# rrule.js

Vendored copy of rrule.js (the `rrule` npm package), by Jakub Roztočil and contributors, MIT
licensed. Implements RFC 5545 recurrence rules (`RRule`, `RRuleSet`, `rrulestr`, etc). Bundled here
verbatim, unminified logic untouched, purely so other addons in this repo don't each need to vendor
their own copy.

This is a raw vendor dependency, not a BeatLink-authored wrapper. For a recurrence picker and rule
helpers built on it, see [recurrence-input](https://github.com/BeatLink/Recurrence-Widget), which
agenda-task@beatlink loads from a commit-pinned URL.

## Usage

Install as a dependency and clone the `rrule.min.js` note as a child of the script that needs it.
The note title is kept literal (matching the upstream filename) so `require()` calls already written
against it elsewhere keep working unchanged:

```js
const libRRule = require("rrule.min.js")
const rule = new libRRule.RRule({ freq: libRRule.RRule.WEEKLY, byweekday: [libRRule.RRule.MO] })
```

recurrence-input imports this library as `rrule`, so under that module the note is titled `rrule`
instead, as in agenda-task@beatlink's manifest.
