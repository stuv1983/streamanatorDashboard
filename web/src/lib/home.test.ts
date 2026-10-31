import test from 'node:test';
import assert from 'node:assert';
import { getSettings } from './config';
import { endpointBase, parsePlexSessions, parseQbittorrent, parseRadarrCalendar, parseSabQueue, parseSonarrCalendar } from './integrations';
import { browserUrl, builtinTiles, validateBookmark } from './launcher';
import { parseFeed, parseOpenMeteo, weatherSummary } from './widgets';
import { ContainerInfo } from './docker_service';
import { dependants, parseContainerRequest, refusalReason } from './container-control';

test('endpoint base URLs drop the probe path', () => {
    const settings = getSettings();
    assert.ok(!endpointBase(settings, 'sonarr').endsWith('/ping'));
    assert.ok(!endpointBase(settings, 'plex').endsWith('/identity'));
    assert.ok(!endpointBase(settings, 'immich').endsWith('/api/server/ping'));
    assert.strictEqual(endpointBase(settings, 'no-such-service'), '');
});

test('launcher tiles point browsers away from loopback', () => {
    assert.strictEqual(browserUrl('http://127.0.0.1:9090', '10.0.40.100'), 'http://10.0.40.100:9090');
    assert.strictEqual(browserUrl('http://10.0.40.100:8081', '10.0.40.100'), 'http://10.0.40.100:8081');
    const plex = builtinTiles(getSettings()).find(tile => tile.key === 'plex');
    assert.ok(plex?.url.endsWith('/web'));
});

test('bookmarks accept only http(s) URLs and plain icon names', () => {
    assert.deepStrictEqual(validateBookmark({ name: ' Jellyfin ', url: 'http://10.0.40.100:8096', icon: 'Jellyfin' }), {
        name: 'Jellyfin', url: 'http://10.0.40.100:8096', icon: 'jellyfin', group: 'Bookmarks', description: '',
    });
    assert.strictEqual(typeof validateBookmark({ name: 'x', url: 'javascript:alert(1)' }), 'string');
    assert.strictEqual(typeof validateBookmark({ name: 'x', url: 'https://a.b', icon: '../evil' }), 'string');
    assert.strictEqual(typeof validateBookmark({ name: '', url: 'https://a.b' }), 'string');
});

test('Plex sessions read episodes, films and transcode state', () => {
    const sessions = parsePlexSessions({
        MediaContainer: {
            Metadata: [
                { type: 'episode', grandparentTitle: 'Bluey', parentIndex: 3, index: 7, title: 'Faceytalk', duration: 420000, viewOffset: 210000,
                  User: { title: 'stuart' }, Player: { title: 'Living Room', product: 'Plex for Android', state: 'playing' },
                  TranscodeSession: { videoDecision: 'transcode' } },
                { type: 'movie', title: 'Heat', year: 1995, Player: { state: 'paused' } },
            ],
        },
    });
    assert.strictEqual(sessions[0].title, 'Bluey');
    assert.strictEqual(sessions[0].subtitle, 'S03E07 · Faceytalk');
    assert.strictEqual(sessions[0].progress, 50);
    assert.strictEqual(sessions[0].transcoding, true);
    assert.strictEqual(sessions[1].subtitle, '1995');
    assert.strictEqual(sessions[1].progress, null);
    assert.deepStrictEqual(parsePlexSessions({ MediaContainer: { size: 0 } }), []);
});

test('SABnzbd and qBittorrent queues normalise to one shape', () => {
    const sab = parseSabQueue({ queue: { kbpersec: '1000', paused: false, slots: [{ filename: 'a.nzb', percentage: '42', timeleft: '0:10:05', mb: '100' }] } });
    assert.strictEqual(sab.speedBytes, 1024000);
    assert.strictEqual(sab.items[0].progress, 42);
    assert.strictEqual(sab.items[0].etaSeconds, 605);

    const qbit = parseQbittorrent({ dl_info_speed: 5000, up_info_speed: 100 }, [
        { name: 'linux.iso', progress: 0.25, dlspeed: 4000, eta: 8640000, size: 1000, state: 'downloading' },
    ]);
    assert.strictEqual(qbit.items[0].progress, 25);
    assert.strictEqual(qbit.items[0].etaSeconds, null, 'qBittorrent infinity ETA is unknown');
    assert.strictEqual(qbit.uploadBytes, 100);
});

test('calendar entries come from Sonarr air dates and the in-window Radarr release', () => {
    const tv = parseSonarrCalendar([
        { airDateUtc: '2026-11-02T09:00:00Z', seasonNumber: 2, episodeNumber: 3, title: 'Pilot', series: { title: 'Show' }, hasFile: false },
        { airDateUtc: null },
    ]);
    assert.strictEqual(tv.length, 1);
    assert.strictEqual(tv[0].detail, 'S02E03 · Pilot');

    const start = Date.parse('2026-11-01T00:00:00Z');
    const end = Date.parse('2026-11-08T00:00:00Z');
    const films = parseRadarrCalendar([
        { title: 'Film', year: 2026, inCinemas: '2026-07-01T00:00:00Z', digitalRelease: '2026-11-03T00:00:00Z' },
        { title: 'Later', inCinemas: '2027-01-01T00:00:00Z' },
    ], start, end);
    assert.strictEqual(films.length, 1);
    assert.strictEqual(films[0].detail, 'Digital release');
    assert.strictEqual(films[0].title, 'Film (2026)');
});

test('RSS and Atom feeds parse to headlines with safe links', () => {
    const rss = parseFeed(`<?xml version="1.0"?><rss><channel><title>News &amp; Views</title>
        <item><title><![CDATA[First <b>story</b>]]></title><link>https://example.com/1</link><pubDate>Sat, 31 Oct 2026 10:00:00 GMT</pubDate></item>
        <item><title>Bad link</title><link>javascript:alert(1)</link></item>
    </channel></rss>`, 'fallback');
    assert.strictEqual(rss.name, 'News & Views');
    assert.strictEqual(rss.items[0].title, 'First story');
    assert.strictEqual(rss.items[0].link, 'https://example.com/1');
    assert.ok(rss.items[0].at);
    assert.strictEqual(rss.items[1].link, '');

    const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
        <entry><title>Post</title><link href="https://blog.example/post"/><updated>2026-10-30T00:00:00Z</updated></entry></feed>`, 'fallback');
    assert.strictEqual(atom.items[0].link, 'https://blog.example/post');
});

test('Open-Meteo payloads map WMO codes to words', () => {
    const weather = parseOpenMeteo({
        current: { temperature_2m: 18.4, apparent_temperature: 17, weather_code: 3, wind_speed_10m: 12 },
        daily: { time: ['2026-10-31', '2026-11-01'], temperature_2m_max: [20, 24], temperature_2m_min: [11, 13], weather_code: [3, 61] },
    }, 'Melbourne');
    assert.strictEqual(weather.summary, 'Overcast');
    assert.strictEqual(weather.days[1].summary, 'Light rain');
    assert.strictEqual(weatherSummary(null), '');
});

test('container requests are validated before reaching docker', () => {
    const id = 'a'.repeat(64);
    assert.deepStrictEqual(parseContainerRequest({ action: 'restart', name: 'media-vpn_gluetun_1', id }), { action: 'restart', name: 'media-vpn_gluetun_1', id });
    assert.strictEqual(typeof parseContainerRequest({ action: 'rm', name: 'x', id }), 'string');
    assert.strictEqual(typeof parseContainerRequest({ action: 'stop', name: '--help', id }), 'string');
    assert.strictEqual(typeof parseContainerRequest({ action: 'stop', name: 'x' }), 'string');
});

test('container actions refuse stale targets and name namespace dependants', () => {
    const gluetun = new ContainerInfo({ id: 'b'.repeat(64), name: 'gluetun', state: 'running' });
    const sonarr = new ContainerInfo({ id: 'c'.repeat(64), name: 'sonarr', state: 'running', network_mode: `container:${'b'.repeat(64)}` });
    const plex = new ContainerInfo({ id: 'd'.repeat(64), name: 'plex', state: 'running' });
    assert.deepStrictEqual(dependants(gluetun, [gluetun, sonarr, plex]), ['sonarr']);

    assert.strictEqual(refusalReason({ action: 'stop', name: 'gluetun', id: 'b'.repeat(12) }, gluetun), null);
    assert.match(refusalReason({ action: 'stop', name: 'gluetun', id: 'e'.repeat(64) }, gluetun) ?? '', /recreated/);
    assert.match(refusalReason({ action: 'start', name: 'gluetun', id: 'b'.repeat(64) }, gluetun) ?? '', /already running/);
});

test('container JSON keeps derived state the pages read', () => {
    const json = JSON.parse(JSON.stringify(new ContainerInfo({ name: 'x', state: 'running', started_at: Date.now() / 1000 - 60 })));
    assert.strictEqual(json.running, true);
    assert.ok(json.uptime_seconds >= 59);
});
