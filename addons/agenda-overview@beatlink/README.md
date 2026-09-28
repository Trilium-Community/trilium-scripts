# Agenda Overview

A right-pane widget that re-files the active profile's matching notes under a single shared overview
note, shown as a built-in Trilium collection view (list / table / board), and writes the same task list
out as an iCal feed. It also owns the agenda configuration those rules live in — the profiles, and the
searches/filters/sorts/prefixes/colors/groupings/date-rules those profiles reference — and the
**Agenda Settings** page that edits all of it.

Self-contained: it ships no other addon's code, and the only settings note it reads besides its own is
area-picker@beatlink's, for variants set to **By Area** (see Configuration). The Task pane
([`agenda-task@beatlink`](../agenda-task@beatlink/README.md)), the My Day focus panel
([`agenda-myday@beatlink`](../agenda-myday@beatlink/README.md)) and the GTD triage page
([`agenda-organize@beatlink`](../agenda-organize@beatlink/README.md)) are each their own addon on the
same footing, each owning its own settings note. They interoperate through note-label conventions and
the `agenda:tasksChanged` event, never through shared code or a shared config note.

## What the widget does

On every note, and on each `agenda:tasksChanged` event (broadcast by
[`agenda-task@beatlink`](../agenda-task@beatlink/README.md) after a task edit), it:

- resolves the active profile, its search, and its filters;
- sorts and prefixes the matching notes per the display elements the profile references;
- re-files them as clones under the profile's overview note, so opening that note shows the current
  list in whichever collection view is configured;
- regenerates the iCal feed note it ships (`#customResourceProvider agendaCalendar.ical`, served at
  `custom/agendaCalendar.ical`) from the same list, finding it by that label.

The widget itself offers the profile picker, the collection-view picker, the folder path picker, and a
link through to the Agenda Settings page.

### Folders

A profile can file its tasks into generated folders instead of directly under the overview note. Each
entry on the settings page's **Folders** tab is an ordered list of groupings, one per level of nesting:
*By Area* then *By Priority* gives a folder per area, each holding a folder per priority.
A level's **Group By** is either an entry from the Groupings tab or one of the installed pickers
(By Area, By Priority, By Template); a level whose picker is uninstalled drops out.
Tick a level's **Always Expanded** to keep its folders open in the note tree. That works through
[`expanded@beatlink`](../expanded@beatlink/README.md)'s label, so it needs that addon installed. The widget's
**Folders** dropdown lists these entries as breadcrumbs (`By Area → By Priority`), plus **None**.

- A folder exists only while it holds tasks, and folders follow the grouping's own order and colour.
- A task no group matches goes into that level's catch-all folder, named by the grouping's no-value
  display, or **Other** when it has none.
- Every folder is a collection note using the profile's collection view, so a board inside a folder
  gets the same columns as the overview would.
- Generated folders carry `#agendaOverviewFolder` and are rebuilt on every refresh, so anything you
  file into one by hand is removed again.

## Configuration

The config lives in one settings note holding a `schema.json`/`defaults.json`/`config.json` set. That
note is tagged **`#agendaOverviewConfig`** and resolved at runtime by `getAgendaSettings()` in
[`lib/settings.js`](lib/settings.js). What it holds is small: your profiles, the date rules, and the
date/recurrence display elements. **Nothing about area, priority or template is stored here at all.**

## Generated from the pickers

Whenever one of these addons is installed, this one stands up a full set of entries for it, live from
that addon's own settings note:

| Picker | Reads | Classifies by |
| ------ | ----- | ------------- |
| [`area-picker@beatlink`](../area-picker@beatlink/README.md) | `#areaConfig` | `#area`, whose value is the key behind its position (`01-career`) |
| [`priority-widget@beatlink`](../priority-widget@beatlink/README.md) | `#priorityConfig` | the active profile's own label, usually `#priority` |
| [`template-picker@beatlink`](../template-picker@beatlink/README.md) | `#templatePickerConfig` | a note's `~template` relation, keyed by the template note's id |

Each one generates six things, keyed `picker-<name>` so they can never collide with an entry of your
own: a **prefix**, a **colour**, a **grouping**, a **sort** (that picker's order, then start date), a
**search group** and a **filter group** — the last two per profile, since each profile keeps its own
on/off state. Every value starts ticked in both, so installing a picker surfaces everything it knows
about and you turn off what you don't want. A generated **template** search also skips notes filed
directly under another note of the same template — a task under a task is part of that task, not a
separate item — so the overview stays a list of work rather than a flattened tree. Area and priority
searches carry no such clause: those axes group notes, they don't nest them. Those flags are the one part that is yours and is
remembered; the names, colours, rules and order are re-read every time, so renaming an area or adding
a template shows up immediately and nothing here can drift from the addon that owns it.

Uninstall a picker and its entries leave with it — a profile pointing at one falls back to no
colours/prefixes, its groups vanish rather than filtering everything away, and its sort criterion
drops out while the criteria after it still apply. Nothing errors, and nothing is left behind to edit.

The corollary is worth saying plainly: **with none of the pickers installed, a fresh install has no
searches, so the overview is empty.** Install the picker for the axis you work in, or build a search
group by hand.

You can still point an entry of your own at a picker: a prefix, colour or grouping's **Type**, a
search or filter group's **Source**, and a sort criterion's **Sort By** all offer By Area / By
Priority / By Template. The generated entries are simply those, pre-made.

A note on template-picker: it fills in template note ids with its **Scan**, so run that once. Until
then its registry has nothing resolvable and a By Template entry behaves as if the addon weren't
installed. Classifying a note remains
[`agenda-organize@beatlink`](../agenda-organize@beatlink/README.md)'s job, out of its own vocabulary.

### Config migrations

Adding a new default sort/colour/prefix/etc. reaches existing installs for free — a registry's
entries in `defaults.json` are its *shipped* entry set, reconciled into every install on read/write,
so no migration is needed for additive changes. Reshaping data the user already owns (renaming a stored
key, moving a value between fields, dropping a field) is what [`lib/migrate.js`](lib/migrate.js)
handles: an ordered list of one-time transforms of the raw persisted config, gated by a
`#agendaConfigVersion` label on the settings note so each step runs exactly once per install.
`getAgendaSettings()` runs any pending steps before the first read. The shipped list is empty (nothing
to reshape yet); adding a step is push-one-entry + bump the version.

## Upgrading from 4.x

Version 5.0.0 stops shipping any copy of a picker's vocabulary. Where 4.x shipped `area`, `priority`
and `template` entries that you could point at a picker, 5.0.0 ships none of them and generates the
whole set — prefix, colour, grouping, sort, search group, filter group — for each picker you have
installed. See **Generated from the pickers** above.

What this removes from `defaults.json`:

- the `area`, `priority` and `template` prefix, colour, grouping and filter entries;
- the eight curated template search rules (`~template.title='3. Task'` and friends) and the two
  leaf-task variants. The generated searches match on the template's note id instead and keep the
  "not nested under the same template" exclusion. Two things about them do not come back: the curated
  rules also excluded anything filed under a **Task** specifically, whatever its own template, and the
  leaf-task rules selected on a note's *children*. Both are query logic rather than vocabulary, so
  nothing generates them — they are in this addon's git history and paste straight into a
  hand-written search group;
- the five sorts that ordered by area, priority or `#type`. Each picker now generates its own
  `<Name> → Start Date` sort. Three of those five ordered by `#type`, a label nothing has written
  since item type became a `~template` relation, so they had been silently doing nothing.

`startDate`, `title`, the date and recurrence elements, and the date/recurrence filter groups are
untouched — no picker owns those.

Your config is repointed automatically on the first read by a
[`lib/migrate.js`](lib/migrate.js) step: profiles that selected `area`/`priority`/`template` now
select `picker-…`, and a stored search or filter group under those ids moves to its per-profile
`picker-<name>-<profile>` id, keeping every on/off flag. Stored *edits* to a shipped area/priority
variant are dropped, because what they edited was a copy of a vocabulary that lives in the picker.

**Sorting behaviour changes twice over.** Sorting by `#area` follows the picker's configured order
again rather than the alphabet (4.0.0 had lost the ordinals along with the dimensions registry), and
the shipped priority sorts lose their descending flag, since the picker lists `4-critical` first and
ascending now means the same thing.

## Upgrading from 3.x

Version 4.0.0 also merges the **Display Elements** category into **Review**, so Sorts, Prefixes,
Colors, Groupings and Date Rules are tabs on the same page as Profiles, Searches and Filters. That
part is presentation only: no setting moves, is renamed, or changes shape.

The substantive change is the removal of the `dimensions` registry, and the whole derivation layer
with it. Area and priority are no longer a vocabulary that generates a prefix, colour, grouping and
filter variant at read time; each of those is a plain hand-written entry on its own tab, shipped in
`defaults.json` and yours to edit. The **Dimensions** tab is gone.

Your existing config is carried across automatically on the first read: a
[`lib/migrate.js`](lib/migrate.js) step folds every stored dimension into the four variants, keyed by
the dimension's own id, and repoints any profile that selected a derived `dim-…` entry at the new one.
Filter groups keep each child's enabled/disabled state, which was the one part of the derivation that
was ever persisted. A dimension you added yourself comes through as four ordinary entries you can now
edit independently — and, being independent, they can now drift from each other, which is the cost of
the flatter model.

Two behaviours change that no migration can preserve:

- **Sorting by `#area` was alphabetical for one version.** Value order used to come from the
  dimension's registry position, and with no registry there was nothing to derive an ordinal from.
  5.0.0 restores configured order by taking it from the picker instead — see below.
- **The overview's Area and Priority columns are gone.** The promoted attributes on the overview note
  were generated one per dimension; the four fixed columns (Start, Due, Duration, Recurrence) stay.

## Upgrading from 2.x

Version 3.0.0 absorbs `agenda@beatlink`, which no longer exists. That addon had become a config store
with this widget as its only consumer, and this widget could not be installed without it; the two are
now one addon that stands on its own.

**If you have `agenda@beatlink` installed, run
[`migrate-config-from-agenda.js`](migrate-config-from-agenda.js) once, manually, before updating** —
otherwise TAM's next sync deletes your config note (every profile, search, filter, sort, prefix,
colour and grouping) and creates a fresh empty one here. See that script's own header comment
for exact steps. Afterwards, update this addon and uninstall `agenda@beatlink`.

Two things change beyond the move:

- The settings note's anchor label is **`#agendaOverviewConfig`**, not `#agendaConfig`. Nothing else
  reads it, and the rename is what keeps the two anchors apart while both addons are installed
  mid-upgrade.
- `lib/settings.js` and `lib/migrate.js` are this addon's own sources now, rather than copies pulled
  out of `agenda@beatlink`'s folder by relative `sourceUrl`.

## Layout

Sources are grouped by kind, and note titles match the file names:

| Folder | Holds |
| ------ | ----- |
| `ui/` | `Overview.jsx` (the right-pane widget), `overview.css`, `Settings.jsx` (the Agenda Settings page), `settings.css` |
| `lib/` | `overview.js` (re-filing and the iCal write), `query.js` (search + filter + sort), `config.js` (the display elements), `settings.js` (`getAgendaSettings()`), `migrate.js` |

`lib/` also carries [`libpickersources`](../../libs/libpickersources/README.md)'s `pickerSources.js`, the shared table that reads the three pickers — `agenda-organize@beatlink` generates its triage queues from the same one.
| `config/` | `schema.json`, `defaults.json` |
| `static/` | `calendar.ical` — the seed body of the iCal feed note |

Trilium resolves an `import` / `require` by note title within the importer's subtree, not by path, so
the folders are a repo-side convention only.
