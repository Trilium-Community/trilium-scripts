#!/usr/bin/env node
"use strict";
/* TAM addon toolchain -- one entry point for every build/validate/publish step.

Subcommands (run `tamhelper.js <cmd> -h` for each one's flags):

  validate              Lint every addon manifest before publishing.
  tam-to-zip            Convert a manifest (or --all) into a Trilium ZIP import.
  zip-to-tam            Convert a Trilium export ZIP into a manifest + source files.
  generate-pages        Build the GitHub Pages site (resources/docs/).
  generate-readme       Regenerate README.md's addon table from manifests.
  publish-release       Upload the built *.zip files and the catalog to GitHub Releases.
  publish               Resolve + hash every manifest into resources/docs/.
  changelog             Regenerate every addon's CHANGELOG.md from git history.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const MANIFEST_NAME = "_tam_manifest_.json";

// One MIME<->extension table, used in both build directions. tam-to-zip needs
// mime -> ext; zip-to-tam needs ext -> mime, with a preferred mime per ext.
const MIME_TO_EXT = {
    "text/html":                            ".html",
    "text/markdown":                        ".md",
    "text/jsx":                             ".jsx",
    "text/css":                             ".css",
    "text/x-python":                        ".py",
    "text/plain":                           ".txt",
    "application/json":                     ".json",
    "application/javascript":               ".js",
    "application/javascript;env=frontend":  ".js",
    "application/javascript;env=backend":   ".js",
    "application/javascript;env=hybrid":    ".js",
    "audio/wav":                            ".wav",
};
const EXT_TO_MIME = {
    ".js":   "application/javascript;env=frontend",
    ".jsx":  "text/jsx",
    ".css":  "text/css",
    ".json": "application/json",
    ".html": "text/html",
    ".md":   "text/markdown",
    ".py":   "text/x-python",
};

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";


// ---------------------------------------------------------------------------
// Small stdlib-shaped helpers (Python parity)
// ---------------------------------------------------------------------------

function die(msg) {
    process.stderr.write(msg + "\n");
    process.exit(1);
}

function htmlEscape(s, quote = true) {
    s = String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    if (quote) {
        s = s.replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    }
    return s;
}

function randChoices(chars, k) {
    let out = "";
    for (let i = 0; i < k; i++) {
        out += chars[crypto.randomInt(chars.length)];
    }
    return out;
}

// Python's json.dumps(obj, indent=N): keys in insertion order, spaces after
// ':' and ','. JSON.stringify with an indent already matches this closely.
function jsonDumps(obj, indent) {
    return JSON.stringify(obj, null, indent);
}

function readText(p) {
    return fs.readFileSync(p, "utf8");
}

function writeText(p, text) {
    fs.writeFileSync(p, text);
}

function exists(p) {
    return fs.existsSync(p);
}

function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function suffixOf(name) {
    const base = path.basename(name);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot) : "";
}

function stemOf(name) {
    const base = path.basename(name);
    const suf = suffixOf(name);
    return suf ? base.slice(0, base.length - suf.length) : base;
}


// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function iterManifests(addonsDir = "addons") {
    // Sorted paths to every addons/*/_tam_manifest_.json.
    let names;
    try {
        names = fs.readdirSync(addonsDir);
    } catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        const mf = path.join(addonsDir, name, MANIFEST_NAME);
        if (exists(mf)) out.push(mf);
    }
    out.sort();
    return out;
}


function uniqueName(base, used) {
    // Return `base`, or `base-2`/`base-3`/... if taken. A name with an
    // extension is disambiguated before the extension (foo.js -> foo-2.js).
    // `used` is a Set that this call adds the result to.
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    const suffix = suffixOf(base);
    const stem = suffix ? stemOf(base) : base;
    let i = 2;
    while (used.has(`${stem}-${i}${suffix}`)) i++;
    const result = `${stem}-${i}${suffix}`;
    used.add(result);
    return result;
}


// The manifest-shape helpers and shared constants from lib-tam.js's own model
// note, required straight from the addon's source so the toolchain and the
// runtime can't drift apart.
const {
    addonAnchorRootLocalId,
    addonAnchorPersistenceLocalId,
    anchorIconClass,
    TYPE_COLORS,
    childEdges,
    persistentLocalIds,
} = require(path.join(__dirname, "..", "..", "addons", "trilium-addon-manager@beatlink", "tam-manifest-model.js"));


function runGit(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.error || result.status !== 0) return null;
    return result.stdout.trim();
}


async function fetchBuffer(url) {
    // Every note's sourceUrl is an absolute URL (see lib-tam.js's resolveNotes) --
    // tam-to-zip fetches the same way TAM itself does at install time, rather than
    // reading a local file, so a local build always reflects what's actually published.
    // encodeURI leaves an already-escaped URL untouched but escapes raw special
    // chars (e.g. "@" in an addon dir name) that otherwise make GitHub/CDN caches
    // key the request differently -- see lib-tam.js's fetchWithRetry.
    const response = await fetch(encodeURI(url));
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    return Buffer.from(await response.arrayBuffer());
}


async function readSource(sourceUrl, manifestFile) {
    // A source manifest names its files relative to itself, so they are read
    // straight off disk -- the copy about to be published, not whatever an
    // earlier commit left on the CDN. Only a sourceUrl pointing at someone
    // else's repo is still fetched.
    if (/^https?:\/\//.test(sourceUrl)) return await fetchBuffer(sourceUrl);
    const filePath = path.join(path.dirname(manifestFile), sourceUrl);
    if (!exists(filePath)) throw new Error(`no such file: ${filePath}`);
    return fs.readFileSync(filePath);
}


const GITHUB_REMOTE_RE = /^(?:git@github\.com:|https:\/\/github\.com\/)(.+?)(?:\.git)?$/;


function loadAddons() {
    // Parse every addon manifest under addons/ into {meta, readmeHtml, outerDir}.
    if (!isDir("addons")) {
        die("ERROR: no 'addons/' directory -- run from repo root");
    }

    const addons = [];
    for (const metaFile of iterManifests()) {
        let meta;
        try {
            meta = JSON.parse(readText(metaFile));
        } catch (e) {
            console.log(`WARNING: skipping ${metaFile}: ${e.message}`);
            continue;
        }
        if (!meta.id) continue;

        const outerDir = path.dirname(metaFile);
        const render = (rel) => (rel && exists(path.join(outerDir, rel)))
            ? renderMd(readText(path.join(outerDir, rel)))
            : "";

        addons.push({ meta, readmeHtml: render(meta.readme), changelogHtml: render(meta.changelog), outerDir });
    }
    return addons;
}


// ===========================================================================
// validate
// ===========================================================================

// Absence of any of these is a warning; only `id` is a hard requirement, gated in cmdValidate itself.
const EXPECTED_FIELDS = ["id", "name", "description", "author", "homepage", "license", "latestVersion", "type"];
const GENERIC_TITLES = new Set(["lib", "library", "libsettings", "settings", "utils", "helper", "helpers"]);
const ICON_PACK_FONT_MIMES = new Set(["font/woff2", "font/woff", "font/ttf"]);

const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;
const IMPORT_RE = /^\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gm;
const EXPORT_RE = /^\s*export\s+(const|let|var|function|class|default|\{)/m;
const TAM_REQUIRE_RE = /tamRequire\(\s*["']([^"']+)["']\s*\)/g;

// One rule per function, run in declaration order over a shared per-manifest
// context; a check returning false ends that manifest's run (a gating fault,
// or a metadata-only addon with nothing more to check).
const MANIFEST_CHECKS = [
    checkExpectedFields,
    checkIdShape,
    checkHomepage,
    checkReadmeFile,
    checkChangelogFile,
    checkManifestSourceUrl,
    prepareNoteContext,
    checkNoteDeclarations,
    checkRoot,
    checkNamedNotes,
    checkSettings,
    checkScriptEnv,
    checkEsModuleSyntax,
    checkTreeReachability,
    checkRedundantPersistenceFlags,
    checkGenericTitles,
    checkSourceUrls,
    checkAttachments,
    checkIconPacks,
    checkChildrenRefs,
    checkChildCycles,
    checkRelationRefs,
    checkLabelRefs,
    checkRequireReachability,
    checkTamRequireTargets,
];


async function cmdValidate(args) {
    const errors = [], warnings = [], fixes = [];

    const error = (p, msg) => errors.push(`ERROR   ${p}: ${msg}`);
    const warn = (p, msg) => warnings.push(`WARNING ${p}: ${msg}`);

    const manifestFiles = iterManifests();
    for (const manifestFile of manifestFiles) {
        let manifest;
        try {
            manifest = JSON.parse(readText(manifestFile));
        } catch (e) {
            error(manifestFile, `invalid JSON -- ${e.message}`);
            continue;
        }
        if (!manifest.id) {
            error(manifestFile, "missing required field 'id'");
            continue;
        }
        const ctx = {
            manifestFile,
            addonDir: path.dirname(manifestFile),
            args,
            manifest,
            addonId: manifest.id,
            error, warn, fixes,
        };
        for (const check of MANIFEST_CHECKS) {
            if (await check(ctx) === false) break;
        }
    }

    for (const msg of [...fixes, ...warnings, ...errors]) {
        console.log(msg);
    }
    if (!(fixes.length || warnings.length || errors.length)) {
        console.log(`OK -- ${manifestFiles.length} addon(s) validated successfully`);
    }
    if (errors.length) {
        process.exit(1);
    }
}


function checkExpectedFields({ manifest, manifestFile, warn }) {
    for (const field of EXPECTED_FIELDS) {
        if (!(field in manifest)) {
            warn(manifestFile, `missing field '${field}'`);
        }
    }
}


function checkIdShape({ addonId, manifestFile, error }) {
    if (addonId.includes(" ")) {
        error(manifestFile, `'id' contains spaces: "${addonId}"`);
        return false;
    }
}


// homepage URL must end with addons/{id} (only when it contains /addons/)
function checkHomepage({ manifest, manifestFile, addonId, args, warn, fixes }) {
    const homepage = manifest.homepage || "";
    if (!homepage) return;
    let parsedUrl;
    try {
        parsedUrl = new URL(homepage);
    } catch {
        parsedUrl = null;
    }
    if (!parsedUrl) return;
    const decodedPath = decodeURIComponent(parsedUrl.pathname).replace(/\/+$/, "");
    const expected = `addons/${addonId}`;
    if (!decodedPath.includes("/addons/") || decodedPath.endsWith(expected)) return;
    if (args.fix) {
        let parts = decodedPath.split("/");
        const revIdx = [...parts].reverse().indexOf("addons");
        if (revIdx !== -1) {
            const addonsIdx = parts.length - 1 - revIdx;
            parts = parts.slice(0, addonsIdx + 1).concat([addonId]);
        } else {
            parts[parts.length - 1] = addonId;
        }
        parsedUrl.pathname = parts.join("/");
        const newHomepage = parsedUrl.toString();
        manifest.homepage = newHomepage;
        writeText(manifestFile, jsonDumps(manifest, 4) + "\n");
        fixes.push(`FIXED   updated homepage in '${manifestFile}': '${homepage}' -> '${newHomepage}'`);
    } else {
        warn(manifestFile, `homepage does not end with 'addons/${addonId}' (run --fix to update)`);
    }
}


function checkReadmeFile({ manifest, addonDir, manifestFile, error }) {
    const readmeRel = manifest.readme;
    if (readmeRel && !exists(path.join(addonDir, readmeRel))) {
        error(manifestFile, `'readme' points to "${readmeRel}" but file not found`);
    }
}


// Not authored any more -- publish sets it. A source manifest still
// carries it so an install predating the publish phase, refetching the
// raw manifest, is told where the published one lives and moves itself
// over on its next sync.
/* Only a hand-authored changelog is checked for the current version's entry: a
 * generated one names the version at HEAD, so a bump not yet committed legitimately
 * has no entry, and `changelog --check` is what holds those to their history.
 */
function checkChangelogFile({ manifest, addonDir, manifestFile, args, error, warn, fixes }) {
    if (!manifest.changelog) {
        if (!exists(path.join(addonDir, CHANGELOG_NAME))) return;
        if (args.fix) {
            const afterKey = "readme" in manifest ? "readme" : "type";
            writeText(manifestFile, jsonDumps(insertKeyAfter(manifest, afterKey, "changelog", CHANGELOG_NAME), 4) + "\n");
            fixes.push(`FIXED   added changelog to '${manifestFile}' -> '${CHANGELOG_NAME}'`);
        } else {
            warn(manifestFile, `has a ${CHANGELOG_NAME} but no 'changelog' field (run --fix to add it)`);
        }
        return;
    }
    const changelogFile = path.join(addonDir, manifest.changelog);
    if (!exists(changelogFile)) {
        error(manifestFile, `'changelog' points to "${manifest.changelog}" but file not found`);
        return;
    }
    const text = readText(changelogFile);
    if (text.includes(CHANGELOG_MARKER) || !manifest.latestVersion) return;
    if (!changelogSection(text, manifest.latestVersion)) {
        error(manifestFile, `'${manifest.changelog}' has no entry for version ${manifest.latestVersion}`);
    }
}


function checkManifestSourceUrl({ manifest, manifestFile, args, error, warn, fixes }) {
    const publishedUrl = publishedManifestUrl(manifest.id);
    if (!manifest.manifestSourceUrl) {
        warn(manifestFile, `missing 'manifestSourceUrl' -- should be ${publishedUrl}`);
    } else if (manifest.manifestSourceUrl !== publishedUrl) {
        if (args.fix) {
            manifest.manifestSourceUrl = publishedUrl;
            writeText(manifestFile, jsonDumps(manifest, 4) + "\n");
            fixes.push(`FIXED   updated manifestSourceUrl in '${manifestFile}' -> '${publishedUrl}'`);
        } else {
            error(manifestFile, `'manifestSourceUrl' is '${manifest.manifestSourceUrl}' but publish serves this manifest at ${publishedUrl}`);
        }
    }
}


// Attaches the note-tree context every later check reads. False ends the run:
// a metadata-only addon, or a notes[] that isn't usable at all.
function prepareNoteContext(ctx) {
    const m = ctx.manifest.manifest;
    if (m == null) {
        return false; // metadata-only addon
    }
    if (!Array.isArray(m.notes)) {
        ctx.error(ctx.manifestFile, "manifest.notes must be an array");
        return false;
    }
    ctx.m = m;
    ctx.notes = m.notes;
    ctx.noteIds = new Set();
    ctx.byId = {};
    for (const note of ctx.notes) {
        const nid = note.id || note.title;
        if (nid) {
            ctx.noteIds.add(nid);
            ctx.byId[nid] = note;
        }
    }
    // Local ids whose children[] parent chain roots at the reserved "persistence" parent
    // keyword -- these are "persistent": created once, prompt-on-update, never touched by
    // uninstall.
    ctx.persistentIds = persistentLocalIds(m);
    // Notes served as static HTTP resources are exempt from the env check.
    ctx.resourceNoteIds = new Set(
        (m.labels || [])
            .filter((lbl) => lbl.name === "customResourceProvider")
            .map((lbl) => lbl.note)
    );
}


function checkNoteDeclarations({ notes, manifestFile, error, warn }) {
    const seen = new Set();
    for (const note of notes) {
        const nid = note.id || note.title;
        if (nid) {
            // A repeated id resolves to one note, so the later entry is silently
            // dropped -- and if the two differ, which one installs is not obvious.
            if (seen.has(nid)) {
                error(manifestFile, `note '${nid}' is declared more than once in notes`);
            }
            seen.add(nid);
        }
        if (!note.title) {
            warn(manifestFile, `note '${nid}' missing 'title'`);
        }
    }
}


// TAM itself bootstraps via a manual ZIP import, so its own manifest is the one
// exception that still declares a real root note. Every other addon's root is
// synthesized by TAM (ensureAddonAnchor) -- its manifest only ever references it via
// the reserved "root" parent keyword in children[], never as a notes[] entry.
function checkRoot({ m, noteIds, manifestFile, error }) {
    const rootId = m.root;
    if (rootId) {
        if (!noteIds.has(rootId)) {
            error(manifestFile, `manifest.root '${rootId}' not found in notes`);
        }
    } else if (!(m.children || []).some((c) => c.parent === "root")) {
        error(manifestFile, "manifest.children must attach at least one note to the reserved \"root\" parent");
    }
}


function checkNamedNotes({ m, noteIds, byId, manifestFile, error, warn }) {
    for (const field of ["settingsNote", "readmeNote"]) {
        const localId = m[field];
        if (localId && !noteIds.has(localId)) {
            error(manifestFile, `manifest.${field} '${localId}' not found in notes`);
        }
    }
    // settingsNote should point at a render note, not the raw code note
    const settingsNote = byId[m.settingsNote];
    if (settingsNote && settingsNote.type === "code") {
        warn(manifestFile, `settingsNote '${m.settingsNote}' is a raw code note -- point it at the wrapping render note instead`);
    }
}


// manifest.settings hands TAM the schema/defaults/config trio it reviews per
// setting instead of whole-file diffing the config. The schema (fields) and
// the defaults (their shipped values) have to be structural, since both ship
// anew each update; the config has to be persistent (it holds the user's own
// divergences) and must ship no content of its own, or the note would still
// be offered for whole-file replacement on every update.
function checkSettings({ m, noteIds, byId, persistentIds, manifestFile, error, warn }) {
    if (!m.settings) return;
    for (const role of ["schema", "defaults", "config"]) {
        const localId = m.settings[role];
        if (!localId) {
            error(manifestFile, `manifest.settings.${role} is missing`);
            continue;
        }
        if (!noteIds.has(localId)) {
            error(manifestFile, `manifest.settings.${role} '${localId}' not found in notes`);
            continue;
        }
        const note = byId[localId];
        const isPersistent = persistentIds.has(localId);
        if (role !== "config" && isPersistent) {
            error(manifestFile, `manifest.settings.${role} '${localId}' is attached under the reserved "persistence" parent -- it ships anew on every update, so it has to be structural`);
        }
        if (role === "defaults" && !note.sourceUrl && !note.content) {
            error(manifestFile, `manifest.settings.defaults '${localId}' ships no content (sourceUrl/content) -- it holds every setting's shipped value, which the schema no longer carries`);
        }
        if (role === "config") {
            if (!isPersistent) {
                error(manifestFile, `manifest.settings.config '${localId}' is not attached under the reserved "persistence" parent -- the user's settings would be overwritten on every update`);
            }
            if (note.sourceUrl || note.content) {
                error(manifestFile, `manifest.settings.config '${localId}' ships content (sourceUrl/content) -- declare it empty so TAM reviews it per setting instead of offering to replace the whole file`);
            }
        }
        if (note.mime && note.mime !== "application/json") {
            warn(manifestFile, `manifest.settings.${role} '${localId}' has mime '${note.mime}' -- expected application/json`);
        }
    }
    // libsettings reads a config note's sources off its own `sourceConfig`
    // relations, so an unlinked defaults note is simply never merged in.
    const linksDefaults = (m.relations || []).some(
        (r) => r.from === m.settings.config && r.type === "sourceConfig" && r.to === m.settings.defaults
    );
    if (m.settings.defaults && m.settings.config && !linksDefaults) {
        error(manifestFile, `manifest.settings.config '${m.settings.config}' has no sourceConfig relation to the defaults note '${m.settings.defaults}' -- libsettings would read no defaults at all`);
    }
}


function checkScriptEnv({ notes, resourceNoteIds, manifestFile, error, warn }) {
    for (const note of notes) {
        const nid = note.id || note.title || "?";
        const mime = note.mime || "";
        if (mime.startsWith("application/javascript")) {
            if (mime.includes("env=hybrid")) {
                error(manifestFile, `note '${nid}': mime declares 'env=hybrid', which does not exist -- ship two notes (env=frontend + env=backend) instead`);
            } else if (!mime.includes("env=frontend") && !mime.includes("env=backend") && !resourceNoteIds.has(nid)) {
                warn(manifestFile, `note '${nid}': mime '${mime}' is missing an env=frontend/env=backend qualifier`);
            }
        }
    }
}


// plain .js notes are never transpiled -- ES export/import will throw; a .js file stored as a text/jsx note is transpiled.
// Resource notes are exempt for the same reason they skip the env check:
// they are served raw over HTTP and never require()'d, so an ESM bundle
// loaded with a dynamic import() is correct rather than broken.
async function checkEsModuleSyntax({ notes, resourceNoteIds, manifestFile, warn }) {
    for (const note of notes) {
        const nid = note.id || note.title || "?";
        const sourceUrl = note.sourceUrl || "";
        if (sourceUrl.endsWith(".js") && note.mime !== "text/jsx" && !resourceNoteIds.has(nid)) {
            try {
                const src = (await readSource(sourceUrl, manifestFile)).toString("utf8");
                if (EXPORT_RE.test(src)) {
                    warn(manifestFile, `note '${nid}': plain .js source uses ES 'export' syntax, which is not transpiled -- use CommonJS module.exports instead`);
                }
            } catch (e) {
                warn(manifestFile, `note '${nid}': sourceUrl '${sourceUrl}' could not be read (${e.message})`);
            }
        }
    }
}


// notes unreachable from "root" (or "persistence") via children[] will never be created
function checkTreeReachability({ m, noteIds, manifestFile, warn }) {
    const localChildren = new Set(
        (m.children || []).filter((c) => c.child).map((c) => c.child)
    );
    for (const nid of noteIds) {
        if (nid !== m.root && !localChildren.has(nid)) {
            warn(manifestFile, `note '${nid}' is not attached under any parent in 'children' -- it will never be created`);
        }
    }
}


// skipOnUpdate/promptOnUpdate are implied by placement under the reserved "persistence"
// parent -- redundant there
function checkRedundantPersistenceFlags({ notes, persistentIds, manifestFile, warn }) {
    for (const note of notes) {
        const nid = note.id || note.title || "?";
        if (persistentIds.has(nid) && (note.skipOnUpdate || note.promptOnUpdate)) {
            warn(manifestFile, `note '${nid}' is attached under the reserved "persistence" parent, so skipOnUpdate/promptOnUpdate is implied and should be removed`);
        }
    }
}


// generic library titles collide globally across addons
function checkGenericTitles({ notes, manifestFile, warn }) {
    for (const note of notes) {
        const title = note.title || "";
        if (GENERIC_TITLES.has(title.toLowerCase()) && note.type === "code") {
            warn(manifestFile, `note title '${title}' is generic -- require()/the bundle-global namespace is shared across all addons; use a fully-qualified title`);
        }
    }
}


// sourceUrl files must be fetchable
async function checkSourceUrls({ notes, manifestFile, error }) {
    for (const note of notes) {
        const nid = note.id || note.title || "?";
        const sourceUrl = note.sourceUrl;
        if (sourceUrl) {
            try {
                await readSource(sourceUrl, manifestFile);
            } catch (e) {
                error(manifestFile, `note '${nid}': sourceUrl '${sourceUrl}' could not be read (${e.message})`);
            }
        }
    }
}


// Attachments are how Trilium carries an icon pack's font file (it reads
// getAttachmentsByRole("file") and picks by mime), and an attachment is
// matched on its title, so a blank one can never be found again.
async function checkAttachments({ notes, manifestFile, error, warn }) {
    const seenAttachments = new Set();
    for (const note of notes) {
        const nid = note.id || note.title || "?";
        if (note.attachments !== undefined && !Array.isArray(note.attachments)) {
            error(manifestFile, `note '${nid}': 'attachments' must be an array`);
            continue;
        }
        for (const att of note.attachments || []) {
            if (!att.title) {
                error(manifestFile, `note '${nid}': an attachment is missing 'title', which is what TAM matches it on across syncs`);
                continue;
            }
            const key = `${nid}\u0000${att.title}`;
            if (seenAttachments.has(key)) {
                error(manifestFile, `note '${nid}': two attachments share the title '${att.title}' -- the second would overwrite the first`);
            }
            seenAttachments.add(key);
            if (!att.mime) {
                error(manifestFile, `note '${nid}': attachment '${att.title}' is missing 'mime'`);
            }
            if (att.role && att.role !== "file" && att.role !== "image") {
                warn(manifestFile, `note '${nid}': attachment '${att.title}' has role '${att.role}' -- expected 'file' or 'image'`);
            }
            if (!att.sourceUrl && att.content == null) {
                error(manifestFile, `note '${nid}': attachment '${att.title}' ships no content (sourceUrl/content)`);
            }
            if (att.sourceUrl) {
                try {
                    await readSource(att.sourceUrl, manifestFile);
                } catch (e) {
                    error(manifestFile, `note '${nid}': attachment '${att.title}' sourceUrl '${att.sourceUrl}' could not be read (${e.message})`);
                }
            }
        }
    }
}


// An icon pack is a JSON manifest note labelled #iconPack=<prefix> with the
// font as an attachment. Any of the three missing and Trilium drops the pack
// with nothing but a line in the server log.
async function checkIconPacks({ m, byId, manifestFile, error }) {
    for (const label of (m.labels || []).filter((lbl) => lbl.name === "iconPack")) {
        const nid = label.note;
        const note = byId[nid];
        if (!note) continue;
        if (!/^[a-zA-Z0-9_-]+$/.test(label.value || "")) {
            error(manifestFile, `note '${nid}': #iconPack prefix '${label.value || ""}' must be non-empty and only alphanumerics, hyphens and underscores`);
        }
        if (label.value === "bx") {
            error(manifestFile, `note '${nid}': #iconPack prefix 'bx' is taken by Trilium's built-in Boxicons pack`);
        }
        if (note.type !== "code" || note.mime !== "application/json") {
            error(manifestFile, `note '${nid}': an #iconPack note must be type 'code' with mime 'application/json', not '${note.type}'/'${note.mime}'`);
        }
        const font = (note.attachments || []).find((att) => ICON_PACK_FONT_MIMES.has(att.mime));
        if (!font) {
            error(manifestFile, `note '${nid}': #iconPack note has no font attachment -- it needs one with mime ${[...ICON_PACK_FONT_MIMES].join(", ")}`);
        } else if ((font.role || "file") !== "file") {
            error(manifestFile, `note '${nid}': #iconPack font attachment '${font.title}' has role '${font.role}' -- Trilium only reads role 'file'`);
        }
        if (note.sourceUrl) {
            try {
                const parsed = JSON.parse((await readSource(note.sourceUrl, manifestFile)).toString("utf8"));
                if (!parsed || typeof parsed.icons !== "object" || !parsed.icons) {
                    error(manifestFile, `note '${nid}': #iconPack manifest '${note.sourceUrl}' has no 'icons' object`);
                }
            } catch (e) {
                error(manifestFile, `note '${nid}': #iconPack manifest '${note.sourceUrl}' is not readable JSON (${e.message})`);
            }
        }
    }
}


// children references. "root"/"persistence" are reserved parent keywords meaning
// "TAM's synthesized structural/persistence anchor" -- never real declared notes.
function checkChildrenRefs({ m, noteIds, manifestFile, error }) {
    for (const c of m.children || []) {
        const parent = c.parent, child = c.child;
        // A note cannot be its own parent, so the link never applies and no re-sync clears it.
        if (parent && child && parent === child) {
            error(manifestFile, `children: note '${child}' is declared as its own parent`);
        }
        if (parent && parent !== "root" && parent !== "persistence" && !noteIds.has(parent)) {
            error(manifestFile, `children: parent '${parent}' not found in notes`);
        }
        if (child && !noteIds.has(child)) {
            error(manifestFile, `children: child '${child}' not found in notes`);
        }
    }
}


// A parent cycle never installs: the repeated id becomes a clone of the note under itself.
function checkChildCycles({ m, manifestFile, error }) {
    const edges = {};
    for (const c of m.children || []) {
        // A one-hop loop is already reported as a self-parent above.
        if (!c.parent || !c.child || c.parent === c.child) continue;
        (edges[c.parent] ||= []).push(c.child);
    }
    const state = {}, reported = new Set();
    const visit = (id, ancestors) => {
        if (state[id] === "done") return;
        if (state[id] === "open") {
            const cycle = ancestors.slice(ancestors.indexOf(id));
            const key = [...cycle].sort().join("\u0000");
            if (!reported.has(key)) {
                reported.add(key);
                error(manifestFile, `children: parent cycle ${[...cycle, id].join(" -> ")}`);
            }
            return;
        }
        state[id] = "open";
        for (const child of edges[id] || []) visit(child, [...ancestors, id]);
        state[id] = "done";
    };
    for (const id of Object.keys(edges)) visit(id, []);
}


function checkRelationRefs({ m, noteIds, manifestFile, error, warn }) {
    for (const rel of m.relations || []) {
        const fromId = rel.from, toId = rel.to;
        if (fromId && !noteIds.has(fromId)) {
            error(manifestFile, `relations: from '${fromId}' not found in notes`);
        }
        if (toId && !noteIds.has(toId)) {
            warn(manifestFile, `relations: to '${toId}' not found in notes (may be a literal noteId)`);
        }
    }
}


function checkLabelRefs({ m, noteIds, manifestFile, error }) {
    for (const label of m.labels || []) {
        const nid = label.note;
        if (nid && !noteIds.has(nid)) {
            error(manifestFile, `labels: note '${nid}' not found in notes`);
        }
    }
}


// require()/import targets must be co-installed in the requiring note's subtree
async function checkRequireReachability({ manifestFile, m, notes, warn }) {
    await validateRequireReachability(manifestFile, m, notes, REQUIRE_RE, IMPORT_RE, warn);
}


// tamRequire("addon@author/localId") targets must name a real, frontend-loadable note
async function checkTamRequireTargets({ manifestFile, addonId, m, notes, error }) {
    await validateTamRequireTargets(manifestFile, addonId, m, notes, TAM_REQUIRE_RE, error);
}


async function validateRequireReachability(manifestFile, m, notes, requireRe, importRe, warn) {
    // A code note that require()s/imports another note by title resolves it
    // within its own installed subtree. Warn when a target isn't reachable there.
    const idToTitle = {};
    for (const n of notes) {
        idToTitle[n.id || n.title] = n.title || "";
    }
    const localTitles = new Set(Object.values(idToTitle).filter(Boolean));

    const localChildEdges = childEdges(m.children);

    function descendants(startId) {
        const seen = new Set();
        const stack = [startId];
        while (stack.length) {
            const cur = stack.pop();
            if (seen.has(cur)) continue;
            seen.add(cur);
            stack.push(...(localChildEdges[cur] || []));
        }
        return seen;
    }

    for (const note of notes) {
        if (note.type !== "code") continue;
        const mime = note.mime || "";
        if (!(mime.startsWith("application/javascript") || mime.includes("jsx"))) continue;
        const sourceUrl = note.sourceUrl || "";
        if (!sourceUrl) continue;

        let src;
        try {
            src = (await readSource(sourceUrl, manifestFile)).toString("utf8");
        } catch (e) {
            continue; // already reported by the sourceUrl-must-be-fetchable check above
        }
        const targets = new Set();
        for (const mm of src.matchAll(requireRe)) targets.add(mm[1]);
        for (const mm of src.matchAll(importRe)) targets.add(mm[1]);
        const filtered = new Set([...targets].filter((t) => t.endsWith(".js") || t.endsWith(".jsx")));
        if (!filtered.size) continue;

        const nid = note.id || note.title;
        const subtree = descendants(nid);
        const reachable = new Set();
        for (const d of subtree) reachable.add(idToTitle[d] || "");

        for (const t of [...filtered].sort()) {
            if (reachable.has(t)) continue;
            if (localTitles.has(t)) {
                warn(manifestFile, `note '${nid}': require/import of '${t}' resolves to a local note wired outside this note's subtree -- it won't be found at runtime`);
            } else {
                warn(manifestFile, `note '${nid}': require/import of '${t}' is not installed in this note's subtree -- wire it under '${nid}' via children[]`);
            }
        }
    }
}


let addonManifestCache = null;

// Every addon's parsed manifest in this repo, keyed by addon id.
function loadAddonManifests() {
    if (addonManifestCache) return addonManifestCache;
    addonManifestCache = {};
    for (const mf of iterManifests()) {
        try {
            const parsed = JSON.parse(readText(mf));
            if (parsed.id) addonManifestCache[parsed.id] = parsed;
        } catch {
            continue; // invalid JSON is already reported by the main validate loop
        }
    }
    return addonManifestCache;
}

// Whether a note can be loaded by FNote.executeScript, mirroring Trilium's getScriptEnv().
function isFrontendLoadable(note) {
    const mime = note.mime || "";
    if (note.type !== "code") return false;
    return mime === "text/jsx" || (mime.startsWith("application/javascript") && mime.endsWith("env=frontend"));
}

async function validateTamRequireTargets(manifestFile, addonId, m, notes, tamRequireRe, error) {
    // tamRequire() resolves a note by its #TAMFILEID rather than by tree position, so the
    // require-reachability check above cannot see it. Check the id names a loadable note instead.
    for (const note of notes) {
        if (note.type !== "code") continue;
        const mime = note.mime || "";
        if (!(mime.startsWith("application/javascript") || mime.includes("jsx"))) continue;
        const sourceUrl = note.sourceUrl || "";
        if (!sourceUrl) continue;

        let src;
        try {
            src = (await readSource(sourceUrl, manifestFile)).toString("utf8");
        } catch (e) {
            continue; // already reported by the sourceUrl-must-be-fetchable check above
        }

        const nid = note.id || note.title;
        for (const mm of src.matchAll(tamRequireRe)) {
            const target = mm[1];
            const slash = target.indexOf("/");
            if (slash < 1) {
                error(manifestFile, `note '${nid}': tamRequire('${target}') is not of the form 'addonId/localId'`);
                continue;
            }
            const targetAddonId = target.slice(0, slash);
            const targetLocalId = target.slice(slash + 1);

            const isLocal = targetAddonId === addonId;
            const targetManifest = isLocal ? m : (loadAddonManifests()[targetAddonId] || {}).manifest;
            if (!targetManifest) continue; // a dependency addon outside this repo, nothing to check against

            const targetNote = (targetManifest.notes || []).find((n) => (n.id || n.title) === targetLocalId);
            if (!targetNote) {
                const where = isLocal ? "this manifest" : `addon '${targetAddonId}'`;
                error(manifestFile, `note '${nid}': tamRequire('${target}') names no note in ${where}`);
                continue;
            }
            if (!isFrontendLoadable(targetNote)) {
                error(manifestFile, `note '${nid}': tamRequire('${target}') targets a note of type '${targetNote.type}'/'${targetNote.mime || ""}', which executeScript cannot load`);
            }
        }
    }
}


// ===========================================================================
// tam-to-zip
// ===========================================================================

const TRILIUM_APP_VERSION = "0.103.0";


function safeName(title) {
    return title.replace(/\//g, "-").replace(/\\/g, "-");
}


async function processManifest(fullManifest, manifestFile) {
    // Build ZIP entries for one manifest.
    // Returns { rootEntry, zipFiles, warnings, uuidMap }.
    const m = fullManifest.manifest || {};

    const notesById = {};
    for (const n of m.notes || []) notesById[n.id] = n;

    // No declared m.root -- every addon but TAM itself. TAM synthesizes this note live
    // (ensureAddonAnchor) under the shared anchor local id; mirror that here purely so the
    // ZIP has a single top-level note to build around, titled after the addon, content-free.
    const rootLid = m.root || addonAnchorRootLocalId;
    if (!m.root) {
        notesById[rootLid] = { id: rootLid, title: fullManifest.name || fullManifest.id, type: "text", mime: "text/html", sourceUrl: null };
    }

    // Live sync parents this under the separate global "Addon Data" anchor; a ZIP export is
    // one tree, so it's nested under the synthetic root here purely as an export approximation.
    const hasPersistence = (m.children || []).some((c) => c.parent === "persistence");
    const persistenceLid = addonAnchorPersistenceLocalId;
    if (hasPersistence) {
        notesById[persistenceLid] = { id: persistenceLid, title: "Persistence", type: "text", mime: "text/html", sourceUrl: null };
    }

    const uuidMap = {};
    for (const lid of Object.keys(notesById)) uuidMap[lid] = randChoices(ID_CHARS, 12);

    // A child listed under >1 parent builds only on first occurrence; later
    // occurrences become isClone references to the same generated noteId.
    const childrenMap = {}, seenChildren = new Set();
    for (const c of m.children || []) {
        const childLid = c.child;
        const isCloneRef = seenChildren.has(childLid);
        seenChildren.add(childLid);
        // The reserved "root"/"persistence" parent keywords mean "TAM's synthesized anchor" --
        // redirect to the matching synthetic entry's local id so buildEntry finds its children
        // under the right key.
        let parentLid = c.parent;
        if (!m.root && c.parent === "root") parentLid = rootLid;
        else if (c.parent === "persistence") parentLid = persistenceLid;
        (childrenMap[parentLid] ||= []).push([childLid, isCloneRef]);
    }
    if (hasPersistence) {
        (childrenMap[rootLid] ||= []).push([persistenceLid, false]);
    }

    const noteLabels = {}, noteRelations = {};
    for (const lbl of m.labels || []) (noteLabels[lbl.note] ||= []).push(lbl);
    for (const rel of m.relations || []) (noteRelations[rel.from] ||= []).push(rel);
    // The synthetic anchors' own #iconClass -- TAM sets this uniformly on every anchor it owns.
    if (!m.root) noteLabels[rootLid] = [{ note: rootLid, name: "iconClass", value: anchorIconClass }];
    if (hasPersistence) noteLabels[persistenceLid] = [{ note: persistenceLid, name: "iconClass", value: anchorIconClass }];

    const zipFiles = [], warnings = [];
    const usedBases = {};

    function uniqueBase(dirPrefix, base) {
        const set = (usedBases[dirPrefix] ||= new Set());
        return uniqueName(base, set);
    }

    async function buildEntry(localId, notePosition, dirPrefix, notePath) {
        const noteDef = notesById[localId];
        const noteUuid = uuidMap[localId];
        // Match Python's dict.get(key, default): a present-but-empty value
        // ("mime": "" on a render note) stays empty, it is not defaulted.
        const noteType = "type" in noteDef ? noteDef.type : "text";
        const noteMime = "mime" in noteDef ? noteDef.mime : "text/html";
        const title = noteDef.title;

        const localChildren = childrenMap[localId] || [];
        const hasChildren = Boolean(localChildren.length);
        const currentPath = [...notePath, noteUuid];

        const ext = noteType === "render" ? ".html" : (MIME_TO_EXT[noteMime] || ".html");
        const base = uniqueBase(dirPrefix, safeName(title));
        const dataName = base.toLowerCase().endsWith(ext.toLowerCase()) ? base : base + ext;
        let dirName = hasChildren ? base : null;

        // A title carrying its own extension (e.g. "libTAM.js") makes
        // dataName == base == dirName once it gains a child -- impossible on a
        // filesystem/zip. Reserve a second name to disambiguate.
        if (dirName !== null && dirName === dataName) {
            dirName = uniqueBase(dirPrefix, dirName);
        }

        let content;
        if (noteType === "render") {
            content = Buffer.alloc(0);
        } else {
            const sourceUrl = noteDef.sourceUrl;
            if (sourceUrl) {
                try {
                    content = await readSource(sourceUrl, manifestFile);
                } catch (e) {
                    warnings.push(`note '${localId}': sourceUrl '${sourceUrl}' could not be read (${e.message}) -- empty content used`);
                    content = Buffer.alloc(0);
                }
            } else if (noteDef.content != null) {
                const c = noteDef.content;
                content = typeof c === "string" ? Buffer.from(c) : Buffer.from(c);
            } else {
                content = Buffer.alloc(0);
            }
        }

        zipFiles.push([dirPrefix + dataName, content]);
        const childPrefix = dirName ? dirPrefix + dirName + "/" : dirPrefix;

        // Trilium's importer looks an attachment's data file up as a sibling of its
        // owner note's own, named "{note base}_{attachment title}" -- and skips any
        // entry with no attachmentId, so each needs a generated one like a note.
        const attachments = [];
        let attPos = 10;
        for (const att of noteDef.attachments || []) {
            const attName = uniqueBase(dirPrefix, safeName(`${base}_${att.title}`));
            let attContent;
            if (att.sourceUrl) {
                try {
                    attContent = await readSource(att.sourceUrl, manifestFile);
                } catch (e) {
                    warnings.push(`note '${localId}': attachment '${att.title}' sourceUrl '${att.sourceUrl}' could not be read (${e.message}) -- skipped`);
                    continue;
                }
            } else {
                attContent = (att.binary ?? true) && typeof att.content === "string"
                    ? Buffer.from(att.content, "base64")
                    : Buffer.from(att.content ?? "");
            }
            zipFiles.push([dirPrefix + attName, attContent]);
            attachments.push({
                attachmentId: randChoices(ID_CHARS, 12),
                title: att.title, role: att.role || "file", mime: att.mime,
                position: attPos, dataFileName: attName,
            });
            attPos += 10;
        }

        const attrs = [];
        let pos = 10;
        // Every TAM-managed note carries a permanent #TAMFILEID label
        // ("{addonId}/{localId}") -- its sole identity mechanism.
        attrs.push({
            type: "label", name: "TAMFILEID",
            value: `${fullManifest.id || ""}/${localId}`,
            isInheritable: false, position: pos,
        });
        pos += 10;

        for (const lbl of noteLabels[localId] || []) {
            attrs.push({
                type: "label", name: lbl.name, value: lbl.value || "",
                isInheritable: false, position: pos,
            });
            pos += 10;
        }

        for (const rel of noteRelations[localId] || []) {
            const target = uuidMap[rel.to] ?? rel.to;
            attrs.push({
                type: "relation", name: rel.type, value: target,
                isInheritable: false, position: pos,
            });
            pos += 10;
        }

        // A Trilium ZIP import walks physical file entries; an isClone meta
        // entry with no backing file is never visited. Mirror Trilium's own
        // exporter: write an empty placeholder file for every clone.
        function cloneEntry(noteId, cloneNotePath, position) {
            const cloneName = uniqueBase(childPrefix, "clone") + ".html";
            zipFiles.push([childPrefix + cloneName, Buffer.alloc(0)]);
            return {
                isClone: true, noteId, notePath: cloneNotePath,
                notePosition: position, prefix: null, isExpanded: false,
                dataFileName: cloneName,
            };
        }

        const childEntries = [];
        let i = 1;
        for (const [childLid, isCloneRef] of localChildren) {
            if (isCloneRef) {
                childEntries.push(cloneEntry(uuidMap[childLid], [...currentPath, uuidMap[childLid]], i * 10));
            } else {
                childEntries.push(await buildEntry(childLid, i * 10, childPrefix, currentPath));
            }
            i++;
        }

        const entry = {
            isClone: false, noteId: noteUuid, notePath: currentPath,
            title, notePosition: notePosition, prefix: null,
            isExpanded: hasChildren, type: noteType, mime: noteMime,
            attributes: attrs, attachments, dataFileName: dataName,
        };
        if (dirName) entry.dirFileName = dirName;
        if (childEntries.length) entry.children = childEntries;
        if (noteType === "text") {
            entry.format = noteMime === "text/markdown" ? "markdown" : "html";
        }
        return entry;
    }

    const rootEntry = await buildEntry(rootLid, 10, "", []);
    if (!("dirFileName" in rootEntry)) {
        rootEntry.dirFileName = safeName(notesById[rootLid].title);
    }
    return { rootEntry, zipFiles, warnings, uuidMap };
}


async function buildZip(manifestPath, outPath) {
    if (!exists(manifestPath)) {
        die(`ERROR: ${manifestPath} not found`);
    }

    const addonDir = path.dirname(manifestPath);
    const fullManifest = JSON.parse(readText(manifestPath));
    if (outPath == null) {
        outPath = path.join(addonDir, `${fullManifest.id || "export"}.zip`);
    }

    const m = fullManifest.manifest;
    if (!m) {
        die("ERROR: no 'manifest' key -- metadata-only addons cannot be exported as a Trilium ZIP");
    }
    if (!m.root && !(m.children || []).some((c) => c.parent === "root")) {
        die("ERROR: manifest.children must attach at least one note to the reserved \"root\" parent");
    }

    const { rootEntry, zipFiles, warnings } = await processManifest(fullManifest, manifestPath);

    const triliumMeta = {
        formatVersion: 2, appVersion: TRILIUM_APP_VERSION,
        files: [rootEntry],
    };

    writeZip(outPath, [
        ["!!!meta.json", Buffer.from(jsonDumps(triliumMeta, 2))],
        ...zipFiles,
    ]);

    if (warnings.length) {
        console.log("Warnings:");
        for (const w of warnings) console.log(`  ${w}`);
    }

    console.log(`Written: ${outPath}  (${zipFiles.length} content files)`);
}


async function cmdTamToZip(args) {
    if (args.all) {
        if (args.manifest || args.out) {
            die("ERROR: --all cannot be combined with a manifest path or --out");
        }
        const addonsDir = args.addonsDir || "addons";
        const outDir = args.outDir || ".";

        const manifestPaths = iterManifests(addonsDir);
        if (!manifestPaths.length) {
            die(`ERROR: no ${MANIFEST_NAME} files found under ${addonsDir}`);
        }
        for (const manifestPath of manifestPaths) {
            const addonId = JSON.parse(readText(manifestPath)).id || "export";
            await buildZip(manifestPath, path.join(outDir, `${addonId}.zip`));
        }
        return;
    }

    if (!args.manifest) {
        die("ERROR: manifest is required unless --all is given");
    }
    let manifestPath = args.manifest;
    if (isDir(manifestPath)) {
        manifestPath = path.join(manifestPath, MANIFEST_NAME);
    }
    await buildZip(manifestPath, args.out || null);
}


// ===========================================================================
// zip-to-tam
// ===========================================================================

function slugify(title) {
    const s = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s || "note";
}


function assignIds(filesArray, idMap, seenIds) {
    // First pass: assign a stable local id to every noteId in the tree.
    for (const entry of filesArray) {
        const noteId = entry.noteId;
        if (noteId == null) continue; // noImport scaffold entry
        if (!(noteId in idMap)) {
            idMap[noteId] = uniqueName(slugify(entry.title || "note"), seenIds);
        }
        assignIds(entry.children || [], idMap, seenIds);
    }
}


function* walkEntries(filesArray, parentLocalId, idMap, dirPrefix = "") {
    // Second pass: yield [entry, localId, parentLocalId, isClone, dirPrefix] in tree order.
    for (const entry of filesArray) {
        const noteId = entry.noteId;
        if (noteId == null) continue;
        const localId = idMap[noteId];
        yield [entry, localId, parentLocalId, Boolean(entry.isClone), dirPrefix];
        const childPrefix = entry.dirFileName ? dirPrefix + entry.dirFileName + "/" : dirPrefix;
        yield* walkEntries(entry.children || [], localId, idMap, childPrefix);
    }
}


function cmdZipToTam(args) {
    const inputPath = args.input;
    const outDir = args.out;
    if (!exists(inputPath)) {
        die(`ERROR: ${inputPath} not found`);
    }
    fs.mkdirSync(outDir, { recursive: true });

    const tmppath = fs.mkdtempSync(path.join(os.tmpdir(), "ziptotam-"));
    try {
        const extracted = extractZip(inputPath, tmppath);

        const metaFiles = Object.keys(extracted).filter((p) => path.basename(p) === "!!!meta.json").sort();
        if (!metaFiles.length) {
            die("ERROR: no !!!meta.json found in ZIP");
        }
        const metaFile = metaFiles[0];
        const metaRoot = path.dirname(metaFile);
        const meta = JSON.parse(extracted[metaFile].toString("utf8"));

        const filesArray = (meta.files || []).filter((f) => !f.noImport);
        if (!filesArray.length) {
            die("ERROR: !!!meta.json has no 'files' array");
        }

        const idMap = {}, seenIds = new Set();
        assignIds(filesArray, idMap, seenIds);
        const rootLocalId = idMap[filesArray[0].noteId];

        const notes = [], children = [], relations = [], labels = [];
        const usedFilenames = new Set();

        const byBasename = {};
        for (const p of Object.keys(extracted)) {
            (byBasename[path.basename(p)] ||= []).push(p);
        }
        const metaPrefix = (metaRoot && metaRoot !== ".") ? metaRoot + "/" : "";

        for (const [entry, localId, parentLocalId, isClone, dirPrefix] of walkEntries(filesArray, null, idMap)) {
            // The ZIP's own top-level note becomes the reserved "root" parent keyword instead
            // of a real notes[] entry -- TAM synthesizes this note itself for every addon but
            // TAM (see lib-tam.js's ensureAddonAnchor). Rewrite its direct children's parent to
            // "root" and drop the note itself (and any labels/relations declared on it).
            const effectiveParentLocalId = parentLocalId === rootLocalId ? "root" : parentLocalId;
            if (localId === rootLocalId) continue;

            if (isClone) {
                if (effectiveParentLocalId) {
                    children.push({ parent: effectiveParentLocalId, child: localId });
                }
                continue;
            }

            const noteType = entry.type || "text";
            const dataFile = entry.dataFileName;

            let sourceUrl = null;
            if (dataFile && !dataFile.endsWith(".clone.html")) {
                let dataKey = metaPrefix + dirPrefix + dataFile;
                if (!(dataKey in extracted)) {
                    const flat = metaPrefix + dataFile;
                    dataKey = (flat in extracted) ? flat
                        : ((byBasename[path.basename(dataFile)] || [])[0] || null);
                }
                if (dataKey && dataKey in extracted) {
                    const destName = uniqueName(dataFile, usedFilenames);
                    fs.writeFileSync(path.join(outDir, destName), extracted[dataKey]);
                    // Relative to the manifest, the way a source manifest names every file.
                    sourceUrl = destName;
                }
            }

            const mime = entry.mime ||
                (dataFile ? (EXT_TO_MIME[suffixOf(dataFile).toLowerCase()] || "text/plain") : "text/html");
            const note = {
                id: localId, title: entry.title || localId,
                type: noteType, mime, sourceUrl,
            };
            if (noteType === "file") note.binary = true;

            // An attachment's data file is a sibling of its owner note's, named by
            // the exporter rather than after the attachment alone, so it is looked
            // up by the dataFileName the meta gives it.
            const attachments = [];
            for (const att of entry.attachments || []) {
                let attKey = metaPrefix + dirPrefix + att.dataFileName;
                if (!(attKey in extracted)) {
                    attKey = (byBasename[path.basename(att.dataFileName || "")] || [])[0] || null;
                }
                if (!attKey || !(attKey in extracted)) {
                    console.log(`WARNING: attachment '${att.title}' of note '${localId}' has no data file in the ZIP -- skipped`);
                    continue;
                }
                const destName = uniqueName(att.title, usedFilenames);
                fs.writeFileSync(path.join(outDir, destName), extracted[attKey]);
                attachments.push({
                    title: att.title, role: att.role || "file",
                    mime: att.mime, sourceUrl: destName,
                });
            }
            if (attachments.length) note.attachments = attachments;
            notes.push(note);

            if (effectiveParentLocalId) {
                children.push({ parent: effectiveParentLocalId, child: localId });
            }

            for (const attr of entry.attributes || []) {
                if (attr.type === "label") {
                    labels.push({ note: localId, name: attr.name || "", value: attr.value || "" });
                } else if (attr.type === "relation") {
                    relations.push({
                        from: localId, type: attr.name || "",
                        to: idMap[attr.value] ?? (attr.value || ""),
                    });
                }
            }
        }

        const manifest = {
            id: "FILL_IN", name: "FILL_IN", description: "FILL_IN",
            author: "FILL_IN", homepage: "FILL_IN", license: "GPL-3.0-or-later",
            latestVersion: "1.0.0", type: "widget", readme: "README.md",
            manifest: {
                notes, children, relations, labels,
            },
        };
        const outputFile = path.join(outDir, MANIFEST_NAME);
        writeText(outputFile, jsonDumps(manifest, 2));

        console.log(`Written: ${outputFile}`);
        console.log(`  ${notes.length} notes, ${children.length} children, ${relations.length} relations, ${labels.length} labels`);
        console.log("  Search for '\"FILL_IN\"' in _tam_manifest_.json and replace with real values");
    } finally {
        fs.rmSync(tmppath, { recursive: true, force: true });
    }
}


// ===========================================================================
// generate-pages / generate-readme (shared addon rendering)
// ===========================================================================

let renderMd;
try {
    const { marked } = require("marked");
    marked.setOptions({ gfm: true });
    // Match python-markdown's `toc` extension: every heading gets an id slug
    // (lowercase, non-word/space/hyphen stripped, spaces -> '-') so in-README
    // anchor links keep working. Uniquified per document, as toc does. Done as
    // an output post-pass -- marked v12's object-literal renderer override
    // doesn't get `this.parser` bound, so building the id inline isn't reliable.
    const slugify = (headingHtml, seen) => {
        const plain = headingHtml.replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        let slug = plain.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
        if (!slug) slug = "section";
        if (seen.has(slug)) {
            const n = seen.get(slug) + 1;
            seen.set(slug, n);
            return `${slug}_${n}`;
        }
        seen.set(slug, 0);
        return slug;
    };
    renderMd = (text) => {
        const seen = new Map();
        return marked.parse(text).replace(
            /<h([1-6])>([\s\S]*?)<\/h\1>/g,
            (_, level, inner) => `<h${level} id="${slugify(inner, seen)}">${inner}</h${level}>`
        );
    };
} catch {
    renderMd = (text) => `<pre>${text}</pre>`;
}

const REPO = "https://github.com/Trilium-Community/trilium-scripts";
const RELEASES = `${REPO}/releases/latest`;
const PAGES_URL = "https://trilium-community.github.io/trilium-scripts/";
const CATALOG_NAME = "catalog.json";
const CATALOG_URL = `${PAGES_URL}${CATALOG_NAME}`;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);


function badge(t) {
    return `<span class="badge" style="background:${TYPE_COLORS[t] || "#6b7280"}">${htmlEscape(t)}</span>`;
}


function page(baseHtml, title, body, css = "style.css") {
    return baseHtml
        .split("{{TITLE}}").join(htmlEscape(title))
        .split("{{CSS}}").join(css)
        .split("{{BODY}}").join(body)
        .split("{{REPO}}").join(REPO);
}


function renderIndex(baseHtml, addons) {
    const typesPresent = [...new Set(addons.map((a) => a.meta.type).filter(Boolean))].sort();

    const cards = [];
    for (const a of addons) {
        const m = a.meta;
        const aid = m.id, t = m.type || "";
        const name = m.name || aid, desc = m.description || "";
        const author = m.author || "", version = m.latestVersion || "";
        cards.push(`  <a class="card" href="${htmlEscape(aid)}/" data-type="${htmlEscape(t)}" data-name="${htmlEscape(name.toLowerCase())}" data-desc="${htmlEscape(desc.toLowerCase())}">
    <div class="card-top">
      <span class="card-name">${htmlEscape(name)}</span>
      ${badge(t)}
    </div>
    <p class="card-desc">${htmlEscape(desc)}</p>
    <div class="card-foot">
      <span>v${htmlEscape(version)}</span>
      <span class="card-author" data-author="${htmlEscape(author)}">${htmlEscape(author)}</span>
    </div>
  </a>`);
    }

    const filterBtns = ['<button class="filter active" data-type="all" style="--c:#2563eb">All</button>'];
    for (const t of typesPresent) {
        const color = TYPE_COLORS[t] || "#2563eb";
        const title = t.charAt(0).toUpperCase() + t.slice(1);
        filterBtns.push(`<button class="filter" data-type="${t}" style="--c:${color}">${title}</button>`);
    }

    const body = `<header>
  <div class="hdr">
    <div class="hdr-left">
      <h1>Trilium Addons</h1>
      <p>${addons.length} addons for <a href="https://github.com/TriliumNext/Notes" target="_blank">TriliumNext Notes</a></p>
    </div>
    <div class="hdr-right">
      <div class="tam-box">
        <span class="tam-label">Add as a Trilium Addon Manager catalog</span>
        <code class="tam-url">${CATALOG_URL}</code>
      </div>
      <div class="hdr-links">
        <a href="${REPO}" target="_blank">GitHub</a>
        <a href="${RELEASES}" target="_blank">Releases</a>
      </div>
    </div>
  </div>
</header>
<main>
  <div class="toolbar">
    <div class="search-wrap">
      <input type="search" id="search" placeholder="Search addons…" autocomplete="off" spellcheck="false">
    </div>
    <div class="filters">
      ${filterBtns.join(" ")}
    </div>
  </div>
  <div class="grid">
${cards.join("\n")}
  </div>
</main>
<script>
(function() {
  var s = document.getElementById('search');
  var btns = document.querySelectorAll('.filter');
  var cards = document.querySelectorAll('.card');
  var activeType = 'all';
  function run() {
    var q = s.value.trim().toLowerCase();
    cards.forEach(function(c) {
      var ok = (activeType === 'all' || c.dataset.type === activeType) &&
               (!q || c.dataset.name.includes(q) || c.dataset.desc.includes(q));
      c.style.display = ok ? '' : 'none';
    });
  }
  s.addEventListener('input', run);
  btns.forEach(function(b) {
    b.addEventListener('click', function() {
      btns.forEach(function(x) { x.classList.remove('active'); });
      b.classList.add('active');
      activeType = b.dataset.type;
      run();
    });
  });
  document.querySelectorAll('.card-author').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      window.open('https://github.com/' + el.dataset.author, '_blank');
    });
  });
})();
</script>`;
    return page(baseHtml, "Trilium Addons — Trilium Community", body);
}


function renderAddon(baseHtml, meta, readmeHtml, changelogHtml) {
    const aid = meta.id;
    const name = meta.name || aid;
    const version = meta.latestVersion || "—";
    const author = meta.author || "—";
    const lic = meta.license || "—";
    const t = meta.type || "";
    const hp = meta.homepage || "";
    const zipUrl = `${RELEASES}/download/${aid}.zip`;
    const manifestUrl = aid ? publishedManifestUrl(aid) : "";

    const authorDisplay = (author && author !== "—")
        ? `<a href="https://github.com/${htmlEscape(author)}" target="_blank">${htmlEscape(author)}</a>`
        : htmlEscape(author);

    const rows = [
        ["ID", `<code>${htmlEscape(aid)}</code>`],
        ["Version", htmlEscape(version)],
        ["Author", authorDisplay],
        ["License", htmlEscape(lic)],
        ["Type", htmlEscape(t)],
    ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");

    let actions = `<a class="btn" href="${htmlEscape(zipUrl)}">Download ZIP</a>`;
    if (manifestUrl) {
        actions += `\n      <a class="btn btn-ghost" href="${htmlEscape(manifestUrl)}" target="_blank">View Manifest</a>`;
    }
    if (hp) {
        actions += `\n      <a class="btn btn-ghost" href="${htmlEscape(hp)}" target="_blank">Source</a>`;
    }

    const content = readmeHtml
        ? `<div class="readme">${readmeHtml}</div>`
        : '<p class="no-readme">No README available.</p>';

    // Collapsed by default: the README is what a visitor came for, the changelog
    // is what they check afterwards.
    const changelog = changelogHtml
        ? `\n      <details class="changelog"><summary>Changelog</summary><div class="readme">${changelogHtml}</div></details>`
        : "";

    const body = `<header>
  <div class="hdr">
    <a class="back" href="../">← All Addons</a>
    <div class="hdr-name">
      <h1>${htmlEscape(name)}</h1>
      ${badge(t)}
    </div>
  </div>
</header>
<main>
  <div class="addon-layout">
    <aside class="addon-sidebar">
      <table class="meta-table">${rows}</table>
      <div class="addon-actions">
      ${actions}
      </div>
    </aside>
    <div class="addon-content">
      ${content}${changelog}
    </div>
  </div>
</main>`;
    return page(baseHtml, `${name} — Trilium Addons`, body, "../style.css");
}


function cmdGeneratePages(args) {
    const staticDir = path.join(path.dirname(path.dirname(path.resolve(__filename))), "static", "pages");
    const baseHtml = readText(path.join(staticDir, "base.html"));
    const css = readText(path.join(staticDir, "style.css"));

    const docsDir = path.join("resources", "docs");
    fs.mkdirSync(docsDir, { recursive: true });

    const addons = loadAddons();

    for (const a of addons) {
        const aid = a.meta.id;
        const pageDir = path.join(docsDir, aid);
        fs.mkdirSync(pageDir, { recursive: true });
        for (const f of fs.readdirSync(a.outerDir)) {
            const full = path.join(a.outerDir, f);
            if (fs.statSync(full).isFile() && IMAGE_EXTS.has(suffixOf(f).toLowerCase())) {
                fs.copyFileSync(full, path.join(pageDir, f));
            }
        }
        writeText(path.join(pageDir, "index.html"), renderAddon(baseHtml, a.meta, a.readmeHtml, a.changelogHtml));
    }

    writeText(path.join(docsDir, "index.html"), renderIndex(baseHtml, addons));
    writeText(path.join(docsDir, "style.css"), css);
    console.log(`Generated ${docsDir}/ for ${addons.length} addons`);
}


const README_START = "<!-- GENERATED:START -->";
const README_END = "<!-- GENERATED:END -->";


function cmdGenerateReadme(args) {
    const basePath = path.join("resources", "README_base.md");
    if (!exists(basePath)) {
        console.log(`WARNING: ${basePath} not found -- skipping README generation`);
        return;
    }
    const base = readText(basePath);

    const addons = loadAddons();
    const sorted = [...addons].sort((a, b) =>
        (a.meta.name || a.meta.id).toLowerCase().localeCompare((b.meta.name || b.meta.id).toLowerCase()));
    const rows = [];
    for (const a of sorted) {
        const m = a.meta;
        const name = m.name || m.id;
        const t = m.type || "";
        // Escape raw HTML (GitHub embeds it) and markdown table pipes.
        const desc = htmlEscape((m.description || "").split("\n")[0]).replace(/\|/g, "\\|");
        const ver = m.latestVersion || "";
        rows.push(`| [${name}](addons/${path.basename(a.outerDir)}/) | ${t} | ${desc} | ${ver} |`);
    }

    const table = [
        "| Name | Type | Description | Version |",
        "|------|------|-------------|---------|",
        ...rows,
    ].join("\n");

    const startIdx = base.indexOf(README_START), endIdx = base.indexOf(README_END);
    if (startIdx === -1 || endIdx === -1) {
        console.log(`WARNING: ${basePath} missing GENERATED markers -- skipping README generation`);
        return;
    }
    const afterStart = startIdx + README_START.length;
    writeText("README.md", base.slice(0, afterStart) + "\n" + table + "\n" + base.slice(endIdx));
    console.log(`Generated README.md with ${rows.length} addons`);
}


// ===========================================================================
// publish-release
// ===========================================================================

function resolveCommit(repoRoot, ref) {
    // A push event's "before" is all zeroes for a new branch, and a tag that was
    // never fetched does not resolve -- either way there is nothing to diff against.
    if (!ref || /^0+$/.test(ref)) return null;
    return runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot);
}


function publishBaseCommit(repoRoot, args) {
    // What this release is compared against, best first: an explicit --since, the
    // commit the push started from, the last publish's tag, then the previous commit.
    const previousTag = runGit(["describe", "--tags", "--abbrev=0", "--match", "publish-*", "HEAD"], repoRoot);
    for (const ref of [args.since, process.env.GITHUB_EVENT_BEFORE, previousTag, "HEAD~1"]) {
        const commit = resolveCommit(repoRoot, ref);
        if (commit) return commit;
    }
    return null;
}


/* Release notes are the changelog entries of the addons this push actually
 * touched, so the release says what changed rather than only which commit it came
 * from. Everything here degrades to the bare commit line: a shallow CI clone has
 * no base commit to diff against, and an addon may carry no changelog at all.
 */
function releaseNotes(repoRoot, sha, args) {
    const header = `Auto-published from \`${sha}\``;
    const base = publishBaseCommit(repoRoot, args);
    if (!base) return header;

    const addonsDir = args.addonsDir || "addons";
    const changed = new Set((runGit(["diff", "--name-only", `${base}..HEAD`, "--", addonsDir], repoRoot) || "")
        .split("\n").filter(Boolean).map((file) => file.split("/").slice(0, 2).join("/")));

    const sections = [];
    for (const dir of [...changed].sort()) {
        const manifestFile = path.join(repoRoot, dir, MANIFEST_NAME);
        if (!exists(manifestFile)) continue;
        const manifest = JSON.parse(readText(manifestFile));
        if (!manifest.id) continue;
        const changelogFile = manifest.changelog ? path.join(repoRoot, dir, manifest.changelog) : null;
        const section = (changelogFile && exists(changelogFile))
            ? changelogSection(readText(changelogFile), manifest.latestVersion)
            : null;
        // The entry's own "## <version>" heading carries the addon's name here.
        sections.push(section
            ? `## ${manifest.id} ${section.replace(/^##\s+/, "")}`
            : `## ${manifest.id} ${manifest.latestVersion || ""}`.trim());
    }
    return sections.length ? `${header}\n\n${sections.join("\n\n")}` : header;
}


function cmdPublishRelease(args) {
    const sha = process.env.GITHUB_SHA || "unknown";
    const runNumber = process.env.GITHUB_RUN_NUMBER || "0";

    // The catalog ships beside the ZIPs so its URL survives an owner change:
    // github.com redirects a moved release, a *.github.io Pages path does not.
    const files = fs.readdirSync(".").filter((f) => f.endsWith(".zip") || f === CATALOG_NAME).sort();
    if (!files.length) {
        die("No *.zip files found to upload");
    }

    const repoRoot = path.resolve(runGit(["rev-parse", "--show-toplevel"], ".") || ".");
    const notes = releaseNotes(repoRoot, sha, args);

    function publishTo(tag, title, latest) {
        // `create` fails whenever the release already exists — always true for the
        // floating `latest` tag after the first publish, and true for
        // `publish-<run>` on a re-run. That is expected, so its failure is not
        // fatal; but every *other* create failure (bad token, missing permission)
        // must not fall through to `upload`, which would then fail with the far
        // more confusing "release not found". So: tolerate the already-exists
        // case by confirming the release is really there, and surface anything
        // else with the actual stderr rather than discarding it.
        const created = spawnSync("gh", [
            "release", "create", tag, "--title", title, "--notes", notes,
            ...(latest ? ["--latest"] : []),
        ], { encoding: "utf8" });

        if (created.status !== 0) {
            const view = spawnSync("gh", ["release", "view", tag], { stdio: "ignore" });
            if (view.status !== 0) {
                process.stderr.write(created.stderr || "");
                die(`Could not create or find release '${tag}'`);
            }
        }

        const r = spawnSync("gh", ["release", "upload", tag, ...files, "--clobber"], { stdio: "inherit" });
        if (r.status !== 0) process.exit(r.status || 1);
    }

    // A permanently-addressable release for this exact publish (older-version
    // path), plus the floating 'latest' alias every "download current" link uses.
    publishTo(`publish-${runNumber}`, `Publish ${runNumber}`, false);
    publishTo("latest", "Latest", true);
}


// ===========================================================================
// publish
// ===========================================================================

/*
 * Turns each hand-authored source manifest into the published one TAM actually
 * installs from.
 *
 * A source manifest names its files by path relative to itself and carries no
 * URLs of its own; publishing resolves each of those against one commit
 * (raw.githubusercontent.com/<owner>/<repo>/<sha>/...), so a published URL is
 * immutable and never serves a stale cached copy the way a refs/heads/main one
 * does. It also hashes every file, per note and once for the manifest as a
 * whole, which is what lets TAM detect a change without an author bumping
 * latestVersion.
 *
 * Deliberately offline: only files on disk are hashed. A sourceUrl already
 * absolute in the source manifest points at someone else's repo, so it is
 * carried through untouched and contributes its URL (not its content) to the
 * hash -- fetching it here would make the same commit publish differently
 * depending on what upstream did that day.
 */

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}


function canonicalJson(value) {
    // Key-order-independent serialization, so the hash tracks the manifest's
    // content rather than the order its keys happen to be written in.
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
}


function publishedManifestUrl(addonId) {
    return `${PAGES_URL}${addonId}/${MANIFEST_NAME}`;
}


function resolvePublishBase(args) {
    // The raw.githubusercontent prefix every relative sourceUrl resolves against,
    // pinned to one commit: --commit, else CI's GITHUB_SHA, else HEAD.
    const repoRoot = path.resolve(runGit(["rev-parse", "--show-toplevel"], ".") || die("ERROR: publish must run inside a git working copy"));
    const remoteUrl = runGit(["remote", "get-url", "origin"], repoRoot);
    const match = remoteUrl && GITHUB_REMOTE_RE.exec(remoteUrl);
    if (!match) die("ERROR: publish needs a github.com 'origin' remote to build source URLs from");
    const commit = args.commit || process.env.GITHUB_SHA || runGit(["rev-parse", "HEAD"], repoRoot);
    if (!commit) die("ERROR: could not determine the commit to pin published URLs to");
    // The branch-tracking URL of the same file, which every note also carries as
    // its `sourceId`: TAM shares one note between addons vendoring the same file
    // by matching on it, and a commit-pinned URL changes every publish, so it
    // can't be what that match is made on.
    const branch = process.env.GITHUB_REF_NAME || runGit(["symbolic-ref", "--short", "HEAD"], repoRoot) || "main";
    return {
        repoRoot,
        commit,
        baseUrl: `https://raw.githubusercontent.com/${match[1]}/${commit}/`,
        identityBaseUrl: `https://raw.githubusercontent.com/${match[1]}/refs/heads/${branch}/`
    };
}


function publishManifest(manifest, manifestFile, repoRoot, baseUrl, identityBaseUrl) {
    // Returns the published manifest: absolute pinned sourceUrls, a sha per note
    // whose file is in this repo, and one contentHash over the whole thing.
    const published = JSON.parse(JSON.stringify(manifest));
    published.manifestSourceUrl = publishedManifestUrl(published.id);
    const addonDir = path.dirname(manifestFile);
    const hashInput = JSON.parse(JSON.stringify(published));
    delete hashInput.manifestSourceUrl;
    delete hashInput.contentHash;

    // The changelog is pinned like a note's file, but stays out of the hash: it
    // is rewritten from history on every commit that touches the addon, and an
    // update the user is offered should mean the installed notes changed.
    if (published.changelog && !/^https?:\/\//.test(published.changelog)) {
        const changelogFile = path.join(addonDir, published.changelog);
        if (!exists(changelogFile)) die(`ERROR: ${manifestFile}: 'changelog' points at missing file ${published.changelog}`);
        published.changelog = baseUrl + encodeURI(repoRelative(repoRoot, changelogFile));
    }
    delete hashInput.changelog;

    const notes = published.manifest?.notes || [];
    const hashNotes = hashInput.manifest?.notes || [];

    function pin(target, hashTarget, describe, withIdentity) {
        if (!target.sourceUrl) return;
        if (/^https?:\/\//.test(target.sourceUrl)) return;
        const filePath = path.join(addonDir, target.sourceUrl);
        if (!exists(filePath)) die(`ERROR: ${manifestFile}: ${describe} points at missing file ${target.sourceUrl}`);
        const relativeToRepo = path.relative(repoRoot, path.resolve(filePath)).split(path.sep).join("/");
        // encodeURI, not encodeURIComponent: a literal "@" in an addon dir name
        // is legal in a path and is what every already-installed note carries as
        // its #TAMSOURCEURL, which sourceId has to keep matching.
        const encodedPath = encodeURI(relativeToRepo);
        target.sha = sha256(fs.readFileSync(filePath));
        target.sourceUrl = baseUrl + encodedPath;
        // Only a note carries a sourceId -- it is what two addons vendoring one
        // file are matched on, and an attachment belongs to exactly one note.
        if (withIdentity) target.sourceId = identityBaseUrl + encodedPath;
        // The pinned URL changes on every commit, so hashing it would report an
        // update for every addon on every push; the file's own hash is what a
        // change actually means.
        hashTarget.sourceUrl = target.sha;
        hashTarget.sha = target.sha;
        delete hashTarget.sourceId;
    }

    for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        pin(note, hashNotes[i], `note '${note.id}'`, true);
        const attachments = note.attachments || [];
        for (let j = 0; j < attachments.length; j++) {
            pin(attachments[j], hashNotes[i].attachments[j], `note '${note.id}' attachment '${attachments[j].title}'`, false);
        }
    }
    published.contentHash = sha256(Buffer.from(canonicalJson(hashInput), "utf8"));
    return published;
}


function cmdPublish(args) {
    const addonsDir = args.addonsDir || "addons";
    const outDir = args.outDir || path.join("resources", "docs");
    const { repoRoot, baseUrl, identityBaseUrl, commit } = resolvePublishBase(args);

    const urls = [];
    let count = 0;
    for (const manifestFile of iterManifests(addonsDir)) {
        const manifest = JSON.parse(readText(manifestFile));
        if (!manifest.id) continue;
        const published = publishManifest(manifest, manifestFile, repoRoot, baseUrl, identityBaseUrl);
        const pageDir = path.join(outDir, manifest.id);
        fs.mkdirSync(pageDir, { recursive: true });
        writeText(path.join(pageDir, MANIFEST_NAME), jsonDumps(published, 4) + "\n");
        urls.push(published.manifestSourceUrl);
        count++;
    }

    writeText(path.join(outDir, CATALOG_NAME),
        jsonDumps({ webUrl: PAGES_URL, "tam-addons": urls }, 2) + "\n");
    console.log(`Published ${count} manifest(s) to ${outDir}/ pinned at ${commit.slice(0, 12)}`);
}


// ===========================================================================
// Minimal ZIP reader/writer (stdlib zlib only, no npm dependency)
// ===========================================================================

const zlib = require("zlib");

// CRC-32 table
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}


function writeZip(outPath, entries) {
    // entries: [ [name, Buffer], ... ]. Deflate-compressed, matching what
    // Trilium's importer expects (Python used ZIP_DEFLATED).
    const localParts = [];
    const central = [];
    let offset = 0;

    for (const [name, contentRaw] of entries) {
        const content = Buffer.isBuffer(contentRaw) ? contentRaw : Buffer.from(contentRaw);
        const nameBuf = Buffer.from(name, "utf8");
        const crc = crc32(content);
        const compressed = zlib.deflateRawSync(content);
        const useStore = compressed.length >= content.length;
        const method = useStore ? 0 : 8;
        const data = useStore ? content : compressed;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);          // version needed
        local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 filenames
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);          // mod time
        local.writeUInt16LE(0x21, 12);       // mod date
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);          // extra len

        localParts.push(local, nameBuf, data);

        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);            // version made by
        cen.writeUInt16LE(20, 6);            // version needed
        cen.writeUInt16LE(0x0800, 8);        // flags
        cen.writeUInt16LE(method, 10);
        cen.writeUInt16LE(0, 12);            // mod time
        cen.writeUInt16LE(0x21, 14);         // mod date
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(data.length, 20);
        cen.writeUInt32LE(content.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt16LE(0, 30);            // extra len
        cen.writeUInt16LE(0, 32);            // comment len
        cen.writeUInt16LE(0, 34);            // disk number
        cen.writeUInt16LE(0, 36);            // internal attrs
        cen.writeUInt32LE(0, 38);            // external attrs
        cen.writeUInt32LE(offset, 42);       // local header offset
        central.push(Buffer.concat([cen, nameBuf]));

        offset += local.length + nameBuf.length + data.length;
    }

    const centralBuf = Buffer.concat(central);
    const localBuf = Buffer.concat(localParts);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);
    eocd.writeUInt16LE(0, 20);

    fs.writeFileSync(outPath, Buffer.concat([localBuf, centralBuf, eocd]));
}


function extractZip(zipPath, destDir) {
    // Returns { "posix/rel/path": Buffer } for every file entry, and also
    // writes nothing to disk beyond destDir tracking (kept in-memory). The
    // returned keys are relative to destDir using forward slashes, matching
    // how the caller builds metaRoot-based lookups.
    const buf = fs.readFileSync(zipPath);
    const result = {};

    // Locate End Of Central Directory record (search from the end).
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) die(`ERROR: ${zipPath} is not a valid ZIP (no EOCD)`);

    const total = buf.readUInt16LE(eocd + 10);
    let ptr = buf.readUInt32LE(eocd + 16); // central dir offset

    for (let n = 0; n < total; n++) {
        if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
        const method = buf.readUInt16LE(ptr + 10);
        const compSize = buf.readUInt32LE(ptr + 20);
        const nameLen = buf.readUInt16LE(ptr + 28);
        const extraLen = buf.readUInt16LE(ptr + 30);
        const commentLen = buf.readUInt16LE(ptr + 32);
        const localOffset = buf.readUInt32LE(ptr + 42);
        const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
        ptr += 46 + nameLen + extraLen + commentLen;

        if (name.endsWith("/")) continue; // directory entry

        // Read the local header to find where the data starts.
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const compData = buf.subarray(dataStart, dataStart + compSize);
        const content = method === 0 ? Buffer.from(compData) : zlib.inflateRawSync(compData);

        result[name] = content;
    }
    return result;
}


// ===========================================================================
// bump-halon
// ===========================================================================

/* The Halon theme's stylesheet lives in its own repository, so halon@beatlink
 * vendors no copy: its stylesheet note points at a raw URL pinned to one Halon
 * commit, which `publish` carries through untouched the way it does any URL into
 * someone else's repo. The pin is also what makes an update visible -- a published
 * manifest hashes an absolute sourceUrl by its URL rather than by its content, so
 * moving the pin is what tells TAM there is something new to fetch, and leaving it
 * on a branch name would mean TAM never reported one.
 */

const HALON_REPO = "BeatLink/Halon";
const HALON_FILE = "trilium/halon.css";
const HALON_MANIFEST = "addons/halon@beatlink/_tam_manifest_.json";
const HALON_URL_RE = new RegExp(`^https://raw\\.githubusercontent\\.com/${HALON_REPO}/([0-9a-f]{40})/${HALON_FILE}$`);


function halonPinnedNote(manifest) {
    const note = (manifest.manifest?.notes || []).find((n) => HALON_URL_RE.test(n.sourceUrl || ""));
    if (!note) die(`ERROR: ${HALON_MANIFEST}: no note carries a commit-pinned ${HALON_REPO} sourceUrl`);
    return note;
}


async function cmdBumpHalon(args) {
    if (!exists(HALON_MANIFEST)) die(`ERROR: ${HALON_MANIFEST} not found -- run from the repo root`);
    const manifest = JSON.parse(readText(HALON_MANIFEST));
    const note = halonPinnedNote(manifest);
    const current = HALON_URL_RE.exec(note.sourceUrl)[1];

    const head = runGit(["ls-remote", `https://github.com/${HALON_REPO}`, "refs/heads/main"]);
    const latest = head && head.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(latest || "")) die(`ERROR: could not resolve ${HALON_REPO}'s main branch`);

    if (current === latest) {
        console.log(`halon@beatlink is pinned to ${latest.slice(0, 7)}, ${HALON_REPO}'s current main.`);
        return;
    }

    // Halon commits for its own reasons, and most of them leave this file alone.
    // The pin is compared by content rather than by commit so that a bump means
    // the stylesheet actually changed -- moving it for an untouched file would
    // report an update to every installation and hand them the same bytes back.
    // Fetching also proves the new commit serves the file at all: a pin at a
    // commit that does not carry it installs an empty note.
    const url = `https://raw.githubusercontent.com/${HALON_REPO}/${latest}/${HALON_FILE}`;
    const [pinnedBytes, latestBytes] = await Promise.all([fetchBuffer(note.sourceUrl), fetchBuffer(url)]);

    if (pinnedBytes.equals(latestBytes)) {
        console.log(`${HALON_REPO} has moved to ${latest.slice(0, 7)}, but ${HALON_FILE} is unchanged -- pin left at ${current.slice(0, 7)}.`);
        return;
    }

    if (args.check) {
        console.error(`${HALON_MANIFEST}: ${HALON_FILE} changed between ${current.slice(0, 7)} and ${latest.slice(0, 7)}`);
        console.error("  run: node resources/scripts/tamhelper.js bump-halon");
        process.exit(1);
    }

    note.sourceUrl = url;
    writeText(HALON_MANIFEST, jsonDumps(manifest, 4) + "\n");
    console.log(`halon@beatlink: ${current.slice(0, 7)} -> ${latest.slice(0, 7)}`);
}


// ===========================================================================
// changelog
// ===========================================================================

/* An addon's CHANGELOG.md is derived from the commits that touched its own
 * directory, grouped under whichever `latestVersion` its manifest carried at the
 * time. Conventional Commit subjects are what make that readable, so a commit
 * message stays the only place a change is written down.
 *
 * A file carrying the marker below was written by this command and is rewritten
 * in place; one without it was hand-authored and is left alone, which is the
 * escape hatch for an addon whose history does not tell the story well.
 *
 * The changelog is metadata beside the manifest, not a note in the addon's tree:
 * `publish` pins its URL the way it pins a note's, TAM fetches it for the detail
 * view, and nothing about it is installed.
 */

const CHANGELOG_NAME = "CHANGELOG.md";
const CHANGELOG_MARKER = "<!-- Generated by `tamhelper.js changelog` from this addon's git history. Delete this line to hand-author it instead. -->";
const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
// Housekeeping that says nothing about the addon as installed.
const SKIPPED_COMMIT_TYPES = new Set(["chore", "ci", "test", "style", "build"]);
const SECTION_ORDER = ["Added", "Changed", "Fixed"];


function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function changelogEntry(subject, body) {
    // One bullet from one commit, or null when the commit is pure housekeeping.
    const match = CONVENTIONAL_RE.exec(subject);
    const type = match ? match[1] : "";
    if (SKIPPED_COMMIT_TYPES.has(type)) return null;
    const description = match ? match[4] : subject;
    const breaking = !!(match && match[3]) || /^BREAKING[ -]CHANGE:/m.test(body);
    const section = type === "feat" ? "Added" : type === "fix" ? "Fixed" : "Changed";
    return { section, text: breaking ? `**Breaking:** ${description}` : description };
}


function addonCommits(repoRoot, addonPath) {
    // Every commit that touched this addon's directory, oldest first. A directory
    // rename is where its history stops: --follow only works on a single file.
    const out = runGit(["log", "--reverse", "--format=%H%x00%aI%x00%s%x00%b%x1e", "--", addonPath], repoRoot);
    if (out === null) die("ERROR: changelog could not read git history");
    return out.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
        const [hash, date, subject, body] = record.split("\x00");
        return { hash, date, subject, body: body || "" };
    });
}


function versionAtCommits(repoRoot, manifestPath, commits) {
    // The version each commit shipped under: read out of the manifest at every
    // commit that touched it, and inherited by every commit that did not.
    const touched = new Set((runGit(["log", "--format=%H", "--", manifestPath], repoRoot) || "").split("\n").filter(Boolean));
    const versions = [];
    let current = null;
    for (const commit of commits) {
        if (touched.has(commit.hash)) {
            try {
                current = JSON.parse(runGit(["show", `${commit.hash}:${manifestPath}`], repoRoot)).latestVersion || current;
            } catch {
                // The manifest was absent or unparseable at that commit.
            }
        }
        versions.push(current);
    }
    // Anything predating the first manifest is credited to the version it arrived at.
    const first = versions.find(Boolean) || null;
    return versions.map((version) => version || first);
}


function changelogGroups(repoRoot, addonPath, manifestPath) {
    // One group per version, newest first, each holding deduplicated bullets.
    const commits = addonCommits(repoRoot, addonPath);
    const versions = versionAtCommits(repoRoot, manifestPath, commits);
    const groups = new Map();
    commits.forEach((commit, index) => {
        const version = versions[index];
        const entry = changelogEntry(commit.subject, commit.body);
        if (!version || !entry) return;
        if (!groups.has(version)) groups.set(version, { version, date: "", sections: new Map() });
        const group = groups.get(version);
        // Commits arrive oldest first, so the last one to land sets the date.
        group.date = commit.date.slice(0, 10);
        const texts = group.sections.get(entry.section) || [];
        if (!texts.includes(entry.text)) texts.push(entry.text);
        group.sections.set(entry.section, texts);
    });
    return [...groups.values()].reverse();
}


function renderChangelog(name, groups) {
    const lines = [`# ${name} Changelog`, "", CHANGELOG_MARKER, ""];
    for (const group of groups) {
        lines.push(`## ${group.version} - ${group.date}`, "");
        for (const section of SECTION_ORDER) {
            const texts = group.sections.get(section);
            if (!texts) continue;
            lines.push(`### ${section}`, "");
            for (const text of texts) lines.push(`- ${text}`);
            lines.push("");
        }
    }
    return lines.join("\n");
}


function changelogSection(text, version) {
    // The one version's block out of a changelog, heading included.
    const start = new RegExp(`^##\\s+v?${escapeRegExp(version)}\\b`, "m").exec(text);
    if (!start) return null;
    const rest = text.slice(start.index);
    const next = /\n##\s/.exec(rest.slice(1));
    return (next ? rest.slice(0, next.index + 1) : rest).trim();
}


function insertKeyAfter(obj, afterKey, key, value) {
    // Keeps a manifest's field order readable: JSON.stringify writes keys in
    // insertion order, so a new field appended at the end would land past `manifest`.
    if (key in obj) {
        obj[key] = value;
        return obj;
    }
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        out[k] = v;
        if (k === afterKey) out[key] = value;
    }
    if (!(key in out)) out[key] = value;
    return out;
}


function repoRelative(repoRoot, target) {
    return path.relative(repoRoot, path.resolve(target)).split(path.sep).join("/");
}


function cmdChangelog(args) {
    const repoRoot = path.resolve(runGit(["rev-parse", "--show-toplevel"], ".") || die("ERROR: changelog must run inside a git working copy"));
    const stale = [], authored = [];
    let written = 0;

    for (const manifestFile of iterManifests(args.addonsDir || "addons")) {
        const manifest = JSON.parse(readText(manifestFile));
        if (!manifest.id) continue;
        const addonDir = path.dirname(manifestFile);
        const groups = changelogGroups(repoRoot, repoRelative(repoRoot, addonDir), repoRelative(repoRoot, manifestFile));
        if (!groups.length) continue;

        const file = path.join(addonDir, CHANGELOG_NAME);
        if (exists(file) && !readText(file).includes(CHANGELOG_MARKER)) {
            authored.push(file);
            continue;
        }
        const content = renderChangelog(manifest.name || manifest.id, groups);
        const current = exists(file) ? readText(file) : null;
        if (args.check) {
            if (current !== content) stale.push(file);
            continue;
        }
        if (current !== content) {
            writeText(file, content);
            written++;
        }
        if (manifest.changelog !== CHANGELOG_NAME) {
            const afterKey = "readme" in manifest ? "readme" : "type";
            writeText(manifestFile, jsonDumps(insertKeyAfter(manifest, afterKey, "changelog", CHANGELOG_NAME), 4) + "\n");
        }
    }

    if (args.check) {
        if (!stale.length) {
            console.log("Changelogs are up to date");
            return;
        }
        for (const file of stale) console.error(`${file}: out of date`);
        console.error("  run: node resources/scripts/tamhelper.js changelog");
        process.exit(1);
    }
    for (const file of authored) console.log(`Kept hand-authored ${file}`);
    console.log(`Wrote ${written} changelog(s)`);
}


// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
    // Minimal argparse-shaped parser: pulls out flags, leaves positionals.
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--fix") args.fix = true;
        else if (a === "--check") args.check = true;
        else if (a === "--all") args.all = true;
        else if (a === "--out") args.out = argv[++i];
        else if (a === "--out-dir") args.outDir = argv[++i];
        else if (a === "--addons-dir") args.addonsDir = argv[++i];
        else if (a === "--commit") args.commit = argv[++i];
        else if (a === "--since") args.since = argv[++i];
        else if (a.startsWith("--since=")) args.since = a.slice(8);
        else if (a.startsWith("--commit=")) args.commit = a.slice(9);
        else if (a.startsWith("--out=")) args.out = a.slice(6);
        else if (a.startsWith("--out-dir=")) args.outDir = a.slice(10);
        else if (a.startsWith("--addons-dir=")) args.addonsDir = a.slice(13);
        else if (a === "-h" || a === "--help") args.help = true;
        else args._.push(a);
    }
    return args;
}

const USAGE = `usage: tamhelper.js <command> [options]

TAM addon toolchain -- validate, build, and publish addons.

commands:
  validate [--fix]                          Lint every addon manifest
  tam-to-zip [manifest] [--out F] [--addons-dir D] [--all] [--out-dir D]
  zip-to-tam <input.zip> [--out DIR]        Convert a Trilium ZIP to a manifest
  generate-pages                            Build the GitHub Pages site (resources/docs/)
  publish [--addons-dir D] [--out-dir D] [--commit SHA]
                                            Resolve + hash every manifest into resources/docs/
  generate-readme                           Regenerate README.md's addon table
  bump-halon [--check]                      Re-pin halon@beatlink when Halon's stylesheet changes
  changelog [--check] [--addons-dir D]      Regenerate every addon's CHANGELOG.md from git history
  publish-release [--since REF]             Upload *.zip files + the catalog to Releases
`;

async function main() {
    const argv = process.argv.slice(2);
    const command = argv[0];
    const args = parseArgs(argv.slice(1));

    switch (command) {
        case "validate":
            await cmdValidate(args);
            break;
        case "tam-to-zip":
            args.manifest = args._[0];
            await cmdTamToZip(args);
            break;
        case "zip-to-tam":
            if (!args._[0]) die("ERROR: input ZIP is required");
            args.input = args._[0];
            args.out = args.out || ".";
            cmdZipToTam(args);
            break;
        case "generate-pages":
            cmdGeneratePages(args);
            break;
        case "publish":
            cmdPublish(args);
            break;
        case "generate-readme":
            cmdGenerateReadme(args);
            break;
        case "bump-halon":
            await cmdBumpHalon(args);
            break;
        case "changelog":
            cmdChangelog(args);
            break;
        case "publish-release":
            cmdPublishRelease(args);
            break;
        case undefined:
        case "-h":
        case "--help":
            process.stdout.write(USAGE);
            break;
        default:
            process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
            process.exit(2);
    }
}

main().catch((e) => die(`ERROR: ${e.message}`));
