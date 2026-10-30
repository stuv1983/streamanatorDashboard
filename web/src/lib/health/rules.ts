import { Status, Reading, Alert, DataState } from '../status';
import { Thresholds, getThresholds } from './thresholds';
import { formatDelta, formatPercent, humanBytes, humanDuration } from '../utils/formatting';

export interface Verdict {
    status: Status;
    detail: string;
    threshold?: string;
}

export function unknownVerdict(reason: string): Verdict {
    return { status: Status.UNKNOWN, detail: reason, threshold: "" };
}

// ---------------------------------------------------------------------------
// RAID
// ---------------------------------------------------------------------------

export function classifyRaid(
    active: number | null,
    required: number | null,
    syncAction: string | null = null,
    syncPercent: number | null = null,
    arrayActive: boolean = true
): Verdict {
    if (active === null || required === null) {
        return unknownVerdict("RAID member counts could not be read.");
    }

    if (!arrayActive) {
        return {
            status: Status.CRITICAL,
            detail: "Array is not active. The filesystem is offline.",
            threshold: "array must be active",
        };
    }

    if (active < required) {
        const missing = required - active;
        let detail = `Array is DEGRADED — ${active}/${required} members active, ${missing} missing. RAID5 has no remaining redundancy; a second disk failure would lose the array.`;
        if (syncAction) {
            detail += ` A ${syncAction} is in progress` + (syncPercent !== null ? ` (${syncPercent.toFixed(1)}%)` : "") + ".";
        }
        return { status: Status.CRITICAL, detail, threshold: `${required}/${required} required` };
    }

    if (active > required) {
        return {
            status: Status.INFO,
            detail: `${active} members present for a ${required}-device array (spare or rebuilding member attached).`,
            threshold: `${required} required`,
        };
    }

    if (syncAction && !["idle", "none"].includes(syncAction.toLowerCase())) {
        const progress = syncPercent !== null ? ` at ${syncPercent.toFixed(1)}%` : "";
        return {
            status: Status.WARNING,
            detail: `All ${active}/${required} members present, but a ${syncAction} is running${progress}. Redundancy is restored only when it completes.`,
            threshold: `${required}/${required} required`,
        };
    }

    return {
        status: Status.HEALTHY,
        detail: `All ${active}/${required} members active.`,
        threshold: `${required}/${required} required`,
    };
}

// ---------------------------------------------------------------------------
// Physical disks
// ---------------------------------------------------------------------------

export function classifySmartHealth(passed: boolean | null): Verdict {
    if (passed === null) {
        return unknownVerdict("SMART overall health could not be read.");
    }
    if (!passed) {
        return {
            status: Status.CRITICAL,
            detail: "SMART overall self-assessment has FAILED. The drive predicts its own imminent failure — replace it.",
            threshold: "must report PASSED",
        };
    }
    return { status: Status.HEALTHY, detail: "SMART self-assessment PASSED.", threshold: "PASSED" };
}

export function classifyPendingSectors(count: number | null, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).disk;
    if (count === null) return unknownVerdict("Pending sector count unavailable.");
    if (count > t.pending_sectors_critical) {
        return {
            status: Status.CRITICAL,
            detail: `${Math.floor(count)} sectors are pending reallocation — blocks the drive could not read. Back up now and plan replacement.`,
            threshold: `must be ${t.pending_sectors_critical}`,
        };
    }
    return { status: Status.HEALTHY, detail: "No pending sectors.", threshold: "0" };
}

export function classifyOfflineUncorrectable(count: number | null, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).disk;
    if (count === null) return unknownVerdict("Offline uncorrectable count unavailable.");
    if (count > t.offline_uncorrectable_critical) {
        return {
            status: Status.CRITICAL,
            detail: `${Math.floor(count)} sectors are uncorrectable — data in those blocks is already unreadable.`,
            threshold: `must be ${t.offline_uncorrectable_critical}`,
        };
    }
    return { status: Status.HEALTHY, detail: "No uncorrectable sectors.", threshold: "0" };
}

export function classifyDiskTemperature(celsius: number | null, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).disk;
    if (celsius === null) return unknownVerdict("Disk temperature unavailable.");
    
    const limits = `warn >${t.temp_warning.toFixed(0)} °C, critical >${t.temp_critical.toFixed(0)} °C`;
    
    if (celsius > t.temp_critical) {
        return {
            status: Status.CRITICAL,
            detail: `${celsius.toFixed(0)} °C exceeds the ${t.temp_critical.toFixed(0)} °C limit. Check chassis airflow immediately.`,
            threshold: limits,
        };
    }
    if (celsius > t.temp_warning) {
        return {
            status: Status.WARNING,
            detail: `${celsius.toFixed(0)} °C is above the ${t.temp_warning.toFixed(0)} °C guideline.`,
            threshold: limits,
        };
    }
    if (celsius > t.temp_watch) {
        return {
            status: Status.INFO,
            detail: `${celsius.toFixed(0)} °C — warm but within tolerance.`,
            threshold: limits,
        };
    }
    return { status: Status.HEALTHY, detail: `${celsius.toFixed(0)} °C.`, threshold: limits };
}

export function classifyCrcDelta(
    current: number | null,
    delta24h: number | null,
    delta7d: number | null = null,
    delta1h: number | null = null,
    thresholds?: Thresholds
): Verdict {
    const t = (thresholds || getThresholds()).disk;
    if (current === null) return unknownVerdict("CRC error count unavailable.");

    const knownDeltas = [delta1h, delta24h, delta7d].filter((d): d is number => d !== null);
    if (knownDeltas.length === 0) {
        return {
            status: Status.UNKNOWN,
            detail: `Count is ${current.toLocaleString()}, but no historical sample exists yet to compare against. The trend — not the total — is what matters here.`,
            threshold: `delta must stay below +${t.crc_delta_warning}`,
        };
    }

    const worstDelta = Math.max(...knownDeltas);
    const limits = `warn ≥ +${t.crc_delta_warning}, critical ≥ +${t.crc_delta_critical}`;

    if (worstDelta >= t.crc_delta_critical) {
        return {
            status: Status.CRITICAL,
            detail: `CRC errors are climbing fast (+${worstDelta.toLocaleString()}). The SATA data path is actively failing. Total is now ${current.toLocaleString()}.`,
            threshold: limits,
        };
    }
    if (worstDelta >= t.crc_delta_warning) {
        return {
            status: Status.WARNING,
            detail: `CRC error count is INCREASING (${formatDelta(worstDelta)}). Total is ${current.toLocaleString()}. This points at the SATA cable, connector, backplane or controller port — not the disk media.`,
            threshold: limits,
        };
    }
    
    let detail = `STABLE — count is ${current.toLocaleString()} and has not increased (${formatDelta(delta24h, '')} over 24h`;
    if (delta7d !== null) {
        detail += `, ${formatDelta(delta7d, '')} over 7d`;
    }
    detail += "). A high but static count reflects a past fault, not a current one.";
    
    return { status: Status.HEALTHY, detail, threshold: limits };
}

export function classifyReallocatedDelta(
    current: number | null,
    delta: number | null,
    thresholds?: Thresholds
): Verdict {
    const t = (thresholds || getThresholds()).disk;
    if (current === null) return unknownVerdict("Reallocated sector count unavailable.");
    
    if (delta === null) {
        if (current > 0) {
            return {
                status: Status.INFO,
                detail: `${current.toLocaleString()} reallocated sectors recorded; no history yet to tell whether the count is still growing.`,
                threshold: "",
            };
        }
        return { status: Status.HEALTHY, detail: "No reallocated sectors.", threshold: "" };
    }
    
    if (delta >= t.reallocated_delta_warning) {
        return {
            status: Status.WARNING,
            detail: `Reallocated sectors increased by ${formatDelta(delta)} to ${current.toLocaleString()}. The drive is actively retiring bad blocks.`,
            threshold: `delta must stay below +${t.reallocated_delta_warning}`,
        };
    }
    if (current > 0) {
        return {
            status: Status.INFO,
            detail: `${current.toLocaleString()} reallocated sectors, stable (${formatDelta(delta)}).`,
            threshold: "",
        };
    }
    return { status: Status.HEALTHY, detail: "No reallocated sectors.", threshold: "" };
}

// ---------------------------------------------------------------------------
// Filesystems
// ---------------------------------------------------------------------------

export function classifyFilesystem(
    usedPercent: number | null,
    freeBytes: number | null = null,
    thresholds?: Thresholds
): Verdict {
    const t = (thresholds || getThresholds()).storage;
    if (usedPercent === null) return unknownVerdict("Filesystem usage could not be read.");

    const limits = `warn ≥${t.warning_percent.toFixed(0)}%, high ≥${t.high_percent.toFixed(0)}%, critical ≥${t.critical_percent.toFixed(0)}%`;
    const freeText = freeBytes !== null ? ` ${humanBytes(freeBytes)} free.` : "";

    if (usedPercent >= t.critical_percent) {
        return {
            status: Status.CRITICAL,
            detail: `${formatPercent(usedPercent)} used.${freeText} Writes will start failing shortly.`,
            threshold: limits,
        };
    }
    if (usedPercent >= t.high_percent) {
        return {
            status: Status.WARNING,
            detail: `${formatPercent(usedPercent)} used.${freeText} Free space is getting short.`,
            threshold: limits,
        };
    }
    if (usedPercent >= t.warning_percent) {
        return {
            status: Status.WARNING,
            detail: `${formatPercent(usedPercent)} used.${freeText}`,
            threshold: limits,
        };
    }
    return { status: Status.HEALTHY, detail: `${formatPercent(usedPercent)} used.${freeText}`, threshold: limits };
}

export function classifyInodes(inodeUsedPercent: number | null, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).storage;
    if (inodeUsedPercent === null) return unknownVerdict("Inode usage unavailable.");
    if (inodeUsedPercent >= t.inode_warning_percent) {
        return {
            status: Status.WARNING,
            detail: `${formatPercent(inodeUsedPercent)} of inodes used — the filesystem can run out of inodes before it runs out of space.`,
            threshold: `warn ≥${t.inode_warning_percent.toFixed(0)}%`,
        };
    }
    return { status: Status.HEALTHY, detail: `${formatPercent(inodeUsedPercent)} of inodes used.`, threshold: "" };
}

export function classifyForecast(forecast: any, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).storage;
    if (!forecast || !forecast.available) {
        const reason = forecast?.reason || "No forecast available.";
        return { status: Status.INFO, detail: `Forecast unavailable — ${reason}`, threshold: "" };
    }

    const days = forecast.daysUntil90 ?? forecast.days_until_90;
    const growth = forecast.growthBytesPerDay ?? forecast.growth_bytes_per_day;

    if (days === null || days === undefined) {
        if (forecast.shrinking) {
            return { status: Status.HEALTHY, detail: "Usage is falling; no fill date projected.", threshold: "" };
        }
        return { status: Status.HEALTHY, detail: "No 90% crossing projected within the planning horizon.", threshold: "" };
    }

    if (days <= t.forecast_critical_days) {
        return {
            status: Status.CRITICAL,
            detail: `Projected to reach 90% in ${days.toFixed(0)} days at the current growth rate (${humanBytes(growth)}/day).`,
            threshold: `critical ≤${t.forecast_critical_days.toFixed(0)} days`,
        };
    }
    if (days <= t.forecast_warning_days) {
        return {
            status: Status.WARNING,
            detail: `Projected to reach 90% in ${days.toFixed(0)} days (${humanBytes(growth)}/day).`,
            threshold: `warn ≤${t.forecast_warning_days.toFixed(0)} days`,
        };
    }
    return {
        status: Status.HEALTHY,
        detail: `90% is about ${days.toFixed(0)} days away at ${humanBytes(growth)}/day.`,
        threshold: "",
    };
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export function classifyCpu(percent: number | null, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).host;
    if (percent === null) return unknownVerdict("CPU utilisation not yet sampled.");
    
    const limits = `warn >${t.cpu_warning_percent.toFixed(0)}%, critical >${t.cpu_critical_percent.toFixed(0)}%`;
    if (percent > t.cpu_critical_percent) {
        return { status: Status.CRITICAL, detail: `CPU at ${formatPercent(percent)}.`, threshold: limits };
    }
    if (percent > t.cpu_warning_percent) {
        return { status: Status.WARNING, detail: `CPU at ${formatPercent(percent)}.`, threshold: limits };
    }
    return { status: Status.HEALTHY, detail: `CPU at ${formatPercent(percent)}.`, threshold: limits };
}

export function classifyMemoryAvailable(availablePercent: number | null, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).host;
    if (availablePercent === null) return unknownVerdict("Memory availability unavailable.");
    
    const limits = `warn <${t.memory_available_warning_percent.toFixed(0)}%, critical <${t.memory_available_critical_percent.toFixed(0)}% available`;
    if (availablePercent < t.memory_available_critical_percent) {
        return { status: Status.CRITICAL, detail: `Only ${formatPercent(availablePercent)} of RAM is available.`, threshold: limits };
    }
    if (availablePercent < t.memory_available_warning_percent) {
        return { status: Status.WARNING, detail: `${formatPercent(availablePercent)} of RAM available.`, threshold: limits };
    }
    return { status: Status.HEALTHY, detail: `${formatPercent(availablePercent)} of RAM available.`, threshold: limits };
}

export function classifySwap(percent: number | null, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).host;
    if (percent === null) return unknownVerdict("Swap usage unavailable.");
    
    const limits = `warn >${t.swap_warning_percent.toFixed(0)}%`;
    if (percent > t.swap_critical_percent) {
        return { status: Status.CRITICAL, detail: `Swap ${formatPercent(percent)} used.`, threshold: limits };
    }
    if (percent > t.swap_warning_percent) {
        return { status: Status.WARNING, detail: `Swap ${formatPercent(percent)} used.`, threshold: limits };
    }
    return { status: Status.HEALTHY, detail: `Swap ${formatPercent(percent)} used.`, threshold: limits };
}

export function classifyIowait(percent: number | null, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).host;
    if (percent === null) return unknownVerdict("iowait not yet sampled.");
    
    const limits = `warn >${t.iowait_warning_percent.toFixed(0)}%`;
    if (percent > t.iowait_critical_percent) {
        return {
            status: Status.CRITICAL,
            detail: `iowait at ${formatPercent(percent)} — the CPU is mostly waiting on storage.`,
            threshold: limits,
        };
    }
    if (percent > t.iowait_warning_percent) {
        return {
            status: Status.WARNING,
            detail: `iowait at ${formatPercent(percent)} — storage may be a bottleneck.`,
            threshold: limits,
        };
    }
    return { status: Status.HEALTHY, detail: `iowait at ${formatPercent(percent)}.`, threshold: limits };
}

export function classifyLoad(load1: number | null, cpuCores: number, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).host;
    if (load1 === null || cpuCores <= 0) return unknownVerdict("Load average unavailable.");
    
    const ratio = load1 / cpuCores;
    const limits = `warn >${t.load_warning_ratio.toFixed(1)}× cores (${cpuCores})`;
    
    if (ratio > t.load_critical_ratio) {
        return {
            status: Status.CRITICAL,
            detail: `Load ${load1.toFixed(2)} is ${ratio.toFixed(1)}× the ${cpuCores} available cores.`,
            threshold: limits,
        };
    }
    if (ratio > t.load_warning_ratio) {
        return {
            status: Status.WARNING,
            detail: `Load ${load1.toFixed(2)} exceeds the ${cpuCores} available cores.`,
            threshold: limits,
        };
    }
    return { status: Status.HEALTHY, detail: `Load ${load1.toFixed(2)} across ${cpuCores} cores.`, threshold: limits };
}

export function classifyFailedUnits(units: any[] | null): Verdict {
    if (units === null) return unknownVerdict("systemd state could not be queried.");
    if (units.length === 0) return { status: Status.HEALTHY, detail: "No failed systemd units.", threshold: "" };

    const names = units.slice(0, 5).map(u => u.name || String(u)).join(", ");
    const suffix = units.length <= 5 ? "" : ` (+${units.length - 5} more)`;
    
    return {
        status: Status.WARNING,
        detail: `${units.length} failed unit(s): ${names}${suffix}.`,
        threshold: "0 failed units",
    };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export function classifyInternet(
    reachable: boolean | null,
    latencyMs: number | null,
    packetLossPercent: number | null,
    downSince: number | null = null,
    thresholds?: Thresholds
): Verdict {
    const t = (thresholds || getThresholds()).network;
    if (reachable === null) return unknownVerdict("Internet reachability could not be tested.");

    if (!reachable) {
        if (downSince !== null) {
            const outage = (Date.now() / 1000) - downSince;
            if (outage < t.internet_down_seconds) {
                return {
                    status: Status.WARNING,
                    detail: `No response for ${humanDuration(outage)} — below the ${t.internet_down_seconds}s threshold for a critical alert.`,
                    threshold: `critical after ${t.internet_down_seconds}s`,
                };
            }
            return {
                status: Status.CRITICAL,
                detail: `Internet unreachable for ${humanDuration(outage)}.`,
                threshold: `critical after ${t.internet_down_seconds}s`,
            };
        }
        return { status: Status.CRITICAL, detail: "Internet is unreachable.", threshold: "must respond" };
    }

    if (packetLossPercent !== null) {
        if (packetLossPercent >= t.packet_loss_critical_percent) {
            return {
                status: Status.CRITICAL,
                detail: `${formatPercent(packetLossPercent)} packet loss.`,
                threshold: `critical ≥${t.packet_loss_critical_percent.toFixed(0)}%`,
            };
        }
        if (packetLossPercent >= t.packet_loss_warning_percent) {
            return {
                status: Status.WARNING,
                detail: `${formatPercent(packetLossPercent)} packet loss.`,
                threshold: `warn ≥${t.packet_loss_warning_percent.toFixed(0)}%`,
            };
        }
    }

    if (latencyMs !== null) {
        if (latencyMs >= t.latency_critical_ms) {
            return {
                status: Status.CRITICAL,
                detail: `Latency ${latencyMs.toFixed(0)} ms.`,
                threshold: `critical ≥${t.latency_critical_ms.toFixed(0)} ms`,
            };
        }
        if (latencyMs >= t.latency_warning_ms) {
            return {
                status: Status.WARNING,
                detail: `Latency ${latencyMs.toFixed(0)} ms.`,
                threshold: `warn ≥${t.latency_warning_ms.toFixed(0)} ms`,
            };
        }
    }

    const latencyText = latencyMs !== null ? `${latencyMs.toFixed(0)} ms` : "reachable";
    const lossText = packetLossPercent !== null ? `, ${formatPercent(packetLossPercent)} loss` : "";
    return { status: Status.HEALTHY, detail: `Internet up — ${latencyText}${lossText}.`, threshold: "" };
}

// ---------------------------------------------------------------------------
// VPN
// ---------------------------------------------------------------------------

export function classifyVpn(status: any): Verdict {
    if (status === null || status === undefined) return unknownVerdict("VPN state could not be determined.");

    const containerPresent = status.containerPresent ?? status.container_present;
    const containerRunning = status.containerRunning ?? status.container_running;
    const containerHealthy = status.containerHealthy ?? status.container_healthy;
    const tunnelUp = status.tunnelUp ?? status.tunnel_up;
    const dnsOk = status.dnsOk ?? status.dns_ok;
    const httpsOk = status.httpsOk ?? status.https_ok;
    const authFailures = status.authFailures ?? status.auth_failures;
    const publicIp = status.publicIp ?? status.public_ip;

    if (!containerPresent) {
        return {
            status: Status.CRITICAL,
            detail: "Gluetun container is missing. The entire download and indexer stack depends on its network namespace.",
            threshold: "container must exist",
        };
    }
    if (!containerRunning) {
        return {
            status: Status.CRITICAL,
            detail: `Gluetun is not running (${status.error || 'stopped'}). Every container sharing its namespace has lost connectivity.`,
            threshold: "container must be running",
        };
    }

    const problems: string[] = [];
    if (containerHealthy === false) problems.push("Docker healthcheck failing");
    if (tunnelUp === false) problems.push("tunnel down");
    if (dnsOk === false) problems.push("DNS resolution failing");
    if (httpsOk === false) problems.push("outbound HTTPS failing");

    if (problems.length > 0) {
        let detail = "VPN unhealthy: " + problems.join(", ") + ".";
        if (status.error) detail += ` Likely cause: ${status.error}.`;
        if (authFailures) detail += ` ${authFailures} AUTH_FAILED entries in recent logs.`;
        return { status: Status.CRITICAL, detail, threshold: "tunnel up, DNS and HTTPS working" };
    }

    if (containerHealthy === null && tunnelUp === null) {
        return unknownVerdict("Gluetun is running but its tunnel state is unknown.");
    }

    const location = status.location ? ` (${status.location})` : "";
    return {
        status: Status.HEALTHY,
        detail: `${status.provider || 'VPN'} connected via ${publicIp}${location}.`,
        threshold: "",
    };
}

export function classifyLeak(leak: any): Verdict {
    if (leak === null || leak === undefined) return unknownVerdict("Leak check not performed.");
    if (leak.passed === null) {
        return { status: Status.UNKNOWN, detail: leak.detail, threshold: "VPN IP must differ from WAN IP" };
    }
    
    const vpnIp = leak.vpnIp ?? leak.vpn_ip;
    const wanIp = leak.wanIp ?? leak.wan_ip;
    
    if (!leak.passed) {
        return {
            status: Status.CRITICAL,
            detail: `POSSIBLE VPN LEAK — the download stack's public IP (${vpnIp}) matches the home WAN IP. Traffic is bypassing the tunnel.`,
            threshold: "VPN IP must differ from WAN IP",
        };
    }
    return {
        status: Status.HEALTHY,
        detail: `PASS — download stack exits on ${vpnIp}, home WAN is ${wanIp}.`,
        threshold: "VPN IP must differ from WAN IP",
    };
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function classifyContainer(
    container: any,
    expectedCritical: boolean = true,
    restartDelta: number | null = null,
    thresholds?: Thresholds
): Verdict {
    const t = (thresholds || getThresholds()).container;
    
    if (container === null || container === undefined) {
        const severity = expectedCritical ? Status.CRITICAL : Status.WARNING;
        return { status: severity, detail: "Expected container is missing entirely.", threshold: "container must exist" };
    }

    if (!container.running) {
        const severity = expectedCritical ? Status.CRITICAL : Status.WARNING;
        return { status: severity, detail: `Container is ${container.state}.`, threshold: "must be running" };
    }

    if (restartDelta !== null && restartDelta >= t.restart_delta_critical) {
        return {
            status: Status.CRITICAL,
            detail: `Container has restarted ${restartDelta} times recently — this is a crash loop.`,
            threshold: `critical ≥${t.restart_delta_critical} restarts`,
        };
    }
    if (restartDelta !== null && restartDelta >= t.restart_delta_warning) {
        return {
            status: Status.WARNING,
            detail: `Container restarted ${restartDelta} time(s) recently.`,
            threshold: `warn ≥${t.restart_delta_warning} restarts`,
        };
    }

    if (container.healthy === false) {
        return {
            status: Status.CRITICAL,
            detail: `Docker healthcheck reports '${container.health}'.`,
            threshold: "healthcheck must pass",
        };
    }

    const uptime = container.uptimeSeconds ?? container.uptime_seconds;
    if (uptime !== null && uptime !== undefined && uptime < t.recent_start_seconds) {
        return {
            status: Status.INFO,
            detail: `Running, but started only ${humanDuration(uptime)} ago.`,
            threshold: "",
        };
    }

    const healthText = container.healthy ? " and healthy" : "";
    return {
        status: Status.HEALTHY,
        detail: uptime ? `Running${healthText} for ${humanDuration(uptime)}.` : `Running${healthText}.`,
        threshold: "",
    };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

export function classifyProbe(result: any, critical: boolean = false, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).probe;
    if (result === null || result === undefined) return unknownVerdict("Service was not probed.");

    if (!result.success) {
        const severity = critical ? Status.CRITICAL : Status.WARNING;
        const failedStage = result.failedStage ?? result.failed_stage;
        
        const stageMap: Record<string, string> = {
            "dns": "DNS resolution failed",
            "tcp": "TCP connection refused or timed out",
            "http": "HTTP request failed",
            "status": "unexpected HTTP status",
            "config": "no URL configured",
        };
        const stage = stageMap[failedStage] || "probe failed";
        
        if (failedStage === "config") {
            return { status: Status.UNKNOWN, detail: "No URL configured for this service.", threshold: "" };
        }
        return {
            status: severity,
            detail: `${stage}: ${result.error}`,
            threshold: "must return an expected status",
        };
    }

    const latency = result.latencyMs ?? result.latency_ms;
    if (latency !== null && latency !== undefined && latency >= t.latency_critical_ms) {
        return {
            status: Status.WARNING,
            detail: `Responding, but very slowly (${Math.floor(latency)} ms).`,
            threshold: `warn ≥${t.latency_warning_ms.toFixed(0)} ms`,
        };
    }
    if (latency !== null && latency !== undefined && latency >= t.latency_warning_ms) {
        return {
            status: Status.WARNING,
            detail: `Responding slowly (${Math.floor(latency)} ms).`,
            threshold: `warn ≥${t.latency_warning_ms.toFixed(0)} ms`,
        };
    }

    const statusCode = result.statusCode ?? result.status_code;
    return {
        status: Status.HEALTHY,
        detail: latency !== null && latency !== undefined 
            ? `HTTP ${statusCode} in ${Math.floor(latency)} ms.` 
            : `HTTP ${statusCode}.`,
        threshold: "",
    };
}

export function classifyTlsExpiry(daysRemaining: number | null, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).probe;
    if (daysRemaining === null) return unknownVerdict("No TLS certificate observed.");
    
    if (daysRemaining < 0) {
        return { status: Status.CRITICAL, detail: "Certificate has expired.", threshold: "must not be expired" };
    }
    if (daysRemaining <= t.tls_expiry_critical_days) {
        return {
            status: Status.CRITICAL,
            detail: `Certificate expires in ${daysRemaining.toFixed(0)} days.`,
            threshold: `critical ≤${t.tls_expiry_critical_days.toFixed(0)} days`,
        };
    }
    if (daysRemaining <= t.tls_expiry_high_days) {
        return {
            status: Status.WARNING,
            detail: `Certificate expires in ${daysRemaining.toFixed(0)} days.`,
            threshold: `high ≤${t.tls_expiry_high_days.toFixed(0)} days`,
        };
    }
    if (daysRemaining <= t.tls_expiry_warning_days) {
        return {
            status: Status.WARNING,
            detail: `Certificate expires in ${daysRemaining.toFixed(0)} days.`,
            threshold: `warn ≤${t.tls_expiry_warning_days.toFixed(0)} days`,
        };
    }
    return { status: Status.HEALTHY, detail: `Certificate valid for ${daysRemaining.toFixed(0)} days.`, threshold: "" };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export function classifyBackupAge(
    ageDays: number | null,
    expectedIntervalDays: number = 1.0,
    thresholds?: Thresholds
): Verdict {
    const t = (thresholds || getThresholds()).backup;
    if (ageDays === null) {
        return {
            status: Status.CRITICAL,
            detail: "No backup found at all. This job has never produced output, or the destination is unreadable.",
            threshold: `expected every ${expectedIntervalDays.toFixed(1)} days`,
        };
    }
    const limits = `warn >${t.warning_days.toFixed(0)} days, critical >${t.critical_days.toFixed(0)} days (expected every ${expectedIntervalDays.toFixed(1)})`;

    if (ageDays > t.critical_days) {
        return { status: Status.CRITICAL, detail: `Last backup is ${ageDays.toFixed(1)} days old.`, threshold: limits };
    }
    if (ageDays > t.warning_days) {
        return {
            status: Status.WARNING,
            detail: `Last backup is ${ageDays.toFixed(1)} days old — a scheduled run appears to have been missed.`,
            threshold: limits,
        };
    }
    if (ageDays > expectedIntervalDays * 1.5) {
        return {
            status: Status.WARNING,
            detail: `Last backup is ${ageDays.toFixed(1)} days old, but this job is expected every ${expectedIntervalDays.toFixed(1)} days.`,
            threshold: limits,
        };
    }
    return { status: Status.HEALTHY, detail: `Last backup is ${ageDays.toFixed(1)} days old.`, threshold: limits };
}

export function classifyMissedRun(missedAt: number | null, schedule: string, ageDays: number | null): Verdict {
    if (missedAt === null) return { status: Status.HEALTHY, detail: "All scheduled runs have produced output.", threshold: "" };

    const date = new Date(missedAt * 1000);
    // Simple custom formatting mimicking the python strftime("%a %d %b %H:%M")
    const when = date.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    
    const ageText = ageDays !== null ? ` The most recent backup is ${ageDays.toFixed(1)} days old.` : " No backup exists at all.";
    
    return {
        status: Status.WARNING,
        detail: `A scheduled run was missed: nothing was written for the ${when} run (${schedule}).${ageText}`,
        threshold: "expected output after every scheduled run",
    };
}

export function classifyBackupIntegrity(ok: boolean | null, detail: string = ""): Verdict {
    if (ok === null) {
        return {
            status: Status.UNKNOWN,
            detail: `Integrity has not been verified. Existence is not proof of restorability.${detail ? ` ${detail}` : ""}`,
            threshold: "must verify as ok",
        };
    }
    if (!ok) {
        return { status: Status.CRITICAL, detail: `Integrity check FAILED: ${detail}`, threshold: "must verify as ok" };
    }
    return { status: Status.HEALTHY, detail: `Integrity verified: ${detail || 'ok'}.`, threshold: "" };
}

export function classifyBackupSize(status: any, thresholds?: Thresholds): Verdict {
    const t = (thresholds || getThresholds()).backup;
    if (!status || !status.latest) return unknownVerdict("No backup to size-check.");

    const sizeKnown = status.latest.sizeKnown ?? status.latest.size_known;
    const sizeBytes = status.latest.sizeBytes ?? status.latest.size_bytes;

    if (!sizeKnown) {
        return {
            status: Status.INFO,
            detail: "Size not measured — this job writes a directory tree per run, and walking it is too slow for a page render. Measure it on demand from the Backups page.",
            threshold: "",
        };
    }

    const sizeSuspicious = status.sizeSuspicious ?? status.size_suspicious;
    const minPlausibleBytes = status.minPlausibleBytes ?? status.min_plausible_bytes;

    if (sizeSuspicious) {
        return {
            status: Status.WARNING,
            detail: `Latest backup is only ${humanBytes(sizeBytes)}, well below the ${humanBytes(minPlausibleBytes)} expected — the run may have been truncated.`,
            threshold: `≥${humanBytes(minPlausibleBytes)}`,
        };
    }

    const growthBytes = status.growthBytes ?? status.growth_bytes;
    if (growthBytes !== null && growthBytes !== undefined && status.previous) {
        const prevSizeBytes = status.previous.sizeBytes ?? status.previous.size_bytes;
        if (prevSizeBytes > 0) {
            const shrinkPercent = -100.0 * growthBytes / prevSizeBytes;
            if (shrinkPercent > t.shrink_warning_percent) {
                return {
                    status: Status.WARNING,
                    detail: `Latest backup is ${shrinkPercent.toFixed(0)}% smaller than the previous one (${humanBytes(sizeBytes)} vs ${humanBytes(prevSizeBytes)}).`,
                    threshold: `warn on >${t.shrink_warning_percent.toFixed(0)}% shrink`,
                };
            }
        }
    }
    return { status: Status.HEALTHY, detail: `Latest backup is ${humanBytes(sizeBytes)}.`, threshold: "" };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export function classifyFreshness(ageSeconds: number | null, budgetSeconds: number): Verdict {
    if (ageSeconds === null) return unknownVerdict("No collection timestamp available.");
    if (ageSeconds > budgetSeconds) {
        return {
            status: Status.UNKNOWN,
            detail: `DATA STALE — last updated ${humanDuration(ageSeconds)} ago, budget is ${humanDuration(budgetSeconds)}.`,
            threshold: `≤${humanDuration(budgetSeconds)}`,
        };
    }
    return {
        status: Status.HEALTHY,
        detail: `CURRENT — updated ${humanDuration(ageSeconds)} ago.`,
        threshold: `≤${humanDuration(budgetSeconds)}`,
    };
}

// ---------------------------------------------------------------------------
// Alert construction
// ---------------------------------------------------------------------------

export function alertFromVerdict(
    key: string,
    verdict: Verdict,
    component: string,
    title: string,
    currentValue: string = "",
    probableCause: string = "",
    recommendedAction: string = "",
    since: number | null = null
): Alert | null {
    if (verdict.status === Status.HEALTHY || verdict.status === Status.INFO) {
        return null;
    }
    return new Alert({
        key,
        status: verdict.status,
        title,
        component,
        detail: verdict.detail,
        current_value: currentValue,
        threshold: verdict.threshold || "",
        probable_cause: probableCause,
        recommended_action: recommendedAction,
        since,
    });
}

export function readingFromVerdict(
    key: string,
    label: string,
    value: any,
    verdict: Verdict,
    unit: string = "",
    source: string = "",
    extra: Record<string, any> = {}
): Reading {
    return new Reading({
        key,
        label,
        value,
        unit,
        status: verdict.status,
        state: DataState.OK,
        detail: verdict.detail,
        threshold: verdict.threshold || "",
        source,
        extra,
    });
}
