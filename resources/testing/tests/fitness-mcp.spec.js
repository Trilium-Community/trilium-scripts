"use strict";
/* End-to-end test for fitness-mcp@beatlink: installs it beside the three addons it
serves, then drives /custom/fitness-mcp the way an MCP client does. Needs backend
scripting, so run with TRILIUM_SECURITY_BACKEND_SCRIPTING_ENABLED=true. */

const { test, expect, installViaTam } = require("../testing");
const { httpClient, wrapPage } = require("../testing");

const ADDONS = ["diet-manager@beatlink", "workout-manager@beatlink", "body-metrics@beatlink", "fitness-mcp@beatlink"];

test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    const raw = await browser.newPage();
    try {
        for (const addonId of ADDONS) await installViaTam(wrapPage(raw), httpClient(), addonId, { mode: "url" });
    } finally {
        await raw.close();
    }
});

let nextId = 1;

async function post(tri, body) {
    return fetch(`${tri.BASE_URL}/custom/fitness-mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify(body)
    });
}

async function rpc(tri, method, params) {
    const res = await post(tri, { jsonrpc: "2.0", id: nextId++, method, params });
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json();
}

async function call(tri, name, args = {}) {
    const { result } = await rpc(tri, "tools/call", { name, arguments: args });
    expect(result.isError, result.content[0].text).toBeFalsy();
    return JSON.parse(result.content[0].text);
}

test("speaks MCP and reads and writes all three databases", async ({ tri }) => {
    test.setTimeout(120_000);
    const init = await rpc(tri, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spec", version: "0" } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await post(tri, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const { result: { tools } } = await rpc(tri, "tools/list");
    expect(tools.map(tool => tool.name)).toContain("workout_finish_workout");

    const food = await call(tri, "diet_save_food", { food: { name: "Oats", servingSize: 40, servingUnit: "g", nutrients: { calories: 150, protein: 5 } } });
    const entry = await call(tri, "diet_save_diary_entry", { date: "2026-01-02", entry: { kind: "food", refId: food.id, servings: 80, unit: "g" } });
    const diary = await call(tri, "diet_get_diary", { from: "2026-01-02" });
    expect(diary.days[0].totals.calories).toBe(300);
    await call(tri, "diet_save_diary_entry", { date: "2026-01-02", entry: { id: entry.entry.id, servings: 40 } });
    expect((await call(tri, "diet_get_diary", { from: "2026-01-02" })).days[0].totals.calories).toBe(150);

    const squat = await call(tri, "workout_save_exercise", { exercise: { name: "Spec Squat", measurement: "weight" } });
    const program = await call(tri, "workout_save_program", { program: { name: "Spec", sessions: [{ name: "A", entries: [
        { exerciseId: squat.id, sets: 2, reps: 5, weight: 100, progression: { type: "linear", increment: 2.5, successes: 1 } }
    ] }] } });
    const started = await call(tri, "workout_start_workout", { sessionId: program.sessions[0].id, date: "2026-01-02" });
    const finished = await call(tri, "workout_finish_workout", { date: "2026-01-02", workoutId: started.workout.id });
    expect(finished.progression[0].to.weight).toBe(102.5);
    const log = await call(tri, "workout_get_log", { from: "2026-01-02" });
    expect(log.days[0].workouts[0].totals.volume).toBe(1000);

    const metrics = await call(tri, "body_list_metrics");
    const weight = metrics.find(metric => metric.kind === "weight");
    await call(tri, "body_set_day", { date: "2026-01-02", values: { [weight.id]: 80 }, comment: "spec" });
    const day = await call(tri, "body_get_log", { from: "2026-01-02" });
    expect(day[0].readings).toContainEqual(expect.objectContaining({ metricId: weight.id, value: 80 }));
    await call(tri, "body_delete", { kind: "day", date: "2026-01-02" });
    expect(await call(tri, "body_get_log", { from: "2026-01-02" })).toEqual([]);

    const { result: failed } = await rpc(tri, "tools/call", { name: "diet_delete", arguments: { kind: "food", id: "nope" } });
    expect(failed.isError).toBe(true);
    expect((await rpc(tri, "tools/call", { name: "nope" })).error.code).toBe(-32602);
    expect((await fetch(`${tri.BASE_URL}/custom/fitness-mcp`)).status).toBe(405);
});
