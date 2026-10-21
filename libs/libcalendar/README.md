# Calendar

Library for generating an iCalendar (RFC 5545) feed from a list of notes, and serving it as an HTTP
response. Combines the best of two prior implementations (the legacy `Calendar` addon's
direct-search + `customRequestHandler`-served approach, and `libagendaoverview@beatlink`'s
richer profile-driven task list) into one deduplicated core: this library doesn't search for notes
or know what a "profile" is — it just turns an already-resolved note list into an ics string, and
knows how to send that string back as a proper HTTP response. Depends on
[libical@kewisch](../libical@kewisch/).

`generateCalendar` is pure (no environment-specific API calls) and genuinely needed from both a
frontend script (`libagendaoverview@beatlink`, which uses it directly instead of duplicating its own
ical-building loop) and a backend `customRequestHandler` (`simplecalendar@beatlink`). Trilium's
bundler only lets a note `require()` another note of the *same* environment though — there's no
environment-agnostic note type — so this library ships two exports built from the identical
`libCalendar.js` source file (no source duplication, just note duplication, which is unavoidable):

| Export    | `env`      | Depends on `libical@kewisch`'s |
|-----------|------------|----------------------------------|
| `lib`     | `frontend` | `lib` (frontend) export          |
| `backend` | `backend`  | `backend` export                 |

`respondWithCalendar` only makes sense called from the `backend` export (it uses `api.res`), but it
being defined-and-unused in the `lib` (frontend) export is harmless — nothing there calls it.

## Usage

Install as a dependency and clone whichever export matches your own note's environment as a child:

```js
const { generateCalendar, respondWithCalendar } = require("libCalendar.js")

if (api.req.method === "GET") {
    const notes = api.searchForNotes(searchQuery)
    const icalString = generateCalendar(notes, { startDateLabel, dueDateLabel })
    respondWithCalendar(api, icalString)
} else {
    api.res.send(400)
}
```

Wiring up the actual endpoint — the `customRequestHandler` label, the request method check, any
auth — is entirely the calling script's responsibility; this library has no opinion on any of that.

## API

### `generateCalendar(notes, options)`

Pure function — no note mutation, no HTTP. Builds an ics string from `notes` (an array of
already-resolved note objects — this library doesn't search or resolve ids itself). Only notes with
both a start and due date produce a `VEVENT`; a note's recurrence label value (if present) becomes
that event's `RRULE`.

`options`:

| Key               | Required | Description                                            |
|-------------------|----------|----------------------------------------------------------|
| `startDateLabel`  | yes      | Label name holding each note's start datetime            |
| `dueDateLabel`    | yes      | Label name holding each note's due datetime               |
| `recurrenceLabel` | no       | Label name holding an RRULE string, or one RRULE per line for several (default `"recurrence"`) |
| `prodId`          | no       | iCalendar `PRODID` value (default `-//Beatlink/Trilium Calendar Script`) |

### `respondWithCalendar(api, icalString)`

Sets the correct `Content-Type` and sends `icalString` as the HTTP response body, given the `api`
object a `customRequestHandler` script receives (`api.req`/`api.res`).

## Why no "save to a note" function

Both prior implementations wrote the generated ics to a note's content first, then served that note
(a `customResourceProvider`-style static-file round trip). Since a `customRequestHandler` can just
generate-and-serve fresh data on every request, that round trip isn't needed — if a caller *also*
wants the ics content persisted somewhere (e.g. for manual viewing inside Trilium), that's one line
(`api.getNote(id).setContent(icalString)`) and not worth a wrapper function here.
