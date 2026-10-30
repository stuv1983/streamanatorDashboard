import test from 'node:test';
import assert from 'node:assert';
import { Status, DataState, Reading, worst, worstWith, getRank, Alert } from './status';

test('Status rank and worst', () => {
    assert.strictEqual(getRank(Status.HEALTHY), 0);
    assert.strictEqual(getRank(Status.CRITICAL), 4);
    assert.strictEqual(worst([Status.INFO, Status.CRITICAL, Status.UNKNOWN]), Status.CRITICAL);
    assert.strictEqual(worstWith(Status.HEALTHY, Status.WARNING), Status.WARNING);
    assert.strictEqual(worst([]), Status.HEALTHY);
});

test('Reading display_value formatting', () => {
    const r1 = new Reading({ key: '1', label: '1', value: 1000.5, unit: 'MB' });
    assert.strictEqual(r1.display_value, '1,000.5MB');

    const r2 = new Reading({ key: '2', label: '2', value: 1000, unit: 'MB' });
    assert.strictEqual(r2.display_value, '1,000MB');

    const r3 = new Reading({ key: '3', label: '3', state: DataState.NOT_CONFIGURED });
    assert.strictEqual(r3.display_value, 'NOT CONFIGURED');

    const r4 = new Reading({ key: '4', label: '4', value: null });
    assert.strictEqual(r4.display_value, '—');
});

test('Reading stale_after behavior', () => {
    const r = new Reading({ key: '1', label: '1', value: 42, collected_at: (Date.now() / 1000) - 100 });
    r.stale_after(50);
    assert.strictEqual(r.state, DataState.STALE);
    assert.strictEqual(r.status, Status.UNKNOWN);
    assert.ok(r.detail.includes('freshness budget 50s'));
});

test('Alert is_actionable logic', () => {
    const a1 = new Alert({ key: '1', status: Status.WARNING, title: 'W', component: 'C' });
    assert.strictEqual(a1.is_actionable, true);

    const a2 = new Alert({ key: '2', status: Status.INFO, title: 'I', component: 'C' });
    assert.strictEqual(a2.is_actionable, false);
});
