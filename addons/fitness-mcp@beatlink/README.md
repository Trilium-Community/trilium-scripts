# Fitness MCP

An [MCP](https://modelcontextprotocol.io) server over the data of three other addons, so an AI agent
(Claude Code, Claude Desktop, or any MCP client) can read and edit it:

- [diet-manager@beatlink](../diet-manager@beatlink/README.md): diary, foods, recipes, grocery list,
  categories and units.
- [workout-manager@beatlink](../workout-manager@beatlink/README.md): workout log, exercises,
  programs and their sessions, categories, stats.
- [body-metrics@beatlink](../body-metrics@beatlink/README.md): metrics and daily readings.

It finds each addon's database note on its own. Install whichever of the three you use; tools for
one that isn't installed answer with an error saying so.

## Setup

1. Turn on backend scripting: `[Security] backendScriptingEnabled=true` in `config.ini`, or
   `TRILIUM_SECURITY_BACKEND_SCRIPTING_ENABLED=true`. Without it every request gets a 403.
2. Install the addon and enable it.
3. Point your MCP client at `http://<trilium-host>:<port>/custom/fitness-mcp` using the HTTP
   transport. For Claude Code:

   ```bash
   claude mcp add --transport http fitness http://localhost:8080/custom/fitness-mcp
   ```

## Security

Trilium serves `/custom/*` without authentication, so anyone who can reach the Trilium port can read
and change this data. Only expose it on a network you trust. Requests must have a JSON body, which
keeps an ordinary cross-site web page from posting to it, but this is no defence against a DNS
rebinding attack or against anything already on your network.

## Tools

Ids come from the list/get tools. Every `save` tool creates a record when given no id, and updates
one when given its id plus only the fields to change. Dates are `YYYY-MM-DD` and default to today.

| Tool | What it does |
| --- | --- |
| `diet_get_diary` | Diary entries, nutrients, daily totals and targets for a date range |
| `diet_list` | Foods, recipes, grocery list, categories, units or brands, with an optional filter |
| `diet_save_food` / `diet_save_recipe` | Create or update a food or recipe |
| `diet_save_diary_entry` | Log or edit something eaten |
| `diet_save_grocery_item` | Add or edit a grocery line |
| `diet_delete` | Delete a food, recipe, diary entry or grocery line |
| `diet_edit_category` / `diet_edit_unit` | Add, rename or delete a category or unit |
| `workout_get_log` | Logged workouts with sets and totals for a date range |
| `workout_list` | Exercises, programs, categories, equipment or muscles |
| `workout_exercise_stats` | Personal bests and per-day trend for one exercise |
| `workout_weekly_summary` | Per-week totals against the weekly target |
| `workout_save_exercise` / `workout_save_program` | Create or update an exercise or program |
| `workout_start_workout` | Start a workout from a program session |
| `workout_save_workout` | Log or edit a workout and its sets |
| `workout_finish_workout` | Finish a workout, applying progression to the session |
| `workout_delete` | Delete an exercise, program or workout |
| `workout_edit_category` | Add, rename or delete a category |
| `body_list_metrics` | Metrics with units, goals, stats and BMI |
| `body_get_log` | Readings and notes for a date range |
| `body_save_metric` / `body_move_metric` | Create, update or reorder a metric |
| `body_set_day` | Record a day's readings and note |
| `body_delete` | Delete a metric with its readings, or a whole day |

Finishing a workout behaves as it does in the widget: it rewrites the session's targets and cannot
be undone.

## How it works

The endpoint is a backend `#customRequestHandler` note speaking MCP's Streamable HTTP transport
statelessly: each POST carries one JSON-RPC message (or a batch) and gets a plain JSON reply, with
no sessions and no server-sent events. It locates each addon through its widget's render label
(`#dietManagerRender`, `#workoutManagerRender`, `#bodyMetricsRender`) and that widget's `~database`
and settings relations, and carries backend copies of the three addons' data-model libraries, so
every write is normalized exactly as the widget would normalize it.
