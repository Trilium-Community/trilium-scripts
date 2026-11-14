// TAM's entire backend/data layer, in one require()-able JS note; section banners below group functions by domain.

const marked = require("marked.min.js")
// The same note libsettings' own frontend half requires, so TAM's settings
// review reads a schema, a config and a registry's shipped-vs-stored delta
// exactly the way the settings form that wrote them does.
const { isPlainObject, mergeSchemas, mergeSources, mergeDefaults, titleFor } = require("libSettingsCore.js")
// The manifest-shape helpers and shared constants from tam-manifest-model.js,
// which tamhelper.js requires from disk, so the runtime and the validator
// can't drift apart.
const {
    addonAnchorRootLocalId,
    addonAnchorPersistenceLocalId,
    anchorIconClass,
    TYPE_COLORS,
    buildParentMaps,
    topologicalSort,
    normalizeManifest,
    persistentLocalIds,
    sourceIdentityOf
} = require("tam-manifest-model.js")

const addonRootLabel = "addonRoot"

async function getAddonRootNoteId() {
    return await api.currentNote.getRelationValue(addonRootLabel)
}

const addonPersistenceLabel = "addonPersistence"

async function getPersistenceNoteId() {
    return await api.currentNote.getRelationValue(addonPersistenceLabel)
}

const synthesizedAnchorLocalIds = [addonAnchorRootLocalId, addonAnchorPersistenceLocalId]

// Find-or-create the one note that owns every note this addon resolves under (structural or persistent).
async function ensureAddonAnchor(addonId, addonName, localId, parentRealId) {
    const tamFileId = `${addonId}/${localId}`
    return await api.runOnBackend((tamFileIdLabel, tamFileId, addonId, addonName, parentRealId, anchorIconClass) => {
        let existing = api.getNoteWithLabel(tamFileIdLabel, tamFileId)
        if (existing && existing.isDeleted) existing = null
        if (existing) {
            if (existing.title !== addonName) {
                existing.title = addonName
                existing.save()
            }
            return existing.noteId
        }
        const { note } = api.createTextNote(parentRealId, addonName, "")
        note.setLabel(tamFileIdLabel, tamFileId)
        note.setLabel("addonId", addonId)
        note.setLabel("iconClass", anchorIconClass)
        return note.noteId
    }, [tamFileIdLabel, tamFileId, addonId, addonName, parentRealId, anchorIconClass])
}

const databaseLabel = "database"

// Database read/write, via the `database` relation on this note.
async function loadDatabase() {
    const databaseNoteId = await api.currentNote.getRelationValue(databaseLabel)
    const database = await api.runOnBackend((databaseId) => {
        const note = api.getNote(databaseId)
        return JSON.parse(note.getContent())
    }, [databaseNoteId])
    if (!database.catalogs) database.catalogs = []
    if (!database.installedAddons) database.installedAddons = {}
    return database
}

async function saveDatabase(database) {
    const databaseNoteId = await api.currentNote.getRelationValue(databaseLabel)
    return await api.runOnBackend((databaseId, database) => {
        const note = api.getNote(databaseId)
        return note.setContent(JSON.stringify(database, null, 4))
    }, [databaseNoteId, database])
}

// One read-modify-write round-trip: `mutate` edits the database in place.
async function updateDatabase(mutate) {
    const database = await loadDatabase()
    await mutate(database)
    await saveDatabase(database)
}

// =========================================================================
// Installed-record accessors: the only functions that spell out the layout
// under database.installedAddons[addonId], so a record schema change stays a
// one-section edit instead of a hunt through every reader.
// =========================================================================

// The whole installed-record map; loadDatabase guarantees it exists.
function installedAddons(database) {
    return database.installedAddons
}

function getRecord(database, addonId) {
    return installedAddons(database)[addonId]
}

function setRecord(database, addonId, record) {
    installedAddons(database)[addonId] = record
}

function deleteRecord(database, addonId) {
    delete installedAddons(database)[addonId]
}

// The record's TAM-side bookkeeping (prompts and review baselines); undefined until first written.
function getPersistence(record) {
    return record?.persistence
}

function ensurePersistence(record) {
    record.persistence = record.persistence || {}
    return record.persistence
}

// An empty list removes the key entirely, so a record with nothing pending stays clean.
function setPendingPrompts(record, prompts) {
    if (!record) return
    if (prompts.length > 0) ensurePersistence(record).pendingPrompts = prompts
    else if (getPersistence(record)) delete getPersistence(record).pendingPrompts
}

// =========================================================================
// Constants: label/relation names, TAM's own id, and the "activation" attribute names enableAddon toggles under a disabled: prefix.
// =========================================================================

const tamFileIdLabel = "TAMFILEID"
const sourceUrlLabel = "TAMSOURCEURL"
const TAM_ID = "trilium-addon-manager@beatlink"
const addonLabels = [
    "widget",
    "renderNote",
    "run",
    "customRequestHandler",
    "customResourceHandler",
    "titleTemplate",
    "appCss",
    "webViewSrc",
    "iconPack",
    "runOnNoteCreation",
    "runOnNoteTitleChange",
    "runOnNoteChange",
    "runOnNoteContentChange",
    "runOnNoteDeletion",
    "runOnBranchCreation",
    "runOnBranchChange",
    "runOnBranchDeletion",
    "runOnChildNoteCreation",
    "runOnAttributeCreation",
    "runOnAttributeChange",
    "appTheme"
]

// =========================================================================
// Log: an append-only record of what TAM is doing, published to whoever is
// rendering it. lib-tam runs in the frontend, so this is a plain in-memory
// array plus a set of listeners - nothing is persisted, and it starts empty
// every load.
//
// This is what the UI shows instead of a blocking spinner overlay: a long
// update-all or a repair says which addon and which note it is on, rather than
// leaving the user in front of a covered screen with nothing to read.
// =========================================================================

// Bounded so a long run can't grow the array without limit. Old entries fall off
// the front, which is also the end the user is least likely to still care about.
const MAX_LOG_ENTRIES = 500
const logEntries = []
const logListeners = new Set()

// `level` is one of "info", "step", "warn", "error", "done" - the UI colors on it.
function log(level, message) {
    const now = new Date()
    const entry = {
        level,
        message,
        time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
    }
    logEntries.push(entry)
    if (logEntries.length > MAX_LOG_ENTRIES) logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES)
    for (const listener of logListeners) listener()
    // Errors still reach the console: the log panel is cleared on reload, and a
    // stack trace is worth more than the one-line message when debugging.
    if (level === "error") console.error(`TAM: ${message}`)
    return entry
}

function subscribeToLog(listener) {
    logListeners.add(listener)
    return () => logListeners.delete(listener)
}

function getLogEntries() {
    return logEntries.slice()
}

function clearLog() {
    logEntries.length = 0
    for (const listener of logListeners) listener()
}

// =========================================================================
// Helpers: pure extractors, guards, and formatters for common patterns, with no side effects.
// =========================================================================

// Whether the sync leaves this note's content alone once it exists: a persistent
// note holds the user's own data and a skipOnUpdate note (TAM's own live
// database among them) keeps whatever it has. The audit pairs with this - a note
// the sync never rewrites is meant to diverge from the shipped default, so
// comparing it against a manifest `sha` would report drift forever.
function contentIsFrozen(noteDef, persistentIds) {
    return !!noteDef.skipOnUpdate || persistentIds.has(noteDef.id)
}

// Whether a live attribute is the one the manifest declares. A disabled addon
// carries its activation attributes under a `disabled:` prefix, which is still
// the wiring the manifest declared.
function attributeMatches(attr, name, value) {
    return (attr.name === name || attr.name === `disabled:${name}`) && attr.value === value
}

// Extracts metadata fields from a manifest for storage in the database.
function extractAddonMeta(manifest) {
    return {
        name: manifest.name,
        description: manifest.description,
        author: manifest.author,
        license: manifest.license,
        type: manifest.type,
        homepage: manifest.homepage,
        changelog: manifest.changelog || null
    }
}

// =========================================================================
// Network: every fetch TAM makes, plus version comparison. Fetching happens here
// on the frontend and nowhere else - a backend closure cannot capture this scope,
// so leaving any of it there means re-inlining the retry wrapper into each one.
// The backend closures below take content as an argument and only write.
//
// The tradeoff is CORS: a manifest, catalog or source file must be served with
// permissive headers (GitHub raw sends `access-control-allow-origin: *`).
// =========================================================================

function versionCompare(remote, local) {
    return remote.localeCompare(local, undefined, { numeric: true, sensitivity: 'base' })
}

/*
 * Retries on HTTP 429, honoring Retry-After when sent, else exponential backoff.
 *
 * The URL is normalized through `new URL()` rather than encodeURI, which
 * escapes a percent sign and so double-encodes a URL that already carries an
 * escape: a stored `...manager%40beatlink/...` became `%2540`, which fetched
 * GitHub's "404: Not Found" body. `new URL().href` leaves an existing escape
 * alone while still encoding a literal space.
 */
async function fetchWithRetry(url, maxRetries = 5) {
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(new URL(url).href)
        if (response.status !== 429 || attempt >= maxRetries) return response
        const retryAfter = Number(response.headers.get("retry-after"))
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(1000 * 2 ** attempt, 15000)
        await new Promise(resolve => setTimeout(resolve, delayMs))
    }
}

// Every body TAM installs comes through here, so the backend closures below stay
// pure writes. A binary is handed over as base64 because only JSON crosses the
// bridge; the chunking keeps a multi-megabyte font off String.fromCharCode's
// argument list, which overflows the stack whole.
async function fetchContent(url, isBinary) {
    const response = await fetchWithRetry(url)
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
    if (!isBinary) return await response.text()
    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ""
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    }
    return btoa(binary)
}

async function fetchJson(url) {
    const response = await fetchWithRetry(url)
    // An error page is still a body, and parsing it yields a JSON syntax
    // error that names neither the status nor the URL — the actual fault
    // (a dead manifestSourceUrl, say) then has to be guessed at.
    if (!response.ok) throw new Error(`TAM: fetch of ${url} failed with HTTP ${response.status} ${response.statusText}`)
    return await response.json()
}

/*
 * A published manifest carries absolute, commit-pinned sourceUrls; a
 * hand-authored source manifest carries paths relative to itself. Resolving
 * them here, against the URL the manifest was actually fetched from, is what
 * keeps every consumer below dealing only in absolute URLs.
 */
async function fetchManifest(manifestSourceUrl) {
    const manifest = await fetchJson(manifestSourceUrl)
    if (manifest?.changelog) manifest.changelog = new URL(manifest.changelog, manifestSourceUrl).href
    for (const noteDef of (manifest?.manifest?.notes || [])) {
        if (!noteDef.sourceUrl) continue
        noteDef.sourceUrl = new URL(noteDef.sourceUrl, manifestSourceUrl).href
    }
    return manifest
}

// The hash key an attachment's shipped content is recorded under, alongside its owner note's own.
function attachmentHashKey(localId, title) {
    return `${localId}#${title}`
}

// A published manifest's per-note content hashes, keyed by local id.
function noteHashesOf(m) {
    const hashes = {}
    for (const noteDef of (m?.notes || [])) {
        if (noteDef.sha) hashes[noteDef.id] = noteDef.sha
        for (const att of (noteDef.attachments || [])) {
            if (att.sha) hashes[attachmentHashKey(noteDef.id, att.title)] = att.sha
        }
    }
    return hashes
}

// A note whose fetch failed is absent from the note map: keeping its previously
// stored hash (or none at all) is what makes the next sync retry it rather than
// read it as already current.
function recordedNoteHashes(m, noteMap, storedNoteHashes) {
    const hashes = {}
    for (const [key, sha] of Object.entries(noteHashesOf(m))) {
        // An attachment is recorded under its owner note's resolution, since that
        // is what decides whether it was written this sync.
        const localId = key.split("#")[0]
        const value = noteMap[localId] ? sha : storedNoteHashes?.[key]
        if (value) hashes[key] = value
    }
    return hashes
}

// =========================================================================
// Manifest shape: pure helpers operating on a fetched/stored manifest object.
// The structural ones live in tam-manifest-model.js, shared with tamhelper.js.
// =========================================================================

// Snapshots the manifest fields TAM still needs offline.
function stripManifestForStorage(m) {
    return {
        root: m.root,
        settingsNote: m.settingsNote,
        readmeNote: m.readmeNote,
        // Kept because resolvePrompt needs to find the schema and config notes
        // again, long after the sync that produced the prompt has finished.
        settings: m.settings || null,
        allowExternalReferences: m.allowExternalReferences,
        children: m.children || []
    }
}

// Parses a trailing "(inheritable)" modifier off a label name into a real isInheritable flag.
function parseInheritableName(name) {
    const match = name.match(/^(.*)\(inheritable\)$/)
    return match ? { name: match[1], isInheritable: true } : { name, isInheritable: false }
}

// =========================================================================
// Note resolution: turns a manifest's notes[]/children[]/labels[] into real, live Trilium notes tagged #TAMFILEID.
// =========================================================================

// Resolves a single real note id live by #TAMFILEID for a stored manifest's local id.
async function resolveStoredNoteId(addonId, localId) {
    if (!localId) return null
    return await api.runOnBackend((tamFileIdLabel, tamFileId) => {
        const note = api.getNoteWithLabel(tamFileIdLabel, tamFileId)
        return (note && !note.isDeleted) ? note.noteId : null
    }, [tamFileIdLabel, `${addonId}/${localId}`])
}

// Resolves an addon's root note id live.
async function resolveAddonRootNoteId(addonId, storedManifest) {
    return await resolveStoredNoteId(addonId, storedManifest?.root ?? addonAnchorRootLocalId)
}

// Writes declared titles, labels and relations onto notes in one hop. An
// attribute TAM has disabled lives under a `disabled:` name, and writing to
// that name is what keeps a disabled addon disabled across a re-sync.
//
// An action addresses its note by real `noteId` or by `tamFileId` (resolved
// live); `value: null` removes the attribute; a relation's `targetTamFileId`
// resolves live too, falling back to `value` as a raw note id. This is the one
// attribute writer, shared by the sync and the metadata review's apply.
async function applyAttributes(actions) {
    if (actions.length === 0) return
    await api.runOnBackend((tamFileIdLabel, actions) => {
        for (const action of actions) {
            const { type, name, value, isInheritable } = action
            let note = action.noteId
                ? api.getNote(action.noteId)
                : api.getNoteWithLabel(tamFileIdLabel, action.tamFileId)
            if (!note || note.isDeleted) continue
            if (type === "title") {
                note.title = value
                note.save()
                continue
            }
            const disabledName = `disabled:${name}`
            const isLabel = type === "label"
            const hasDisabled = isLabel ? note.hasOwnedLabel(disabledName) : note.hasRelation(disabledName)
            const targetName = hasDisabled ? disabledName : name
            if (value === null) {
                if (isLabel) note.removeLabel(targetName)
                else note.removeRelation(targetName)
            } else if (!isLabel) {
                let target = value
                if (action.targetTamFileId) {
                    const targetNote = api.getNoteWithLabel(tamFileIdLabel, action.targetTamFileId)
                    if (targetNote && !targetNote.isDeleted) target = targetNote.noteId
                }
                note.setRelation(targetName, target)
            } else if (isInheritable) {
                note.removeLabel(targetName)
                note.addLabel(targetName, value, true)
            } else {
                note.setLabel(targetName, value)
            }
        }
    }, [tamFileIdLabel, actions])
}

// One backend hop answering, for every declared note at once, which are already
// installed (with the attachment titles they already carry) and which vendored
// copies this addon may adopt - a note already carrying one of their
// #TAMSOURCEURL identities and mimes and belonging to a *different* addon. The
// mime has to match because one file can be vendored as a frontend module by one
// addon and a backend module by another, and Trilium only bundles a child whose
// script env matches its parent's. Knowing all of
// it up front is what lets the frontend decide which bodies to fetch, leaving
// the write below with nothing to look up.
//
// Adopting a copy this addon already owns would collapse two local ids onto one
// note. A manifest may legitimately ship one file twice - agenda's ical.min.js
// is declared once as a library and once as a customResourceProvider - and both
// carry the same sourceId. The second note would then never be created, its
// labels would land on the first, and a declared parenting between them becomes
// "parent this note under itself", which is refused as a cycle and can never be
// repaired by re-syncing.
async function readNoteResolution(addonId, noteDefs) {
    if (noteDefs.length === 0) return { existing: {}, adoptable: {}, attachmentTitles: {} }
    const shareable = noteDefs
        .filter(n => sourceIdentityOf(n))
        .map(n => ({ localId: n.id, identity: sourceIdentityOf(n), mime: n.mime ?? "text/html" }))
    const attachmentIds = noteDefs.filter(n => (n.attachments || []).length).map(n => n.id)
    return await api.runOnBackend((tamFileIdLabel, sourceUrlLabel, addonId, localIds, shareable, attachmentIds) => {
        const attachmentIdSet = new Set(attachmentIds)
        const existing = {}
        const attachmentTitles = {}
        for (const localId of localIds) {
            const note = api.getNoteWithLabel(tamFileIdLabel, `${addonId}/${localId}`)
            if (!note || note.isDeleted) continue
            existing[localId] = note.noteId
            if (attachmentIdSet.has(localId)) attachmentTitles[localId] = note.getAttachments().map(att => att.title)
        }
        const adoptable = {}
        for (const { localId, identity, mime } of shareable) {
            const shared = api.getNotesWithLabel(sourceUrlLabel, identity).find(note => !note.isDeleted
                && note.mime === mime
                && !(note.getOwnedLabelValue(tamFileIdLabel) || "").startsWith(`${addonId}/`))
            if (shared) adoptable[localId] = shared.noteId
        }
        return { existing, adoptable, attachmentTitles }
    }, [tamFileIdLabel, sourceUrlLabel, addonId, noteDefs.map(n => n.id), shareable, attachmentIds])
}

// What a note's declared attachments should look like after this sync, and which
// titles it shipped last time that are no longer declared. Trilium reads an icon
// pack's font as an attachment (getAttachmentsByRole("file")) and an attachment
// is not a note, so nothing in the note pass itself can carry one; matching by
// title is what makes a re-sync update in place, and dropping a renamed one
// matters because which of two same-mime attachments Trilium picks is arbitrary.
function attachmentPlan(noteDef, storedNoteHashes, installedTitles) {
    const specs = (noteDef.attachments || []).map(att => ({
        title: att.title,
        role: att.role || "file",
        mime: att.mime,
        binary: att.binary ?? true,
        content: att.content ?? null,
        sourceUrl: att.sourceUrl || null,
        unchanged: !!(att.sha && storedNoteHashes?.[attachmentHashKey(noteDef.id, att.title)] === att.sha)
    }))
    const previousTitles = Object.keys(storedNoteHashes || {})
        .filter(key => key.startsWith(`${noteDef.id}#`))
        .map(key => key.slice(noteDef.id.length + 1))
    return {
        // Already installed and unchanged means there is nothing to fetch or write.
        pending: specs.filter(spec => !(installedTitles.includes(spec.title) && spec.unchanged)),
        stale: previousTitles.filter(title => !specs.some(spec => spec.title === title))
    }
}

// The whole note pass as backend writes, in as few hops as the payload allows.
//
// Specs arrive in topological order and the backend resolves each parent from
// the ids it has already created, so a note never has to come back to the
// frontend for its parent's real id. Nothing here fetches or decides - every
// body was fetched before the call - which is what lets the loop live on the
// backend at all.
//
// Batches are capped by accumulated content size rather than note count: one
// icon pack's font is worth more than fifty script notes. The cap is about how
// much TAM holds in memory at once, not the request limit - Trilium's server
// takes 500mb bodies - and the largest addon in the catalog is ~3.3MB, so a
// real sync is one batch.
const noteWriteBatchBytes = 4 * 1024 * 1024

async function writeNotes(specs) {
    const noteMap = {}
    const errors = []
    let batch = []
    let batchBytes = 0
    const flush = async () => {
        if (batch.length === 0) return
        const result = await api.runOnBackend((tamFileIdLabel, sourceUrlLabel, specs, noteMap) => {
            const resolved = {}
            const failures = []
            for (const spec of specs) {
                const parentRealId = spec.parentLocalId ? (noteMap[spec.parentLocalId] || resolved[spec.parentLocalId]) : spec.anchorId
                if (spec.parentLocalId && !parentRealId) {
                    failures.push(`skipping note '${spec.localId}' - its parent '${spec.parentLocalId}' failed to resolve`)
                    continue
                }
                try {
                    let existing = api.getNoteWithLabel(tamFileIdLabel, spec.tamFileId)
                    if (existing && existing.isDeleted) existing = null
                    let noteId
                    if (!existing && spec.adoptableNoteId) {
                        if (!spec.skipParenting) api.ensureNoteIsPresentInParent(spec.adoptableNoteId, parentRealId)
                        noteId = spec.adoptableNoteId
                    } else {
                        const finalContent = spec.content === null
                            ? null
                            : (spec.isBinary ? Buffer.from(spec.content, "base64") : spec.content)
                        if (existing) {
                            if (!spec.skipParenting) api.ensureNoteIsPresentInParent(existing.noteId, parentRealId)
                            if (existing.getOwnedLabelValue(sourceUrlLabel) !== (spec.sourceIdentity || "")) {
                                existing.setLabel(sourceUrlLabel, spec.sourceIdentity || "")
                            }
                            // Title/type/mime still track the manifest when only the
                            // content write was skipped as unchanged — a rename ships
                            // without the file itself moving.
                            if (!(spec.frozen || spec.promptOnUpdate)) {
                                if (existing.type !== spec.noteType || existing.mime !== spec.mime || existing.title !== spec.title) {
                                    existing.type = spec.noteType
                                    existing.mime = spec.mime
                                    existing.title = spec.title
                                    existing.save()
                                }
                            }
                            if (finalContent !== null) existing.setContent(finalContent)
                            noteId = existing.noteId
                        } else {
                            const note = api.createTextNote(parentRealId, spec.title, "").note
                            if (spec.noteType !== "text" || spec.mime !== "text/html") {
                                note.type = spec.noteType
                                note.mime = spec.mime
                                note.save()
                            }
                            note.setContent(finalContent ?? "")
                            note.setLabel(tamFileIdLabel, spec.tamFileId)
                            note.setLabel(sourceUrlLabel, spec.sourceIdentity || "")
                            noteId = note.noteId
                        }
                    }
                    resolved[spec.localId] = noteId
                } catch (e) {
                    failures.push(`note '${spec.localId}' failed to install - ${e.message}`)
                    continue
                }
                // Its own guard: an attachment that fails to write leaves the note
                // itself installed, which is what the resolved map above already says.
                if (!spec.attachments.length && !spec.staleAttachments.length) continue
                try {
                    const note = api.getNote(resolved[spec.localId])
                    const existingByTitle = {}
                    for (const att of note.getAttachments()) existingByTitle[att.title] = att
                    for (const title of spec.staleAttachments) existingByTitle[title]?.markAsDeleted()
                    for (const att of spec.attachments) {
                        const content = att.binary ? Buffer.from(att.content, "base64") : att.content
                        const attachment = note.saveAttachment({ title: att.title, role: att.role, mime: att.mime, content }, "title")
                        // saveAttachment only ever writes content, so a mime or role
                        // that moved since the last sync has to be corrected here.
                        if (attachment.mime !== att.mime || attachment.role !== att.role) {
                            attachment.mime = att.mime
                            attachment.role = att.role
                            attachment.save()
                        }
                    }
                } catch (e) {
                    failures.push(`note '${spec.localId}' attachments failed to install - ${e.message}`)
                }
            }
            return { resolved, failures }
        }, [tamFileIdLabel, sourceUrlLabel, batch, noteMap])
        Object.assign(noteMap, result.resolved)
        errors.push(...result.failures)
        batch = []
        batchBytes = 0
    }
    for (const spec of specs) {
        const bytes = (spec.content?.length || 0) + spec.attachments.reduce((sum, att) => sum + (att.content?.length || 0), 0)
        if (batch.length && batchBytes + bytes > noteWriteBatchBytes) await flush()
        batch.push(spec)
        batchBytes += bytes
    }
    await flush()
    return { noteMap, errors }
}

// Resolves every declared note against the live tree by #TAMFILEID, find-or-create.
//
// `anchors` holds the note each reserved parent keyword stands for. One
// topological pass covers structural and persistent notes together: a note is
// persistent precisely because its parent chain roots at the "persistence"
// keyword, so no structural note can be parented under a persistent one and the
// single ordering is always resolvable.
async function resolveNotes(m, addonId, anchors, options = {}) {
    const { rootExternallyParented = false, entryLocalId = null, storedNoteHashes = null } = options
    const { primaryParent } = buildParentMaps(m.children)
    const persistentIds = persistentLocalIds(m)
    const sortedIds = topologicalSort(m.notes.map(n => n.id), primaryParent)
    // First declaration wins, as the find() this replaces did: a manifest may
    // repeat one id, and topologicalSort emits it once.
    const byLocalId = {}
    for (const noteDef of m.notes) if (!(noteDef.id in byLocalId)) byLocalId[noteDef.id] = noteDef
    // Read up front rather than per note: a copy this pass creates is owned by
    // this addon, and adoption never takes one of those, so nothing the write
    // below does can change an answer here.
    const live = await readNoteResolution(addonId, m.notes)
    // Everything per note except the bytes themselves, so every fetch the pass
    // needs is known up front and runs concurrently below.
    const plans = []
    for (const localId of sortedIds) {
        const noteDef = byLocalId[localId]
        if (!noteDef) continue
        const isEntry = entryLocalId
            ? localId === entryLocalId
            : primaryParent[localId] === "root" || primaryParent[localId] === "persistence"
        // An unhashed manifest (or a note whose shipped content moved) always
        // refetches; matching hashes mean the bytes on the other end of that URL
        // are the ones already installed, so both the fetch and the write go.
        const contentUnchanged = !!(noteDef.sha && storedNoteHashes?.[localId] === noteDef.sha)
        const plan = {
            localId,
            noteDef,
            isEntry,
            contentUnchanged,
            isBinary: noteDef.binary ?? false,
            noteType: noteDef.renderAsHTML ? "text" : (noteDef.type ?? "text"),
            mime: noteDef.renderAsHTML ? "text/html" : (noteDef.mime ?? "text/html"),
            sourceIdentity: sourceIdentityOf(noteDef),
            frozen: contentIsFrozen(noteDef, persistentIds),
            // Only the body the write will actually keep is fetched. `null` means
            // "not fetched", which the write reads as "leave the content alone" —
            // distinct from the empty string a note declaring no source installs.
            content: null,
            fetchUrl: null,
            error: null,
            ...attachmentPlan(noteDef, storedNoteHashes, live.attachmentTitles[localId] || [])
        }
        if (!live.existing[localId] || !(plan.frozen || noteDef.promptOnUpdate || contentUnchanged)) {
            const explicit = noteDef.content ?? null
            if (explicit !== null) plan.content = explicit
            else if (noteDef.sourceUrl) plan.fetchUrl = noteDef.sourceUrl
            else plan.content = ""
        }
        plans.push(plan)
    }
    // All bodies and attachments at once: fetch time dominates a sync, and
    // order only matters for the writes below, never for the fetches.
    await Promise.all(plans.map(async plan => {
        try {
            if (plan.fetchUrl) plan.content = await fetchContent(plan.fetchUrl, plan.noteDef.renderAsHTML ? false : plan.isBinary)
            if (plan.noteDef.renderAsHTML && plan.content !== null) plan.content = marked.parse(plan.content)
        } catch (e) {
            plan.error = e
        }
        try {
            for (const att of plan.pending) {
                if (att.content === null) att.content = att.sourceUrl ? await fetchContent(att.sourceUrl, att.binary) : ""
            }
        } catch (e) {
            log("error", `${addonId}: note '${plan.localId}' attachments failed to install - ${e.message}`)
            plan.pending.length = 0
        }
    }))
    const specs = []
    const unchanged = {}
    for (const plan of plans) {
        if (plan.error) {
            log("error", plan.noteDef.renderAsHTML
                ? `${addonId}: skipping note '${plan.localId}' - couldn't fetch markdown source ${plan.fetchUrl} (${plan.error.message})`
                : `${addonId}: skipping note '${plan.localId}' - ${plan.error.message}`)
            continue
        }
        unchanged[plan.localId] = plan.contentUnchanged
        specs.push({
            localId: plan.localId,
            tamFileId: `${addonId}/${plan.localId}`,
            parentLocalId: plan.isEntry ? null : primaryParent[plan.localId],
            anchorId: anchors[primaryParent[plan.localId]] || anchors.root,
            title: plan.noteDef.title,
            noteType: plan.noteType,
            mime: plan.mime,
            content: plan.content,
            isBinary: plan.isBinary,
            frozen: plan.frozen,
            promptOnUpdate: !!plan.noteDef.promptOnUpdate,
            skipParenting: plan.isEntry && rootExternallyParented,
            sourceIdentity: plan.sourceIdentity,
            adoptableNoteId: live.adoptable[plan.localId] || null,
            attachments: plan.pending,
            staleAttachments: plan.stale
        })
    }
    const { noteMap, errors } = await writeNotes(specs)
    for (const failure of errors) log("error", `${addonId}: ${failure}`)
    for (const spec of specs) {
        if (noteMap[spec.localId] && !unchanged[spec.localId]) log("info", `${addonId}: installed ${spec.title}`)
    }
    await reconcileNoteParenting(m, addonId, noteMap, anchors, rootExternallyParented, entryLocalId)
    return noteMap
}

// Clones every resolved note into every parent its manifest currently declares,
// and detaches parents it no longer declares. Both halves are decided on the
// frontend against the finished note map and applied in one hop.
async function reconcileNoteParenting(m, addonId, noteMap, anchors, rootExternallyParented, entryLocalId = null) {
    const { primaryParent, extraParents } = buildParentMaps(m.children)
    const isReservedAnchor = (pid) => pid === "root" || pid === "persistence"
    const isEntry = (localId) => entryLocalId ? localId === entryLocalId : isReservedAnchor(primaryParent[localId])
    const clones = []
    for (const [childLocalId, parentLocalIds] of Object.entries(extraParents)) {
        const childRealId = noteMap[childLocalId]
        if (!childRealId) continue
        for (const parentLocalId of parentLocalIds) {
            const parentRealId = isReservedAnchor(parentLocalId) ? anchors[parentLocalId] : noteMap[parentLocalId]
            if (parentRealId) clones.push({ noteId: childRealId, parentId: parentRealId })
        }
    }
    const detachments = []
    for (const [localId, noteRealId] of Object.entries(noteMap)) {
        if (isEntry(localId) && rootExternallyParented) continue
        const declaredParentLocalIds = [primaryParent[localId], ...(extraParents[localId] || [])].filter(Boolean)
        const desiredRealParents = declaredParentLocalIds
            .map(pid => isReservedAnchor(pid) ? anchors[pid] : noteMap[pid])
            .filter(Boolean)
        const entryAnchorId = anchors[primaryParent[localId]] || anchors.root
        if (isEntry(localId) && !rootExternallyParented && entryAnchorId) {
            desiredRealParents.push(entryAnchorId)
        }
        if (desiredRealParents.length === 0) continue
        detachments.push({
            noteId: noteRealId,
            desiredRealParents,
            declaredParentTamIds: declaredParentLocalIds.map(pid => isReservedAnchor(pid) ? null : `${addonId}/${pid}`).filter(Boolean)
        })
    }
    if (clones.length === 0 && detachments.length === 0) return
    await api.runOnBackend((tamFileIdLabel, addonId, clones, detachments) => {
        for (const { noteId, parentId } of clones) api.ensureNoteIsPresentInParent(noteId, parentId)
        for (const { noteId, desiredRealParents, declaredParentTamIds } of detachments) {
            const note = api.getNote(noteId)
            for (const parentId of note.getParentNotes().map(p => p.noteId)) {
                if (desiredRealParents.includes(parentId)) continue
                const parentNote = api.getNote(parentId)
                const parentTamId = parentNote ? parentNote.getOwnedLabelValue(tamFileIdLabel) : null
                if (parentTamId && parentTamId.startsWith(`${addonId}/`) && !declaredParentTamIds.includes(parentTamId)) {
                    api.ensureNoteIsAbsentFromParent(noteId, parentId)
                }
            }
        }
    }, [tamFileIdLabel, addonId, clones, detachments])
}

// Deletes any live #TAMFILEID-tagged note of this addon whose local id is no longer declared in the current manifest.
async function pruneRemovedNotes(m, addonId) {
    const exemptIds = [...persistentLocalIds(m), ...synthesizedAnchorLocalIds]
    await api.runOnBackend((tamFileIdLabel, addonId, currentLocalIds, exemptIds) => {
        const currentSet = new Set(currentLocalIds)
        const exemptSet = new Set(exemptIds)
        const prefix = `${addonId}/`
        for (const note of api.getNotesWithLabel(tamFileIdLabel)) {
            if (note.isDeleted) continue
            // Owned-only: getLabelValue() resolves inherited labels, so a note
            // templated from a TAM template would report the template's id and
            // be pruned along with it.
            const value = note.getOwnedLabelValue(tamFileIdLabel)
            if (!value || !value.startsWith(prefix)) continue
            const localId = value.slice(prefix.length)
            if (exemptSet.has(localId)) continue
            if (!currentSet.has(localId)) note.deleteNote()
        }
    }, [tamFileIdLabel, addonId, m.notes.map(n => n.id), exemptIds])
}

// =========================================================================
// Persistence: user data lives in notes reachable from the reserved "persistence" parent, anchored under the shared "Addon Data" note.
// =========================================================================

// Called from syncAddon before resolveNotes: compares each persistent note's live content against the incoming manifest default and queues a prompt on any difference.
async function collectPendingPrompts(addonId, m, storedNoteHashes = null) {
    const persistentIds = persistentLocalIds(m)
    if (persistentIds.size === 0) return []
    const prompts = []
    for (const noteDef of (m.notes || [])) {
        if (!persistentIds.has(noteDef.id)) continue
        // Nothing to decide when the shipped default hasn't moved since the last
        // sync: the only difference left is the user's own edit, which they've
        // already been asked about once.
        if (noteDef.sha && storedNoteHashes?.[noteDef.id] === noteDef.sha) continue
        // A declared settings config note is reviewed per setting instead (see
        // collectSettingsPrompt) — diffing it whole would offer to replace the
        // user's entire config with the blank document the addon ships.
        if (noteDef.id === m.settings?.config) continue
        let newContent = noteDef.content ?? null
        if (newContent === null && noteDef.sourceUrl) {
            try {
                newContent = await fetchContent(noteDef.sourceUrl, false)
            } catch (e) {
                log("warn", `${addonId}: couldn't fetch the incoming default for persistent note '${noteDef.id}' - ${e.message}`)
            }
        }
        if (newContent === null) continue
        const info = await api.runOnBackend((tamFileIdLabel, tamFileId) => {
            const note = api.getNoteWithLabel(tamFileIdLabel, tamFileId)
            return (note && !note.isDeleted) ? { noteId: note.noteId, content: note.getContent() } : null
        }, [tamFileIdLabel, `${addonId}/${noteDef.id}`])
        if (!info) continue
        if (info.content === newContent) continue
        prompts.push({
            noteLocalId: noteDef.id,
            title: noteDef.title,
            persistedNoteId: info.noteId,
            newContent,
            currentContent: info.content
        })
    }
    return prompts
}

async function getPendingPrompts(addonId) {
    const database = await loadDatabase()
    return getPersistence(getRecord(database, addonId))?.pendingPrompts || []
}

// `decision` is a plain boolean for a built-in whole-content prompt, or a
// { [itemKey]: boolean } map for an item-level review kind, dispatched by the
// prompt's `source` through the reviewKinds registry.
async function resolvePrompt(addonId, noteLocalId, decision) {
    log("info", `${addonId}: applying your choices for '${noteLocalId}'`)
    const database = await loadDatabase()
    const record = getRecord(database, addonId)
    const prompt = (getPersistence(record)?.pendingPrompts || [])
        .find(p => p.noteLocalId === noteLocalId)
    if (!prompt) return
    const kind = prompt.source && reviewKinds[prompt.source]
    if (kind) {
        await kind.apply(addonId, record, prompt, decision || {})
        return
    }
    if (!decision) return
    await api.runOnBackend((noteId, content) => {
        api.getNote(noteId).setContent(content)
    }, [prompt.persistedNoteId, prompt.newContent])
}

async function clearPendingPrompts(addonId) {
    await updateDatabase(database => setPendingPrompts(getRecord(database, addonId), []))
}

// =========================================================================
// Review bookkeeping shared by every item-level review kind: where a kind's
// "what shipped last time" baseline lives on the record, and the shape of the
// pending-prompts entry its items become.
// =========================================================================

async function loadReviewBaseline(addonId, baselineKey) {
    const database = await loadDatabase()
    return getPersistence(getRecord(database, addonId))?.[baselineKey]
}

async function saveReviewBaseline(addonId, baselineKey, value) {
    await updateDatabase(database => {
        const record = getRecord(database, addonId)
        if (record) ensurePersistence(record)[baselineKey] = value
    })
}

// A pending-prompts entry for one review kind's item list; null when there is nothing to decide.
function itemPrompt(source, noteLocalId, title, items) {
    return items.length === 0 ? null : { noteLocalId, source, title, items }
}

// =========================================================================
// Settings review: the per-setting half of the Update Review, for addons declaring `manifest.settings`.
// =========================================================================

// An addon's defaults.json is structural (replaced on every update) while its
// config.json is persistent (never overwritten), so both versions of "what this
// setting should be" are already on disk. What is missing is what the defaults
// looked like *last* time: without it, "the user's config differs from the
// current default" cannot tell a deliberate choice from a default that moved
// upstream. `settingsBaseline` on the addon's own database record is that
// missing side — the merged read-only sources as of the last review — which
// keeps this review down to what actually changed upstream instead of re-asking
// about every customization on every update.
//
// It lives here rather than inside config.json because it is TAM's bookkeeping,
// not the user's data: nothing in the addon has to know it exists, a settings
// save can't accidentally drop it, and it goes away with the addon's record.
const settingsPromptSource = "settings"

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// `list` is excluded from the review entirely: a stored list replaces its
// default wholesale rather than reconciling per entry, so "use the new default"
// could only mean discarding the user's entries. `checklist` stores nothing of
// its own.
function isReviewableField(key, def) {
    return !key.startsWith("_") && def.type !== "list" && def.type !== "checklist"
}

// The shipped baseline of every reviewable field, taken from the merged
// read-only sources: a plain value for a scalar, the entry map for a registry.
function shippedDefaults(schema, defaults) {
    const shipped = {}
    for (const [key, def] of Object.entries(schema)) {
        if (isReviewableField(key, def)) shipped[key] = defaults[key]
    }
    return shipped
}

// Registry entries are compared in their *runtime* (merged, flat) shape rather
// than as stored: a shipped entry may omit any itemSchema key it is happy to
// default, and a nested registry is stored as an `{ entries, removedIds }` delta
// but shipped as a flat map — only after mergeDefaults are the two comparable.
function registrySettingsItems(key, def, storedField, shippedNow, shippedThen) {
    const items = []
    const storedEntries = isPlainObject(storedField?.entries) ? storedField.entries : {}
    const removedIds = Array.isArray(storedField?.removedIds) ? storedField.removedIds : []
    for (const [id, now] of Object.entries(shippedNow)) {
        // An entry the user deleted is never resurrected, and one shipped for the
        // first time in this version has no previous version to diff against.
        if (removedIds.includes(id)) continue
        const then = shippedThen[id]
        if (!then) continue
        const nowMerged = mergeDefaults(def.itemSchema, now, null)
        const thenMerged = mergeDefaults(def.itemSchema, then, null)
        if (sameJson(thenMerged, nowMerged)) continue
        const storedItem = storedEntries[id]
        // What the user has right now: their own version if they edited this
        // entry, otherwise the entry as it shipped last time.
        const currentMerged = storedItem ? mergeDefaults(def.itemSchema, now, storedItem) : thenMerged
        if (sameJson(currentMerged, nowMerged)) continue
        items.push({
            key: `${key}.${id}`,
            label: `${def.label ?? key}: ${titleFor(def.itemSchema, currentMerged, null)}`,
            current: currentMerged,
            incoming: nowMerged,
            defaultSelected: !storedItem,
            field: key,
            id
        })
    }
    return items
}

// Everything the user would have to decide about, given what shipped last time.
// `field`/`id` are internal: the prompt strips them, and applySettingsSelections
// recomputes this list to get them back rather than parsing them out of `key`.
function settingsReviewItems(schema, stored, baseline, defaults) {
    const items = []
    for (const [key, def] of Object.entries(schema)) {
        // A field with no baseline is new in this version: nothing to diff.
        if (!isReviewableField(key, def) || !(key in baseline)) continue
        if (def.type === "registry") {
            items.push(...registrySettingsItems(key, def, stored[key], defaults[key] || {}, baseline[key] || {}))
            continue
        }
        // Every default that moved in this update gets a row, whether or not the
        // user ever saved anything: a setting they never customized is already
        // following the new value, so the row is what lets them say otherwise.
        if (sameJson(defaults[key], baseline[key])) continue
        const current = key in stored ? stored[key] : baseline[key]
        if (sameJson(current, defaults[key])) continue
        items.push({
            key,
            label: def.label ?? key,
            current,
            incoming: defaults[key],
            defaultSelected: !(key in stored),
            field: key,
            id: null
        })
    }
    return items
}

// A scalar still holding exactly the default it shipped with is one the user
// never touched, so dropping it from the config lets it follow the defaults
// source again and a changed default is theirs for free — no review. Registry
// entries need no equivalent: an untouched shipped entry is never copied into
// config.json in the first place, so it already tracks its shipped version.
// Mutates `stored`; returns whether anything moved.
function adoptUnchangedDefaults(schema, stored, baseline, defaults) {
    let changed = false
    for (const [key, def] of Object.entries(schema)) {
        if (!isReviewableField(key, def) || def.type === "registry") continue
        if (!(key in stored) || !(key in baseline)) continue
        if (sameJson(defaults[key], baseline[key]) || !sameJson(stored[key], baseline[key])) continue
        delete stored[key]
        changed = true
    }
    return changed
}

async function readJsonNote(noteId) {
    const content = await api.runOnBackend((id) => api.getNote(id).getContent(), [noteId])
    try {
        return JSON.parse(content || "{}")
    } catch (e) {
        log("error", `note ${noteId} does not hold valid JSON - ${e.message}`)
        return {}
    }
}

// The config note's whole source chain, lowest priority first and the note
// itself last — the same walk libsettings does when it reads settings, so the
// review sees exactly the layering the settings form does.
async function loadSettingsSources(configNoteId) {
    return await api.runOnBackend((rootId) => {
        const readJson = (noteId) => {
            const note = noteId ? api.getNote(noteId) : null
            if (!note) return {}
            try {
                return JSON.parse(note.getContent() || "{}")
            } catch (e) {
                return {}
            }
        }
        const sources = []
        const seen = new Set()
        const visit = (noteId) => {
            if (!noteId || seen.has(noteId)) return
            seen.add(noteId)
            const note = api.getNote(noteId)
            if (!note) return
            for (const relation of note.getOwnedRelations("sourceConfig")) visit(relation.value)
            sources.push({
                schema: readJson(note.getRelationValue("schemaNote")),
                stored: readJson(noteId)
            })
        }
        visit(rootId)
        return sources
    }, [configNoteId])
}

async function writeJsonNote(noteId, value) {
    await api.runOnBackend(
        (id, content) => api.getNote(id).setContent(content),
        [noteId, JSON.stringify(value, null, 4)]
    )
}

// Everything the settings phases need, or null when the addon declares no
// settings (or its notes can't be resolved, which is not worth failing a sync over).
async function loadSettingsState(addonId, m) {
    if (!m?.settings?.schema || !m?.settings?.config) return null
    const schemaNoteId = await resolveStoredNoteId(addonId, m.settings.schema)
    const configNoteId = await resolveStoredNoteId(addonId, m.settings.config)
    if (!schemaNoteId || !configNoteId) {
        log("warn", `${addonId}: settings notes did not resolve (schema '${m.settings.schema}', config '${m.settings.config}')`)
        return null
    }
    // Every source under the config note but the config note itself: those are
    // the read-only ones the review compares the user's own document against.
    const sources = (await loadSettingsSources(configNoteId)).slice(0, -1)
    const schema = mergeSchemas([...sources.map(s => s.schema), await readJsonNote(schemaNoteId)])
    const defaults = mergeSources(schema, sources.map(s => s.stored)) || {}
    return {
        configNoteId, schema, defaults,
        stored: await readJsonNote(configNoteId),
        shipped: shippedDefaults(schema, defaults)
    }
}

// First install: the user has customized nothing, so record where the defaults
// stand and leave the first update with nothing to review.
async function recordSettingsBaseline(addonId, m) {
    const state = await loadSettingsState(addonId, m)
    if (state) await saveReviewBaseline(addonId, "settingsBaseline", state.shipped)
}

// Runs after an update's notes are in place, so it reads the *new* schema
// against the config and baseline the update left alone. Returns a prompt entry
// for the Update Review, or null when there is nothing to decide — in which
// case the baseline advances straight away.
async function collectSettingsPrompt(addonId, m, title) {
    const state = await loadSettingsState(addonId, m)
    if (!state) return null
    const baseline = await loadReviewBaseline(addonId, "settingsBaseline")
    // No baseline means this install predates the settings review: there is
    // genuinely no way to know which of its stored values were deliberate, so
    // record where things stand and review nothing this once.
    if (!isPlainObject(baseline)) {
        await saveReviewBaseline(addonId, "settingsBaseline", state.shipped)
        return null
    }
    if (adoptUnchangedDefaults(state.schema, state.stored, baseline, state.defaults)) {
        await writeJsonNote(state.configNoteId, state.stored)
    }
    const items = settingsReviewItems(state.schema, state.stored, baseline, state.defaults)
    if (items.length === 0) {
        await saveReviewBaseline(addonId, "settingsBaseline", state.shipped)
        return null
    }
    // The baseline deliberately does not move here: it advances only once the
    // user has answered, so an update they never applied is asked about again
    // rather than silently forgotten. `field`/`id` stay internal to this file,
    // so the prompt carries only what the review screen renders.
    return itemPrompt(settingsPromptSource, m.settings.config, title,
        items.map(({ key, label, current, incoming, defaultSelected }) => ({ key, label, current, incoming, defaultSelected })))
}

// `true` for an item means "use the new default": it drops the user's override —
// a scalar's own key, a registry entry's shadowing entry — so the setting goes
// back to tracking the defaults source. `false` means "keep mine", which has to
// *pin* what they have today: a setting they never diverged on holds no value of
// its own, so without writing one it would simply follow the new default.
async function applySettingsSelections(addonId, m, selections) {
    const state = await loadSettingsState(addonId, m)
    if (!state) return
    const baseline = await loadReviewBaseline(addonId, "settingsBaseline")
    if (isPlainObject(baseline)) {
        for (const item of settingsReviewItems(state.schema, state.stored, baseline, state.defaults)) {
            if (selections[item.key]) {
                if (item.id === null) {
                    delete state.stored[item.field]
                } else if (isPlainObject(state.stored[item.field]?.entries)) {
                    delete state.stored[item.field].entries[item.id]
                }
            } else if (item.id === null) {
                state.stored[item.field] = item.current
            } else {
                const field = isPlainObject(state.stored[item.field]) ? state.stored[item.field] : {}
                field.entries = isPlainObject(field.entries) ? field.entries : {}
                field.removedIds = Array.isArray(field.removedIds) ? field.removedIds : []
                if (!(item.id in field.entries)) field.entries[item.id] = item.current
                state.stored[item.field] = field
            }
        }
        await writeJsonNote(state.configNoteId, state.stored)
    }
    await saveReviewBaseline(addonId, "settingsBaseline", state.shipped)
}

// =========================================================================
// Metadata review: the per-item half of the Update Review for a note's title, labels and relations.
// =========================================================================

// A note's content is not the only thing an update replaces: `resolveNotes`
// rewrites every declared title, and `applyAttributes` overwrites every declared
// label and relation, so a title the user renamed or a label they retargeted is
// silently reverted. This review is the same key-by-key treatment
// the settings review gives a config note, applied to that metadata:
// `metadataBaseline` on the addon's own database record holds what the manifest
// declared last time, so a row is raised only where the *declaration* moved, and
// the live value says whether the user had diverged from it.
//
// It is collected before the sync (the live values are gone once notes are
// rewritten) and applied after the user answers: "use new" makes the note match
// the manifest — which is also the only way a label or relation the manifest has
// dropped ever goes away — and "keep mine" writes the pre-update value back.
const metadataPromptSource = "metadata"
const metadataPromptLocalId = "__metadata__"

// What a manifest declares about each of its notes, in the shape the baseline is
// stored and compared in.
function declaredMetadata(m) {
    const declared = {}
    for (const note of m.notes || []) {
        declared[note.id] = { title: note.title, labels: {}, relations: {} }
    }
    for (const label of m.labels || []) {
        if (declared[label.note]) declared[label.note].labels[label.name] = String(label.value ?? "")
    }
    for (const relation of m.relations || []) {
        if (declared[relation.from]) declared[relation.from].relations[relation.type] = relation.to
    }
    return declared
}

// The live title, label values and relation targets of every note named in
// `wanted` ({ localId: { labels: [name], relations: [type] } }), read in one hop
// before the sync overwrites them. A label TAM has disabled lives under its
// `disabled:` name, which is still the user's value for review purposes.
async function liveMetadata(addonId, wanted) {
    return await api.runOnBackend((tamFileIdLabel, addonId, wanted) => {
        const live = {}
        for (const [localId, want] of Object.entries(wanted)) {
            const note = api.getNoteWithLabel(tamFileIdLabel, `${addonId}/${localId}`)
            if (!note || note.isDeleted) continue
            const entry = { title: note.title, labels: {}, relations: {} }
            for (const name of want.labels) {
                entry.labels[name] = note.getOwnedLabelValue(name) ?? note.getOwnedLabelValue(`disabled:${name}`)
            }
            for (const type of want.relations) {
                const targetId = note.getOwnedRelationValue(type) ?? note.getOwnedRelationValue(`disabled:${type}`)
                const target = targetId ? api.getNote(targetId) : null
                const targetTamId = target ? target.getOwnedLabelValue(tamFileIdLabel) : null
                // Compared as the manifest states it — a local id for a note of
                // this addon, a raw noteId for anything else.
                entry.relations[type] = targetTamId && targetTamId.startsWith(`${addonId}/`)
                    ? targetTamId.slice(addonId.length + 1)
                    : targetId
            }
            live[localId] = entry
        }
        return live
    }, [tamFileIdLabel, addonId, wanted])
}

// One row per declaration that moved in this update, skipping any the note
// already matches. `defaultSelected` starts a row on "use new" when the user
// never diverged from the old declaration — the same rule the settings review
// uses, so an untouched note is not asked about twice for no reason.
function metadataReviewItems(now, then, live) {
    const items = []
    const add = (localId, kind, name, currentValue, incomingValue, wasUntouched) => {
        if (currentValue === incomingValue) return
        const what = kind === "title" ? "title" : `${kind} ${name}`
        items.push({
            key: `${kind}:${localId}${name ? `:${name}` : ""}`,
            label: `${localId}: ${what}`,
            current: currentValue === null ? "(none)" : currentValue,
            incoming: incomingValue === null ? "(removed)" : incomingValue,
            defaultSelected: wasUntouched,
            localId,
            kind,
            name: name || null,
            currentValue,
            incomingValue
        })
    }
    for (const [localId, declaredNow] of Object.entries(now)) {
        const declaredThen = then[localId]
        const liveNote = live[localId]
        if (!declaredThen || !liveNote) continue
        if (declaredNow.title !== declaredThen.title) {
            add(localId, "title", null, liveNote.title, declaredNow.title, liveNote.title === declaredThen.title)
        }
        for (const kind of ["labels", "relations"]) {
            const names = new Set([...Object.keys(declaredNow[kind]), ...Object.keys(declaredThen[kind])])
            for (const name of names) {
                const valueNow = declaredNow[kind][name] ?? null
                const valueThen = declaredThen[kind][name] ?? null
                if (valueNow === valueThen) continue
                const liveValue = liveNote[kind][name] ?? null
                add(localId, kind === "labels" ? "label" : "relation", name, liveValue, valueNow, liveValue === valueThen)
            }
        }
    }
    return items
}

// Runs *before* the sync rewrites anything. Returns a prompt entry (appended to
// the pending prompts once the sync is done) or null when nothing moved.
async function collectMetadataPrompt(addonId, m, title) {
    const baseline = await loadReviewBaseline(addonId, "metadataBaseline")
    // No baseline means this install predates the metadata review: there is no
    // way to tell a user's rename from a declaration that has always been this
    // way, so record where things stand and review nothing this once.
    if (!isPlainObject(baseline)) return null
    const declared = declaredMetadata(m)
    const wanted = {}
    for (const [localId, entry] of Object.entries(declared)) {
        if (!baseline[localId]) continue
        wanted[localId] = {
            labels: [...new Set([...Object.keys(entry.labels), ...Object.keys(baseline[localId].labels || {})])],
            relations: [...new Set([...Object.keys(entry.relations), ...Object.keys(baseline[localId].relations || {})])]
        }
    }
    const items = metadataReviewItems(declared, baseline, await liveMetadata(addonId, wanted))
    return itemPrompt(metadataPromptSource, metadataPromptLocalId, title, items)
}

// `true` for an item makes the note match the manifest (including dropping a
// label or relation the manifest no longer declares, which nothing else does);
// `false` writes back what the note held before the update. The writes go
// through the same applyAttributes the sync uses.
async function applyMetadataSelections(addonId, prompt, selections) {
    await applyAttributes((prompt.items || []).map(item => {
        const value = selections[item.key] ? item.incomingValue : item.currentValue
        return {
            tamFileId: `${addonId}/${item.localId}`,
            type: item.kind,
            name: item.name,
            value,
            // Stored as the manifest states it: a local id of this addon
            // resolves live, anything else passes through as a raw note id.
            targetTamFileId: item.kind === "relation" && value !== null ? `${addonId}/${value}` : null
        }
    }))
}

// =========================================================================
// Review kinds: one registry entry per item-level prompt `source`, giving the
// Update Review a single dispatch point. A prompt with no source is the
// built-in whole-content diff, applied inline by resolvePrompt.
// =========================================================================

const reviewKinds = {
    [settingsPromptSource]: {
        apply: (addonId, record, prompt, selections) => applySettingsSelections(addonId, record.manifest, selections)
    },
    [metadataPromptSource]: {
        apply: (addonId, record, prompt, selections) => applyMetadataSelections(addonId, prompt, selections)
    }
}

// =========================================================================
// Install / Sync: the install/update entry point (syncAddon, installByUrl).
// =========================================================================

// Resolves `m`'s notes and applies every declared label and relation to them.
async function resolveManifest(m, addonId, anchors, options = {}) {
    const { entryLocalId = null, rootExternallyParented = false, storedNoteHashes = null } = options
    const noteMap = await resolveNotes(m, addonId, anchors, { entryLocalId, rootExternallyParented, storedNoteHashes })
    const actions = []
    for (const label of (m.labels || [])) {
        const noteId = noteMap[label.note]
        if (!noteId) continue
        const { name, isInheritable } = parseInheritableName(label.name)
        actions.push({ noteId, type: "label", name, value: String(label.value ?? ""), isInheritable })
    }
    // A `to` that isn't one of the manifest's own local ids is taken as a real
    // note id (e.g. "root"); one that is must come from the map, since passing
    // the local id through would set a relation to a note that doesn't exist.
    for (const rel of (m.relations || [])) {
        const fromRealId = noteMap[rel.from]
        if (!fromRealId) continue
        const toRealId = noteMap[rel.to] || rel.to
        if (!toRealId) continue
        actions.push({ noteId: fromRealId, type: "relation", name: rel.type, value: toRealId })
    }
    await applyAttributes(actions)
    return noteMap
}

// The note each reserved parent keyword stands for. Every declared note then
// resolves in one pass, taking its anchor from its own chain's root, so a
// relation between the two halves needs no deferral.
async function resolveAnchors(addonId, addonName, isSelf, hasPersistence) {
    const anchors = {
        root: isSelf
            ? await getAddonRootNoteId()
            : await ensureAddonAnchor(addonId, addonName, addonAnchorRootLocalId, await getAddonRootNoteId()),
        persistence: null
    }
    if (hasPersistence) {
        anchors.persistence = isSelf
            ? await getPersistenceNoteId()
            : await ensureAddonAnchor(addonId, addonName, addonAnchorPersistenceLocalId, await getPersistenceNoteId())
    }
    return anchors
}

// The update tail, after the notes are in place: the review collectors, then
// one merge into the record's pending prompts. The settings and metadata
// entries are *additive* alongside the whole-content diffs collected before
// the sync, each replacing only a prior entry of its own `source`.
async function runPostSyncReviews(addonId, m, title, metadataPrompt) {
    // Settings review runs last, against notes the sync has already replaced.
    const settingsPrompt = await collectSettingsPrompt(addonId, m, title)
    const extraPrompts = [metadataPrompt, settingsPrompt].filter(Boolean)
    if (extraPrompts.length === 0) return
    await updateDatabase(database => {
        const record = getRecord(database, addonId)
        const replacedSources = new Set(extraPrompts.map(p => p.source))
        const prompts = (getPersistence(record)?.pendingPrompts || [])
            .filter(p => !replacedSources.has(p.source))
            .concat(extraPrompts)
        setPendingPrompts(record, prompts)
    })
}

// The one entry point for getting an addon's notes to match its manifest — fresh install, update, and TAM's own self-sync are all the same call.
async function syncAddon(addonId, options = {}) {
    const { manifestSourceUrl = null, manual = true } = options
    if (!addonId.trim()) return
    const isSelf = addonId === TAM_ID
    const database = await loadDatabase()
    const existing = getRecord(database, addonId)
    const wasInstalled = !!existing?.installedVersion
    const previousVersion = existing?.installedVersion ?? null
    const fetchUrl = manifestSourceUrl || existing?.manifestSourceUrl
    if (!fetchUrl) throw new Error(`TAM: no manifestSourceUrl available to sync '${addonId}' (not installed yet, and none provided)`)
    log("step", `${addonId}: ${wasInstalled ? `updating from ${previousVersion}` : "installing"}`)
    log("info", `${addonId}: fetching manifest ${fetchUrl}`)
    const manifest = await fetchManifest(fetchUrl)
    const m = normalizeManifest(manifest)
    if (isSelf && !m.root) throw new Error(`TAM: manifest for ${addonId} is missing required 'root' field`)
    // Collected before anything is rewritten: the live title/labels/relations it
    // compares against are gone once resolveManifest has run.
    const metadataPrompt = wasInstalled && !isSelf
        ? await collectMetadataPrompt(addonId, m, manifest.name || addonId)
        : null
    const storedNoteHashes = existing?.noteHashes || null
    log("info", `${addonId}: manifest v${manifest.latestVersion} declares ${(m.notes || []).length} note(s)`)
    const pendingPrompts = await collectPendingPrompts(addonId, m, storedNoteHashes)
    if (pendingPrompts.length > 0) log("warn", `${addonId}: ${pendingPrompts.length} persistent note(s) differ from the shipped default - queued for review`)
    const anchors = await resolveAnchors(addonId, manifest.name, isSelf, persistentLocalIds(m).size > 0)
    const noteMap = await resolveManifest(m, addonId, anchors, {
        entryLocalId: isSelf ? m.root : null,
        rootExternallyParented: isSelf,
        storedNoteHashes
    })
    if (isSelf && !noteMap[m.root]) throw new Error(`TAM: root note '${m.root}' was not resolved for ${addonId}`)
    await pruneRemovedNotes(m, addonId)
    const storedManifest = stripManifestForStorage(m)
    const resolvedCount = Object.keys(noteMap).length
    const meta = extractAddonMeta(manifest)
    // A sync that skipped a note (its fetch failed) has not installed what the
    // manifest hash stands for, so the hash is left unset and the next update
    // check falls back to comparing versions until a clean sync records one.
    const fullyResolved = (m.notes || []).every(n => !!noteMap[n.id])
    if (!fullyResolved) {
        log("warn", `${addonId}: only ${resolvedCount}/${(m.notes || []).length} notes installed - `
            + "no contentHash recorded, so this stays flagged as a half-failed sync")
    }
    const contentHash = fullyResolved ? (manifest.contentHash ?? null) : null
    const noteHashes = recordedNoteHashes(m, noteMap, storedNoteHashes)
    // One record shape for fresh install and update alike: the spread carries an
    // update's prior persistence and flags through, a fresh install starts them.
    setRecord(database, addonId, {
        ...(existing || {}),
        installedVersion: manifest.latestVersion,
        contentHash,
        noteHashes,
        manifestSourceUrl: fetchUrl,
        meta,
        manifest: storedManifest,
        updateAvailable: false,
        // Pure user intent: only ever promoted, never reset by a maintenance sync.
        manuallyInstalled: manual || isSelf || !!existing?.manuallyInstalled,
        enabled: wasInstalled ? !!existing.enabled : isSelf
    })
    const record = getRecord(database, addonId)
    if (pendingPrompts.length > 0) ensurePersistence(record).pendingPrompts = pendingPrompts
    // The metadata baseline advances here rather than when the user answers: the
    // prompt below carries both values it needs, so it stays applicable either way.
    if (!isSelf) ensurePersistence(record).metadataBaseline = declaredMetadata(m)
    await saveDatabase(database)
    log("done", `${addonId}: ${wasInstalled ? "updated to" : "installed at"} v${manifest.latestVersion}`)
    if (!wasInstalled && !isSelf) await enableAddon(addonId, false)
    if (isSelf) return
    if (!wasInstalled) {
        await recordSettingsBaseline(addonId, m)
        return
    }
    await runPostSyncReviews(addonId, m, meta.name || addonId, metadataPrompt)
}

// Installs by manifestSourceUrl alone — the caller doesn't need to know the addon's id.
async function installByUrl(manifestSourceUrl, options = {}) {
    log("step", `installing from ${manifestSourceUrl}`)
    const manifest = await fetchManifest(manifestSourceUrl)
    if (!manifest.id) throw new Error("TAM: manifest has no 'id' field")
    await syncAddon(manifest.id, { ...options, manifestSourceUrl })
}

// Syncs the given addons in sequence and returns which of them queued update
// prompts, so a caller only has to run the review flow over `promptQueue`.
// `onProgress` gets a short "which addon, how far along" line per addon.
async function syncMany(addonIds, onProgress = null) {
    const promptQueue = []
    for (let i = 0; i < addonIds.length; i++) {
        const addonId = addonIds[i]
        if (onProgress) onProgress(`${addonId} (${i + 1}/${addonIds.length})`)
        await syncAddon(addonId)
        if ((await getPendingPrompts(addonId)).length > 0) promptQueue.push(addonId)
    }
    return { promptQueue }
}

// =========================================================================
// Lifecycle / query: enable/disable, read-only addon listing, update-checking, and database validation.
// =========================================================================

async function enableAddon(addonId, enabled) {
    if (!addonId.trim()) return
    let database = await loadDatabase()
    const record = getRecord(database, addonId)
    const rootNoteId = await resolveAddonRootNoteId(addonId, record.manifest)
    if (!rootNoteId) return
    await api.runOnBackend((tamFileIdLabel, addonId, noteId, enabled, addonLabels) => {
        for (const id of api.getNote(noteId).getSubtreeNoteIds()) {
            const note = api.getNote(id)
            if (!note.getOwnedLabelValue(tamFileIdLabel)?.startsWith(`${addonId}/`)) continue
            for (const attribute of note.getOwnedAttributes() || []) {
                const isDisabledAttr = attribute.name.startsWith("disabled:")
                if (enabled ? !isDisabledAttr : !addonLabels.includes(attribute.name)) continue
                const newName = enabled ? attribute.name.slice("disabled:".length) : `disabled:${attribute.name}`
                note.removeAttribute(attribute.type, attribute.name)
                note.addAttribute(attribute.type, newName, attribute.value, attribute.isInheritable, attribute.position)
            }
        }
    }, [tamFileIdLabel, addonId, rootNoteId, enabled, addonLabels])
    record.enabled = enabled
    await saveDatabase(database)
    log("done", `${addonId}: ${enabled ? "enabled" : "disabled"}`)
}

// Returns every installed addon merged with live-resolved rootNoteId/settingsNoteId.
async function getAllAddons() {
    let database = await loadDatabase()
    const lookups = []
    for (const [addonId, addon] of Object.entries(installedAddons(database))) {
        if (!addon.installedVersion || !addon.manifest) continue
        lookups.push({ addonId, rootLocalId: addon.manifest.root ?? addonAnchorRootLocalId, settingsLocalId: addon.manifest.settingsNote })
    }
    const resolved = await api.runOnBackend((tamFileIdLabel, lookups) => {
        const result = {}
        for (const { addonId, rootLocalId, settingsLocalId } of lookups) {
            function resolveLocal(localId) {
                if (!localId) return null
                const note = api.getNoteWithLabel(tamFileIdLabel, `${addonId}/${localId}`)
                return (note && !note.isDeleted) ? note.noteId : null
            }
            result[addonId] = { rootNoteId: resolveLocal(rootLocalId), settingsNoteId: resolveLocal(settingsLocalId) }
        }
        return result
    }, [tamFileIdLabel, lookups])
    // A narrow projection rather than the raw record: these are the fields the
    // UI renders, so the record's internals (stored manifest, hashes, prompt
    // bookkeeping) never leak into the view layer.
    const addons = {}
    for (const [addonId, addon] of Object.entries(installedAddons(database))) {
        if (!addon.installedVersion) continue
        addons[addonId] = {
            id: addonId,
            ...(addon.meta || {}),
            installedVersion: addon.installedVersion,
            latestVersion: addon.installedVersion,
            updateAvailable: !!addon.updateAvailable,
            availableVersion: addon.availableVersion,
            availableChangelog: addon.availableChangelog || null,
            enabled: !!addon.enabled,
            manifestSourceUrl: addon.manifestSourceUrl,
            readmeLocalId: addon.manifest?.readmeNote || null,
            hasPersistentData: persistentLocalIds(addon.manifest || {}).size > 0,
            ...(resolved[addonId] || {})
        }
    }
    return addons
}

/*
 * Refetches every installed addon's own manifestSourceUrl and decides whether an
 * update exists.
 *
 * A published manifest carries a `contentHash` covering its structure and every
 * note's content, so a change is detected from the content itself and shipping a
 * fix no longer depends on the author remembering to bump `latestVersion`. The
 * version comparison stays as the fallback for a manifest that carries no hash —
 * a hand-authored one, or one published before this existed.
 */
async function checkForAddonUpdates() {
    let database = await loadDatabase()
    const installed = installedAddons(database)
    log("step", `checking ${Object.keys(installed).length} installed addon(s) for updates`)
    await Promise.all(Object.entries(installed).map(async ([addonId, addon]) => {
        if (!addon.installedVersion || !addon.manifestSourceUrl) return
        try {
            const manifest = await fetchManifest(addon.manifestSourceUrl)
            if (manifest.contentHash && addon.contentHash) {
                addon.updateAvailable = manifest.contentHash !== addon.contentHash
            } else if (manifest.latestVersion) {
                addon.updateAvailable = versionCompare(manifest.latestVersion, addon.installedVersion) > 0
            } else {
                return
            }
            if (addon.updateAvailable) log("info", `${addonId}: update available`)
            // Left unset for a content-only update, so the button reads "Update"
            // rather than offering the version already installed.
            if (addon.updateAvailable && manifest.latestVersion && manifest.latestVersion !== addon.installedVersion) {
                addon.availableVersion = manifest.latestVersion
            } else {
                delete addon.availableVersion
            }
            // So "what's new" is the changelog of the version being offered, not the installed one's.
            if (addon.updateAvailable) addon.availableChangelog = manifest.changelog || null
            else delete addon.availableChangelog
        } catch (e) {
            log("warn", `${addonId}: update check failed - ${e.message}`)
        }
    }))
    await saveDatabase(database)
    const count = Object.values(installed).filter(a => a.updateAvailable).length
    log("done", count ? `${count} update(s) available` : "everything is up to date")
}

// =========================================================================
// Diagnostics: the single audit behind TAM's maintenance page. It checks TAM's
// own bookkeeping, the addon-owned note tree, and every installed addon against
// its live manifest, and returns one row per problem with the repair for it.
//
// The audit is read-only: nothing is deleted, re-synced or repointed until
// repairIssue() is called with a row. The database validation and the two note
// sweeps used to be three separate buttons, and the sweeps deleted first and
// reported after; they're folded in here as findings you see before anything
// goes.
//
// The reason this is worth having at all: syncAddon() advances installedVersion
// unconditionally but records a contentHash only once every note resolved, so a
// note whose fetch failed leaves the addon reporting itself up to date while
// still running the previous version's code.
// =========================================================================

// One row of the diagnosis, with the repairs offered for it - more than one
// where there's a real choice, as with an addon whose source is gone: repoint it
// at a catalog's copy, or give up and uninstall it. An empty `fixes` means
// nothing TAM can do unattended.
//
// `self` marks a repair to TAM's own notes, which needs a reload before it has
// actually taken effect.

// What each code means in one line, shipped on the row itself so the UI's
// Issue column explains itself without its own copy of this map.
const ISSUE_TITLES = {
    "duplicate-id": "Duplicate TAMFILEID",
    "orphaned-note": "Orphaned note",
    "unclaimed-note": "Unclaimed note",
    "dead-source": "Source unreachable",
    "unverifiable-source": "Source carries no hashes",
    "partial-sync": "Sync half-failed",
    "missing-note": "Note not installed",
    "missing-attachment": "Attachment not installed",
    "content-drift": "Content doesn't match manifest",
    "broken-wiring": "Wiring not applied",
    "duplicate-child-title": "Duplicate child name breaks the script bundle"
}

function issueRow(addonId, code, target, detail, fixes = []) {
    const FIX_LABELS = {
        resync: "Re-sync",
        repoint: "Repoint & re-sync",
        delete: "Delete note",
        detach: "Detach from parent",
        uninstall: "Uninstall"
    }
    return {
        addonId,
        code,
        title: ISSUE_TITLES[code] || code,
        target,
        detail,
        fixes: fixes.filter(Boolean).map(fix => ({
            ...fix,
            label: `${FIX_LABELS[fix.kind]}${fix.self ? " & reload" : ""}`
        }))
    }
}

// sha256 of a string as lowercase hex - the digest a published manifest's `sha`
// carries for that note's source file. Needs a secure context for crypto.subtle,
// which Trilium always is (trilium-app:// is registered as a secure scheme).
async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

// addonId -> a catalog's manifest URL for it, used to repoint a record whose own
// source has gone dead or carries nothing to verify against. Only hashed
// manifests are indexed: repointing at another unverifiable one fixes nothing.
async function catalogSourceIndex() {
    const index = {}
    for (const catalogUrl of await getCatalogs()) {
        try {
            const { addons } = await fetchCatalogAddons(catalogUrl)
            for (const entry of addons) {
                if (entry.id && entry.contentHash && !index[entry.id]) index[entry.id] = entry.manifestSourceUrl
            }
        } catch (e) {
            log("warn", `couldn't read catalog ${catalogUrl} while diagnosing - ${e.message}`)
        }
    }
    return index
}

// Everything the audit needs about one addon's live notes, in a single backend
// round trip. Content comes back only for `contentIds`, so a 1MB binary or a
// note with nothing to compare against isn't serialized for nothing.
//
// Resolution mirrors resolveNotes(): a file vendored by two addons is installed
// once, under whichever addon got there first, so a note that doesn't answer to
// this addon's #TAMFILEID is still installed if one carries its #TAMSOURCEURL.
// Matching on the id alone would report every shared library note as missing.
// `adoptableNoteId` per note comes from resolveAdoptableNotes(), the same lookup
// the sync adopts by.
async function readLiveAddon(addonId, noteDefs, contentIds) {
    return await api.runOnBackend((tamFileIdLabel, addonId, noteDefs, contentIds) => {
        const live = {}
        for (const { id: localId, adoptableNoteId } of noteDefs) {
            let note = api.getNoteWithLabel(tamFileIdLabel, `${addonId}/${localId}`)
            if (note && note.isDeleted) note = null
            if (!note && adoptableNoteId) note = api.getNote(adoptableNoteId)
            if (!note || note.isDeleted) continue
            const attributes = note.getOwnedAttributes() || []
            live[localId] = {
                noteId: note.noteId,
                parentIds: note.getParentNotes().map(parent => parent.noteId),
                children: note.getChildNotes().map(child => ({ noteId: child.noteId, title: child.title })),
                labels: attributes.filter(a => a.type === "label").map(a => ({ name: a.name, value: a.value })),
                relations: attributes.filter(a => a.type === "relation").map(a => ({ name: a.name, value: a.value })),
                attachments: note.getAttachments().map(a => a.title),
                content: contentIds.includes(localId) ? note.getContent() : null
            }
        }
        return live
    }, [tamFileIdLabel, addonId, noteDefs, contentIds])
}

// TAM's own bookkeeping. A duplicate is the one thing a live-lookup design
// can't self-correct - getNoteWithLabel() just returns whichever match it
// finds first - and TAM can't tell which copy is the real one, so this is
// reported without a repair.
async function auditDuplicateTamIds(rows) {
    const duplicateIds = await api.runOnBackend((tamFileIdLabel) => {
        const byValue = {}
        for (const note of api.getNotesWithLabel(tamFileIdLabel)) {
            if (note.isDeleted) continue
            const value = note.getOwnedLabelValue(tamFileIdLabel)
            if (!value) continue
            byValue[value] = byValue[value] || []
            byValue[value].push(note.noteId)
        }
        return Object.entries(byValue).filter(([, noteIds]) => noteIds.length > 1)
    }, [tamFileIdLabel])
    for (const [tamFileId, noteIds] of duplicateIds) {
        rows.push(issueRow(tamFileId.split("/")[0], "duplicate-id", tamFileId,
            `claimed by ${noteIds.length} notes at once (${noteIds.join(", ")}) - delete the wrong one by hand`, []))
    }
}

// Notes the tree is holding that nothing owns any more.
async function auditUnownedNotes(rows) {
    for (const note of await findOrphanedNotes()) {
        rows.push(issueRow(note.tamFileId.split("/")[0], "orphaned-note", note.title,
            "has no parents left, so nothing in the tree reaches it",
            [{ kind: "delete", noteId: note.noteId }]))
    }
    for (const note of await findInvalidAddonTreeNotes()) {
        rows.push(issueRow(note.tamFileId ? note.tamFileId.split("/")[0] : "(none)", "unclaimed-note", note.title,
            note.tamFileId
                ? `is tagged for '${note.tamFileId}', which isn't installed`
                : "sits under the addon root carrying no #TAMFILEID",
            [{ kind: "delete", noteId: note.noteId }]))
    }
}

function auditMissingNotes({ addonId, notes, live, persistentIds, resyncFixes }, rows) {
    for (const noteDef of notes) {
        if (live[noteDef.id]) continue
        rows.push(issueRow(addonId, "missing-note", noteDef.title,
            persistentIds.has(noteDef.id)
                ? `persistent note '${noteDef.id}' is not installed - saved data for it may have been lost`
                : `declared note '${noteDef.id}' is not installed`,
            resyncFixes))
    }
}

async function auditContentDrift({ addonId, notes, live, resyncFixes }, rows) {
    for (const noteDef of notes) {
        const entry = live[noteDef.id]
        if (!entry || entry.content === null) continue
        if (await sha256Hex(entry.content) !== noteDef.sha) {
            rows.push(issueRow(addonId, "content-drift", noteDef.title,
                "the installed copy doesn't match the manifest - stale bytes, or edited by hand",
                resyncFixes))
        }
    }
}

// An attachment is invisible in the tree and its absence is only ever
// logged server-side, so an icon pack whose font never landed just
// silently stops being offered.
function auditMissingAttachments({ addonId, notes, live, resyncFixes }, rows) {
    for (const noteDef of notes) {
        const entry = live[noteDef.id]
        if (!entry) continue
        for (const att of (noteDef.attachments || [])) {
            if (entry.attachments.includes(att.title)) continue
            rows.push(issueRow(addonId, "missing-attachment", `${noteDef.title}/${att.title}`,
                `declared attachment '${att.title}' is not installed on note '${noteDef.id}'`,
                resyncFixes))
        }
    }
}

// A note missing entirely is already a row above; these only look at
// wiring between notes that both exist, so one failure reads as one row.
function auditChildWiring({ addonId, m, live, resyncFixes }, rows) {
    for (const link of (m.children || [])) {
        if (link.parent === "root" || link.parent === "persistence") continue
        const parent = live[link.parent]
        const child = live[link.child]
        if (!parent || !child) continue
        if (!child.parentIds.includes(parent.noteId)) {
            rows.push(issueRow(addonId, "broken-wiring", link.child,
                `is not parented under '${link.parent}' as the manifest declares`,
                resyncFixes))
        }
    }
}

function auditRelationWiring({ addonId, m, live, resyncFixes }, rows) {
    for (const relation of (m.relations || [])) {
        const from = live[relation.from]
        const to = live[relation.to]
        if (!from || !to) continue
        const present = from.relations.some(attr => attributeMatches(attr, relation.type, to.noteId))
        if (!present) {
            rows.push(issueRow(addonId, "broken-wiring", `~${relation.type}`,
                `from '${relation.from}' to '${relation.to}' is missing`,
                resyncFixes))
        }
    }
}

// Trilium builds a script bundle as
//   function(exports, module, require, api, <one param per required child>)
// naming each parameter after that child's *title*. Two children of one
// note sharing a title emit the same parameter name twice, and the whole
// bundle dies at parse time with "Duplicate parameter name not allowed in
// this context" - the note simply stops running, with nothing in the
// manifest to explain why.
//
// A stale copy gets there when two notes share a #TAMSOURCEURL: adoption
// picks whichever getNoteWithLabel() returns first, so successive syncs
// can parent two different copies of one file under the same note.
// reconcileNoteParenting() can't undo it - the stale copy isn't in this
// addon's noteMap, so it never looks at it.
function auditDuplicateChildTitles({ addonId, m, notes, live }, rows) {
    for (const noteDef of notes) {
        const entry = live[noteDef.id]
        if (!entry) continue
        const declaredChildIds = new Set((m.children || [])
            .filter(link => link.parent === noteDef.id)
            .map(link => live[link.child]?.noteId)
            .filter(Boolean))
        const byTitle = {}
        for (const child of entry.children) {
            (byTitle[child.title] = byTitle[child.title] || []).push(child)
        }
        for (const [title, sameTitle] of Object.entries(byTitle)) {
            if (sameTitle.length < 2) continue
            const stale = sameTitle.filter(child => !declaredChildIds.has(child.noteId))
            // Only offer to detach when a declared copy is among them, so the
            // one the manifest actually wants is the one left behind.
            const canDetach = stale.length < sameTitle.length
            for (const child of stale) {
                rows.push(issueRow(addonId, "duplicate-child-title", title,
                    `'${noteDef.title}' has ${sameTitle.length} children named '${title}', which makes its `
                    + "script bundle fail to parse and stops the note running"
                    + (canDetach ? "" : " - none of them is the one this manifest declares, so detach the wrong one by hand"),
                    canDetach ? [{ kind: "detach", noteId: child.noteId, parentNoteId: entry.noteId }] : []))
            }
        }
    }
}

function auditLabelWiring({ addonId, m, live, resyncFixes }, rows) {
    for (const label of (m.labels || [])) {
        const entry = live[label.note]
        if (!entry) continue
        const { name } = parseInheritableName(label.name)
        const value = String(label.value ?? "")
        const present = entry.labels.some(attr => attributeMatches(attr, name, value))
        if (!present) {
            rows.push(issueRow(addonId, "broken-wiring", `#${name}`,
                `on '${label.note}' is missing or holds the wrong value`,
                resyncFixes))
        }
    }
}

// One installed addon against its live manifest: source health first, then the
// live tree gathered once and handed to each family above.
//
// TAM audits itself like anything else, but its repairs are marked
// `self`. Rewriting a script note doesn't disturb the already-loaded
// instance - the running copy lives in memory - so the repair is safe to
// apply from inside TAM; what isn't safe is treating it as done, since
// every note would be repaired while the old code kept running. `self`
// is what makes the UI demand a reload instead.
async function auditAddon(addonId, addon, catalogSources, rows) {
    const isSelf = addonId === TAM_ID
    const canRepoint = !!catalogSources[addonId]
    const resyncFixes = [{ kind: "resync", self: isSelf }]
    // A source that can't be reached is the one case with a real choice:
    // point it at a catalog's copy, or accept it's gone and remove it. TAM
    // itself is never offered for uninstall - there'd be nothing left to run
    // the uninstall, let alone anything to manage addons with afterwards.
    // The repoint fix carries the catalog URL it was diagnosed with, so the
    // repair doesn't have to refetch every catalog to find it again.
    const sourceFixes = [
        canRepoint ? { kind: "repoint", self: isSelf, url: catalogSources[addonId] } : null,
        isSelf ? null : { kind: "uninstall" }
    ].filter(Boolean)

    let manifestFetched
    try {
        manifestFetched = await fetchManifest(addon.manifestSourceUrl)
    } catch (e) {
        log("warn", `${addonId}: manifest unreachable at ${addon.manifestSourceUrl}`)
        rows.push(issueRow(addonId, "dead-source", addon.manifestSourceUrl,
            "its manifest can no longer be fetched"
            + (canRepoint ? "" : ", and no catalog offers a replacement"),
            sourceFixes))
        return
    }

    const m = normalizeManifest(manifestFetched)
    const notes = m.notes || []
    const hashedNotes = notes.filter(noteDef => noteDef.sha)

    if (!manifestFetched.contentHash && hashedNotes.length === 0) {
        rows.push(issueRow(addonId, "unverifiable-source", addon.manifestSourceUrl,
            "carries no contentHash and no per-note hashes, so update detection falls back to comparing "
            + "version numbers and installed content can't be checked at all"
            + (canRepoint ? "" : ", and no catalog offers a hashed replacement"),
            sourceFixes))
    } else if (manifestFetched.contentHash && !addon.contentHash) {
        rows.push(issueRow(addonId, "partial-sync", `v${addon.installedVersion}`,
            "the last sync never recorded a contentHash, so at least one note failed to install "
            + "while the version was still advanced",
            resyncFixes))
    }

    // What can meaningfully be compared against a manifest `sha`, which is
    // the digest of the *source file*. A frozen note is meant to diverge, a
    // renderAsHTML note stores marked.parse() output rather than the markdown
    // that was hashed, and a binary note isn't worth shipping over the wire
    // to hash.
    const persistentIds = persistentLocalIds(m)
    const contentIds = hashedNotes
        .filter(noteDef => !noteDef.binary && !noteDef.renderAsHTML && !contentIsFrozen(noteDef, persistentIds))
        .map(noteDef => noteDef.id)
    const { adoptable } = await readNoteResolution(addonId, notes)
    const live = await readLiveAddon(
        addonId,
        notes.map(noteDef => ({ id: noteDef.id, adoptableNoteId: adoptable[noteDef.id] || null })),
        contentIds
    )

    const ctx = { addonId, m, notes, live, persistentIds, resyncFixes }
    auditMissingNotes(ctx, rows)
    await auditContentDrift(ctx, rows)
    auditMissingAttachments(ctx, rows)
    auditChildWiring(ctx, rows)
    auditRelationWiring(ctx, rows)
    auditDuplicateChildTitles(ctx, rows)
    auditLabelWiring(ctx, rows)
}

// The whole audit, as one flat list of rows. Read-only: nothing is deleted,
// re-synced or repointed until repairIssue() is called with a row. One issue
// family per function above; this is just the order they run in.
async function diagnose() {
    log("step", "running diagnostics")
    const database = await loadDatabase()
    const catalogSources = await catalogSourceIndex()
    const rows = []
    await auditDuplicateTamIds(rows)
    await auditUnownedNotes(rows)
    // Audited concurrently - the manifest refetch dominates each addon's audit -
    // with every addon appending to its own list, so row order stays stable.
    const installed = Object.entries(installedAddons(database))
        .filter(([, addon]) => addon.installedVersion)
    const addonRows = await Promise.all(installed.map(async ([addonId, addon]) => {
        const own = []
        await auditAddon(addonId, addon, catalogSources, own)
        return own
    }))
    for (const own of addonRows) rows.push(...own)
    log("done", rows.length ? `diagnostics found ${rows.length} issue(s)` : "diagnostics found no issues")
    return rows
}

// Applies one row's repair, and only that row's.
//
// Everything an addon owns is repaired by a re-sync: syncAddon() already
// re-creates missing notes, rewrites drifted content, re-applies wiring and
// records the hashes, so there is no second repair path to keep correct. It also
// still routes persistent notes through the prompt system, so a repair can never
// silently overwrite settings.
// Applies one chosen repair from one row, and only that. `fix` is the entry the
// user picked out of the row's `fixes`, so a row offering both a repoint and an
// uninstall does what was actually pressed.
//
// "uninstall" is not handled here: it goes through TAM's normal uninstall flow
// in the UI, which asks about dangling references and saved data first.
//
// Returns { requiresReload } - true once TAM has rewritten its own notes, whose
// repaired code only starts running on the next load.
async function repairIssue(issue, fix) {
    if (!issue || !fix) return { requiresReload: false }

    if (fix.kind === "delete") {
        log("step", `deleting ${issue.target}`)
        await deleteTamNote(fix.noteId)
        log("done", `deleted ${issue.target}`)
        return { requiresReload: false }
    }

    if (fix.kind === "detach") {
        log("step", `detaching the duplicate '${issue.target}'`)
        await detachNoteFromParent(fix.noteId, fix.parentNoteId)
        log("done", `detached the duplicate '${issue.target}'`)
        return { requiresReload: false }
    }

    if (fix.kind === "repoint") {
        const database = await loadDatabase()
        const record = getRecord(database, issue.addonId)
        if (!fix.url || !record) {
            log("error", `${issue.addonId}: no catalog offers a replacement manifest any more`)
            return { requiresReload: false }
        }
        record.manifestSourceUrl = fix.url
        await saveDatabase(database)
        log("info", `${issue.addonId}: repointed at ${fix.url}`)
    }

    // Maintenance, not a manual install: a repaired addon must not start
    // claiming the user installed it by hand.
    await syncAddon(issue.addonId, { manual: false })
    if (fix.self) log("warn", "TAM repaired its own notes - reload Trilium to run the repaired version")
    return { requiresReload: !!fix.self }
}

// =========================================================================
// Catalog: catalog CRUD + browsing. A "catalog" is a URL serving {"tam-addons": [manifestSourceUrl, ...]}.
// =========================================================================

async function addCatalog(catalogUrl) {
    catalogUrl = catalogUrl.trim()
    if (!catalogUrl) return
    log("step", `adding catalog ${catalogUrl}`)
    let database = await loadDatabase()
    if (!database.catalogs.includes(catalogUrl)) {
        database.catalogs.push(catalogUrl)
        await saveDatabase(database)
    }
}

async function deleteCatalog(catalogUrl) {
    await updateDatabase(database => {
        database.catalogs = database.catalogs.filter(u => u !== catalogUrl)
    })
}

async function getCatalogs() {
    return (await loadDatabase()).catalogs
}

// Renders a catalog's "Visit Website" link without fetching every addon manifest it lists.
async function fetchCatalogMeta(catalogUrl) {
    return { webUrl: (await fetchJson(catalogUrl)).webUrl || null }
}

// Fetches a catalog's addon list fresh every time.
async function fetchCatalogAddons(catalogUrl) {
    const catalog = await fetchJson(catalogUrl)
    const urls = catalog["tam-addons"] || []
    const results = await Promise.all(urls.map(async (manifestSourceUrl) => {
        try {
            const manifest = await fetchManifest(manifestSourceUrl)
            return { ...manifest, manifestSourceUrl }
        } catch (e) {
            log("warn", `catalog entry ${manifestSourceUrl} could not be fetched - ${e.message}`)
            return null
        }
    }))
    return { webUrl: catalog.webUrl || null, addons: results.filter(Boolean) }
}

// =========================================================================
// Uninstall / recovery: removing an addon's own note branches, detecting dangling external references, and the orphan-sweep / full-reinitialize recovery tools.
// =========================================================================

// User-triggered maintenance sweep: deletes any #TAMFILEID-tagged note with zero parents.
// Read-only: every #TAMFILEID-tagged note with no parents left. Deleting one is
// deleteTamNote() below, so the diagnosis can list them before anything goes.
async function findOrphanedNotes() {
    return await api.runOnBackend((tamFileIdLabel) => {
        const found = []
        for (const note of api.getNotesWithLabel(tamFileIdLabel)) {
            if (note.isDeleted) continue
            if (note.getParentNotes().length > 0) continue
            const tamFileId = note.getOwnedLabelValue(tamFileIdLabel)
            if (!tamFileId) continue
            found.push({ noteId: note.noteId, title: note.title, tamFileId })
        }
        return found
    }, [tamFileIdLabel])
}

// Read-only: every note under the addon root that no installed addon claims -
// either untagged, or tagged for an addon that isn't installed any more.
async function findInvalidAddonTreeNotes() {
    const database = await loadDatabase()
    const installedIds = Object.keys(installedAddons(database))
    const addonsRootId = await getAddonRootNoteId()
    if (!addonsRootId) return []
    return await api.runOnBackend((tamFileIdLabel, addonsRootId, installedIds) => {
        const installedSet = new Set(installedIds)
        const rootNote = api.getNote(addonsRootId)
        if (!rootNote) return []
        const found = []
        for (const noteId of rootNote.getSubtreeNoteIds()) {
            if (noteId === addonsRootId) continue
            const note = api.getNote(noteId)
            if (!note || note.isDeleted) continue
            const tamFileId = note.getOwnedLabelValue(tamFileIdLabel)
            const addonId = tamFileId ? tamFileId.split("/")[0] : null
            if (tamFileId && installedSet.has(addonId)) continue
            found.push({ noteId: note.noteId, title: note.title, tamFileId })
        }
        return found
    }, [tamFileIdLabel, addonsRootId, installedIds])
}

// The repair behind every "Detach from parent" row: removes one branch, never
// the note. Trilium refuses to remove a note's last parent, so a note living
// only here is left in place rather than deleted.
async function detachNoteFromParent(noteId, parentNoteId) {
    await api.runOnBackend((noteId, parentNoteId) => {
        api.ensureNoteIsAbsentFromParent(noteId, parentNoteId)
    }, [noteId, parentNoteId])
}

// The repair behind every "Delete note" row.
async function deleteTamNote(noteId) {
    await api.runOnBackend((noteId) => {
        const note = api.getNote(noteId)
        if (note && !note.isDeleted) note.deleteNote()
    }, [noteId])
}

// Removes every branch this addon owns, never a blanket note-level delete.
async function detachAddonOwnedBranches(addonId, persistentIds = []) {
    const anchorIds = [await getAddonRootNoteId()].filter(Boolean)
    await api.runOnBackend((tamFileIdLabel, addonId, anchorIds, persistentIds) => {
        const prefix = `${addonId}/`
        const persistentSet = new Set(persistentIds)
        for (const note of api.getNotesWithLabel(tamFileIdLabel)) {
            if (note.isDeleted) continue
            const tamFileId = note.getOwnedLabelValue(tamFileIdLabel)
            if (!tamFileId || !tamFileId.startsWith(prefix)) continue
            if (persistentSet.has(tamFileId.slice(prefix.length))) continue
            const parentsToDetach = []
            let keepsAnyParent = false
            for (const parentNote of note.getParentNotes()) {
                const isAnchor = anchorIds.includes(parentNote.noteId)
                const parentTamId = parentNote.getOwnedLabelValue(tamFileIdLabel)
                const ownedByThisAddon = parentTamId && parentTamId.startsWith(prefix)
                const ownedByAnotherAddon = parentTamId && !ownedByThisAddon && !isAnchor
                if (ownedByAnotherAddon) {
                    keepsAnyParent = true
                } else {
                    parentsToDetach.push(parentNote)
                }
            }
            if (!keepsAnyParent) {
                note.deleteNote()
                continue
            }
            for (const parentNote of parentsToDetach) {
                api.ensureNoteIsAbsentFromParent(note.noteId, parentNote.noteId)
            }
        }
    }, [tamFileIdLabel, addonId, anchorIds, persistentIds])
}

// `deleteData` drops the protected-id list entirely, so the same sweep that tears
// down the structural tree also takes the persistent notes and their anchor.
async function deleteAddon(addonId, options = {}) {
    const { deleteData = false } = options
    if (!addonId.trim()) return
    let database = await loadDatabase()
    const addonRecord = getRecord(database, addonId)
    const persistentIds = deleteData
        ? []
        : [...persistentLocalIds(addonRecord?.manifest || {}), addonAnchorPersistenceLocalId]
    await detachAddonOwnedBranches(addonId, persistentIds)
    deleteRecord(database, addonId)
    await saveDatabase(database)
    log("done", `${addonId}: uninstalled`)
}

// Pre-uninstall safety check: finds every relation pointing into an addon's subtree from outside it.
async function findExternalReferences(addonId) {
    const addonRecord = getRecord(await loadDatabase(), addonId)
    if (addonRecord?.manifest?.allowExternalReferences) return []
    const rootNoteId = await resolveAddonRootNoteId(addonId, addonRecord?.manifest)
    if (!rootNoteId) return []
    return await api.runOnBackend((rootNoteId) => {
        const subtreeIds = new Set(api.getNote(rootNoteId).getSubtreeNoteIds())
        const found = []
        for (const noteId of subtreeIds) {
            const note = api.getNote(noteId)
            for (const rel of note.getTargetRelations()) {
                if (subtreeIds.has(rel.noteId)) continue
                const sourceNote = api.getNote(rel.noteId)
                found.push({
                    sourceNoteId: rel.noteId,
                    sourceTitle: sourceNote ? sourceNote.title : "(unknown)",
                    relationName: rel.name,
                    targetNoteId: noteId,
                    targetTitle: note.title
                })
            }
        }
        return found
    }, [rootNoteId])
}

// The user-facing "uninstall" entry point.
async function uninstallAddon(addonId, options = {}) {
    const { deleteData = false } = options
    if (!addonId.trim()) return
    const database = await loadDatabase()
    const record = getRecord(database, addonId)
    if (!record?.installedVersion) return
    log("step", `${addonId}: uninstalling${deleteData ? " and deleting its saved data" : " (saved data kept)"}`)
    await deleteAddon(addonId, { deleteData })
}

// Whether an addon owns any persistent notes — drives the "delete stored data" option on uninstall.
async function hasPersistentData(addonId) {
    const record = getRecord(await loadDatabase(), addonId)
    return persistentLocalIds(record?.manifest || {}).size > 0
}

// Recovery tool: uninstalls every addon except TAM itself, then hard-resets the Database note to just its catalogs and a bare TAM entry.
async function reinitializeDatabase() {
    let database = await loadDatabase()
    const doomed = Object.keys(installedAddons(database)).filter(id => id !== TAM_ID)
    log("step", `reinitializing: uninstalling ${doomed.length} addon(s) and clearing TAM's own install state`)
    for (const addonId of doomed) {
        await uninstallAddon(addonId)
    }
    database = await loadDatabase()
    await saveDatabase({
        catalogs: database.catalogs || [],
        installedAddons: {
            [TAM_ID]: {
                manifestSourceUrl: getRecord(database, TAM_ID)?.manifestSourceUrl
            }
        }
    })
    log("done", "database reinitialized - catalogs kept, TAM will re-sync itself on next load")
}

// =========================================================================
// UI helpers: rendering support for the TAM.jsx views that isn't part of the install/resolve machinery.
// =========================================================================

// Renders an addon's README as HTML for the detail view.
async function fetchReadmeHtml(addonId, readmeLocalId) {
    const noteId = await resolveStoredNoteId(addonId, readmeLocalId)
    if (!noteId) return null
    const markdown = await api.runOnBackend((noteId) => {
        const note = api.getNote(noteId)
        return note ? note.getContent() : null
    }, [noteId])
    if (markdown === null) return null
    return marked.parse(markdown)
}

// Renders an addon's changelog as HTML for the detail view. It is a file beside
// the manifest rather than a note in the tree, so it is fetched rather than read
// out of Trilium - which is also what lets an addon show one before it is installed.
async function fetchChangelogHtml(changelogUrl) {
    if (!changelogUrl) return null
    return marked.parse(await fetchContent(changelogUrl, false))
}

// =========================================================================
// Public surface — the same names lib-tam.js has always exported.
// =========================================================================

module.exports.addCatalog = addCatalog
module.exports.deleteCatalog = deleteCatalog
module.exports.getCatalogs = getCatalogs
module.exports.fetchCatalogAddons = fetchCatalogAddons
module.exports.fetchCatalogMeta = fetchCatalogMeta
module.exports.getAllAddons = getAllAddons
module.exports.checkForAddonUpdates = checkForAddonUpdates
module.exports.syncAddon = syncAddon
module.exports.syncMany = syncMany
module.exports.installByUrl = installByUrl
module.exports.uninstallAddon = uninstallAddon
module.exports.hasPersistentData = hasPersistentData
module.exports.reinitializeDatabase = reinitializeDatabase
module.exports.findExternalReferences = findExternalReferences
module.exports.enableAddon = enableAddon
module.exports.getPendingPrompts = getPendingPrompts
module.exports.resolvePrompt = resolvePrompt
module.exports.clearPendingPrompts = clearPendingPrompts
module.exports.fetchReadmeHtml = fetchReadmeHtml
module.exports.fetchChangelogHtml = fetchChangelogHtml
module.exports.diagnose = diagnose
module.exports.repairIssue = repairIssue
module.exports.log = log
module.exports.subscribeToLog = subscribeToLog
module.exports.getLogEntries = getLogEntries
module.exports.clearLog = clearLog
module.exports.TYPE_COLORS = TYPE_COLORS
