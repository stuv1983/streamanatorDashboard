/**
 * Physical disk (SMART) health.
 *
 * Two possible sources, in preference order:
 *
 * 1. **smartctl_exporter via Prometheus** — the right long-term answer, and the
 *    only one that gives history without this dashboard sampling it itself.
 * 2. **`smartctl` directly** — needs root. On streamanator the dashboard user
 *    `arm` has no passwordless sudo, so this path is *disabled by default* and
 *    reports NOT CONFIGURED with the exact remediation, rather than silently
 *    returning nothing. Install `deploy/sudoers-smartctl` to enable it.
 *
 * Disks are keyed by **serial number**, never `/dev/sdX`. On this host the device
 * letters demonstrably moved between boots — the 11 Aug 2026 incident had
 * `WPV2E6LL` appear on a different path and get kicked from the array — so a
 * serial is the only stable identity.
 */

import { getBlockDevices, runCommand } from './system';

// Replace these with actual loggers/prometheus clients as available in your TS codebase
const log = {
    debug: (msg: string) => console.debug(`[smart] ${msg}`)
};

export interface PrometheusClient {
    available(): Promise<boolean>;
    query(promql: string): Promise<any[]>;
}

/** SMART attribute IDs the dashboard cares about, with their canonical names. */
const ATTRIBUTE_IDS: Record<number, string> = {
    5: "reallocated_sector_count",
    9: "power_on_hours",
    12: "power_cycle_count",
    187: "reported_uncorrectable_errors",
    188: "command_timeout",
    193: "load_cycle_count",
    194: "temperature_celsius",
    197: "current_pending_sector",
    198: "offline_uncorrectable",
    199: "udma_crc_error_count",
};

export interface SmartDisk {
    /** SMART state for one physical disk, identified by serial. */
    serial: string;
    model: string;
    device: string;
    /** smartctl's overall self-assessment. null when it could not be read. */
    passed: boolean | null;
    temperatureCelsius: number | null;
    powerOnHours: number | null;
    powerCycleCount: number | null;
    reallocatedSectors: number | null;
    currentPendingSectors: number | null;
    offlineUncorrectable: number | null;
    reportedUncorrectable: number | null;
    udmaCrcErrors: number | null;
    commandTimeouts: number | null;
    /** Raw attribute table, for the disk detail view. */
    attributes: Record<string, number>;
    collectedAt: number;
    source: string;
}

export function isRotational(disk: SmartDisk): boolean {
    return disk.powerOnHours !== null && !disk.model.toUpperCase().includes("SSD");
}

export class SmartUnavailable extends Error {
    hint: string;
    constructor(message: string, hint: string = "") {
        super(message);
        this.name = "SmartUnavailable";
        this.hint = hint;
    }
}

export async function smartctlAvailable(path: string = "/usr/sbin/smartctl"): Promise<boolean> {
    try {
        const [ code ] = await runCommand([path, "--version"], 4.0);
        return code === 0;
    } catch {
        return false;
    }
}

function extractAttributes(payload: any): Record<string, number> {
    /** Pull the ATA attribute table out of `smartctl -j` output. */
    const attributes: Record<string, number> = {};
    const table: any[] = payload?.ata_smart_attributes?.table || [];
    for (const entry of table) {
        const attrId = entry.id;
        const name = ATTRIBUTE_IDS[attrId];
        if (!name) continue;
        const raw = entry.raw?.value;
        if (raw === undefined || raw === null) continue;
        
        let value = Number(raw);
        if (isNaN(value)) continue;

        // Attribute 194's raw value packs min/max into the high bits on some
        // firmware; the low 16 bits hold the current temperature.
        if (attrId === 194 && value > 1000) {
            value = value & 0xFFFF;
        }
        attributes[name] = value;
    }
    return attributes;
}

export async function readSmartDevice(
    device: string,
    smartctlPath: string = "/usr/sbin/smartctl",
    useSudo: boolean = false,
    timeoutMs: number = 12000
): Promise<SmartDisk | null> {
    /** Read SMART for one /dev node. Returns null when it cannot be read. */
    let args = [smartctlPath, "-j", "-a", device];
    if (useSudo) {
        args = ["sudo", "-n", ...args];
    }

    try {
        const [ code, out, err ] = await runCommand(args, timeoutMs / 1000);
        if (!out.trim()) {
            log.debug(`smartctl produced no output for ${device}: ${err.trim()}`);
            return null;
        }
        
        let payload: any;
        try {
            payload = JSON.parse(out);
        } catch (e) {
            return null;
        }

        if ((code & 0b11) !== 0) {
            const messages = payload?.smartctl?.messages || [];
            const text = messages.map((m: any) => m.string || "").join("; ");
            log.debug(`smartctl could not open ${device}: ${text}`);
            return null;
        }

        const attributes = extractAttributes(payload);
        let temperature = payload?.temperature?.current;
        if (temperature === undefined) {
            temperature = attributes["temperature_celsius"];
        }

        let powerOn = payload?.power_on_time?.hours;
        if (powerOn === undefined) {
            powerOn = attributes["power_on_hours"];
        }

        const status = payload?.smart_status || {};
        
        const powerCycleCount = attributes["power_cycle_count"] ?? payload?.power_cycle_count ?? null;
        const serial = String(payload?.serial_number || "").trim();

        return {
            serial,
            model: String(payload?.model_name || "").trim(),
            device,
            passed: status.passed ?? null,
            temperatureCelsius: temperature !== undefined ? Number(temperature) : null,
            powerOnHours: powerOn !== undefined ? Number(powerOn) : null,
            powerCycleCount: powerCycleCount !== null ? Number(powerCycleCount) : null,
            reallocatedSectors: attributes["reallocated_sector_count"] ?? null,
            currentPendingSectors: attributes["current_pending_sector"] ?? null,
            offlineUncorrectable: attributes["offline_uncorrectable"] ?? null,
            reportedUncorrectable: attributes["reported_uncorrectable_errors"] ?? null,
            udmaCrcErrors: attributes["udma_crc_error_count"] ?? null,
            commandTimeouts: attributes["command_timeout"] ?? null,
            attributes,
            collectedAt: Date.now() / 1000,
            source: "smartctl"
        };
    } catch (e) {
        return null;
    }
}

// TTL cache decorator logic should be wrapped around this in the caller, or implemented here.
export async function collectSmartLocal(
    smartctlPath: string = "/usr/sbin/smartctl",
    useSudo: boolean = false,
    timeoutMs: number = 12000
): Promise<Record<string, SmartDisk>> {
    if (!(await smartctlAvailable(smartctlPath))) {
        throw new SmartUnavailable(
            "smartctl is not installed",
            "apt-get install smartmontools, or deploy the smartctl exporter."
        );
    }

    const devices = await getBlockDevices();
    if (!devices || devices.length === 0) {
        throw new SmartUnavailable(
            "No block devices could be enumerated",
            "Check that lsblk is available to the dashboard user."
        );
    }

    const disks: Record<string, SmartDisk> = {};
    let refused = 0;

    // Concurrently fetch smart data for performance
    const devicePromises = devices.map(async (device: any) => {
        const disk = await readSmartDevice(`/dev/${device.name}`, smartctlPath, useSudo, timeoutMs);
        if (disk === null) {
            refused++;
            return;
        }
        const serial = disk.serial || device.serial;
        if (serial) {
            disks[serial] = disk;
        }
    });

    await Promise.all(devicePromises);

    if (Object.keys(disks).length === 0 && refused > 0) {
        throw new SmartUnavailable(
            `smartctl could not read any of ${refused} devices (permission denied)`,
            "SMART needs root. Install deploy/sudoers-smartctl and set SMARTCTL_SUDO=true, or run the smartctl_exporter container."
        );
    }
    return disks;
}

const ATTR_CRC = "199";
const ATTR_PENDING = "197";
const ATTR_REALLOCATED = "5";
const ATTR_OFFLINE = "198";
const ATTR_TIMEOUT = "188";

export async function collectSmartFromPrometheus(client: PrometheusClient, timeoutMs: number = 4000): Promise<Record<string, SmartDisk>> {
    const disks: Record<string, SmartDisk> = {};
    if (!client || !(await client.available())) {
        return disks;
    }

    const deviceSerial: Record<string, string> = {};
    const models: Record<string, string> = {};

    try {
        const items = await client.query("smartctl_device");
        for (const item of items) {
            const device = item.labels?.device || "";
            const serial = item.labels?.serial_number || "";
            if (device && serial) {
                deviceSerial[device] = serial;
                models[serial] = item.labels?.model_name || "";
            }
        }
    } catch (exc) {
        log.debug(`smartctl_device query failed: ${exc}`);
        return disks;
    }

    async function bySerial(promql: string): Promise<Record<string, number>> {
        try {
            const results = await client.query(promql);
            const values: Record<string, number> = {};
            for (const item of results) {
                const device = item.labels?.device || "";
                const serial = deviceSerial[device];
                if (serial) {
                    values[serial] = item.value;
                }
            }
            return values;
        } catch (exc) {
            log.debug(`SMART query failed (${promql}): ${exc}`);
            return {};
        }
    }

    // Can be run concurrently
    const [temperatures, status, powerOn, crc, pending, reallocated, offline, timeouts] = await Promise.all([
        bySerial("smartctl_device_temperature{temperature_type='current'}"),
        bySerial("smartctl_device_smart_status"),
        bySerial("smartctl_device_power_on_seconds"),
        bySerial(`smartctl_device_attribute{attribute_id='${ATTR_CRC}',attribute_value_type='raw'}`),
        bySerial(`smartctl_device_attribute{attribute_id='${ATTR_PENDING}',attribute_value_type='raw'}`),
        bySerial(`smartctl_device_attribute{attribute_id='${ATTR_REALLOCATED}',attribute_value_type='raw'}`),
        bySerial(`smartctl_device_attribute{attribute_id='${ATTR_OFFLINE}',attribute_value_type='raw'}`),
        bySerial(`smartctl_device_attribute{attribute_id='${ATTR_TIMEOUT}',attribute_value_type='raw'}`)
    ]);

    for (const [device, serial] of Object.entries(deviceSerial)) {
        disks[serial] = {
            serial,
            model: models[serial] || "",
            device,
            passed: serial in status ? Boolean(status[serial]) : null,
            temperatureCelsius: temperatures[serial] ?? null,
            powerOnHours: serial in powerOn ? (powerOn[serial] / 3600.0) : null,
            powerCycleCount: null,
            reallocatedSectors: reallocated[serial] ?? null,
            currentPendingSectors: pending[serial] ?? null,
            offlineUncorrectable: offline[serial] ?? null,
            reportedUncorrectable: null,
            udmaCrcErrors: crc[serial] ?? null,
            commandTimeouts: timeouts[serial] ?? null,
            attributes: {}, 
            collectedAt: Date.now() / 1000,
            source: "prometheus:smartctl_exporter"
        };
    }
    return disks;
}
