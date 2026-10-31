import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { 
    CAUSAL_RULES, 
    Incident, 
    correlate, 
    probableCauseForDiskCrc, 
    summariseIncident 
} from './correlation';
import { Alert, Status } from '../status';

describe('correlation', () => {
    test('Incident properties', () => {
        const cause = { key: 'cause', status: Status.CRITICAL, title: 'Cause Alert' } as Alert;
        const effect = { key: 'effect', status: Status.WARNING, title: 'Effect Alert' } as Alert;
        
        const incident = new Incident(cause, [effect], 'Title', 'Explanation');
        assert.strictEqual(incident.status, Status.CRITICAL);
        assert.strictEqual(incident.isCorrelated, true);

        const emptyIncident = new Incident(cause);
        assert.strictEqual(emptyIncident.isCorrelated, false);
    });

    test('correlate - groups alerts according to rules', () => {
        const alerts: Alert[] = [
            { key: 'vpn.gluetun', status: Status.CRITICAL, title: 'Gluetun Down' } as Alert,
            { key: 'probe.sonarr', status: Status.WARNING, title: 'Sonarr Probe Failed' } as Alert,
            { key: 'app.sabnzbd', status: Status.UNKNOWN, title: 'SABnzbd Unknown' } as Alert,
            { key: 'unrelated.alert', status: Status.CRITICAL, title: 'Unrelated' } as Alert
        ];

        const [incidents, uncorrelated] = correlate(alerts);

        assert.strictEqual(incidents.length, 1);
        assert.strictEqual(incidents[0].cause.key, 'vpn.gluetun');
        assert.strictEqual(incidents[0].effects.length, 2);
        assert.strictEqual(incidents[0].effects[0].key, 'probe.sonarr');
        assert.strictEqual(incidents[0].effects[1].key, 'app.sabnzbd');

        assert.strictEqual(uncorrelated.length, 1);
        assert.strictEqual(uncorrelated[0].key, 'unrelated.alert');

        // Check if mutation occurred as expected
        assert.strictEqual(alerts[0].effects?.length, 2);
        assert.strictEqual(alerts[1].caused_by, 'vpn.gluetun');
    });

    test('correlate - ignores OK status causes', () => {
        const alerts: Alert[] = [
            { key: 'vpn.gluetun', status: Status.HEALTHY, title: 'Gluetun OK' } as Alert,
            { key: 'probe.sonarr', status: Status.WARNING, title: 'Sonarr Probe Failed' } as Alert,
        ];

        const [incidents, uncorrelated] = correlate(alerts);

        assert.strictEqual(incidents.length, 0);
        assert.strictEqual(uncorrelated.length, 2);
    });

    test('correlate - ignores effects without a valid cause', () => {
        const alerts: Alert[] = [
            { key: 'probe.sonarr', status: Status.WARNING, title: 'Sonarr Probe Failed' } as Alert,
        ];

        const [incidents, uncorrelated] = correlate(alerts);

        assert.strictEqual(incidents.length, 0);
        assert.strictEqual(uncorrelated.length, 1);
    });

    test('probableCauseForDiskCrc returns string tuple', () => {
        const [cause, action] = probableCauseForDiskCrc();
        assert.ok(cause.includes('UDMA CRC errors'));
        assert.ok(action.includes('Inspect and reseat'));
    });

    test('summariseIncident formats correctly', () => {
        const cause = { key: 'cause', status: Status.CRITICAL, title: 'Cause Title' } as Alert;
        const effects = Array.from({ length: 7 }).map((_, i) => ({
            key: `effect.${i}`,
            status: Status.WARNING,
            title: `Effect ${i + 1}`
        } as Alert));

        const incident = new Incident(cause, effects, 'Incident Title', 'This is the explanation.');
        const summary = summariseIncident(incident);

        assert.strictEqual(
            summary, 
            'This is the explanation. Primary cause: Cause Title. Effects: Effect 1, Effect 2, Effect 3, Effect 4, Effect 5 (+2 more).'
        );
    });
});
