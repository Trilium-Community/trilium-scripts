const recurrence = require("recurrence-input.js")

function durationStringToHMS(duration) {
    const parsed = api.dayjs.duration(duration)
    return {
        hours: parsed.hours(),
        minutes: parsed.minutes(),
        seconds: parsed.seconds()
    }
}

function humanizeDuration(duration) {
    if (!duration) return ""
    const { hours, minutes, seconds } = durationStringToHMS(duration)
    const parts = []
    if (hours) parts.push(`${hours}h`)
    if (minutes) parts.push(`${minutes}m`)
    if (seconds) parts.push(`${seconds}s`)
    return parts.length ? parts.join(" ") : "0m"
}

async function markUndone(noteId) {
    await api.runOnBackend((noteId) => {
        function markNoteAndChildrenUndone(note) {
            note.setContent(note.getContent().replaceAll('checked="checked"', ""), { forceSave: true })
            note.removeLabel("archived")
            for (const child of note.getChildNotes()) {
                markNoteAndChildrenUndone(child)
            }
        }
        markNoteAndChildrenUndone(api.getNote(noteId))
    }, [noteId])
}

async function markDone(noteId) {
    await api.runOnBackend((noteId) => {
        api.getNote(noteId).setLabel("archived")
    }, [noteId])
}

// Write one label across a whole selection of tasks in a single backend round
// trip. An empty value is stored as an empty label rather than removed, which
// is what clearing a field through the widget has always done.
async function setTaskLabel(noteIds, name, value) {
    await api.runOnBackend((noteIds, name, value) => {
        for (const noteId of noteIds) {
            const note = api.getNote(noteId)
            if (note) note.setLabel(name, value)
        }
    }, [noteIds, name, value ?? ""])
}

// A recurrence label holds one rule, or several standard RRULE lines when a task's times differ by day.
function splitRules(value) {
    return (value || "").split(/\r?\n/).map(line => line.trim().replace(/^RRULE:/i, "")).filter(Boolean)
}

// Joins rules back into a label value: a bare rule when there is one, RRULE lines when there are several.
function joinRules(rules) {
    const kept = rules.filter(Boolean)
    return kept.length > 1 ? kept.map(rule => `RRULE:${rule}`).join("\n") : (kept[0] || "")
}

// Describes every rule in plain English; recurrence times are local clock times, which recurrence-input calls "floating".
function humanizeRecurrence(value) {
    const descriptions = splitRules(value).map(rule => recurrence.describe_rule(rule, "floating"))
    if (descriptions.some(description => !description)) return ""
    return descriptions.map((description, index) => index ? description.charAt(0).toLowerCase() + description.slice(1) : description).join("; and ")
}

// Returns the earliest next occurrence across the rules and the label value to keep, or null once every rule has ended.
function nextRecurrence(value, startDate) {
    const rules = splitRules(value)
    const nexts = rules.map(rule => recurrence.next_occurrence(rule, startDate, "floating"))
    const earliest = nexts.reduce((best, next, index) => (next && (best < 0 || next.next_date < nexts[best].next_date) ? index : best), -1)
    if (earliest < 0) return null
    const kept = rules.map((rule, index) => (index === earliest ? nexts[index].rule : rule)).filter((rule, index) => nexts[index])
    return { nextDate: nexts[earliest].next_date, recurrence: joinRules(kept) }
}

// Returns the earliest occurrence from now across the rules, or null when none yields one.
function nextRecurrenceFromNow(value) {
    const dates = splitRules(value).map(rule => recurrence.next_from_now(rule, "floating")).filter(Boolean)
    return dates.length ? new Date(Math.min(...dates)) : null
}

async function updateDependentAttributes(noteId, constants) {
    if (!noteId) return

    const note = await api.getNote(noteId)
    const durationDisplay = humanizeDuration(note.getLabelValue(constants.DURATION_LABEL))
    const recurrenceDisplay = humanizeRecurrence(note.getLabelValue(constants.RECURRENCE_LABEL))

    await api.runOnBackend((noteId, constants, durationDisplay, recurrenceDisplay) => {
        const note = api.getNote(noteId)
        const startDatetime = note.getLabelValue(constants.START_DATETIME_LABEL)
        const duration = note.getLabelValue(constants.DURATION_LABEL)

        // Append the duration to the title, e.g. "Meeting (1h)".
        const titleWithoutSuffix = note.title.replace(/\s*\([^)]*\)\s*$/, "")
        const durationSuffix = duration ? ` (${duration.substring(2).toLowerCase()})` : ""
        note.title = `${titleWithoutSuffix}${durationSuffix}`
        note.save()

        if (durationDisplay) note.setLabel("durationDisplay", durationDisplay)
        else note.removeLabel("durationDisplay")
        if (recurrenceDisplay) note.setLabel("recurrenceDisplay", recurrenceDisplay)
        else note.removeLabel("recurrenceDisplay")

        // Derive the due datetime from start + duration when both are present.
        let dueDatetime = note.getLabelValue(constants.DUE_DATETIME_LABEL)
        if (startDatetime && duration) {
            dueDatetime = api.dayjs(startDatetime)
                .add(api.dayjs.duration(duration))
                .format("YYYY-MM-DDTHH:mm")
            note.setLabel(constants.DUE_DATETIME_LABEL, dueDatetime)
        }

        // Split start/due datetimes into their separate date and time labels.
        if (startDatetime) {
            note.setLabel(constants.START_DATE_LABEL, api.dayjs(startDatetime).format("YYYY-MM-DD"))
            note.setLabel(constants.START_TIME_LABEL, api.dayjs(startDatetime).format("HH:mm"))
        } else {
            note.removeLabel(constants.START_DATE_LABEL)
            note.removeLabel(constants.START_TIME_LABEL)
        }
        if (dueDatetime) {
            note.setLabel(constants.DUE_DATE_LABEL, api.dayjs(dueDatetime).format("YYYY-MM-DD"))
            note.setLabel(constants.DUE_TIME_LABEL, api.dayjs(dueDatetime).format("HH:mm"))
        } else {
            note.removeLabel(constants.DUE_DATE_LABEL)
            note.removeLabel(constants.DUE_TIME_LABEL)
        }
    }, [noteId, constants, durationDisplay, recurrenceDisplay])
}

// Marks a task complete. Recurring tasks advance to their next occurrence
// and are reset to undone; one-off tasks are archived.
async function complete(noteId, constants) {
    const note = await api.getNote(noteId)
    const startDatetime = note.getLabelValue(constants.START_DATETIME_LABEL)
    const recurrenceRule = note.getLabelValue(constants.RECURRENCE_LABEL)

    const nextOccurrence = (startDatetime && recurrenceRule)
        ? nextRecurrence(recurrenceRule, api.dayjs(startDatetime).toDate())
        : null

    if (nextOccurrence) {
        const nextStartDatetime = api.dayjs(nextOccurrence.nextDate).format("YYYY-MM-DDTHH:mm")
        await api.runOnBackend((noteId, recurrence, startDatetime, constants) => {
            const note = api.getNote(noteId)
            note.setLabel(constants.START_DATETIME_LABEL, startDatetime)
            note.setLabel(constants.RECURRENCE_LABEL, recurrence)
        }, [noteId, nextOccurrence.recurrence, nextStartDatetime, constants])
        await markUndone(noteId)
        // The task lives on at its next occurrence, so it only leaves today if
        // that occurrence isn't today.
        await clearMyDayFlagIfNotToday(noteId, constants)
    } else {
        await markDone(noteId)
        // Done and archived. It keeps its start date, so the "still today"
        // check would wrongly hold the flag - clear it outright.
        await clearMyDayFlag(noteId)
    }

    await updateDependentAttributes(noteId, constants)
}

// Removes #agendaMyDay, the label agenda-myday@beatlink uses to track which
// tasks are on the My Day note. Called when a task stops belonging to today.
// A plain label write: agenda-task does not depend on agenda-myday, and this is
// harmless when that addon isn't installed.
async function clearMyDayFlag(noteId) {
    await api.runOnBackend((noteId) => {
        const note = api.getNote(noteId)
        if (note) note.removeLabel("agendaMyDay")
    }, [noteId])
}

// Clears the My Day flag unless the task's new start date is still today - a
// task pushed to "later today" stays on today's page.
async function clearMyDayFlagIfNotToday(noteId, constants) {
    const note = await api.getNote(noteId)
    if (!note) return
    const startDatetime = note.getLabelValue(constants.START_DATETIME_LABEL)
    if (startDatetime && api.dayjs(startDatetime).isSame(api.dayjs(), "day")) return
    await clearMyDayFlag(noteId)
}

async function rescheduleByDays(noteId, constants, daysToAdd = 0) {
    await api.runOnBackend((noteId, daysToAdd, startDatetimeLabel) => {
        const note = api.getNote(noteId)
        const currentStart = note.getLabelValue(startDatetimeLabel)
        const timeSource = currentStart ? api.dayjs(currentStart) : api.dayjs()
        const newStart = api.dayjs()
            .add(daysToAdd, 'day')
            .hour(timeSource.hour())
            .minute(timeSource.minute())
            .startOf('minute')
            .format("YYYY-MM-DDTHH:mm")
        note.setLabel(startDatetimeLabel, newStart)
    }, [noteId, daysToAdd, constants.START_DATETIME_LABEL])
    await clearMyDayFlagIfNotToday(noteId, constants)
    await updateDependentAttributes(noteId, constants)
}

// Reschedules from a Reschedule Options entry: either a fixed number of days
// from now, or the next occurrence (from now) of a recurrence rule. A
// recurrence option that yields nothing (e.g. an exhausted count/until) is a
// no-op.
async function rescheduleByOption(noteId, constants, option) {
    if (option.mode === "recurrence") {
        const nextDate = nextRecurrenceFromNow(option.recurrence)
        if (!nextDate) return
        const newStart = api.dayjs(nextDate).format("YYYY-MM-DDTHH:mm")
        await api.runOnBackend((noteId, startDatetimeLabel, newStart) => {
            api.getNote(noteId).setLabel(startDatetimeLabel, newStart)
        }, [noteId, constants.START_DATETIME_LABEL, newStart])
        await clearMyDayFlagIfNotToday(noteId, constants)
        await updateDependentAttributes(noteId, constants)
        return
    }
    await rescheduleByDays(noteId, constants, option.days)
}

module.exports = {
    durationStringToHMS,
    humanizeDuration,
    complete,
    markDone,
    markUndone,
    rescheduleByDays,
    rescheduleByOption,
    setTaskLabel,
    updateDependentAttributes,
    clearMyDayFlag,
    clearMyDayFlagIfNotToday,
    humanizeRecurrence,
    splitRules,
    joinRules,
    nextRecurrence,
    nextRecurrenceFromNow
}
