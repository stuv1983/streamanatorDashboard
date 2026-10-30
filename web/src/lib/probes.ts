import * as dns from 'dns/promises';
import * as net from 'net';
import * as tls from 'tls';
import { performance } from 'perf_hooks';

export interface ProbeResult {
    key: string;
    display: string;
    url: string;
    success: boolean;
    latency_ms: number | null;
    status_code: number | null;
    error: string;
    failed_stage: string;
    dns_ms: number | null;
    connect_ms: number | null;
    tls_expiry: number | null; // Unix timestamp in seconds
    checked_at: number; // Unix timestamp in seconds
    source: string;
    tls_days_remaining?: number | null;
}

export async function probeHttp(
    key: string,
    display: string,
    url: string,
    expect_status: number[] = [200],
    timeoutSecs: number = 5.0,
    verify_tls: boolean = true
): Promise<ProbeResult> {
    if (!url) {
        return {
            key, display, url, success: false,
            error: "No URL configured", failed_stage: "config",
            latency_ms: null, status_code: null, dns_ms: null, connect_ms: null, tls_expiry: null,
            checked_at: Date.now() / 1000, source: "direct", tls_days_remaining: null
        };
    }

    let host = "";
    let port = 80;
    let scheme = "http:";
    try {
        const parsed = new URL(url);
        host = parsed.hostname;
        scheme = parsed.protocol;
        port = parsed.port ? parseInt(parsed.port, 10) : (scheme === "https:" ? 443 : 80);
    } catch {
        return {
            key, display, url, success: false,
            error: "Invalid URL", failed_stage: "config",
            latency_ms: null, status_code: null, dns_ms: null, connect_ms: null, tls_expiry: null,
            checked_at: Date.now() / 1000, source: "direct", tls_days_remaining: null
        };
    }

    // Stage 1: DNS
    let dns_ms: number | null = null;
    if (host && net.isIP(host) === 0) {
        const start = performance.now();
        try {
            await dns.lookup(host);
            dns_ms = performance.now() - start; // performance.now() directly returns ms
        } catch (exc: any) {
            return {
                key, display, url, success: false,
                error: `DNS resolution failed: ${exc.message}`,
                failed_stage: "dns",
                latency_ms: null, status_code: null, dns_ms: null, connect_ms: null, tls_expiry: null,
                checked_at: Date.now() / 1000, source: "direct", tls_days_remaining: null
            };
        }
    }

    // Stage 2: TCP connect
    let connect_ms: number | null = null;
    const tcpStart = performance.now();
    try {
        await new Promise<void>((resolve, reject) => {
            const socket = net.createConnection(port, host);
            socket.setTimeout(timeoutSecs * 1000);
            socket.once('connect', () => {
                socket.destroy();
                resolve();
            });
            socket.once('timeout', () => {
                socket.destroy();
                reject(new Error(`Timeout after ${timeoutSecs}s`));
            });
            socket.once('error', (err) => reject(err));
        });
        connect_ms = performance.now() - tcpStart;
    } catch (exc: any) {
        return {
            key, display, url, success: false,
            error: `TCP connect failed: ${exc.message}`,
            failed_stage: "tcp",
            latency_ms: null, status_code: null, dns_ms, connect_ms: null, tls_expiry: null,
            checked_at: Date.now() / 1000, source: "direct", tls_days_remaining: null
        };
    }

    // Stage 3: TLS expiry
    let tls_expiry: number | null = null;
    if (scheme === "https:") {
        tls_expiry = await _tlsExpiry(host, port, timeoutSecs);
    }

    // Stage 4: HTTP exchange
    let latency_ms: number | null = null;
    let status_code: number | null = null;
    const httpStart = performance.now();
    try {
        // NOTE: Native fetch does not natively support disabling verify_tls without custom undici dispatchers.
        const response = await fetch(url, {
            signal: AbortSignal.timeout(timeoutSecs * 1000),
            redirect: 'manual', // match allow_redirects=False
            headers: {
                "User-Agent": "streamanator-dashboard/1.0 (health probe)"
            }
        });
        latency_ms = performance.now() - httpStart;
        status_code = response.status;
    } catch (exc: any) {
        const isTimeout = exc.name === 'TimeoutError' || exc.name === 'AbortError';
        return {
            key, display, url, success: false,
            error: isTimeout ? `HTTP request timed out after ${timeoutSecs}s` : `HTTP request failed: ${exc.name || exc.message}`,
            failed_stage: "http",
            latency_ms: null, status_code: null, dns_ms, connect_ms, tls_expiry,
            checked_at: Date.now() / 1000, source: "direct",
            tls_days_remaining: tls_expiry ? (tls_expiry - (Date.now() / 1000)) / 86400.0 : null
        };
    }

    const ok = expect_status.includes(status_code);
    const checked_at = Date.now() / 1000;
    return {
        key, display, url,
        success: ok,
        latency_ms,
        status_code,
        error: ok ? "" : `Unexpected HTTP ${status_code}`,
        failed_stage: ok ? "" : "status",
        dns_ms, connect_ms, tls_expiry,
        checked_at, source: "direct",
        tls_days_remaining: tls_expiry ? (tls_expiry - checked_at) / 86400.0 : null
    };
}

async function _tlsExpiry(host: string, port: number, timeoutSecs: number): Promise<number | null> {
    return new Promise((resolve) => {
        const socket = tls.connect({
            host,
            port,
            rejectUnauthorized: false,
            servername: net.isIP(host) === 0 ? host : undefined
        });
        
        socket.setTimeout(timeoutSecs * 1000);
        
        socket.once('secureConnect', () => {
            const cert = socket.getPeerCertificate();
            socket.destroy();
            if (cert && cert.valid_to) {
                resolve(new Date(cert.valid_to).getTime() / 1000);
            } else {
                resolve(null);
            }
        });
        
        socket.once('timeout', () => {
            socket.destroy();
            resolve(null);
        });
        
        socket.once('error', () => {
            socket.destroy();
            resolve(null);
        });
    });
}

export async function probeTcp(host: string, port: number, timeoutSecs: number = 4.0): Promise<[boolean, number | null]> {
    const start = performance.now();
    try {
        await new Promise<void>((resolve, reject) => {
            const socket = net.createConnection(port, host);
            socket.setTimeout(timeoutSecs * 1000);
            socket.once('connect', () => {
                socket.destroy();
                resolve();
            });
            socket.once('timeout', () => {
                socket.destroy();
                reject(new Error("timeout"));
            });
            socket.once('error', reject);
        });
        return [true, performance.now() - start];
    } catch {
        return [false, null];
    }
}


// TTL Caches
const probeCache = new Map<string, { expires: number, data: ProbeResult[] }>();
const dnsCache = new Map<string, { expires: number, data: [boolean, number | null] }>();

export async function probeMany(
    targets: Array<[string, string, string, number[]]>,
    timeoutSecs: number = 5.0,
    maxWorkers: number = 8
): Promise<ProbeResult[]> {
    if (!targets || targets.length === 0) return [];
    
    const cacheKey = JSON.stringify({ targets, timeoutSecs });
    const now = Date.now();
    const cached = probeCache.get(cacheKey);
    if (cached && cached.expires > now) {
        return cached.data;
    }
    
    // Create pre-sized array to preserve original order of targets
    const results: ProbeResult[] = new Array(targets.length);
    const queue = targets.map((t, i) => ({ index: i, target: t }));
    
    async function worker() {
        while (queue.length > 0) {
            const task = queue.shift();
            if (!task) break;
            const [key, display, url, expect] = task.target;
            results[task.index] = await probeHttp(key, display, url, expect, timeoutSecs, true);
        }
    }
    
    const workers = [];
    const numWorkers = Math.min(maxWorkers, targets.length);
    for (let i = 0; i < numWorkers; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    
    probeCache.set(cacheKey, { expires: Date.now() + 45000, data: results });
    return results;
}

export async function probeDns(hostname: string = "cloudflare.com", timeoutSecs: number = 4.0): Promise<[boolean, number | null]> {
    const cacheKey = `${hostname}:${timeoutSecs}`;
    const now = Date.now();
    const cached = dnsCache.get(cacheKey);
    if (cached && cached.expires > now) {
        return cached.data;
    }

    const start = performance.now();
    let result: [boolean, number | null];
    try {
        await Promise.race([
            dns.lookup(hostname),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutSecs * 1000))
        ]);
        result = [true, performance.now() - start];
    } catch {
        result = [false, null];
    }
    
    dnsCache.set(cacheKey, { expires: Date.now() + 30000, data: result });
    return result;
}

// ---------------------------------------------------------------------------
// Blackbox Exporter
// ---------------------------------------------------------------------------

export async function probesFromBlackbox(client: any, timeoutSecs: number = 4.0): Promise<Record<string, ProbeResult>> {
    const results: Record<string, ProbeResult> = {};
    if (!client || typeof client.available !== 'function' || !(await client.available())) {
        return results;
    }

    let successes: any[] = [];
    try {
        successes = await client.query("probe_success");
    } catch (exc) {
        console.debug("Blackbox query failed:", exc);
        return results;
    }

    if (!successes || successes.length === 0) {
        return results;
    }

    const durations: Record<string, number> = {};
    const statuses: Record<string, number> = {};
    const expiries: Record<string, number> = {};

    try {
        const d = await client.query("probe_duration_seconds");
        for (const item of d) {
            if (item.labels?.instance) durations[item.labels.instance] = parseFloat(item.value);
        }
        const s = await client.query("probe_http_status_code");
        for (const item of s) {
            if (item.labels?.instance) statuses[item.labels.instance] = parseInt(item.value, 10);
        }
        const e = await client.query("probe_ssl_earliest_cert_expiry");
        for (const item of e) {
            if (item.labels?.instance) expiries[item.labels.instance] = parseFloat(item.value);
        }
    } catch (exc) {
        // pass
    }

    for (const item of successes) {
        const instance = item.labels?.instance || "";
        const key = instance;
        const successVal = parseFloat(item.value);
        const tls_expiry = expiries[instance] !== undefined ? expiries[instance] : null;
        const checked_at = item.timestamp || (Date.now() / 1000);
        
        results[key] = {
            key,
            display: instance,
            url: instance,
            success: successVal > 0,
            latency_ms: durations[instance] !== undefined ? durations[instance] * 1000.0 : null,
            status_code: statuses[instance] !== undefined ? statuses[instance] : null,
            tls_expiry,
            checked_at,
            source: "prometheus:blackbox",
            error: "",
            failed_stage: successVal > 0 ? "" : "unknown",
            dns_ms: null,
            connect_ms: null,
            tls_days_remaining: tls_expiry ? (tls_expiry - checked_at) / 86400.0 : null
        };
    }
    return results;
}
