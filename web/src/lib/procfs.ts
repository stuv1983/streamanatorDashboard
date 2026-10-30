// Pure parsers for /proc and /sys text. No I/O lives here, so every format
// quirk (process names containing ") ", little-endian socket addresses, absent
// PSI "full" lines on older kernels) is testable on any platform.

// ---------------------------------------------------------------------------
// /proc/stat
// ---------------------------------------------------------------------------

export interface CpuTimes {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

export interface ProcStat {
  total: CpuTimes;
  cores: CpuTimes[];
  contextSwitches: number | null;
  forks: number | null;
  procsRunning: number | null;
  procsBlocked: number | null;
}

function cpuTimes(fields: string[]): CpuTimes {
  const n = (i: number) => Number(fields[i] ?? 0) || 0;
  return { user: n(0), nice: n(1), system: n(2), idle: n(3), iowait: n(4), irq: n(5), softirq: n(6), steal: n(7) };
}

export function parseProcStat(text: string): ProcStat | null {
  let total: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  const scalar: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const key = fields[0];
    if (key === "cpu") total = cpuTimes(fields.slice(1));
    else if (/^cpu\d+$/.test(key)) cores[Number(key.slice(3))] = cpuTimes(fields.slice(1));
    else if (key && fields.length === 2) scalar[key] = Number(fields[1]);
  }
  if (!total) return null;
  return {
    total,
    // Offline CPUs are absent from /proc/stat; keep the array dense so the
    // index still means "logical processor N" for the ones that remain.
    cores: cores.filter(Boolean),
    contextSwitches: scalar.ctxt ?? null,
    forks: scalar.processes ?? null,
    procsRunning: scalar.procs_running ?? null,
    procsBlocked: scalar.procs_blocked ?? null,
  };
}

export interface CpuBreakdown {
  total: number;
  user: number;
  system: number;
  iowait: number;
  steal: number;
  irq: number;
}

function sum(t: CpuTimes) {
  return t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;
}

/** Percentages of elapsed CPU time between two samples. Null when no time has passed. */
export function cpuBreakdown(prev: CpuTimes, cur: CpuTimes): CpuBreakdown | null {
  const elapsed = sum(cur) - sum(prev);
  if (elapsed <= 0) return null;
  const pct = (a: number, b: number) => Math.min(100, Math.max(0, (100 * (a - b)) / elapsed));
  const idle = pct(cur.idle, prev.idle);
  const iowait = pct(cur.iowait, prev.iowait);
  return {
    // iowait is idle time with I/O outstanding; counting it as busy would make
    // a storage stall look like CPU saturation.
    total: Math.max(0, 100 - idle - iowait),
    user: pct(cur.user + cur.nice, prev.user + prev.nice),
    system: pct(cur.system, prev.system),
    iowait,
    steal: pct(cur.steal, prev.steal),
    irq: pct(cur.irq + cur.softirq, prev.irq + prev.softirq),
  };
}

// ---------------------------------------------------------------------------
// /proc/meminfo, /proc/loadavg, /proc/pressure/*
// ---------------------------------------------------------------------------

/** Every meminfo field in bytes (HugePages_* counts are left as counts). */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = /^([\w()]+):\s+(\d+)(\s+kB)?/.exec(line);
    if (match) out[match[1]] = Number(match[2]) * (match[3] ? 1024 : 1);
  }
  return out;
}

export interface LoadAvg {
  one: number;
  five: number;
  fifteen: number;
  running: number;
  total: number;
}

export function parseLoadavg(text: string): LoadAvg | null {
  const match = /^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\/(\d+)/.exec(text.trim());
  if (!match) return null;
  return { one: +match[1], five: +match[2], fifteen: +match[3], running: +match[4], total: +match[5] };
}

export interface PressureLine {
  avg10: number;
  avg60: number;
  avg300: number;
  total: number;
}

export interface Pressure {
  some: PressureLine | null;
  full: PressureLine | null;
}

export function parsePressure(text: string): Pressure {
  const out: Pressure = { some: null, full: null };
  for (const line of text.split("\n")) {
    const match = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/.exec(line.trim());
    if (match) out[match[1] as "some" | "full"] = { avg10: +match[2], avg60: +match[3], avg300: +match[4], total: +match[5] };
  }
  return out;
}

// ---------------------------------------------------------------------------
// /proc/net/dev and /proc/diskstats
// ---------------------------------------------------------------------------

export interface NetDevCounters {
  rxBytes: number;
  rxPackets: number;
  rxErrors: number;
  rxDropped: number;
  txBytes: number;
  txPackets: number;
  txErrors: number;
  txDropped: number;
}

export function parseNetDev(text: string): Record<string, NetDevCounters> {
  const out: Record<string, NetDevCounters> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const f = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (!name || f.length < 16) continue;
    out[name] = {
      rxBytes: f[0], rxPackets: f[1], rxErrors: f[2], rxDropped: f[3],
      txBytes: f[8], txPackets: f[9], txErrors: f[10], txDropped: f[11],
    };
  }
  return out;
}

export interface DiskCounters {
  readIos: number;
  readSectors: number;
  readTicks: number;
  writeIos: number;
  writeSectors: number;
  writeTicks: number;
  inFlight: number;
  ioTicks: number;
  weightedTicks: number;
}

export function parseDiskstats(text: string): Record<string, DiskCounters> {
  const out: Record<string, DiskCounters> = {};
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const n = (i: number) => Number(f[i]) || 0;
    out[f[2]] = {
      readIos: n(3), readSectors: n(5), readTicks: n(6),
      writeIos: n(7), writeSectors: n(9), writeTicks: n(10),
      inFlight: n(11), ioTicks: n(12), weightedTicks: n(13),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// /proc/<pid>/{stat,status,io,cgroup}
// ---------------------------------------------------------------------------

export interface PidStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  utimeTicks: number;
  stimeTicks: number;
  priority: number;
  nice: number;
  threads: number;
  startTicks: number;
  vsizeBytes: number;
  rssPages: number;
}

export function parsePidStat(text: string): PidStat | null {
  // comm is wrapped in parentheses and may itself contain spaces and ")" —
  // e.g. "(tmux: server)" or "(a) b)". Only the LAST ")" is reliable.
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).trim().split(/\s+/);
  // rest[0] is field 3 (state); field N is rest[N - 3].
  const field = (n: number) => Number(rest[n - 3]);
  if (rest.length < 22) return null;
  return {
    pid: Number(text.slice(0, open).trim()),
    comm: text.slice(open + 1, close),
    state: rest[0],
    ppid: field(4),
    utimeTicks: field(14),
    stimeTicks: field(15),
    priority: field(18),
    nice: field(19),
    threads: field(20),
    startTicks: field(22),
    vsizeBytes: field(23),
    rssPages: field(24),
  };
}

export interface PidStatus {
  name: string | null;
  uid: number | null;
  rssBytes: number | null;
  swapBytes: number | null;
  threads: number | null;
  /** Kernel threads have no memory map and therefore no VmSize line. */
  isKernelThread: boolean;
}

export function parsePidStatus(text: string): PidStatus {
  const get = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? null;
  const kb = (key: string) => {
    const v = get(key);
    return v ? Number(v.split(/\s+/)[0]) * 1024 : null;
  };
  const uid = get("Uid");
  return {
    name: get("Name"),
    // Effective uid (second field), not real: a setuid program such as sudo
    // has real uid = the caller but runs with root's authority.
    uid: uid ? Number(uid.split(/\s+/)[1] ?? uid.split(/\s+/)[0]) : null,
    rssBytes: kb("VmRSS"),
    swapBytes: kb("VmSwap"),
    threads: get("Threads") ? Number(get("Threads")) : null,
    isKernelThread: get("VmSize") === null,
  };
}

export interface PidIo {
  readBytes: number;
  writeBytes: number;
  rchar: number;
  wchar: number;
}

export function parsePidIo(text: string): PidIo | null {
  const v: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const [k, val] = line.split(":");
    if (k && val) v[k.trim()] = Number(val.trim());
  }
  if (v.read_bytes === undefined) return null;
  return { readBytes: v.read_bytes, writeBytes: v.write_bytes ?? 0, rchar: v.rchar ?? 0, wchar: v.wchar ?? 0 };
}

/** Docker container id from a cgroup v1 or v2 path, or null for host processes. */
export function containerIdFromCgroup(text: string): string | null {
  const match = /(?:docker-|\/docker\/|cri-containerd-|libpod-)([0-9a-f]{64})/.exec(text);
  return match ? match[1] : null;
}

/** The systemd unit a host process belongs to, e.g. "nginx.service". */
export function unitFromCgroup(text: string): string | null {
  const line = text.split("\n").find(l => l.startsWith("0::")) ?? text.split("\n")[0] ?? "";
  const parts = line.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/\.(service|scope)$/.test(parts[i]) && !/^(docker|session)-/.test(parts[i])) return parts[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// /proc/net/{tcp,tcp6,udp,udp6}
// ---------------------------------------------------------------------------

export const TCP_STATES: Record<string, string> = {
  "01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1",
  "05": "FIN_WAIT2", "06": "TIME_WAIT", "07": "CLOSE", "08": "CLOSE_WAIT",
  "09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING", "0C": "NEW_SYN_RECV",
};

export interface Socket {
  protocol: "tcp" | "udp";
  family: 4 | 6;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  uid: number;
  inode: number;
  txQueue: number;
  rxQueue: number;
}

/** Kernel prints each 32-bit word in host (little-endian) byte order. */
function decodeAddress(hex: string): string {
  if (hex.length === 8) {
    return [6, 4, 2, 0].map(i => parseInt(hex.slice(i, i + 2), 16)).join(".");
  }
  const bytes: number[] = [];
  for (let word = 0; word < 4; word++) {
    const w = hex.slice(word * 8, word * 8 + 8);
    bytes.push(...[6, 4, 2, 0].map(i => parseInt(w.slice(i, i + 2), 16)));
  }
  // IPv4-mapped (::ffff:a.b.c.d) is how dual-stack listeners report v4 peers.
  if (bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12).join(".");
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return compressIpv6(groups);
}

function compressIpv6(groups: string[]): string {
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== "0") { i++; continue; }
    let j = i;
    while (j < groups.length && groups[j] === "0") j++;
    if (j - i > bestLen && j - i > 1) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  if (bestStart < 0) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

export function parseNetSockets(text: string, protocol: "tcp" | "udp", family: 4 | 6): Socket[] {
  const out: Socket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [localHex, localPortHex] = f[1].split(":");
    const [remoteHex, remotePortHex] = f[2].split(":");
    const [tx, rx] = f[4].split(":");
    // UDP has no connection states; "07" (CLOSE) there means an unconnected
    // socket, which for a bound port is effectively a listener.
    const state = protocol === "udp"
      ? (f[3] === "01" ? "ESTABLISHED" : "UNCONN")
      : (TCP_STATES[f[3].toUpperCase()] ?? f[3]);
    out.push({
      protocol, family,
      localAddress: decodeAddress(localHex),
      localPort: parseInt(localPortHex, 16),
      remoteAddress: decodeAddress(remoteHex),
      remotePort: parseInt(remotePortHex, 16),
      state,
      uid: Number(f[7]),
      inode: Number(f[9]),
      txQueue: parseInt(tx, 16),
      rxQueue: parseInt(rx, 16),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// /etc/passwd
// ---------------------------------------------------------------------------

export function parsePasswd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split("\n")) {
    const f = line.split(":");
    if (f.length >= 3 && /^\d+$/.test(f[2])) out.set(Number(f[2]), f[0]);
  }
  return out;
}

/** The kernel cuts `comm` at this many characters. */
export const COMM_MAX = 15;

/**
 * The display name: `comm`, or the full program name from argv[0] when `comm`
 * was cut ("Plex Media Serv" → "Plex Media Server"). Only used when argv[0]
 * still starts with `comm`, because programs may rewrite their argv freely.
 */
export function displayName(comm: string, rawCmdline: string): string {
  if (comm.length < COMM_MAX) return comm;
  const argv0 = rawCmdline.split("\0")[0] ?? "";
  // Either the whole of argv[0] ("next-server (v16.3.3)") or its last path
  // component ("/usr/lib/plexmediaserver/Plex Media Server").
  let full: string;
  if (argv0.startsWith(comm)) full = argv0;
  else {
    const at = argv0.lastIndexOf(`/${comm}`);
    if (at === -1) return comm;
    full = argv0.slice(at + 1);
  }
  return full.includes("/") || full.length > 64 ? comm : full;
}
