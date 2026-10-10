"use strict";
/* End-to-end test for body-metrics@beatlink: installs it through TAM's UI, opens
the launcher, logs a reading, checks it reached the database note, then checks
the Reports tab plots it. */

const { test, expect, installViaTam } = require("../testing");
const { httpClient, wrapPage } = require("../testing");

const ADDON_ID = "body-metrics@beatlink";

test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const raw = await browser.newPage();
    try {
        await installViaTam(wrapPage(raw), httpClient(), ADDON_ID, { mode: "url" });
    } finally {
        await raw.close();
    }
});

test("logging a reading saves it and the report plots it", async ({ tri, page }) => {
    test.setTimeout(120_000);
    const { results } = await tri.searchNotes(`note.title = '${ADDON_ID}'`);
    const launcher = results.find((note) => note.type === "render");
    expect(launcher, "the launcher render note is missing").toBeTruthy();

    await page.gotoNote(launcher.noteId);
    await page.enableRenderNote();
    const widget = page.locator(".body-metrics-widget:visible");
    await expect(widget.locator("tbody tr").first()).toContainText("Weight", { timeout: 30_000 });

    const weight = widget.locator("tbody tr").first().locator("input[type=number]");
    await weight.fill("81.5");
    await weight.press("Tab");

    // Other addons ship a database.json too, so the right one is the one holding metrics.
    const { results: dbs } = await tri.searchNotes("note.title = 'database.json'");
    let saved = null;
    await expect.poll(async () => {
        for (const db of dbs) {
            const content = await tri.request("GET", `/etapi/notes/${db.noteId}/content`);
            if (content && Array.isArray(content.metrics)) saved = content;
        }
        return saved ? Object.values(saved.log).map((day) => day.values.weight) : [];
    }, { timeout: 15_000 }).toContain(81.5);
    expect(saved.metrics.map((metric) => metric.id)).toContain("bodyfat");

    await widget.locator(".body-metrics-tab-btn", { hasText: "Reports" }).click();
    await expect(widget.locator(".body-metrics-chart-dot")).toHaveCount(1);
    await expect(widget.locator(".body-metrics-card-stat").first()).toContainText("81.5 kg");
});
