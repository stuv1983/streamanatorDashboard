// One-second telemetry for the Task Manager and wall views.
//
// This is deliberately separate from history.ts. The history sampler records
// one-minute points for 400 days; this keeps ten minutes of one-second frames
// in memory and pushes each to connected browsers. It owns its own "previous
// sample" for every counter: system.ts keeps module-level previous samples
// that the snapshot path also reads, so calling those at 1 Hz would silently
// change the window the one-minute rates are computed over.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  cpuBreakdown, parseDiskstats, parseLoadavg, parseMeminfo, parseNetDev, parsePressure, parseProcStat,
  type CpuBreakdown, type DiskCounters, type NetDevCounters, type ProcStat,
} from "./procfs";
import { getCpuTemperatures, IS_LINUX } from "./system";

export interface LiveDisk {
  name: string;
  readBps: number;
  writeBps: number;
  readIops: number;
  writeIops: number;
  /** Share of wall time the device had I/O in flight ("active time" in Task Manager). */
  busyPercent: number;
  /** Mean time per completed I/O over the interval; null when nothing completed. */
  latencyMs: number | null;
}

export interface LiveNet {
  name: string;
  rxBps: number;
  txBps: number;
  rxPps: number;
  txPps: number;
  errorsPerSec: number;
  dropsPerSec: number;
}

export interface LiveGpu {
  index: number;
  utilPercent: number | null;
  memUtilPercent: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  temperatureC: number | null;
  powerW: number | null;
  fanPercent: number | null;
  clockMhz: number | null;
  encoderPercent: number | null;
  decoderPercent: number | null;
}

export interface PressureNow {
  some: number | null;
  full: number | null;
}

export interface LiveFrame {
  ts: number;
  intervalSeconds: number;
  cpu: (CpuBreakdown & { cores: number[] }) | null;
  load: [number, number, number] | null;
  tasks: { running: number; total: number; blocked: number | null } | null;
  mem: {
    total: number; used: number; available: number; free: number; cached: number; buffers: number;
    shmem: number; dirty: number; slab: number; swapTotal: number; swapUsed: number;
    committed: number; commitLimit: number; zswap: number | null; zswapped: number | null;
  } | null;
  psi: { cpu: PressureNow; memory: PressureNow; io: PressureNow } | null;
  disks: LiveDisk[];
  nets: LiveNet[];
  gpus: LiveGpu[];
  temps: Record<string, number> | null;
  cpuMhz: number | null;
  rates: { contextSwitches: number; forks: number } | null;
  uptimeSeconds: number | null;
}

export interface DiskInfo {
  name: string;
  model: string | null;
  sizeBytes: number | null;
  rotational: boolean | null;
  kind: "nvme" | "ssd" | "hdd" | "raid" | "other";
}

export interface NicInfo {
  name: string;
  speedMbps: number | null;
  operstate: string | null;
  mac: string | null;
  wireless: boolean;
  addresses: string[];
}

export interface GpuInfo {
  index: number;
  name: string;
  driver: string | null;
}

export interface LiveStatic {
  hostname: string;
  kernel: string;
  cpuModel: string | null;
  logicalCpus: number;
  physicalCores: number | null;
  sockets: number | null;
  baseMhz: number | null;
  memTotal: number | null;
  disks: DiskInfo[];
  nics: NicInfo[];
  gpus: GpuInfo[];
  buildId: string | null;
}

const read = (file: string): string | null => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};

const round = (value: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

// ---------------------------------------------------------------------------
// Static inventory — read once at start, refreshed every few minutes so a
// hot-plugged disk or a link-speed renegotiation still shows up.
// ---------------------------------------------------------------------------

const TRACKED_DISK = /^(sd[a-z]+|nvme\d+n\d+|md\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/;

function listDisks(): DiskInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync("/sys/block").filter(n => TRACKED_DISK.test(n)); } catch { return []; }
  return names.sort().map(name => {
    const base = path.join("/sys/block", name);
    const sectors = Number(read(path.join(base, "size")));
    const rotational = read(path.join(base, "queue/rotational"))?.trim();
    const model = (read(path.join(base, "device/model")) ?? read(path.join(base, "md/level")))?.trim() || null;
    const kind: DiskInfo["kind"] = name.startsWith("md") ? "raid"
      : name.startsWith("nvme") ? "nvme"
      : rotational === "1" ? "hdd" : rotational === "0" ? "ssd" : "other";
    return {
      name, model, kind,
      sizeBytes: Number.isFinite(sectors) && sectors > 0 ? sectors * 512 : null,
      rotational: rotational === undefined ? null : rotational === "1",
    };
  });
}

/** Physical NICs only: anything with a backing device, which excludes veth, bridges and tunnels. */
function listNics(): NicInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync("/sys/class/net"); } catch { return []; }
  const interfaces = os.networkInterfaces();
  return names
    .filter(name => fs.existsSync(path.join("/sys/class/net", name, "device")))
    .sort()
    .map(name => {
      const base = path.join("/sys/class/net", name);
      const speed = Number(read(path.join(base, "speed")));
      return {
        name,
        speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
        operstate: read(path.join(base, "operstate"))?.trim() ?? null,
        mac: read(path.join(base, "address"))?.trim() ?? null,
        wireless: fs.existsSync(path.join(base, "wireless")),
        addresses: (interfaces[name] ?? []).map(a => a.cidr ?? a.address),
      };
    });
}

function cpuIdentity(): Pick<LiveStatic, "cpuModel" | "physicalCores" | "sockets" | "baseMhz"> {
  const text = read("/proc/cpuinfo") ?? "";
  const model = /^model name\s*:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? os.cpus()[0]?.model ?? null;
  const pairs = new Set<string>();
  const sockets = new Set<string>();
  for (const block of text.split("\n\n")) {
    const phys = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (phys !== undefined && core !== undefined) { pairs.add(`${phys}:${core}`); sockets.add(phys); }
  }
  const maxKhz = Number(read("/sys/devices/system/cpu/cpu0/cpufreq/base_frequency") ?? read("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq"));
  return {
    cpuModel: model,
    physicalCores: pairs.size || null,
    sockets: sockets.size || null,
    baseMhz: Number.isFinite(maxKhz) && maxKhz > 0 ? Math.round(maxKhz / 1000) : null,
  };
}

function averageCpuMhz(): number | null {
  let total = 0, count = 0;
  try {
    for (const entry of fs.readdirSync("/sys/devices/system/cpu")) {
      if (!/^cpu\d+$/.test(entry)) continue;
      const khz = Number(read(`/sys/devices/system/cpu/${entry}/cpufreq/scaling_cur_freq`));
      if (Number.isFinite(khz) && khz > 0) { total += khz; count++; }
    }
  } catch { /* no cpufreq (VMs, some ARM boards) */ }
  return count ? Math.round(total / count / 1000) : null;
}

export function readBuildId(): string | null {
  return read(path.join(process.cwd(), ".next", "BUILD_ID"))?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// NVIDIA GPUs — one long-running nvidia-smi rather than a spawn per second.
// ---------------------------------------------------------------------------

const GPU_FIELDS = [
  "index", "name", "driver_version", "utilization.gpu", "utilization.memory", "memory.used", "memory.total",
  "temperature.gpu", "power.draw", "fan.speed", "clocks.gr", "utilization.encoder", "utilization.decoder",
];

function gpuNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value.trim());
  // nvidia-smi prints "[N/A]" or "[Not Supported]" for absent sensors.
  return Number.isFinite(n) ? n : null;
}

export function parseNvidiaSmiLine(line: string): { info: GpuInfo; sample: LiveGpu } | null {
  const f = line.split(",").map(s => s.trim());
  if (f.length < GPU_FIELDS.length || !/^\d+$/.test(f[0])) return null;
  const mib = (v: string) => { const n = gpuNumber(v); return n === null ? null : n * 1024 * 1024; };
  const index = Number(f[0]);
  return {
    info: { index, name: f[1], driver: f[2] || null },
    sample: {
      index,
      utilPercent: gpuNumber(f[3]),
      memUtilPercent: gpuNumber(f[4]),
      memUsedBytes: mib(f[5]),
      memTotalBytes: mib(f[6]),
      temperatureC: gpuNumber(f[7]),
      powerW: gpuNumber(f[8]),
      fanPercent: gpuNumber(f[9]),
      clockMhz: gpuNumber(f[10]),
      encoderPercent: gpuNumber(f[11]),
      decoderPercent: gpuNumber(f[12]),
    },
  };
}

class NvidiaWatcher {
  latest = new Map<number, LiveGpu>();
  info = new Map<number, GpuInfo>();
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;

  start(intervalMs: number) {
    if (!IS_LINUX || !["/usr/bin/nvidia-smi", "/bin/nvidia-smi"].some(p => fs.existsSync(p))) return this;
    this.spawn(intervalMs);
    return this;
  }

  private spawn(intervalMs: number) {
    const child = spawn("nvidia-smi", [
      `--query-gpu=${GPU_FIELDS.join(",")}`, "--format=csv,noheader,nounits", `-lms=${Math.max(500, intervalMs)}`,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    this.child = child;
    let buffer = "";
    child.stdout?.on("data", chunk => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const parsed = parseNvidiaSmiLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (parsed) { this.latest.set(parsed.info.index, parsed.sample); this.info.set(parsed.info.index, parsed.info); }
      }
    });
    child.on("error", () => { /* binary vanished; exit handler decides on retry */ });
    child.on("exit", () => {
      this.child = null;
      this.latest.clear();
      // A driver reload kills nvidia-smi. Retry with backoff, but give up
      // eventually so a box with a broken driver doesn't spawn forever.
      if (!this.stopped && this.restarts < 20) {
        this.restarts++;
        setTimeout(() => this.spawn(intervalMs), Math.min(60_000, 2_000 * this.restarts)).unref();
      }
    });
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }
}

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------

type Listener = (frame: LiveFrame) => void;

interface Previous {
  at: number;
  stat: ProcStat | null;
  disks: Record<string, DiskCounters>;
  nets: Record<string, NetDevCounters>;
}

export class LiveSampler {
  readonly intervalMs: number;
  readonly capacity: number;
  private frames: LiveFrame[] = [];
  private listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | null = null;
  private previous: Previous | null = null;
  private staticInfo: LiveStatic | null = null;
  private staticAt = 0;
  private slowAt = 0;
  private slow: Pick<LiveFrame, "temps" | "cpuMhz"> = { temps: null, cpuMhz: null };
  private gpu = new NvidiaWatcher();
  lastError: string | null = null;
  ticks = 0;

  constructor(intervalMs = 1000, historySeconds = 600) {
    this.intervalMs = Math.max(250, intervalMs);
    this.capacity = Math.ceil((historySeconds * 1000) / this.intervalMs);
  }

  start(): this {
    if (this.timer) return this;
    this.gpu.start(this.intervalMs);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.gpu.stop();
  }

  isRunning() { return this.timer !== null; }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get subscriberCount() { return this.listeners.size; }

  history(): LiveFrame[] { return this.frames.slice(); }

  latest(): LiveFrame | null { return this.frames.at(-1) ?? null; }

  static(): LiveStatic {
    if (!this.staticInfo || Date.now() - this.staticAt > 5 * 60_000) {
      const mem = parseMeminfo(read("/proc/meminfo") ?? "");
      this.staticInfo = {
        hostname: os.hostname(),
        kernel: os.release(),
        logicalCpus: os.cpus().length,
        memTotal: mem.MemTotal ?? null,
        ...cpuIdentity(),
        disks: listDisks(),
        nics: listNics(),
        gpus: [...this.gpu.info.values()],
        buildId: readBuildId(),
      };
      this.staticAt = Date.now();
    }
    // GPU identity arrives with nvidia-smi's first line, after start().
    if (this.staticInfo.gpus.length !== this.gpu.info.size) this.staticInfo.gpus = [...this.gpu.info.values()];
    return this.staticInfo;
  }

  private async tick() {
    try {
      const frame = this.sample();
      if (!frame) return;
      this.ticks++;
      this.frames.push(frame);
      if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity);
      for (const listener of this.listeners) {
        try { listener(frame); } catch { /* a broken client must not stop the others */ }
      }
      this.lastError = null;
      if (Date.now() - this.slowAt > 5_000) {
        this.slowAt = Date.now();
        this.slow = { temps: await getCpuTemperatures().catch(() => null), cpuMhz: averageCpuMhz() };
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private sample(): LiveFrame | null {
    if (!IS_LINUX) return null;
    const now = Date.now();
    const stat = parseProcStat(read("/proc/stat") ?? "");
    const disks = parseDiskstats(read("/proc/diskstats") ?? "");
    const nets = parseNetDev(read("/proc/net/dev") ?? "");
    const prev = this.previous;
    this.previous = { at: now, stat, disks, nets };
    // The first tick only primes the counters; a rate needs two samples.
    if (!prev) return null;
    const dt = (now - prev.at) / 1000;
    if (dt <= 0) return null;

    let cpu: LiveFrame["cpu"] = null;
    if (stat && prev.stat) {
      const total = cpuBreakdown(prev.stat.total, stat.total);
      if (total) {
        cpu = {
          ...roundBreakdown(total),
          cores: stat.cores.map((core, i) => {
            const before = prev.stat!.cores[i];
            const b = before ? cpuBreakdown(before, core) : null;
            return b ? round(b.total) : 0;
          }),
        };
      }
    }

    const load = parseLoadavg(read("/proc/loadavg") ?? "");
    const m = parseMeminfo(read("/proc/meminfo") ?? "");
    const mem: LiveFrame["mem"] = m.MemTotal ? {
      total: m.MemTotal,
      available: m.MemAvailable ?? m.MemFree ?? 0,
      used: Math.max(0, m.MemTotal - (m.MemAvailable ?? m.MemFree ?? 0)),
      free: m.MemFree ?? 0,
      cached: m.Cached ?? 0,
      buffers: m.Buffers ?? 0,
      shmem: m.Shmem ?? 0,
      dirty: m.Dirty ?? 0,
      slab: m.Slab ?? 0,
      swapTotal: m.SwapTotal ?? 0,
      swapUsed: Math.max(0, (m.SwapTotal ?? 0) - (m.SwapFree ?? 0)),
      committed: m.Committed_AS ?? 0,
      commitLimit: m.CommitLimit ?? 0,
      zswap: m.Zswap ?? null,
      zswapped: m.Zswapped ?? null,
    } : null;

    const pressure = (name: string): PressureNow => {
      const p = parsePressure(read(`/proc/pressure/${name}`) ?? "");
      return { some: p.some?.avg10 ?? null, full: p.full?.avg10 ?? null };
    };
    const psi = fs.existsSync("/proc/pressure") ? { cpu: pressure("cpu"), memory: pressure("memory"), io: pressure("io") } : null;

    const info = this.static();
    const diskRates: LiveDisk[] = [];
    for (const d of info.disks) {
      const cur = disks[d.name], before = prev.disks[d.name];
      if (!cur || !before) continue;
      const rIos = Math.max(0, cur.readIos - before.readIos);
      const wIos = Math.max(0, cur.writeIos - before.writeIos);
      const ticks = Math.max(0, cur.readTicks - before.readTicks) + Math.max(0, cur.writeTicks - before.writeTicks);
      diskRates.push({
        name: d.name,
        readBps: Math.round(Math.max(0, cur.readSectors - before.readSectors) * 512 / dt),
        writeBps: Math.round(Math.max(0, cur.writeSectors - before.writeSectors) * 512 / dt),
        readIops: round(rIos / dt),
        writeIops: round(wIos / dt),
        busyPercent: round(Math.min(100, (100 * Math.max(0, cur.ioTicks - before.ioTicks)) / (dt * 1000))),
        latencyMs: rIos + wIos > 0 ? round(ticks / (rIos + wIos), 2) : null,
      });
    }

    const netRates: LiveNet[] = [];
    for (const n of info.nics) {
      const cur = nets[n.name], before = prev.nets[n.name];
      if (!cur || !before) continue;
      const d = (a: number, b: number) => Math.max(0, a - b) / dt;
      netRates.push({
        name: n.name,
        rxBps: Math.round(d(cur.rxBytes, before.rxBytes)),
        txBps: Math.round(d(cur.txBytes, before.txBytes)),
        rxPps: round(d(cur.rxPackets, before.rxPackets)),
        txPps: round(d(cur.txPackets, before.txPackets)),
        errorsPerSec: round(d(cur.rxErrors + cur.txErrors, before.rxErrors + before.txErrors), 2),
        dropsPerSec: round(d(cur.rxDropped + cur.txDropped, before.rxDropped + before.txDropped), 2),
      });
    }

    const uptime = Number((read("/proc/uptime") ?? "").split(/\s+/)[0]);

    return {
      ts: now,
      intervalSeconds: round(dt, 3),
      cpu,
      load: load ? [load.one, load.five, load.fifteen] : null,
      tasks: load ? { running: load.running, total: load.total, blocked: stat?.procsBlocked ?? null } : null,
      mem,
      psi,
      disks: diskRates,
      nets: netRates,
      gpus: [...this.gpu.latest.values()],
      temps: this.slow.temps,
      cpuMhz: this.slow.cpuMhz,
      rates: stat && prev.stat && stat.contextSwitches !== null && prev.stat.contextSwitches !== null ? {
        contextSwitches: Math.round(Math.max(0, stat.contextSwitches - prev.stat.contextSwitches) / dt),
        forks: round(Math.max(0, (stat.forks ?? 0) - (prev.stat.forks ?? 0)) / dt),
      } : null,
      uptimeSeconds: Number.isFinite(uptime) ? Math.round(uptime) : null,
    };
  }
}

function roundBreakdown(b: CpuBreakdown): CpuBreakdown {
  return { total: round(b.total), user: round(b.user), system: round(b.system), iowait: round(b.iowait), steal: round(b.steal), irq: round(b.irq) };
}

const state = globalThis as typeof globalThis & { __streamanatorLive?: LiveSampler };

export function getLiveSampler(): LiveSampler {
  if (!state.__streamanatorLive) {
    const interval = Number(process.env.LIVE_SAMPLE_INTERVAL_MS) || 1000;
    const seconds = Number(process.env.LIVE_HISTORY_SECONDS) || 600;
    state.__streamanatorLive = new LiveSampler(interval, seconds).start();
  }
  return state.__streamanatorLive;
}
