import { Settings } from './config';
import { getFilesystemUsage, getCpuUsage, getMemoryInfo, getDiskIoRates } from './system';
import { collectSmartLocal } from './smart';
import { ping, DEFAULT_INTERNET_TARGET } from './network';
import { get_interface_rates } from './network';

// Metric keys used in the history store
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
export const M_DISK_READ_BPS = "disk.read_bytes_per_second";
export const M_DISK_WRITE_BPS = "disk.write_bytes_per_second";
export const M_DISK_UTIL = "disk.utilisation_percent";
export const M_NET_RX_BPS = "net.rx_bytes_per_second";
export const M_NET_TX_BPS = "net.tx_bytes_per_second";

export type SampleRow = [string, Record<string, string> | null, number | null];

export async function sampleMetrics(settings: Settings): Promise<SampleRow[]> {
    const rows: SampleRow[] = [];

    for (const filesystem of settings.filesystems) {
        const usage = await getFilesystemUsage(filesystem.mountpoint);
        if (usage !== null) {
            rows.push([M_FS_USED, { mount: filesystem.mountpoint }, usage.usedBytes]);
        }
    }

    const cpu = await getCpuUsage();
    if (cpu !== null) {
        rows.push([M_CPU, null, cpu.usedPercent]);
        rows.push([M_IOWAIT, null, cpu.iowaitPercent]);
    }

    const memory = await getMemoryInfo();
    if (memory !== null) {
        rows.push([M_MEM_AVAIL, null, memory.availablePercent]);
    }

    const diskRates = Object.values(await getDiskIoRates());
    if (diskRates.length) {
        rows.push([M_DISK_READ_BPS, null, diskRates.reduce((sum, disk) => sum + disk.readBytesPerSec, 0)]);
        rows.push([M_DISK_WRITE_BPS, null, diskRates.reduce((sum, disk) => sum + disk.writeBytesPerSec, 0)]);
        rows.push([M_DISK_UTIL, null, Math.max(...diskRates.map(disk => disk.utilisationPercent))]);
    }

    const physicalInterfaces = Object.values(get_interface_rates()).filter(rate =>
        !/^(lo|veth|br-|docker|virbr|tun|tap)/.test(rate.name)
    );
    if (physicalInterfaces.length) {
        rows.push([M_NET_RX_BPS, null, physicalInterfaces.reduce((sum, item) => sum + item.rx_bytes_per_sec, 0)]);
        rows.push([M_NET_TX_BPS, null, physicalInterfaces.reduce((sum, item) => sum + item.tx_bytes_per_sec, 0)]);
    }

    if (settings.local.enabled) {
        try {
            const disks = await collectSmartLocal(
                settings.local.smartctl_path,
                settings.local.smartctl_via_sudo
            );
            for (const [serial, disk] of Object.entries(disks)) {
                const labels = { serial };
                rows.push([M_SMART_CRC, labels, disk.udmaCrcErrors]);
                rows.push([M_SMART_REALLOC, labels, disk.reallocatedSectors]);
                rows.push([M_SMART_PENDING, labels, disk.currentPendingSectors]);
                rows.push([M_SMART_TEMP, labels, disk.temperatureCelsius]);
            }
        } catch (e) {
            // SMART is optional
        }
    }

    const result = await ping(DEFAULT_INTERNET_TARGET, 3, 6.0);
    rows.push([M_LATENCY, null, result.latency_ms]);
    rows.push([M_LOSS, null, result.packet_loss_percent]);

    // _warm_slow_caches is omitted for now, we can add it later if needed.

    return rows;
}
