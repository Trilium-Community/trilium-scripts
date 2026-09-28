# Expanded

Keep selected notes always expanded in the Trilium note tree.

## What it does

Trilium collapses note trees when you restart or navigate away. This addon adds an **Always Expanded** checkbox to every note's promoted attributes; ticking it keeps that note's branches open permanently.

## How it works

Three backend scripts, each with one job:

- **setupRoot.js** (`#run=frontendStartup`, doing the note writes through `api.runOnBackend`) writes the inheritable `#label:alwaysExpanded="promoted,alias=Always Expanded,single,boolean"` definition onto the root note, so the checkbox shows up on every note, along with the inheritable `~runOnAttributeCreation` / `~runOnAttributeChange` hooks pointing at updateExpanded.js
- **updateExpanded.js** runs on any attribute change in the tree and ignores everything but the configured label. Ticked (`true`) gives the note a `runOnBranchChange` relation to expandBranches.js and runs it once; unticked (`false`, or the label deleted) takes that relation away
- **expandBranches.js** is what the `runOnBranchChange` relation points at: it expands the parent branches of every note flagged `true`, so a change anywhere in the tree re-opens all of them

See [Events](https://docs.triliumnotes.org/user-guide/scripts/backend-basics/events) for how those relations are dispatched.

## Settings

The two backend scripts read the values through `expandedConfig.js`, and setupRoot.js reads the same schema and config notes from the frontend; both come from the addon's settings (in the Trilium Addon Manager detail page):

- **Label Name** — the label marking a note as always expanded (default `alwaysExpanded`)
- **Promoted Definition** — the definition written to root for that label (default `promoted,alias=Always Expanded,single,boolean`)

The settings note carries `#expandedConfig`, so other addons can find it and flag their own notes with the configured label: agenda-overview@beatlink uses it for its **Always Expanded** folder levels.

Renaming the label takes effect on the next reload, when setupRoot.js removes the definition it wrote for the old name and writes the new one. Notes flagged under the old name keep the old label; re-tick them under the new checkbox.

## Installation

Import `expanded@beatlink.zip` via **Trilium Addon Manager** or manually via the Trilium import dialog.

## Usage

1. Navigate to any note you want to keep expanded
2. Tick **Always Expanded** in the note's promoted attributes
3. The note's branch stays expanded after restarts and navigation

## Upgrading from 1.x

Version 2.0.0 replaces the right-pane pin widget with the promoted checkbox. The flag is now matched by value: notes flagged under 1.x carry `#alwaysExpanded` with no value, so re-tick them once to store `true`.
