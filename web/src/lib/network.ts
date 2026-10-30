import * as fs from 'fs';
import { spawn } from 'child_process';

export const DEFAULT_GATEWAY = "10.0.40.1";
export const DEFAULT_INTERNET_TARGET = "1.1.1.1";

export interface PingResult {
    target: string;
    latency_ms: number | null;
    packet_loss_percent: number | null;
    jitter_ms: number | null;
    packets_sent: number;
    packets_received: number;
    error: string;
    checked_at: number;
    reachable: boolean;
}

const PING_STATS = /(\d+) packets transmitted, (\d+) (?:packets )?received(?:.*?([\d.]+)% packet loss)?/s;
const PING_RTT = /(?:rtt|round-trip) min\/avg\/max\/(?:mdev|stddev) = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/;

export function parse_ping(output: string, target: string): PingResult {
    let sent = 0;
    let received = 0;
    let loss: number | null = null;
    
    const statsMatch = PING_STATS.exec(output);
    if (statsMatch) {
        sent = parseInt(statsMatch[1], 10);
        received = parseInt(statsMatch[2], 10);
        if (statsMatch[3] !== undefined) {
            loss = parseFloat(statsMatch[3]);
        } else if (sent) {
            loss = 100.0 * (sent - received) / sent;
        }
    }

    let latency: number | null = null;
    let jitter: number | null = null;
    const rttMatch = PING_RTT.exec(output);
    if (rttMatch) {
        latency = parseFloat(rttMatch[2]);
        jitter = parseFloat(rttMatch[4]);
    }

    return {
        target,
        latency_ms: latency,
        packet_loss_percent: loss,
        jitter_ms: jitter,
        packets_sent: sent,
        packets_received: received,
        error: "",
        checked_at: Date.now() / 1000,
        reachable: received > 0,
    };
}

async function run_command(command: string, args: string[], timeoutSeconds: number): Promise<{code: number, out: string, err: string}> {
    return new Promise((resolve) => {
        let out = "";
        let err = "";
        
        const child = spawn(command, args, { timeout: timeoutSeconds * 1000 });
        
        child.stdout.on('data', (data) => { out += data.toString(); });
        child.stderr.on('data', (data) => { err += data.toString(); });
        
        child.on('error', (error: any) => {
            if (error.code === 'ENOENT') {
                resolve({ code: 127, out: "", err: "binary not available" });
            } else {
                resolve({ code: -1, out: "", err: error.message });
            }
        });
        
        child.on('close', (code) => {
            resolve({ code: code ?? -1, out, err });
        });
    });
}

function ttl_cache<T extends (...args: any[]) => Promise<any>>(seconds: number, fn: T): T {
    let cache: { value: any, expires: number } | null = null;
    return (async (...args: any[]) => {
        const now = Date.now();
        if (cache && now < cache.expires) {
            return cache.value;
        }
        const value = await fn(...args);
        cache = { value, expires: now + seconds * 1000 };
        return value;
    }) as any;
}

export const ping = ttl_cache(50, async (target: string, count: number = 5, timeout: number = 8.0): Promise<PingResult> => {
    const { code, out, err } = await run_command("ping", ["-n", "-c", count.toString(), "-W", "2", "-i", "0.3", target], timeout);
    if (code === 127) {
        return {
            target,
            latency_ms: null,
            packet_loss_percent: null,
            jitter_ms: null,
            packets_sent: 0,
            packets_received: 0,
            error: "ping binary not available",
            checked_at: Date.now() / 1000,
            reachable: false,
        };
    }
    const result = parse_ping(out, target);
    if (result.packets_sent === 0) {
        result.error = err.trim() || out.trim().substring(0, 120) || "ping produced no summary";
    }
    return result;
});

export interface WanIpInfo {
    ip: string | null;
    city: string;
    region: string;
    country: string;
    org: string;
    error: string;
    checked_at: number;
    location: string;
}

function valid_ip(value: string): boolean {
    const ipv4 = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6 = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
    return ipv4.test(value) || ipv6.test(value);
}

export const get_public_ip = ttl_cache(120, async (url: string = "https://ipinfo.io/json", timeout: number = 6.0): Promise<WanIpInfo> => {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);
        const response = await fetch(url, {
            headers: { "User-Agent": "streamanator-dashboard/1.0" },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }
        
        const payload = await response.json();
        const ip = String(payload.ip || "").trim();
        
        if (!valid_ip(ip)) {
            return {
                ip: null,
                city: "",
                region: "",
                country: "",
                org: "",
                error: "Response did not contain a valid IP",
                checked_at: Date.now() / 1000,
                location: ""
            };
        }
        
        const city = String(payload.city || "");
        const region = String(payload.region || "");
        const country = String(payload.country || "");
        
        const parts = [city, region, country].filter(p => p);
        const location = parts.join(", ");
        
        return {
            ip,
            city,
            region,
            country,
            org: String(payload.org || ""),
            error: "",
            checked_at: Date.now() / 1000,
            location
        };
    } catch (exc: any) {
        return {
            ip: null,
            city: "",
            region: "",
            country: "",
            org: "",
            error: `${exc.name || 'Error'}: ${exc.message}`,
            checked_at: Date.now() / 1000,
            location: ""
        };
    }
});

export interface InterfaceCounters {
    name: string;
    rx_bytes: number;
    tx_bytes: number;
    rx_errors: number;
    tx_errors: number;
    rx_dropped: number;
    tx_dropped: number;
    timestamp: number;
}

export function read_interface_counters(): Record<string, InterfaceCounters> {
    try {
        const data = fs.readFileSync("/proc/net/dev", { encoding: "utf-8" });
        const lines = data.split('\n');
        
        const counters: Record<string, InterfaceCounters> = {};
        for (let i = 2; i < lines.length; i++) {
            const line = lines[i];
            const colonIndex = line.indexOf(":");
            if (colonIndex === -1) continue;
            
            const name = line.substring(0, colonIndex).trim();
            const rest = line.substring(colonIndex + 1);
            const fields = rest.trim().split(/\s+/);
            
            if (fields.length < 16 || name === "lo") {
                continue;
            }
            
            counters[name] = {
                name,
                rx_bytes: parseInt(fields[0], 10),
                rx_errors: parseInt(fields[2], 10),
                rx_dropped: parseInt(fields[3], 10),
                tx_bytes: parseInt(fields[8], 10),
                tx_errors: parseInt(fields[10], 10),
                tx_dropped: parseInt(fields[11], 10),
                timestamp: Date.now() / 1000
            };
        }
        return counters;
    } catch (e) {
        return {};
    }
}

let _last_interface_counters: Record<string, InterfaceCounters> = {};

export interface InterfaceRate {
    name: string;
    rx_bytes_per_sec: number;
    tx_bytes_per_sec: number;
    rx_error_delta: number;
    tx_error_delta: number;
    drop_delta: number;
}

export function get_interface_rates(): Record<string, InterfaceRate> {
    const current = read_interface_counters();
    const previous = _last_interface_counters;
    _last_interface_counters = current;
    
    if (Object.keys(previous).length === 0) {
        return {};
    }
    
    const rates: Record<string, InterfaceRate> = {};
    for (const [name, counters] of Object.entries(current)) {
        const before = previous[name];
        if (!before) continue;
        
        const elapsed = counters.timestamp - before.timestamp;
        if (elapsed <= 0) continue;
        
        rates[name] = {
            name,
            rx_bytes_per_sec: Math.max(0, counters.rx_bytes - before.rx_bytes) / elapsed,
            tx_bytes_per_sec: Math.max(0, counters.tx_bytes - before.tx_bytes) / elapsed,
            rx_error_delta: Math.max(0, counters.rx_errors - before.rx_errors),
            tx_error_delta: Math.max(0, counters.tx_errors - before.tx_errors),
            drop_delta: Math.max(
                0,
                (counters.rx_dropped + counters.tx_dropped) - (before.rx_dropped + before.tx_dropped)
            )
        };
    }
    
    return rates;
}

export async function get_default_gateway(): Promise<string | null> {
    const { code, out } = await run_command("ip", ["-4", "route", "show", "default"], 4.0);
    if (code !== 0) {
        return null;
    }
    const match = out.match(/default via (\S+)/);
    return match ? match[1] : null;
}
