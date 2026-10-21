const ical = require("ical.min.js")

const DEFAULT_PRODID = "-//Beatlink/Trilium Calendar Script"

// Builds an iCalendar (RFC 5545) string from a list of already-resolved notes.
// Only notes with both a start and due date (per the given label names)
// produce an event; a note's recurrenceLabel value (if any) becomes that
// event's RRULE, or one RRULE per line when it holds several. Pure function — no note mutation, no HTTP, so it's usable
// from any context (a customRequestHandler, a scheduled refresh, a widget).
function generateCalendar(notes, { startDateLabel, dueDateLabel, recurrenceLabel = "recurrence", prodId = DEFAULT_PRODID }) {
    const calendar = new ical.Component(["vcalendar", [], []])
    calendar.updatePropertyWithValue("prodid", prodId)
    calendar.updatePropertyWithValue("version", "2.0")
    const now = ical.Time.now()

    for (const note of notes) {
        const startDate = note.getLabelValue(startDateLabel)
        const dueDate = note.getLabelValue(dueDateLabel)
        const recurrence = note.getLabelValue(recurrenceLabel)

        if (startDate && dueDate) {
            const vevent = new ical.Component("vevent")
            const event = new ical.Event(vevent)
            vevent.updatePropertyWithValue("dtstamp", now)
            event.uid = String(note.noteId)
            event.summary = String(note.title)
            event.startDate = ical.Time.fromJSDate(new Date(startDate))
            event.endDate = ical.Time.fromJSDate(new Date(dueDate))
            for (const rule of (recurrence || "").split(/\r?\n/).map(line => line.trim().replace(/^RRULE:/i, "")).filter(Boolean)) {
                vevent.addPropertyWithValue("rrule", ical.Recur.fromString(rule))
            }
            calendar.addSubcomponent(vevent)
        }
    }

    return calendar.toString()
}

// Sends an already-generated iCalendar string as a correctly content-typed
// HTTP response. Wiring up the actual endpoint (the customRequestHandler
// label, method checks, auth, etc.) is the calling script's own
// responsibility — this just knows how to respond once it has one.
function respondWithCalendar(api, icalString) {
    api.res.set("Content-Type", "text/calendar; charset=utf-8")
    api.res.status(200).send(icalString)
}

module.exports = { generateCalendar, respondWithCalendar }
