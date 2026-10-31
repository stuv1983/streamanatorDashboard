import test from 'node:test';
import assert from 'node:assert/strict';
import {
    linearFit,
    CapacityForecast,
    growthOver,
    forecastCapacity,
    projectThresholdDate
} from './forecast';

test('linearFit', async (t) => {
    await t.test('returns null for less than 3 samples', () => {
        assert.equal(linearFit([[1, 2], [2, 3]]), null);
    });

    await t.test('calculates correct fit for perfect line', () => {
        const fit = linearFit([[0, 0], [1, 2], [2, 4], [3, 6]]);
        assert.ok(fit);
        assert.equal(fit.slope, 2);
        assert.equal(fit.intercept, 0);
        assert.equal(fit.rSquared, 1.0);
        assert.equal(fit.sampleCount, 4);
        assert.equal(fit.spanSeconds, 3);
    });
    
    await t.test('calculates correct fit for flat line', () => {
        const fit = linearFit([[1, 5], [2, 5], [3, 5]]);
        assert.ok(fit);
        assert.equal(fit.slope, 0);
        assert.equal(fit.intercept, 5);
        assert.equal(fit.rSquared, 1.0);
    });
});

test('CapacityForecast properties', async (t) => {
    await t.test('growthTbPerMonth', () => {
        const f = new CapacityForecast(true);
        assert.equal(f.growthTbPerMonth, null);
        
        f.growthBytesPerDay = Math.pow(1024, 4); // 1 TB per day
        assert.equal(f.growthTbPerMonth, 30.0);
    });

    await t.test('shrinking', () => {
        const f = new CapacityForecast(true);
        assert.equal(f.shrinking, false);
        
        f.growthBytesPerDay = -100;
        assert.equal(f.shrinking, true);
        
        f.growthBytesPerDay = 100;
        assert.equal(f.shrinking, false);
    });
});

test('growthOver', async (t) => {
    await t.test('calculates correct growth', () => {
        const samples: [number, number][] = [
            [100, 10],
            [150, 15],
            [200, 20]
        ];
        // exact match
        assert.equal(growthOver(samples, 100), 10); // 20 - 10
        // baseline in middle
        assert.equal(growthOver(samples, 60), 10); // closest is [100, 10]
    });
    
    await t.test('returns null if window too large and insufficient history', () => {
        const samples: [number, number][] = [
            [100, 10],
            [200, 20]
        ]; // span is 100
        assert.equal(growthOver(samples, 200), null); // 100 < 200 * 0.75 is 150
    });
});

test('forecastCapacity', async (t) => {
    await t.test('insufficient history', () => {
        const result = forecastCapacity([[0, 0], [1, 1]], 1000, 3.0, 0.5, 3);
        assert.equal(result.available, false);
        assert.match(result.reason, /Insufficient history/);
    });

    await t.test('valid projection', () => {
        const day = 86400;
        const samples: [number, number][] = [
            [0, 100],
            [day, 200],
            [2 * day, 300],
            [3 * day, 400],
            [4 * day, 500],
            [5 * day, 600],
            [6 * day, 700],
            [7 * day, 800],
            [8 * day, 900],
            [9 * day, 1000]
        ];
        const result = forecastCapacity(samples, 2000, 3, 0.5, 10);
        assert.equal(result.available, true);
        assert.equal(result.growthBytesPerDay, 100);
        assert.equal(result.rSquared, 1.0);
        // Current used: 1000. Target 80% (1600), needs +600. Slope = 100/day. Needs 6 days. Now is 9 days. Crosses at 15 days.
        assert.equal(result.date80Percent, 15 * day);
        assert.equal(result.date90Percent, 17 * day);
        assert.equal(result.dateFull, 19 * day);
    });
    
    await t.test('rejected due to low rSquared', () => {
        const day = 86400;
        const samples: [number, number][] = [
            [0, 10],
            [day, 100],
            [2 * day, -50],
            [3 * day, 300],
            [4 * day, 10],
            [5 * day, 50],
            [6 * day, 90],
            [7 * day, 800],
            [8 * day, -900],
            [9 * day, 1000]
        ];
        const result = forecastCapacity(samples, 2000, 3, 0.8, 10);
        assert.equal(result.available, false);
        assert.match(result.reason, /Growth is too irregular/);
    });
});

test('projectThresholdDate', async (t) => {
    await t.test('returns null if shrinking or target reached', () => {
        assert.equal(projectThresholdDate(100, -10, 200), null);
        assert.equal(projectThresholdDate(200, 10, 100), null);
    });
});
