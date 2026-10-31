import test from 'node:test';
import assert from 'node:assert';
import { dateKey, expandCalendar, parseDuration, zonedToUtc } from './ical';

const TZ = 'Australia/Melbourne';
const cal = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const ev = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const range = (from: string, to: string) => [Date.parse(from), Date.parse(to)] as const;
const local = (iso: string) => new Date(iso).toLocaleString('en-AU', { timeZone: TZ, hour12: false });

test('zone conversion follows Melbourne daylight saving', () => {
    // AEDT (+11) in January, AEST (+10) in July.
    assert.strictEqual(new Date(zonedToUtc({ y: 2026, mo: 1, d: 15, h: 9, mi: 0, s: 0 }, TZ)).toISOString(), '2026-01-14T22:00:00.000Z');
    assert.strictEqual(new Date(zonedToUtc({ y: 2026, mo: 7, d: 15, h: 9, mi: 0, s: 0 }, TZ)).toISOString(), '2026-07-14T23:00:00.000Z');
    assert.strictEqual(dateKey(Date.parse('2026-07-14T23:00:00Z'), TZ), '2026-07-15');
});

test('a weekly 9am event stays at 9am across the DST change', () => {
    const text = cal(ev('UID:w1', 'SUMMARY:Swim', 'DTSTART;TZID=Australia/Melbourne:20260924T090000', 'DTEND;TZID=Australia/Melbourne:20260924T100000', 'RRULE:FREQ=WEEKLY'));
    const [from, to] = range('2026-09-30T00:00:00Z', '2026-10-10T00:00:00Z');
    const events = expandCalendar(text, from, to, TZ);
    assert.strictEqual(events.length, 2);
    // 1 Oct is AEST, 8 Oct is after the 4 Oct switch to AEDT; both 9:00 local.
    assert.ok(events.every(e => new Date(e.start).toLocaleTimeString('en-AU', { timeZone: TZ, hour12: false }).startsWith('09:00')));
    assert.strictEqual(events[0].end - events[0].start, 3600000);
});

test('monthly BYDAY ordinals, COUNT and UNTIL', () => {
    const text = cal(
        ev('UID:m1', 'SUMMARY:Bins', 'DTSTART;TZID=Australia/Melbourne:20261006T190000', 'RRULE:FREQ=MONTHLY;BYDAY=1TU'),
        ev('UID:m2', 'SUMMARY:Last Friday', 'DTSTART;TZID=Australia/Melbourne:20261030T170000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=2'),
        ev('UID:m3', 'SUMMARY:Daily', 'DTSTART:20261101T000000Z', 'RRULE:FREQ=DAILY;UNTIL=20261103T000000Z'),
    );
    const [from, to] = range('2026-10-01T00:00:00Z', '2027-02-01T00:00:00Z');
    const events = expandCalendar(text, from, to, TZ);
    const bins = events.filter(e => e.uid === 'm1').map(e => e.startDate);
    assert.deepStrictEqual(bins, ['2026-10-06', '2026-11-03', '2026-12-01', '2027-01-05']);
    assert.deepStrictEqual(events.filter(e => e.uid === 'm2').map(e => e.startDate), ['2026-10-30', '2026-11-27']);
    assert.strictEqual(events.filter(e => e.uid === 'm3').length, 3);
});

test('EXDATE removes and RECURRENCE-ID moves single instances', () => {
    const text = cal(
        ev('UID:r1', 'SUMMARY:Footy training', 'DTSTART;TZID=Australia/Melbourne:20261102T170000', 'DURATION:PT90M',
            'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE;TZID=Australia/Melbourne:20261104T170000'),
        ev('UID:r1', 'SUMMARY:Footy training (moved)', 'RECURRENCE-ID;TZID=Australia/Melbourne:20261109T170000',
            'DTSTART;TZID=Australia/Melbourne:20261110T180000', 'DTEND;TZID=Australia/Melbourne:20261110T193000'),
        ev('UID:r1', 'SUMMARY:Footy training', 'RECURRENCE-ID;TZID=Australia/Melbourne:20261111T170000', 'STATUS:CANCELLED',
            'DTSTART;TZID=Australia/Melbourne:20261111T170000'),
    );
    const [from, to] = range('2026-11-01T00:00:00Z', '2026-11-13T00:00:00Z');
    const events = expandCalendar(text, from, to, TZ);
    assert.deepStrictEqual(events.map(e => `${e.startDate} ${e.title}`), [
        '2026-11-02 Footy training',
        '2026-11-10 Footy training (moved)',
    ]);
});

test('all-day and multi-day events keep their literal dates', () => {
    const text = cal(
        ev('UID:a1', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261228'),
        ev('UID:a2', 'SUMMARY:Birthday', 'DTSTART;VALUE=DATE:20000315', 'RRULE:FREQ=YEARLY'),
    );
    const [from, to] = range('2026-12-20T00:00:00Z', '2027-04-01T00:00:00Z');
    const events = expandCalendar(text, from, to, TZ);
    const holiday = events.find(e => e.uid === 'a1')!;
    assert.strictEqual(holiday.allDay, true);
    assert.strictEqual(holiday.startDate, '2026-12-24');
    assert.strictEqual(holiday.endDate, '2026-12-28');
    assert.deepStrictEqual(events.filter(e => e.uid === 'a2').map(e => e.startDate), ['2027-03-15']);
});

test('old series reach today, folded lines and escapes are read, Outlook zones map', () => {
    const text = cal(
        ev('UID:o1', 'SUMMARY:Since 2009', 'DTSTART;TZID=Australia/Melbourne:20090101T070000', 'RRULE:FREQ=DAILY'),
        ev('UID:o2', 'SUMMARY:Long title that the server', '  folded\\, with a comma', 'LOCATION:Room 1\\nLevel 2',
            'DTSTART;TZID=AUS Eastern Standard Time:20261102T090000', 'DTEND;TZID=AUS Eastern Standard Time:20261102T100000'),
    );
    const [from, to] = range('2026-11-01T13:00:00Z', '2026-11-02T13:00:00Z');
    const events = expandCalendar(text, from, to, TZ);
    assert.strictEqual(events.filter(e => e.uid === 'o1').length, 1);
    const outlook = events.find(e => e.uid === 'o2')!;
    assert.strictEqual(outlook.title, 'Long title that the server folded, with a comma');
    assert.strictEqual(outlook.location, 'Room 1\nLevel 2');
    assert.ok(local(new Date(outlook.start).toISOString()).includes('09:00'), 'Sydney and Melbourne share an offset');
});

test('durations parse in both forms', () => {
    assert.deepStrictEqual(parseDuration('PT1H30M'), { ms: 5400000, days: 0 });
    assert.deepStrictEqual(parseDuration('P1W'), { ms: 7 * 86400000, days: 7 });
    assert.strictEqual(parseDuration('nonsense'), null);
});
