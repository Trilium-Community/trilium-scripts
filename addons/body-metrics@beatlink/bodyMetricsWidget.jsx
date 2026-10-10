import { useState, useEffect, useRef, useCallback, useMemo, Button } from "trilium:preact"
import { currentNote } from "trilium:api"
import { loadSettings } from "libSettingsUI.jsx"

const {
    KINDS,
    kindOf,
    metricUnit,
    normalizeMetric,
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
} = require("libBodyMetrics.js")

// Readings are taken to a tenth, so whole numbers print whole and the rest keep one decimal.
function formatNumber(value) {
    if (!Number.isFinite(value)) return "0"
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatChange(value) {
    return `${value > 0 ? "+" : ""}${formatNumber(value)}`
}

// The first weight metric is the one BMI is worked out from.
function weightMetric(database) {
    return database.metrics.find(metric => kindOf(metric).key === "weight")
}

// ---------------------------------------------------------------------------
// Log tab
// ---------------------------------------------------------------------------

/*
 * Saves on change rather than on every keystroke, so a half-typed "0.5" is not
 * normalised away as a zero before the rest of it arrives.
 */
function ReadingInput({ value, onCommit }) {
    return (
        <input
            type="number"
            step="0.1"
            min="0"
            value={value > 0 ? value : ""}
            onChange={e => onCommit(Number(e.target.value))}
        />
    )
}

function LogTab({ database, units, height, onSaveDay }) {
    const [date, setDate] = useState(() => todayKey())
    const day = database.log[date] || { values: {}, comment: "" }
    const weight = weightMetric(database)

    const setValue = useCallback((metricId, value) => {
        onSaveDay(date, { ...day, values: { ...day.values, [metricId]: value } })
    }, [date, day, onSaveDay])

    const bmiWeight = weight ? latestReading(database, weight.id, date) : null
    const bmi = bmiWeight ? bodyMassIndex(bmiWeight.value, height, units) : 0

    return (
        <div>
            <div className="body-metrics-toolbar">
                <Button icon="bx-chevron-left" title="Previous day" onClick={() => setDate(shiftDateKey(date, -1))} />
                <input type="date" value={date} onInput={e => setDate(e.target.value || todayKey())} />
                <Button icon="bx-chevron-right" title="Next day" onClick={() => setDate(shiftDateKey(date, 1))} />
                <Button icon="bx-calendar" text="Today" onClick={() => setDate(todayKey())} />
            </div>
            <table className="body-metrics-table">
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Reading</th>
                        <th>Previous</th>
                        <th>Goal</th>
                    </tr>
                </thead>
                <tbody>
                    {database.metrics.map(metric => {
                        const unit = metricUnit(metric, units)
                        const previous = latestReading(database, metric.id, shiftDateKey(date, -1))
                        const value = day.values[metric.id] || 0
                        return (
                            <tr key={`${date}-${metric.id}`}>
                                <td title={metric.comment}>{metric.name}</td>
                                <td className="body-metrics-reading">
                                    <ReadingInput value={value} onCommit={next => setValue(metric.id, next)} />
                                    <span className="body-metrics-hint">{unit}</span>
                                </td>
                                <td>
                                    {previous ? (
                                        <span>
                                            {`${formatNumber(previous.value)} ${unit}`}
                                            <span className="body-metrics-hint">{` on ${previous.date}`}</span>
                                            {value > 0 && <span className="body-metrics-hint">{` (${formatChange(value - previous.value)})`}</span>}
                                        </span>
                                    ) : "—"}
                                </td>
                                <td>{metric.goal > 0 ? `${formatNumber(metric.goal)} ${unit}` : "—"}</td>
                            </tr>
                        )
                    })}
                    {database.metrics.length === 0 && (
                        <tr><td colSpan="4" className="body-metrics-hint">No metrics. Add some in the Metrics tab.</td></tr>
                    )}
                </tbody>
            </table>
            {bmi > 0 && (
                <p className="body-metrics-hint">
                    {`BMI ${formatNumber(bmi)}, from ${formatNumber(bmiWeight.value)} ${units.weight} on ${bmiWeight.date}.`}
                </p>
            )}
            <div className="body-metrics-field">
                <label>Note</label>
                <textarea
                    key={date}
                    rows="2"
                    value={day.comment}
                    onChange={e => onSaveDay(date, { ...day, comment: e.target.value })}
                />
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Metrics tab
// ---------------------------------------------------------------------------
function MetricForm({ initial, units, onSave, onCancel }) {
    const [metric, setMetric] = useState(() => normalizeMetric(initial))
    const update = (key, value) => setMetric(current => ({ ...current, [key]: value }))

    return (
        <div className="body-metrics-form">
            <div className="body-metrics-field">
                <label>Name</label>
                <input type="text" value={metric.name} onInput={e => update("name", e.target.value)} />
            </div>
            <div className="body-metrics-field">
                <label>Measured In</label>
                <select value={metric.kind} onChange={e => update("kind", e.target.value)}>
                    {KINDS.map(kind => <option value={kind.key} key={kind.key}>{kind.label}</option>)}
                </select>
            </div>
            {metric.kind === "custom" && (
                <div className="body-metrics-field">
                    <label>Unit</label>
                    <input type="text" placeholder="bpm, mmHg, ..." value={metric.unit} onInput={e => update("unit", e.target.value)} />
                </div>
            )}
            <div className="body-metrics-field">
                <label>{`Goal (${metricUnit(metric, units) || "no unit"}, 0 for none)`}</label>
                <input type="number" step="0.1" min="0" value={metric.goal} onInput={e => update("goal", Number(e.target.value))} />
            </div>
            <div className="body-metrics-field">
                <label>Note</label>
                <textarea rows="2" value={metric.comment} onInput={e => update("comment", e.target.value)} />
            </div>
            <div className="body-metrics-form-actions">
                <Button icon="bx-check" text="Save" onClick={() => onSave(normalizeMetric(metric))} />
                <Button icon="bx-x" text="Cancel" onClick={onCancel} />
            </div>
        </div>
    )
}

function MetricsTab({ database, units, onSave, onMove, onDelete }) {
    const [editing, setEditing] = useState(null)

    if (editing) {
        return (
            <MetricForm
                initial={editing}
                units={units}
                onSave={metric => { onSave(metric); setEditing(null) }}
                onCancel={() => setEditing(null)}
            />
        )
    }

    return (
        <div>
            <div className="body-metrics-toolbar">
                <Button icon="bx-plus" text="Add Metric" onClick={() => setEditing({})} />
            </div>
            <table className="body-metrics-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Measured In</th>
                        <th>Goal</th>
                        <th>Readings</th>
                        <th>Last Taken</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {database.metrics.map((metric, index) => {
                        const unit = metricUnit(metric, units)
                        const series = metricSeries(database, metric.id)
                        return (
                            <tr key={metric.id}>
                                <td title={metric.comment}>{metric.name}</td>
                                <td>{`${kindOf(metric).label}${unit ? ` (${unit})` : ""}`}</td>
                                <td>{metric.goal > 0 ? `${formatNumber(metric.goal)} ${unit}` : "—"}</td>
                                <td>{series.length}</td>
                                <td>{series.at(-1)?.date || "—"}</td>
                                <td className="body-metrics-row-actions">
                                    <Button icon="bx-chevron-up" title="Move up" disabled={index === 0} onClick={() => onMove(metric.id, -1)} />
                                    <Button icon="bx-chevron-down" title="Move down" disabled={index === database.metrics.length - 1} onClick={() => onMove(metric.id, 1)} />
                                    <Button icon="bx-edit" title="Edit" onClick={() => setEditing(metric)} />
                                    <Button icon="bx-trash" title="Delete" onClick={() => onDelete(metric, series.length)} />
                                </td>
                            </tr>
                        )
                    })}
                    {database.metrics.length === 0 && (
                        <tr><td colSpan="6" className="body-metrics-hint">No metrics.</td></tr>
                    )}
                </tbody>
            </table>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Reports tab
// ---------------------------------------------------------------------------
const CHART = { width: 640, height: 200, left: 54, right: 12, top: 12, bottom: 26 }
const RANGES = [
    { days: 30, label: "30 days" },
    { days: 90, label: "90 days" },
    { days: 180, label: "6 months" },
    { days: 365, label: "1 year" },
    { days: 0, label: "All time" }
]
const AVERAGE_DAYS = 7

function dayNumber(dateKey) {
    return Date.parse(`${dateKey}T00:00:00Z`) / 86400000
}

/*
 * Readings as dots, their 7-day average as a line and the goal as a dashed
 * rule, drawn as inline SVG since a render note's content policy will not fetch
 * a charting library. The x axis is real time, so gaps between readings show as
 * gaps, and the vertical scale is padded around the data rather than anchored
 * at zero so a slow change still reads as one.
 */
function TrendChart({ series, average, goal, format }) {
    const geometry = useMemo(() => {
        if (series.length === 0) return null
        const values = series.map(point => point.value).concat(goal > 0 ? [goal] : [])
        const max = Math.max(...values)
        const min = Math.min(...values)
        // A series that never moves has no span to scale by, so one is invented.
        const pad = (max - min) * 0.15 || Math.max(max * 0.05, 1)
        const low = Math.max(0, min - pad)
        const high = max + pad
        const first = dayNumber(series[0].date)
        const span = dayNumber(series.at(-1).date) - first
        const innerWidth = CHART.width - CHART.left - CHART.right
        const innerHeight = CHART.height - CHART.top - CHART.bottom
        const x = date => CHART.left + (span === 0 ? innerWidth / 2 : ((dayNumber(date) - first) / span) * innerWidth)
        const y = value => CHART.top + innerHeight - ((value - low) / (high - low)) * innerHeight
        const place = point => ({ ...point, x: x(point.date), y: y(point.value) })
        return { low, high, dots: series.map(place), line: average.map(place), goalY: goal > 0 ? y(goal) : null }
    }, [series, average, goal])

    if (!geometry) return <p className="body-metrics-hint">Nothing to plot yet.</p>

    return (
        <svg className="body-metrics-chart" viewBox={`0 0 ${CHART.width} ${CHART.height}`}>
            <line className="body-metrics-chart-axis" x1={CHART.left} y1={CHART.top} x2={CHART.left} y2={CHART.height - CHART.bottom} />
            <line
                className="body-metrics-chart-axis"
                x1={CHART.left} y1={CHART.height - CHART.bottom} x2={CHART.width - CHART.right} y2={CHART.height - CHART.bottom}
            />
            <text className="body-metrics-chart-label" x={CHART.left - 6} y={CHART.top + 4} textAnchor="end">{format(geometry.high)}</text>
            <text className="body-metrics-chart-label" x={CHART.left - 6} y={CHART.height - CHART.bottom} textAnchor="end">{format(geometry.low)}</text>
            {geometry.goalY !== null && (
                <line
                    className="body-metrics-chart-goal"
                    x1={CHART.left} y1={geometry.goalY} x2={CHART.width - CHART.right} y2={geometry.goalY}
                >
                    <title>{`Goal: ${format(goal)}`}</title>
                </line>
            )}
            {geometry.line.length > 1 && (
                <polyline className="body-metrics-chart-line" points={geometry.line.map(point => `${point.x},${point.y}`).join(" ")} />
            )}
            {geometry.dots.map(point => (
                <circle className="body-metrics-chart-dot" key={point.date} cx={point.x} cy={point.y} r="3">
                    <title>{`${point.date}: ${format(point.value)}`}</title>
                </circle>
            ))}
            <text className="body-metrics-chart-label" x={CHART.left} y={CHART.height - 8}>{geometry.dots[0].date}</text>
            {geometry.dots.length > 1 && (
                <text className="body-metrics-chart-label" x={CHART.width - CHART.right} y={CHART.height - 8} textAnchor="end">
                    {geometry.dots.at(-1).date}
                </text>
            )}
        </svg>
    )
}

function MetricCard({ label, value }) {
    return (
        <div className="body-metrics-card-stat">
            <span className="body-metrics-card-value">{value}</span>
            <span className="body-metrics-card-label">{label}</span>
        </div>
    )
}

function ReportsTab({ database, units, height }) {
    const [metricId, setMetricId] = useState(() => database.metrics[0]?.id || "")
    const [days, setDays] = useState(90)

    const metric = database.metrics.find(item => item.id === metricId) || database.metrics[0]
    const unit = metric ? metricUnit(metric, units) : ""
    const format = useCallback(value => `${formatNumber(value)} ${unit}`.trim(), [unit])
    const from = days > 0 ? shiftDateKey(todayKey(), -(days - 1)) : ""

    // The average is taken over the whole series so the first days in range still have a full window behind them.
    const { series, average } = useMemo(() => {
        if (!metric) return { series: [], average: [] }
        const all = metricSeries(database, metric.id)
        return {
            series: all.filter(point => point.date >= from),
            average: movingAverage(all, AVERAGE_DAYS).filter(point => point.date >= from)
        }
    }, [database, metric, from])
    const stats = seriesStats(series)
    const isWeight = metric && metric === weightMetric(database)

    // Every day with anything logged in range, newest first.
    const loggedDates = useMemo(
        () => Object.keys(database.log).filter(date => date >= from).sort().reverse(),
        [database.log, from]
    )

    if (!metric) return <p className="body-metrics-hint">No metrics. Add some in the Metrics tab.</p>

    const cards = stats ? [
        { label: "Latest", value: `${format(stats.latest.value)} (${stats.latest.date})` },
        { label: "Change", value: `${formatChange(stats.change)} ${unit}`.trim() },
        { label: `${AVERAGE_DAYS}-Day Average`, value: format(average.at(-1).value) },
        { label: "Lowest", value: format(stats.min) },
        { label: "Highest", value: format(stats.max) },
        { label: "Readings", value: String(stats.count) }
    ] : []
    if (stats && metric.goal > 0) {
        cards.push({ label: "Goal", value: format(metric.goal) })
        cards.push({ label: "To Go", value: `${formatChange(metric.goal - stats.latest.value)} ${unit}`.trim() })
    }
    if (stats && isWeight) {
        const bmi = bodyMassIndex(stats.latest.value, height, units)
        if (bmi > 0) cards.push({ label: "BMI", value: formatNumber(bmi) })
    }

    return (
        <div>
            <div className="body-metrics-toolbar">
                <select value={metric.id} onChange={e => setMetricId(e.target.value)}>
                    {database.metrics.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
                </select>
                <select value={days} onChange={e => setDays(Number(e.target.value))}>
                    {RANGES.map(range => <option value={range.days} key={range.days}>{range.label}</option>)}
                </select>
            </div>
            {stats ? (
                <div className="body-metrics-card">
                    <div className="body-metrics-card-stats">
                        {cards.map(card => <MetricCard key={card.label} label={card.label} value={card.value} />)}
                    </div>
                    <p className="body-metrics-hint">{`Readings, with their ${AVERAGE_DAYS}-day average as a line${metric.goal > 0 ? " and the goal dashed" : ""}.`}</p>
                    <TrendChart series={series} average={average} goal={metric.goal} format={format} />
                </div>
            ) : (
                <p className="body-metrics-hint">{`No ${metric.name} readings in this range.`}</p>
            )}

            <h4 className="body-metrics-heading">History</h4>
            <div className="body-metrics-scroll">
                <table className="body-metrics-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            {database.metrics.map(item => (
                                <th key={item.id}>{`${item.name}${metricUnit(item, units) ? ` (${metricUnit(item, units)})` : ""}`}</th>
                            ))}
                            <th>Note</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loggedDates.map(date => (
                            <tr key={date}>
                                <td>{date}</td>
                                {database.metrics.map(item => {
                                    const value = database.log[date].values[item.id]
                                    return <td key={item.id}>{value > 0 ? formatNumber(value) : ""}</td>
                                })}
                                <td>{database.log[date].comment}</td>
                            </tr>
                        ))}
                        {loggedDates.length === 0 && (
                            <tr><td colSpan={database.metrics.length + 2} className="body-metrics-hint">Nothing logged in this range.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------
function BodyMetricsWidget() {
    const [tab, setTab] = useState("log")
    const [database, setDatabase] = useState(null)
    const [settings, setSettings] = useState(null)
    const [databaseNoteId, setDatabaseNoteId] = useState(null)
    // Mirrors `database` so persist can apply its updater without reading state through a stale closure.
    const databaseRef = useRef(null)

    const units = useMemo(
        () => ({ weight: settings?.weightUnit || "kg", length: settings?.lengthUnit || "cm" }),
        [settings]
    )

    useEffect(() => {
        (async () => {
            const dbNoteId = await currentNote.getRelationValue("database")
            setDatabaseNoteId(dbNoteId)
            const content = await api.runOnBackend(id => api.getNote(id).getContent(), [dbNoteId])
            databaseRef.current = parseDatabase(content)
            setDatabase(databaseRef.current)

            const schemaNoteId = await currentNote.getRelationValue("schemaNote")
            const settingsNote = await currentNote.getRelationTarget("settingsNote")
            const configNote = await settingsNote.getRelationTarget("configNote")
            setSettings(await loadSettings(schemaNoteId, configNote.noteId))
        })()
    }, [])

    const persist = useCallback(update => {
        const next = update(databaseRef.current)
        databaseRef.current = next
        setDatabase(next)
        api.runOnBackend((id, content) => api.getNote(id).setContent(content), [databaseNoteId, serializeDatabase(next)])
    }, [databaseNoteId])

    const onSaveDay = useCallback((date, day) => {
        persist(current => setDay(current, date, day))
    }, [persist])

    const onSaveMetric = useCallback(metric => {
        persist(current => ({
            ...current,
            metrics: current.metrics.some(existing => existing.id === metric.id)
                ? current.metrics.map(existing => existing.id === metric.id ? metric : existing)
                : [...current.metrics, metric]
        }))
    }, [persist])

    const onMoveMetric = useCallback((metricId, delta) => {
        persist(current => moveMetric(current, metricId, delta))
    }, [persist])

    // A metric's readings go with it, since nothing else could show them.
    const onDeleteMetric = useCallback((metric, readings) => {
        const detail = readings > 0 ? ` Its ${readings} reading(s) are deleted with it.` : ""
        if (!confirm(`Delete metric "${metric.name}"?${detail}`)) return
        persist(current => {
            let next = { ...current, metrics: current.metrics.filter(existing => existing.id !== metric.id) }
            for (const [date, day] of Object.entries(current.log)) {
                if (!(metric.id in day.values)) continue
                const values = { ...day.values }
                delete values[metric.id]
                next = setDay(next, date, { ...day, values })
            }
            return next
        })
    }, [persist])

    const onExport = useCallback(() => {
        const blob = new Blob([serializeDatabase(database)], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.href = url
        link.download = "body-metrics-database.json"
        link.click()
        URL.revokeObjectURL(url)
    }, [database])

    const onImport = useCallback(() => {
        const input = document.createElement("input")
        input.type = "file"
        input.accept = "application/json,.json"
        input.onchange = async () => {
            const file = input.files?.[0]
            if (!file) return
            let imported
            try {
                imported = importDatabase(await file.text())
            } catch (e) {
                api.showError(`Could not import: ${e.message}`)
                return
            }
            persist(current => mergeDatabase(current, imported))
            api.showMessage(`Imported ${imported.metrics.length} metric(s) and ${Object.keys(imported.log).length} day(s).`)
        }
        input.click()
    }, [persist])

    if (!database || !settings) return <div className="body-metrics-widget">Loading...</div>

    const height = Number(settings.height) || 0
    const tabButton = (key, label) => (
        <button
            className={tab === key ? "body-metrics-tab-btn body-metrics-tab-btn-active" : "body-metrics-tab-btn"}
            onClick={() => setTab(key)}
        >
            {label}
        </button>
    )

    return (
        <div className="body-metrics-widget">
            <div className="body-metrics-tabs">
                {tabButton("log", "Log")}
                {tabButton("reports", "Reports")}
                {tabButton("metrics", "Metrics")}
                <span className="body-metrics-spacer" />
                <Button icon="bx-import" text="Import JSON" onClick={onImport} />
                <Button icon="bx-export" text="Export JSON" onClick={onExport} />
            </div>
            {tab === "log" && <LogTab database={database} units={units} height={height} onSaveDay={onSaveDay} />}
            {tab === "reports" && <ReportsTab database={database} units={units} height={height} />}
            {tab === "metrics" && (
                <MetricsTab
                    database={database}
                    units={units}
                    onSave={onSaveMetric}
                    onMove={onMoveMetric}
                    onDelete={onDeleteMetric}
                />
            )}
        </div>
    )
}

export default BodyMetricsWidget
