# Agenda Task

A right-pane widget for the start/due dates, duration and recurrence of a note, or of a whole tree
multi-selection at once, plus an Actions section with Complete Task and a row of reschedule buttons.
Split out from the original agenda addon (whose Overview widget is now `agenda-overview@beatlink`)
so Task can be installed, updated, and configured independently — the two addons share no code or
settings.

Dates and Duration and Actions are collapsible disclosures, open by default. Recurrence is a single
button reading the current rule back in plain English ("Every 2 weeks on Monday", or "Does not
repeat"); clicking it opens the recurrence picker in a popover. The pane scrolls vertically when
its sections outgrow the window.

The picker and the rule handling (plain-English text, the next occurrence on completion, reschedule
dates) come from [recurrence-input](https://github.com/BeatLink/Recurrence-Widget), loaded from a
URL pinned to the commit of one npm release. The "Update recurrence-input" workflow checks npm daily
and opens a pull request moving the pin to the newest release in the same major version (also
`node resources/scripts/tamhelper.js bump-recurrence-input` by hand); a new major version is left to
a person, since it can change how rules are stored. The picker covers every RFC 5545 rule
part (several times a day, several days or weekdays of the month, and "only the last of those"),
using recurrence-input's `standard` feature set, which leaves out the raw More options section; editing
a rule keeps anything it does not show exactly as written.

A task whose times differ by day, such as 14:00 on weekends and 18:00 on weekdays, can have several
rules: "Add another rule" in the picker adds one, and the label then holds one standard `RRULE:` line
per rule. Completing or rescheduling the task takes the earliest next date across them, and the
iCalendar feed writes each line as its own `RRULE`. RFC 5545 discourages more than one `RRULE` per
event, so some calendar apps show only the first rule; Trilium itself uses all of them. Rules are stored in floating local time, so an end date is written without a `Z`, as the
iCalendar feed's floating start times require; older rules with a `Z` still read the same.

## How it works

The widget appears in the right pane on any note whose type is marked actionable (`#agendaTaskWidget`
inheritable label, set by the item's template). It edits four kinds of note labels — start/due
datetime, duration, recurrence — via configurable label names, plus fires `agenda:tasksChanged` after
any change so `agenda-overview@beatlink`'s widget (if installed) re-files the note.

## Working on several tasks at once

Select notes in the tree (alt-click, or shift-click for a range) and the widget retargets at that
whole selection, the way `area-picker@beatlink` and `template-picker@beatlink` do: the header counts
what it will write to ("Task (3 notes)"), every field writes to all of them, and Complete Task and
the reschedule buttons run over each in turn. Notes in the selection that aren't tasks are dropped,
so the widget only ever writes task labels to notes marked actionable. With nothing selected it stays
on the active note.

A field whose targets disagree reads `— Mixed —` and stays that way until a value is chosen, which
then applies to all of them.

Completing a task with a recurrence rolls its start date forward instead of leaving it done; the
reschedule buttons offer a configurable set of quick date jumps (fixed days-from-now or a recurrence
rule evaluated from now). The stock set is Today, Tomorrow, Next Weekend (`FREQ=WEEKLY;BYDAY=SA`) and
End of Month (`FREQ=MONTHLY;BYMONTHDAY=-1`).

## Configuration

Task owns its own settings note (`taskSchema.json`/`taskDefaults.json`/`taskConfig.json`) tagged `#agendaTaskConfig` — the label
names it reads/writes (start/due date/time, duration, recurrence) and the reschedule buttons' option
registry. Its own **Task Settings** page (TAM's "Addon Settings" button) is the only place that edits
it.

## Independence from the other agenda addons

Task used to live inside the original agenda addon (`task/` folder), sharing its settings note. The
two are now fully decoupled in both directions: neither ships the other's code, neither reads the
other's settings note, and neither declares the other as a TAM dependency. Either one runs on its own.

What they still share is a vocabulary, not a wire:

| Convention | Who writes it | Who reads it |
|---|---|---|
| start/due datetime + recurrence label names | this addon | `agenda-overview@beatlink` and `agenda-myday@beatlink`, each from their own copy of the setting |
| `durationDisplay` / `recurrenceDisplay` | this addon | `agenda-overview@beatlink`'s overview columns, if installed |
| `agenda:tasksChanged` (`api.triggerEvent`) | this addon, after any change | `agenda-overview@beatlink`, if installed |
| `#agendaTaskWidget` (inheritable, from the item's template) | `template-picker@beatlink`'s templates | this addon, to decide whether the pane shows |

The cost of that independence: renaming a label name here means renaming it in each other installed
addon that reads it. Nothing detects the drift for you.

## Upgrading from 2.x

Version 3.0.0 removes the one-time migration that copied label names and Reschedule Options out of
the old shared agenda config note. Any install that ran a 2.x version at least once has already
migrated and is unaffected. Installing 3.0.0 fresh onto a pre-4.0.0 agenda gets the default label names
instead of the old shared ones — re-enter them on the Task Settings page if you had customized them.
