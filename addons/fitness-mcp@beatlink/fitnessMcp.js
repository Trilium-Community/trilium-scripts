/*
 * fitness-mcp@beatlink -- backend customRequestHandler ("fitness-mcp").
 *
 * An MCP server (Streamable HTTP transport, stateless, JSON responses only) at
 * custom/fitness-mcp over the databases of diet-manager@beatlink,
 * workout-manager@beatlink and body-metrics@beatlink. Each addon is found by its
 * widget's render label, and its database note and settings through the
 * widget's own relations, so none of the three needs to know this addon exists.
 * A missing addon only fails the tools that need it.
 *
 * Every write is one read-modify-write of one database note, built from the
 * same pure library functions the widgets use (this addon carries its own
 * backend copies of them), so a record written here is normalized exactly as
 * one saved from the widget would be.
 *
 * There is no authentication: /custom/* is served to anyone who can reach the
 * Trilium port. Only JSON bodies are accepted, so a cross-site page cannot post
 * here without a CORS preflight, which is never answered.
 */

const { loadSettings } = require("libSettings.js")
const diet = require("libDietManager.js")
const workout = require("libWorkoutManager.js")
const body = require("libBodyMetrics.js")

const SERVER_INFO = { name: "fitness-mcp", version: "1.0.0" }
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

const ADDONS = {
    diet: { id: "diet-manager@beatlink", label: "dietManagerRender", lib: diet },
    workout: { id: "workout-manager@beatlink", label: "workoutManagerRender", lib: workout },
    body: { id: "body-metrics@beatlink", label: "bodyMetricsRender", lib: body }
}

// --- storage ----------------------------------------------------------------

function openAddon(key) {
    const addon = ADDONS[key]
    const widget = api.getNoteWithLabel(addon.label)
    const note = widget?.getRelationTarget("database")
    if (!note) throw new Error(`${addon.id} is not installed.`)
    const configNoteId = widget.getRelationTarget("settingsNote")?.getRelationValue("configNote")
    return {
        note,
        lib: addon.lib,
        settings: loadSettings(widget.getRelationValue("schemaNote"), configNoteId),
        database: addon.lib.parseDatabase(note.getContent())
    }
}

function save(store, database) {
    store.note.setContent(store.lib.serializeDatabase(database))
}

// --- helpers ----------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function checkDate(raw, fallback) {
    const date = raw || fallback
    if (!DATE_PATTERN.test(date)) throw new Error(`Expected a YYYY-MM-DD date, got "${raw}".`)
    return date
}

// The dates of `log` within the from/to range, oldest first; both default to today.
function datesInRange(log, args, today) {
    const from = checkDate(args.from, today)
    const to = checkDate(args.to, from)
    return Object.keys(log).filter(date => date >= from && date <= to).sort()
}

function matches(query, ...texts) {
    if (!query) return true
    const needle = query.toLowerCase()
    return texts.flat().some(text => typeof text === "string" && text.toLowerCase().includes(needle))
}

// Two decimals on every number, so derived nutrients and averages read cleanly.
function rounded(value) {
    if (typeof value === "number") return Math.round(value * 100) / 100
    if (Array.isArray(value)) return value.map(rounded)
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item)]))
    }
    return value
}

function requireFields(fields, what) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error(`Expected a ${what} object.`)
    return fields
}

/*
 * Without an id the record is new; with one it must already exist, and the
 * given fields are laid over it, so an edit only has to name what changes.
 */
function merged(existing, fields, what) {
    if (fields.id && !existing) throw new Error(`No ${what} with id "${fields.id}".`)
    return { ...existing, ...fields }
}

function upsertInMap(map, fields, normalize, what) {
    requireFields(fields, what)
    const item = normalize(merged(fields.id ? map[fields.id] : null, fields, what))
    return { map: { ...map, [item.id]: item }, item }
}

function upsertInList(list, fields, normalize, what) {
    requireFields(fields, what)
    const existing = fields.id ? list.find(entry => entry.id === fields.id) : null
    const item = normalize(merged(existing, fields, what))
    return { list: existing ? list.map(entry => entry.id === item.id ? item : entry) : [...list, item], item }
}

function removeFromMap(map, id, what) {
    if (!map[id]) throw new Error(`No ${what} with id "${id}".`)
    const next = { ...map }
    delete next[id]
    return next
}

function removeFromList(list, id, what) {
    if (!list.some(item => item.id === id)) throw new Error(`No ${what} with id "${id}".`)
    return list.filter(item => item.id !== id)
}

// Drops one item from a dated list, and the date itself once it is empty.
function removeFromDay(log, date, id, what) {
    const next = { ...log, [checkDate(date)]: removeFromList(log[date] || [], id, `${what} on ${date}`) }
    if (next[date].length === 0) delete next[date]
    return next
}

function editCategory(lib, database, { action, name, to }) {
    if (action === "add") return lib.addCategory(database, name)
    if (!lib.allCategories(database).includes(name)) throw new Error(`No category "${name}".`)
    if (action === "rename") return lib.renameCategory(database, name, to)
    if (action === "delete") return lib.deleteCategory(database, name)
    throw new Error(`Unknown action "${action}".`)
}

// --- schema builders --------------------------------------------------------

const str = description => ({ type: "string", description })
const num = description => ({ type: "number", description })
const obj = (description, properties = {}) => ({ type: "object", description, properties })
const oneOf = (values, description) => ({ type: "string", enum: values, description })
const dateArg = str("Date as YYYY-MM-DD. Defaults to today.")
const rangeArgs = { from: str("First date, YYYY-MM-DD. Defaults to today."), to: str("Last date, YYYY-MM-DD. Defaults to `from`.") }

function schema(properties = {}, required = []) {
    return { type: "object", properties, required }
}

const categoryArgs = schema({
    action: oneOf(["add", "rename", "delete"], "Rename and delete carry nested categories (\"A/B\") along."),
    name: str("Category path, \"/\" separating levels."),
    to: str("New path, for rename. Renaming onto an existing category merges the two.")
}, ["action", "name"])

// --- diet-manager -----------------------------------------------------------

const NUTRIENT_UNITS = diet.NUTRIENTS.map(n => `${n.key} (${n.unit})`).join(", ")

function dietItemName(database, entry) {
    const item = entry.kind === "recipe" ? database.recipes[entry.refId] : database.foods[entry.refId]
    if (!item) return "(deleted)"
    return entry.kind === "recipe" ? item.name : diet.foodLabel(item)
}

function checkFood(database, foodId) {
    if (!database.foods[foodId]) throw new Error(`No food with id "${foodId}".`)
}

const DIET_TOOLS = [
    {
        name: "diet_get_diary",
        description: `Diet diary for a date range: each day's entries with the food or recipe name and the nutrients they contribute, the day's totals, and the daily targets from settings. Nutrients: ${NUTRIENT_UNITS}.`,
        inputSchema: schema(rangeArgs),
        run: args => {
            const { database, settings } = openAddon("diet")
            const { foods, recipes } = database
            return rounded({
                targets: Object.fromEntries(diet.NUTRIENTS.map(n => [n.key, settings[diet.targetKeyFor(n.key)]])),
                days: datesInRange(database.diary, args, diet.todayKey()).map(date => ({
                    date,
                    entries: database.diary[date].map(entry => ({
                        ...entry,
                        name: dietItemName(database, entry),
                        nutrients: diet.entryNutrients(entry, foods, recipes)
                    })),
                    totals: diet.dayTotals(database.diary[date], foods, recipes)
                }))
            })
        }
    },
    {
        name: "diet_list",
        description: "List one part of the diet database. Foods carry nutrients per their own serving (servingSize servingUnit) and the units they can be logged in; recipes carry derived nutrients per serving. `query` filters foods, recipes and grocery lines by name, brand or category.",
        inputSchema: schema({
            section: oneOf(["foods", "recipes", "grocery", "categories", "units", "brands"]),
            query: str("Case-insensitive substring filter.")
        }, ["section"]),
        run: ({ section, query }) => {
            const { database } = openAddon("diet")
            switch (section) {
                case "foods":
                    return Object.values(database.foods)
                        .filter(food => matches(query, food.name, food.brand, food.tags))
                        .map(food => ({ ...food, units: rounded(diet.foodUnits(food)) }))
                case "recipes":
                    return Object.values(database.recipes)
                        .filter(recipe => matches(query, recipe.name, recipe.tags))
                        .map(recipe => ({ ...recipe, nutrientsPerServing: rounded(diet.recipeNutrientsPerServing(recipe, database.foods)) }))
                case "grocery":
                    return database.grocery
                        .map(item => ({ ...item, food: database.foods[item.foodId] ? diet.foodLabel(database.foods[item.foodId]) : "(deleted)" }))
                        .filter(item => matches(query, item.food, item.brand))
                case "categories": return diet.allCategories(database)
                case "units": return diet.allUnits(database)
                case "brands": return diet.allBrands(database)
            }
            throw new Error(`Unknown section "${section}".`)
        }
    },
    {
        name: "diet_save_food",
        description: `Create a food (no id) or update one (id plus only the fields to change). Fields: name, brand, comment, servingSize, servingUnit, tags (category paths), nutrients per serving {${diet.NUTRIENTS.map(n => n.key).join(", ")}}, portions [{unit, amount, size, sizeUnit}] meaning "amount unit = size sizeUnit" (sizeUnit empty = the serving unit).`,
        inputSchema: schema({ food: obj("The food's fields.", { id: str("Existing food id, to update.") }) }, ["food"]),
        mutates: true,
        run: ({ food }) => {
            const store = openAddon("diet")
            const { map, item } = upsertInMap(store.database.foods, food, diet.normalizeFood, "food")
            save(store, { ...store.database, foods: map })
            return item
        }
    },
    {
        name: "diet_save_recipe",
        description: "Create a recipe (no id) or update one (id plus only the fields to change). Fields: name, comment, servings (how many servings the ingredients make), servingUnit, tags, ingredients [{foodId, amount, unit}] (unit empty = the food's serving unit; replaces the whole list).",
        inputSchema: schema({ recipe: obj("The recipe's fields.", { id: str("Existing recipe id, to update.") }) }, ["recipe"]),
        mutates: true,
        run: ({ recipe }) => {
            const store = openAddon("diet")
            const { map, item } = upsertInMap(store.database.recipes, recipe, diet.normalizeRecipe, "recipe")
            for (const ingredient of item.ingredients) checkFood(store.database, ingredient.foodId)
            save(store, { ...store.database, recipes: map })
            return item
        }
    },
    {
        name: "diet_save_diary_entry",
        description: "Log something eaten (no id) or update a logged entry (id plus only the fields to change). Fields: kind (\"food\" or \"recipe\"), refId (the food or recipe id), servings (the amount), unit (one of the food's units from diet_list; empty = whole servings). To move an entry to another date, delete it and log it again.",
        inputSchema: schema({ date: dateArg, entry: obj("The entry's fields.", { id: str("Existing entry id, to update.") }) }, ["entry"]),
        mutates: true,
        run: ({ date, entry }) => {
            const store = openAddon("diet")
            const day = checkDate(date, diet.todayKey())
            const { list, item } = upsertInList(store.database.diary[day] || [], entry, diet.normalizeDiaryEntry, "diary entry")
            const items = item.kind === "recipe" ? store.database.recipes : store.database.foods
            if (!items[item.refId]) throw new Error(`No ${item.kind} with id "${item.refId}".`)
            save(store, { ...store.database, diary: { ...store.database.diary, [day]: list } })
            return { date: day, entry: item }
        }
    },
    {
        name: "diet_save_grocery_item",
        description: "Add a grocery list line (no id) or update one (id plus only the fields to change). Fields: foodId, amount, unit, brand, comment, done (checked off).",
        inputSchema: schema({ item: obj("The line's fields.", { id: str("Existing line id, to update.") }) }, ["item"]),
        mutates: true,
        run: ({ item: fields }) => {
            const store = openAddon("diet")
            const normalize = raw => diet.normalizeGroceryItem(raw, store.database.foods)
            const { list, item } = upsertInList(store.database.grocery, fields, normalize, "grocery item")
            checkFood(store.database, item.foodId)
            save(store, { ...store.database, grocery: list })
            return item
        }
    },
    {
        name: "diet_delete",
        description: "Delete a food, recipe, diary entry (needs its date) or grocery line. Deleting a food or recipe leaves entries and recipes that used it pointing at nothing, as the widget does.",
        inputSchema: schema({
            kind: oneOf(["food", "recipe", "diary_entry", "grocery_item"]),
            id: str("Id of the record."),
            date: str("Date of a diary entry, YYYY-MM-DD.")
        }, ["kind", "id"]),
        mutates: true,
        run: ({ kind, id, date }) => {
            const store = openAddon("diet")
            const { database } = store
            const next = kind === "food" ? { ...database, foods: removeFromMap(database.foods, id, "food") }
                : kind === "recipe" ? { ...database, recipes: removeFromMap(database.recipes, id, "recipe") }
                : kind === "diary_entry" ? { ...database, diary: removeFromDay(database.diary, date, id, "diary entry") }
                : kind === "grocery_item" ? { ...database, grocery: removeFromList(database.grocery, id, "grocery item") }
                : null
            if (!next) throw new Error(`Unknown kind "${kind}".`)
            save(store, next)
            return { deleted: { kind, id } }
        }
    },
    {
        name: "diet_edit_category",
        description: "Add, rename or delete a food/recipe category. Deleting untags items but keeps them.",
        inputSchema: categoryArgs,
        mutates: true,
        run: args => {
            const store = openAddon("diet")
            const next = editCategory(diet, store.database, args)
            save(store, next)
            return diet.allCategories(next)
        }
    },
    {
        name: "diet_edit_unit",
        description: "Add, rename or delete a unit in the shared unit list. Renaming rewrites every food, recipe and grocery line using it (onto an existing unit merges them); a unit still in use cannot be deleted, rename it into another instead.",
        inputSchema: schema({
            action: oneOf(["add", "rename", "delete"]),
            name: str("Unit name."),
            to: str("New name, for rename.")
        }, ["action", "name"]),
        mutates: true,
        run: ({ action, name, to }) => {
            const store = openAddon("diet")
            const { database } = store
            let next
            if (action === "add") next = diet.addUnit(database, name)
            else if (!diet.allUnits(database).includes(name)) throw new Error(`No unit "${name}".`)
            else if (action === "rename") next = diet.renameUnit(database, name, to)
            else if (action === "delete") {
                const usage = diet.unitUsage(database, name)
                if (usage.foods + usage.recipes + usage.grocery > 0) throw new Error(`Unit "${name}" is in use: ${JSON.stringify(usage)}.`)
                next = diet.deleteUnit(database, name)
            } else throw new Error(`Unknown action "${action}".`)
            save(store, next)
            return diet.allUnits(next)
        }
    }
]

// --- workout-manager --------------------------------------------------------

function workoutUnits(settings) {
    return { weight: settings.weightUnit, distance: settings.distanceUnit, duration: "min" }
}

function checkExercises(database, entries) {
    for (const entry of entries) {
        if (!database.exercises[entry.exerciseId]) throw new Error(`No exercise with id "${entry.exerciseId}".`)
    }
}

function withExerciseNames(database, entries) {
    return entries.map(entry => ({ ...entry, exerciseName: database.exercises[entry.exerciseId]?.name || "(deleted)" }))
}

const WORKOUT_TOOLS = [
    {
        name: "workout_get_log",
        description: "Workouts logged in a date range, each with its exercises (named), the sets performed, the targets they were started against, and totals. Weight and distance are in the units listed; durations are minutes. An empty finishedAt means the workout is still open.",
        inputSchema: schema(rangeArgs),
        run: args => {
            const { database, settings } = openAddon("workout")
            return rounded({
                units: workoutUnits(settings),
                days: datesInRange(database.log, args, workout.todayKey()).map(date => ({
                    date,
                    workouts: database.log[date].map(item => ({
                        ...item,
                        entries: withExerciseNames(database, item.entries),
                        totals: workout.workoutTotals(item, database.exercises)
                    }))
                }))
            })
        }
    },
    {
        name: "workout_list",
        description: "List one part of the workout database. Programs hold ordered sessions, each a plan of exercise entries with set/rep/weight targets and an optional progression. `query` filters exercises by name, equipment, muscle or category, and programs by program or session name.",
        inputSchema: schema({
            section: oneOf(["exercises", "programs", "categories", "equipment", "muscles"]),
            query: str("Case-insensitive substring filter.")
        }, ["section"]),
        run: ({ section, query }) => {
            const { database } = openAddon("workout")
            switch (section) {
                case "exercises":
                    return Object.values(database.exercises)
                        .filter(exercise => matches(query, exercise.name, exercise.equipment, exercise.muscles, exercise.tags))
                case "programs":
                    return Object.values(database.programs)
                        .filter(program => matches(query, program.name, program.sessions.map(session => session.name)))
                        .map(program => ({
                            ...program,
                            sessions: program.sessions.map(session => ({ ...session, entries: withExerciseNames(database, session.entries) }))
                        }))
                case "categories": return workout.allCategories(database)
                case "equipment": return workout.allEquipment(database)
                case "muscles": return workout.allMuscles(database)
            }
            throw new Error(`Unknown section "${section}".`)
        }
    },
    {
        name: "workout_exercise_stats",
        description: "Personal bests and totals for one exercise (best weight, reps, estimated 1RM, set volume, duration, distance), plus one trend point per day it was trained.",
        inputSchema: schema({ exerciseId: str("Exercise id.") }, ["exerciseId"]),
        run: ({ exerciseId }) => {
            const { database, settings } = openAddon("workout")
            const exercise = database.exercises[exerciseId]
            if (!exercise) throw new Error(`No exercise with id "${exerciseId}".`)
            return rounded({
                exercise,
                units: workoutUnits(settings),
                stats: workout.exerciseStats(database, exerciseId),
                trend: workout.exerciseTrend(database, exerciseId)
            })
        }
    },
    {
        name: "workout_weekly_summary",
        description: "Workouts, sets, volume, duration and distance per Monday-start week, newest first, with the weekly workout target from settings.",
        inputSchema: schema({ weeks: num("How many weeks back. Defaults to 4.") }),
        run: ({ weeks }) => {
            const { database, settings } = openAddon("workout")
            const count = Math.max(1, Math.min(520, Math.round(weeks || 4)))
            return rounded({
                weeklyTarget: settings.weeklyTarget,
                units: workoutUnits(settings),
                weeks: workout.weeklySummary(database, database.exercises, count)
            })
        }
    },
    {
        name: "workout_save_exercise",
        description: `Create an exercise (no id) or update one (id plus only the fields to change). Fields: name, measurement (${workout.MEASUREMENTS.map(m => `"${m.key}" = ${m.label}`).join(", ")}), equipment, muscles [names], comment, tags (category paths).`,
        inputSchema: schema({ exercise: obj("The exercise's fields.", { id: str("Existing exercise id, to update.") }) }, ["exercise"]),
        mutates: true,
        run: ({ exercise }) => {
            const store = openAddon("workout")
            const { map, item } = upsertInMap(store.database.exercises, exercise, workout.normalizeExercise, "exercise")
            save(store, { ...store.database, exercises: map })
            return item
        }
    },
    {
        name: "workout_save_program",
        description: `Create a program (no id) or update one (id plus only the fields to change). Fields: name, comment, sessions (replaces the whole list; read the program first to keep what is there): [{id, name, comment, tags, entries: [{id, exerciseId, sets, reps, weight, duration, distance, rest (seconds), comment, progression}]}]. Keep existing session and entry ids, since logged workouts and progression point at them. progression: {type: ${workout.PROGRESSIONS.map(p => `"${p.key}"`).join("|")}, increment, incrementPercent, successes, decrement, decrementPercent, failures, minReps, maxReps, repsThreshold}; it only applies to weight exercises.`,
        inputSchema: schema({ program: obj("The program's fields.", { id: str("Existing program id, to update.") }) }, ["program"]),
        mutates: true,
        run: ({ program }) => {
            const store = openAddon("workout")
            const { map, item } = upsertInMap(store.database.programs, program, workout.normalizeProgram, "program")
            for (const session of item.sessions) checkExercises(store.database, session.entries)
            save(store, { ...store.database, programs: map })
            return item
        }
    },
    {
        name: "workout_start_workout",
        description: "Start a workout from a program session: logs a new open workout on the date with one entry per session entry, its sets pre-filled with the session's targets. Correct the sets with workout_save_workout, then call workout_finish_workout.",
        inputSchema: schema({ sessionId: str("Session id, from workout_list programs."), date: dateArg }, ["sessionId"]),
        mutates: true,
        run: ({ sessionId, date }) => {
            const store = openAddon("workout")
            const day = checkDate(date, workout.todayKey())
            const found = workout.findSession(store.database, sessionId)
            if (!found) throw new Error(`No session with id "${sessionId}".`)
            const started = workout.workoutFromSession(found.session, new Date().toISOString(), found.program)
            const log = { ...store.database.log, [day]: [...(store.database.log[day] || []), started] }
            save(store, { ...store.database, log })
            return { date: day, workout: started }
        }
    },
    {
        name: "workout_save_workout",
        description: "Log a workout (no id) or update one (id plus only the fields to change). Fields: name, comment, sessionId (empty = ad hoc), startedAt, entries (replaces the whole list; read the workout first to keep what is there): [{id, exerciseId, sessionEntryId, target, comment, sets: [{id, reps, weight, duration, distance, rpe}]}]. Keep existing entry ids and sessionEntryId/target, which progression reads. To move a workout to another date, delete it and log it again.",
        inputSchema: schema({ date: dateArg, workout: obj("The workout's fields.", { id: str("Existing workout id, to update.") }) }, ["workout"]),
        mutates: true,
        run: ({ date, workout: fields }) => {
            const store = openAddon("workout")
            const day = checkDate(date, workout.todayKey())
            const { list, item } = upsertInList(store.database.log[day] || [], fields, workout.normalizeWorkout, "workout")
            checkExercises(store.database, item.entries)
            save(store, { ...store.database, log: { ...store.database.log, [day]: list } })
            return { date: day, workout: item }
        }
    },
    {
        name: "workout_finish_workout",
        description: "Finish an open workout. This applies each entry's progression to its session's targets for next time and cannot be undone (a mistake has to be corrected in the program by hand). Returns what each progression did.",
        inputSchema: schema({ date: str("Date of the workout, YYYY-MM-DD."), workoutId: str("Workout id.") }, ["date", "workoutId"]),
        mutates: true,
        run: ({ date, workoutId }) => {
            const store = openAddon("workout")
            const found = (store.database.log[checkDate(date)] || []).find(item => item.id === workoutId)
            if (!found) throw new Error(`No workout with id "${workoutId}" on ${date}.`)
            if (found.finishedAt) throw new Error(`Workout "${workoutId}" was already finished at ${found.finishedAt}.`)
            const { database, reports } = workout.finishWorkout(store.database, date, workoutId)
            save(store, database)
            return { finished: workoutId, progression: withExerciseNames(database, reports) }
        }
    },
    {
        name: "workout_delete",
        description: "Delete an exercise, a program (with its sessions) or a logged workout (needs its date). Logged workouts keep their sets when an exercise or program they used is deleted.",
        inputSchema: schema({
            kind: oneOf(["exercise", "program", "workout"]),
            id: str("Id of the record."),
            date: str("Date of a workout, YYYY-MM-DD.")
        }, ["kind", "id"]),
        mutates: true,
        run: ({ kind, id, date }) => {
            const store = openAddon("workout")
            const { database } = store
            const next = kind === "exercise" ? { ...database, exercises: removeFromMap(database.exercises, id, "exercise") }
                : kind === "program" ? { ...database, programs: removeFromMap(database.programs, id, "program") }
                : kind === "workout" ? { ...database, log: removeFromDay(database.log, date, id, "workout") }
                : null
            if (!next) throw new Error(`Unknown kind "${kind}".`)
            save(store, next)
            return { deleted: { kind, id } }
        }
    },
    {
        name: "workout_edit_category",
        description: "Add, rename or delete an exercise/session category. Deleting untags items but keeps them.",
        inputSchema: categoryArgs,
        mutates: true,
        run: args => {
            const store = openAddon("workout")
            const next = editCategory(workout, store.database, args)
            save(store, next)
            return workout.allCategories(next)
        }
    }
]

// --- body-metrics -----------------------------------------------------------

function bodyUnits(settings) {
    return { weight: settings.weightUnit, length: settings.lengthUnit }
}

function checkMetric(database, metricId) {
    if (!database.metrics.some(metric => metric.id === metricId)) throw new Error(`No metric with id "${metricId}".`)
}

const BODY_TOOLS = [
    {
        name: "body_list_metrics",
        description: "Every body metric in display order, with its unit, goal (0 = none) and stats over all readings (first, latest, change, min, max, count). The weight metric also carries BMI when a height is set.",
        inputSchema: schema(),
        run: () => {
            const { database, settings } = openAddon("body")
            const units = bodyUnits(settings)
            const weight = database.metrics.find(metric => body.kindOf(metric).key === "weight")
            return rounded(database.metrics.map(metric => {
                const stats = body.seriesStats(body.metricSeries(database, metric.id))
                const bmi = metric === weight && stats ? body.bodyMassIndex(stats.latest.value, settings.height, units) : 0
                return { ...metric, unit: body.metricUnit(metric, units), stats, ...(bmi > 0 ? { bmi } : {}) }
            }))
        }
    },
    {
        name: "body_get_log",
        description: "Body readings in a date range: per day, each metric's value with its unit, and the day's note.",
        inputSchema: schema(rangeArgs),
        run: args => {
            const { database, settings } = openAddon("body")
            const units = bodyUnits(settings)
            return datesInRange(database.log, args, body.todayKey()).map(date => ({
                date,
                comment: database.log[date].comment,
                readings: Object.entries(database.log[date].values).map(([metricId, value]) => {
                    const metric = database.metrics.find(item => item.id === metricId)
                    return { metricId, name: metric?.name || "(deleted)", value, unit: metric ? body.metricUnit(metric, units) : "" }
                })
            }))
        }
    },
    {
        name: "body_save_metric",
        description: `Create a metric (no id; added last) or update one (id plus only the fields to change). Fields: name, kind (${body.KINDS.map(kind => `"${kind.key}"`).join("|")}; weight and length take their unit from settings, percent is %), unit (custom kind only), goal (0 = none), comment.`,
        inputSchema: schema({ metric: obj("The metric's fields.", { id: str("Existing metric id, to update.") }) }, ["metric"]),
        mutates: true,
        run: ({ metric }) => {
            const store = openAddon("body")
            const { list, item } = upsertInList(store.database.metrics, metric, body.normalizeMetric, "metric")
            save(store, { ...store.database, metrics: list })
            return item
        }
    },
    {
        name: "body_move_metric",
        description: "Move a metric one place up (-1) or down (1) in the display order.",
        inputSchema: schema({ id: str("Metric id."), delta: num("-1 or 1.") }, ["id", "delta"]),
        mutates: true,
        run: ({ id, delta }) => {
            const store = openAddon("body")
            checkMetric(store.database, id)
            const next = body.moveMetric(store.database, id, Math.sign(delta))
            save(store, next)
            return next.metrics.map(metric => metric.id)
        }
    },
    {
        name: "body_set_day",
        description: "Record readings for one day. `values` maps metric ids to numbers and is merged into what the day already holds; 0 removes that reading. `comment` replaces the day's note when given. A day left with no readings and no note is removed.",
        inputSchema: schema({
            date: dateArg,
            values: obj("{ [metricId]: number }"),
            comment: str("The day's note.")
        }),
        mutates: true,
        run: ({ date, values = {}, comment }) => {
            const store = openAddon("body")
            const day = checkDate(date, body.todayKey())
            for (const metricId of Object.keys(requireFields(values, "values"))) checkMetric(store.database, metricId)
            const current = store.database.log[day] || { values: {}, comment: "" }
            const next = body.setDay(store.database, day, {
                values: { ...current.values, ...values },
                comment: comment ?? current.comment
            })
            save(store, next)
            return { date: day, day: next.log[day] || null }
        }
    },
    {
        name: "body_delete",
        description: "Delete a metric together with all its readings, or a whole day's readings and note.",
        inputSchema: schema({
            kind: oneOf(["metric", "day"]),
            id: str("Metric id, for a metric."),
            date: str("YYYY-MM-DD, for a day.")
        }, ["kind"]),
        mutates: true,
        run: ({ kind, id, date }) => {
            const store = openAddon("body")
            const { database } = store
            let next
            if (kind === "metric") {
                checkMetric(database, id)
                next = { ...database, metrics: database.metrics.filter(metric => metric.id !== id) }
                for (const [day, entry] of Object.entries(database.log)) {
                    if (!(id in entry.values)) continue
                    const values = { ...entry.values }
                    delete values[id]
                    next = body.setDay(next, day, { ...entry, values })
                }
            } else if (kind === "day") {
                const log = removeFromMap(database.log, checkDate(date), "day")
                next = { ...database, log }
            } else throw new Error(`Unknown kind "${kind}".`)
            save(store, next)
            return { deleted: { kind, id: id || date } }
        }
    }
]

const TOOLS = [...DIET_TOOLS, ...WORKOUT_TOOLS, ...BODY_TOOLS]

// --- JSON-RPC ---------------------------------------------------------------

const INSTRUCTIONS = "Tools over the user's Trilium diet diary (diet_*), workout log and programs (workout_*) and body measurements (body_*). Look ids up with the list/get tools before writing; an update only needs the id and the fields that change. Dates are YYYY-MM-DD."

function callTool(params) {
    const tool = TOOLS.find(item => item.name === params?.name)
    if (!tool) return null
    try {
        const result = tool.run(params.arguments || {})
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
        return { content: [{ type: "text", text: e.message }], isError: true }
    }
}

function rpcError(id, code, message) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }
}

// One JSON-RPC message in, its response out; a notification gets none.
function dispatch(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return rpcError(message?.id, -32600, "Invalid request.")
    }
    const { id, method, params } = message
    if (id === undefined) return null
    const result = (() => {
        switch (method) {
            case "initialize": return {
                protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
                capabilities: { tools: {} },
                serverInfo: SERVER_INFO,
                instructions: INSTRUCTIONS
            }
            case "ping": return {}
            case "tools/list": return {
                tools: TOOLS.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    annotations: { readOnlyHint: !tool.mutates }
                }))
            }
            case "tools/call": return callTool(params)
        }
        return undefined
    })()
    if (result === undefined) return rpcError(id, -32601, `Method not found: ${method}`)
    if (result === null) return rpcError(id, -32602, `Unknown tool: ${params?.name}`)
    return { jsonrpc: "2.0", id, result }
}

function handle() {
    const { req, res } = api
    // No server-initiated stream and no sessions, so GET and DELETE are refused as the transport allows.
    if (req.method !== "POST") {
        res.set("Allow", "POST").status(405).end()
        return
    }
    if (!req.body || typeof req.body !== "object") {
        res.status(400).json(rpcError(null, -32700, "Expected an application/json body."))
        return
    }
    const responses = (Array.isArray(req.body) ? req.body : [req.body]).map(dispatch).filter(Boolean)
    if (responses.length === 0) res.status(202).end()
    else res.json(Array.isArray(req.body) ? responses : responses[0])
}

handle()
