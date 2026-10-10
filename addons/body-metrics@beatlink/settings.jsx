import { useState, useEffect, NoteAutocomplete, LoadingSpinner } from "trilium:preact"
import { SettingsPage, resolveConfigNotes, loadSettings, saveSettings } from "libSettingsUI.jsx"

// The icon stamped on the note wired to render the widget.
const RENDER_ICON = "bx bx-body"

// Point `noteId` at the widget: make it a render note whose ~renderNote relation
// targets the widget code note (found by #bodyMetricsRender), and stamp its
// icon. Revert `previousNoteId` (if different) back to a plain text note, so
// switching notes never leaves an orphaned render note behind.
// Runs on the backend — the closure may reference only `api`.
async function reconcileRenderNote(noteId, previousNoteId, icon) {
    return api.runOnBackend((noteId, previousNoteId, icon) => {
        const found = api.searchForNotes("#bodyMetricsRender")[0]
            || api.searchForNotes('note.title = "bodyMetricsWidget.jsx"')[0]
        const srcId = found ? found.noteId : ""

        if (previousNoteId && previousNoteId !== noteId) {
            const prev = api.getNote(previousNoteId)
            if (prev) {
                prev.removeRelation("renderNote")
                if (prev.getLabelValue("iconClass") === icon) prev.removeLabel("iconClass")
                if (prev.type === "render") {
                    prev.type = "text"
                    prev.save()
                }
            }
        }

        if (!noteId) return { ok: true, cleared: true }
        if (!srcId) return { ok: false, reason: "no-render-source" }

        const note = api.getNote(noteId)
        if (!note || note.isDeleted) return { ok: false, reason: "note-not-found" }

        if (note.type !== "render") {
            note.type = "render"
            note.save()
        }
        // TAM renames activation attributes to `disabled:<name>` while an addon
        // is disabled, and ~renderNote is one of them. Clear that stale copy so
        // the note doesn't end up carrying both spellings.
        if (note.getRelationValue("disabled:renderNote")) note.removeRelation("disabled:renderNote")
        if (note.getRelationValue("renderNote") !== srcId) note.setRelation("renderNote", srcId)
        if (note.getLabelValue("iconClass") !== icon) note.setLabel("iconClass", icon)

        // Report what the note actually looks like now, so the UI can confirm
        // the wiring landed instead of assuming it did.
        return {
            ok: note.type === "render" && note.getRelationValue("renderNote") === srcId,
            type: note.type,
            srcId
        }
    }, [noteId, previousNoteId, icon])
}

function describe(result) {
    if (!result) return { error: "Wiring did not run." }
    if (result.cleared) return { ok: "Cleared. The previous note was reverted to a text note." }
    if (result.reason === "no-render-source") {
        return {
            error: "Could not find the widget note. Make sure body-metrics is enabled in TAM, " +
                "then apply again."
        }
    }
    if (result.reason === "note-not-found") return { error: "That note no longer exists." }
    if (!result.ok) return { error: `Wiring failed (type is "${result.type}").` }
    return { ok: "Wired. Open the note to see body metrics." }
}

// The Render Note picker: selecting a note converts it into a render note
// pointing at the widget (and reverts the previously-selected one). Persisted as
// renderNoteId in this addon's own settings note.
function RenderNotePicker() {
    const [noteIds, setNoteIds] = useState(null)
    const [noteId, setNoteId] = useState("")
    const [busy, setBusy] = useState(false)
    const [status, setStatus] = useState(null)

    useEffect(() => {
        (async () => {
            const resolved = await resolveConfigNotes(api.currentNote)
            const values = await loadSettings(resolved.schemaNoteId, resolved.configNoteId)
            setNoteId(values.renderNoteId || "")
            setNoteIds(resolved)
        })()
    }, [])

    async function wire(targetNoteId, previous) {
        setBusy(true)
        setStatus(null)
        try {
            const values = await loadSettings(noteIds.schemaNoteId, noteIds.configNoteId)
            values.renderNoteId = targetNoteId || ""
            await saveSettings(noteIds.schemaNoteId, noteIds.configNoteId, values)
            setStatus(describe(await reconcileRenderNote(targetNoteId || "", previous, RENDER_ICON)))
        } catch (e) {
            setStatus({ error: String(e && e.message ? e.message : e) })
        } finally {
            setBusy(false)
        }
    }

    async function onPick(newNoteId) {
        if (busy || newNoteId === noteId) return
        const previous = noteId
        setNoteId(newNoteId || "")
        await wire(newNoteId, previous)
    }

    if (!noteIds) return <div><LoadingSpinner /> Loading...</div>

    return (
        <div>
            <div className="lst-field-row">
                <label>Render Note</label>
                <NoteAutocomplete noteId={noteId} noteIdChanged={onPick} />
            </div>
            <p className="body-metrics-hint">
                The chosen note becomes a second place body metrics shows up, alongside the
                addon's own launcher. Clearing it reverts the previously-chosen note to a text note.
            </p>
            {/* Re-runs the wiring on the note already selected. Needed because
                picking the same note again is a no-op, so a note that was set
                while the addon was disabled would otherwise have no way to get
                fixed. */}
            <button disabled={busy || !noteId} onClick={() => wire(noteId, "")}>
                Apply render wiring
            </button>
            {status?.ok && <p className="body-metrics-ok">{status.ok}</p>}
            {status?.error && <p className="body-metrics-error">{status.error}</p>}
        </div>
    )
}

export default function BodyMetricsSettings() {
    // renderNoteId is `hidden` in the schema so the form doesn't render it twice
    // — this panel owns it, because picking a note has side effects beyond
    // storing the id.
    const extraPanels = [
        { tab: "Render Note", render: () => <RenderNotePicker /> }
    ]
    return <SettingsPage note={api.currentNote} extraPanels={extraPanels} />
}
