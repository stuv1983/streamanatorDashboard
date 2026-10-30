import { ContainerInfo, execReadonly, getContainerLogs } from './docker_service';

export interface VpnStatus {
    containerPresent: boolean;
    containerRunning: boolean;
    containerHealthy: boolean | null;
    tunnelUp: boolean | null;
    publicIp: string | null;
    location: string;
    org: string;
    provider: string;
    protocol: string;
    endpoint: string;
    uptimeSeconds: number | null;
    restartCount: number;
    dnsOk: boolean | null;
    httpsOk: boolean | null;
    authFailures: number;
    reconnects: number;
    recentErrors: string[];
    error: string;
    checkedAt: number;
    source: string;
}

export interface LeakCheck {
    passed: boolean | null;
    vpnIp: string | null;
    wanIp: string | null;
    detail: string;
    conclusive: boolean;
}

const LOG_SIGNATURES: Array<[RegExp, string, string]> = [
    [
        /AUTH_FAILED/i,
        "VPN authentication failure",
        "The provider rejected the credentials. Check OPENVPN_USER/OPENVPN_PASSWORD in the Gluetun environment — NordVPN service credentials are not the same as the account login."
    ],
    [
        /TLS Error|TLS handshake failed/i,
        "TLS handshake failure to the VPN endpoint",
        "The endpoint may be down or blocked. Try a different server."
    ],
    [
        /Connection refused|Network is unreachable/i,
        "Network path to the VPN endpoint unavailable",
        "Check the host's own Internet connectivity first."
    ],
    [
        /did not run yet/i,
        "Gluetun health server has not completed its first check",
        "Normal briefly after a restart; persistent means the tunnel never came up."
    ],
    [
        /SIGUSR1|restarting/i,
        "Tunnel restart loop",
        "Gluetun is cycling. Read the lines above the restart for the trigger."
    ],
    [
        /dial tcp.*i\/o timeout/i,
        "Timeout reaching the VPN endpoint",
        "Provider-side or upstream network issue."
    ]
];

export function analyseLogs(lines: string[]): { cause: string; recommendation: string; authFailures: number; reconnects: number; errors: string[] } {
    const authFailures = lines.filter(line => line.toUpperCase().includes("AUTH_FAILED")).length;
    const reconnects = lines.filter(line => /SIGUSR1|restarting|reconnect/i.test(line)).length;
    const errors = lines.filter(line => /\bERROR\b|\bFATAL\b|AUTH_FAILED|TLS Error/i.test(line)).slice(-8);

    for (const [pattern, cause, recommendation] of LOG_SIGNATURES) {
        if (lines.some(line => pattern.test(line))) {
            return { cause, recommendation, authFailures, reconnects, errors };
        }
    }
    return { cause: "", recommendation: "", authFailures, reconnects, errors };
}

export async function getVpnStatus(
    container: ContainerInfo | null,
    containerName: string,
    options: {
        ipCheckUrl?: string;
        provider?: string;
        protocol?: string;
        controlUrl?: string;
        apiKey?: string | null;
        timeout?: number;
        readLogs?: boolean;
    } = {}
): Promise<VpnStatus> {
    const ipCheckUrl = options.ipCheckUrl || "https://ipinfo.io/json";
    const provider = options.provider || "nordvpn";
    const protocol = options.protocol || "openvpn";
    const controlUrl = options.controlUrl || "";
    const apiKey = options.apiKey || null;
    const timeout = options.timeout || 10.0;
    const readLogs = options.readLogs !== false;

    const status: VpnStatus = {
        containerPresent: false,
        containerRunning: false,
        containerHealthy: null,
        tunnelUp: null,
        publicIp: null,
        location: "",
        org: "",
        provider: provider,
        protocol: protocol,
        endpoint: "",
        uptimeSeconds: null,
        restartCount: 0,
        dnsOk: null,
        httpsOk: null,
        authFailures: 0,
        reconnects: 0,
        recentErrors: [],
        error: "",
        checkedAt: Date.now() / 1000,
        source: "docker"
    };

    if (!container) {
        status.error = `Container ${containerName} not found`;
        return status;
    }

    status.containerPresent = true;
    status.containerRunning = container.running;
    status.containerHealthy = container.healthy;
    status.uptimeSeconds = container.uptime_seconds;
    status.restartCount = container.restart_count;

    const envProvider = container.labels?.["vpn_service_provider"];
    if (envProvider) {
        status.provider = envProvider;
    }

    if (!container.running) {
        status.tunnelUp = false;
        status.error = `Container state: ${container.state}`;
        if (readLogs) {
            await attachLogAnalysis(status, containerName);
        }
        return status;
    }

    const ipInfo = await exitIpViaContainer(containerName, ipCheckUrl, timeout);
    if (ipInfo) {
        status.publicIp = ipInfo.ip || null;
        const locationParts = [ipInfo.city, ipInfo.region, ipInfo.country].filter(Boolean);
        status.location = locationParts.join(", ");
        status.org = ipInfo.org || "";
        status.tunnelUp = !!status.publicIp;
        status.dnsOk = true;
        status.httpsOk = true;
    } else {
        status.tunnelUp = false;
        const probes = await probeFromContainer(containerName, timeout);
        status.dnsOk = probes.dnsOk;
        status.httpsOk = probes.httpsOk;
    }

    if (controlUrl) {
        await augmentFromControlServer(status, controlUrl, apiKey, timeout);
    }

    const unhealthy = status.containerHealthy === false || status.tunnelUp === false || status.dnsOk === false;
    if (readLogs && unhealthy) {
        await attachLogAnalysis(status, containerName);
    }

    return status;
}

const exitIpCache = new Map<string, { data: Record<string, any>; expiresAt: number }>();

async function exitIpViaContainer(containerName: string, url: string, timeoutSec: number): Promise<Record<string, any> | null> {
    const now = Date.now();
    const cacheKey = `${containerName}|${url}`;
    const cached = exitIpCache.get(cacheKey);
    
    if (cached && cached.expiresAt > now) {
        return cached.data;
    }

    const commands = [
        ["wget", "-qO-", "-T", "8", url],
        ["curl", "-s", "-m", "8", url]
    ];

    for (const argv of commands) {
        try {
            const { code, output } = await execReadonly(containerName, argv, timeoutSec);
            if (code !== 0 || !output) continue;

            try {
                const payload = JSON.parse(output);
                if (payload && typeof payload === 'object' && payload.ip) {
                    exitIpCache.set(cacheKey, { data: payload, expiresAt: now + 90000 });
                    return payload;
                }
            } catch (e) {
                const candidate = output.trim();
                if (/^[0-9a-fA-F.:]+$/.test(candidate)) {
                    const result = { ip: candidate };
                    exitIpCache.set(cacheKey, { data: result, expiresAt: now + 90000 });
                    return result;
                }
            }
        } catch (exc) {
            console.debug(`exec ${argv[0]} failed:`, exc);
        }
    }
    return null;
}

async function probeFromContainer(containerName: string, timeoutSec: number): Promise<{ dnsOk: boolean | null, httpsOk: boolean | null }> {
    let dnsOk: boolean | null = null;
    let httpsOk: boolean | null = null;

    try {
        const { code } = await execReadonly(containerName, ["getent", "hosts", "cloudflare.com"], timeoutSec);
        dnsOk = code === 0;
    } catch (e) {
        dnsOk = null;
    }

    try {
        const { code } = await execReadonly(containerName, ["wget", "-q", "--spider", "-T", "6", "https://1.1.1.1"], timeoutSec);
        httpsOk = code === 0;
    } catch (e) {
        httpsOk = null;
    }

    return { dnsOk, httpsOk };
}

async function augmentFromControlServer(status: VpnStatus, controlUrl: string, apiKey: string | null, timeoutSec: number): Promise<void> {
    if (!apiKey) return;
    const headers = { "X-API-Key": apiKey };
    const base = controlUrl.replace(/\/$/, "");

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

        const response = await fetch(`${base}/v1/openvpn/status`, {
            headers,
            redirect: "manual",
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
            const payload = await response.json();
            const state = String(payload?.status || "").toLowerCase();
            if (state) {
                status.tunnelUp = state === "running";
            }
        }
    } catch (exc) {
        console.debug("Gluetun control server unavailable:", exc);
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

        const response = await fetch(`${base}/v1/openvpn/portforwarded`, {
            headers,
            redirect: "manual",
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
            const forwarded = await response.json();
            const port = forwarded?.port;
            if (port) {
                status.endpoint = `${status.endpoint} (forwarded port ${port})`.trim();
            }
        }
    } catch (exc) {
        // Pass
    }
}

async function attachLogAnalysis(status: VpnStatus, containerName: string): Promise<void> {
    let lines: string[];
    try {
        lines = await getContainerLogs(containerName, 120);
    } catch (e) {
        return; // E.g., DockerUnavailable equivalent
    }
    
    if (!lines || lines.length === 0) return;

    const { cause, recommendation, authFailures, reconnects, errors } = analyseLogs(lines);
    status.authFailures = authFailures;
    status.reconnects = reconnects;
    status.recentErrors = errors;

    if (cause) {
        status.error = cause;
        status.recentErrors = [`Recommended: ${recommendation}`, ...errors];
    }
}

export function checkLeak(vpnIp: string | null, wanIp: string | null): LeakCheck {
    if (!vpnIp && !wanIp) {
        return {
            passed: null,
            vpnIp: null,
            wanIp: null,
            detail: "Neither the VPN exit IP nor the home WAN IP could be determined.",
            conclusive: false
        };
    }
    if (!vpnIp) {
        return {
            passed: null,
            vpnIp: null,
            wanIp: wanIp,
            detail: "VPN exit IP unknown — the tunnel may be down. Cannot confirm that download traffic is leaving through the VPN.",
            conclusive: false
        };
    }
    if (!wanIp) {
        return {
            passed: null,
            vpnIp: vpnIp,
            wanIp: null,
            detail: "Home WAN IP unknown, so the comparison cannot be made. Check outbound HTTPS from the host.",
            conclusive: false
        };
    }
    if (vpnIp === wanIp) {
        return {
            passed: false,
            vpnIp: vpnIp,
            wanIp: wanIp,
            detail: "The download stack's public IP matches the home WAN IP. Traffic is not going through the VPN.",
            conclusive: true
        };
    }
    return {
        passed: true,
        vpnIp: vpnIp,
        wanIp: wanIp,
        detail: "Download stack exits on a different public IP from the home WAN.",
        conclusive: true
    };
}
