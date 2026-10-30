/**
 * UniFi integration.
 *
 * Authentication choice matters here. The polling account on this network has
 * email MFA enforced, which rules out any path that performs an interactive login.
 * 
 * The Network Integration API (/proxy/network/integration/v1/...) authenticates 
 * with an X-API-KEY header.
 */

import * as ipaddr from 'ipaddr.js';
import { readFileSync } from 'node:fs';
import { Agent } from 'undici';

export interface UnifiConfig {
    controllerUrl?: string;
    apiKey?: string;
    verifyTls?: boolean | string;
    tlsVerify?: boolean | string;
    site?: string;
    exporterUrl?: string;
    controller_url?: string;
    api_key?: string | null;
    verify_tls?: boolean | string;
    tls_verify?: boolean | string;
    exporter_url?: string;
}

function normaliseConfig(config: UnifiConfig): UnifiConfig {
    return {
        ...config,
        controllerUrl: config.controllerUrl ?? config.controller_url,
        apiKey: config.apiKey ?? config.api_key ?? undefined,
        verifyTls: config.verifyTls ?? config.verify_tls,
        tlsVerify: config.tlsVerify ?? config.tls_verify ?? config.verifyTls ?? config.verify_tls,
        exporterUrl: config.exporterUrl ?? config.exporter_url,
    };
}

export interface PrometheusClient {
    available(): boolean;
    queryOne(query: string): Promise<number | null>;
    query(query: string): Promise<{ labels: Record<string, string>; value: number }[]>;
}

const log = {
    debug: (...args: any[]) => console.debug("[unifi]", ...args),
    error: (...args: any[]) => console.error("[unifi]", ...args),
};

export const INTEGRATION_STEPS: string[] = [
    "Keep MFA enabled on your UniFi account — an API key is a separate credential and does not weaken it.",
    "In the UniFi console (https://10.0.40.1): Settings → Control Plane → Integrations → Create API Key.",
    "Verify it: curl -sk -H 'X-API-KEY: <key>' https://10.0.40.1/proxy/network/integration/v1/info",
    "Put it in the dashboard: Admin → API keys → UniFi, or set UNIFI_CONTROLLER_URL=... and UNIFI_API_KEY=...",
    "Treat the key as privileged. This dashboard only ever sends GET.",
    "Do NOT use unpoller with this account — it logs in with username and password, which MFA will block."
];

export const PROVIDED_BY_INTEGRATION_API: string[] = [
    "Adopted and pending devices, device details, physical ports and radios",
    "Latest device CPU, memory, uptime, load, uplink and radio statistics",
    "Connected client identity, access state and uplink device",
    "Network/VLAN definitions, details and reference relationships",
    "WiFi broadcast definitions with credential fields redacted",
    "Firewall policies, firewall zones and ACL rules",
    "LAGs, MC-LAG domains and switch stacks",
    "DNS policies and traffic matching lists",
    "WAN interfaces, VPN servers and site-to-site tunnels",
    "DPI applications/categories, device tags and RADIUS profile names",
    "Network application version and local site inventory",
];

export const NOT_PROVIDED_BY_INTEGRATION_API: string[] = [
    "Per-client bandwidth and usage counters on the documented client endpoints",
    "IDS/IPS alarm history (legacy API only)",
    "Per-VLAN firewall hit, drop and block counters",
    "Historical WAN latency (use the dashboard's own ICMP history instead)",
];

const _INTEGRATION_BASE = "/proxy/network/integration/v1";

const _GATEWAY_TYPES = new Set(["UGW", "UDM", "UXG", "UCG"]);
const _GATEWAY_MODELS = ["UDM", "UXG", "UCG", "UDR", "USG"];
const _SWITCH_TYPES = new Set(["USW", "SWITCH"]);
const _SWITCH_MODELS = ["US", "USW", "USL", "FLEX"];
const _AP_TYPES = new Set(["UAP", "AP"]);
const _AP_MODELS = ["UAP", "U6", "U7", "U5", "UWB", "UAP-AC"];

export class UnifiAvailability {
    configured: boolean = false;
    source: string = "";
    detail: string = "";
    steps: string[] = INTEGRATION_STEPS;
    constructor(init?: Partial<UnifiAvailability>) { Object.assign(this, init); }
}

export class GatewayStatus {
    name: string = "";
    model: string = "";
    version: string = "";
    state: string = "";
    uptimeSeconds: number | null = null;
    cpuPercent: number | null = null;
    memoryPercent: number | null = null;
    temperatureCelsius: number | null = null;
    wanUp: boolean | null = null;
    wanRxBytesPerSec: number | null = null;
    wanTxBytesPerSec: number | null = null;
    wanLatencyMs: number | null = null;
    configured: boolean = false;
    error: string = "";
    checkedAt: number = Date.now() / 1000;
    constructor(init?: Partial<GatewayStatus>) { Object.assign(this, init); }
}

export class RadioStats {
    frequencyGhz: number = 0;
    txRetriesPercent: number | null = null;
    wlanStandard: string = "";
    channel: number | null = null;
    channelWidthMhz: number | null = null;

    constructor(init?: Partial<RadioStats>) { Object.assign(this, init); }

    get band(): string {
        if (this.frequencyGhz >= 5.9) return "6 GHz";
        if (this.frequencyGhz >= 4.9) return "5 GHz";
        return "2.4 GHz";
    }
}

export class PortStats {
    index: number | null = null;
    state: string = "";
    connector: string = "";
    speedMbps: number | null = null;
    maxSpeedMbps: number | null = null;
    poeEnabled: boolean | null = null;
    poeState: string = "";
    poeStandard: string = "";
    constructor(init?: Partial<PortStats>) { Object.assign(this, init); }
}

export class UnifiDevice {
    deviceId: string = "";
    name: string = "";
    model: string = "";
    mac: string = "";
    ipAddress: string = "";
    state: string = "";
    deviceType: string = "";
    uptimeSeconds: number | null = null;
    cpuPercent: number | null = null;
    memoryPercent: number | null = null;
    uplinkRxBps: number | null = null;
    uplinkTxBps: number | null = null;
    firmwareVersion: string = "";
    firmwareUpdatable: boolean = false;
    load1m: number | null = null;
    supported: boolean | null = null;
    adoptedAt: string = "";
    provisionedAt: string = "";
    configurationId: string = "";
    uplinkDeviceId: string = "";
    ports: PortStats[] = [];
    radios: RadioStats[] = [];

    constructor(init?: Partial<UnifiDevice>) { Object.assign(this, init); }

    get online(): boolean {
        return this.state.toUpperCase() === "ONLINE";
    }

    get role(): string {
        const kind = this.deviceType.toUpperCase();
        const model = this.model.toUpperCase();
        if (_GATEWAY_TYPES.has(kind) || _GATEWAY_MODELS.some(tag => model.includes(tag))) return "gateway";
        if (_SWITCH_TYPES.has(kind) || _SWITCH_MODELS.some(prefix => model.startsWith(prefix)) || model.includes("SWITCH")) return "switch";
        if (_AP_TYPES.has(kind) || _AP_MODELS.some(prefix => model.startsWith(prefix))) return "access point";
        return "device";
    }
}

export class VlanStats {
    vlanId: number = 0;
    name: string = "";
    subnet: string = "";
    clientCount: number | null = null;
    rxBytes: number | null = null;
    txBytes: number | null = null;
    rxBytesPerSec: number | null = null;
    txBytesPerSec: number | null = null;
    firewallBlocks: number | null = null;
    topClients: Record<string, any>[] = [];
    constructor(init?: Partial<VlanStats>) { Object.assign(this, init); }
}

export function availability(config: UnifiConfig): UnifiAvailability {
    config = normaliseConfig(config);
    if (config.controllerUrl && config.apiKey) {
        return new UnifiAvailability({
            configured: true,
            source: "UniFi Network Integration API",
            detail: `API-key authentication against ${config.controllerUrl}. MFA on the account is unaffected.`
        });
    }
    if (config.exporterUrl) {
        return new UnifiAvailability({
            configured: true,
            source: "unpoller exporter",
            detail: `Scraping ${config.exporterUrl}`
        });
    }
    return new UnifiAvailability({
        configured: false,
        source: "",
        detail: "No UniFi API key configured. Gateway health, WAN throughput, per-VLAN client counts and device status are unavailable."
    });
}

// ---------------------------------------------------------------------------
// Integration API transport
// ---------------------------------------------------------------------------

const _READ_PATHS: string[] = [
    "/info", "/sites", "/pending-devices", "/dpi/categories", "/dpi/applications",
    "/sites/{site}/devices", "/sites/{site}/devices/{device}", "/sites/{site}/devices/{device}/statistics/latest",
    "/sites/{site}/clients", "/sites/{site}/clients/{client}", "/sites/{site}/networks", "/sites/{site}/networks/{network}",
    "/sites/{site}/networks/{network}/references", "/sites/{site}/wifi/broadcasts", "/sites/{site}/wifi/broadcasts/{broadcast}",
    "/sites/{site}/wans", "/sites/{site}/firewall/policies", "/sites/{site}/firewall/policies/{policy}",
    "/sites/{site}/firewall/zones", "/sites/{site}/firewall/zones/{zone}", "/sites/{site}/acl-rules",
    "/sites/{site}/acl-rules/{rule}", "/sites/{site}/switching/lags", "/sites/{site}/switching/lags/{lag}",
    "/sites/{site}/switching/mc-lag-domains", "/sites/{site}/switching/mc-lag-domains/{domain}",
    "/sites/{site}/switching/switch-stacks", "/sites/{site}/switching/switch-stacks/{stack}",
    "/sites/{site}/dns/policies", "/sites/{site}/dns/policies/{policy}", "/sites/{site}/traffic-matching-lists",
    "/sites/{site}/traffic-matching-lists/{matching_list}", "/sites/{site}/vpn/servers", "/sites/{site}/vpn/site-to-site-tunnels",
    "/sites/{site}/radius/profiles", "/sites/{site}/device-tags",
];

const _QUERY_KEYS = new Set(["offset", "limit"]);
const _PAGE_SIZE = 100;
const _MAX_COLLECTION_ITEMS = 5000;
const _dispatchers = new Map<string, Agent>();

function _dispatcher(config: UnifiConfig): Agent | undefined {
    if (!config.controllerUrl?.toLowerCase().startsWith("https://")) return undefined;
    const verify = config.tlsVerify ?? config.verifyTls ?? true;
    if (verify === true) return undefined;
    const ca = typeof verify === "string" && verify ? readFileSync(/*turbopackIgnore: true*/ verify, "utf8") : undefined;
    const key = ca ? `ca:${verify}` : "insecure";
    let dispatcher = _dispatchers.get(key);
    if (!dispatcher) {
        dispatcher = new Agent({ connect: { rejectUnauthorized: Boolean(ca), ca } });
        _dispatchers.set(key, dispatcher);
    }
    return dispatcher;
}

function _isResourceId(value: string): boolean {
    if (!value || value.length > 128) return false;
    return /^[\w-]+$/.test(value);
}

function _pathIsAllowlisted(path: string): boolean {
    if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.includes("//")) return false;
    const concrete = path.split("/").slice(1);
    for (const template of _READ_PATHS) {
        const expected = template.split("/").slice(1);
        if (concrete.length !== expected.length) continue;
        
        let match = true;
        for (let i = 0; i < concrete.length; i++) {
            const val = concrete[i];
            const part = expected[i];
            if (part.startsWith("{")) {
                if (!_isResourceId(val)) { match = false; break; }
            } else if (val !== part) {
                match = false; break;
            }
        }
        if (match) return true;
    }
    return false;
}

function _queryIsSafe(params?: Record<string, number>): boolean {
    if (!params) return true;
    for (const key of Object.keys(params)) {
        if (!_QUERY_KEYS.has(key)) return false;
        const val = params[key];
        if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > _MAX_COLLECTION_ITEMS) return false;
    }
    return true;
}

async function _request(
    config: UnifiConfig,
    path: string,
    timeoutSeconds: number = 8.0,
    params?: Record<string, number>
): Promise<[any | null, string]> {
    if (!_pathIsAllowlisted(path)) return [null, "Read path is not allowlisted"];
    if (!_queryIsSafe(params)) return [null, "Query parameters are not allowlisted"];
    if (!config.controllerUrl || !config.apiKey) return [null, "No controller URL or API key configured"];

    let urlStr = `${config.controllerUrl.replace(/\/+$/, '')}${_INTEGRATION_BASE}${path}`;
    if (params) {
        const query = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            query.set(k, v.toString());
        }
        urlStr += `?${query.toString()}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    try {
        const dispatcher = _dispatcher(config);
        const request: RequestInit & { dispatcher?: Agent } = {
            method: 'GET',
            headers: {
                'X-API-KEY': config.apiKey,
                'Accept': 'application/json',
            },
            signal: controller.signal,
            redirect: 'manual',
        };
        if (dispatcher) request.dispatcher = dispatcher;
        const response = await fetch(urlStr, request);
        clearTimeout(timer);

        if (response.status === 401) return [null, "401 Unauthorized — the API key was rejected. Re-issue it from Settings → Control Plane → Integrations."];
        if (response.status === 404) return [null, "404 Not Found — this read endpoint is unavailable on the current UniFi Network version."];
        if (response.status >= 300 && response.status < 400) return [null, "Redirect refused while sending the API key"];
        if (response.status >= 400) return [null, `HTTP ${response.status}`];

        const MAX_BYTES = 5 * 1024 * 1024; // 5MB bounded read
        const body = response.body;
        if (!body) return [null, "Response had no body"];

        let totalBytes = 0;
        const chunks: Uint8Array[] = [];
        const reader = body.getReader();
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                totalBytes += value.length;
                if (totalBytes > MAX_BYTES) {
                    reader.cancel();
                    return [null, "ResponseTooLarge"];
                }
                chunks.push(value);
            }
        }

        const totalLength = chunks.reduce((acc, val) => acc + val.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        
        const text = new TextDecoder('utf-8', { fatal: false }).decode(result);
        
        try {
            return [JSON.parse(text), ""];
        } catch {
            return [null, "Response was not JSON"];
        }
    } catch (exc: any) {
        clearTimeout(timer);
        if (exc.name === 'AbortError') return [null, "DeadlineExceeded"];
        const cause = exc?.cause?.code || exc?.cause?.message;
        return [null, cause ? `${exc.name || "Error"}: ${cause}` : (exc.name || "Error")];
    }
}

function _asNonNegativeInt(value: any): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    return null;
}

async function _requestCollection(
    config: UnifiConfig,
    path: string,
    timeoutSeconds: number = 8.0
): Promise<[Record<string, any>[], string]> {
    const items: Record<string, any>[] = [];
    let offset = 0;

    while (offset < _MAX_COLLECTION_ITEMS) {
        const [payload, error] = await _request(config, path, timeoutSeconds, { offset, limit: _PAGE_SIZE });
        if (error) return [[], error];
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
            return [[], "Unexpected collection response"];
        }

        const page = payload.data;
        const total = _asNonNegativeInt(payload.totalCount);
        if (total !== null && total > _MAX_COLLECTION_ITEMS) {
            return [[], `Collection contains ${total} items, above the safe limit of ${_MAX_COLLECTION_ITEMS}`];
        }

        for (const entry of page) {
            if (entry && typeof entry === 'object') items.push(entry);
        }

        if (items.length > _MAX_COLLECTION_ITEMS) return [[], `Collection exceeded the safe limit of ${_MAX_COLLECTION_ITEMS}`];
        if (page.length === 0) {
            if (total !== null && items.length < total) {
                return [[], `Collection ended after ${items.length} of ${total} declared items`];
            }
            return [items, ""];
        }

        const nextOffset = offset + page.length;
        if (nextOffset <= offset) return [[], "Collection pagination did not advance"];
        if (total !== null && nextOffset >= total) return [items, ""];
        offset = nextOffset;
    }
    return [[], `Collection exceeded the safe limit of ${_MAX_COLLECTION_ITEMS}`];
}

// Caching primitive
interface CacheEntry<T> { value: T; expiresAt: number; }
const cache = new Map<string, CacheEntry<any>>();

function cacheKey(fnName: string, ...args: any[]): string {
    return `${fnName}:${JSON.stringify(args)}`;
}

function withTtlCache<T>(
    fnName: string,
    ttlSeconds: number,
    fn: (...args: any[]) => Promise<T>,
    maxEntries: number = 128
): (...args: any[]) => Promise<T> {
    return async (...args: any[]) => {
        const key = cacheKey(fnName, ...args);
        const now = Date.now();
        const entry = cache.get(key);
        
        if (entry && entry.expiresAt > now) return entry.value;
        
        const result = await fn(...args);
        
        if (cache.size >= maxEntries && !cache.has(key)) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey !== undefined) cache.delete(oldestKey);
        }
        cache.set(key, { value: result, expiresAt: now + ttlSeconds * 1000 });
        return result;
    };
}

const _fetchCollectionCached = withTtlCache("_fetchCollectionCached", 300, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string, path: string) => {
    return _requestCollection({ controllerUrl, apiKey, tlsVerify }, path);
}, 128);

const _resolveSiteId = withTtlCache("_resolveSiteId", 300, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string, site: string): Promise<string | null> => {
    const [sites, error] = await _requestCollection({ controllerUrl, apiKey, tlsVerify }, "/sites");
    if (error) {
        log.debug("Site lookup failed:", error);
        return null;
    }
    for (const entry of sites) {
        const intRef = String(entry.internalReference || "").toLowerCase();
        const name = String(entry.name || "").toLowerCase();
        const sLower = site.toLowerCase();
        if (sLower === intRef || sLower === name) return entry.id;
    }
    return sites.length > 0 ? sites[0].id : null;
});

export async function siteId(config: UnifiConfig): Promise<string | null> {
    config = normaliseConfig(config);
    if (!config.controllerUrl || !config.apiKey) return null;
    const tlsVerify = config.tlsVerify ?? config.verifyTls ?? true;
    return _resolveSiteId(config.controllerUrl, config.apiKey, tlsVerify, config.site || "default");
}

const _fetchDetailCached = withTtlCache("_fetchDetailCached", 300, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string, path: string): Promise<[Record<string, any>, string]> => {
    const [payload, error] = await _request({ controllerUrl, apiKey, tlsVerify }, path);
    if (error) return [{}, error];
    if (!payload || typeof payload !== 'object') return [{}, "Unexpected detail response"];
    if (payload.data && typeof payload.data === 'object') return [payload.data, ""];
    return [payload, ""];
}, 256);

const _SENSITIVE_FIELD_MARKERS = [
    "password", "passphrase", "secret", "token", "credential", "apikey",
    "privatekey", "presharedkey", "sharedkey", "psk", "communitystring"
];

export function safeForDisplay(value: any, depth: number = 0): any {
    if (depth >= 8) return "[nested data omitted]";
    if (Array.isArray(value)) {
        const visible = value.slice(0, 500).map(item => safeForDisplay(item, depth + 1));
        if (value.length > 500) visible.push(`[${value.length - 500} additional items omitted]`);
        return visible;
    }
    if (value && typeof value === 'object') {
        const safe: Record<string, any> = {};
        for (const [key, nested] of Object.entries(value)) {
            const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (_SENSITIVE_FIELD_MARKERS.some(marker => normalized.includes(marker))) {
                safe[key] = "[redacted]";
            } else {
                safe[key] = safeForDisplay(nested, depth + 1);
            }
        }
        return safe;
    }
    if (typeof value === 'string' && value.length > 4096) {
        return value.substring(0, 4096) + "… [truncated]";
    }
    return value;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function _toFloat(value: any): number | null {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
}

function _toInt(value: any): number | null {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
}

function _radios(stats: any): RadioStats[] {
    if (!stats || !stats.interfaces || !Array.isArray(stats.interfaces.radios)) return [];
    return stats.interfaces.radios.map((entry: any) => {
        const freq = _toFloat(entry.frequencyGHz);
        if (freq === null) return null;
        return new RadioStats({
            frequencyGhz: freq,
            txRetriesPercent: _toFloat(entry.txRetriesPct),
            wlanStandard: String(entry.wlanStandard || ""),
            channel: _toInt(entry.channel),
            channelWidthMhz: _toInt(entry.channelWidthMHz),
        });
    }).filter(Boolean) as RadioStats[];
}

function _ports(payload: any): PortStats[] {
    if (!payload || !payload.interfaces || !Array.isArray(payload.interfaces.ports)) return [];
    return payload.interfaces.ports.map((entry: any) => {
        const poe = entry.poe && typeof entry.poe === 'object' ? entry.poe : {};
        return new PortStats({
            index: _toInt(entry.idx),
            state: String(entry.state || ""),
            connector: String(entry.connector || ""),
            speedMbps: _toInt(entry.speedMbps),
            maxSpeedMbps: _toInt(entry.maxSpeedMbps),
            poeEnabled: typeof poe.enabled === 'boolean' ? poe.enabled : null,
            poeState: String(poe.state || ""),
            poeStandard: String(poe.standard || "")
        });
    });
}

function _mergeRadios(configured: RadioStats[], statistical: RadioStats[]): RadioStats[] {
    const cfgByBand = Object.fromEntries(configured.map(r => [r.band, r]));
    const statByBand = Object.fromEntries(statistical.map(r => [r.band, r]));
    const allBands = Array.from(new Set([...Object.keys(cfgByBand), ...Object.keys(statByBand)]));
    
    return allBands.map(band => {
        const base = cfgByBand[band];
        const stats = statByBand[band];
        return new RadioStats({
            frequencyGhz: (base || stats).frequencyGhz,
            txRetriesPercent: stats?.txRetriesPercent ?? base?.txRetriesPercent,
            wlanStandard: base?.wlanStandard ?? stats?.wlanStandard,
            channel: base?.channel ?? stats?.channel,
            channelWidthMhz: base?.channelWidthMhz ?? stats?.channelWidthMhz,
        });
    });
}

const _fetchDevices = withTtlCache("_fetchDevices", 60, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string, resolvedSite: string): Promise<[UnifiDevice[], string]> => {
    const config = { controllerUrl, apiKey, tlsVerify };
    const [entries, error] = await _requestCollection(config, `/sites/${resolvedSite}/devices`);
    if (error) return [[], error || "Unexpected device response"];

    const devices: UnifiDevice[] = [];
    for (const entry of entries) {
        const uplink = typeof entry.uplink === 'object' && entry.uplink ? entry.uplink : {};
        const device = new UnifiDevice({
            deviceId: String(entry.id || ""),
            name: String(entry.name || ""),
            model: String(entry.model || ""),
            mac: String(entry.macAddress || ""),
            ipAddress: String(entry.ipAddress || ""),
            state: String(entry.state || ""),
            deviceType: String(entry.type || ""),
            firmwareVersion: String(entry.firmwareVersion || ""),
            firmwareUpdatable: Boolean(entry.firmwareUpdatable),
            supported: typeof entry.supported === 'boolean' ? entry.supported : null,
            adoptedAt: String(entry.adoptedAt || ""),
            provisionedAt: String(entry.provisionedAt || ""),
            configurationId: String(entry.configurationId || ""),
            uplinkDeviceId: String(uplink.deviceId || ""),
            ports: _ports(entry),
            radios: _radios(entry)
        });

        if (device.online && device.deviceId) {
            const [detail, detailError] = await _fetchDetailCached(
                controllerUrl,
                apiKey,
                tlsVerify,
                `/sites/${resolvedSite}/devices/${device.deviceId}`
            );
            if (!detailError) {
                const detailPorts = _ports(detail);
                const detailRadios = _radios(detail);
                if (detailPorts.length) device.ports = detailPorts;
                if (detailRadios.length) device.radios = _mergeRadios(device.radios, detailRadios);
            }
            const [stats, statsError] = await _request(config, `/sites/${resolvedSite}/devices/${device.deviceId}/statistics/latest`);
            if (!statsError && stats && typeof stats === 'object') {
                device.uptimeSeconds = _toFloat(stats.uptimeSec);
                device.cpuPercent = _toFloat(stats.cpuUtilizationPct);
                device.memoryPercent = _toFloat(stats.memoryUtilizationPct);
                const statsUplink = stats.uplink || {};
                device.uplinkRxBps = _toFloat(statsUplink.rxRateBps);
                device.uplinkTxBps = _toFloat(statsUplink.txRateBps);
                device.load1m = _toFloat(stats.loadAverage1Min);
                const statisticalRadios = _radios(stats);
                if (statisticalRadios.length > 0) {
                    device.radios = _mergeRadios(device.radios, statisticalRadios);
                }
            }
        }
        devices.push(device);
    }
    return [devices, ""];
});

export async function getDevices(config: UnifiConfig): Promise<[UnifiDevice[], string]> {
    config = normaliseConfig(config);
    const resolved = await siteId(config);
    if (!resolved) return [[], "Could not resolve the UniFi site id"];
    const tlsVerify = config.tlsVerify ?? config.verifyTls ?? true;
    return _fetchDevices(config.controllerUrl!, config.apiKey!, tlsVerify, resolved);
}

function _pickGateway(devices: UnifiDevice[]): UnifiDevice | null {
    for (const d of devices) {
        if (d.role === "gateway") return d;
    }
    return devices.length > 0 ? devices[0] : null;
}

async function _gatewayFromPrometheus(status: GatewayStatus, prometheusClient?: PrometheusClient): Promise<GatewayStatus> {
    if (!prometheusClient || !prometheusClient.available()) {
        status.error = "unpoller metrics are not available in Prometheus";
        return status;
    }
    try {
        status.uptimeSeconds = await prometheusClient.queryOne("unpoller_device_uptime_seconds{type='ugw'}");
        status.cpuPercent = await prometheusClient.queryOne("unpoller_device_cpu_percent{type='ugw'}");
        status.memoryPercent = await prometheusClient.queryOne("unpoller_device_memory_percent{type='ugw'}");
        const latency = await prometheusClient.queryOne("unpoller_usg_wan_latency_seconds");
        status.wanLatencyMs = latency !== null ? latency * 1000.0 : null;
        status.wanRxBytesPerSec = await prometheusClient.queryOne("rate(unpoller_usg_wan_bytes_total{direction='rx'}[5m])");
        status.wanTxBytesPerSec = await prometheusClient.queryOne("rate(unpoller_usg_wan_bytes_total{direction='tx'}[5m])");
        status.wanUp = status.uptimeSeconds !== null;
    } catch (exc: any) {
        log.debug("UniFi metrics query failed:", exc);
        status.error = `UniFi metrics query failed: ${exc.message || exc}`;
    }
    return status;
}

export async function getGatewayStatus(
    config: UnifiConfig,
    prometheusClient?: PrometheusClient,
    timeoutSeconds: number = 8.0,
    devices?: UnifiDevice[]
): Promise<GatewayStatus> {
    config = normaliseConfig(config);
    const status = new GatewayStatus();
    const available = availability(config);
    status.configured = available.configured;
    
    if (!available.configured) {
        status.error = available.detail;
        return status;
    }

    if (config.controllerUrl && config.apiKey) {
        let error = "";
        let devs = devices;
        if (!devs) {
            [devs, error] = await getDevices(config);
        }
        if (error) {
            status.error = error;
            return status;
        }
        const gateway = _pickGateway(devs!);
        if (!gateway) {
            status.error = "No gateway device found in the UniFi inventory";
            return status;
        }
        status.name = gateway.name;
        status.model = gateway.model;
        status.state = gateway.state;
        status.uptimeSeconds = gateway.uptimeSeconds;
        status.cpuPercent = gateway.cpuPercent;
        status.memoryPercent = gateway.memoryPercent;
        status.wanUp = gateway.online;
        status.wanRxBytesPerSec = gateway.uplinkRxBps !== null ? gateway.uplinkRxBps / 8.0 : null;
        status.wanTxBytesPerSec = gateway.uplinkTxBps !== null ? gateway.uplinkTxBps / 8.0 : null;
        return status;
    }

    return await _gatewayFromPrometheus(status, prometheusClient);
}

// ---------------------------------------------------------------------------
// Clients and VLANs
// ---------------------------------------------------------------------------

const _fetchClients = withTtlCache("_fetchClients", 60, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string, resolvedSite: string): Promise<[Record<string, any>[], string]> => {
    return _requestCollection({ controllerUrl, apiKey, tlsVerify }, `/sites/${resolvedSite}/clients`);
});

export async function getVlanStats(config: UnifiConfig, vlans: VlanStats[], prometheusClient?: PrometheusClient): Promise<VlanStats[]> {
    config = normaliseConfig(config);
    const stats = vlans.map(v => {
        const source = v as VlanStats & { vlan_id?: number };
        return new VlanStats({ vlanId: source.vlanId ?? source.vlan_id ?? 0, name: source.name, subnet: source.subnet });
    });
    const available = availability(config);
    if (!available.configured) return stats;

    if (config.controllerUrl && config.apiKey) {
        const resolved = await siteId(config);
        if (!resolved) return stats;
        
        const tlsVerify = config.tlsVerify ?? config.verifyTls ?? true;
        const [clients, error] = await _fetchClients(config.controllerUrl, config.apiKey, tlsVerify, resolved);
        if (error) {
            log.debug("Client fetch failed:", error);
            return stats;
        }

        const networks = [];
        for (const entry of stats) {
            try {
                const parsedNet = ipaddr.parseCIDR(entry.subnet);
                networks.push({ entry, network: parsedNet });
                entry.clientCount = 0;
            } catch (e) {
                // Invalid CIDR
            }
        }

        for (const client of clients) {
            const address = String(client.ipAddress || "").trim();
            if (!address) continue;
            try {
                const parsedIp = ipaddr.parse(address);
                for (const { entry, network } of networks) {
                    // ipaddr.js match method checks subnet presence
                    if (parsedIp.match(network)) {
                        entry.clientCount = (entry.clientCount || 0) + 1;
                        break;
                    }
                }
            } catch (e) {
                // Invalid IP
            }
        }
        return stats;
    }

    if (prometheusClient && prometheusClient.available()) {
        try {
            const results = await prometheusClient.query("unpoller_client_count");
            const counts: Record<string, number> = {};
            for (const item of results) {
                if (item.labels.network) counts[item.labels.network] = item.value;
            }
            for (const entry of stats) {
                for (const [networkName, value] of Object.entries(counts)) {
                    if (networkName.toLowerCase() === entry.name.toLowerCase()) {
                        entry.clientCount = value;
                        break;
                    }
                }
            }
        } catch (exc) {
            log.debug("VLAN client counts unavailable:", exc);
        }
    }
    return stats;
}

// ---------------------------------------------------------------------------
// Controller metadata, networks, WANs and firewall policy
// ---------------------------------------------------------------------------

export class ControllerInfo {
    version: string = "";
    reachable: boolean = false;
    error: string = "";
    constructor(init?: Partial<ControllerInfo>) { Object.assign(this, init); }
}

function _extractVersion(payload: any): string {
    if (!payload || typeof payload !== 'object') return "";
    const candidates = [payload];
    if (payload.data && typeof payload.data === 'object') candidates.push(payload.data);
    
    for (const source of candidates) {
        for (const key of ["applicationVersion", "version"]) {
            if (source[key]) return String(source[key]);
        }
    }
    return "";
}

export const getControllerInfo = withTtlCache("getControllerInfo", 600, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string): Promise<ControllerInfo> => {
    const [payload, error] = await _request({ controllerUrl, apiKey, tlsVerify }, "/info");
    if (error) return new ControllerInfo({ error });
    return new ControllerInfo({ version: _extractVersion(payload), reachable: true });
});

export class UnifiNetwork {
    networkId: string = "";
    name: string = "";
    subnet: string = "";
    vlanId: number | null = null;
    purpose: string = "";
    enabled: boolean = true;
    constructor(init?: Partial<UnifiNetwork>) { Object.assign(this, init); }
}

export const getNetworks = withTtlCache("getNetworks", 300, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string, site: string): Promise<[UnifiNetwork[], string]> => {
    const resolved = await _resolveSiteId(controllerUrl, apiKey, tlsVerify, site);
    if (!resolved) return [[], "Could not resolve the site id"];
    
    const [entries, error] = await _fetchCollectionCached(controllerUrl, apiKey, tlsVerify, `/sites/${resolved}/networks`);
    if (error) return [[], error || "Unexpected response"];

    const networks = entries.map(entry => {
        const vlan = entry.vlanId ?? entry.vlan;
        const vlanId = vlan !== undefined && vlan !== null ? _toInt(vlan) : null;
        return new UnifiNetwork({
            networkId: String(entry.id || ""),
            name: String(entry.name || ""),
            subnet: String(entry.subnet || entry.ipSubnet || ""),
            vlanId,
            purpose: String(entry.purpose || ""),
            enabled: Boolean(entry.enabled ?? true)
        });
    });
    return [networks, ""];
});

export class FirewallPolicy {
    policyId: string = "";
    name: string = "";
    action: string = "";
    enabled: boolean = true;
    predefined: boolean = false;
    source: string = "";
    destination: string = "";
    constructor(init?: Partial<FirewallPolicy>) { Object.assign(this, init); }
}

function _endpointLabel(spec: any): string {
    if (!spec || typeof spec !== 'object') return "";
    for (const key of ["zoneId", "zone", "networkId", "matchingTarget", "ips"]) {
        const val = spec[key];
        if (Array.isArray(val) && val.length > 0) return val.slice(0, 3).map(String).join(", ");
        if (val) return String(val);
    }
    return "";
}

export const getFirewallPolicies = withTtlCache("getFirewallPolicies", 300, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string, site: string): Promise<[FirewallPolicy[], string]> => {
    const resolved = await _resolveSiteId(controllerUrl, apiKey, tlsVerify, site);
    if (!resolved) return [[], "Could not resolve the site id"];
    
    const [entries, error] = await _fetchCollectionCached(controllerUrl, apiKey, tlsVerify, `/sites/${resolved}/firewall/policies`);
    if (error) {
        if (error.includes("500")) {
            return [[], "The controller's firewall-policies endpoint returned HTTP 500 (a UniFi-side error on this firmware). Firewall zones below are unaffected."];
        }
        return [[], error];
    }
    const policies = entries.map(entry => {
        return new FirewallPolicy({
            policyId: String(entry.id || ""),
            name: String(entry.name || "(unnamed)"),
            action: String(entry.action || ""),
            enabled: Boolean(entry.enabled ?? true),
            predefined: Boolean(entry.predefined ?? false),
            source: _endpointLabel(entry.source || {}),
            destination: _endpointLabel(entry.destination || {})
        });
    });
    return [policies, ""];
});

export class FirewallZone {
    zoneId: string = "";
    name: string = "";
    networkIds: string[] = [];
    constructor(init?: Partial<FirewallZone>) { Object.assign(this, init); }
}

export const getFirewallZones = withTtlCache("getFirewallZones", 300, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string, site: string): Promise<[FirewallZone[], string]> => {
    const resolved = await _resolveSiteId(controllerUrl, apiKey, tlsVerify, site);
    if (!resolved) return [[], "Could not resolve the site id"];
    
    const [entries, error] = await _fetchCollectionCached(controllerUrl, apiKey, tlsVerify, `/sites/${resolved}/firewall/zones`);
    if (error) return [[], error || "Unexpected response"];
    
    const zones = entries.map(entry => {
        const netIds = Array.isArray(entry.networkIds) ? entry.networkIds.map(String) : [];
        return new FirewallZone({
            zoneId: String(entry.id || ""),
            name: String(entry.name || "(unnamed)"),
            networkIds: netIds
        });
    });
    return [zones, ""];
});

export const getWans = withTtlCache("getWans", 300, async (controllerUrl: string, apiKey: string, tlsVerify: boolean | string, site: string): Promise<[Record<string, any>[], string]> => {
    const resolved = await _resolveSiteId(controllerUrl, apiKey, tlsVerify, site);
    if (!resolved) return [[], "Could not resolve the site id"];
    return _fetchCollectionCached(controllerUrl, apiKey, tlsVerify, `/sites/${resolved}/wans`);
});

export function getIdsEvents(config: UnifiConfig, limit: number = 50, timeoutSeconds: number = 8.0): any[] {
    return [];
}

export function idsAvailable(config: UnifiConfig): boolean {
    return false;
}
