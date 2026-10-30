import test from 'node:test';
import assert from 'node:assert';
import { Status, Alert, Reading, DataState } from '../status';
import { classifyRaid, classifySmartHealth, alertFromVerdict, readingFromVerdict } from './rules';

test('classifyRaid', async (t) => {
    await t.test('returns UNKNOWN when counts are null', () => {
        const result = classifyRaid(null, null);
        assert.strictEqual(result.status, Status.UNKNOWN);
    });

    await t.test('returns CRITICAL when array is not active', () => {
        const result = classifyRaid(4, 4, null, null, false);
        assert.strictEqual(result.status, Status.CRITICAL);
        assert.match(result.detail, /Array is not active/);
    });

    await t.test('returns CRITICAL on degraded array (missing redundancy)', () => {
        const result = classifyRaid(3, 4);
        assert.strictEqual(result.status, Status.CRITICAL);
        assert.match(result.detail, /DEGRADED/);
    });

    await t.test('returns WARNING on active sync', () => {
        const result = classifyRaid(4, 4, 'recovering', 45.5);
        assert.strictEqual(result.status, Status.WARNING);
        assert.match(result.detail, /recovering is running at 45.5%/);
    });

    await t.test('returns HEALTHY when optimal', () => {
        const result = classifyRaid(4, 4);
        assert.strictEqual(result.status, Status.HEALTHY);
    });
});

test('classifySmartHealth', async (t) => {
    await t.test('returns UNKNOWN on null', () => {
        const result = classifySmartHealth(null);
        assert.strictEqual(result.status, Status.UNKNOWN);
    });

    await t.test('returns CRITICAL when failing', () => {
        const result = classifySmartHealth(false);
        assert.strictEqual(result.status, Status.CRITICAL);
    });

    await t.test('returns HEALTHY when passing', () => {
        const result = classifySmartHealth(true);
        assert.strictEqual(result.status, Status.HEALTHY);
    });
});

test('alertFromVerdict', async (t) => {
    await t.test('returns null for HEALTHY or INFO verdicts', () => {
        const healthyResult = alertFromVerdict('test-key', { status: Status.HEALTHY, detail: 'Ok' }, 'Comp', 'Title');
        const infoResult = alertFromVerdict('test-key', { status: Status.INFO, detail: 'Note' }, 'Comp', 'Title');
        
        assert.strictEqual(healthyResult, null);
        assert.strictEqual(infoResult, null);
    });

    await t.test('returns an Alert for CRITICAL verdicts', () => {
        const verdict = { status: Status.CRITICAL, detail: 'Failure mode', threshold: 'limit' };
        const alert = alertFromVerdict('raid', verdict, 'MD Array', 'Raid Alert');
        
        assert.ok(alert !== null);
        assert.ok(alert instanceof Alert);
        assert.strictEqual(alert.status, Status.CRITICAL);
        assert.strictEqual(alert.detail, 'Failure mode');
        assert.strictEqual(alert.title, 'Raid Alert');
    });
});

test('readingFromVerdict', async (t) => {
    await t.test('returns a Reading object with correct state', () => {
        const verdict = { status: Status.HEALTHY, detail: 'Ok', threshold: 'none' };
        const reading = readingFromVerdict('key', 'label', 10, verdict);
        
        assert.ok(reading instanceof Reading);
        assert.strictEqual(reading.status, Status.HEALTHY);
        assert.strictEqual(reading.state, DataState.OK);
        assert.strictEqual(reading.value, 10);
    });
});
