# Draw.io for TriliumNext

Integrates [Draw.io](https://www.drawio.com/) diagram editing into TriliumNext. Click any SVG note created from the template to open the Draw.io editor inline.

> Packaged from [SiriusXT/trilium-drawio](https://github.com/SiriusXT/trilium-drawio). All credit to [@SiriusXT](https://github.com/SiriusXT).
>
> The "Update draw.io" workflow checks upstream daily and lands its newest widget with this repo's local changes
> (`upstream.patch`, which keeps the edit button in zen mode) re-applied, then publishes it; if the changes no
> longer apply, the workflow fails and the update is merged by hand. The Draw.io editor itself always loads live
> from `embed.diagrams.net`.

## Features

- Edit SVG diagrams directly inside TriliumNext using the embedded Draw.io editor
- Supports light, dark, and auto themes
- Diagrams are saved as SVG and remain readable even if the widget is removed
- Configurable to use a self-hosted Draw.io instance
- Export diagrams to a file from Draw.io's own export menu

## Usage

1. Install via Trilium Addon Manager
2. Create a new note using the **drawio** template
3. Use the edit button in the note's action bar to toggle the Draw.io editor; new diagrams open it automatically

## Notes

- The official hosted Draw.io does not include PDF export. Self-hosting with the export backend is required for that feature.
- Diagrams are stored as SVG, so they are portable and not locked to this widget.
