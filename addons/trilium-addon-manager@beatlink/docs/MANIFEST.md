# The TAM Manifest and Toolchain

Everything an addon author writes or runs: the `_tam_manifest_.json` format, the catalog format,
and the `tamhelper.js` commands that validate, build, and publish. For how TAM resolves what these
declare, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## The mental model

A manifest is not an install script. It is a **declaration of a desired note tree**: which notes
exist, where each one's content comes from, how they are parented, and what labels and relations
they carry. TAM's job is to make the live tree match the declaration
(see [How sync works](ARCHITECTURE.md#how-sync-works)); the manifest never expresses steps, only
shape. That one fact explains most of the format:

- **Everything is data.** Notes, parentings, relations, and labels are arrays of plain objects,
  which is what lets `validate` check an addon completely without installing anything, and lets
  the same declaration drive a live sync, a ZIP export, and a published catalog entry.
- **Ids are local and permanent.** A note's `id` means nothing to Trilium; TAM turns it into the
  note's `#TAMFILEID="{addonId}/{id}"` label
  (see [Note identity](ARCHITECTURE.md#note-identity-tamfileid)). Ids staying stable across
  versions is what makes updates possible at all, so never rename one casually.
- **Placement is semantics.** Attaching a note's parent chain at the reserved `"root"` keyword
  makes it replaceable structure; attaching it at `"persistence"` makes it user data that
  survives updates and uninstall (see [Persistence](ARCHITECTURE.md#persistence)). There is no
  per-note "persistent" flag; where it lives is what it is.
- **One document, three lives.** The hand-authored **source** manifest names files relative to
  itself and is read from disk. `publish` turns it into the **published** manifest TAM installs
  from, with commit-pinned URLs and content hashes. At install time TAM snapshots a **stored**
  trim of it onto the addon's database record. Same document, progressively frozen
  (see [Publishing](ARCHITECTURE.md#publishing)).

The life of an addon in this repo: write `addons/{id}/_tam_manifest_.json` next to its source
files, run `validate`, push. CI publishes the pinned and hashed manifest plus `catalog.json` to
GitHub Pages, and builds importable ZIPs. TAM installs from the published URL, detects later
publishes by content hash, and walks changes through the update review. Nothing about the
`addons/` folder layout is required by TAM itself: it discovers an addon only by fetching a
manifest URL, so a manifest and its files can live anywhere on the web.

---

## Top-level fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique addon identifier, `addon-name@author`. No spaces. |
| `name` | Yes | Human-friendly display name. |
| `description` | Yes | Short description for the TAM UI and the catalog site. |
| `author` | Yes | GitHub username of the author. |
| `homepage` | Yes | URL to the addon's GitHub page. Purely a human-facing link, never used by install logic. |
| `license` | Yes | SPDX license identifier (e.g. `GPL-3.0-or-later`). |
| `latestVersion` | Yes | Semver version string. Shown in the UI, and the update-check fallback for manifests with no hashes. |
| `type` | Yes | Display category: `widget`, `theme`, `css`, `script`, `library`, `iconpack`. |
| `manifestSourceUrl` | No¹ | The URL this exact manifest can always be fetched from. Written by `publish`. |
| `contentHash` | — | *Published only.* Hash over the manifest's structure and every file's content; what update checks compare. Never hand-authored. |
| `readme` | No | Relative path to the README, for the catalog website. |
| `changelog` | No | Relative path to the addon's `CHANGELOG.md`, written by `changelog`. `publish` pins it to a commit; TAM and the catalog site render it. Never part of `contentHash`. |
| `manifest` | No | The note-tree declaration (below). Omit for metadata-only entries. |

¹ `manifestSourceUrl` is the one field that makes an addon installable and updatable at all: TAM
stores it verbatim on the install record and refetches it for every update check, and a catalog is
just a list of these URLs. For an addon in this repo it is the published manifest's URL on the
catalog site; `publish` writes it and `validate` enforces it, nobody types it. A source manifest
carries it anyway so that an install made from the raw source manifest learns where the published
one lives and moves itself over on its next sync. Hand-author it only for a manifest published
somewhere outside this repo.

---

## Declaring the note tree

```json
{
  "manifest": {
    "notes": [...],
    "children": [...],
    "relations": [...],
    "labels": [...],
    "settings": {...}
  }
}
```

An addon never declares its own root note. TAM creates and owns a root anchor per addon (titled
after the addon, tagged with TAM's icon), and the manifest only ever references it through the
reserved `"root"` parent keyword in `children[]`. The same goes for the persistence anchor via the
reserved `"persistence"` keyword. This is what keeps every addon uniform under TAM's tree and
keeps anchors out of the manifests entirely.

### `notes`

One entry per note to create:

```json
{
  "id":           "local-id",
  "title":        "Note Title",
  "type":         "code",
  "mime":         "application/javascript;env=frontend",
  "sourceUrl":    "filename.js",
  "attachments":  []
}
```

| Field | Description |
|-------|-------------|
| `id` | The local identifier every other part of the manifest references, and the note's permanent `#TAMFILEID` suffix. Keep it stable across versions. |
| `title` | The Trilium note title. |
| `type` | Trilium note type: `text`, `code`, `render`, `book`, etc. |
| `mime` | MIME type. Code notes need an env qualifier: `application/javascript;env=frontend` or `;env=backend`, or `text/jsx`. |
| `sourceUrl` | Where the content lives. Relative to the manifest in a source manifest (read from disk by the toolchain); rewritten to a commit-pinned absolute URL by `publish`; an already-absolute URL is left alone in both (content hosted in someone else's repo). TAM resolves whatever it finds against the manifest's own URL, exactly like an HTML `<base href>`, and fetches it fresh at sync time. |
| `content` | Escape hatch: literal inline content, used directly with no fetch. For hand-authored special cases. |
| `sha` | *Published only.* SHA-256 of the file. Lets a sync skip both the fetch and the write when nothing moved, and keeps persistent notes from being reviewed when the shipped side is unchanged. |
| `sourceId` | *Published only.* The file's branch-tracking URL, recorded as `#TAMSOURCEURL`. Two addons vendoring the same file with the same `mime` share one live note matched on this (see [Shared notes](ARCHITECTURE.md#shared-notes-tamsourceurl)); the pinned `sourceUrl` cannot serve, being a different string every publish. |
| `skipOnUpdate` | Never overwrite this note's content on update. For structural notes whose content is filled in after install (a database note, an empty render stub). Redundant under `"persistence"`, where it is implied. |
| `promptOnUpdate` | Diff this note's content on update and let the user choose Keep Mine / Use New Default. For structural notes users are expected to customize. Also implied under `"persistence"`. |
| `attachments` | Binary or text blobs attached to the note rather than shipped as child notes (below). |

### `children`

The parent-child tree. The child is a local id from this manifest; the parent is another local id
or one of the reserved anchor keywords:

```json
{"parent": "root", "child": "script-note"}
```

A note's *first* declared parent is where it is created; any later declarations become clones of
the same note under additional parents. Everything whose parent chain roots at `"persistence"` is
persistent; everything else must be reachable from `"root"` or it will never be created
(`validate` warns).

Two addons shipping the same file need no cross-addon wiring for it: each declares its own
vendored copy, and TAM shares one live note between them automatically when the copies resolve to
the same `sourceId`.

One placement constraint comes from Trilium itself, not TAM: a note that `require()`s or
`import`s another note resolves it within its own subtree, so the required note must be wired as
a descendant (in practice, a direct child) of the requiring note. `validate` checks reachability
at build time; the runtime truth is audited by
[Diagnostics](ARCHITECTURE.md#diagnostics) as `broken-wiring`.

### `relations`

Typed links between notes. Both ends must be real local ids from this manifest (the reserved
keywords are not valid targets); a `to` that matches no local id passes through as a literal
Trilium note id:

```json
{"from": "launcher", "type": "renderNote", "to": "settings"}
```

A relation may cross the persistence boundary in either direction; relations are applied only
after every note has resolved, so no ordering care is needed.

### `labels`

Key-value attributes applied after creation:

```json
{"note": "script", "name": "run", "value": "frontendStartup"}
```

A name with a trailing `(inheritable)` suffix is written as a real inheritable attribute.
Activation labels (`run`, `widget`, `appCss`, ...) are managed by TAM's enable/disable system and
survive it correctly; see [Enabling and disabling](ARCHITECTURE.md#enabling-and-disabling).

### `settings` *(optional)*

Names the notes making up a [libsettings](../../../libs/libsettings/README.md)-style settings set,
so TAM reviews the addon's settings **per setting** on update instead of diffing the config note
as one wall of JSON (see [Update review](ARCHITECTURE.md#update-review)):

```json
"settings": {
  "schema": "schema",
  "defaults": "defaults",
  "config": "config"
}
```

The division of labor dictates each note's placement, and `validate` enforces all of it:

- `schema` describes the fields and carries no values. **Structural**: every update replaces it.
- `defaults` holds every setting's shipped value, so it must ship content. **Structural** too.
- `config` holds the user's answers, so it must be **persistent**, and must ship *no* content of
  its own (TAM creates it empty, which libsettings reads as `{}`); shipping content would put it
  back on the whole-file diff it was excluded from. It must carry a
  `{"from": "config", "type": "sourceConfig", "to": "defaults"}` relation, which is both how
  libsettings finds the defaults and how TAM walks to the shipped values.

An addon that stores settings some other way simply omits this and nothing changes for it.

### `settingsNote` *(optional)*

The local id of the note TAM's Settings button should navigate to. Point it at a `render`-type
note, not the raw JSX note: activating a code note opens its source, not its UI. The common
pattern is a launcher note attached under `"root"` carrying a `renderNote` relation to the
settings JSX, so the same note opens from the tree and from TAM.

### `readmeNote` *(optional)*

The local id of a note (typically `code`/`text/markdown`, `sourceUrl` pointing at the addon's own
`README.md`) shipped as part of the installed tree. TAM's detail page resolves it live and renders
it with `marked`, no network fetch, since the README is just another installed note. Before
install there is no such note, so an uninstalled addon's detail page links to its homepage
instead.

### `root` *(TAM only)*

TAM bootstraps by manual ZIP import, before any TAM code exists to synthesize an anchor for it, so
its own manifest is the one that still declares a real root note: the note the user imported. No
other manifest should ever set this field; its absence is what tells every tool "TAM synthesizes
the root", which is what every addon but TAM wants.

### `attachments`

A Trilium attachment is not a note: it has no place in the tree, no `#TAMFILEID`, and cannot be a
`children[]`/`relations[]` target. So it is declared inline on its owner:

```json
"attachments": [
  {"title": "fa-solid-900.woff2", "role": "file", "mime": "font/woff2", "sourceUrl": "fa-solid-900.woff2"}
]
```

| Field | Description |
|-------|-------------|
| `title` | Required, unique per note, and **the key TAM matches on across syncs**, so it is the one field that must stay stable. |
| `role` | `file` (default) or `image`. Trilium's icon-pack lookup only reads `file`. |
| `mime` | Required; Trilium picks attachments by mime. |
| `sourceUrl` / `content` / `sha` | Exactly as for notes. `content` is base64 unless `"binary": false`. |

An attachment shipped at the last sync and no longer declared is deleted, because Trilium picks
between two same-mime attachments arbitrarily, so a renamed font would otherwise fight its own
stale copy. Attachments TAM never shipped are left alone.

**Icon packs** are the main attachment consumer. A
[Trilium icon pack](https://docs.triliumnotes.org/user-guide/concepts/themes/icon-packs) is three
things on one note, and Trilium drops a malformed pack with nothing but a server-log line, so
`validate` enforces all three: a `code`/`application/json` note whose content is the glyph
manifest, an `#iconPack=<prefix>` label (alphanumerics, hyphens, underscores; `bx` is taken), and
the font as a `role: "file"` attachment with a `font/woff2`/`woff`/`ttf` mime. `iconPack` is an
activation label, so disabling the addon removes the pack from the picker without uninstalling.
See `font-awesome-icons@hulmgulm` for a worked example.

---

## Catalog format

A catalog is nothing more than a URL serving:

```json
{
  "webUrl": "https://.../",
  "tam-addons": ["https://.../foo@bar/_tam_manifest_.json", "..."]
}
```

`tam-addons` is a flat list of `manifestSourceUrl`s with no per-entry metadata; `webUrl` is an
optional human-browsable site for the "Visit Website" button. Adding a catalog just remembers the
URL. Browsing refetches the list and every manifest on it, fresh each time; nothing about a
catalog's contents is ever cached, which is why no "refresh catalog" action needs to exist and why
deleting a catalog can never affect installed addons.

No catalog is needed to install a single addon: **install by URL** fetches one manifest, discovers
its own `id`, and installs it exactly like a catalog entry.

This repo's catalog (`https://trilium-community.github.io/trilium-scripts/catalog.json`) is written by
`publish` and served by GitHub Pages alongside the manifests. GitHub Releases are not involved in
installing or updating at all; they only carry the importable `{id}.zip` exports.

---

## Scripts reference

The toolchain is one Node.js CLI, `resources/scripts/tamhelper.js`, run from the repo root. Inside
`nix-shell resources/nix` each command is a shell function (`validate`, `tam_to_zip`,
`zip_to_tam`, `generate_pages`, `publish`, `generate_readme`, `changelog`, `publish_release`). The only runtime
dependency is `marked` (`npm ci` against the committed lockfile).

### `validate`

The closest thing this repo has to a test suite; run after any manifest or source edit, and run in
CI before every publish (exit code 1 on errors). Checks, per manifest:

- Expected top-level fields present (`id` missing is an error; other absences warn).
- `homepage` ends with `addons/{id}` and `manifestSourceUrl` matches where `publish` will serve
  this manifest (both auto-fixable with `--fix`).
- The `readme` file exists; every relative `sourceUrl` (notes and attachments) resolves to a real
  file on disk; absolute ones are fetched.
- The `changelog` field points at a real file, and is filled in from an existing `CHANGELOG.md`
  with `--fix`. A hand-authored changelog must carry an entry for `latestVersion`; a generated one
  is held to its history by `changelog --check` instead.
- `manifest.root` is only used the TAM way, and otherwise at least one note attaches to `"root"`;
  every note is reachable through `children[]`; all `children`/`relations`/`labels` references
  name declared ids (reserved keywords allowed only as `children[].parent`).
- No duplicate note ids; code notes carry an env qualifier; plain `.js` sources do not use ES
  module syntax (never transpiled); generic library titles warn (the require namespace is global
  across addons); `require()`/`import` targets are reachable in the requiring note's subtree;
  `tamRequire()` targets name a real, frontend-loadable note.
- `settings` placement and wiring as described [above](#settings-optional).
- Attachments have stable unique titles, a mime, and content; icon packs are complete.
- `skipOnUpdate`/`promptOnUpdate` under `"persistence"` warn as redundant.

```
node resources/scripts/tamhelper.js validate [--fix]
```

### `tam-to-zip`

Renders a manifest into a Trilium-importable ZIP: fresh Trilium ids per note, clones for
multi-parent declarations, attachments placed as Trilium's own exporter does, and every note's
`#TAMFILEID` baked in, so a manually imported ZIP is fully self-identifying and a later TAM sync
adopts it with no bootstrap step. Content comes off disk for relative `sourceUrl`s, so a ZIP
always matches the working copy and builds offline.

```
node resources/scripts/tamhelper.js tam-to-zip addons/{id}/ [--out out.zip] [--addons-dir addons/]
node resources/scripts/tamhelper.js tam-to-zip --all [--addons-dir addons/] [--out-dir .]
```

`--all` builds every addon's `{id}.zip` in one call; the publish workflow uses it.

### `zip-to-tam`

The reverse: a Trilium export ZIP into a starting `_tam_manifest_.json` plus flat source files,
for migrating an addon developed inside Trilium. Local ids are slugified from titles, clones
become extra `children` entries, attachments are recovered, and top-level metadata is scaffolded
as `FILL_IN` placeholders to complete by hand (then review ids and set update flags).

```
node resources/scripts/tamhelper.js zip-to-tam path/to/export.zip [--out ./output-dir/]
```

### `publish`

Turns every source manifest into its published form (pinned URLs, `sha` per file, `contentHash`,
`sourceId`) and writes them with `catalog.json` to `resources/docs/`. Offline and deterministic:
the same commit always publishes byte-identically. See
[Publishing](ARCHITECTURE.md#publishing) for what the output means.

```
node resources/scripts/tamhelper.js publish [--addons-dir addons/] [--out-dir resources/docs/] [--commit SHA]
```

`--commit` defaults to `GITHUB_SHA` in CI, else `HEAD`. A local run is only for inspecting output;
`resources/docs/` is gitignored and only the deployed copy is ever installed from.

### `generate-pages` and `generate-readme`

`generate-pages` builds the static GitHub Pages catalog site into `resources/docs/`: an index of
cards with search and type filters, and a detail page per addon with its rendered README, metadata,
download buttons, and its changelog in a collapsed section below the README. `generate-readme` regenerates the repo-root `README.md`'s addon table
between its `GENERATED` markers. Both share manifest loading.

### `changelog`

Regenerates every addon's `CHANGELOG.md` from the commits that touched its directory, grouping them
under whichever `latestVersion` the manifest carried at each commit, and adds the `changelog` field
to any manifest still missing it. Conventional Commit subjects become the bullets: `feat` under
**Added**, `fix` under **Fixed**, anything else under **Changed**, with `chore`/`ci`/`test`/`style`/
`build` dropped and a `!` or `BREAKING CHANGE:` marked in the text.

A file carrying the generated marker is rewritten in place; one without it was hand-authored and is
left alone, which is the escape hatch for an addon whose history reads badly. `--check` fails
instead of writing, which is how CI keeps the committed files honest (it needs full history, so the
workflow checks out with `fetch-depth: 0`). A directory rename ends an addon's history: `git log`
only follows renames for a single file.

```
node resources/scripts/tamhelper.js changelog [--check] [--addons-dir addons/]
```

### `publish-release` *(CI only)*

Uploads every ZIP from `tam-to-zip --all` to two GitHub releases: a permanently tagged release for
this publish run (how a user gets an older version) and the floating `latest` release (so
"download current" links never change). Requires an authenticated `gh`.

The release notes are the changelog entries of the addons this push actually changed, found by
diffing against `--since`, else the push event's `before` commit, else the last `publish-*` tag,
else `HEAD~1`. With no base commit to diff against (a shallow clone) the notes fall back to naming
the published commit alone.

---

## GitHub Actions workflows

**`publish.yml`** (every push to `main`): `validate`, `changelog --check`, then `tam-to-zip --all`,
then `publish-release`. Checks out full history, which the changelog check and the release notes
both read.

**`pages.yml`** (every push to `main`): `npm ci`, `generate-pages`, then `publish` pinned to the
deployed commit, then deploy `resources/docs/` to GitHub Pages.
