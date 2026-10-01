/*
 * media-tracker@beatlink — backend customRequestHandler ("mediaTracker").
 *
 * One HTTP endpoint (custom/mediaTracker) routed by ?action=:
 *
 *   listTitles       read the whole library out of the database note
 *   search           TMDB multi search (movies + shows)
 *   details          TMDB details for one title, incl. per-season episode counts
 *   addTitle         add a title to the database from a TMDB id
 *   removeTitle      drop a title from the database
 *   setStatus        set watch status
 *   setRating        set rating
 *   setEpisode       mark one episode watched/unwatched
 *   traktAuthStart   begin Trakt device authorization
 *   traktAuthPoll    poll for the user approving it
 *   importTrakt      one-way import of Trakt watched movies + shows
 *   stremioLogin     exchange Stremio email/password for an auth key
 *   importStremio    one-way import of the Stremio library
 *
 * Storage: every title lives in ONE JSON note titled "Database", a direct child
 * of the configured Library Root (find-or-create, see resolveDatabaseNote).
 * Imports read the document once, apply every change in memory, and write once
 * at the end -- a 400-title Trakt import is a single note write, and a partial
 * failure can't leave the document half-updated.
 *
 * Imports are additive: they only ever add and update titles, never remove them.
 * A title dropped from Trakt or Stremio upstream is left untouched here, so an
 * external change can't quietly delete your Trilium data. Nothing is written to
 * Stremio at all.
 *
 * deleteTraktHistory is the one call that writes to an external service, added
 * for migrating off Trakt. It removes a single Trakt history entry by its history
 * id, refuses unless that watch is already captured in Trilium, and has no bulk
 * equivalent. Trakt history removal is permanent -- there is no undo there.
 *
 * API contracts verified against live endpoints plus known-good clients:
 *   Trakt device OAuth  - PyTrakt (trakt/core.py); status codes 400 pending /
 *                         404 invalid / 409 used / 410 expired / 418 denied / 429 slow down
 *   Trakt watched shape - jellyfin-plugin-trakt DataContracts/Users/Watched/*.cs
 *   Stremio             - carried over from stremio-sync@beatlink, which this addon absorbs
 */

const { loadSettings, saveSettings } = require("libSettings.js")
const tracker = require("libMediaTracker.js")

const TMDB_API = "https://api.themoviedb.org/3"
const TRAKT_API = "https://api.trakt.tv"
const STREMIO_API = "https://api.strem.io/api"

const DATABASE_TITLE = "Database"

// --- settings ---------------------------------------------------------------

// Normally resolved from this note's own relations. When these functions are
// required from another script (autoSync.js), `api.currentNote` is that script
// instead, so fall back to finding the settings note by its #mediaTrackerConfig
// marker -- otherwise a scheduled import would fail the moment it tried to
// persist a refreshed token.
function getNoteIds() {
    let schemaNoteId = api.currentNote?.getRelationValue("schemaNote")
    let settingsNoteId = api.currentNote?.getRelationValue("settingsNote")

    if (!schemaNoteId || !settingsNoteId) {
        const marker = api.getNoteWithLabel("mediaTrackerConfig")
        if (!marker) throw new Error("Media Tracker settings note not found")
        schemaNoteId = marker.getRelationValue("schemaNote")
        settingsNoteId = marker.noteId
    }

    const configNoteId = api.getNote(settingsNoteId).getRelationValue("configNote")
    return { schemaNoteId, configNoteId }
}

function getSettings() {
    const { schemaNoteId, configNoteId } = getNoteIds()
    return loadSettings(schemaNoteId, configNoteId)
}

function persistFields(fields) {
    const { schemaNoteId, configNoteId } = getNoteIds()
    const settings = loadSettings(schemaNoteId, configNoteId)
    Object.assign(settings, fields)
    saveSettings(schemaNoteId, configNoteId, settings)
}

// --- database ---------------------------------------------------------------

function requireLibraryRoot(settings) {
    if (!settings.libraryRootNoteId) throw new Error("Set a Library Root in Settings first")
    const note = api.getNote(settings.libraryRootNoteId)
    if (!note || note.isDeleted) throw new Error("Library Root note not found")
    return note
}

// The database note is a JSON code note titled "Database" directly under the
// library root. Kept there rather than in the addon's persistence tree so the
// data travels with the library: move or export the root and the titles follow.
// Find-or-create, and tagged #mediaTrackerDatabase so a renamed note is still
// found.
function resolveDatabaseNote(settings) {
    const root = requireLibraryRoot(settings)

    const tagged = root.getChildNotes().find(n => !n.isDeleted && n.hasLabel("mediaTrackerDatabase"))
    if (tagged) return tagged

    const byTitle = root.getChildNotes().find(n => !n.isDeleted && n.title === DATABASE_TITLE)
    if (byTitle) {
        byTitle.setLabel("mediaTrackerDatabase")
        return byTitle
    }

    const { note } = api.createNewNote({
        parentNoteId: root.noteId,
        title: DATABASE_TITLE,
        type: "code",
        mime: "application/json",
        content: tracker.serializeDocument(tracker.emptyDocument())
    })
    note.setLabel("mediaTrackerDatabase")
    note.setLabel("iconClass", "bx bx-data")
    return note
}

function loadDocument(settings) {
    return tracker.parseDocument(resolveDatabaseNote(settings).getContent())
}

function saveDocument(settings, doc) {
    resolveDatabaseNote(settings).setContent(tracker.serializeDocument(doc))
}

function today() {
    return new Date().toISOString().slice(0, 10)
}

// --- http helpers -----------------------------------------------------------

// Trakt requires a User-Agent on every call (docs.trakt.tv/docs/required-headers)
// and Cloudflare returns a plain-text 403 when it's absent, before the request
// ever reaches Trakt. Node's fetch sends none by default, so one is set on every
// outbound call here. Format follows Trakt's documented AppName/Version.
const USER_AGENT = "media-tracker-beatlink/1.0.0"

function outboundHeaders(headers) {
    return { "User-Agent": USER_AGENT, ...(headers || {}) }
}

// TMDB and Trakt both return a JSON body explaining a failure
// (TMDB: status_message, Trakt: error_description). Surfacing it turns an opaque
// "Request failed (HTTP 404)" into something that names the actual cause.
async function getJson(url, headers) {
    const res = await fetch(url, { headers: outboundHeaders(headers) })
    if (res.ok) return res.json()

    let detail = ""
    try {
        const body = await res.json()
        detail = body.status_message || body.error_description || body.error || ""
    } catch (e) {
        // Non-JSON error body; the status alone will have to do.
    }
    throw new Error(detail
        ? `${detail} (HTTP ${res.status})`
        : `Request failed (HTTP ${res.status})`)
}

async function postJson(url, body, headers) {
    return fetch(url, {
        method: "POST",
        headers: outboundHeaders({ "Content-Type": "application/json", ...(headers || {}) }),
        body: JSON.stringify(body)
    })
}

// --- TMDB -------------------------------------------------------------------

function requireTmdbKey(settings) {
    if (!settings.tmdbApiKey) throw new Error("Set a TMDB API key in Settings first")
    return settings.tmdbApiKey
}

// `mediaType` scopes the search: "movie" and "show" use TMDB's dedicated
// search/movie and search/tv endpoints (a full page of one kind), anything else
// uses search/multi and keeps both. The dedicated endpoints don't return a
// media_type field, so it's stamped on from what was asked for.
async function tmdbSearch(settings, query, mediaType) {
    const key = requireTmdbKey(settings)
    const scoped = mediaType === "movie" || mediaType === "show"
    const path = scoped ? (mediaType === "show" ? "search/tv" : "search/movie") : "search/multi"

    const json = await getJson(
        `${TMDB_API}/${path}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`
    )

    // Each result is marked with whether it's already tracked, so the UI can say
    // so instead of offering an Add that turns out to be a no-op. Matched through
    // findTitle (any shared id), not just the TMDB id, so a title imported from
    // Stremio with only an IMDb id is still recognised.
    // The library root may not be set yet -- searching before that is legitimate,
    // so treat an unreadable document as "nothing tracked" rather than failing.
    let doc = { titles: {} }
    try {
        doc = loadDocument(settings)
    } catch (e) {
        // No library root configured yet.
    }

    return (json.results || [])
        .filter(r => scoped || r.media_type === "movie" || r.media_type === "tv")
        .map(r => ({
            tmdbId: String(r.id),
            trackedKey: tracker.findTitle(doc, { tmdbId: String(r.id) }) || "",
            mediaType: scoped ? mediaType : (r.media_type === "tv" ? "show" : "movie"),
            title: r.title || r.name || "",
            year: (r.release_date || r.first_air_date || "").slice(0, 4),
            overview: r.overview || "",
            poster: tracker.posterUrl(r.poster_path, settings.posterSize)
        }))
}

// Full details for one title. For shows this includes per-season aired episode
// counts, which is what next-up detection needs.
async function tmdbDetails(settings, mediaType, tmdbId) {
    const key = requireTmdbKey(settings)
    const path = mediaType === "show" ? "tv" : "movie"
    const json = await getJson(
        `${TMDB_API}/${path}/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(key)}&append_to_response=external_ids`
    )

    const details = {
        tmdbId: String(json.id),
        imdbId: json.imdb_id || json.external_ids?.imdb_id || "",
        mediaType,
        title: json.title || json.name || "",
        year: (json.release_date || json.first_air_date || "").slice(0, 4),
        overview: json.overview || "",
        poster: tracker.posterUrl(json.poster_path, settings.posterSize),
        genres: (json.genres || []).map(g => g.name).join(", "),
        runtime: json.runtime || json.episode_run_time?.[0] || 0,
        seasonCounts: {},
        totalEpisodes: 0
    }

    if (mediaType === "show") {
        // "Specials" (season 0) are excluded: they are not part of the main
        // running order, so counting them would make next-up start there.
        for (const season of json.seasons || []) {
            if (!season.season_number) continue
            details.seasonCounts[season.season_number] = season.episode_count || 0
        }
        details.totalEpisodes = Object.values(details.seasonCounts).reduce((a, b) => a + b, 0)
    }
    return details
}

// Resolve a TMDB id from an IMDb id. Imported titles often have only an IMDb id
// -- Stremio supplies nothing else, and a Trakt entry has none when metadata
// enrichment was off or its fetch failed -- so without this their episode lists
// are unreachable. TMDB's /find returns matches grouped by kind.
async function tmdbIdFromImdb(settings, imdbId, mediaType) {
    const key = requireTmdbKey(settings)
    if (!imdbId) return ""

    const json = await getJson(
        `${TMDB_API}/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(key)}&external_source=imdb_id`
    )

    const results = mediaType === "show" ? json.tv_results : json.movie_results
    return results?.length ? String(results[0].id) : ""
}

// Details for one title, resolving a missing TMDB id from the IMDb id first.
// Returns the resolved tmdbId so the caller can persist it and avoid the extra
// lookup next time.
async function resolveDetails(settings, mediaType, tmdbId, imdbId) {
    let id = tmdbId
    if (!id) {
        id = await tmdbIdFromImdb(settings, imdbId, mediaType)
        if (!id) {
            throw new Error(imdbId
                ? "TMDB has no match for this title's IMDb id, so its episode list is unavailable."
                : "This title has no TMDB or IMDb id, so its episode list cannot be looked up.")
        }
    }
    return tmdbDetails(settings, mediaType, id)
}

// Details for a library entry. When the TMDB id had to be resolved from the IMDb
// id, it's written back to the entry so the lookup happens once rather than on
// every open of the episode panel.
async function detailsForKey(settings, mediaType, tmdbId, imdbId, key) {
    const details = await resolveDetails(settings, mediaType, tmdbId, imdbId)

    if (key && details.tmdbId && details.tmdbId !== tmdbId) {
        const doc = loadDocument(settings)
        const entry = doc.titles[key]
        if (entry) {
            entry.tmdbId = details.tmdbId
            if (!entry.imdbId && details.imdbId) entry.imdbId = details.imdbId
            if (details.totalEpisodes) entry.totalEpisodes = details.totalEpisodes
            saveDocument(settings, doc)
        }
    }

    return details
}

// --- title mutations --------------------------------------------------------

async function addTitle(settings, mediaType, tmdbId) {
    const details = await tmdbDetails(settings, mediaType, tmdbId)
    const doc = loadDocument(settings)
    const existingKey = tracker.findTitle(doc, details)

    if (existingKey) {
        // Refresh metadata but keep the user's own status/rating/progress.
        const existing = doc.titles[existingKey]
        doc.titles[existingKey] = {
            ...existing,
            tmdbId: details.tmdbId,
            imdbId: details.imdbId || existing.imdbId || "",
            title: details.title,
            year: details.year,
            overview: details.overview,
            poster: details.poster,
            genres: details.genres,
            runtime: details.runtime,
            totalEpisodes: details.totalEpisodes || existing.totalEpisodes || 0
        }
        saveDocument(settings, doc)
        return { key: existingKey, title: details.title, existed: true }
    }

    const key = tracker.titleKey(details)
    doc.titles[key] = tracker.normalizeTitle({
        ...details,
        status: settings.defaultStatus || "planned",
        addedAt: today()
    })
    saveDocument(settings, doc)
    return { key, title: details.title, existed: false }
}

function requireEntry(doc, key) {
    const entry = doc.titles[key]
    if (!entry) throw new Error("That title is not in the library")
    return entry
}

function setStatus(settings, key, status) {
    if (!tracker.STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`)
    const doc = loadDocument(settings)
    const entry = requireEntry(doc, key)
    entry.status = status
    if (status === "watched") entry.lastWatched = today()
    saveDocument(settings, doc)
    return { ok: true }
}

function setRating(settings, key, rating) {
    const value = Number(rating)
    if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error("Rating must be 0-10")
    const doc = loadDocument(settings)
    const entry = requireEntry(doc, key)
    entry.rating = value > 0 ? value : null
    saveDocument(settings, doc)
    return { ok: true }
}

// `totalEpisodes` is what decides "all watched". It's only known once TMDB
// details have been fetched, so the episode panel passes the count it is already
// displaying; without it a fully-ticked show would stay "watching" forever.
function setEpisode(settings, key, season, episode, watched, totalEpisodes) {
    const doc = loadDocument(settings)
    const entry = requireEntry(doc, key)

    const knownTotal = Number(totalEpisodes) || 0
    if (knownTotal > 0) entry.totalEpisodes = knownTotal

    const current = tracker.parseEpisodes(entry.watchedEpisodes || "")
    const next = tracker.withEpisode(current, Number(season), Number(episode), !!watched)
    entry.watchedEpisodes = tracker.formatEpisodes(next)
    entry.status = tracker.statusFromProgress(tracker.countEpisodes(next), Number(entry.totalEpisodes) || 0)
    if (watched) entry.lastWatched = today()

    saveDocument(settings, doc)
    return { ok: true, watchedEpisodes: entry.watchedEpisodes, status: entry.status }
}

// Mark a run of episodes watched/unwatched in one operation. `ranges` arrives as
// a JSON array of { season, from, to }. Doing this in one read/write rather than
// one request per episode means "watch all" on a 250-episode show is a single
// note write that can't half-apply.
function setEpisodeRange(settings, key, rangesJson, watched, totalEpisodes) {
    let ranges
    try {
        ranges = JSON.parse(rangesJson || "[]")
    } catch (e) {
        throw new Error("Malformed episode range")
    }
    if (!Array.isArray(ranges)) throw new Error("Malformed episode range")

    const doc = loadDocument(settings)
    const entry = requireEntry(doc, key)

    const knownTotal = Number(totalEpisodes) || 0
    if (knownTotal > 0) entry.totalEpisodes = knownTotal

    const next = tracker.withEpisodeRanges(
        tracker.parseEpisodes(entry.watchedEpisodes || ""), ranges, !!watched
    )
    entry.watchedEpisodes = tracker.formatEpisodes(next)
    entry.status = tracker.statusFromProgress(tracker.countEpisodes(next), Number(entry.totalEpisodes) || 0)
    if (watched) entry.lastWatched = today()

    saveDocument(settings, doc)
    return { ok: true, watchedEpisodes: entry.watchedEpisodes, status: entry.status }
}

// Add a title from a pasted TMDB or IMDb link (or a bare IMDb id).
//
// A TMDB link carries its type in the path (/movie/ vs /tv/), so it goes straight
// to addTitle. An IMDb link doesn't say which it is, so /find is asked for both
// and whichever answers wins -- an id only ever matches one of the two.
async function addFromLink(settings, input) {
    const parsed = tracker.parseMediaLink(input)
    if (!parsed) {
        throw new Error("Not a TMDB or IMDb link. Expected something like "
            + "https://www.themoviedb.org/movie/693134 or https://www.imdb.com/title/tt15239678/")
    }

    if (parsed.tmdbId) return addTitle(settings, parsed.mediaType, parsed.tmdbId)

    for (const mediaType of ["movie", "show"]) {
        const tmdbId = await tmdbIdFromImdb(settings, parsed.imdbId, mediaType)
        if (tmdbId) return addTitle(settings, mediaType, tmdbId)
    }
    throw new Error(`TMDB has no match for ${parsed.imdbId}.`)
}

// Persist the Library view's filter/sort choices so they survive a reload.
// Only the six known keys are accepted, so a stray query parameter can't write
// arbitrary settings. The search box is deliberately not remembered: a filter
// that silently hides most of the library on load reads as data loss.
const VIEW_FIELDS = {
    statusFilter: "viewStatusFilter",
    typeFilter: "viewTypeFilter",
    collectionFilter: "viewCollectionFilter",
    groupFilters: "viewGroupFilters",
    genreFilter: "viewGenreFilter",
    sortKey: "viewSortKey",
    sortDesc: "viewSortDesc",
    grouped: "viewGrouped"
}

function saveViewState(query) {
    const fields = {}
    for (const [param, setting] of Object.entries(VIEW_FIELDS)) {
        const value = query[param]
        if (value === undefined) continue
        fields[setting] = (setting === "viewSortDesc" || setting === "viewGrouped")
            ? value === "true"
            : String(value)
    }
    if (Object.keys(fields).length) persistFields(fields)
    return { ok: true }
}

// Removes a collection from every title that carries it, or renames it across
// all of them. Collections are derived from the titles rather than stored in
// their own list (see listCollections), so a collection ceases to exist exactly
// when no title references it -- there is nothing else to delete.
//
// Matching is case-insensitive so "mcu" removes "MCU"; renaming to a name that
// already exists merges the two rather than creating a duplicate.
// Every collection the panel should show: those actually in use on titles, plus
// any that exist only as a group assignment. A collection created in Settings has
// no members yet, and collections are otherwise derived from titles, so without
// this it would vanish the moment it was created.
function collectionRows(doc, config) {
    const seen = new Map()
    for (const name of tracker.listCollections(doc)) {
        seen.set(name.toLowerCase(), { name, group: tracker.groupOf(config, name), inUse: true })
    }
    for (const [key, group] of Object.entries(config.assign)) {
        if (seen.has(key)) continue
        // The stored key is lowercased; recover the display name from the
        // config's own record of it.
        const display = config.names?.[key] || key
        seen.set(key, { name: display, group, inUse: false })
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function renameCollection(settings, from, to) {
    const source = String(from || "").trim().toLowerCase()
    if (!source) throw new Error("Which collection?")

    const target = String(to || "").trim()
    const doc = loadDocument(settings)
    let changed = 0

    for (const entry of Object.values(doc.titles)) {
        const names = tracker.normalizeCollections(entry.collections)
        if (!names.some(n => n.toLowerCase() === source)) continue

        const rest = names.filter(n => n.toLowerCase() !== source)
        // A blank target means delete; otherwise re-add under the new name unless
        // the title already has it (which is how a merge collapses).
        const next = target && !rest.some(n => n.toLowerCase() === target.toLowerCase())
            ? [...rest, target]
            : rest

        entry.collections = tracker.normalizeCollections(next)
        changed++
    }

    if (changed) saveDocument(settings, doc)
    return { ok: true, changed, deleted: !target }
}

// Collections are tags: the whole set is replaced at once, sent comma-separated.
function setCollections(settings, key, raw) {
    const doc = loadDocument(settings)
    const entry = requireEntry(doc, key)
    entry.collections = tracker.normalizeCollections(String(raw || "").split(","))
    saveDocument(settings, doc)
    return { ok: true, collections: entry.collections }
}

function removeTitle(settings, key) {
    const doc = loadDocument(settings)
    requireEntry(doc, key)
    delete doc.titles[key]
    saveDocument(settings, doc)
    return { ok: true }
}

// Full metadata for the details page: everything tmdbDetails returns, plus cast,
// and for shows the per-season episode lists with their summaries.
//
// Episode field names come straight from TMDB's season response `episodes` array.
// Every one is read defensively -- TMDB omits fields it has no data for (an
// unaired episode has no still or runtime), so a missing value must render as
// blank rather than "undefined".
async function fullDetails(settings, mediaType, tmdbId, imdbId, key) {
    const details = await resolveDetails(settings, mediaType, tmdbId, imdbId)
    const apiKey = requireTmdbKey(settings)
    const path = mediaType === "show" ? "tv" : "movie"

    // Credits come from the same append_to_response the details call could carry,
    // but it's fetched separately so a credits failure can't lose the metadata.
    let cast = []
    try {
        const credits = await getJson(
            `${TMDB_API}/${path}/${encodeURIComponent(details.tmdbId)}/credits?api_key=${encodeURIComponent(apiKey)}`
        )
        cast = (credits.cast || []).slice(0, 12).map(person => ({
            name: person.name || "",
            character: person.character || "",
            profile: person.profile_path ? tracker.posterUrl(person.profile_path, "w185") : ""
        }))
    } catch (e) {
        // Cast is decorative; never fail the page over it.
    }

    const seasons = []
    if (mediaType === "show") {
        for (const seasonNumber of Object.keys(details.seasonCounts).map(Number).sort((a, b) => a - b)) {
            try {
                const season = await getJson(
                    `${TMDB_API}/tv/${encodeURIComponent(details.tmdbId)}/season/${seasonNumber}`
                    + `?api_key=${encodeURIComponent(apiKey)}`
                )
                seasons.push({
                    number: seasonNumber,
                    name: season.name || `Season ${seasonNumber}`,
                    overview: season.overview || "",
                    poster: season.poster_path ? tracker.posterUrl(season.poster_path, settings.posterSize) : "",
                    episodes: (season.episodes || []).map(ep => ({
                        number: ep.episode_number,
                        name: ep.name || "",
                        overview: ep.overview || "",
                        airDate: ep.air_date || "",
                        runtime: ep.runtime || 0,
                        rating: Number.isFinite(Number(ep.vote_average)) ? Number(ep.vote_average) : null,
                        still: ep.still_path ? tracker.posterUrl(ep.still_path, "w185") : ""
                    }))
                })
            } catch (e) {
                // Skip a season TMDB can't serve rather than losing the whole page.
            }
        }
    }

    // The entry's own tracked state, so the page can show progress and status.
    const doc = loadDocument(settings)
    const entry = key && doc.titles[key] ? tracker.normalizeTitle(doc.titles[key]) : null

    return { ...details, cast, seasons, entry }
}

// --- housekeeping -----------------------------------------------------------

// Re-derives everything that can drift: refreshes metadata and posters from TMDB,
// backfills missing ids and episode counts, and recomputes each show's status
// from its episode progress. Reads the document once and writes once, like the
// importers. Never changes a rating, and never un-watches an episode.
async function refreshLibrary(settings) {
    const doc = loadDocument(settings)
    const entries = Object.entries(doc.titles)

    let metadataUpdated = 0
    let statusUpdated = 0
    let failed = 0

    for (const [key, raw] of entries) {
        const entry = tracker.normalizeTitle(raw)

        if (settings.tmdbApiKey) {
            try {
                const details = await resolveDetails(
                    settings, entry.mediaType, entry.tmdbId, entry.imdbId
                )
                const before = JSON.stringify([
                    entry.title, entry.poster, entry.overview, entry.genres,
                    entry.runtime, entry.totalEpisodes, entry.tmdbId, entry.imdbId
                ])

                entry.tmdbId = details.tmdbId || entry.tmdbId
                entry.imdbId = details.imdbId || entry.imdbId
                entry.title = details.title || entry.title
                entry.year = details.year || entry.year
                entry.overview = details.overview || entry.overview
                entry.poster = details.poster || entry.poster
                entry.genres = details.genres || entry.genres
                entry.runtime = details.runtime || entry.runtime
                if (details.totalEpisodes) entry.totalEpisodes = details.totalEpisodes

                const after = JSON.stringify([
                    entry.title, entry.poster, entry.overview, entry.genres,
                    entry.runtime, entry.totalEpisodes, entry.tmdbId, entry.imdbId
                ])
                if (before !== after) metadataUpdated++
            } catch (e) {
                // A title TMDB can't resolve shouldn't stop the sweep.
                failed++
            }
        }

        // Shows: status follows episode progress. Movies keep whatever the user
        // set, since there is no progress to derive it from.
        if (entry.mediaType === "show") {
            const watchedCount = tracker.countEpisodes(tracker.parseEpisodes(entry.watchedEpisodes || ""))
            const derived = tracker.statusFromProgress(watchedCount, Number(entry.totalEpisodes) || 0)
            if (derived !== entry.status) {
                entry.status = derived
                statusUpdated++
            }
        }

        doc.titles[key] = entry
    }

    saveDocument(settings, doc)
    return { total: entries.length, metadataUpdated, statusUpdated, failed }
}

// --- Trakt ------------------------------------------------------------------

// Credentials are trimmed at every use: a client id pasted from Trakt's site
// often carries a trailing space or newline, and Trakt reports that as
// "client not found" -- indistinguishable from a genuinely wrong id.
function traktClientId(settings) {
    return String(settings.traktClientId || "").trim()
}

function traktClientSecret(settings) {
    return String(settings.traktClientSecret || "").trim()
}

// Trakt returns a JSON error_description on this endpoint ("client not found",
// "client_id is required"). Surface it verbatim rather than inventing a cause.
//
// Verified against the live endpoint: a bad or missing client id yields 401 or
// 400 with a JSON body -- never 403. A 403 with a plain-text "Forbidden" body is
// what Trakt's *authenticated* API returns, so seeing one here means the request
// never reached the device-code endpoint as sent (a proxy, firewall, or blocked
// server-side fetch). Say that instead of blaming the Trakt app.
async function traktError(res, clientId) {
    const raw = await res.text().catch(() => "")
    let detail = ""
    try {
        const body = JSON.parse(raw)
        detail = body.error_description || body.error || ""
    } catch (e) {
        // Plain-text body (e.g. "Forbidden"); keep it as the detail.
        detail = raw.trim().slice(0, 200)
    }

    if (res.status === 401 && detail === "client not found") {
        return "Trakt does not recognise this Client ID. Check it against your app at "
            + "trakt.tv/oauth/applications -- copy the Client ID, not the Client Secret, "
            + `and make sure the whole value was pasted (currently ${clientId.length} characters).`
    }
    if (res.status === 403) {
        return "Trakt returned 403 Forbidden. On the device-code endpoint this means the "
            + "request was blocked before reaching Trakt -- most often a missing User-Agent "
            + "header (Cloudflare rejects those), or a proxy between this server and "
            + "api.trakt.tv."
    }
    return detail
        ? `Trakt rejected the request: ${detail} (HTTP ${res.status})`
        : `Trakt rejected the request (HTTP ${res.status})`
}

function traktHeaders(settings, withAuth) {
    const headers = {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": traktClientId(settings)
    }
    if (withAuth) headers["Authorization"] = `Bearer ${settings.traktAccessToken}`
    return headers
}

async function traktAuthStart(settings) {
    const clientId = traktClientId(settings)
    if (!clientId) throw new Error("Set a Trakt Client ID in Settings first")

    const res = await postJson(`${TRAKT_API}/oauth/device/code`, { client_id: clientId })
    if (!res.ok) throw new Error(await traktError(res, clientId))
    const json = await res.json()
    return {
        deviceCode: json.device_code,
        userCode: json.user_code,
        verificationUrl: json.verification_url,
        expiresIn: json.expires_in,
        interval: json.interval
    }
}

// Polled by the frontend. Status codes are Trakt's documented device-flow
// semantics, so each maps to a distinct UI state rather than a generic error.
async function traktAuthPoll(settings, deviceCode) {
    if (!traktClientSecret(settings)) throw new Error("Set a Trakt Client Secret in Settings first")
    const res = await postJson(`${TRAKT_API}/oauth/device/token`, {
        code: deviceCode,
        client_id: traktClientId(settings),
        client_secret: traktClientSecret(settings)
    })

    if (res.status === 200) {
        const json = await res.json()
        persistFields({
            traktAccessToken: json.access_token,
            traktRefreshToken: json.refresh_token,
            traktTokenExpiresAt: (json.created_at || 0) + (json.expires_in || 0)
        })
        return { state: "authorized" }
    }
    if (res.status === 400) return { state: "pending" }
    if (res.status === 429) return { state: "slow_down" }
    if (res.status === 404) throw new Error("Authorization code is not valid. Start again.")
    if (res.status === 409) throw new Error("This code was already used. Start again.")
    if (res.status === 410) throw new Error("The code expired. Start again.")
    if (res.status === 418) throw new Error("Authorization was denied.")
    throw new Error(`Unexpected Trakt response (HTTP ${res.status})`)
}

async function traktRefreshIfNeeded(settings) {
    const expiresAt = Number(settings.traktTokenExpiresAt) || 0
    const now = Math.floor(Date.now() / 1000)
    // Refresh a little early so a long import doesn't expire mid-run.
    if (!settings.traktRefreshToken || expiresAt === 0 || now < expiresAt - 300) return settings
    const res = await postJson(`${TRAKT_API}/oauth/token`, {
        refresh_token: settings.traktRefreshToken,
        client_id: traktClientId(settings),
        client_secret: traktClientSecret(settings),
        grant_type: "refresh_token"
    })
    if (!res.ok) throw new Error("Trakt session expired and could not be renewed. Authorize again.")
    const json = await res.json()
    const fields = {
        traktAccessToken: json.access_token,
        traktRefreshToken: json.refresh_token,
        traktTokenExpiresAt: (json.created_at || 0) + (json.expires_in || 0)
    }
    persistFields(fields)
    return { ...settings, ...fields }
}

// Trakt pages large collections and reports the total in X-Pagination-Page-Count
// (verified against jellyfin-plugin-trakt's GetFromTraktWithPaging). /sync/history
// in particular can run to thousands of entries, so every page is walked rather
// than silently keeping only the first.
async function traktPaged(settings, path, onProgress) {
    const all = []
    let page = 1
    let pageCount = 1

    do {
        const url = `${TRAKT_API}${path}${path.includes("?") ? "&" : "?"}page=${page}&limit=100`
        const res = await fetch(url, { headers: outboundHeaders(traktHeaders(settings, true)) })
        if (!res.ok) {
            if (res.status === 403) {
                throw new Error("Trakt rejected the Client ID (HTTP 403). Check it in Settings.")
            }
            if (res.status === 401) throw new Error("Trakt authorization expired. Authorize again.")
            throw new Error(`Trakt request failed (HTTP ${res.status}) for ${path}`)
        }

        const batch = await res.json()
        if (Array.isArray(batch)) all.push(...batch)

        const header = res.headers.get("x-pagination-page-count")
        pageCount = Number(header) || 1
        if (onProgress) onProgress(path, page, pageCount, all.length)
        page++
        // Hard stop so a misreported header can't spin forever.
    } while (page <= pageCount && page <= 500)

    return all
}

// Pulls everything Trakt holds and stores it verbatim in an "Archive" note beside
// the library Database, then maps the watch data into the library as usual.
//
// The raw copy is the point: /sync/watched (what the normal import uses) is only
// aggregate state, so ratings, watchlist, collection, and every individual
// watched_at timestamp would be lost. Keeping Trakt's untouched responses means
// nothing is destroyed by a mapping gap, which matters if the account is then
// deleted.
async function archiveTrakt(settings) {
    if (!settings.traktAccessToken) throw new Error("Authorize with Trakt first")
    const current = await traktRefreshIfNeeded(settings)

    const sources = {
        watchedMovies: "/sync/watched/movies",
        watchedShows: "/sync/watched/shows",
        historyMovies: "/sync/history/movies",
        historyEpisodes: "/sync/history/episodes",
        ratingsMovies: "/sync/ratings/movies",
        ratingsShows: "/sync/ratings/shows",
        ratingsSeasons: "/sync/ratings/seasons",
        ratingsEpisodes: "/sync/ratings/episodes",
        watchlistMovies: "/sync/watchlist/movies",
        watchlistShows: "/sync/watchlist/shows",
        collectionMovies: "/sync/collection/movies",
        collectionShows: "/sync/collection/shows"
    }

    const archive = { fetchedAt: new Date().toISOString(), counts: {}, data: {} }
    const failures = []

    for (const [name, path] of Object.entries(sources)) {
        try {
            const rows = await traktPaged(current, path)
            archive.data[name] = rows
            archive.counts[name] = rows.length
        } catch (e) {
            // Record the failure instead of aborting: a partial archive plus an
            // explicit list of what's missing is far more useful than nothing,
            // and it tells the user exactly what is not safe to delete yet.
            failures.push(`${name}: ${e.message}`)
            archive.counts[name] = null
        }
    }
    archive.failures = failures

    writeArchiveNote(settings, archive)

    // Map the watch data into the library using the same additive importer.
    const imported = await importTraktFrom(
        current, archive.data.watchedMovies || [], archive.data.watchedShows || []
    )

    // Ratings are the one curated field the library itself can hold.
    const ratingsApplied = applyTraktRatings(current, [
        ...(archive.data.ratingsMovies || []),
        ...(archive.data.ratingsShows || [])
    ])

    return { ...imported, counts: archive.counts, failures, ratingsApplied }
}

// The archive lives beside the Database note, under the library root, so it
// travels with the library and is visible in the tree.
function writeArchiveNote(settings, archive) {
    const root = requireLibraryRoot(settings)
    const title = "Trakt Archive"

    let note = root.getChildNotes().find(n => !n.isDeleted && n.hasLabel("mediaTrackerTraktArchive"))
    if (!note) {
        note = root.getChildNotes().find(n => !n.isDeleted && n.title === title)
        if (note) note.setLabel("mediaTrackerTraktArchive")
    }

    if (!note) {
        const created = api.createNewNote({
            parentNoteId: root.noteId,
            title,
            type: "code",
            mime: "application/json",
            content: JSON.stringify(archive, null, 2)
        })
        created.note.setLabel("mediaTrackerTraktArchive")
        created.note.setLabel("iconClass", "bx bx-archive")
        return created.note
    }

    note.setContent(JSON.stringify(archive, null, 2))
    return note
}

// Trakt ratings are 1-10, the same scale the library uses, so they map directly.
// Only applied where the entry has no rating yet, unless the user opted into
// letting imports overwrite.
function applyTraktRatings(settings, rated) {
    const doc = loadDocument(settings)
    let applied = 0

    for (const row of rated) {
        const subject = row.movie || row.show
        if (!subject) continue
        const rating = Number(row.rating)
        if (!Number.isFinite(rating) || rating <= 0) continue

        const key = tracker.findTitle(doc, {
            tmdbId: subject.ids?.tmdb,
            imdbId: subject.ids?.imdb,
            traktId: subject.ids?.trakt
        })
        if (!key) continue

        const entry = doc.titles[key]
        if (entry.rating != null && !settings.importOverwriteRatings) continue
        entry.rating = rating
        applied++
    }

    if (applied) saveDocument(settings, doc)
    return applied
}

// --- Trakt reconciliation (migration only) ----------------------------------
//
// The one place this addon writes to Trakt. Everything else is strictly read-only;
// see the header. Deletion is deliberately narrow: one history entry per call,
// addressed by its own history id, with no bulk endpoint.
//
// Verified: POST /sync/history/remove accepts {"ids": [historyId]}, which removes
// exactly that play. Trakt's own issue tracker (trakt/trakt-api#248) states the
// history id exists precisely "so a user doesn't remove all plays" -- removing by
// item + watched_at is ambiguous, because Trakt does not guarantee that pair is
// unique. Always address by id.

// Side-by-side comparison of Trakt's watch history against the Trilium library.
// Read-only. Each row reports whether Trilium already has that watch, so nothing
// is deleted from Trakt that hasn't landed here first.
async function compareTrakt(settings) {
    if (!settings.traktAccessToken) throw new Error("Authorize with Trakt first")
    const current = await traktRefreshIfNeeded(settings)
    const doc = loadDocument(settings)

    const movies = await traktPaged(current, "/sync/history/movies")
    const episodes = await traktPaged(current, "/sync/history/episodes")

    const rows = []

    for (const entry of movies) {
        const movie = entry.movie || {}
        const key = tracker.findTitle(doc, {
            tmdbId: movie.ids?.tmdb, imdbId: movie.ids?.imdb, traktId: movie.ids?.trakt
        })
        rows.push({
            historyId: entry.id,
            mediaType: "movie",
            title: movie.title || "Untitled",
            year: movie.year || "",
            // Ids travel with the row so a single entry can be imported from here
            // without re-fetching the whole history.
            tmdbId: movie.ids?.tmdb ? String(movie.ids.tmdb) : "",
            imdbId: movie.ids?.imdb || "",
            traktId: movie.ids?.trakt ? String(movie.ids.trakt) : "",
            watchedAt: entry.watched_at || "",
            label: movie.title || "Untitled",
            inTrilium: !!key,
            // A movie counts as captured when it's tracked and marked watched.
            captured: !!key && doc.titles[key]?.status === "watched"
        })
    }

    for (const entry of episodes) {
        const show = entry.show || {}
        const ep = entry.episode || {}
        const key = tracker.findTitle(doc, {
            tmdbId: show.ids?.tmdb, imdbId: show.ids?.imdb, traktId: show.ids?.trakt
        })
        // An episode counts as captured when that exact season/episode is marked
        // watched in the library, not merely when the show is present.
        let captured = false
        if (key) {
            const watched = tracker.parseEpisodes(doc.titles[key].watchedEpisodes || "")
            captured = tracker.hasEpisode(watched, Number(ep.season), Number(ep.number))
        }
        rows.push({
            historyId: entry.id,
            mediaType: "episode",
            title: show.title || "Untitled",
            year: show.year || "",
            season: ep.season,
            episode: ep.number,
            tmdbId: show.ids?.tmdb ? String(show.ids.tmdb) : "",
            imdbId: show.ids?.imdb || "",
            traktId: show.ids?.trakt ? String(show.ids.trakt) : "",
            watchedAt: entry.watched_at || "",
            label: `${show.title || "Untitled"} ${ep.season}x${String(ep.number).padStart(2, "0")}`
                + (ep.title ? ` · ${ep.title}` : ""),
            inTrilium: !!key,
            captured
        })
    }

    rows.sort((a, b) => String(b.watchedAt).localeCompare(String(a.watchedAt)))

    return {
        rows,
        total: rows.length,
        captured: rows.filter(r => r.captured).length,
        missing: rows.filter(r => !r.captured).length
    }
}

// Imports ONE watch from the comparison view, so a row marked "not in Trilium"
// can be captured without re-running the whole Trakt import. Goes through the
// same additive applyImport, so it merges rather than replaces: an episode is
// added to the show's progress, and an existing rating or status is preserved.
async function importOneWatch(settings, row) {
    const mediaType = row.mediaType === "episode" ? "show" : "movie"
    const item = {
        mediaType,
        title: row.title,
        year: row.year,
        tmdbId: row.tmdbId,
        imdbId: row.imdbId,
        traktId: row.traktId,
        lastWatched: row.watchedAt
    }

    if (mediaType === "show") {
        const season = Number(row.season)
        const episode = Number(row.episode)
        if (!Number.isFinite(season) || !Number.isFinite(episode)) {
            throw new Error("That history entry has no season/episode number.")
        }
        item.episodes = { [season]: new Set([episode]) }
    } else {
        item.status = "watched"
    }

    // Force importMarksWatched for this one call: the user explicitly asked to
    // capture this watch, so the setting that suppresses status changes during a
    // bulk import shouldn't silently make this a no-op.
    const result = await applyImport({ ...settings, importMarksWatched: true }, [item])
    return { ...result, captured: true }
}

// Removes ONE history entry from Trakt, by its history id.
//
// This permanently deletes data on Trakt; there is no undo. Guarded so it can
// only ever affect a single entry, and refuses outright unless that watch is
// already captured in Trilium.
async function deleteTraktHistory(settings, historyId, captured) {
    if (!settings.traktAccessToken) throw new Error("Authorize with Trakt first")
    const id = Number(historyId)
    if (!Number.isFinite(id) || id <= 0) throw new Error("A valid history id is required")

    // Enforced here, not just hidden in the UI: a disabled button is a hint, but
    // this is the thing that actually prevents deleting an unsaved watch.
    if (captured !== "true") {
        throw new Error("That watch is not recorded in Trilium yet. Import it first — "
            + "deleting it from Trakt now would lose it permanently.")
    }

    const current = await traktRefreshIfNeeded(settings)
    const res = await postJson(
        `${TRAKT_API}/sync/history/remove`,
        { ids: [id] },
        traktHeaders(current, true)
    )

    if (!res.ok) throw new Error(await traktError(res, traktClientId(current)))

    const body = await res.json().catch(() => ({}))
    const deleted = body.deleted?.episodes ?? body.deleted?.movies ?? 0
    const notFound = (body.not_found?.ids || []).length > 0

    if (notFound) throw new Error("Trakt did not recognise that history entry; it may already be gone.")
    return { ok: true, deleted, historyId: id }
}

async function importTrakt(settings) {
    if (!settings.traktAccessToken) throw new Error("Authorize with Trakt first")
    const current = await traktRefreshIfNeeded(settings)

    // Verified live: Trakt's API endpoints answer 403 (plain-text "Forbidden")
    // when trakt-api-key isn't a real client id, and 401 when the access token is
    // bad -- so the two failures need different advice.
    const fetchTrakt = async (path) => {
        try {
            return await getJson(`${TRAKT_API}${path}`, traktHeaders(current, true))
        } catch (e) {
            if (String(e.message).includes("403")) {
                throw new Error("Trakt rejected the Client ID (HTTP 403). Check it in Settings "
                    + "against your app at trakt.tv/oauth/applications.")
            }
            if (String(e.message).includes("401")) {
                throw new Error("Trakt authorization expired (HTTP 401). Authorize again.")
            }
            throw e
        }
    }

    const movies = await fetchTrakt("/sync/watched/movies")
    const shows = await fetchTrakt("/sync/watched/shows")

    return importTraktFrom(current, movies, shows)
}

// Maps Trakt's /sync/watched payloads into the library. Split out so the archive
// flow reuses exactly the same mapping instead of a second copy that could drift.
async function importTraktFrom(current, movies, shows) {
    const items = []

    for (const entry of movies || []) {
        const movie = entry.movie || {}
        items.push({
            mediaType: "movie",
            title: movie.title,
            year: movie.year,
            tmdbId: movie.ids?.tmdb,
            imdbId: movie.ids?.imdb,
            traktId: movie.ids?.trakt,
            lastWatched: entry.last_watched_at,
            status: "watched"
        })
    }

    for (const entry of shows || []) {
        const show = entry.show || {}
        const watched = {}
        for (const season of entry.seasons || []) {
            if (!season.number) continue
            for (const episode of season.episodes || []) {
                if (!episode.number) continue
                if (!watched[season.number]) watched[season.number] = new Set()
                watched[season.number].add(episode.number)
            }
        }
        items.push({
            mediaType: "show",
            title: show.title,
            year: show.year,
            tmdbId: show.ids?.tmdb,
            imdbId: show.ids?.imdb,
            traktId: show.ids?.trakt,
            lastWatched: entry.last_watched_at,
            episodes: watched
        })
    }

    return applyImport(current, items)
}

// --- Stremio ----------------------------------------------------------------

async function stremioPost(path, body) {
    const res = await postJson(`${STREMIO_API}/${path}`, body)
    let json
    try { json = await res.json() } catch (e) { throw new Error(`Stremio API error (HTTP ${res.status})`) }
    if (json.error) throw new Error(json.error.message || "Stremio API error")
    return json.result
}

async function stremioLogin(settings) {
    if (!settings.stremioEmail || !settings.stremioPassword) {
        throw new Error("Set a Stremio email and password in Settings first")
    }
    const result = await stremioPost("login", {
        type: "Login",
        email: settings.stremioEmail,
        password: settings.stremioPassword
    })
    // Drop the password once it has served its purpose.
    persistFields({ stremioAuthKey: result.authKey, stremioPassword: "" })
    return { ok: true }
}

async function importStremio(settings) {
    if (!settings.stremioAuthKey) throw new Error("Log in to Stremio first")
    const library = await stremioPost("datastoreGet", {
        authKey: settings.stremioAuthKey,
        collection: "libraryItem",
        ids: [],
        all: true
    })

    const items = []

    // The playback position, falling back to the last video in the watched record ("<videoId>:<count>:<bitfield>") when none is saved.
    const positionOf = (item) => item.state?.video_id
        || String(item.state?.watched || "").split(":").slice(0, -2).join(":")

    // Removing a title from the Stremio library keeps its watch state, so a removed title still counts once watched or started as a series.
    const keptAfterRemoval = (item) => item.state?.timesWatched > 0 || !!item.state?.flaggedWatched
        || (item.type === "series" && positionOf(item).split(":").length === 3)

    for (const item of library || []) {
        if (item.type === "other" || (item.removed && !keptAfterRemoval(item))) continue
        // Stremio ids are imdb ids, optionally suffixed ":season:episode".
        const imdbId = String(item._id || "").split(":")[0]
        if (!imdbId.startsWith("tt")) continue

        const mediaType = item.type === "series" ? "show" : "movie"
        const watched = {}
        if (mediaType === "show" && positionOf(item)) {
            const parts = positionOf(item).split(":")
            const season = Number(parts[1])
            const episode = Number(parts[2])
            // Stremio tracks only the current position, not full history, so
            // this marks everything up to it as watched within that season.
            if (Number.isFinite(season) && Number.isFinite(episode)) {
                watched[season] = new Set()
                for (let n = 1; n <= episode; n++) watched[season].add(n)
            }
        }

        items.push({
            mediaType,
            title: item.name,
            imdbId,
            lastWatched: item.state?.lastWatched,
            episodes: watched,
            status: mediaType === "movie" && item.state?.timesWatched > 0 ? "watched" : undefined
        })
    }

    return applyImport(settings, items)
}

// --- shared import ----------------------------------------------------------

// One-way and idempotent: matches each incoming item against the document by any
// shared id, merges episode progress rather than replacing it, and never touches
// a rating unless explicitly allowed. Reads the document once and writes once,
// so a large import is a single note write and can't half-apply.
async function applyImport(settings, items) {
    const doc = loadDocument(settings)
    let added = 0
    let updated = 0

    for (const item of items) {
        const existingKey = tracker.findTitle(doc, item)

        let details = {
            tmdbId: item.tmdbId ? String(item.tmdbId) : "",
            imdbId: item.imdbId ? String(item.imdbId) : "",
            traktId: item.traktId ? String(item.traktId) : "",
            mediaType: item.mediaType,
            title: item.title || "Untitled",
            year: item.year ? String(item.year) : ""
        }

        // Enrich from TMDB on first import only; an existing entry already has it.
        // An item with only an IMDb id (every Stremio item, and Trakt entries
        // whose TMDB id is absent) is resolved through /find first, so it still
        // gets a poster, overview, and -- for shows -- an episode count.
        if (!existingKey && settings.importFetchMetadata && settings.tmdbApiKey
            && (item.tmdbId || item.imdbId)) {
            try {
                const fetched = await resolveDetails(
                    settings, item.mediaType, item.tmdbId ? String(item.tmdbId) : "", details.imdbId
                )
                details = {
                    ...fetched,
                    traktId: details.traktId,
                    imdbId: fetched.imdbId || details.imdbId
                }
            } catch (e) {
                // Metadata is a nice-to-have; never fail an import over it.
            }
        }

        const key = existingKey || tracker.titleKey(details)
        if (!key) continue

        const previous = doc.titles[key] || {}

        // A rating from the source is only taken when the user opted in;
        // otherwise their own rating always wins.
        const incomingRating = Number.isFinite(Number(item.rating)) ? Number(item.rating) : null
        const rating = (settings.importOverwriteRatings && incomingRating !== null)
            ? incomingRating
            : (previous.rating ?? null)
        const entry = tracker.normalizeTitle({
            ...previous,
            ...details,
            // Preserve the user's own fields across a re-import.
            status: previous.status,
            rating,
            watchedEpisodes: previous.watchedEpisodes,
            totalEpisodes: details.totalEpisodes || previous.totalEpisodes || 0,
            addedAt: previous.addedAt || today()
        })

        if (item.lastWatched) entry.lastWatched = String(item.lastWatched).slice(0, 10)

        if (item.mediaType === "show" && item.episodes && Object.keys(item.episodes).length) {
            const merged = tracker.mergeEpisodes(
                tracker.parseEpisodes(entry.watchedEpisodes || ""),
                item.episodes
            )
            entry.watchedEpisodes = tracker.formatEpisodes(merged)
            if (settings.importMarksWatched) {
                entry.status = tracker.statusFromProgress(
                    tracker.countEpisodes(merged),
                    Number(entry.totalEpisodes) || 0
                )
            }
        } else if (item.status && settings.importMarksWatched) {
            entry.status = item.status
        }

        doc.titles[key] = entry
        existingKey ? updated++ : added++
    }

    saveDocument(settings, doc)
    return { added, updated, total: added + updated }
}

// --- routing ----------------------------------------------------------------

function sendJson(status, obj) {
    api.res.status(status).json(obj)
}

async function handle() {
    const query = api.req.query
    const action = query.action

    try {
        const settings = getSettings()

        switch (action) {
            case "listTitles": {
                const doc = loadDocument(settings)
                const collections = tracker.listCollections(doc)
                const groupConfig = tracker.parseGroupConfig(settings.collectionGroups)
                return sendJson(200, {
                    titles: tracker.listTitles(doc),
                    collections,
                    // One entry per group that actually has collections; the
                    // widget renders a dropdown for each.
                    collectionGroups: tracker.collectionsByGroup(collections, groupConfig),
                    // Only genres the user hasn't hidden reach the filter row, and
                    // none at all when the genre system is switched off.
                    genres: settings.genresEnabled === false
                        ? []
                        : tracker.visibleGenres(doc, settings.hiddenGenres)
                })
            }
            // Every genre in the library plus its hidden state, for the settings
            // panel. Separate from listTitles because that one deliberately omits
            // hidden genres, and the panel needs to show them to un-hide them.
            case "listAllGenres": {
                const doc = loadDocument(settings)
                const hidden = tracker.hiddenGenreSet(settings.hiddenGenres)
                return sendJson(200, {
                    genres: tracker.listGenres(doc).map(name => ({
                        name,
                        hidden: hidden.has(name.toLowerCase())
                    }))
                })
            }
            case "setHiddenGenres":
                persistFields({ hiddenGenres: String(query.hiddenGenres || "") })
                return sendJson(200, { ok: true })
            // Every collection in the library plus its group, for the settings
            // panel. Read from the live library so a collection created on a row
            // is immediately assignable.
            case "collectionGroups": {
                const doc = loadDocument(settings)
                const config = tracker.parseGroupConfig(settings.collectionGroups)
                return sendJson(200, {
                    // Raw stored value, so a mismatch between what was saved and
                    // what is rendered can be seen rather than inferred.
                    raw: settings.collectionGroups ?? null,
                    groups: config.groups,
                    collections: collectionRows(doc, config)
                })
            }
            case "setCollectionGroups": {
                // Re-parsed before saving so an unknown group or malformed payload
                // can't be written into settings.
                const config = tracker.parseGroupConfig(query.config)
                persistFields({ collectionGroups: tracker.serializeGroupConfig(config) })

                // Return the state that was just written rather than making the
                // caller re-read it: a read issued immediately after the write can
                // still see the previous note content, which showed up as an
                // assignment reverting on reload.
                const doc = loadDocument(settings)
                const stored = tracker.serializeGroupConfig(config)
                return sendJson(200, {
                    ok: true,
                    raw: stored,
                    groups: config.groups,
                    collections: tracker.listCollections(doc).map(name => ({
                        name,
                        group: tracker.groupOf(config, name)
                    }))
                })
            }
            case "setEpisodeRange":
                return sendJson(200, setEpisodeRange(
                    settings, query.key, query.ranges,
                    query.watched === "true", query.totalEpisodes
                ))
            case "saveViewState":
                return sendJson(200, saveViewState(query))
            case "setCollections":
                return sendJson(200, setCollections(settings, query.key, query.collections))
            case "renameCollection":
                return sendJson(200, renameCollection(settings, query.from, query.to))
            case "fullDetails":
                return sendJson(200, await fullDetails(
                    settings, query.mediaType, query.tmdbId, query.imdbId, query.key
                ))
            case "refreshLibrary":
                return sendJson(200, await refreshLibrary(settings))
            case "search":
                return sendJson(200, { results: await tmdbSearch(settings, query.query || "", query.mediaType) })
            case "details":
                return sendJson(200, await detailsForKey(settings, query.mediaType, query.tmdbId, query.imdbId, query.key))
            case "addTitle":
                return sendJson(200, await addTitle(settings, query.mediaType, query.tmdbId))
            case "addFromLink":
                return sendJson(200, await addFromLink(settings, query.url))
            case "removeTitle":
                return sendJson(200, removeTitle(settings, query.key))
            case "setStatus":
                return sendJson(200, setStatus(settings, query.key, query.status))
            case "setRating":
                return sendJson(200, setRating(settings, query.key, query.rating))
            case "setEpisode":
                return sendJson(200, setEpisode(
                    settings, query.key, query.season, query.episode,
                    query.watched === "true", query.totalEpisodes
                ))
            case "traktAuthStart":
                return sendJson(200, await traktAuthStart(settings))
            case "traktAuthPoll":
                return sendJson(200, await traktAuthPoll(settings, query.deviceCode))
            case "importTrakt":
                return sendJson(200, await importTrakt(settings))
            case "archiveTrakt":
                return sendJson(200, await archiveTrakt(settings))
            case "compareTrakt":
                return sendJson(200, await compareTrakt(settings))
            case "importOneWatch": {
                let row
                try {
                    row = JSON.parse(query.row || "{}")
                } catch (e) {
                    throw new Error("Malformed history row")
                }
                return sendJson(200, await importOneWatch(settings, row))
            }
            case "deleteTraktHistory":
                return sendJson(200, await deleteTraktHistory(settings, query.historyId, query.captured))
            case "stremioLogin":
                return sendJson(200, await stremioLogin(settings))
            case "importStremio":
                return sendJson(200, await importStremio(settings))
            default:
                return sendJson(400, { error: `Unknown action: ${action}` })
        }
    } catch (e) {
        return sendJson(500, { error: e.message })
    }
}

// Exported so the scheduled importer (autoSync.js) reuses these exact functions
// rather than reimplementing them.
module.exports = { importStremio, importTrakt }

// Only serve a request when there actually is one. Requiring this note for its
// exports must not trigger the HTTP handler, which would fail on the missing
// api.req/api.res.
if (typeof api !== "undefined" && api.req && api.res) handle()
