/*
 * Body Metrics data model. Pure functions over the JSON document stored in the
 * addon's persisted Database note:
 *   {
 *     metrics: [ { id, name, kind, unit, goal, comment } ],
 *     log: { [date]: { values: { [metricId]: number }, comment } }
 *   }
 * A metric is one thing being measured (weight, waist, resting heart rate) and
 * the array order is the order it is shown in everywhere. A log day holds at
 * most one reading per metric. `kind` decides the unit label: weight and length
 * take theirs from settings (kg/lb, cm/in), percent is always %, and custom uses
 * the metric's own `unit`. Units are display labels, never conversions, so
 * changing one never rewrites recorded numbers. `date` is an ISO "YYYY-MM-DD"
 * string. A goal of 0 means none is set.
 */

const KINDS = [
    { key: "weight", label: "Weight" },
    { key: "length", label: "Length" },
    { key: "percent", label: "Percent" },
    { key: "custom", label: "Custom Unit" }
]

function newId() {
    return Math.random().toString(36).slice(2, 10)
}

function kindOf(metric) {
    return KINDS.find(kind => kind.key === metric?.kind) || KINDS[0]
}

function metricUnit(metric, units) {
    switch (kindOf(metric).key) {
        case "weight": return units.weight
        case "length": return units.length
        case "percent": return "%"
        default: return metric.unit
    }
}

function nonNegativeNumber(raw) {
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
}

function trimmedString(raw) {
    return typeof raw === "string" ? raw.trim() : ""
}

function normalizeMetric(metric) {
    return {
        id: trimmedString(metric?.id) || newId(),
        name: trimmedString(metric?.name) || "Metric",
        kind: kindOf(metric).key,
        unit: trimmedString(metric?.unit),
        goal: nonNegativeNumber(metric?.goal),
        comment: trimmedString(metric?.comment)
    }
}

// Blank or non-positive readings are dropped, so a cleared field leaves nothing behind.
function normalizeDay(day) {
    const values = {}
    if (day?.values && typeof day.values === "object") {
        for (const [id, raw] of Object.entries(day.values)) {
            const value = nonNegativeNumber(raw)
            if (value > 0) values[id] = value
        }
    }
    return { values, comment: trimmedString(day?.comment) }
}

function dayIsEmpty(day) {
    return Object.keys(day.values).length === 0 && !day.comment
}

/*
 * The Database note is a JSON code note, so its content is raw JSON.
 * Unparseable content becomes an empty database rather than throwing in the
 * widget's render path.
 */
function parseDatabase(content) {
    let parsed = null
    try {
        parsed = content ? JSON.parse(String(content).trim()) : null
    } catch {
        parsed = null
    }
    const metrics = Array.isArray(parsed?.metrics) ? parsed.metrics.map(normalizeMetric) : []
    const log = {}
    if (parsed?.log && typeof parsed.log === "object") {
        for (const [date, day] of Object.entries(parsed.log)) {
            const normalized = normalizeDay(day)
            if (!dayIsEmpty(normalized)) log[date] = normalized
        }
    }
    return { metrics, log }
}

function serializeDatabase(database) {
    return JSON.stringify(database, null, 4)
}

// Writes one day back, dropping its key once nothing is left in it.
function setDay(database, date, day) {
    const normalized = normalizeDay(day)
    const log = { ...database.log }
    if (dayIsEmpty(normalized)) delete log[date]
    else log[date] = normalized
    return { ...database, log }
}

// Swaps a metric with its neighbour, which is what the up/down arrows mean.
function moveMetric(database, metricId, delta) {
    const index = database.metrics.findIndex(metric => metric.id === metricId)
    const target = index + delta
    if (index < 0 || target < 0 || target >= database.metrics.length) return database
    const metrics = [...database.metrics]
    metrics[index] = database.metrics[target]
    metrics[target] = database.metrics[index]
    return { ...database, metrics }
}

// Every reading of one metric, oldest first.
function metricSeries(database, metricId) {
    return Object.keys(database.log)
        .sort()
        .filter(date => database.log[date].values[metricId] > 0)
        .map(date => ({ date, value: database.log[date].values[metricId] }))
}

// The most recent reading on or before `date`, used to carry weight into BMI.
function latestReading(database, metricId, date) {
    const series = metricSeries(database, metricId).filter(point => point.date <= date)
    return series.at(-1) || null
}

/*
 * Each point's average over the readings in the `days` days ending on it, so
 * day-to-day noise such as water weight smooths into the underlying trend.
 */
function movingAverage(series, days) {
    return series.map(point => {
        const from = shiftDateKey(point.date, -(days - 1))
        const window = series.filter(other => other.date >= from && other.date <= point.date)
        return { date: point.date, value: window.reduce((sum, other) => sum + other.value, 0) / window.length }
    })
}

// Summary numbers for one series; `change` is last minus first.
function seriesStats(series) {
    if (series.length === 0) return null
    const values = series.map(point => point.value)
    return {
        first: series[0],
        latest: series.at(-1),
        change: series.at(-1).value - series[0].value,
        min: Math.min(...values),
        max: Math.max(...values),
        count: series.length
    }
}

// Body mass index from a weight and a height, in whichever unit pair settings name.
function bodyMassIndex(weight, height, units) {
    if (!(weight > 0) || !(height > 0)) return 0
    const kilograms = units.weight === "lb" ? weight * 0.45359237 : weight
    const metres = units.length === "in" ? height * 0.0254 : height / 100
    return kilograms / (metres * metres)
}

// Today in local time, so an evening reading lands on the day it was taken.
function todayKey(date = new Date()) {
    const pad = value => String(value).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function shiftDateKey(dateKey, deltaDays) {
    const date = new Date(`${dateKey}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + deltaDays)
    return date.toISOString().slice(0, 10)
}

/*
 * Import accepts the same document shape serializeDatabase writes. Throws on
 * anything that isn't recognisably a database so the caller can report it
 * rather than silently wiping existing data.
 */
function importDatabase(text) {
    let parsed
    try {
        parsed = JSON.parse(String(text).trim())
    } catch {
        throw new Error("Not valid JSON.")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.metrics)) {
        throw new Error("Expected a JSON object with metrics/log.")
    }
    return parseDatabase(JSON.stringify(parsed))
}

/*
 * Merges by id: new metrics are appended, and on a day both hold, readings
 * already present win, so importing the same file twice changes nothing.
 */
function mergeDatabase(current, imported) {
    const known = new Set(current.metrics.map(metric => metric.id))
    const metrics = [...current.metrics, ...imported.metrics.filter(metric => !known.has(metric.id))]
    const log = { ...current.log }
    for (const [date, day] of Object.entries(imported.log)) {
        const existing = log[date]
        log[date] = existing
            ? { values: { ...day.values, ...existing.values }, comment: existing.comment || day.comment }
            : day
    }
    return { metrics, log }
}

module.exports = {
    KINDS,
    newId,
    kindOf,
    metricUnit,
    normalizeMetric,
    normalizeDay,
    parseDatabase,
    serializeDatabase,
    setDay,
    moveMetric,
    metricSeries,
    latestReading,
    movingAverage,
    seriesStats,
    bodyMassIndex,
    todayKey,
    shiftDateKey,
    importDatabase,
    mergeDatabase
}
