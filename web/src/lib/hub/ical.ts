/**
 * Just enough iCalendar (RFC 5545) to put a family's calendars on a wall:
 * VEVENTs with DATE / DATE-TIME / TZID starts, DURATION, RRULE expansion
 * (DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL, BYDAY,
 * BYMONTHDAY, BYMONTH), EXDATE, RECURRENCE-ID overrides and cancellations.
 *
 * Recurrences are expanded in the event's own wall-clock time and converted to
 * UTC per instance, so a 9:00 weekly meeting stays at 9:00 across a daylight
 * saving change. Not supported: BYSETPOS, BYWEEKNO, BYYEARDAY, sub-daily
 * frequencies and RDATE; such events show their first occurrence only.
 */

export interface CalendarEvent {
    uid: string;
    title: string;
    location: string;
    allDay: boolean;
    /** UTC milliseconds. For all-day events, midnight at the start date in the display zone. */
    start: number;
    end: number;
    /** YYYY-MM-DD in the display zone; for all-day events the literal dates (end exclusive). */
    startDate: string;
    endDate: string;
}

interface Property {
    name: string;
    params: Record<string, string>;
    value: string;
}

/** Wall-clock fields; month is 1-12. */
interface Wall {
    y: number; mo: number; d: number; h: number; mi: number; s: number;
}

interface ParsedTime {
    wall: Wall;
    allDay: boolean;
    /** IANA zone, "UTC", or "" for floating (display zone). */
    tz: string;
}

interface RawEvent {
    uid: string;
    title: string;
    location: string;
    status: string;
    start: ParsedTime;
    durationMs: number | null;
    durationDays: number | null;
    rrule: Record<string, string> | null;
    exdates: number[];
    recurrenceId: number | null;
}

// Outlook/Exchange feeds use Windows zone names. Common ones, with the rest
// falling back to the display zone.
const WINDOWS_ZONES: Record<string, string> = {
    "AUS Eastern Standard Time": "Australia/Sydney",
    "E. Australia Standard Time": "Australia/Brisbane",
    "Cen. Australia Standard Time": "Australia/Adelaide",
    "AUS Central Standard Time": "Australia/Darwin",
    "W. Australia Standard Time": "Australia/Perth",
    "Tasmania Standard Time": "Australia/Hobart",
    "New Zealand Standard Time": "Pacific/Auckland",
    "GMT Standard Time": "Europe/London",
    "W. Europe Standard Time": "Europe/Berlin",
    "Romance Standard Time": "Europe/Paris",
    "Eastern Standard Time": "America/New_York",
    "Central Standard Time": "America/Chicago",
    "Mountain Standard Time": "America/Denver",
    "Pacific Standard Time": "America/Los_Angeles",
    "Singapore Standard Time": "Asia/Singapore",
    "Tokyo Standard Time": "Asia/Tokyo",
    "India Standard Time": "Asia/Kolkata",
    "China Standard Time": "Asia/Shanghai",
    "UTC": "UTC",
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", {
            timeZone: tz, hourCycle: "h23",
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
        formatters.set(tz, f);
    }
    return f;
}

export function validZone(tz: string): boolean {
    try {
        formatter(tz);
        return true;
    } catch {
        return false;
    }
}

function resolveZone(tzid: string | undefined, fallback: string): string {
    if (!tzid) return fallback;
    const clean = tzid.replace(/^"|"$/g, "").replace(/^\/[^/]+\/[^/]+\//, ""); // strip "/mozilla.org/20050126_1/" style prefixes
    if (WINDOWS_ZONES[clean]) return WINDOWS_ZONES[clean];
    return validZone(clean) ? clean : fallback;
}

/** Wall-clock fields of a UTC instant in a zone. */
export function wallIn(utcMs: number, tz: string): Wall {
    const parts: Record<string, number> = {};
    for (const part of formatter(tz).formatToParts(new Date(utcMs))) {
        if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
    return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour === 24 ? 0 : parts.hour, mi: parts.minute, s: parts.second };
}

function wallAsUtc(w: Wall): number {
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}

/** Convert wall-clock time in a zone to UTC, resolving DST gaps forwards. */
export function zonedToUtc(w: Wall, tz: string): number {
    if (tz === "UTC") return wallAsUtc(w);
    const guess = wallAsUtc(w);
    const offset1 = wallAsUtc(wallIn(guess, tz)) - guess;
    const candidate = guess - offset1;
    const offset2 = wallAsUtc(wallIn(candidate, tz)) - candidate;
    return offset1 === offset2 ? candidate : guess - offset2;
}

export function dateKey(utcMs: number, tz: string): string {
    const w = wallIn(utcMs, tz);
    return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

function wallDateKey(w: Wall): string {
    return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

function addDays(w: Wall, days: number): Wall {
    const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + days, w.h, w.mi, w.s));
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: w.h, mi: w.mi, s: w.s };
}

function daysInMonth(y: number, mo: number): number {
    return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** 0 = Monday ... 6 = Sunday. */
function weekday(y: number, mo: number, d: number): number {
    return (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
}

const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

function unescapeText(value: string): string {
    return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
}

function parseLines(text: string): Property[] {
    const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
    const props: Property[] = [];
    for (const line of unfolded.split("\n")) {
        if (!line) continue;
        // The value starts at the first ':' not inside a quoted parameter.
        let inQuote = false;
        let split = -1;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') inQuote = !inQuote;
            else if (c === ":" && !inQuote) { split = i; break; }
        }
        if (split < 0) continue;
        const [name, ...paramParts] = line.slice(0, split).split(";");
        const params: Record<string, string> = {};
        for (const part of paramParts) {
            const eq = part.indexOf("=");
            if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
        }
        props.push({ name: name.toUpperCase(), params, value: line.slice(split + 1) });
    }
    return props;
}

function parseTime(prop: Property, displayTz: string): ParsedTime | null {
    const v = prop.value.trim();
    const date = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (date || prop.params.VALUE === "DATE") {
        const m = date ?? v.match(/^(\d{4})(\d{2})(\d{2})/);
        if (!m) return null;
        return { wall: { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 }, allDay: true, tz: displayTz };
    }
    const dt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
    if (!dt) return null;
    const wall = { y: +dt[1], mo: +dt[2], d: +dt[3], h: +dt[4], mi: +dt[5], s: +(dt[6] ?? 0) };
    const tz = dt[7] ? "UTC" : resolveZone(prop.params.TZID, displayTz);
    return { wall, allDay: false, tz };
}

function toUtc(t: ParsedTime): number {
    return zonedToUtc(t.wall, t.tz);
}

/** ISO 8601 duration, e.g. PT1H30M, P1D, P2W, -PT15M. */
export function parseDuration(value: string): { ms: number; days: number } | null {
    const m = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!m) return null;
    const sign = m[1] === "-" ? -1 : 1;
    const days = (+(m[2] ?? 0)) * 7 + +(m[3] ?? 0);
    const ms = ((+(m[4] ?? 0)) * 3600 + (+(m[5] ?? 0)) * 60 + +(m[6] ?? 0)) * 1000;
    return { ms: sign * (ms + days * 86400000), days: sign * days };
}

function parseEvents(text: string, displayTz: string): RawEvent[] {
    const props = parseLines(text);
    const events: RawEvent[] = [];
    let current: Property[] | null = null;
    let depth = 0;
    for (const prop of props) {
        if (prop.name === "BEGIN" && prop.value === "VEVENT") { current = []; depth = 0; continue; }
        if (!current) continue;
        // Nested components (VALARM) carry their own DESCRIPTION etc.; skip them.
        if (prop.name === "BEGIN") { depth++; continue; }
        if (prop.name === "END" && prop.value !== "VEVENT") { depth--; continue; }
        if (prop.name === "END" && prop.value === "VEVENT") {
            const event = buildEvent(current, displayTz);
            if (event) events.push(event);
            current = null;
            continue;
        }
        if (depth === 0) current.push(prop);
    }
    return events;
}

function buildEvent(props: Property[], displayTz: string): RawEvent | null {
    const get = (name: string) => props.find(p => p.name === name);
    const startProp = get("DTSTART");
    if (!startProp) return null;
    const start = parseTime(startProp, displayTz);
    if (!start) return null;

    let durationMs: number | null = null;
    let durationDays: number | null = null;
    const endProp = get("DTEND");
    const durationProp = get("DURATION");
    if (endProp) {
        const end = parseTime(endProp, displayTz);
        if (end) {
            if (start.allDay) durationDays = Math.round((wallAsUtc(end.wall) - wallAsUtc(start.wall)) / 86400000);
            else durationMs = toUtc(end) - toUtc(start);
        }
    } else if (durationProp) {
        const d = parseDuration(durationProp.value);
        if (d) {
            if (start.allDay) durationDays = d.days;
            else durationMs = d.ms;
        }
    }

    let rrule: Record<string, string> | null = null;
    const ruleProp = get("RRULE");
    if (ruleProp) {
        rrule = {};
        for (const part of ruleProp.value.split(";")) {
            const [k, v] = part.split("=");
            if (k && v) rrule[k.toUpperCase()] = v.toUpperCase();
        }
    }

    const exdates: number[] = [];
    for (const prop of props.filter(p => p.name === "EXDATE")) {
        for (const value of prop.value.split(",")) {
            const t = parseTime({ ...prop, value }, start.tz === "UTC" ? displayTz : start.tz);
            if (t) exdates.push(t.allDay ? zonedToUtc(t.wall, start.tz) : toUtc(t));
        }
    }

    const recurrenceProp = get("RECURRENCE-ID");
    const recurrence = recurrenceProp ? parseTime(recurrenceProp, start.tz === "UTC" ? displayTz : start.tz) : null;

    return {
        uid: get("UID")?.value ?? "",
        title: unescapeText(get("SUMMARY")?.value ?? "(no title)") || "(no title)",
        location: unescapeText(get("LOCATION")?.value ?? ""),
        status: (get("STATUS")?.value ?? "").toUpperCase(),
        start,
        durationMs,
        durationDays,
        rrule,
        exdates,
        recurrenceId: recurrence ? (recurrence.allDay ? zonedToUtc(recurrence.wall, start.tz) : toUtc(recurrence)) : null,
    };
}

function parseUntil(value: string, start: ParsedTime): number | null {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    if (!m[4]) return zonedToUtc({ y: +m[1], mo: +m[2], d: +m[3], h: 23, mi: 59, s: 59 }, start.tz);
    const wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
    return m[7] ? wallAsUtc(wall) : zonedToUtc(wall, start.tz);
}

/** Days of a month matching BYDAY entries such as MO, 2TU, -1FR. */
function monthDaysForByDay(y: number, mo: number, byday: string[]): number[] {
    const result = new Set<number>();
    const count = daysInMonth(y, mo);
    for (const entry of byday) {
        const m = entry.match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/);
        if (!m) continue;
        const target = DAY_CODES.indexOf(m[2]);
        const matches: number[] = [];
        for (let d = 1; d <= count; d++) if (weekday(y, mo, d) === target) matches.push(d);
        if (!m[1]) matches.forEach(d => result.add(d));
        else {
            const n = +m[1];
            const pick = n > 0 ? matches[n - 1] : matches[matches.length + n];
            if (pick) result.add(pick);
        }
    }
    return [...result].sort((a, b) => a - b);
}

function monthDays(y: number, mo: number, rule: Record<string, string>, startDay: number): number[] {
    if (rule.BYDAY) return monthDaysForByDay(y, mo, rule.BYDAY.split(","));
    const count = daysInMonth(y, mo);
    const days = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(",").map(Number) : [startDay];
    return days
        .map(d => (d < 0 ? count + d + 1 : d))
        .filter(d => d >= 1 && d <= count)
        .sort((a, b) => a - b);
}

const MAX_ITERATIONS = 5000;

/**
 * Start times (as wall clock in the event zone) of occurrences that start
 * before `untilMs`, honouring COUNT from the first occurrence. Without COUNT,
 * periods wholly before `fromMs` are skipped so a series started years ago
 * still reaches today within the iteration cap.
 */
function occurrences(event: RawEvent, fromMs: number, untilMs: number): Wall[] {
    const rule = event.rrule;
    const first = event.start.wall;
    if (!rule) return [first];
    const freq = rule.FREQ;
    const interval = Math.max(1, Number(rule.INTERVAL ?? 1) || 1);
    const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
    const until = rule.UNTIL ? parseUntil(rule.UNTIL, event.start) : null;
    const limit = Math.min(untilMs, until ?? Infinity);
    const firstUtc = toUtc(event.start);
    const out: Wall[] = [];
    let emitted = 0;

    const take = (w: Wall): boolean => {
        const utc = zonedToUtc(w, event.start.tz);
        if (utc < firstUtc) return true;
        if (utc > limit || emitted >= count) return false;
        emitted++;
        out.push(w);
        return true;
    };

    const at = (y: number, mo: number, d: number): Wall => ({ y, mo, d, h: first.h, mi: first.mi, s: first.s });
    // Periods to skip; two spare so a long event that began just before `fromMs` is kept.
    const skip = (periodDays: number) =>
        count === Infinity ? Math.max(0, Math.floor((fromMs - firstUtc) / 86400000 / (periodDays * interval)) - 2) : 0;

    if (freq === "DAILY") {
        for (let i = skip(1), n = 0; n < MAX_ITERATIONS; i++, n++) {
            const w = addDays(first, i * interval);
            if (rule.BYMONTH && !rule.BYMONTH.split(",").map(Number).includes(w.mo)) continue;
            if (!take(w)) break;
        }
    } else if (freq === "WEEKLY") {
        const days = (rule.BYDAY ? rule.BYDAY.split(",") : [DAY_CODES[weekday(first.y, first.mo, first.d)]])
            .map(code => DAY_CODES.indexOf(code.replace(/^[+-]?\d+/, "")))
            .filter(i => i >= 0)
            .sort((a, b) => a - b);
        const weekStart = addDays(first, -weekday(first.y, first.mo, first.d));
        outer: for (let i = skip(7), n = 0; n < MAX_ITERATIONS; i++, n++) {
            const monday = addDays(weekStart, i * 7 * interval);
            for (const day of days) {
                if (!take(addDays(monday, day))) break outer;
            }
        }
    } else if (freq === "MONTHLY") {
        outer: for (let i = skip(31), n = 0; n < MAX_ITERATIONS; i++, n++) {
            const t = new Date(Date.UTC(first.y, first.mo - 1 + i * interval, 1));
            const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1;
            for (const d of monthDays(y, mo, rule, first.d)) {
                if (!take(at(y, mo, d))) break outer;
            }
        }
    } else if (freq === "YEARLY") {
        const months = rule.BYMONTH ? rule.BYMONTH.split(",").map(Number).sort((a, b) => a - b) : [first.mo];
        outer: for (let i = skip(366), n = 0; n < MAX_ITERATIONS / 12; i++, n++) {
            const y = first.y + i * interval;
            for (const mo of months) {
                const days = rule.BYDAY || rule.BYMONTHDAY ? monthDays(y, mo, rule, first.d) : (first.d <= daysInMonth(y, mo) ? [first.d] : []);
                for (const d of days) {
                    if (!take(at(y, mo, d))) break outer;
                }
            }
        }
    } else {
        return [first];
    }
    return out;
}

/**
 * Expand a calendar into event instances overlapping [fromMs, toMs), with
 * dates keyed in `displayTz`.
 */
export function expandCalendar(text: string, fromMs: number, toMs: number, displayTz: string): CalendarEvent[] {
    const raw = parseEvents(text, displayTz).filter(e => e.status !== "CANCELLED" || e.recurrenceId !== null);

    // RECURRENCE-ID instances replace (or, when cancelled, remove) one occurrence of their series.
    const overrides = new Map<string, RawEvent>();
    for (const e of raw) if (e.recurrenceId !== null) overrides.set(`${e.uid}|${e.recurrenceId}`, e);

    const out: CalendarEvent[] = [];
    const emit = (e: RawEvent, startUtc: number, startWall: Wall) => {
        if (e.status === "CANCELLED") return;
        if (e.start.allDay) {
            const days = Math.max(1, e.durationDays ?? 1);
            const startDate = wallDateKey(startWall);
            const endDate = wallDateKey(addDays(startWall, days));
            const start = zonedToUtc({ ...startWall, h: 0, mi: 0, s: 0 }, displayTz);
            const end = zonedToUtc({ ...addDays(startWall, days), h: 0, mi: 0, s: 0 }, displayTz);
            if (end <= fromMs || start >= toMs) return;
            out.push({ uid: e.uid, title: e.title, location: e.location, allDay: true, start, end, startDate, endDate });
        } else {
            const end = startUtc + Math.max(0, e.durationMs ?? 0);
            if (end < fromMs || (end === fromMs && end !== startUtc) || startUtc >= toMs) return;
            out.push({
                uid: e.uid, title: e.title, location: e.location, allDay: false, start: startUtc, end,
                startDate: dateKey(startUtc, displayTz), endDate: dateKey(Math.max(startUtc, end - 1), displayTz),
            });
        }
    };

    for (const e of raw) {
        if (e.recurrenceId !== null) continue;
        const exdates = new Set(e.exdates);
        for (const wall of occurrences(e, fromMs, toMs)) {
            const startUtc = zonedToUtc(wall, e.start.tz);
            if (exdates.has(startUtc)) continue;
            const override = overrides.get(`${e.uid}|${startUtc}`);
            if (override) {
                overrides.delete(`${e.uid}|${startUtc}`);
                emit(override, toUtc(override.start), override.start.wall);
            } else {
                emit(e, startUtc, wall);
            }
        }
    }
    // Overrides whose series was not in this feed (or moved far) still show.
    for (const o of overrides.values()) emit(o, toUtc(o.start), o.start.wall);

    return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
}
