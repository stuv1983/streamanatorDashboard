import test from 'node:test';
import assert from 'node:assert';
import { analyseLogs, checkLeak, describeServerFilter, inferTunnelUp } from './vpn';
import { _parse_public_env } from './docker_service';

test('AUTH_FAILED is identified ahead of the restart loop it causes', () => {
    const result = analyseLogs([
        '2026-10-31T10:00:00Z ERROR [openvpn] AUTH: Received control message: AUTH_FAILED',
        '2026-10-31T10:00:01Z INFO [openvpn] SIGUSR1[soft,auth-failure] received, process restarting',
    ]);
    assert.strictEqual(result.cause, 'VPN authentication failure');
    assert.strictEqual(result.authFailures, 1);
    assert.strictEqual(result.reconnects, 1);
    assert.ok(result.recommendation.includes('OPENVPN_USER'));
});

test('missing TUN device and empty server filter are named specifically', () => {
    assert.strictEqual(
        analyseLogs(['ERROR TUN device is not available: open /dev/net/tun: no such file or directory']).cause,
        'TUN device unavailable to Gluetun'
    );
    assert.strictEqual(
        analyseLogs(['ERROR VPN settings: no server found: for VPN openvpn; country Atlantis']).cause,
        'No VPN server matches the configured filters'
    );
});

test('internal healthcheck failures are recognised', () => {
    const result = analyseLogs([
        'INFO [healthcheck] program has been unhealthy for 6s: restarting VPN',
    ]);
    assert.strictEqual(result.cause, "Gluetun's internal healthcheck is failing");
});

test('clean logs produce no cause', () => {
    const result = analyseLogs(['INFO [vpn] You are running on the bleeding edge', 'INFO [ip getter] Public IP address is 1.2.3.4']);
    assert.strictEqual(result.cause, '');
    assert.deepStrictEqual(result.errors, []);
});

test('the control server decides tunnel state when it answered', () => {
    assert.strictEqual(inferTunnelUp({ controlVpnStatus: 'running', publicIp: null, httpsOk: null }), true);
    assert.strictEqual(inferTunnelUp({ controlVpnStatus: 'stopped', publicIp: '1.2.3.4', httpsOk: true }), false);
});

test('a failed exit-IP lookup alone does not mark the tunnel down', () => {
    // Rate-limited lookup, but HTTPS through the kill switch works: tunnel is up.
    assert.strictEqual(inferTunnelUp({ controlVpnStatus: '', publicIp: null, httpsOk: true }), true);
    assert.strictEqual(inferTunnelUp({ controlVpnStatus: '', publicIp: null, httpsOk: false }), false);
    assert.strictEqual(inferTunnelUp({ controlVpnStatus: '', publicIp: null, httpsOk: null }), null);
    assert.strictEqual(inferTunnelUp({ controlVpnStatus: '', publicIp: '1.2.3.4', httpsOk: null }), true);
});

test('only allow-listed container env survives', () => {
    const env = _parse_public_env([
        'VPN_SERVICE_PROVIDER=nordvpn',
        'VPN_TYPE=wireguard',
        'WIREGUARD_PRIVATE_KEY=secret',
        'OPENVPN_PASSWORD=secret',
        'SERVER_COUNTRIES=Australia',
        'MALFORMED',
    ]);
    assert.deepStrictEqual(env, {
        VPN_SERVICE_PROVIDER: 'nordvpn',
        VPN_TYPE: 'wireguard',
        SERVER_COUNTRIES: 'Australia',
    });
    assert.strictEqual(describeServerFilter(env), 'countries: Australia');
});

test('leak check covers both inconclusive cases', () => {
    assert.strictEqual(checkLeak(null, '1.1.1.1').passed, null);
    assert.strictEqual(checkLeak('2.2.2.2', null).passed, null);
    assert.strictEqual(checkLeak('1.1.1.1', '1.1.1.1').passed, false);
    assert.strictEqual(checkLeak('2.2.2.2', '1.1.1.1').passed, true);
});
