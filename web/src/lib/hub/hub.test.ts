import test from 'node:test';
import assert from 'node:assert';
import { parseCountdowns, PHOTO_ID } from './hub';
import { inWindow } from './night';
import { applyListAction, DONE_RETENTION_SECONDS, MAX_ITEMS, parseListAction, pruneDone, type ListItem } from './store';
import { parseOpenMeteo } from '../widgets';

const LISTS = ['To do', 'Shopping'];

test('list actions are validated against configured lists and bounded', () => {
    assert.deepStrictEqual(parseListAction({ action: 'add', list: 'Shopping', text: '  milk   2L ' }, LISTS), { action: 'add', list: 'Shopping', text: 'milk 2L' });
    assert.strictEqual(typeof parseListAction({ action: 'add', list: 'Secret', text: 'x' }, LISTS), 'string');
    assert.strictEqual(typeof parseListAction({ action: 'add', list: 'Shopping', text: '   ' }, LISTS), 'string');
    assert.strictEqual(typeof parseListAction({ action: 'toggle', id: '../../etc' }, LISTS), 'string');
    const long = parseListAction({ action: 'add', list: 'To do', text: 'x'.repeat(500) }, LISTS);
    assert.ok(typeof long !== 'string' && long.action === 'add' && long.text.length === 140);
});

test('add, toggle, clear and the item cap', () => {
    let items: ListItem[] = [];
    items = applyListAction(items, { action: 'add', list: 'Shopping', text: 'bread' }, 1000) as ListItem[];
    assert.strictEqual(items.length, 1);
    const id = items[0].id;
    items = applyListAction(items, { action: 'toggle', id }, 2000) as ListItem[];
    assert.strictEqual(items[0].done, true);
    assert.strictEqual(items[0].doneAt, 2000);
    items = applyListAction(items, { action: 'toggle', id }, 3000) as ListItem[];
    assert.strictEqual(items[0].done, false);
    assert.strictEqual(items[0].doneAt, null);
    items = applyListAction(items, { action: 'toggle', id }, 4000) as ListItem[];
    assert.deepStrictEqual(applyListAction(items, { action: 'clear-done', list: 'To do' }), items, 'other lists untouched');
    assert.deepStrictEqual(applyListAction(items, { action: 'clear-done', list: 'Shopping' }), []);

    const full = Array.from({ length: MAX_ITEMS }, (_, i) => ({ id: String(i), list: 'To do', text: 't', done: false, createdAt: 0, doneAt: null }));
    assert.strictEqual(typeof applyListAction(full, { action: 'add', list: 'To do', text: 'one more' }), 'string');
    assert.strictEqual(typeof applyListAction([], { action: 'toggle', id: 'abcdef12' }), 'string');
});

test('ticked items drop off after a day', () => {
    const now = 1_000_000;
    const items: ListItem[] = [
        { id: 'a', list: 'To do', text: 'old', done: true, createdAt: 0, doneAt: now - DONE_RETENTION_SECONDS - 1 },
        { id: 'b', list: 'To do', text: 'recent', done: true, createdAt: 0, doneAt: now - 60 },
        { id: 'c', list: 'To do', text: 'open', done: false, createdAt: 0, doneAt: null },
    ];
    assert.deepStrictEqual(pruneDone(items, now).map(i => i.id), ['b', 'c']);
});

test('countdowns handle one-off and yearly dates', () => {
    const result = parseCountdowns('Christmas|12-25; Holiday|2027-01-10; Past|2020-01-01; Birthday|10-31; Junk', '2026-10-31');
    assert.deepStrictEqual(result.map(c => [c.name, c.date, c.days]), [
        ['Birthday', '2026-10-31', 0],
        ['Christmas', '2026-12-25', 55],
        ['Holiday', '2027-01-10', 71],
    ]);
    assert.strictEqual(parseCountdowns('New year|01-01', '2026-10-31')[0].date, '2027-01-01');
});

test('night window wraps midnight in the hub timezone', () => {
    const tz = 'Australia/Melbourne';
    // 31 Oct 2026 is AEDT (+11).
    assert.strictEqual(inWindow('22:00-06:30', new Date('2026-10-31T12:30:00Z'), tz), true);  // 23:30
    assert.strictEqual(inWindow('22:00-06:30', new Date('2026-10-31T19:00:00Z'), tz), true);  // 06:00
    assert.strictEqual(inWindow('22:00-06:30', new Date('2026-10-31T20:00:00Z'), tz), false); // 07:00
    assert.strictEqual(inWindow('13:00-14:00', new Date('2026-10-31T02:30:00Z'), tz), true);  // 13:30
    assert.strictEqual(inWindow('', new Date(), tz), false);
});

test('weather hours start at the current hour', () => {
    const weather = parseOpenMeteo({
        current: { time: '2026-10-31T14:15', temperature_2m: 20, weather_code: 1, is_day: 1, relative_humidity_2m: 55 },
        hourly: {
            time: ['2026-10-31T13:00', '2026-10-31T14:00', '2026-10-31T15:00'],
            temperature_2m: [19, 20, 21], precipitation_probability: [0, 10, 60], weather_code: [1, 2, 61], is_day: [1, 1, 1],
        },
        daily: { time: ['2026-10-31'], sunrise: ['2026-10-31T06:12'], sunset: ['2026-10-31T19:48'], precipitation_probability_max: [60], uv_index_max: [9.1] },
    }, 'Melbourne');
    assert.deepStrictEqual(weather.hours.map(h => h.time), ['2026-10-31T14:00', '2026-10-31T15:00']);
    assert.strictEqual(weather.hours[1].rainChance, 60);
    assert.strictEqual(weather.humidity, 55);
    assert.strictEqual(weather.days[0].sunset, '2026-10-31T19:48');
});

test('photo proxy ids must be UUIDs', () => {
    assert.ok(PHOTO_ID.test('3fa85f64-5717-4562-b3fc-2c963f66afa6'));
    assert.ok(!PHOTO_ID.test('../../api/users'));
});
