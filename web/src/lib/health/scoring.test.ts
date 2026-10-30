import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Status, type ComponentHealth, type Reading, type Alert } from '../status';
import { scoreComponent, calculateHealthScore, collectAlerts, sortAlerts } from './scoring';

describe('scoring', () => {
    it('should score a component correctly based on readings', () => {
        const readings: Reading[] = [
            // Using type assertions assuming standard interface props for the test
            { key: 'r1', label: 'R1', status: Status.HEALTHY, value: 1, state: 'OK', optional: false } as Reading,
            { key: 'r2', label: 'R2', status: Status.WARNING, value: 1, state: 'OK', optional: false } as Reading
        ];

        const component = scoreComponent('disk', 'Disks', readings, null, 1.0);
        
        assert.equal(component.status, Status.WARNING);
        // HEALTHY = 1.0, WARNING = 0.55. Mean = 0.775
        assert.equal(component.score, 0.775);
        assert.equal(component.label, 'Disks');
    });

    it('should ignore optional components from score but keep in readings', () => {
        const readings: Reading[] = [
            { key: 'r1', label: 'R1', status: Status.HEALTHY, optional: false } as Reading,
            { key: 'r2', label: 'R2', status: Status.UNKNOWN, optional: true } as Reading
        ];

        const component = scoreComponent('unifi', 'Network', readings, null, 1.0);
        
        assert.equal(component.status, Status.HEALTHY); // Optional UNKNOWN ignored
        assert.equal(component.score, 1.0); // Only HEALTHY counted
        assert.equal(component.readings.length, 2); // Both kept
    });

    it('should cap overall score when a critical component is present', () => {
        const components: ComponentHealth[] = [
            { key: 'c1', label: 'C1', status: Status.HEALTHY, weight: 99.0, score: 1.0, detail: '', readings: [], alerts: [] },
            { key: 'c2', label: 'C2', status: Status.CRITICAL, weight: 1.0, score: 0.0, detail: '', readings: [], alerts: [] }
        ];

        const result = calculateHealthScore(components);
        
        // Raw score is 99%, but ceiling for CRITICAL is 84
        assert.equal(result.score, 84.0);
        assert.equal(result.status, Status.CRITICAL);
        assert.equal(result.criticalCount, 1);
        assert.equal(result.label, 'CRITICAL');
        assert.ok(result.reason.includes('Critical: C2'));
    });

    it('should sort alerts by severity then recency', () => {
        const alerts: Alert[] = [
            { key: 'a1', status: Status.WARNING, title: 'W1', component: 'c', since: 100, effects: [] } as unknown as Alert,
            { key: 'a2', status: Status.CRITICAL, title: 'C1', component: 'c', since: 50, effects: [] } as unknown as Alert,
            { key: 'a3', status: Status.CRITICAL, title: 'C2', component: 'c', since: 200, effects: [] } as unknown as Alert,
        ];

        const sorted = sortAlerts(alerts);
        
        // CRITICAL since 200 > CRITICAL since 50 > WARNING since 100
        assert.equal(sorted[0].key, 'a3');
        assert.equal(sorted[1].key, 'a2');
        assert.equal(sorted[2].key, 'a1');
    });

    it('should handle zero components gracefully', () => {
        const result = calculateHealthScore([]);
        assert.equal(result.score, 0.0);
        assert.equal(result.status, Status.UNKNOWN);
        assert.equal(result.reason, 'No health components were evaluated.');
    });
});
