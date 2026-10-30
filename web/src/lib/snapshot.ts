import { Status, Reading, Alert, ComponentHealth, ChangeEvent } from './status';
import { getThresholds, Thresholds, COMPONENT_WEIGHTS } from './health/thresholds';
import { getRank } from './status';
import { HealthScore, scoreComponent, calculateHealthScore } from './health/scoring';
import { correlate, Incident, probableCauseForDiskCrc } from './health/correlation';
import * as rules from './health/rules';
import { linearFit, CapacityForecast, forecastCapacity } from './health/forecast';
import * as backupService from './backups';
import * as dockerService from './docker_service';
import * as network from './network';
import * as probes from './probes';
import * as smart from './smart';
import * as sportsdb from './sportsdb';
import * as system from './system';
import * as unifi from './unifi';
import * as vpn from './vpn';
import { humanBytes, humanDuration } from './utils/formatting';
import { Settings } from './config';
import { HistoryStore } from './history';

export interface Snapshot {
    health: HealthScore;
    components: Record<string, ComponentHealth>;
    alerts: Alert[];
    incidents: Incident[];
    changes: ChangeEvent[];
    raw: Record<string, any>;
    collected_at: number;
    duration_seconds: number;
    sources: Record<string, string>;
}

// M_ keys from collector.py
export const M_FS_USED = "fs.used_bytes";
export const M_SMART_CRC = "smart.udma_crc";
export const M_SMART_REALLOC = "smart.reallocated";
export const M_SMART_PENDING = "smart.pending";
export const M_SMART_TEMP = "smart.temperature";
export const M_CONTAINER_RESTARTS = "container.restarts";
export const M_CPU = "host.cpu_percent";
export const M_IOWAIT = "host.iowait_percent";
export const M_MEM_AVAIL = "host.mem_available_percent";
export const M_LATENCY = "net.latency_ms";
export const M_LOSS = "net.packet_loss_percent";
export const M_DB_SIZE = "sportsdb.size_bytes";

// Safe wrapper? In TS we can just use try-catch inside async functions.
export async function _safe<T>(func: () => Promise<T>, key: string, label: string, source: string): Promise<[T | null, Reading<any> | null]> {
    try {
        const res = await func();
        return [res, null];
    } catch (exc: any) {
        console.warn(`Collector ${key} failed: ${exc}`);
        return [null, Reading.error(key, label, `${exc.name || 'Error'}: ${exc.message || exc}`, source)];
    }
}

export class SourceRouter {
    settings: Settings;
    prometheus: any;
    private _features: Record<string, boolean> | null = null;

    constructor(settings: Settings, prometheusClient: any = null) {
        this.settings = settings;
        this.prometheus = prometheusClient;
    }

    get prometheusAvailable(): boolean {
        return !!(this.prometheus && this.prometheus.available());
    }

    async features(): Promise<Record<string, boolean>> {
        if (this._features === null) {
            if (this.prometheusAvailable) {
                try {
                    this._features = await this.prometheus.features();
                } catch (error) {
                    console.warn("Prometheus feature discovery failed; using bounded local collectors", error);
                    this._features = {};
                }
            } else {
                this._features = {
                    "node_exporter": false,
                    "cadvisor": false,
                    "smartctl_exporter": false,
                    "blackbox_exporter": false,
                    "unifi_exporter": false,
                };
            }
        }
        return this._features ?? {};
    }

    async sourceFor(area: string): Promise<string> {
        if (area === "unifi" && this.settings.unifi.configured) return "unifi:integration-api";
        const mapping: Record<string, [string, string]> = {
            "host": ["", "local:/proc"],
            "storage": ["", "local:statvfs"],
            "raid": ["", "local:/proc/mdstat"],
            "smart": ["smartctl_exporter", "local:smartctl"],
            "containers": ["", "local:docker"],
            "probes": ["", "direct probe"],
            "unifi": ["unifi_exporter", "not configured"],
        };
        const familyAndFallback = mapping[area] || ["", "local"];
        const family = familyAndFallback[0];
        const fallback = familyAndFallback[1];
        
        const f = await this.features();
        if (family && f[family]) {
            return `prometheus:${family}`;
        }
        return fallback;
    }
}

export async function collectRaidAndDisks(settings: Settings, history: HistoryStore, router: SourceRouter, thresholds: Thresholds): Promise<[ComponentHealth, Record<string, any>]> {
    const readings: Reading<any>[] = [];
    const alerts: Alert[] = [];
    const raw: Record<string, any> = {};

    // --- Array -----------------------------------------------------------
    const [arrays, errorReading] = await _safe(
        () => system.getMdArrays(settings.local.proc_mdstat),
        "raid.read",
        "RAID state",
        "local:/proc/mdstat"
    );
    raw.arrays = arrays || [];

    if (errorReading) {
        readings.push(errorReading);
    } else if (arrays === null) {
        readings.push(
            Reading.no_data(
                "raid.md127",
                "RAID array",
                "/proc/mdstat is not readable on this system.",
                "local:/proc/mdstat"
            )
        );
    } else {
        let target = arrays.find((a: any) => a.device === settings.raid.device);
        if (!target && arrays.length > 0) {
            target = arrays[0];
        }

        if (!target) {
            const verdict: rules.Verdict = {
                status: Status.CRITICAL,
                detail: `Array ${settings.raid.device} is not present in /proc/mdstat.`,
                threshold: "array must exist"
            };
            readings.push(
                rules.readingFromVerdict(
                    `raid.${settings.raid.device}`, "RAID array", null, verdict, "", "local:/proc/mdstat"
                )
            );
            const alert = rules.alertFromVerdict(
                `raid.${settings.raid.device}`,
                verdict,
                "RAID",
                "RAID array missing",
                "", "", "Check `cat /proc/mdstat` and `mdadm --detail`."
            );
            if (alert) alerts.push(alert);
        } else {
            const verdict = rules.classifyRaid(
                target.disksActive,
                target.disksRequired || settings.raid.required_members,
                target.syncAction,
                target.syncPercent,
                target.active
            );
            readings.push(
                rules.readingFromVerdict(
                    `raid.${target.device}`,
                    `RAID ${target.device}`,
                    `${target.disksActive}/${target.disksRequired}`,
                    verdict,
                    "",
                    "local:/proc/mdstat",
                    {
                        "state_string": target.stateString,
                        "level": target.level,
                        "members": target.members,
                        "sync_action": target.syncAction,
                        "sync_percent": target.syncPercent,
                        "sync_speed_kbps": target.syncSpeedKbps,
                        "sync_finish_minutes": target.syncFinishMinutes,
                    }
                )
            );
            const alert = rules.alertFromVerdict(
                `raid.${target.device}`,
                verdict,
                "RAID",
                target.degraded ? "RAID array degraded" : `RAID ${target.device} needs attention`,
                `${target.disksActive}/${target.disksRequired} [${target.stateString}]`,
                target.degraded ? "A member has dropped out of the array. On this host that has previously been a SATA path fault rather than a failed disk." : "",
                target.degraded ? "Identify the missing member by serial (`lsblk -o NAME,SERIAL`), check dmesg for ATA errors, then re-add with `mdadm --re-add`. Do not replace a disk on device-name evidence alone." : ""
            );
            if (alert) alerts.push(alert);
        }
    }

    // --- SMART -----------------------------------------------------------
    let smartDisks: Record<string, smart.SmartDisk> = {};
    const smartSource = await router.sourceFor("smart");
    let smartError = "";

    const f = await router.features();
    if (f["smartctl_exporter"]) {
        smartDisks = await smart.collectSmartFromPrometheus(router.prometheus);
    } else if (settings.local.enabled) {
        try {
            smartDisks = await smart.collectSmartLocal(
                settings.local.smartctl_path,
                settings.local.smartctl_via_sudo
            );
        } catch (exc: any) {
            if (exc instanceof smart.SmartUnavailable) {
                smartError = `${exc.message} — ${exc.hint}`;
            } else {
                smartError = `${exc.name || 'Error'}: ${exc.message || exc}`;
            }
        }
    }

    raw.smart = smartDisks;
    raw.smart_error = smartError;

    if (Object.keys(smartDisks).length === 0) {
        readings.push(
            Reading.not_configured(
                "disk.smart",
                "Physical disk SMART health",
                smartError || (
                    "No SMART source available. Deploy smartctl_exporter, or grant " +
                    "the dashboard read-only smartctl access (deploy/sudoers-smartctl)."
                ),
                smartSource
            )
        );
    } else {
        for (const diskConfig of settings.disks) {
            const disk = smartDisks[diskConfig.serial];
            if (!disk) continue;
            readings.push(..._diskReadings(disk, diskConfig, history, thresholds, smartSource, alerts));
        }
    }

    const component = scoreComponent(
        "raid_disks",
        "RAID & disks",
        readings,
        alerts,
        null,
        "Array redundancy and physical disk health"
    );
    return [component, raw];
}

function _diskReadings(disk: smart.SmartDisk, diskConfig: any, history: HistoryStore, thresholds: Thresholds, source: string, alerts: Alert[]): Reading<any>[] {
    const labels = { "serial": disk.serial };
    const readings: Reading<any>[] = [];

    // SMART overall
    let verdict = rules.classifySmartHealth(disk.passed);
    readings.push(
        rules.readingFromVerdict(
            `disk.${disk.serial}.smart`,
            `${disk.serial} SMART health`,
            disk.passed === true ? "PASSED" : (disk.passed === false ? "FAILED" : null),
            verdict,
            "",
            source
        )
    );
    let alert = rules.alertFromVerdict(
        `disk.${disk.serial}.smart`,
        verdict,
        `Disk ${disk.serial}`,
        "SMART self-assessment failed",
        "FAILED", "", "Replace the drive. Verify backups before doing so."
    );
    if (alert) alerts.push(alert);

    // Pending / uncorrectable sectors
    const checks = [
        [disk.currentPendingSectors, rules.classifyPendingSectors, "pending", "Pending sectors detected"],
        [disk.offlineUncorrectable, rules.classifyOfflineUncorrectable, "uncorrectable", "Uncorrectable sectors detected"]
    ];
    
    for (const [value, classifier, name, title] of checks) {
        const v = value as number | null;
        const cl = classifier as any;
        verdict = cl(v, thresholds);
        readings.push(
            rules.readingFromVerdict(
                `disk.${disk.serial}.${name}`,
                `${disk.serial} ${name} sectors`,
                v !== null ? Math.floor(v) : null,
                verdict,
                "",
                source
            )
        );
        alert = rules.alertFromVerdict(
            `disk.${disk.serial}.${name}`,
            verdict,
            `Disk ${disk.serial}`,
            title as string,
            v !== null ? String(Math.floor(v)) : "",
            "Media defects on the platter surface.",
            "Confirm backups, then plan replacement. Run a long SMART self-test to confirm: smartctl -t long"
        );
        if (alert) alerts.push(alert);
    }

    // Temperature
    verdict = rules.classifyDiskTemperature(disk.temperatureCelsius, thresholds);
    readings.push(
        rules.readingFromVerdict(
            `disk.${disk.serial}.temp`,
            `${disk.serial} temperature`,
            disk.temperatureCelsius,
            verdict,
            " °C",
            source
        )
    );
    alert = rules.alertFromVerdict(
        `disk.${disk.serial}.temp`,
        verdict,
        `Disk ${disk.serial}`,
        "Disk temperature above threshold",
        disk.temperatureCelsius ? `${Math.floor(disk.temperatureCelsius)} °C` : "",
        "Insufficient chassis airflow or a failed fan.",
        "Check case fans and drive bay ventilation."
    );
    if (alert) alerts.push(alert);

    // CRC
    if (disk.udmaCrcErrors !== null) {
        history.record(M_SMART_CRC, disk.udmaCrcErrors, labels);
    }
    const delta1h = history.delta(M_SMART_CRC, 3600, labels);
    const delta24h = history.delta(M_SMART_CRC, 86400, labels);
    const delta7d = history.delta(M_SMART_CRC, 7 * 86400, labels);
    const delta30d = history.delta(M_SMART_CRC, 30 * 86400, labels);

    verdict = rules.classifyCrcDelta(disk.udmaCrcErrors, delta24h, delta7d, delta1h, thresholds);
    readings.push(
        rules.readingFromVerdict(
            `disk.${disk.serial}.crc`,
            `${disk.serial} UDMA CRC errors`,
            disk.udmaCrcErrors !== null ? Math.floor(disk.udmaCrcErrors) : null,
            verdict,
            "",
            source,
            {
                "delta_1h": delta1h,
                "delta_24h": delta24h,
                "delta_7d": delta7d,
                "delta_30d": delta30d,
                "watch": diskConfig.watch_crc,
                "coverage_seconds": history.coverageSeconds(M_SMART_CRC, labels),
            }
        )
    );
    const [cause, action] = probableCauseForDiskCrc();
    alert = rules.alertFromVerdict(
        `disk.${disk.serial}.crc`,
        verdict,
        `Disk ${disk.serial}`,
        "Disk CRC errors increasing",
        disk.udmaCrcErrors !== null ? Math.floor(disk.udmaCrcErrors).toLocaleString('en-US') : "",
        cause,
        action
    );
    if (alert) alerts.push(alert);

    // Reallocated
    if (disk.reallocatedSectors !== null) {
        history.record(M_SMART_REALLOC, disk.reallocatedSectors, labels);
    }
    const reallocDelta = history.delta(M_SMART_REALLOC, 7 * 86400, labels);
    verdict = rules.classifyReallocatedDelta(disk.reallocatedSectors, reallocDelta, thresholds);
    readings.push(
        rules.readingFromVerdict(
            `disk.${disk.serial}.realloc`,
            `${disk.serial} reallocated sectors`,
            disk.reallocatedSectors !== null ? Math.floor(disk.reallocatedSectors) : null,
            verdict,
            "",
            source,
            { "delta_7d": reallocDelta }
        )
    );

    if (disk.temperatureCelsius !== null) {
        history.record(M_SMART_TEMP, disk.temperatureCelsius, labels);
    }

    return readings;
}

export async function collectStorage(settings: Settings, history: HistoryStore, router: SourceRouter, thresholds: Thresholds): Promise<[ComponentHealth, Record<string, any>]> {
    const readings: Reading<any>[] = [];
    const alerts: Alert[] = [];
    const raw: Record<string, any> = { filesystems: {}, forecasts: {} };
    const source = await router.sourceFor("storage");

    for (const filesystem of settings.filesystems) {
        const usage = await system.getFilesystemUsage(filesystem.mountpoint);
        if (!usage) {
            readings.push(
                Reading.no_data(
                    `storage.${filesystem.mountpoint}`,
                    filesystem.label,
                    `${filesystem.mountpoint} is not mounted or not readable.`,
                    source
                )
            );
            continue;
        }

        raw.filesystems[filesystem.mountpoint] = usage;
        const labels = { mount: filesystem.mountpoint };
        history.record(M_FS_USED, usage.usedBytes, labels);

        const verdict = rules.classifyFilesystem(usage.usedPercent, usage.freeBytes, thresholds);

        let forecast: CapacityForecast | null = null;
        if (filesystem.forecast) {
            const samples = history.series(M_FS_USED, labels, (Date.now() / 1000) - 120 * 86400);
            forecast = forecastCapacity(
                samples,
                usage.totalBytes,
                thresholds.storage.min_forecast_history_days,
                thresholds.storage.min_forecast_r_squared
            );
            raw.forecasts[filesystem.mountpoint] = forecast;
        }

        readings.push(
            rules.readingFromVerdict(
                `storage.${filesystem.mountpoint}`,
                filesystem.label,
                usage.usedPercent ? Math.round(usage.usedPercent * 10) / 10 : null,
                verdict,
                "%",
                source,
                {
                    usage,
                    forecast,
                    free_bytes: usage.freeBytes,
                    total_bytes: usage.totalBytes,
                }
            )
        );

        const alert = rules.alertFromVerdict(
            `storage.${filesystem.mountpoint}`,
            verdict,
            `Filesystem ${filesystem.mountpoint}`,
            `${filesystem.mountpoint} is filling up`,
            usage.usedPercent !== null ? `${usage.usedPercent.toFixed(1)}% used, ${humanBytes(usage.freeBytes)} free` : `${humanBytes(usage.freeBytes)} free`,
            "Normal media growth, or a runaway download/transcode directory.",
            `Check the largest directories: du -x -h -d1 ${filesystem.mountpoint} | sort -h | tail`
        );
        if (alert) alerts.push(alert);

        if (forecast !== null) {
            const forecastVerdict = rules.classifyForecast(forecast, thresholds);
            if (forecastVerdict.status === Status.WARNING || forecastVerdict.status === Status.CRITICAL) {
                alerts.push(
                    new Alert({
                        key: `storage.forecast.${filesystem.mountpoint}`,
                        status: forecastVerdict.status,
                        title: `${filesystem.mountpoint} projected to fill`,
                        component: `Filesystem ${filesystem.mountpoint}`,
                        detail: forecastVerdict.detail,
                        current_value: usage.usedPercent !== null ? `${usage.usedPercent.toFixed(1)}% used` : "",
                        threshold: forecastVerdict.threshold || "",
                        recommended_action: "Plan capacity or prune content."
                    })
                );
            }
        }

        const inodeVerdict = rules.classifyInodes(usage.inodesUsedPercent, thresholds);
        if (inodeVerdict.status !== Status.HEALTHY) {
            readings.push(
                rules.readingFromVerdict(
                    `storage.inodes.${filesystem.mountpoint}`,
                    `${filesystem.mountpoint} inodes`,
                    usage.inodesUsedPercent ? Math.round(usage.inodesUsedPercent * 10) / 10 : null,
                    inodeVerdict,
                    "%",
                    source
                )
            );
        }
    }

    const component = scoreComponent(
        "storage",
        "Storage",
        readings,
        alerts,
        null,
        "Filesystem capacity and growth"
    );
    return [component, raw];
}

export async function collectServer(settings: Settings, history: HistoryStore, router: SourceRouter, thresholds: Thresholds): Promise<[ComponentHealth, Record<string, any>]> {
    const readings: Reading<any>[] = [];
    const alerts: Alert[] = [];
    const source = await router.sourceFor("host");

    const snapshot = await system.getHostSnapshot(settings.local.command_timeout);
    const raw: Record<string, any> = { snapshot };

    const cpuPercent = snapshot.cpu?.usedPercent ?? null;
    const iowait = snapshot.cpu?.iowaitPercent ?? null;
    history.record(M_CPU, cpuPercent);
    history.record(M_IOWAIT, iowait);

    let verdict = rules.classifyCpu(cpuPercent, thresholds);
    readings.push(
        rules.readingFromVerdict(
            "server.cpu", "CPU utilisation", cpuPercent, verdict, "%", source
        )
    );
    _appendAlert(alerts, "server.cpu", verdict, "Host", "CPU utilisation high",
                  cpuPercent !== null ? `${cpuPercent.toFixed(1)}%` : "",
                  "A transcode, RAID scrub or import job may be running.",
                  "Check `top` and the Docker page for the responsible container.",
                  false);

    verdict = rules.classifyIowait(iowait, thresholds);
    readings.push(
        rules.readingFromVerdict(
            "server.iowait", "CPU iowait", iowait, verdict, "%", source
        )
    );
    _appendAlert(alerts, "server.iowait", verdict, "Host", "iowait high",
                  iowait !== null ? `${iowait.toFixed(1)}%` : "",
                  "Storage is saturated — often a RAID resync or heavy import.",
                  "Compare against the Storage page's disk utilisation figures.",
                  false);

    const memory = snapshot.memory;
    const availablePercent = memory?.availablePercent ?? null;
    history.record(M_MEM_AVAIL, availablePercent);
    verdict = rules.classifyMemoryAvailable(availablePercent, thresholds);
    readings.push(
        rules.readingFromVerdict(
            "server.memory",
            "Memory available",
            availablePercent ? Math.round(availablePercent * 10) / 10 : null,
            verdict,
            "%",
            source,
            { memory }
        )
    );
    _appendAlert(alerts, "server.memory", verdict, "Host", "Available memory low",
                  availablePercent ? `${availablePercent.toFixed(1)}% available` : "",
                  "A container or application is consuming memory.",
                  "Check per-container memory on the Docker page.",
                  false);

    const swapPercent = memory?.swapUsedPercent ?? null;
    verdict = rules.classifySwap(swapPercent, thresholds);
    readings.push(
        rules.readingFromVerdict(
            "server.swap",
            "Swap used",
            swapPercent ? Math.round(swapPercent * 10) / 10 : null,
            verdict,
            "%",
            source
        )
    );
    _appendAlert(
        alerts, "server.swap", verdict, "Host", "Swap usage high", "", "", "", false
    );

    const load = snapshot.load;
    verdict = rules.classifyLoad(
        load?.one ?? null, settings.host.cpu_cores, thresholds
    );
    readings.push(
        rules.readingFromVerdict(
            "server.load",
            "Load average (1m)",
            load?.one ? Math.round(load.one * 100) / 100 : null,
            verdict,
            "",
            source,
            { load }
        )
    );

    verdict = rules.classifyFailedUnits(snapshot.failedUnits);
    const failedNames = snapshot.failedUnits ? snapshot.failedUnits.map((u: any) => u.name).join(", ") : "";
    readings.push(
        rules.readingFromVerdict(
            "server.systemd",
            "Failed systemd units",
            snapshot.failedUnits ? snapshot.failedUnits.length : null,
            verdict,
            "",
            source,
            { units: snapshot.failedUnits }
        )
    );
    _appendAlert(
        alerts, "server.systemd", verdict, "Host", "Failed systemd unit(s)",
        failedNames,
        "A scheduled job or service exited non-zero.",
        failedNames ? `Inspect with: systemctl status ${failedNames.split(',')[0].trim()}` : "Inspect with: systemctl --failed"
    );

    if (snapshot.uptimeSeconds !== null) {
        const recent = snapshot.uptimeSeconds < thresholds.host.recent_boot_seconds;
        readings.push(
            new Reading({
                key: "server.uptime",
                label: "Uptime",
                value: humanDuration(snapshot.uptimeSeconds, 2),
                status: recent ? Status.INFO : Status.HEALTHY,
                detail: recent ? "Host rebooted recently." : `Up for ${humanDuration(snapshot.uptimeSeconds, 2)}.`,
                source,
                extra: { seconds: snapshot.uptimeSeconds }
            })
        );
    }

    if (snapshot.temperatures && Object.keys(snapshot.temperatures).length > 0) {
        const temps = Object.values(snapshot.temperatures);
        const hottest = Math.max(...temps as number[]);
        let status = Status.HEALTHY;
        let detail = `Hottest sensor ${Math.round(hottest)} °C.`;
        if (hottest > thresholds.host.cpu_temp_critical) {
            status = Status.CRITICAL;
            detail = `CPU/system sensor at ${Math.round(hottest)} °C.`;
        } else if (hottest > thresholds.host.cpu_temp_warning) {
            status = Status.WARNING;
            detail = `CPU/system sensor at ${Math.round(hottest)} °C.`;
        }
        verdict = { status, detail };
        
        readings.push(
            rules.readingFromVerdict(
                "server.temperature",
                "System temperature",
                Math.round(hottest * 10) / 10,
                verdict,
                " °C",
                source,
                { sensors: snapshot.temperatures }
            )
        );
    } else {
        readings.push(
            Reading.not_configured(
                "server.temperature",
                "System temperature",
                "No hwmon sensors exposed. Install lm-sensors and run sensors-detect.",
                source,
                true
            )
        );
    }

    const component = scoreComponent(
        "server",
        "Server",
        readings,
        alerts,
        null,
        `${settings.host.hostname} host health`
    );
    return [component, raw];
}

function _appendAlert(
    alerts: Alert[],
    key: string,
    verdict: rules.Verdict,
    component: string,
    title: string,
    current: string,
    cause: string,
    action: string,
    alertOnUnknown: boolean = true
): void {
    if (verdict.status === Status.UNKNOWN && !alertOnUnknown) {
        return;
    }
    const alert = rules.alertFromVerdict(
        key, verdict, component, title, current, cause, action
    );
    if (alert) {
        alerts.push(alert);
    }
}

export async function collectNetwork(settings: Settings, history: HistoryStore, router: SourceRouter, thresholds: Thresholds): Promise<[ComponentHealth, Record<string, any>]> {
    const readings: Reading<any>[] = [];
    const alerts: Alert[] = [];
    const raw: Record<string, any> = {};

    const gatewayIp = await network.get_default_gateway() || network.DEFAULT_GATEWAY;
    const internet = await network.ping(network.DEFAULT_INTERNET_TARGET, 3, 6.0);
    const gateway = await network.ping(gatewayIp, 2, 5.0);
    raw.internet_ping = internet;
    raw.gateway_ping = gateway;
    raw.gateway_ip = gatewayIp;

    history.record(M_LATENCY, internet.latency_ms);
    history.record(M_LOSS, internet.packet_loss_percent);

    let downSince: number | null = null;
    const state = history.putState("network.internet.reachable", internet.reachable ? "up" : "down");
    if (!internet.reachable) {
        downSince = state.changed_at;
    }

    const verdict = rules.classifyInternet(
        internet.packets_sent ? internet.reachable : null,
        internet.latency_ms,
        internet.packet_loss_percent,
        downSince,
        thresholds
    );
    readings.push(
        rules.readingFromVerdict(
            "network.internet",
            "Internet",
            internet.latency_ms ? Math.round(internet.latency_ms * 10) / 10 : null,
            verdict,
            " ms",
            "local:ping",
            { ping: internet }
        )
    );
    _appendAlert(
        alerts, "network.internet", verdict, "Internet", "Internet connectivity problem",
        (internet.latency_ms !== null && internet.packet_loss_percent !== null) ? `${Math.round(internet.latency_ms)} ms, ${Math.round(internet.packet_loss_percent)}% loss` : "no response",
        "WAN link, ISP, or gateway fault.",
        "Check the gateway result below; if the gateway responds the fault is upstream."
    );

    let gatewayVerdict: rules.Verdict;
    if (gateway.reachable && gateway.latency_ms !== null) {
        gatewayVerdict = { status: Status.HEALTHY, detail: `Gateway ${gatewayIp} responding (${gateway.latency_ms.toFixed(1)} ms).`, threshold: "" };
    } else if (gateway.packets_sent) {
        gatewayVerdict = { status: Status.CRITICAL, detail: `Gateway ${gatewayIp} is not responding.`, threshold: "" };
    } else {
        gatewayVerdict = { status: Status.UNKNOWN, detail: "Gateway could not be probed.", threshold: "" };
    }
    readings.push(
        rules.readingFromVerdict(
            "network.gateway",
            "Gateway",
            gateway.latency_ms !== null ? Math.round(gateway.latency_ms as number * 100) / 100 : null,
            gatewayVerdict,
            " ms",
            "local:ping"
        )
    );

    const [dnsOk, dnsMs] = await probes.probeDns();
    const dnsVerdict: rules.Verdict = dnsOk 
        ? { status: Status.HEALTHY, detail: `DNS resolving in ${Math.round(dnsMs as number)} ms.`, threshold: "" }
        : { status: Status.CRITICAL, detail: "DNS resolution is failing.", threshold: "" };
    readings.push(
        rules.readingFromVerdict(
            "network.dns",
            "DNS resolution",
            dnsMs ? Math.round(dnsMs * 10) / 10 : null,
            dnsVerdict,
            " ms",
            "local:getaddrinfo"
        )
    );
    _appendAlert(alerts, "network.dns", dnsVerdict, "Internet", "DNS resolution failing", "", "Resolver unreachable or misconfigured.", "Check /etc/resolv.conf and systemd-resolved status.");

    const wan = await network.get_public_ip(settings.vpn.wan_ip_check_url);
    raw.wan = wan;
    if (wan.ip) {
        const change = history.putState("network.wan_ip", wan.ip);
        raw.wan_ip_change = change;
        let detail = `Public IP ${wan.ip}`;
        if (change.changed && !change.first_seen) {
            detail = `WAN IP changed from ${change.previous} to ${wan.ip}.`;
            history.addEvent("network", "WAN public IP changed", `Old: ${change.previous}  New: ${wan.ip}`, Status.INFO);
        } else {
            detail += ` — unchanged for ${humanDuration((Date.now() / 1000) - change.changed_at)}.`;
        }
        readings.push(
            new Reading({
                key: "network.wan_ip",
                label: "WAN public IP",
                value: wan.ip,
                status: (change.changed && !change.first_seen) ? Status.INFO : Status.HEALTHY,
                detail,
                source: "ipinfo.io",
                extra: { change, info: wan }
            })
        );
    } else {
        readings.push(
            Reading.no_data("network.wan_ip", "WAN public IP", wan.error || "Could not determine the public IP.", "ipinfo.io")
        );
    }

    const unifiAvailable = await unifi.availability(settings.unifi);
    raw.unifi = unifiAvailable;
    raw.vlans = await unifi.getVlanStats(settings.unifi, settings.vlans as any, router.prometheus);
    if (!unifiAvailable.configured) {
        readings.push(
            Reading.not_configured(
                "network.unifi",
                "UniFi telemetry",
                unifiAvailable.detail,
                "unifi",
                true
            )
        );
    } else {
        const [devices, devicesError] = await unifi.getDevices(settings.unifi);
        raw.unifi_devices = devices.map(device => ({
            ...device,
            online: device.online,
            role: device.role,
            radios: device.radios.map(radio => ({ ...radio, band: radio.band })),
        }));
        raw.unifi_devices_error = devicesError;
        raw.gateway_status = await unifi.getGatewayStatus(settings.unifi, router.prometheus, undefined, devices);

        const controllerUrl = settings.unifi.controller_url;
        const apiKey = settings.unifi.api_key;
        const tlsVerify = settings.unifi.tls_verify;
        if (controllerUrl && apiKey) {
            const [controllerInfo, networksResult, wansResult, policiesResult, zonesResult] = await Promise.all([
                unifi.getControllerInfo(controllerUrl, apiKey, tlsVerify),
                unifi.getNetworks(controllerUrl, apiKey, tlsVerify, settings.unifi.site),
                unifi.getWans(controllerUrl, apiKey, tlsVerify, settings.unifi.site),
                unifi.getFirewallPolicies(controllerUrl, apiKey, tlsVerify, settings.unifi.site),
                unifi.getFirewallZones(controllerUrl, apiKey, tlsVerify, settings.unifi.site),
            ]);
            raw.unifi_controller = controllerInfo;
            raw.unifi_networks = networksResult[0];
            raw.unifi_networks_error = networksResult[1];
            raw.unifi_wans = wansResult[0].map(item => unifi.safeForDisplay(item));
            raw.unifi_wans_error = wansResult[1];
            raw.unifi_firewall_policies = policiesResult[0];
            raw.unifi_firewall_policies_error = policiesResult[1];
            raw.unifi_firewall_zones = zonesResult[0];
            raw.unifi_firewall_zones_error = zonesResult[1];
        }

        for (const device of devices || []) {
            if (device.role === "gateway") continue;
            const label = device.name || device.model || device.mac;
            if (device.online) {
                let detail = `${device.model} at ${device.ipAddress || 'unknown address'}`;
                if (device.uptimeSeconds) {
                    detail += `, up ${humanDuration(device.uptimeSeconds)}`;
                }
                readings.push(
                    new Reading({
                        key: `network.unifi.${device.mac || device.deviceId}`,
                        label: `${label} (${device.role})`,
                        value: device.state ? device.state.charAt(0).toUpperCase() + device.state.slice(1) : "",
                        status: Status.HEALTHY,
                        detail,
                        source: "unifi",
                        extra: { device }
                    })
                );
            } else {
                alerts.push(
                    new Alert({
                        key: `network.unifi.${device.mac || device.deviceId}`,
                        status: Status.CRITICAL,
                        title: `UniFi ${device.role} offline: ${label}`,
                        component: `UniFi ${device.role}`,
                        detail: `${device.model} reports state ${device.state || 'unknown'}.`,
                        current_value: device.state || "unknown",
                        probable_cause: "Lost power or PoE, an unplugged uplink, or a firmware update that has not come back.",
                        recommended_action: `Check the PoE port feeding ${label} on the switch, then its adoption state in the UniFi console.`
                    })
                );
                readings.push(
                    new Reading({
                        key: `network.unifi.${device.mac || device.deviceId}`,
                        label: `${label} (${device.role})`,
                        value: device.state ? (device.state.charAt(0).toUpperCase() + device.state.slice(1)) : "Offline",
                        status: Status.CRITICAL,
                        detail: `${device.model} is not reporting to the controller.`,
                        source: "unifi",
                        extra: { device }
                    })
                );
            }
        }
    }

    raw.interface_rates = await network.get_interface_rates();

    const component = scoreComponent(
        "network",
        "Network",
        readings,
        alerts,
        null,
        "Internet, gateway and DNS"
    );
    return [component, raw];
}

export async function collectContainers(settings: Settings, history: HistoryStore, router: SourceRouter, thresholds: Thresholds): Promise<[ComponentHealth, Record<string, any>, dockerService.ContainerInfo[]]> {
    const readings: Reading<any>[] = [];
    const alerts: Alert[] = [];
    const raw: Record<string, any> = {};
    const source = await router.sourceFor("containers");

    let containers: dockerService.ContainerInfo[] = [];
    try {
        containers = await dockerService.list_containers(settings.local.command_timeout + 3);
    } catch (exc: any) {
        if (exc instanceof dockerService.DockerUnavailable) {
            readings.push(Reading.error("server.docker", "Docker", `Docker is unreachable: ${exc.message}`, source));
            alerts.push(
                new Alert({
                    key: "server.docker",
                    status: Status.CRITICAL,
                    title: "Docker daemon unavailable",
                    component: "Docker",
                    detail: exc.message,
                    recommended_action: "Check `systemctl status docker` and that the dashboard user is in the docker group."
                })
            );
            const component = scoreComponent("containers", "Containers", readings, alerts, 0.0);
            return [component, raw, []];
        }
        throw exc;
    }

    raw.containers = containers;
    raw.docker_version = await dockerService.docker_version();

    let running = 0;
    for (const expected of settings.containers) {
        const container = dockerService.find_container(containers, expected.name);
        let restartDelta: number | null = null;
        if (container) {
            const labels = { container: expected.name };
            history.record(M_CONTAINER_RESTARTS, container.restart_count, labels);
            const delta = history.delta(M_CONTAINER_RESTARTS, 3600, labels);
            if (delta !== null) {
                restartDelta = Math.floor(delta);
            }
            if (container.running) {
                running += 1;
            }
            _detectContainerChanges(history, expected, container);
        }

        const verdict = rules.classifyContainer(container, expected.critical, restartDelta, thresholds);
        readings.push(
            rules.readingFromVerdict(
                `container.${expected.name}`,
                expected.display,
                container ? container.state : "missing",
                verdict,
                "",
                source,
                { container, restart_delta: restartDelta, expected }
            )
        );
        _appendAlert(
            alerts, `container.${expected.name}`, verdict, `Container ${expected.display}`,
            `${expected.display} is not healthy`,
            container ? container.state : "missing",
            expected.behind_vpn ? "Containers behind Gluetun lose connectivity whenever the VPN fails." : "",
            `docker logs --tail 100 ${expected.name}`
        );
    }

    raw.running_count = running;
    raw.expected_count = settings.containers.length;

    const expectedNames = new Set(settings.containers.map(e => e.name));
    const matched = new Set(settings.containers.filter(e => dockerService.find_container(containers, e.name)).map(e => e.name));
    const unexpected = containers.filter(c => c.running && !matched.has(c.name) && !expectedNames.has(c.name));
    raw.unexpected = unexpected;

    if (unexpected.length > 0) {
        readings.push(
            new Reading({
                key: "container.unexpected",
                label: "Unexpected containers",
                value: unexpected.length,
                status: Status.INFO,
                detail: "Running but not in the expected inventory: " + unexpected.slice(0, 5).map(c => c.name).join(", "),
                source,
                extra: { containers: unexpected }
            })
        );
    }

    const component = scoreComponent(
        "containers",
        "Containers",
        readings,
        alerts,
        0.0,
        `${running}/${settings.containers.length} expected containers running`
    );
    return [component, raw, containers];
}

function _detectContainerChanges(history: HistoryStore, expected: any, container: dockerService.ContainerInfo): void {
    const imageChange = history.putState(
        `container.${expected.name}.image`, `${container.image}@${container.version}`
    );
    if (imageChange.changed && !imageChange.first_seen) {
        const previous = (imageChange.previous || "").split("@");
        const current = `${container.image}@${container.version}`.split("@");
        history.addEvent(
            "docker",
            `${expected.display} image changed`,
            `Previous: ${previous[previous.length - 1] || previous[0]}  Current: ${current[current.length - 1] || current[0]}`,
            Status.INFO
        );
    }

    const restartChange = history.putState(
        `container.${expected.name}.restarts`, String(container.restart_count)
    );
    if (restartChange.changed && !restartChange.first_seen) {
        history.addEvent(
            "docker",
            `${expected.display} restarted`,
            `Restart count ${restartChange.previous} → ${container.restart_count}`,
            Status.WARNING
        );
    }
}

export async function collectVpn(settings: Settings, history: HistoryStore, containers: dockerService.ContainerInfo[], wanIp: string | null, thresholds: Thresholds): Promise<[ComponentHealth, Record<string, any>]> {
    const readings: Reading<any>[] = [];
    const alerts: Alert[] = [];

    const container = dockerService.find_container(containers, settings.vpn.container);
    const status = await vpn.getVpnStatus(container || null, container ? container.name : settings.vpn.container, { ipCheckUrl: settings.vpn.ip_check_url, provider: settings.vpn.provider, protocol: settings.vpn.protocol, controlUrl: settings.api.gluetun_control_url, apiKey: settings.api.gluetun_api_key });
    const leak = await vpn.checkLeak(status.publicIp, wanIp);
    const raw: Record<string, any> = { status, leak };

    if (status.publicIp) {
        const change = history.putState("vpn.public_ip", status.publicIp);
        raw.ip_change = change;
        if (change.changed && !change.first_seen) {
            history.addEvent(
                "vpn", "VPN exit IP changed",
                `Old: ${change.previous}  New: ${status.publicIp}`, Status.INFO
            );
        }
    }

    const verdict = rules.classifyVpn(status);
    readings.push(
        rules.readingFromVerdict(
            "vpn.gluetun", "Gluetun tunnel", status.publicIp, verdict, "", "local:docker", { status }
        )
    );
    _appendAlert(
        alerts, "vpn.gluetun", verdict, "VPN", "Gluetun VPN unhealthy",
        status.publicIp || "no tunnel",
        status.error || "",
        `Check \`docker logs --tail 200 ${settings.vpn.container}\`. If AUTH_FAILED appears, the provider credentials are wrong.`
    );

    const leakVerdict = rules.classifyLeak(leak);
    readings.push(
        rules.readingFromVerdict(
            "vpn.leak", "VPN leak check",
            leak.passed === true ? "PASS" : (leak.passed === false ? "FAIL" : null),
            leakVerdict, "", "derived", { leak }
        )
    );
    _appendAlert(
        alerts, "vpn.leak", leakVerdict, "VPN", "Possible VPN leak",
        `VPN ${leak.vpnIp} / WAN ${leak.wanIp}`,
        "The download stack is not routing through the tunnel.",
        "Stop the download clients, then verify Gluetun's network_mode bindings."
    );

    const component = scoreComponent(
        "vpn", "VPN", readings, alerts, null,
        "Gluetun tunnel and leak protection"
    );
    return [component, raw];
}

export async function collectApplications(settings: Settings, history: HistoryStore, router: SourceRouter, thresholds: Thresholds): Promise<[ComponentHealth, Record<string, any>]> {
    const readings: Reading<any>[] = [];
    const alerts: Alert[] = [];

    const targets: [string, string, string, number[]][] = settings.endpoints.filter(e => e.url).map(e => [e.key, e.display, e.url, e.expect_status]);
    
    const results = await probes.probeMany(targets, 5.0);
    const byKey: Record<string, any> = {};
    for (const r of results) {
        byKey[r.key] = r;
    }
    const raw: Record<string, any> = { probes: byKey };
    const source = await router.sourceFor("probes");

    for (const endpoint of settings.endpoints) {
        if (!endpoint.url) {
            readings.push(
                Reading.not_configured(
                    `probe.${endpoint.key}`, endpoint.display,
                    `No URL configured. ${endpoint.hosting}`, "probe", true
                )
            );
            continue;
        }
        const result = byKey[endpoint.key];
        const verdict = rules.classifyProbe(result, endpoint.critical, thresholds);
        readings.push(
            rules.readingFromVerdict(
                `probe.${endpoint.key}`, endpoint.display,
                result && result.latencyMs ? Math.round(result.latencyMs * 10) / 10 : null,
                verdict, " ms", source,
                { probe: result, endpoint }
            )
        );
        _appendAlert(
            alerts, `probe.${endpoint.key}`, verdict, endpoint.display,
            `${endpoint.display} is not responding correctly`,
            result ? result.error : "",
            endpoint.hosting,
            `Probe manually: curl -sS -o /dev/null -w '%{http_code}' ${endpoint.url}`
        );
    }

    const databases = await sportsdb.getAllDatabases(settings.sports_databases);
    raw.sports_databases = databases;
    for (const database of databases) {
        if (database.size_bytes !== null) {
            history.record(M_DB_SIZE, database.size_bytes, { db: database.key });
        }
        if (!database.exists) {
            readings.push(
                Reading.no_data(
                    `sportsdb.${database.key}`, `${database.display} database`,
                    database.error || "", "local:stat"
                )
            );
            continue;
        }
        
        let verdict: rules.Verdict;
        if (sportsdb.isStale(database)) {
            verdict = {
                status: Status.WARNING,
                detail: `Last updated ${humanDuration(sportsdb.getAgeSeconds(database) || 0)} ago, beyond the ${database.max_age_hours}h expectation.`,
                threshold: `≤${database.max_age_hours}h`
            };
        } else {
            verdict = {
                status: Status.HEALTHY,
                detail: `Updated ${humanDuration(sportsdb.getAgeSeconds(database) || 0)} ago (${humanBytes(database.size_bytes || 0)}).`,
                threshold: ""
            };
        }
        
        readings.push(
            rules.readingFromVerdict(
                `sportsdb.${database.key}`, `${database.display} database`,
                humanBytes(database.size_bytes || 0), verdict,
                "", "local:stat", { database }
            )
        );
    }

    const component = scoreComponent(
        "applications", "Applications", readings, alerts, null,
        "Synthetic probes and application data freshness"
    );
    return [component, raw];
}

export async function collectBackups(settings: Settings, history: HistoryStore, thresholds: Thresholds): Promise<[ComponentHealth, Record<string, any>]> {
    const readings: Reading<any>[] = [];
    const alerts: Alert[] = [];
    const statuses: backupService.BackupStatus[] = [];

    for (const job of settings.backups) {
        const status = await backupService.scanBackupDirectory(
            job.key, job.display, job.directory, job.pattern, job.schedule,
            job.expected_interval_days, job.min_plausible_bytes
        );

        const verification = history.getState(`backup.${job.key}.integrity`);
        if (verification) {
            status.integrity_ok = verification.value === "ok";
            status.integrity_detail = verification.value;
            status.integrity_checked_at = verification.changed_at;
        }

        if (job.schedule_weekdays) {
            status.missed_run_at = backupService.checkMissedRun(
                status, job.schedule_weekdays, job.schedule_hour, job.schedule_grace_hours
            );
            const missedVerdict = rules.classifyMissedRun(status.missed_run_at, job.schedule, status.age_days);
            if (missedVerdict.status !== Status.HEALTHY) {
                readings.push(rules.readingFromVerdict(`backup.schedule.${job.key}`, `${job.display} schedule`, "missed run", missedVerdict, "", "derived"));
                _appendAlert(
                    alerts, `backup.schedule.${job.key}`, missedVerdict, `Backup: ${job.display}`,
                    "Scheduled backup run was missed",
                    status.latest ? status.latest.name : "no backup found",
                    "The scheduled job did not run, or ran and failed before writing output.",
                    `Check the job (${job.source}) and its unit/cron entry, then \`journalctl -u backup-nightly.service -n 50\`.`
                );
            }
        }

        statuses.push(status);

        const verdict = rules.classifyBackupAge(status.age_days, job.expected_interval_days, thresholds);
        readings.push(
            rules.readingFromVerdict(
                `backup.${job.key}`, job.display,
                status.age_days !== null ? `${status.age_days.toFixed(1)} days` : null,
                verdict, "", "local:stat", { status }
            )
        );
        _appendAlert(
            alerts, `backup.${job.key}`, verdict, `Backup: ${job.display}`,
            `${job.display} is overdue`,
            status.latest ? status.latest.name : "no backup found",
            `Scheduled ${job.schedule}. The scheduled run may have failed.`,
            `Check the job: ${job.source}. Then \`systemctl list-timers\` / \`crontab -l\`.`
        );

        const sizeVerdict = rules.classifyBackupSize(status, thresholds);
        if (status.latest !== null && sizeVerdict.status !== Status.HEALTHY) {
            readings.push(
                rules.readingFromVerdict(
                    `backup.size.${job.key}`, `${job.display} size`, null,
                    sizeVerdict, "", "local:stat"
                )
            );
            _appendAlert(alerts, `backup.size.${job.key}`, sizeVerdict, `Backup: ${job.display}`, "Backup size looks wrong", "", "", "");
        }

        const integrityVerdict = rules.classifyBackupIntegrity(status.integrity_ok, status.integrity_detail);
        readings.push(
            rules.readingFromVerdict(
                `backup.integrity.${job.key}`, `${job.display} integrity`,
                status.integrity_detail || null, integrityVerdict, "", "verification",
                { checked_at: status.integrity_checked_at }
            )
        );
        if (integrityVerdict.status === Status.CRITICAL) {
            _appendAlert(
                alerts, `backup.integrity.${job.key}`, integrityVerdict, `Backup: ${job.display}`,
                "Backup failed its integrity check", "", "The archive is corrupt or truncated.",
                "Re-run the backup, then verify again from the Backups page."
            );
        }

        if (status.destination_used_percent !== null && status.destination_used_percent >= thresholds.backup.destination_full_percent) {
            alerts.push(new Alert({
                key: `backup.destination.${job.key}`,
                status: Status.CRITICAL,
                title: "Backup destination is nearly full",
                component: `Backup: ${job.display}`,
                detail: `${status.directory} is ${status.destination_used_percent.toFixed(0)}% full (${humanBytes(status.destination_free_bytes || 0)} free).`,
                threshold: `≥${thresholds.backup.destination_full_percent.toFixed(0)}%`,
                recommended_action: "Prune old backups or extend retention policy."
            }));
        }
    }

    const component = scoreComponent("backups", "Backups", readings, alerts, null, "Backup recency, size and integrity");
    return [component, { jobs: statuses }];
}

export async function collectSecurity(settings: Settings, history: HistoryStore, thresholds: Thresholds): Promise<[ComponentHealth, Record<string, any>]> {
    const readings: Reading<any>[] = [];
    const alerts: Alert[] = [];
    const raw: Record<string, any> = {};

    const listeners = await system.getListeners(settings.local.command_timeout);
    raw.listeners = listeners;

    const exposed = listeners ? listeners.filter(l => !l.loopbackOnly) : [];
    const expectedPorts = new Set(Object.values(settings.expected_listeners || {}).map(Number));
    const unexpected = exposed.filter(l => !expectedPorts.has(l.port));
    raw.unexpected_listeners = unexpected;

    if (!listeners) {
        readings.push(
            Reading.no_data("security.listeners", "Listening ports", "`ss` is unavailable, so local listeners could not be enumerated.", "local:ss")
        );
    } else if (unexpected.length > 0) {
        readings.push(
            new Reading({
                key: "security.listeners", label: "Unexpected listeners", value: unexpected.length,
                status: Status.WARNING,
                detail: "Listening on non-loopback addresses but not in the expected inventory: " + unexpected.slice(0, 6).map(l => `${l.address}:${l.port}`).join(", "),
                source: "local:ss", extra: { listeners: unexpected }
            })
        );
        alerts.push(new Alert({
            key: "security.listeners", status: Status.WARNING, title: "Unexpected listening port(s)", component: "Security",
            detail: unexpected.map(l => `${l.address}:${l.port}`).join(", "),
            recommended_action: "Identify the owner with `sudo ss -lntup`, then add it to EXPECTED_LISTENERS in config.py or shut it down."
        }));
    } else {
        readings.push(
            new Reading({
                key: "security.listeners", label: "Listening ports", value: exposed.length,
                status: Status.HEALTHY, detail: `All ${exposed.length} non-loopback listeners are expected.`,
                source: "local:ss", extra: { listeners: exposed }
            })
        );
    }

    const unifiAvailable = await unifi.availability(settings.unifi);
    raw.unifi = unifiAvailable;
    if (unifiAvailable.configured && unifi.idsAvailable(settings.unifi)) {
        const events = await unifi.getIdsEvents(settings.unifi);
        raw.ids_events = events;
        readings.push(
            new Reading({
                key: "security.ids", label: "UniFi IDS/IPS events", value: events.length,
                status: events.length > 0 ? Status.INFO : Status.HEALTHY,
                detail: `${events.length} recent IDS/IPS events.`, source: "unifi", extra: { events }
            })
        );
    } else {
        readings.push(
            Reading.not_configured(
                "security.ids", "UniFi IDS/IPS events",
                unifiAvailable.configured
                    ? "The UniFi Integration API does not expose IDS/IPS events, so an empty event list must not be interpreted as no intrusions."
                    : "UniFi is not integrated, so IDS/IPS alerts, blocked WAN traffic and firewall denials cannot be shown.",
                "unifi", true
            )
        );
    }

    const reviewPorts = settings.external_ports.filter(p => !p.expected);
    readings.push(
        new Reading({
            key: "security.exposure", label: "External port exposure",
            value: reviewPorts.length > 0 ? `${reviewPorts.length} need review` : `${settings.external_ports.length} intentional`,
            status: reviewPorts.length > 0 ? Status.WARNING : Status.INFO,
            detail: reviewPorts.length > 0 ? "Declared Internet-facing ports needing review: " + reviewPorts.map(p => p.port).join(", ") + ". Verify them in UniFi." : "All declared Internet-facing ports have a documented purpose.",
            source: "config", extra: { ports: settings.external_ports }
        })
    );

    const component = scoreComponent("security", "Security", readings, alerts, null, "Listener inventory and external exposure");
    return [component, raw];
}

export async function buildSnapshot(settings: Settings, history: HistoryStore, prometheusClient: any = null, thresholds?: Thresholds): Promise<Snapshot> {
    const started = Date.now();
    thresholds = thresholds || getThresholds();
    const router = new SourceRouter(settings, prometheusClient);

    const components: Record<string, ComponentHealth> = {};
    const raw: Record<string, any> = {};

    // Independent sensors run concurrently. Some probes have multi-second
    // timeouts, so serial collection made a dashboard refresh unnecessarily
    // slow and could cause clients to start overlapping snapshots.
    const [
        [raid, raidRaw],
        [storage, storageRaw],
        [server, serverRaw],
        [net, netRaw],
        [containers, containerRaw, containerList],
        [applicationsBase, appRaw],
        [backupsComponent, backupRaw],
        [security, securityRaw],
    ] = await Promise.all([
        collectRaidAndDisks(settings, history, router, thresholds),
        collectStorage(settings, history, router, thresholds),
        collectServer(settings, history, router, thresholds),
        collectNetwork(settings, history, router, thresholds),
        collectContainers(settings, history, router, thresholds),
        collectApplications(settings, history, router, thresholds),
        collectBackups(settings, history, thresholds),
        collectSecurity(settings, history, thresholds),
    ]);

    components["raid_disks"] = raid;
    raw["raid"] = raidRaw;

    components["storage"] = storage;
    raw["storage"] = storageRaw;

    components["server"] = server;
    raw["server"] = serverRaw;

    components["network"] = net;
    raw["network"] = netRaw;

    components["containers"] = containers;
    raw["containers"] = containerRaw;

    const wanInfo = netRaw["wan"];
    const [vpnComponent, vpnRaw] = await collectVpn(settings, history, containerList, wanInfo ? wanInfo.ip : null, thresholds);
    components["vpn"] = vpnComponent;
    raw["vpn"] = vpnRaw;

    let applications = applicationsBase;
    applications.readings.push(...containers.readings);
    applications.alerts.push(...containers.alerts);
    applications = scoreComponent(
        "applications", "Applications", applications.readings, applications.alerts, null, containers.detail
    );
    components["applications"] = applications;
    raw["applications"] = appRaw;

    components["backups"] = backupsComponent;
    raw["backups"] = backupRaw;

    components["security"] = security;
    raw["security"] = securityRaw;

    const scored = Object.values(components).filter(c => c.weight > 0);
    const health = calculateHealthScore(scored);

    const allAlerts: Alert[] = [];
    for (const component of Object.values(components)) {
        allAlerts.push(...component.alerts);
    }
    const [incidents, ] = correlate(allAlerts);

    const events = history.recentEvents(40);
    const changes = events.map(event => new ChangeEvent({
        timestamp: event.timestamp,
        category: event.category,
        summary: event.summary,
        detail: event.detail,
        status: (Object.values(Status).includes(event.status as any)) ? (event.status as Status) : Status.INFO
    }));

    const durationSeconds = (Date.now() - started) / 1000;
    
    const areas = ["host", "storage", "raid", "smart", "containers", "probes", "unifi"];
    const sources: Record<string, string> = {};
    for (const area of areas) {
        sources[area] = await router.sourceFor(area);
    }

    return {
        health,
        components,
        alerts: allAlerts.sort((a, b) => getRank(b.status) - getRank(a.status)),
        incidents,
        changes,
        raw,
        collected_at: Date.now() / 1000,
        duration_seconds: durationSeconds,
        sources
    };
}
