import "recurrence-input.js"

// Pure value/onChange recurrence editor (an rrule string in, an rrule string
// out, null when it does not repeat) so it can be reused both on a note's own
// recurrence label (the Task pane's own "Recurrence" section) and on a plain
// config value (agenda's Reschedule Options settings panel).
export function RecurrencePicker({ recurrence, onChange }){
    return (
        <div className="recurrence-picker">
            <recurrence-input
                value={recurrence || ""}
                time-mode="floating"
                weekday-format="narrow"
                input-class="form-control"
                select-class="form-select"
                button-class="btn btn-sm btn-secondary"
                toggle-class="btn btn-primary"
                toggle-input-class="btn-check"
                onChange={event => onChange(event.target.value || null)}
            />
        </div>
    )
}
