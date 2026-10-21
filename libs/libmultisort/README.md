# MultiSort Library

Shared library for sorting TriliumNext notes by multiple attributes. Used as a dependency by addons that need multi-criteria sorting of notes in memory; to keep a parent's children sorted, use Trilium's native `#sorted="priority desc, dueDate"` instead.

## Usage

Install this addon as a dependency. TAM clones the `libMultisort.js` note as a child of any script
that declares it; `require()` it by that title (the note title is what Trilium's bundler resolves
`require()` calls against, so keeping it a distinctive, fully-qualified name avoids collisions with
other libraries):

```js
const { sortChildNotes } = require("libMultisort.js");
const sorted = sortChildNotes(sortString, childNotes);
```

## Sort string format

Attributes are separated by `;`. Each attribute can have colon-separated criteria flags.

```
priority:desc;area;startDateTime;title:caseInsensitive
```

| Flag              | Effect                          |
|-------------------|---------------------------------|
| `desc`            | Sort descending                 |
| `caseInsensitive` | Ignore case when comparing      |

## Built-in attributes

`noteId`, `title`, `dateCreated`, `dateModified` are read directly from the note object. All other attribute names are resolved via `note.getLabelValue()`.

## Relation attributes

An attribute written `~name` sorts by `note.getRelationValue("name")` — the noteId the relation points at — instead of a label:

```
~template;startDateTime
```

A raw noteId has no meaningful order of its own, so this is only useful with a `valueMaps` entry (below) turning those ids into ordinals.

## `valueMaps`

`sortChildNotes(sortString, childNotes, valueMaps)` takes an optional `{ attribute: { value: ordinal } }` map, for attributes whose values carry no intrinsic order — a vocabulary whose display order lives in config rather than in the stored value. A value missing from its map sorts after every mapped one, so retired values collect at the end. The key is the attribute exactly as it appears in the sort string, `~` included.

## API

### `sortChildNotes(sortString, childNotes, valueMaps?)`

Returns a new sorted array of notes. Does not mutate the input.

### `parseSortCriteria(sortString)`

Returns the parsed criteria array — useful for debugging or building custom sort logic.
