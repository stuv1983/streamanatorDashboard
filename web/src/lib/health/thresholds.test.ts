import test from 'node:test';
import assert from 'node:assert/strict';
import { getThresholds, COMPONENT_WEIGHTS } from './thresholds';

test('Thresholds Configuration', async (t) => {
  await t.test('should return default host thresholds accurately', () => {
    const thresholds = getThresholds();
    assert.equal(thresholds.host.cpu_warning_percent, 90.0);
    assert.equal(thresholds.host.cpu_sustained_seconds, 600);
    assert.equal(thresholds.host.cpu_temp_critical, 90.0);
  });

  await t.test('should return default storage thresholds accurately', () => {
    const thresholds = getThresholds();
    assert.equal(thresholds.storage.warning_percent, 80.0);
    assert.equal(thresholds.storage.forecast_warning_days, 90.0);
  });

  await t.test('should structure all threshold categories', () => {
    const thresholds = getThresholds();
    assert.ok('host' in thresholds);
    assert.ok('storage' in thresholds);
    assert.ok('disk' in thresholds);
    assert.ok('network' in thresholds);
    assert.ok('container' in thresholds);
    assert.ok('backup' in thresholds);
    assert.ok('probe' in thresholds);
    assert.ok('freshness' in thresholds);
  });

  await t.test('should map component weights correctly', () => {
    assert.equal(COMPONENT_WEIGHTS.raid_disks, 25.0);
    assert.equal(COMPONENT_WEIGHTS.server, 15.0);
    assert.equal(COMPONENT_WEIGHTS.security, 5.0);
  });
});
