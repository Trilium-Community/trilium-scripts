# TAM Architecture

How Trilium Addon Manager works internally, and why it is built the way it is. For the manifest
format and the toolchain an addon author writes against, see **[MANIFEST.md](MANIFEST.md)**; for
what TAM is and how to install it, see **[README.md](../README.md)**.

---

## What TAM is

TAM is a reconciler, not an installer.

A file package manager gets to treat its install target as dead matter: delete the old directory,
unpack the new one. TAM never has that luxury. An addon is a subtree of the user's own Trilium
database, and that database is alive. The user renames notes, moves them, retags them, and the
addon itself writes the user's data into its own subtree. Installing by replacement would destroy
all of that, so every operation TAM performs (first install, update, self-update, repair) is the
same act instead: fetch the declared shape, compare it with the living tree, change only what needs
changing, and put anything the user may have deliberately changed in front of them rather than
silently overwriting it.

Three more constraints shape everything below:

- **No state about the tree is trusted unless it lives in the tree.** An id map cached anywhere
  else drifts the moment a sync half-fails or the user rearranges something, and a drifted map
  misdirects the code that deletes. So each note carries its own identity as a label, and
  everything else is derived from the live tree on demand.
- **Distribution is static files.** A manifest is a JSON document at any URL, a catalog is a list
  of such URLs, and publishing is an offline build step. There is no server, no account, no
  registry service.
- **User data outlives addon code.** Whether a note is replaceable structure or the user's data is
  expressed by where it is placed, and every destructive sweep is scoped so that removing an addon
  cannot take the user's data with it unless the user explicitly asks.

Every section below is one of these commitments carried out in detail.

---

## TAM's own notes

TAM is itself an addon. Once installed:

```
trilium-addon-manager@beatlink  (render note)
├── Database  (JSON code note: all TAM state)
│   ├── Addons  (global anchor: every addon's structural root nests here)
│   └── Addon Data  (global anchor: every addon's persistence root nests here)
└── Source Code  (grouping note)
    ├── TAM.jsx  (the entire frontend widget in one file)
    │   └── lib-tam.js  (the entire backend/data layer in one file)
    │       ├── marked.min.js  (vendored markdown renderer)
    │       ├── tam-manifest-model.js  (manifest-shape helpers and shared constants)
    │       └── libSettingsCore.js  (libsettings' merge core, for the settings review)
    └── TAM.css  (appCss stylesheet)
```

The code is deliberately just a handful of files, organized by banner comments rather than split
across many notes. `tam-manifest-model.js` is also required from disk by the toolchain's
`tamhelper.js`, so the runtime and the validator read a manifest the same way by construction.
`libSettingsCore.js` is the very note libsettings' own frontend uses, so "the user changed this
setting" means exactly what the settings form that wrote the file meant by it.

Relations wired at install time:

| From | Relation | To |
|------|----------|----|
| `trilium-addon-manager@beatlink` | `renderNote` | `TAM.jsx` |
| `TAM.jsx` | `displayNote` | `trilium-addon-manager@beatlink` |
| `lib-tam.js` | `database` | `Database` |
| `lib-tam.js` | `addonRoot` | `Addons` |
| `lib-tam.js` | `addonPersistence` | `Addon Data` |

`lib-tam.js` owns these three `currentNote`-bound lookups itself; everything else receives ids as
parameters. It runs in the browser and reaches the backend through `api.runOnBackend` for anything
that creates notes or reads content in bulk. All fetching stays on the frontend (backend closures
are serialized, so they cannot share the retry wrapper), which trades on CORS: manifests and
source files must be served with permissive headers, as GitHub raw is.

Under **Addons**, each installed addon gets a TAM-owned root note; under **Addon Data**, each addon
with persistent notes gets a TAM-owned persistence root. Both are created by `ensureAddonAnchor`,
titled and `#addonId`/`#iconClass`-tagged after the addon. An addon's manifest never declares or
reparents these anchors; it only attaches notes beneath them via the reserved `"root"` and
`"persistence"` parent keywords (see [MANIFEST.md](MANIFEST.md#children)). TAM's own manifest is
the one exception, since TAM bootstraps by manual ZIP import before any TAM code exists to
synthesize an anchor for it (see [`root`](MANIFEST.md#root-tam-only)).

---

## Note identity: `#TAMFILEID`

Every note TAM creates or resolves carries a permanent label,
`#TAMFILEID="{addonId}/{localId}"` (e.g. `#TAMFILEID="libical@kewisch/lib"`). This label, not any
id stored anywhere else, is the canonical answer to "which real note is local id X of addon Y":
lookups go through Trilium's own attribute index (`api.getNoteWithLabel`), so the note carries its
own identity and there is no external map to drift out of sync after a partial failure, a manual
edit, or a bug.

This is what makes every resolution **idempotent**. Whether a note is being created for the first
time, retried after a failure, or re-adopted after a reinstall, the same "look it up by
`#TAMFILEID`, then create if absent" logic applies, and the sync never needs to special-case "did
this already happen". A soft-deleted match (`note.isDeleted`) is treated as absent rather than
resurrected.

Two rules keep the identity trustworthy:

- **Never inheritable.** The label is set plainly, with no `isInheritable` flag: it identifies
  exactly one note.
- **Always read with the *owned* accessors.** Writing it non-inheritably is not enough, because
  Trilium's `~template` relation is a second, independent inheritance path: an instance inherits
  **all** of its template's labels regardless of `isInheritable`. TAM ships templates, so every
  user note created from one reports the template's `#TAMFILEID` as its own through the plain
  accessors. `getLabelValue`/`hasLabel` will therefore claim ownership of notes TAM never created,
  and `api.getNotesWithLabel` returns template instances too. Every ownership check must use
  `getOwnedLabelValue`/`hasOwnedLabel`, and every scan must re-check each hit:

  ```js
  for (const note of api.getNotesWithLabel(tamFileIdLabel)) {
      if (note.isDeleted) continue
      const value = note.getOwnedLabelValue(tamFileIdLabel)  // NOT getLabelValue
      if (!value) continue                                   // inherited-only: not ours
      // ...
  }
  ```

  This matters most where the value gates a `note.deleteNote()`, which cascades through the note's
  entire subtree. Reading the inherited value there deletes user notes at scale: one manifest
  change dropping a template's local id would take every note templated from it. This is not
  hypothetical; it caused the mass-deletion regression fixed in 6.3.1.

Consistent with "trust only the tree", **nothing about note identity is cached**: not
`rootNoteId`, not `settingsNoteId`. Each is derived by a `#TAMFILEID` lookup wherever needed (the
addon's anchor local id for the root, `manifest.settingsNote` for settings), batched into one
backend round trip where the UI needs many at once. Caching them "for speed" would reintroduce
exactly the drift this convention removes.

### Shared notes: `#TAMSOURCEURL`

Many addons vendor the same library files. Installed naively, one settings library becomes dozens
of identical notes, and every fix to it syncs dozens of times. So each resolved note also carries
`#TAMSOURCEURL`: the URL its content came from, as a second, content-based identity. During
resolution, a note that does not yet exist under *this* addon's `#TAMFILEID`, but whose source URL
and mime already exist on some other addon's note, is **cloned into place rather than copied**. Two
addons vendoring one file with the same mime share one live note. The mime is part of the match
because Trilium only bundles a child script whose env matches its parent's: one addon may vendor a
library as a frontend module and another as a backend module, and each needs its own note.

The recorded value is the published `sourceId` (the file's branch-tracking URL), not the
commit-pinned `sourceUrl` it was fetched from, because a pinned URL is a different string on every
publish and would never match anything (see [Publishing](#publishing)).

Sharing has one authoring consequence worth stating outright:

> A note shared by source URL may not carry per-addon labels or relations.

Only the first addon to install it owns its `#TAMFILEID`, and every sharing addon's declared
relations land on the same note, last sync wins. A pure library module shares perfectly; anything
that must know which addon it belongs to must ship as that addon's own file at its own URL.
Uninstall is safe either way: a shared note is only detached from the departing addon's parents,
and deleted only once nothing else parents it (see [Uninstall](#uninstall)).

Adoption is only ever taken from a *different* addon's copy. A manifest may legitimately declare
one file under two local ids (agenda ships `ical.min.js` once as a library and once as a resource
note), and both carry the same `sourceId`; adopting this addon's own note there would collapse the
two ids onto one note and wire a note as its own parent. `readNoteResolution` is the single place
that decides adoption, for the sync and the audit alike.

---

## The Database record

The **Database** note holds all TAM state as one JSON document: `catalogs`, a plain array of added
catalog URLs, and `installedAddons`, a flat map keyed by `addonId` alone. An addon's identity is
its manifest `id`, independent of which catalog it was discovered through, and nothing about a
catalog's *contents* is ever cached, so deleting a catalog never touches anything installed from
it. In the code, only the accessor functions at the top of `lib-tam.js` spell out this layout.

Each installed addon's record:

```json
{
  "installedVersion": "1.2.3",
  "contentHash": "9f2c...",
  "noteHashes": { "widget": "3ab1...", "style": "c07e..." },
  "manifestSourceUrl": "https://.../foo@bar/_tam_manifest_.json",
  "manuallyInstalled": true,
  "enabled": true,
  "meta": { "name": "...", "description": "...", "author": "...", "license": "...", "type": "...", "homepage": "..." },
  "manifest": { "settingsNote": "...", "readmeNote": "...", "settings": {...}, "allowExternalReferences": false, "children": [...] },
  "persistence": { "pendingPrompts": [...], "settingsBaseline": {...}, "metadataBaseline": {...} }
}
```

The record stores only what cannot be derived from the manifest or the live tree:

- **`installedVersion`**, **`contentHash`**, **`noteHashes`**: what is *actually installed*. A
  manifest fetch only ever describes the latest published version, so once a newer one exists,
  this record is the only account of the current install. `contentHash` is what an update check
  compares; `noteHashes` decides, per note, whether anything needs refetching. Both are left unset
  by a sync that skipped a note, so the next sync retries instead of reading it as current.
- **`manifestSourceUrl`**: exactly which URL this install came from, refetched for update checks.
- **`meta`**: a display snapshot (name, description, ...), so the addon list renders without a
  live catalog.
- **`manuallyInstalled`**: pure user intent. `true` if the user installed it; only ever promoted
  from `false` (a maintenance re-sync must not start claiming the user asked for it).
- **`enabled`**: technically derivable from the tree, cached because it is read on every list
  render.
- **`manifest`**: not the whole manifest, only the fields TAM needs after the fetched document is
  gone (`stripManifestForStorage`): the named notes, `settings`, `allowExternalReferences`, and
  `children[]` for computing the persistent-id set. `notes[]`/`relations[]`/`labels[]` are not
  stored, because nothing ever reads them back; they only drive a live resolution pass against a
  freshly fetched manifest. This split is deliberate: an upstream manifest change never affects an
  installed addon until it is actually synced.
- **`persistence`**: TAM's own review bookkeeping, described under
  [Update review](#update-review). It lives here rather than in the addon's own config note
  because it is TAM's data, not the user's: the addon never has to know it exists, a settings save
  cannot drop it, and it is discarded with the record on uninstall.

---

## How sync works

`syncAddon(addonId, options)` is the single entry point for making an addon's notes match its
manifest. First install, update, and TAM updating itself are the same call; find-or-create by
`#TAMFILEID` is what removed the need for separate install/update/self-update paths.
`options.manifestSourceUrl` is required for a fresh install and falls back to the stored record
for an update.

1. **Fetch the manifest**, resolving every relative `sourceUrl` against the manifest's own URL,
   exactly like an HTML `<base href>`. From here on everything deals in absolute URLs.
2. **Collect what the user may have changed, before anything is rewritten**: the live
   title/label/relation values for the metadata review, and each persistent note's current content
   for the whole-content diff (both under [Update review](#update-review)). These must run first
   because the sync is about to overwrite the very values they compare.
3. **Ensure the anchors** ([TAM's own notes](#tams-own-notes)) and **resolve every declared
   note** in one topological pass. The pass costs three backend hops regardless of addon size:
   `readNoteResolution` (which notes already exist, which shared copies are adoptable, which
   attachment titles are present), `writeNotes` (all creates/updates, in topological order so each
   parent resolves from ids created moments earlier), and `reconcileNoteParenting`. Write batches
   split only past 4MB of accumulated content. Per note: found and live means cloned into the
   right parent with content/type/mime updated; absent means created and tagged. Content is
   fetched fresh on the frontend (through one shared HTTP 429 retry wrapper, base64 for binaries)
   and handed to the backend as arguments, so the backend write looks nothing up. A note whose
   published `sha` matches the recorded one is skipped entirely, no fetch, no write, though its
   title/type/mime still track the manifest so a rename ships without the file moving. A fetch
   failure logs, skips that note and its subtree, and is never fatal. Declared attachments install
   onto their notes matched by title, with the same hash skip and the same non-fatal handling; an
   attachment shipped last sync and no longer declared is deleted, one the user added by hand is
   left alone. TAM's own root is the one structural exception: it lives wherever the bootstrap
   ZIP was imported, so its parent is never touched.
4. **Reconcile parenting**: every note is cloned into every parent its manifest currently
   declares, and detached from parents it no longer declares, scoped to branches *this addon's
   own* manifest created so another addon's clone of a shared note is never mistaken for stale.
5. **Apply labels and relations**, through the one attribute writer, which is disable-aware: an
   attribute TAM has disabled lives under a `disabled:` name, and writing to that name is what
   keeps a disabled addon disabled across a re-sync. A label name's trailing `(inheritable)`
   suffix becomes a real `isInheritable` attribute.
6. **Prune**: any live note owned by this addon (by `#TAMFILEID` prefix, owned accessors) whose
   local id is no longer declared is deleted, except persistent notes and the anchors.
7. **Write the record**: merged in place for an update (never resetting `manuallyInstalled` or
   `enabled`), fresh only for a first install. `contentHash` is recorded only if *every* note
   resolved; a half-failed sync leaves it unset so the addon keeps reporting an update and
   [Diagnostics](#diagnostics) can name it.
8. **Finish by lifecycle**: a brand-new install is left disabled and records its settings
   baseline; an update runs the post-sync reviews. TAM's own record skips the review tail, which
   would run mid-self-replacement.

**Update All** simply calls `syncAddon` per out-of-date addon in sequence, then shows the Update
Review once per addon that queued prompts.

---

## Publishing

A manifest is written in one form and installed in another, because the two forms answer different
needs: authoring wants relative paths and no bookkeeping, installing wants immutable URLs and
verifiable content.

A **source manifest** (`addons/{id}/_tam_manifest_.json`) names each file relative to itself and
carries no hashes. `tamhelper.js publish` turns it into the **published manifest** TAM actually
installs from (deployed to `https://trilium-community.github.io/trilium-scripts/{id}/_tam_manifest_.json`),
doing three things:

1. **Pins every relative `sourceUrl` to one commit** (`raw.githubusercontent.com/.../{sha}/...`),
   so a published URL never moves and never serves a stale CDN copy the way a branch URL does.
   Each note also gets a `sourceId`, the same file's branch-tracking URL, which is what
   [note sharing](#shared-notes-tamsourceurl) matches on precisely because it does *not* change
   every publish.
2. **Hashes every file**: a `sha` per note and attachment, and one `contentHash` over the whole
   manifest. The `contentHash` input replaces each pinned URL with that note's `sha`, so it tracks
   content and structure but not the commit, otherwise every push would look like an update.
3. **Writes `catalog.json`**, the list of every published manifest URL
   (see [Catalog format](MANIFEST.md#catalog-format)).

A `changelog` path is pinned the same way, but deliberately left out of the `contentHash`: it is
rewritten from git history on every commit that touches the addon, and an update the user is
offered should mean the installed notes changed. TAM fetches it for the detail view, preferring the
changelog of the version being offered over the installed one's.

Publishing is offline and deterministic: only files on disk are hashed, and the same commit always
publishes byte-identically. A `sourceUrl` that was already absolute points at someone else's repo,
so it is carried through unhashed (fetching it would make the same commit publish differently
depending on upstream); such a note simply refetches on every sync.

The hashes buy three things:

- **Updates without version bumps.** The update check compares `contentHash` against the recorded
  one, so any content or structure change is an update by itself. `latestVersion` remains the
  displayed version and the fallback comparison for unhashed manifests.
- **Syncs that fetch only what moved.** A matching per-note `sha` skips fetch and write both, so
  changing one file in a 25-note addon costs one request, not 25.
- **Reviews that only ask real questions.** A persistent note raises no prompt unless its
  *shipped* side moved since the last sync, however much the user's copy has diverged.

---

## Persistence

Some addon notes hold the user's data: settings, caches, content the addon seeded and the user
edited. That data must survive updates, and by default uninstall too.

The rule is **placement, not per-note flags**: everything reachable through `children[]` from the
reserved `"persistence"` parent keyword is persistent, everything else is structural. Persistent
notes are ordinary `#TAMFILEID` notes, but they resolve under the addon's persistence anchor
(under the global **Addon Data** note), which no sweep ever touches, while structural notes
resolve under the addon's root anchor (under **Addons**), which uninstall tears down entirely.
Survival is a property of where a note lives.

The consequences fall out mechanically:

- **Created once, never overwritten.** The resolution pass never writes content to an existing
  persistent note; a missing one is created from its shipped default exactly once. Upstream
  changes to the default reach the user only through [Update review](#update-review).
- **One resolution pass covers both halves.** Each note takes its anchor from the root of its own
  `children[]` chain. A single topological ordering always exists, because a note is persistent
  *precisely because* its chain roots at `"persistence"`, so no structural note can sit below a
  persistent one. Relations may cross the boundary freely; they are applied after all notes
  resolve.
- **Every sweep is handed the persistent-id set** (plus the persistence anchor's own synthetic
  id) and leaves it alone: update-time pruning, uninstall detachment, all of it.
- **Uninstall keeps the data unless the user says otherwise.** For an addon owning persistent
  notes, the uninstall dialog offers "Also delete this addon's stored data", off by default.
  Reinstalling the same addonId later re-adopts every surviving note by `#TAMFILEID`, data
  intact.

One warning: this protection covers notes TAM owns. User notes *templated from* a TAM-owned
template are not TAM notes at all, yet inherit the template's `#TAMFILEID`; they are protected by
the owned-accessor rule in [Note identity](#note-identity-tamfileid), not by the persistent set.
That, and not caution for its own sake, is why data deletion on uninstall is opt-in per uninstall.

---

## Update review

An update rewrites three kinds of thing the user may consider theirs: a persistent note's content,
their settings values, and the titles/labels/relations of any installed note. TAM's contract is
that none of these changes silently. Everything lands on one **Update Review** screen, each entry
a Keep Mine / Use New Default choice, collected during the sync and stored on the record's
`persistence.pendingPrompts` until answered.

The kinds share one shape and one dispatch: an entry is either a whole-content diff (one boolean)
or an item list (one boolean per item key), routed by its `source` through the `reviewKinds`
registry in `lib-tam.js`. The two item-level kinds keep their "what shipped last time" baseline on
the record through the same pair of helpers. A new review kind means a collector, a baseline key,
and one registry entry, never a parallel mechanism.

**Whole-content diff** (persistent notes). Before the sync rewrites anything, each persistent
note's live content is compared against the incoming default, skipping any note whose published
`sha` is unchanged (nothing upstream moved to ask about). A difference queues both versions
side-by-side; Keep Mine is the default selection.

**Per-setting review** (addons declaring [`settings`](MANIFEST.md#settings-optional)).
Whole-file diffing is the wrong shape for a config document: one blob of unrelated answers, where
"Use New Default" would replace everything at once. So the config note is excluded from the diff
and reviewed key by key instead. The baseline (`settingsBaseline`, the merged read-only sources as
of the last review) is what distinguishes "the user chose this" from "this default moved
upstream": a moved default the user never diverged from is adopted outright; every other moved
default gets a row, starting on Use New Default if the user never customized it. Use New Default
drops the user's override so the setting tracks the source again; Keep Mine *pins* today's value
into the config, which is what stops an untouched setting from following the default. Either way
the baseline advances, so no question is asked twice; on the collect side it advances only once
the user answers, so an unanswered review is re-asked rather than forgotten. Silent by design: a
value already equal to the new default, a customization whose default did not move, a field new in
this version, registry entries the user deleted, and `list` fields (a stored list replaces its
default wholesale, so per-entry review is meaningless). A pre-baseline install records a baseline
on its first update and reviews nothing that once, since there is no way to know which stored
values were deliberate.

**Per-note metadata review** (every addon, nothing to declare). The sync sets every declared
title, label, and relation, which would silently revert a note the user renamed or a label they
retargeted. So declarations get the same treatment: `metadataBaseline` holds what the manifest
declared at the last sync, and a row is raised only where the *declaration itself* moved, one per
`<note>: title` / `label <name>` / `relation <type>`. The live value decides the row's default
(untouched: Use New Default). A declaration the manifest dropped shows `(removed)` as incoming,
and Use New Default is the only way such a label or relation is ever removed; Keep Mine writes the
pre-update value back, since the sync has already overwritten it by the time the user answers.
This baseline advances at sync time, because each row already carries both values it needs. A
title the user renamed under an unchanged declaration is never asked about.

---

## Enabling and disabling

TAM disables an addon without uninstalling it by renaming Trilium's activation attributes under a
`disabled:` prefix, which Trilium does not recognize, so the scripts stop running; enabling
renames them back. The scan covers the addon root's whole subtree, filtered to notes the addon
owns, so activation labels on any descendant toggle correctly. The activation names:

`widget`, `renderNote`, `run`, `customRequestHandler`, `customResourceHandler`, `titleTemplate`,
`appCss`, `webViewSrc`, `iconPack`, `runOnNoteCreation`, `runOnNoteTitleChange`, `runOnNoteChange`,
`runOnNoteContentChange`, `runOnNoteDeletion`, `runOnBranchCreation`, `runOnBranchChange`,
`runOnBranchDeletion`, `runOnChildNoteCreation`, `runOnAttributeCreation`,
`runOnAttributeChange`, `appTheme`

A fresh install is always left disabled, so nothing runs until the user has looked at what
arrived. Every other attribute write in TAM (the sync, the metadata review) is disable-aware for
the same reason: writing to the `disabled:` name when one exists is what keeps a disabled addon
disabled across a re-sync.

---

## Uninstall

`deleteAddon` is branch-scoped, never a blanket delete of the root's subtree, because of shared
notes: it scans every live note the addon owns (by `#TAMFILEID` prefix, owned accessors) and
detaches it from each parent unless that parent belongs to a *different* addon. A note disappears
only when no parents remain, so a note shared via [`#TAMSOURCEURL`](#shared-notes-tamsourceurl) is
provably safe, not just probably safe, and nothing depends on assumptions about Trilium's cascade
behavior toward multi-parented notes. Scanning the live tree by tag rather than walking the stored
manifest is what makes this self-healing: a note whose removal an intermediate update never
processed still gets found.

Before anything is torn down, TAM checks for **external references**: relations pointing into the
addon's subtree from outside it. Any found are shown in the uninstall dialog, since they would be
left dangling. An addon that expects to be relation-targeted (a template library, say) sets
`allowExternalReferences` to skip the warning. The same dialog carries the
"delete stored data" choice described under [Persistence](#persistence).

The record is then dropped. As a last-resort recovery, Settings offers **Reinitialize database**:
uninstall everything except TAM itself and reset the Database note to its catalogs plus a bare TAM
entry, from which TAM re-syncs itself.

---

## Diagnostics

The sync is deliberately non-fatal about individual notes, and `installedVersion` advances even on
a partial sync. That is the right behavior in the moment (a broken CDN should not wedge an
update), but it means an addon can report itself current while running old code. **Run
Diagnostics** (`diagnose()`) exists to close that gap: one read-only audit of TAM's bookkeeping,
the addon-owned tree, and every installed addon against its live manifest. Nothing changes until a
row's own repair button is pressed. It replaced three earlier buttons, two of which deleted first
and reported after.

| Issue code | What it means | Repair |
|---|---|---|
| `duplicate-id` | Two live notes claim one `#TAMFILEID`. The one thing a live-lookup design cannot self-correct; TAM cannot tell which copy is real. | none, by hand |
| `orphaned-note` | A `#TAMFILEID` note with no parents left. | Delete note |
| `unclaimed-note` | A note under the addon root no installed addon claims. | Delete note |
| `dead-source` | The record's `manifestSourceUrl` no longer fetches. | Repoint & re-sync (if a catalog carries it), or Uninstall |
| `unverifiable-source` | The manifest has no hashes at all, so updates fall back to version numbers and content cannot be checked. | Repoint & re-sync, or Uninstall |
| `partial-sync` | The manifest has a `contentHash` but the record does not: the fingerprint of a half-failed sync. | Re-sync |
| `missing-note` | A declared note is not installed (said louder for a persistent note, where saved data may be gone). | Re-sync |
| `missing-attachment` | A declared attachment is not on its note. Trilium only ever logs this server-side. | Re-sync |
| `content-drift` | An installed note's sha256 does not match the manifest's `sha`. | Re-sync |
| `broken-wiring` | A declared parenting, relation, or label is not applied. Catches at runtime the direct-child `require()` case `validate` cannot see at build time. | Re-sync |
| `duplicate-child-title` | Two children of one note share a title, which makes Trilium's script bundle fail to parse (duplicate parameter name) and silently stops the note running. | Detach the stale copy |

Notes on how the audit stays honest:

- **A row carries `fixes[]`, not one fix**, because an unreachable source is a real choice:
  repoint at a catalog's copy, or accept it is gone. Uninstall dispatches TAM's normal uninstall
  flow, so the dangling-reference and delete-my-data questions are still asked; TAM never offers
  itself for uninstall.
- **Repair means re-sync** for anything an addon owns: the sync already recreates missing notes,
  rewrites drifted content, and re-applies wiring, so there is no second repair path to keep
  correct, and persistent notes still route through the review. Repairs run as non-manual syncs.
  After a repair the audit re-runs rather than striking the row, because one re-sync routinely
  settles several rows.
- **The content check skips what is not the source file**: persistent and `skipOnUpdate` notes
  (they hold live state and would report drift forever), `renderAsHTML` notes (they store rendered
  HTML, not the hashed markdown), and binaries (not worth shipping to hash). Resolution mirrors
  the sync's, including shared-note adoption, or every shared library would be reported missing.
  The self-aliasing case (one addon declaring one file twice) is the known permanent
  `broken-wiring` row no re-sync can clear, which is why adoption never takes this addon's own
  copy in the first place.
- **TAM repairs itself with a reload.** Rewriting a running script note is safe (the loaded copy
  lives in memory), but treating the repair as finished is not: the next diagnosis would come from
  the pre-repair build. A self-repair therefore returns `requiresReload`, and the UI pins a banner
  until Trilium is reloaded.

---

## The activity log

Long operations used to hide behind a blocking spinner that named only the running command. The
activity log replaces it: an in-memory, capped, non-persisted feed (`log`, `subscribeToLog`) that
every operation writes to, so a long update-all names the addon and note it is on. Errors also go
to `console.error`, since a stack trace outlives the panel.

It renders as a dismissable full-screen page that opens itself when a command starts (not while
one runs, so dismissing sticks until the next command; catalog browsing is excluded because that
view has its own spinner). Dismissing never cancels anything. While work is in flight the header
shows a spinner and the command; idle, it says so explicitly, since a page that opened itself has
to say when it is done. It reopens any time from Settings.
