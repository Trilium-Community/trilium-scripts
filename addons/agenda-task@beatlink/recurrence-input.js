// recurrence-input: rule helpers and a <recurrence-input> form field for iCalendar recurrence (RFC 5545), built on rrule.js.
// A value is an RRULE without its "RRULE:" prefix, or with value-format="ical" the RRULE, EXDATE and RDATE lines together.
// The element draws plain page elements with recurrence-input__* class names, so the page's own CSS styles it.
// Parts and lines the form cannot edit, such as RSCALE or TZID dates, are kept exactly as written.

import * as rrule_module from "rrule";

// Node loads rrule as CommonJS, which offers its classes only on the default export; ES module builds offer them by name.
const { RRule, RRuleSet } = rrule_module.RRule ? rrule_module : rrule_module.default;

// ===== Constants ===================================================================================================================

const rrule_weekday_codes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const display_weekday_codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const weekday_labels = {
    long: { SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday" },
    short: { SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat" },
    narrow: { SU: "S", MO: "M", TU: "T", WE: "W", TH: "T", FR: "F", SA: "S" },
};

const frequency_units = [
    ["SECONDLY", "second(s)"],
    ["MINUTELY", "minute(s)"],
    ["HOURLY", "hour(s)"],
    ["DAILY", "day(s)"],
    ["WEEKLY", "week(s)"],
    ["MONTHLY", "month(s)"],
    ["YEARLY", "year(s)"],
];

const month_names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const ordinal_choices = [
    ["", "every"],
    ["1", "first"],
    ["2", "second"],
    ["3", "third"],
    ["4", "fourth"],
    ["5", "fifth"],
    ["-1", "last"],
    ["-2", "second last"],
    ["-3", "third last"],
    ["-4", "fourth last"],
    ["-5", "fifth last"],
];

const rule_part_names = ["FREQ", "UNTIL", "COUNT", "INTERVAL", "BYSECOND", "BYMINUTE", "BYHOUR", "BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "WKST"];

const list_parts = {
    bymonth: { label: "BYMONTH", minimum: 1, maximum: 12, signed: false },
    byweekno: { label: "BYWEEKNO", minimum: 1, maximum: 53, signed: true },
    byyearday: { label: "BYYEARDAY", minimum: 1, maximum: 366, signed: true },
    bymonthday: { label: "BYMONTHDAY", minimum: 1, maximum: 31, signed: true },
    byweekday: { label: "BYDAY" },
    byhour: { label: "BYHOUR", minimum: 0, maximum: 23, signed: false },
    byminute: { label: "BYMINUTE", minimum: 0, maximum: 59, signed: false },
    bysecond: { label: "BYSECOND", minimum: 0, maximum: 60, signed: false },
    bysetpos: { label: "BYSETPOS", minimum: 1, maximum: 366, signed: true },
};

const feature_presets = {
    simple: [],
    standard: ["times", "month-days", "weekday-entries", "months", "set-position", "filters", "sub-daily", "exdates"],
};
feature_presets.full = [...feature_presets.standard, "more-options"];

// Reads a features attribute: presets and feature names add, names starting with "-" remove, and nothing given means standard.
function read_features(text) {
    const features = new Set();
    const tokens = (text ?? "").split(/[\s,]+/).filter(Boolean);
    for (const token of tokens.length > 0 ? tokens : ["standard"]) {
        const name = token.replace(/^[-+]/, "").toLowerCase();
        const names = feature_presets[name] ?? [name];
        for (const feature of names) token.startsWith("-") ? features.delete(feature) : features.add(feature);
    }
    return features;
}

const time_of_day_frequencies = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const day_of_month_frequencies = ["MONTHLY", "YEARLY"];
const sub_daily_frequencies = ["HOURLY", "MINUTELY", "SECONDLY"];

// ===== Formats and dates ===========================================================================================================

// Reads a format given as a time mode ("utc" or "floating") or as { time_mode, all_day }.
function read_format(format) {
    if (typeof format === "string") return { time_mode: format, all_day: false };
    return { time_mode: "utc", all_day: false, ...format };
}

// Converts a real date to the date rrule works with: a UTC midnight for all-day, local clock as UTC fields for floating, else unchanged.
export function to_rule_date(date, format = "utc") {
    const { time_mode, all_day } = read_format(format);
    if (all_day) return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    if (time_mode !== "floating") return new Date(date);
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()));
}

// Converts a date from rrule back to a real date, the reverse of to_rule_date.
export function from_rule_date(date, format = "utc") {
    const { time_mode, all_day } = read_format(format);
    if (all_day) return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (time_mode !== "floating") return new Date(date);
    return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
}

// Returns the kind a rule date is written as: the kind it was read with, else the format's.
function ical_kind(date, format) {
    const { time_mode, all_day } = read_format(format);
    return date.ical_kind ?? (all_day ? "date" : time_mode === "floating" ? "floating" : "utc");
}

// Writes a rule date as iCalendar text of its kind: a DATE, a DATE-TIME without "Z", or a UTC DATE-TIME.
function format_ical_date(date, kind) {
    const iso = date.toISOString();
    const day = iso.slice(0, 10).replaceAll("-", "");
    if (kind === "date") return day;
    return `${day}T${iso.slice(11, 19).replaceAll(":", "")}${kind === "floating" ? "" : "Z"}`;
}

// Reads iCalendar DATE or DATE-TIME text into a rule date that remembers its kind ("date", "floating" or "utc"); throws on anything else.
function parse_ical_date(text) {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(text.trim());
    if (!match) throw new Error(`"${text}" is not an iCalendar date.`);
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map((field) => Number(field ?? 0));
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    date.ical_kind = match[4] === undefined ? "date" : match[7] ? "utc" : "floating";
    return date;
}

// Returns a date as the "YYYY-MM-DDTHH:MM" text a datetime-local input uses, read from its local or UTC fields.
function to_datetime_input(date, use_utc_fields) {
    const pad = (number) => String(number).padStart(2, "0");
    const fields = use_utc_fields
        ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()]
        : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
    return `${fields[0]}-${pad(fields[1])}-${pad(fields[2])}T${pad(fields[3])}:${pad(fields[4])}`;
}

// ===== Rules =======================================================================================================================

// Parses one rule into rrule options with every BY part as a list, keeping unknown parts such as RSCALE in extra_parts.
export function parse_rule(rule_text) {
    const lines = String(rule_text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const rule_line = lines.find((line) => /^RRULE:/i.test(line)) ?? lines[0] ?? "";
    const known_parts = [];
    const extra_parts = [];
    for (const part of rule_line.replace(/^RRULE:/i, "").split(";").map((text) => text.trim()).filter(Boolean)) {
        const name = part.split("=")[0].toUpperCase();
        (rule_part_names.includes(name) ? known_parts : extra_parts).push(part);
    }
    const options = RRule.parseString(known_parts.join(";"));
    if (options.freq === undefined) throw new Error("The rule has no FREQ part.");
    delete options.dtstart;
    delete options.tzid;
    for (const part of Object.keys(list_parts)) {
        if (options[part] === undefined || options[part] === null) delete options[part];
        else options[part] = [options[part]].flat().map((value) => (part === "byweekday" && typeof value === "number" ? RRule[rrule_weekday_codes[value]] : value));
    }
    if (extra_parts.length > 0) options.extra_parts = extra_parts;
    return options;
}

// Returns options rrule itself accepts, without the kept extra parts.
function rrule_options(options) {
    const { extra_parts, ...known_options } = options;
    return known_options;
}

// Turns options into a rule value with FREQ and INTERVAL first, an UNTIL that matches the format, and any kept extra parts last.
export function format_rule(options, format = "utc") {
    const { time_mode, all_day } = read_format(format);
    const { freq, interval, extra_parts = [], ...other_options } = options;
    for (const part of Object.keys(list_parts)) if (Array.isArray(other_options[part]) && other_options[part].length === 0) delete other_options[part];
    const ordered_options = interval && interval !== 1 ? { freq, interval, ...other_options } : { freq, ...other_options };
    const rule_line = RRule.optionsToString(ordered_options)
        .split("\n")
        .find((line) => line.startsWith("RRULE:"));
    const rule_text = (rule_line ?? "").slice("RRULE:".length).replace(/UNTIL=(\d{8})T(\d{6})Z/, (whole, day, time) => {
        if (all_day) return `UNTIL=${day}`;
        return time_mode === "floating" ? `UNTIL=${day}T${time}` : whole;
    });
    const calendar_parts = extra_parts.filter((part) => /^RSCALE=/i.test(part));
    const other_parts = extra_parts.filter((part) => !/^RSCALE=/i.test(part));
    return [...calendar_parts, rule_text, ...other_parts].filter(Boolean).join(";");
}

// Returns a rule's non-Gregorian RSCALE part, such as "RSCALE=HEBREW", or "" when it uses the Gregorian calendar.
export function rule_calendar(options) {
    const calendar = (options?.extra_parts ?? []).find((part) => /^RSCALE=/i.test(part));
    return calendar && !/=GREGORIAN$/i.test(calendar) ? calendar : "";
}

// ===== Recurrence sets =============================================================================================================

// Reports whether text holds iCalendar property lines rather than a bare rule.
function is_recurrence_text(text) {
    return /\n/.test(text) || /^(RRULE|EXDATE|RDATE|DTSTART)[:;]/i.test(text.trim());
}

// Parses RRULE, EXDATE and RDATE lines; lines it cannot edit, such as TZID dates, are kept as written in extra_lines.
export function parse_recurrence(text) {
    const recurrence = { rule: null, exdates: [], rdates: [], extra_lines: [] };
    const lines = [];
    for (const line of String(text).split(/\r?\n/)) {
        if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += line.slice(1);
        else lines.push(line);
    }
    for (const line of lines.map((text) => text.trim()).filter(Boolean)) {
        const colon = line.indexOf(":");
        const [name, ...parameters] = (colon < 0 ? "" : line.slice(0, colon)).toUpperCase().split(";");
        const value = line.slice(colon + 1);
        const plain_dates = parameters.every((parameter) => parameter === "VALUE=DATE" || parameter === "VALUE=DATE-TIME");
        if (name === "RRULE" && !recurrence.rule) recurrence.rule = parse_rule(value);
        else if ((name === "EXDATE" || name === "RDATE") && plain_dates) {
            recurrence[name === "EXDATE" ? "exdates" : "rdates"].push(...value.split(",").map(parse_ical_date));
        } else if (colon < 0 && !recurrence.rule && /FREQ=/i.test(line)) recurrence.rule = parse_rule(line);
        else recurrence.extra_lines.push(line);
    }
    if (!recurrence.rule && recurrence.rdates.length === 0) throw new Error("There is no RRULE or RDATE.");
    return recurrence;
}

// Writes a parsed recurrence back as RRULE, EXDATE and RDATE lines in the given format, followed by any kept lines.
export function format_recurrence(recurrence, format = "utc") {
    const date_lines = (name, dates = []) =>
        ["date", "floating", "utc"]
            .map((kind) => [kind, dates.filter((date) => ical_kind(date, format) === kind)])
            .filter(([, kind_dates]) => kind_dates.length > 0)
            .map(([kind, kind_dates]) => `${name}${kind === "date" ? ";VALUE=DATE" : ""}:${kind_dates.map((date) => format_ical_date(date, kind)).join(",")}`);
    const lines = [];
    if (recurrence.rule) lines.push(`RRULE:${format_rule(recurrence.rule, format)}`);
    lines.push(...date_lines("EXDATE", recurrence.exdates), ...date_lines("RDATE", recurrence.rdates));
    return [...lines, ...(recurrence.extra_lines ?? [])].join("\n");
}

// Parses a value of either kind into a recurrence.
function read_recurrence(text) {
    return is_recurrence_text(text) ? parse_recurrence(text) : { rule: parse_rule(text), exdates: [], rdates: [], extra_lines: [] };
}

// Builds an rrule set counted from rule_start; throws for RSCALE calendars, which rrule.js cannot calculate.
function build_rule_set(recurrence, rule_start) {
    const calendar = rule_calendar(recurrence.rule);
    if (calendar) throw new Error(`rrule.js cannot calculate ${calendar}.`);
    const rule_set = new RRuleSet();
    if (recurrence.rule) rule_set.rrule(new RRule({ ...rrule_options(recurrence.rule), dtstart: rule_start }));
    for (const date of recurrence.rdates) rule_set.rdate(date);
    for (const date of recurrence.exdates) rule_set.exdate(date);
    return rule_set;
}

// ===== Rule helpers ================================================================================================================

// Describes a rule or recurrence in plain English with dates in local time, or returns "" when it has no English form.
export function describe_rule(text, format = "utc") {
    if (!text) return "";
    const { all_day, time_mode } = read_format(format);
    try {
        const recurrence = read_recurrence(text);
        if (!recurrence.rule || rule_calendar(recurrence.rule)) return "";
        const { byhour, byminute, bysecond, bysetpos, count, until, ...pattern } = rrule_options(recurrence.rule);
        const rule = new RRule(pattern);
        if (!rule.isFullyConvertibleToText()) return "";
        const plural = (number, word) => `${number} ${word}${number === 1 ? "" : "s"}`;
        const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
        const pad = (number) => String(number).padStart(2, "0");
        let description = rule.toText();
        if (bysetpos) description += `, only the ${list(bysetpos.map(ordinal_word))} of those`;
        if (byhour) {
            const times = byhour.flatMap((hour) => (byminute ?? [0]).flatMap((minute) => (bysecond ?? [null]).map((second) => `${pad(hour)}:${pad(minute)}${second === null ? "" : `:${pad(second)}`}`)));
            description += ` at ${list(times)}`;
        } else {
            if (byminute) description += ` at ${list(byminute.map(String))} minutes past the hour`;
            if (bysecond) description += `${byminute ? " and" : " at"} ${list(bysecond.map(String))} seconds past the minute`;
        }
        if (count) description += ` for ${plural(count, "time")}`;
        if (until) {
            const local_until = all_day || time_mode === "floating" ? until : to_rule_date(until, "floating");
            description += ` until ${local_until.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
        }
        if (recurrence.exdates.length > 0) description += `, except ${plural(recurrence.exdates.length, "date")}`;
        if (recurrence.rdates.length > 0) description += `, plus ${plural(recurrence.rdates.length, "other date")}`;
        return description.charAt(0).toUpperCase() + description.slice(1);
    } catch {
        return "";
    }
}

// Returns the occurrence after start_date and the value to carry forward, with COUNT lowered by one; null when it has ended.
export function next_occurrence(text, start_date, format = "utc") {
    const recurrence = read_recurrence(text);
    const rule_start = to_rule_date(start_date, format);
    const next_date = build_rule_set(recurrence, rule_start).after(rule_start, false);
    if (!next_date) return null;
    if (recurrence.rule?.count) recurrence.rule.count -= 1;
    const next_text = is_recurrence_text(text) ? format_recurrence(recurrence, format) : format_rule(recurrence.rule, format);
    return { next_date: from_rule_date(next_date, format), rule: next_text };
}

// Returns the first occurrence from the current minute onwards for a rule counted from then, or null when it yields none.
export function next_from_now(text, format = "utc") {
    const this_minute = new Date();
    this_minute.setSeconds(0, 0);
    const now = to_rule_date(this_minute, format);
    const next_date = build_rule_set(read_recurrence(text), now).after(now, true);
    return next_date ? from_rule_date(next_date, format) : null;
}

// Returns the English word for a position, such as "first", "last" or "12th".
function ordinal_word(position) {
    const known = ordinal_choices.find(([value]) => value === String(position));
    if (known) return known[1];
    const size = Math.abs(position);
    const suffix = size % 100 >= 11 && size % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][size % 10] ?? "th";
    return position < 0 ? `${size}${suffix} last` : `${size}${suffix}`;
}

// Reads a comma or space separated list for one BY part; throws a message naming the allowed values.
function parse_part_list(part, text) {
    const tokens = String(text).split(/[\s,]+/).filter(Boolean);
    if (part === "byweekday") {
        return tokens.map((token) => {
            const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(token);
            const number = match?.[1] ? Number(match[1]) : 0;
            if (!match || Math.abs(number) > 53) throw new Error(`BYDAY takes weekdays such as MO or -1FR, not "${token}".`);
            const weekday = RRule[match[2].toUpperCase()];
            return number ? weekday.nth(number) : weekday;
        });
    }
    const { label, minimum, maximum, signed } = list_parts[part];
    return tokens.map((token) => {
        const number = Number(token);
        const size = Math.abs(number);
        if (!Number.isInteger(number) || size < minimum || size > maximum || (number < 0 && !signed)) {
            throw new Error(`${label} takes whole numbers from ${signed ? `-${maximum} to -${minimum} and ` : ""}${minimum} to ${maximum}, not "${token}".`);
        }
        return number;
    });
}

// ===== Element styles ==============================================================================================================

const default_styles = `
    :where(recurrence-input) { display: block; }
    :where(recurrence-input [hidden]) { display: none !important; }
    :where(.recurrence-input__row) { display: flex; align-items: baseline; gap: 0.5rem; margin: 0.5em 0; }
    :where(.recurrence-input__controls) { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 0.25rem; min-width: 0; }
    :where(.recurrence-input__row-label) { flex: none; width: 3.5em; }
    :where(.recurrence-input__number) { width: 5em; }
    :where(.recurrence-input__list) { display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem; flex-basis: 100%; }
    :where(.recurrence-input__item) { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
    :where(.recurrence-input__toggle) { display: inline-flex; }
    :where(.recurrence-input__toggle-input) { position: absolute; opacity: 0; pointer-events: none; }
    :where(.recurrence-input__toggle-label) {
        display: inline-block; min-width: 2.5em; padding: 0.2em 0.4em; text-align: center; cursor: pointer;
        border: 1px solid currentColor; border-radius: 0.3em; opacity: 0.7; user-select: none;
    }
    :where(.recurrence-input__toggle-input:checked + .recurrence-input__toggle-label) {
        opacity: 1; background: Highlight; color: HighlightText; border-color: Highlight;
    }
    :where(.recurrence-input__toggle-input:focus-visible + .recurrence-input__toggle-label) { outline: 2px solid Highlight; outline-offset: 1px; }
    :where(.recurrence-input__more) { margin: 0.5em 0; }
    :where(.recurrence-input__more > summary) { cursor: pointer; }
    :where(.recurrence-input__part) { display: flex; align-items: center; gap: 0.5rem; margin: 0.25em 0; }
    :where(.recurrence-input__part-name) { flex: none; width: 7em; font-family: monospace; }
    :where(.recurrence-input__summary) { margin: 0.5em 0 0; font-style: italic; }
    :where(.recurrence-input__summary--invalid) { color: #c22f3c; font-style: normal; }
`;

let default_style_sheet = null;

// Adds the default styles once to the document or shadow root holding an element.
function adopt_default_styles(root) {
    if (!root.adoptedStyleSheets) return;
    if (!default_style_sheet) {
        default_style_sheet = new CSSStyleSheet();
        default_style_sheet.replaceSync(default_styles);
    }
    if (!root.adoptedStyleSheets.includes(default_style_sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, default_style_sheet];
}

// ===== Element markup ==============================================================================================================

let next_element_number = 0;

// Builds an option list from [value, label] pairs.
function options_markup(pairs) {
    return pairs.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
}

// Builds a row of toggle buttons, each a hidden checkbox and the label drawn as its button.
function toggles_markup(id_prefix, control, pairs) {
    return pairs
        .map(
            ([value, label, title]) => `<span class="recurrence-input__toggle">
                <input class="recurrence-input__toggle-input" type="checkbox" id="${id_prefix}-${control}-${value}" value="${value}" data-control="${control}" data-kind="toggle" aria-label="${title}">
                <label class="recurrence-input__toggle-label" for="${id_prefix}-${control}-${value}" title="${title}">${label}</label>
            </span>`,
        )
        .join("");
}

// Builds a labelled row; its controls come from the caller.
function row_markup(id_prefix, section, label, controls) {
    return `<div class="recurrence-input__row recurrence-input__${section.replaceAll("_", "-")}" role="group" aria-labelledby="${id_prefix}-${section}" data-section="${section}">
        <span class="recurrence-input__row-label" id="${id_prefix}-${section}">${label}</span>
        <span class="recurrence-input__controls">${controls}</span>
    </div>`;
}

// Builds the element's controls, giving each instance its own ids so labels stay tied to their inputs.
function element_markup(id_prefix, weekday_format) {
    const labels = weekday_labels[weekday_format] ?? weekday_labels.short;
    const weekday_pairs = display_weekday_codes.map((code) => [code, labels[code], weekday_labels.long[code]]);
    const month_pairs = month_names.map((name, index) => [String(index + 1), name.slice(0, 3), name]);
    const weekday_options = options_markup(display_weekday_codes.map((code) => [code, weekday_labels.long[code]]));
    const part_rows = Object.entries(list_parts)
        .map(
            ([part, { label }]) => `<label class="recurrence-input__part" data-part-row="${part}">
                <span class="recurrence-input__part-name">${label}</span>
                <input type="text" data-control="part" data-part="${part}" data-kind="input" data-commit="change" autocomplete="off">
            </label>`,
        )
        .join("");
    return `
        <label class="recurrence-input__enabled"><input type="checkbox" data-control="enabled"> Repeats</label>
        ${row_markup(id_prefix, "repeat", "Every", `
            <input class="recurrence-input__number" type="number" min="1" step="1" value="1" aria-label="Interval" data-control="interval" data-kind="input">
            <select data-control="frequency" data-kind="select" aria-label="Unit">${options_markup(frequency_units)}</select>`)}
        ${row_markup(id_prefix, "weekdays", "On", toggles_markup(id_prefix, "weekday", weekday_pairs))}
        ${row_markup(id_prefix, "months", "In", toggles_markup(id_prefix, "month", month_pairs))}
        ${row_markup(id_prefix, "month_days", "On", `
            <select data-control="day_mode" data-kind="select" aria-label="Which days">
                <option value="start">the start's day</option>
                <option value="days">certain days of the month</option>
                <option value="weekdays">certain weekdays</option>
                <option value="both">certain days that fall on certain weekdays</option>
            </select>
            <input type="text" placeholder="15, -1" aria-label="Days of the month, -1 for the last" data-control="month_days" data-kind="input" data-commit="change" autocomplete="off">
            <span class="recurrence-input__list" data-list="entries"></span>
            <button type="button" data-action="add_entry" data-kind="button">Add a weekday</button>`)}
        ${row_markup(id_prefix, "set_position", "Use", `
            <select data-control="set_position" data-kind="select" aria-label="Which of the matching days">
                <option value="">all of them</option>
                ${options_markup(ordinal_choices.slice(1).map(([value, label]) => [value, `only the ${label}`]))}
                <option value="custom" disabled>a custom set (see More options)</option>
            </select>`)}
        ${row_markup(id_prefix, "times", "At", `
            <span class="recurrence-input__list" data-list="times"></span>
            <button type="button" data-action="add_time" data-kind="button">Add a time</button>`)}
        ${row_markup(id_prefix, "hour_minutes", "At", `
            <input type="text" placeholder="0, 30" aria-label="Minutes past the hour" data-control="hour_minutes" data-kind="input" data-commit="change" autocomplete="off">
            <span>minutes past</span>`)}
        ${row_markup(id_prefix, "minute_seconds", "At", `
            <input type="text" placeholder="0, 30" aria-label="Seconds past the minute" data-control="minute_seconds" data-kind="input" data-commit="change" autocomplete="off">
            <span>seconds past</span>`)}
        ${row_markup(id_prefix, "end", "Ends", `
            <select data-control="end_type" data-kind="select" aria-label="How it ends">
                <option value="never">never</option>
                <option value="count">after a number of times</option>
                <option value="until">on a date</option>
            </select>
            <input class="recurrence-input__number" type="number" min="1" step="1" value="1" aria-label="Number of times" data-control="end_count" data-kind="input">
            <input type="datetime-local" aria-label="End date" data-control="end_date" data-kind="input">`)}
        ${row_markup(id_prefix, "exdates", "Except", `
            <span class="recurrence-input__list" data-list="exdates"></span>
            <button type="button" data-action="add_exdate" data-kind="button">Skip a date</button>`)}
        ${row_markup(id_prefix, "rdates", "Also", `
            <span class="recurrence-input__list" data-list="rdates"></span>
            <button type="button" data-action="add_rdate" data-kind="button">Add a date</button>`)}
        <details class="recurrence-input__more" data-section="more">
            <summary>More options</summary>
            ${part_rows}
            <label class="recurrence-input__part">
                <span class="recurrence-input__part-name">WKST</span>
                <select data-control="week_start" data-kind="select" aria-label="Week starts on">
                    <option value="">Monday (default)</option>
                    ${weekday_options}
                </select>
            </label>
        </details>
        <p class="recurrence-input__summary" aria-live="polite"></p>
        <template data-template="entries">
            <span class="recurrence-input__item">
                <select data-control="entry_ordinal" data-kind="select" aria-label="Which">${options_markup(ordinal_choices)}</select>
                <select data-control="entry_weekday" data-kind="select" aria-label="Weekday">${weekday_options}</select>
                <button type="button" data-action="remove_entry" data-kind="button" aria-label="Remove">×</button>
            </span>
        </template>
        <template data-template="times">
            <span class="recurrence-input__item">
                <input type="time" data-control="time" data-kind="input" aria-label="Time">
                <button type="button" data-action="remove_time" data-kind="button" aria-label="Remove">×</button>
            </span>
        </template>
        <template data-template="exdates">
            <span class="recurrence-input__item">
                <input type="datetime-local" data-control="exdate" data-kind="input" aria-label="Date to skip">
                <button type="button" data-action="remove_exdate" data-kind="button" aria-label="Remove">×</button>
            </span>
        </template>
        <template data-template="rdates">
            <span class="recurrence-input__item">
                <input type="datetime-local" data-control="rdate" data-kind="input" aria-label="Extra date">
                <button type="button" data-action="remove_rdate" data-kind="button" aria-label="Remove">×</button>
            </span>
        </template>
    `;
}

// ===== Element =====================================================================================================================

// Defines the element class; it is only called where the DOM exists, so the rule helpers also load outside a browser.
function create_element_class() {
    return class RecurrenceInput extends HTMLElement {
        static formAssociated = true;
        static observedAttributes = ["value", "features", "time-mode", "all-day", "value-format", "start", "input-class", "select-class", "button-class", "toggle-class", "toggle-input-class"];

        #internals = this.attachInternals();
        #controls = null;
        #disabled = false;
        #value = "";
        #value_is_dirty = false;
        #state = { enabled: false, options: {}, exdates: [], rdates: [], extra_lines: [] };
        #load_error = "";
        #verbatim_text = "";
        #field_errors = new Map();

        // Listens in the capture phase so the page only ever sees the element's own events, never its inner controls'.
        constructor() {
            super();
            for (const type of ["input", "change", "click"]) this.addEventListener(type, (event) => this.#handle_event(event), true);
        }

        // Adds the default styles and draws the controls the first time the element joins a page.
        connectedCallback() {
            adopt_default_styles(this.getRootNode());
            if (!this.#controls) this.#load_value(this.#value_is_dirty ? this.#value : (this.getAttribute("value") ?? ""));
        }

        // Follows the value attribute until the value is set another way, and redraws when a format or class attribute changes.
        attributeChangedCallback(name, old_value, new_value) {
            if (name === "value") {
                if (!this.#value_is_dirty) this.#load_value(new_value ?? "");
            } else if (this.#controls) {
                this.#apply_host_classes();
                this.#load_value(this.#value_is_dirty ? this.#value : (this.getAttribute("value") ?? ""));
            }
        }

        // ===== Public interface ====================================================================================================

        get value() {
            return this.#value;
        }

        set value(new_value) {
            this.#value_is_dirty = true;
            this.#load_value(String(new_value ?? ""));
        }

        get features() {
            return read_features(this.getAttribute("features"));
        }

        get format() {
            return { time_mode: this.getAttribute("time-mode") === "floating" ? "floating" : "utc", all_day: this.hasAttribute("all-day") };
        }

        get form() {
            return this.#internals.form;
        }

        get name() {
            return this.getAttribute("name");
        }

        get type() {
            return "recurrence";
        }

        get validity() {
            return this.#internals.validity;
        }

        get validationMessage() {
            return this.#internals.validationMessage;
        }

        get willValidate() {
            return this.#internals.willValidate;
        }

        // Reports whether the value is a rule the form could read and every field holds a usable value.
        checkValidity() {
            return this.#internals.checkValidity();
        }

        // Reports validity and shows the browser's message when the value is not valid.
        reportValidity() {
            return this.#internals.reportValidity();
        }

        // ===== Form callbacks ======================================================================================================

        // Puts the value back to the value attribute when the form is reset.
        formResetCallback() {
            this.#value_is_dirty = false;
            this.#load_value(this.getAttribute("value") ?? "");
        }

        // Restores the value the browser saved for this field on back navigation or autofill.
        formStateRestoreCallback(state) {
            this.value = state;
        }

        // Enables or disables every control along with the form.
        formDisabledCallback(disabled) {
            this.#disabled = disabled;
            if (this.#controls) this.#apply_disabled();
        }

        // ===== Drawing =============================================================================================================

        // Draws the controls once.
        #render() {
            if (this.#controls) return;
            const id_prefix = `recurrence-input-${++next_element_number}`;
            this.innerHTML = element_markup(id_prefix, this.getAttribute("weekday-format"));
            const controls = { weekdays: [], months: [], parts: {}, sections: {}, lists: {}, templates: {} };
            for (const element of this.querySelectorAll("[data-control]")) {
                const control = element.dataset.control;
                if (control === "weekday") controls.weekdays.push(element);
                else if (control === "month") controls.months.push(element);
                else if (control === "part") controls.parts[element.dataset.part] = element;
                else if (!element.closest("template")) controls[control] = element;
            }
            for (const element of this.querySelectorAll("[data-section]")) controls.sections[element.dataset.section] = element;
            for (const element of this.querySelectorAll("[data-list]")) controls.lists[element.dataset.list] = element;
            for (const element of this.querySelectorAll("template[data-template]")) controls.templates[element.dataset.template] = element;
            controls.summary = this.querySelector(".recurrence-input__summary");
            this.#controls = controls;
            this.#apply_host_classes();
            this.#apply_disabled();
        }

        // Adds the classes named by the input-class, select-class, button-class, toggle-class and toggle-input-class attributes.
        #apply_host_classes() {
            const class_names = (attribute) => (this.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean);
            const targets = [
                ["input-class", '[data-kind="input"]'],
                ["select-class", '[data-kind="select"]'],
                ["button-class", '[data-kind="button"]'],
                ["toggle-class", ".recurrence-input__toggle-label"],
                ["toggle-input-class", ".recurrence-input__toggle-input"],
            ];
            for (const [attribute, selector] of targets) {
                for (const element of this.querySelectorAll(selector)) {
                    if (element.closest("template")) continue;
                    element.classList.remove(...(element.dataset.hostClasses ?? "").split(" ").filter(Boolean));
                    element.classList.add(...class_names(attribute));
                    element.dataset.hostClasses = class_names(attribute).join(" ");
                }
            }
        }

        // Matches every control's disabled state to the element's.
        #apply_disabled() {
            for (const control of this.querySelectorAll("input, select, button")) control.disabled = this.#disabled;
        }

        // Makes a list hold one item per value, adding or removing items from the end, and returns the items.
        #sync_list(list_name, count) {
            const list = this.#controls.lists[list_name];
            while (list.children.length > count) list.lastElementChild.remove();
            while (list.children.length < count) {
                list.append(this.#controls.templates[list_name].content.firstElementChild.cloneNode(true));
                this.#apply_host_classes();
                this.#apply_disabled();
            }
            return [...list.children];
        }

        // ===== Reading a value =====================================================================================================

        // Parses a value into the state and the controls, keeping the parts the form cannot edit.
        #load_value(text) {
            this.#render();
            this.#field_errors.clear();
            this.#load_error = "";
            this.#verbatim_text = "";
            this.#state = { enabled: false, options: {}, exdates: [], rdates: [], extra_lines: [] };
            const trimmed_text = text.trim();
            if (trimmed_text !== "") {
                try {
                    const recurrence = this.getAttribute("value-format") === "ical" ? read_recurrence(trimmed_text) : { ...read_recurrence(trimmed_text), exdates: [], rdates: [], extra_lines: [] };
                    if (!recurrence.rule) throw new Error("The form needs an RRULE line.");
                    this.#state = { enabled: true, options: recurrence.rule, exdates: recurrence.exdates, rdates: recurrence.rdates, extra_lines: recurrence.extra_lines };
                    if (rule_calendar(recurrence.rule)) this.#verbatim_text = trimmed_text;
                } catch (error) {
                    this.#state.enabled = true;
                    this.#load_error = `This is not a recurrence rule the form can read: ${error.message}`;
                }
            }
            this.#refresh(null, this.#load_error ? trimmed_text : null);
        }

        // ===== Writing a value =====================================================================================================

        // Applies an inner control's change to the state, then fires the same event from the element itself.
        #handle_event(event) {
            if (event.target === this || !this.#controls) return;
            const target = event.target;
            if (event.type === "click") {
                const button = target.closest?.("button[data-action]");
                if (!button || !this.contains(button)) return;
                this.#edit(() => this.#apply_action(button.dataset.action, button), button);
                this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
                this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
                return;
            }
            event.stopPropagation();
            if (!target.dataset?.control) return;
            if (target.dataset.commit === "change" && event.type !== "change") return;
            this.#edit(() => this.#apply_control(target), target);
            this.dispatchEvent(new Event(event.type, { bubbles: true, composed: true }));
        }

        // Runs one edit, starting a fresh rule first when the loaded value could not be read.
        #edit(apply_edit, active_element) {
            if (this.#load_error) {
                this.#load_error = "";
                this.#state = { enabled: true, options: { freq: RRule[this.#controls.frequency.value] }, exdates: [], rdates: [], extra_lines: [] };
            }
            this.#value_is_dirty = true;
            apply_edit();
            this.#refresh(active_element, null);
        }

        // Records a problem with one field, or clears it when message is empty.
        #set_field_error(element, message) {
            if (message) this.#field_errors.set(element, message);
            else this.#field_errors.delete(element);
            element.setCustomValidity?.(message);
        }

        // Applies a change from one control to the rule.
        #apply_control(target) {
            const controls = this.#controls;
            const state = this.#state;
            const options = state.options;
            const control = target.dataset.control;
            const read_number = (input, fallback) => (Number.isFinite(parseInt(input.value, 10)) ? parseInt(input.value, 10) : fallback);
            if (control === "enabled") {
                state.enabled = target.checked;
                if (state.enabled && options.freq === undefined) options.freq = RRule.DAILY;
            } else if (control === "interval") {
                const interval = Math.max(1, read_number(target, 1));
                if (interval === 1) delete options.interval;
                else options.interval = interval;
            } else if (control === "frequency") this.#set_frequency(target.value);
            else if (control === "weekday") {
                set_list(options, "byweekday", controls.weekdays.filter((checkbox) => checkbox.checked).map((checkbox) => RRule[checkbox.value]));
            } else if (control === "month") {
                if (!this.features.has("months") && target.checked) for (const checkbox of controls.months) checkbox.checked = checkbox === target;
                const months = controls.months.filter((checkbox) => checkbox.checked).map((checkbox) => Number(checkbox.value));
                if (months.length === 0 && this.#needs_month(true)) target.checked = true;
                else set_list(options, "bymonth", months);
            } else if (control === "day_mode") this.#set_day_mode(target.value);
            else if (control === "month_days") this.#apply_list_text(target, "bymonthday", this.features.has("month-days") ? 0 : 1);
            else if (control === "entry_ordinal" || control === "entry_weekday") this.#read_entries();
            else if (control === "set_position") set_list(options, "bysetpos", target.value === "" ? [] : [Number(target.value)]);
            else if (control === "time") this.#read_times(target);
            else if (control === "hour_minutes") this.#apply_list_text(target, "byminute");
            else if (control === "minute_seconds") this.#apply_list_text(target, "bysecond");
            else if (control === "end_type" || control === "end_count" || control === "end_date") {
                if (control === "end_type" && target.value === "until" && !controls.end_date.value) controls.end_date.value = this.#default_end_input();
                delete options.count;
                delete options.until;
                if (controls.end_type.value === "count") options.count = Math.max(1, read_number(controls.end_count, 1));
                if (controls.end_type.value === "until" && controls.end_date.value) options.until = this.#rule_date_from_input(controls.end_date.value);
            } else if (control === "exdate" || control === "rdate") this.#read_dates(control);
            else if (control === "part") this.#apply_list_text(target, target.dataset.part);
            else if (control === "week_start") {
                if (target.value) options.wkst = RRule[target.value];
                else delete options.wkst;
            }
        }

        // Applies an add or remove button.
        #apply_action(action, button) {
            const options = this.#state.options;
            const item_index = () => [...button.closest(".recurrence-input__item").parentElement.children].indexOf(button.closest(".recurrence-input__item"));
            if (action === "add_entry") {
                const { weekday, ordinal } = this.#default_weekday();
                set_list(options, "byweekday", [...(options.byweekday ?? []), RRule[weekday].nth(ordinal)]);
                if (this.#needs_month()) options.bymonth = [this.#default_month()];
            } else if (action === "remove_entry") set_list(options, "byweekday", (options.byweekday ?? []).filter((entry, index) => index !== item_index()));
            else if (action === "add_time") {
                const hours = options.byhour ?? [];
                const next_hour = hours.length > 0 ? (Math.max(...hours) + 1) % 24 : 9;
                const items = this.#sync_list("times", this.#controls.lists.times.children.length + 1);
                items.at(-1).querySelector("input").value = `${String(next_hour).padStart(2, "0")}:${String(options.byminute?.[0] ?? 0).padStart(2, "0")}`;
                this.#read_times(null);
            } else if (action === "remove_time") {
                button.closest(".recurrence-input__item").remove();
                this.#read_times(null);
            } else if (action === "add_exdate" || action === "add_rdate") {
                const list_name = action === "add_exdate" ? "exdates" : "rdates";
                this.#state[list_name] = [...this.#state[list_name], this.#rule_date_from_input(this.#default_date_input())];
            } else if (action === "remove_exdate" || action === "remove_rdate") {
                const list_name = action === "remove_exdate" ? "exdates" : "rdates";
                this.#state[list_name] = this.#state[list_name].filter((date, index) => index !== item_index());
            }
        }

        // Changes the frequency and drops the parts RFC 5545 does not allow with it.
        #set_frequency(frequency) {
            const options = this.#state.options;
            options.freq = RRule[frequency];
            if (frequency !== "YEARLY") delete options.byweekno;
            if (["DAILY", "WEEKLY", "MONTHLY"].includes(frequency)) delete options.byyearday;
            if (frequency === "WEEKLY") delete options.bymonthday;
            if (!day_of_month_frequencies.includes(frequency) && options.byweekday) {
                const codes = [...new Set(options.byweekday.map((entry) => rrule_weekday_codes[entry.weekday]))];
                set_list(options, "byweekday", codes.map((code) => RRule[code]));
            }
            if (this.#needs_month()) options.bymonth = [this.#default_month()];
        }

        // Switches a monthly or yearly rule between the start's day, days of the month, weekdays, or both.
        #set_day_mode(mode) {
            const options = this.#state.options;
            if (mode === "start" || mode === "weekdays") delete options.bymonthday;
            if (mode === "start" || mode === "days") delete options.byweekday;
            if (mode === "start") delete options.bysetpos;
            if ((mode === "days" || mode === "both") && !options.bymonthday) options.bymonthday = [this.#default_month_day()];
            if ((mode === "weekdays" || mode === "both") && !options.byweekday) {
                const { weekday, ordinal } = this.#default_weekday();
                options.byweekday = [mode === "both" ? RRule[weekday] : RRule[weekday].nth(ordinal)];
            }
            if (this.#needs_month()) options.bymonth = [this.#default_month()];
        }

        // Reports whether a yearly rule has a day pattern but nothing naming its month, which RFC 5545 reads as every month.
        #needs_month(ignoring_months = false) {
            const options = this.#state.options;
            const has_day_pattern = Boolean(options.bymonthday?.length || options.byweekday?.length);
            const has_months = !ignoring_months && Boolean(options.bymonth?.length);
            const has_period = has_months || Boolean(options.byweekno?.length || options.byyearday?.length);
            return RRule.FREQUENCIES[options.freq] === "YEARLY" && has_day_pattern && !has_period;
        }

        // Reads a typed list into one BY part, or marks the field when it holds something that part does not allow or more than limit values.
        #apply_list_text(target, part, limit = 0) {
            try {
                const values = parse_part_list(part, target.value);
                if (limit && values.length > limit) throw new Error("Enter a single day of the month.");
                const frequency = RRule.FREQUENCIES[this.#state.options.freq];
                if (part === "byweekday" && values.some((entry) => entry.n) && !day_of_month_frequencies.includes(frequency)) {
                    throw new Error("Numbered weekdays such as -1FR only work in monthly and yearly rules.");
                }
                this.#set_field_error(target, "");
                set_list(this.#state.options, part, values);
            } catch (error) {
                this.#set_field_error(target, error.message);
            }
        }

        // Reads the weekday entry rows into BYDAY.
        #read_entries() {
            const entries = [...this.#controls.lists.entries.children].map((item) => {
                const ordinal = Number(item.querySelector('[data-control="entry_ordinal"]').value);
                const weekday = RRule[item.querySelector('[data-control="entry_weekday"]').value];
                return ordinal ? weekday.nth(ordinal) : weekday;
            });
            const unique_entries = [...new Map(entries.map((entry) => [entry.toString(), entry])).values()];
            set_list(this.#state.options, "byweekday", unique_entries);
        }

        // Reads the time rows into BYHOUR and BYMINUTE, which only work when every hour shares the same minutes.
        #read_times(active_input) {
            const inputs = [...this.#controls.lists.times.querySelectorAll("input")];
            const times = [...new Set(inputs.map((input) => input.value).filter(Boolean))];
            const hours = [...new Set(times.map((time) => Number(time.slice(0, 2))))].sort((a, b) => a - b);
            const minutes = [...new Set(times.map((time) => Number(time.slice(3, 5))))].sort((a, b) => a - b);
            const anchor = active_input ?? inputs[0] ?? this.#controls.lists.times;
            for (const input of inputs) this.#set_field_error(input, "");
            if (hours.length * minutes.length !== times.length) {
                this.#set_field_error(anchor, "One rule can only hold times that share the same minutes in every hour, such as 09:00 and 17:00.");
                return;
            }
            set_list(this.#state.options, "byhour", hours);
            set_list(this.#state.options, "byminute", times.length > 0 ? minutes : []);
        }

        // Reads the skip or extra date rows into the recurrence.
        #read_dates(control) {
            const list_name = control === "exdate" ? "exdates" : "rdates";
            const values = [...this.#controls.lists[list_name].querySelectorAll("input")].map((input) => input.value).filter(Boolean);
            this.#state[list_name] = values.map((value) => this.#rule_date_from_input(value));
        }

        // ===== Defaults and conversions ============================================================================================

        // Returns the start attribute as a local date, or null when it is missing or unreadable.
        #start_date() {
            const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(this.getAttribute("start") ?? "");
            return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
        }

        // Returns the month a yearly day pattern falls in by default: the start's month, or this month.
        #default_month() {
            return (this.#start_date() ?? new Date()).getMonth() + 1;
        }

        // Returns the day of the month a new day pattern uses: the start's day, or the 1st.
        #default_month_day() {
            return this.#start_date()?.getDate() ?? 1;
        }

        // Returns the weekday and its place in the month for a new weekday entry: the start's, or the first Monday.
        #default_weekday() {
            const start = this.#start_date();
            if (!start) return { weekday: "MO", ordinal: 1 };
            return { weekday: display_weekday_codes[start.getDay()], ordinal: Math.ceil(start.getDate() / 7) };
        }

        // Returns the input text for a new end date: the end of today.
        #default_end_input() {
            const end_of_today = new Date();
            end_of_today.setHours(23, 59, 0, 0);
            return this.format.all_day ? to_datetime_input(end_of_today, false).slice(0, 10) : to_datetime_input(end_of_today, false);
        }

        // Returns the input text for a new skip or extra date: tomorrow at nine.
        #default_date_input() {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            return this.format.all_day ? to_datetime_input(tomorrow, false).slice(0, 10) : to_datetime_input(tomorrow, false);
        }

        // Converts a date or datetime-local input's text into a rule date.
        #rule_date_from_input(text) {
            if (this.format.all_day) return new Date(`${text.slice(0, 10)}T00:00:00Z`);
            return to_rule_date(new Date(text), this.format);
        }

        // Converts a rule date into the text a date or datetime-local input shows.
        #input_from_rule_date(date) {
            if (this.format.all_day) return date.toISOString().slice(0, 10);
            return to_datetime_input(date, this.format.time_mode === "floating");
        }

        // ===== Display =============================================================================================================

        // Recomputes the value and redraws every control except the one being edited.
        #refresh(active_element, unreadable_text) {
            const state = this.#state;
            const format = this.format;
            for (const element of this.#field_errors.keys()) if (!element.isConnected) this.#field_errors.delete(element);
            if (unreadable_text !== null) this.#value = unreadable_text;
            else if (this.#verbatim_text) this.#value = state.enabled ? this.#verbatim_text : "";
            else if (!state.enabled || state.options.freq === undefined) this.#value = "";
            else if (this.getAttribute("value-format") === "ical") this.#value = format_recurrence({ rule: state.options, ...state }, format);
            else this.#value = format_rule(state.options, format);
            this.#internals.setFormValue(this.#value, this.#value);
            this.#show_state(active_element);
            this.#update_visibility();
            const [error_element, field_message] = [...this.#field_errors][0] ?? [];
            const message = this.#load_error || field_message || "";
            if (message) this.#internals.setValidity({ customError: true }, message, error_element ?? this.#controls.enabled);
            else this.#internals.setValidity({});
            const summary = this.#controls.summary;
            const extras = [...(state.options.extra_parts ?? []), ...state.extra_lines];
            const calendar_note = this.#verbatim_text && state.enabled ? `This rule uses ${rule_calendar(state.options)}, which this form cannot edit or calculate, so it is kept as written.` : "";
            const description = calendar_note || (this.#value && !this.#load_error ? describe_rule(this.#value, format) : "");
            const kept_note = this.#value && !calendar_note && extras.length > 0 ? `Also keeps, without calculating: ${extras.join("; ")}` : "";
            summary.textContent = message || [description, kept_note].filter(Boolean).join(". ");
            summary.classList.toggle("recurrence-input__summary--invalid", Boolean(message));
            summary.hidden = summary.textContent === "";
        }

        // Shows the state in the controls, leaving the edited control and any field showing an error untouched.
        #show_state(active_element) {
            const controls = this.#controls;
            const options = this.#state.options;
            const frequency = RRule.FREQUENCIES[options.freq] ?? "DAILY";
            const can_set = (element) => element !== active_element && !this.#field_errors.has(element);
            const set_value = (element, value) => can_set(element) && (element.value = value);
            const weekdays = options.byweekday ?? [];
            if (can_set(controls.enabled)) controls.enabled.checked = this.#state.enabled;
            set_value(controls.interval, options.interval ?? 1);
            set_value(controls.frequency, frequency);
            const plain_codes = new Set(weekdays.filter((entry) => !entry.n).map((entry) => rrule_weekday_codes[entry.weekday]));
            for (const checkbox of controls.weekdays) checkbox.checked = plain_codes.has(checkbox.value);
            for (const checkbox of controls.months) checkbox.checked = (options.bymonth ?? []).includes(Number(checkbox.value));
            const has_days = Boolean(options.bymonthday?.length);
            const has_weekdays = Boolean(weekdays.length);
            set_value(controls.day_mode, has_days && has_weekdays ? "both" : has_days ? "days" : has_weekdays ? "weekdays" : "start");
            const features = this.features;
            set_value(controls.month_days, (options.bymonthday ?? []).slice(0, features.has("month-days") ? undefined : 1).join(", "));
            const entry_count = day_of_month_frequencies.includes(frequency) ? weekdays.length : 0;
            const entry_items = this.#sync_list("entries", features.has("weekday-entries") ? entry_count : Math.min(entry_count, 1));
            entry_items.forEach((item, index) => {
                const ordinal_select = item.querySelector('[data-control="entry_ordinal"]');
                const ordinal = String(weekdays[index].n ?? "");
                if (![...ordinal_select.options].some((option) => option.value === ordinal)) ordinal_select.add(new Option(`number ${ordinal}`, ordinal));
                if (!item.contains(active_element)) {
                    ordinal_select.value = ordinal;
                    item.querySelector('[data-control="entry_weekday"]').value = rrule_weekday_codes[weekdays[index].weekday];
                }
            });
            const positions = options.bysetpos ?? [];
            const single_position = positions.length === 1 && [...controls.set_position.options].some((option) => option.value === String(positions[0]) && !option.disabled);
            set_value(controls.set_position, positions.length === 0 ? "" : single_position ? String(positions[0]) : "custom");
            const times_have_error = [...this.#field_errors.keys()].some((element) => this.#controls.lists.times.contains(element));
            if (!this.#controls.lists.times.contains(active_element) && !times_have_error) {
                const hours = options.byhour ?? [];
                const minutes = options.byminute ?? [0];
                const times = hours.flatMap((hour) => minutes.map((minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`)).sort();
                const time_count = features.has("times") ? times.length : 1;
                this.#sync_list("times", time_count).forEach((item, index) => (item.querySelector("input").value = times[index] ?? ""));
            }
            set_value(controls.hour_minutes, (options.byminute ?? []).join(", "));
            set_value(controls.minute_seconds, (options.bysecond ?? []).join(", "));
            const end_input_type = this.format.all_day ? "date" : "datetime-local";
            set_value(controls.end_type, options.until ? "until" : options.count ? "count" : "never");
            if (options.count) set_value(controls.end_count, options.count);
            if (controls.end_date.type !== end_input_type) controls.end_date.type = end_input_type;
            if (options.until) set_value(controls.end_date, this.#input_from_rule_date(options.until));
            for (const list_name of ["exdates", "rdates"]) {
                const dates = this.#state[list_name];
                this.#sync_list(list_name, dates.length).forEach((item, index) => {
                    const input = item.querySelector("input");
                    if (input.type !== end_input_type) input.type = end_input_type;
                    if (input !== active_element) input.value = this.#input_from_rule_date(dates[index]);
                });
            }
            for (const [part, input] of Object.entries(controls.parts)) {
                set_value(input, (options[part] ?? []).map((value) => String(value)).join(", "));
            }
            set_value(controls.week_start, options.wkst === undefined ? "" : rrule_weekday_codes[typeof options.wkst === "number" ? options.wkst : options.wkst.weekday]);
        }

        // Shows only the rows and controls that apply to the frequency, the day pattern, the end type and the value format.
        #update_visibility() {
            const controls = this.#controls;
            const sections = controls.sections;
            const enabled = this.#state.enabled && !this.#load_error && !this.#verbatim_text;
            const frequency = controls.frequency.value;
            const all_day = this.format.all_day;
            const day_mode = controls.day_mode.value;
            const is_monthly_or_yearly = day_of_month_frequencies.includes(frequency);
            const with_dates = this.getAttribute("value-format") === "ical";
            const features = this.features;
            const show = (section, visible) => (sections[section].hidden = !enabled || !visible);
            show("repeat", true);
            show("weekdays", frequency === "WEEKLY" || (!is_monthly_or_yearly && features.has("filters")));
            sections.weekdays.querySelector(".recurrence-input__row-label").textContent = frequency === "WEEKLY" ? "On" : "Only on";
            show("months", frequency === "YEARLY");
            show("month_days", is_monthly_or_yearly);
            show("set_position", is_monthly_or_yearly && day_mode !== "start" && features.has("set-position"));
            show("times", time_of_day_frequencies.includes(frequency) && !all_day);
            show("hour_minutes", frequency === "HOURLY" && !all_day && features.has("sub-daily"));
            show("minute_seconds", frequency === "MINUTELY" && !all_day && features.has("sub-daily"));
            show("end", true);
            show("exdates", with_dates && features.has("exdates"));
            show("rdates", with_dates && features.has("exdates"));
            show("more", features.has("more-options"));
            for (const option of controls.frequency.options) {
                option.hidden = sub_daily_frequencies.includes(option.value) && (all_day || !features.has("sub-daily")) && option.value !== frequency;
            }
            controls.day_mode.querySelector('[value="both"]').hidden = !features.has("month-days") || !features.has("weekday-entries");
            for (const button of this.querySelectorAll('[data-action="add_time"], [data-action="remove_time"]')) button.hidden = !features.has("times");
            for (const button of this.querySelectorAll('[data-action="remove_entry"]')) button.hidden = !features.has("weekday-entries");
            controls.month_days.hidden = day_mode !== "days" && day_mode !== "both";
            controls.lists.entries.hidden = day_mode !== "weekdays" && day_mode !== "both";
            this.querySelector('[data-action="add_entry"]').hidden = controls.lists.entries.hidden || !features.has("weekday-entries");
            controls.end_count.hidden = controls.end_type.value !== "count";
            controls.end_date.hidden = controls.end_type.value !== "until";
            const part_allowed = {
                byweekno: frequency === "YEARLY",
                byyearday: !["DAILY", "WEEKLY", "MONTHLY"].includes(frequency),
                bymonthday: frequency !== "WEEKLY",
            };
            for (const row of this.querySelectorAll("[data-part-row]")) row.hidden = part_allowed[row.dataset.partRow] === false;
        }
    };
}

// Sets one BY part to a list of values, or removes it when the list is empty.
function set_list(options, part, values) {
    if (values.length > 0) options[part] = values;
    else delete options[part];
}

// Only the first copy of this module to load registers the element, so loading it again never throws.
export const RecurrenceInput = typeof HTMLElement === "undefined" ? undefined : (customElements.get("recurrence-input") ?? create_element_class());
if (RecurrenceInput && !customElements.get("recurrence-input")) customElements.define("recurrence-input", RecurrenceInput);
