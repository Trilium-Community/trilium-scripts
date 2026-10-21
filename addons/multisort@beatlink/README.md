# MultiSort

Trilium 0.106.0 sorts child notes by several criteria natively, so this addon no longer sorts anything itself. It moves notes still using `#multiSorted` onto the native `#sorted` label, and you can uninstall it once that has run.

## Native sorting

```
#sorted="priority desc, area, startDateTime, title"
```

Levels are separated by commas; each is `title`, `dateCreated`, `dateModified` or a label name, optionally followed by `asc` or `desc`. See Trilium's *Sorting Notes* guide for `#sortDirection`, `#top`, `#bottom` and the rest.

## What the migration does

At frontend startup, for every note labelled `#multiSorted`:

1. Converts the value: `priority:desc;area;title:caseInsensitive` becomes `#sorted="priority desc, area, title"`
2. Removes `#multiSorted` from the note and `#multiSortedValue_{parentId}` from its children

Native sorting always ignores case, so `caseInsensitive` is dropped. A `#multiSorted` value with a `~relation` criterion has no native equivalent; that note is left unchanged and reported with an error message.
