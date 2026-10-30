import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { promisify } from 'util';

const execFile = promisify(child_process.execFile);

export const IS_LINUX = os.platform() === 'linux' && fs.existsSync('/proc');

export async function runCommand(args: string[], timeoutSeconds: number = 5.0): Promise<[number, string, string]> {
    if (!args || args.length === 0) {
        return [127, '', 'no command'];
    }
    
    try {
        const { stdout, stderr } = await execFile(args[0], args.slice(1), {
            timeout: timeoutSeconds * 1000,
        });
        return [0, stdout, stderr];
    } catch (err: any) {
        if (err.killed && err.signal === 'SIGTERM') {
            return [124, err.stdout || '', `timed out after ${timeoutSeconds}s`];
        }
        return [err.code || 126, err.stdout || '', err.message || String(err)];
    }
}

async function readText(filePath: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(filePath, 'utf-8');
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

export interface CpuSample {
    total: number;
    idle: number;
    iowait: number;
    steal: number;
    timestamp: number;
}

export interface CpuUsage {
    usedPercent: number;
    iowaitPercent: number;
    stealPercent: number;
    intervalSeconds: number;
}

let lastCpuSample: CpuSample | null = null;

export async function readCpuSample(): Promise<CpuSample | null> {
    const content = await readText('/proc/stat');
    if (!content) return null;
    for (const line of content.split('\n')) {
        if (!line.startsWith('cpu ')) continue;
        const fields = line.trim().split(/\s+/).slice(1).map(Number);
        if (fields.length < 5 || fields.some(isNaN)) return null;
        
        const idle = fields[3];
        const iowait = fields[4];
        const steal = fields.length > 7 ? fields[7] : 0.0;
        const total = fields.slice(0, fields.length >= 8 ? 8 : fields.length).reduce((a, b) => a + b, 0);
        
        return { total, idle, iowait, steal, timestamp: Date.now() / 1000 };
    }
    return null;
}

export async function getCpuUsage(): Promise<CpuUsage | null> {
    const current = await readCpuSample();
    if (!current) return null;
    const previous = lastCpuSample;
    lastCpuSample = current;
    if (!previous) return null;

    const totalDelta = current.total - previous.total;
    if (totalDelta <= 0) return null;
    
    const idleDelta = current.idle - previous.idle;
    const iowaitDelta = current.iowait - previous.iowait;
    const stealDelta = current.steal - previous.steal;
    
    const used = 100.0 * (totalDelta - idleDelta - iowaitDelta) / totalDelta;
    
    return {
        usedPercent: Math.max(0.0, Math.min(100.0, used)),
        iowaitPercent: Math.max(0.0, 100.0 * iowaitDelta / totalDelta),
        stealPercent: Math.max(0.0, 100.0 * stealDelta / totalDelta),
        intervalSeconds: current.timestamp - previous.timestamp,
    };
}

export interface LoadAverage {
    one: number;
    five: number;
    fifteen: number;
    runningProcesses: number;
    totalProcesses: number;
}

export async function getLoadAverage(): Promise<LoadAverage | null> {
    const content = await readText('/proc/loadavg');
    if (!content) {
        const [one, five, fifteen] = os.loadavg();
        return { one, five, fifteen, runningProcesses: 0, totalProcesses: 0 };
    }
    const parts = content.trim().split(/\s+/);
    if (parts.length < 4) return null;
    const [running, total] = parts[3].split('/');
    return {
        one: parseFloat(parts[0]),
        five: parseFloat(parts[1]),
        fifteen: parseFloat(parts[2]),
        runningProcesses: parseInt(running, 10),
        totalProcesses: parseInt(total || '0', 10),
    };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemoryInfo {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    cachedBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
    availablePercent: number | null;
    usedPercent: number | null;
    swapUsedPercent: number | null;
}

export async function getMemoryInfo(): Promise<MemoryInfo | null> {
    const content = await readText('/proc/meminfo');
    if (!content) return null;
    
    const values: Record<string, number> = {};
    for (const line of content.split('\n')) {
        const [keyPart, rest] = line.split(':');
        if (!keyPart || !rest) continue;
        const fields = rest.trim().split(/\s+/);
        if (fields.length === 0) continue;
        const val = parseInt(fields[0], 10);
        if (!isNaN(val)) {
            values[keyPart.trim()] = val * 1024; // kB -> bytes
        }
    }
    
    if (values['MemTotal'] === undefined) return null;
    
    const total = values['MemTotal'];
    const available = values['MemAvailable'] ?? values['MemFree'] ?? 0;
    const swapTotal = values['SwapTotal'] ?? 0;
    const swapFree = values['SwapFree'] ?? 0;
    const swapUsed = Math.max(0, swapTotal - swapFree);
    const usedBytes = Math.max(0, total - available);
    
    return {
        totalBytes: total,
        availableBytes: available,
        usedBytes,
        cachedBytes: (values['Cached'] ?? 0) + (values['Buffers'] ?? 0),
        swapTotalBytes: swapTotal,
        swapUsedBytes: swapUsed,
        availablePercent: total > 0 ? (100.0 * available / total) : null,
        usedPercent: total > 0 ? (100.0 * usedBytes / total) : null,
        swapUsedPercent: swapTotal > 0 ? (100.0 * swapUsed / swapTotal) : null,
    };
}

// ---------------------------------------------------------------------------
// Uptime / processes
// ---------------------------------------------------------------------------

export async function getUptimeSeconds(): Promise<number | null> {
    const content = await readText('/proc/uptime');
    if (content) {
        const val = parseFloat(content.split(/\s+/)[0]);
        if (!isNaN(val)) return val;
    }
    return null;
}

export async function getBootTime(): Promise<number | null> {
    const uptime = await getUptimeSeconds();
    if (uptime !== null) {
        return (Date.now() / 1000) - uptime;
    }
    return null;
}

export async function getProcessCount(): Promise<number | null> {
    if (!IS_LINUX) return null;
    try {
        const entries = await fs.promises.readdir('/proc');
        return entries.filter(e => /^\d+$/.test(e)).length;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Filesystems
// ---------------------------------------------------------------------------

export interface FilesystemUsage {
    mountpoint: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    inodesTotal: number;
    inodesFree: number;
    usedPercent: number | null;
    inodesUsedPercent: number | null;
}

export async function getFilesystemUsage(mountpoint: string): Promise<FilesystemUsage | null> {
    try {
        if (typeof fs.promises.statfs === 'function') {
            const stat = await fs.promises.statfs(mountpoint);
            const block = stat.bsize;
            const total = stat.blocks * block;
            const freeUnprivileged = stat.bavail * block;
            const freeTotal = stat.bfree * block;
            const used = total - freeTotal;
            
            const denominator = used + freeUnprivileged;
            const usedPercent = denominator > 0 ? (100.0 * used / denominator) : null;
            const inodesUsedPercent = stat.files > 0 ? (100.0 * (stat.files - stat.ffree) / stat.files) : null;

            return {
                mountpoint,
                totalBytes: total,
                usedBytes: used,
                freeBytes: freeUnprivileged,
                inodesTotal: stat.files,
                inodesFree: stat.ffree,
                usedPercent,
                inodesUsedPercent,
            };
        } else {
            return null; 
        }
    } catch {
        return null;
    }
}

export async function listMountpoints(): Promise<string[]> {
    const content = await readText('/proc/mounts');
    if (!content) return [];
    const skipTypes = new Set([
        "proc", "sysfs", "devtmpfs", "tmpfs", "devpts", "cgroup", "cgroup2",
        "securityfs", "pstore", "bpf", "debugfs", "tracefs", "configfs",
        "fusectl", "efivarfs", "squashfs", "autofs", "hugetlbfs", "mqueue",
        "nsfs", "binfmt_misc", "overlay"
    ]);
    const mounts: string[] = [];
    for (const line of content.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 3 || skipTypes.has(fields[2])) continue;
        mounts.push(fields[1]);
    }
    return mounts;
}

// ---------------------------------------------------------------------------
// RAID (/proc/mdstat + mdadm)
// ---------------------------------------------------------------------------

export interface MdArray {
    device: string;
    active: boolean;
    level: string;
    members: string[];
    failedMembers: string[];
    spareMembers: string[];
    totalBlocks: number;
    disksRequired: number;
    disksActive: number;
    stateString: string;
    syncAction: string | null;
    syncPercent: number | null;
    syncSpeedKbps: number | null;
    syncFinishMinutes: number | null;
    degraded: boolean;
    resyncing: boolean;
}

const MD_HEADER = /^(md\d+)\s*:\s*(\w+)\s+(\S+)\s+(.*)$/;
const MD_STATUS = /^\s*(\d+)\s+blocks.*?\[(\d+)\/(\d+)\]\s+\[([U_]+)\]/;
const MD_SYNC = /^\s*\[[=>.]*\]\s+(\w+)\s*=\s*([\d.]+)%.*?finish=([\d.]+)min\s+speed=(\d+)K\/sec/;
const MD_MEMBER = /^(\w+)\[(\d+)\](\([FS]\))?$/;

export function parseMdstat(content: string): MdArray[] {
    const arrays: MdArray[] = [];
    const lines = content.split('\n');
    let index = 0;
    
    while (index < lines.length) {
        const headerMatch = MD_HEADER.exec(lines[index]);
        if (!headerMatch) {
            index++;
            continue;
        }
        
        const [, device, state, level, membersStr] = headerMatch;
        const members: string[] = [];
        const failed: string[] = [];
        const spare: string[] = [];
        
        for (const token of membersStr.split(/\s+/)) {
            const memberMatch = MD_MEMBER.exec(token);
            if (!memberMatch) continue;
            const name = memberMatch[1];
            const flags = memberMatch[3] || '';
            members.push(name);
            if (flags.includes('F')) failed.push(name);
            else if (flags.includes('S')) spare.push(name);
        }
        
        let blocks = 0, required = 0, activeCount = 0, stateString = '';
        let syncAction: string | null = null;
        let syncPercent: number | null = null;
        let syncSpeed: number | null = null;
        let syncFinish: number | null = null;
        
        let cursor = index + 1;
        while (cursor < lines.length && lines[cursor].trim() !== '' && !MD_HEADER.test(lines[cursor])) {
            const statusMatch = MD_STATUS.exec(lines[cursor]);
            if (statusMatch) {
                blocks = parseInt(statusMatch[1], 10);
                required = parseInt(statusMatch[2], 10);
                activeCount = parseInt(statusMatch[3], 10);
                stateString = statusMatch[4];
            }
            const syncMatch = MD_SYNC.exec(lines[cursor]);
            if (syncMatch) {
                syncAction = syncMatch[1];
                syncPercent = parseFloat(syncMatch[2]);
                syncFinish = parseFloat(syncMatch[3]);
                syncSpeed = parseFloat(syncMatch[4]);
            }
            cursor++;
        }
        
        arrays.push({
            device,
            active: state === 'active',
            level,
            members,
            failedMembers: failed,
            spareMembers: spare,
            totalBlocks: blocks,
            disksRequired: required,
            disksActive: activeCount,
            stateString,
            syncAction,
            syncPercent,
            syncSpeedKbps: syncSpeed,
            syncFinishMinutes: syncFinish,
            degraded: activeCount < required,
            resyncing: syncAction !== null,
        });
        index = cursor;
    }
    return arrays;
}

export async function getMdArrays(mdstatPath = '/proc/mdstat'): Promise<MdArray[] | null> {
    const content = await readText(mdstatPath);
    if (content === null) return null;
    try {
        return parseMdstat(content);
    } catch {
        throw new Error(`Could not parse ${mdstatPath}`);
    }
}

export async function getMdDetail(device: string, timeout = 5.0): Promise<Record<string, string>> {
    const [code, out] = await runCommand(['mdadm', '--detail', `/dev/${device}`], timeout);
    if (code !== 0) return {};
    const detail: Record<string, string> = {};
    for (const line of out.split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.substring(0, idx).trim();
        const value = line.substring(idx + 1).trim();
        if (key && !key.startsWith('/dev')) {
            detail[key] = value;
        }
    }
    return detail;
}

// ---------------------------------------------------------------------------
// Block devices and disk I/O
// ---------------------------------------------------------------------------

export interface BlockDevice {
    name: string;
    serial: string;
    model: string;
    sizeBytes: number;
    mountpoints: string[];
    fstype: string;
}

let blockDevicesCache: { data: BlockDevice[], expiry: number } | null = null;

export async function getBlockDevices(timeout = 5.0): Promise<BlockDevice[]> {
    const now = Date.now();
    if (blockDevicesCache && blockDevicesCache.expiry > now) {
        return blockDevicesCache.data;
    }
    
    const [code, out] = await runCommand(['lsblk', '-b', '-d', '-n', '-o', 'NAME,SIZE,MODEL,SERIAL,TYPE'], timeout);
    if (code !== 0) return [];
    
    const devices: BlockDevice[] = [];
    for (const line of out.split('\n')) {
        const tokens = line.trim().split(/\s+/);
        if (tokens.length < 4 || tokens[tokens.length - 1] !== 'disk') continue;
        
        const name = tokens[0];
        const sizeRaw = tokens[1];
        const serial = tokens[tokens.length - 2];
        const model = tokens.slice(2, -2).join(' ');
        const sizeBytes = parseInt(sizeRaw, 10) || 0;
        
        devices.push({
            name,
            serial,
            model,
            sizeBytes,
            mountpoints: [],
            fstype: ''
        });
    }
    
    blockDevicesCache = { data: devices, expiry: now + 300 * 1000 };
    return devices;
}

export interface DiskIoSample {
    device: string;
    readSectors: number;
    writeSectors: number;
    readIos: number;
    writeIos: number;
    readTicks: number;
    writeTicks: number;
    ioTicks: number;
    timestamp: number;
}

export interface DiskIoRate {
    device: string;
    readBytesPerSec: number;
    writeBytesPerSec: number;
    readIops: number;
    writeIops: number;
    readLatencyMs: number | null;
    writeLatencyMs: number | null;
    utilisationPercent: number;
}

let lastDiskstats: Record<string, DiskIoSample> = {};
const SECTOR_BYTES = 512;

export async function readDiskstats(): Promise<Record<string, DiskIoSample>> {
    const content = await readText('/proc/diskstats');
    if (!content) return {};
    const now = Date.now() / 1000;
    const samples: Record<string, DiskIoSample> = {};
    for (const line of content.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 14) continue;
        const name = fields[2];
        if (name.startsWith('loop') || name.startsWith('ram') || name.startsWith('dm-')) continue;
        
        samples[name] = {
            device: name,
            readIos: parseInt(fields[3], 10),
            readSectors: parseInt(fields[5], 10),
            readTicks: parseInt(fields[6], 10),
            writeIos: parseInt(fields[7], 10),
            writeSectors: parseInt(fields[9], 10),
            writeTicks: parseInt(fields[10], 10),
            ioTicks: parseInt(fields[12], 10),
            timestamp: now,
        };
    }
    return samples;
}

export async function getDiskIoRates(): Promise<Record<string, DiskIoRate>> {
    const current = await readDiskstats();
    const previous = lastDiskstats;
    lastDiskstats = current;
    if (Object.keys(previous).length === 0) return {};
    
    const rates: Record<string, DiskIoRate> = {};
    for (const [name, sample] of Object.entries(current)) {
        const before = previous[name];
        if (!before) continue;
        const elapsed = sample.timestamp - before.timestamp;
        if (elapsed <= 0) continue;
        
        const readIos = Math.max(0, sample.readIos - before.readIos);
        const writeIos = Math.max(0, sample.writeIos - before.writeIos);
        const readTicks = Math.max(0, sample.readTicks - before.readTicks);
        const writeTicks = Math.max(0, sample.writeTicks - before.writeTicks);
        const ioTicks = Math.max(0, sample.ioTicks - before.ioTicks);
        
        rates[name] = {
            device: name,
            readBytesPerSec: (sample.readSectors - before.readSectors) * SECTOR_BYTES / elapsed,
            writeBytesPerSec: (sample.writeSectors - before.writeSectors) * SECTOR_BYTES / elapsed,
            readIops: readIos / elapsed,
            writeIops: writeIos / elapsed,
            readLatencyMs: readIos ? (readTicks / readIos) : null,
            writeLatencyMs: writeIos ? (writeTicks / writeIos) : null,
            utilisationPercent: Math.min(100.0, 100.0 * ioTicks / (elapsed * 1000.0)),
        };
    }
    return rates;
}

// ---------------------------------------------------------------------------
// Temperatures
// ---------------------------------------------------------------------------

export async function getCpuTemperatures(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    const hwmonRoot = '/sys/class/hwmon';
    try {
        const hwmons = await fs.promises.readdir(hwmonRoot);
        for (const hwmonName of hwmons) {
            const hwmonPath = path.join(hwmonRoot, hwmonName);
            const nameContent = await readText(path.join(hwmonPath, 'name'));
            const chip = (nameContent || '').trim() || hwmonName;
            
            const files = await fs.promises.readdir(hwmonPath);
            for (const file of files) {
                if (file.startsWith('temp') && file.endsWith('_input')) {
                    const raw = await readText(path.join(hwmonPath, file));
                    if (!raw) continue;
                    const celsius = parseFloat(raw.trim()) / 1000.0;
                    if (isNaN(celsius) || celsius <= -40.0 || celsius >= 150.0) continue;
                    
                    const labelFile = file.replace('_input', '_label');
                    const labelContent = await readText(path.join(hwmonPath, labelFile));
                    const label = (labelContent || '').trim() || file.replace('_input', '');
                    results[`${chip}/${label}`] = celsius;
                }
            }
        }
    } catch {
        // Ignored
    }
    return results;
}

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

export interface SystemdUnit {
    name: string;
    loadState: string;
    activeState: string;
    subState: string;
    description: string;
    failed: boolean;
}

export async function getFailedUnits(timeout = 5.0): Promise<SystemdUnit[] | null> {
    const [code, out] = await runCommand(
        ['systemctl', '--failed', '--no-legend', '--plain', '--no-pager'], timeout
    );
    if (code !== 0) return null;
    
    const units: SystemdUnit[] = [];
    for (const line of out.split('\n')) {
        let fields = line.trim().split(/\s+/);
        if (fields.length < 4) continue;
        if (['●', '*', '×'].includes(fields[0])) fields = fields.slice(1);
        if (fields.length < 4) continue;
        
        units.push({
            name: fields[0],
            loadState: fields[1],
            activeState: fields[2],
            subState: fields[3],
            description: fields.slice(4).join(' '),
            failed: fields[2] === 'failed' || fields[3] === 'failed'
        });
    }
    return units;
}

export async function getUnitState(unit: string, timeout = 5.0): Promise<SystemdUnit | null> {
    const [code, out] = await runCommand(
        ['systemctl', 'show', unit, '--property=LoadState,ActiveState,SubState,Description', '--no-pager'], timeout
    );
    if (code !== 0) return null;
    
    const values: Record<string, string> = {};
    for (const line of out.split('\n')) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        values[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
    }
    if (!values['LoadState']) return null;
    
    return {
        name: unit,
        loadState: values['LoadState'] || '',
        activeState: values['ActiveState'] || '',
        subState: values['SubState'] || '',
        description: values['Description'] || '',
        failed: values['ActiveState'] === 'failed' || values['SubState'] === 'failed'
    };
}

export async function getUnitLogs(unit: string, lines = 20, timeout = 6.0): Promise<string[]> {
    const [code, out] = await runCommand(
        ['journalctl', '-u', unit, '-n', String(lines), '--no-pager', '-o', 'short-iso'], timeout
    );
    if (code !== 0) return [];
    return out.split('\n').filter(line => line.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

export interface Listener {
    protocol: string;
    address: string;
    port: number;
    process: string;
    loopbackOnly: boolean;
}

const SS_LINE = /^(\S+)\s+\d+\s+\d+\s+(\S+)\s+\S+(.*)$/;

export async function getListeners(timeout = 5.0): Promise<Listener[]> {
    const [code, out] = await runCommand(['ss', '-lntp'], timeout);
    if (code !== 0) return [];
    
    const listeners: Listener[] = [];
    const lines = out.split('\n');
    for (let i = 1; i < lines.length; i++) {
        const match = SS_LINE.exec(lines[i].trim());
        if (!match) continue;
        
        const local = match[2];
        const lastColonIdx = local.lastIndexOf(':');
        if (lastColonIdx === -1) continue;
        
        const address = local.substring(0, lastColonIdx).replace(/^\[|\]$/g, '') || '0.0.0.0';
        const portText = local.substring(lastColonIdx + 1);
        const port = parseInt(portText, 10);
        if (isNaN(port)) continue;
        
        let process = '';
        const rest = match[3];
        const procMatch = /users:\(\("([^"]+)"/.exec(rest);
        if (procMatch) {
            process = procMatch[1];
        }
        
        listeners.push({
            protocol: 'tcp',
            address,
            port,
            process,
            loopbackOnly: address.startsWith('127.') || address.startsWith('::1') || address.startsWith('127.0.0.53')
        });
    }
    return listeners;
}

// ---------------------------------------------------------------------------
// Convenience snapshot
// ---------------------------------------------------------------------------

export interface HostSnapshot {
    cpu: CpuUsage | null;
    load: LoadAverage | null;
    memory: MemoryInfo | null;
    uptimeSeconds: number | null;
    processCount: number | null;
    temperatures: Record<string, number>;
    failedUnits: SystemdUnit[] | null;
    collectedAt: number;
}

export async function getHostSnapshot(commandTimeout = 5.0): Promise<HostSnapshot> {
    const [
        cpu,
        load,
        memory,
        uptimeSeconds,
        processCount,
        temperatures,
        failedUnits
    ] = await Promise.all([
        getCpuUsage(),
        getLoadAverage(),
        getMemoryInfo(),
        getUptimeSeconds(),
        getProcessCount(),
        getCpuTemperatures(),
        getFailedUnits(commandTimeout)
    ]);
    
    return {
        cpu,
        load,
        memory,
        uptimeSeconds,
        processCount,
        temperatures,
        failedUnits,
        collectedAt: Date.now() / 1000
    };
}
