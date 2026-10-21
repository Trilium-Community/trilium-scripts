import "recurrence-input.js"

const { splitRules, joinRules } = require("libAgendaTask.js")

// Pure value/onChange recurrence editor (an rrule string in, an rrule string
// out, null when it does not repeat) so it can be reused both on a note's own
// recurrence label (the Task pane's own "Recurrence" section) and on a plain
// config value (agenda's Reschedule Options settings panel). Several rules,
// such as 14:00 on weekends and 18:00 on weekdays, are stored as RRULE lines.
export function RecurrencePicker({ recurrence, onChange }){
    const rules = splitRules(recurrence)
    const shownRules = rules.length ? rules : [""]

    function changeRule(index, value) {
        const next = [...rules]
        next[index] = value
        onChange(joinRules(next) || null)
    }

    return (
        <div className="recurrence-picker">
            {shownRules.map((rule, index) => (
                <div className="recurrence-rule" key={index}>
                    {shownRules.length > 1 && (
                        <div className="recurrence-rule-header">
                            <span>Rule {index + 1}</span>
                            <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                onClick={() => onChange(joinRules(rules.filter((_, ruleIndex) => ruleIndex !== index)) || null)}
                            >
                                Remove
                            </button>
                        </div>
                    )}
                    <recurrence-input
                        value={rule}
                        features="standard"
                        time-mode="floating"
                        weekday-format="narrow"
                        input-class="form-control"
                        select-class="form-select"
                        button-class="btn btn-sm btn-secondary"
                        toggle-class="btn btn-primary"
                        toggle-input-class="btn-check"
                        onChange={event => changeRule(index, event.target.value)}
                    />
                </div>
            ))}
            {rules.length > 0 && (
                <button
                    type="button"
                    className="btn btn-sm btn-secondary recurrence-add-rule"
                    onClick={() => onChange(joinRules([...rules, "FREQ=WEEKLY"]))}
                >
                    Add another rule
                </button>
            )}
        </div>
    )
}
