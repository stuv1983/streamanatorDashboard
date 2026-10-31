// Process table and socket inventory read straight from /proc.
//
// The dashboard runs as an unprivileged user, so some per-process detail is
// simply not readable for other users' processes: /proc/<pid>/io, the fd
// table (and therefore which socket belongs to which process), cwd and exe.
// Those fields come back null, never 0. "Unknown" and "none" are different
// answers, and treating them as the same is how a dashboard ends up lying.

import fs from "node:fs";
import path from "node:path";
import {
  displayName,
  containerIdFromCgroup, parseNetSockets, parsePasswd, parsePidIo, parsePidStat, parsePidStatus, unitFromCgroup,
  type Socket,
} from "./procfs";
import { IS_LINUX, runCommand } from "./system";

// USER_HZ is 100 on every mainstream Linux architecture; the kernel
// keeps it fixed for userspace ABI reasons, regardless of CONFIG_HZ.
const CLK_TCK = 100;
const PAGE_SIZE = 4096;

export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  command: string;
  user: string;
  uid: number | null;
  state: string;
  /** Share of the whole machine (all logical CPUs), as Task Manager shows it. */
  cpuPercent: number | null;
  rssBytes: number | null;
  swapBytes: number | null;
  threads: number;
  nice: number;
  startedAt: number | null;
  /** Bytes/second hitting storage; null when /proc/<pid>/io is not readable as this user. */
  readBps: number | null;
  writeBps: number | null;
  container: { id: string; name: string | null } | null;
  unit: string | null;
  kernelThread: boolean;
  /** Whether this dashboard's account may signal it (same uid, not protected). */
  controllable: boolean;
  protectedReason: string | null;
}

export interface ProcessTable {
  collectedAt: number;
  intervalSeconds: number | null;
  logicalCpus: number;
  selfUid: number;
  processes: ProcessRow[];
  totals: { processes: number; threads: number; running: number; sleeping: number; zombie: number; kernelThreads: number; unreadableIo: number };
}

const read = (file: string): string | null => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};

let usersCache: { at: number; map: Map<number, string> } | null = null;
function userName(uid: number | null): string {
  if (uid === null) return "?";
  if (!usersCache || Date.now() - usersCache.at > 300_000) {
    usersCache = { at: Date.now(), map: parsePasswd(read("/etc/passwd") ?? "") };
  }
  return usersCache.map.get(uid) ?? String(uid);
}

let containerCache: { at: number; map: Map<string, string> } | null = null;
let containerRefresh: Promise<void> | null = null;
/** id → name, refreshed in the background so a slow docker daemon never stalls the table. */
function containerName(id: string): string | null {
  if ((!containerCache || Date.now() - containerCache.at > 30_000) && !containerRefresh) {
    containerRefresh = runCommand(["docker", "ps", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}"], 5)
      .then(([code, out]) => {
        if (code !== 0) return;
        const map = new Map<string, string>();
        for (const line of out.split("\n")) {
          const [cid, name] = line.split("\t");
          if (cid && name) map.set(cid.trim(), name.trim());
        }
        containerCache = { at: Date.now(), map };
      })
      .catch(() => {})
      .finally(() => { containerRefresh = null; });
  }
  return containerCache?.map.get(id) ?? null;
}

function bootTime(): number | null {
  const btime = /^btime\s+(\d+)/m.exec(read("/proc/stat") ?? "")?.[1];
  return btime ? Number(btime) : null;
}

// ---------------------------------------------------------------------------
// Protection rules for signal/renice. Kept beside the table so the UI and the
// API share one answer to "may this process be touched?".
// ---------------------------------------------------------------------------

/** Names that must never be signalled from a web page, even when owned by this account. */
const PROTECTED_NAMES = new Set([
  "systemd", "init", "sshd", "sshd-session", "dockerd", "containerd", "containerd-shim", "containerd-shim-runc-v2",
  "dbus-daemon", "dbus-broker", "systemd-journald", "systemd-logind", "systemd-udevd", "systemd-resolved",
  "systemd-networkd", "mdadm", "mdmon", "agetty", "login", "polkitd",
]);

export function protectionReason(
  row: Pick<ProcessRow, "pid" | "ppid" | "uid" | "name" | "kernelThread" | "container">,
  selfUid: number,
  selfPid: number = process.pid,
  selfPpid: number = process.ppid,
): string | null {
  if (row.pid <= 1) return "PID 1 is the init system.";
  if (row.kernelThread) return "Kernel threads cannot be signalled.";
  if (row.pid === selfPid) return "This is the dashboard itself.";
  if (row.ppid === selfPid) return "This is one of the dashboard's own worker processes.";
  // Under systemd (or setsid) the parent is PID 1, and everything else whose
  // parent is init is NOT a sibling. Only a real launcher parent marks siblings.
  if (selfPpid > 1) {
    if (row.pid === selfPpid) return "This is the dashboard's parent process.";
    if (row.ppid === selfPpid) return "This is one of the dashboard's own worker processes.";
  }
  // linuxserver.io images run their app as uid 1000, the same uid as this
  // account, so the kernel would allow it. Signalling a container's app from
  // outside bypasses its restart policy and health checks; restart the container.
  if (row.container) return `Runs inside container ${row.container.name ?? row.container.id.slice(0, 12)}. Restart the container instead of signalling its processes.`;
  if (PROTECTED_NAMES.has(row.name)) return `${row.name} is core system plumbing; use SSH if it really needs a signal.`;
  if (row.uid === null || row.uid !== selfUid) {
    return row.uid === 0
      ? "Owned by root. The dashboard runs unprivileged and will not be given root to kill processes."
      : "Owned by another account. The dashboard can only signal its own account's processes.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

interface PrevEntry { startTicks: number; cpuTicks: number; read: number | null; write: number | null }

const state = globalThis as typeof globalThis & {
  __streamanatorProcs?: { at: number; entries: Map<number, PrevEntry>; table?: ProcessTable; pending?: Promise<ProcessTable> };
};

function scan(previous: { at: number; entries: Map<number, PrevEntry> } | undefined): { table: ProcessTable; entries: Map<number, PrevEntry> } {
  const now = Date.now();
  const elapsed = previous ? (now - previous.at) / 1000 : null;
  const logicalCpus = Math.max(1, (read("/proc/stat") ?? "").split("\n").filter(l => /^cpu\d+/.test(l)).length);
  const btime = bootTime();
  const selfUid = process.getuid?.() ?? -1;
  const entries = new Map<number, PrevEntry>();
  const processes: ProcessRow[] = [];
  const totals = { processes: 0, threads: 0, running: 0, sleeping: 0, zombie: 0, kernelThreads: 0, unreadableIo: 0 };

  let pids: string[] = [];
  try { pids = fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch { /* not Linux */ }

  for (const pidText of pids) {
    const dir = `/proc/${pidText}`;
    // A process can exit between readdir and here; every read tolerates that.
    const stat = parsePidStat(read(`${dir}/stat`) ?? "");
    if (!stat) continue;
    const status = parsePidStatus(read(`${dir}/status`) ?? "");
    const io = parsePidIo(read(`${dir}/io`) ?? "");
    const cgroup = read(`${dir}/cgroup`) ?? "";
    const rawCmdline = read(`${dir}/cmdline`) ?? "";
    const cmdline = rawCmdline.replace(/\0+$/, "").replaceAll("\0", " ");
    const cpuTicks = stat.utimeTicks + stat.stimeTicks;

    const before = previous?.entries.get(stat.pid);
    // Matching on start time as well as pid stops a recycled pid inheriting
    // the previous owner's counters and showing a nonsense spike.
    const same = before && before.startTicks === stat.startTicks;
    const rate = (cur: number | null, prev: number | null | undefined) =>
      same && elapsed && cur !== null && prev !== null && prev !== undefined ? Math.max(0, cur - prev) / elapsed : null;

    entries.set(stat.pid, { startTicks: stat.startTicks, cpuTicks, read: io?.readBytes ?? null, write: io?.writeBytes ?? null });

    const containerId = containerIdFromCgroup(cgroup);
    const row: ProcessRow = {
      pid: stat.pid,
      ppid: stat.ppid,
      name: displayName(status.name ?? stat.comm, rawCmdline),
      command: (status.isKernelThread ? `[${stat.comm}]` : cmdline || stat.comm).slice(0, 1024),
      uid: status.uid,
      user: userName(status.uid),
      state: stat.state,
      cpuPercent: same && elapsed
        ? Math.round((1000 * Math.max(0, cpuTicks - before!.cpuTicks)) / CLK_TCK / elapsed / logicalCpus) / 10
        : null,
      rssBytes: status.rssBytes ?? (stat.rssPages ? stat.rssPages * PAGE_SIZE : null),
      swapBytes: status.swapBytes,
      threads: status.threads ?? stat.threads,
      nice: stat.nice,
      startedAt: btime !== null ? btime + stat.startTicks / CLK_TCK : null,
      readBps: rate(io?.readBytes ?? null, before?.read),
      writeBps: rate(io?.writeBytes ?? null, before?.write),
      container: containerId ? { id: containerId, name: containerName(containerId) } : null,
      unit: containerId ? null : unitFromCgroup(cgroup),
      kernelThread: status.isKernelThread,
      controllable: false,
      protectedReason: null,
    };
    row.protectedReason = protectionReason(row, selfUid);
    row.controllable = row.protectedReason === null;
    processes.push(row);

    totals.processes++;
    totals.threads += row.threads;
    if (row.kernelThread) totals.kernelThreads++;
    if (row.state === "R") totals.running++;
    else if (row.state === "Z") totals.zombie++;
    else totals.sleeping++;
    if (!io && !row.kernelThread) totals.unreadableIo++;
  }

  return {
    entries,
    table: { collectedAt: now / 1000, intervalSeconds: elapsed, logicalCpus, selfUid, processes, totals },
  };
}

/**
 * The process table, at most `maxAgeMs` old. CPU% and I/O rates are measured
 * between consecutive scans, so the very first call has no rates.
 */
export async function getProcessTable(maxAgeMs = 1500): Promise<ProcessTable> {
  const cache = state.__streamanatorProcs;
  if (cache?.table && Date.now() - cache.at < maxAgeMs) return cache.table;
  if (cache?.pending) return cache.pending;
  if (!IS_LINUX) return { collectedAt: Date.now() / 1000, intervalSeconds: null, logicalCpus: 1, selfUid: -1, processes: [], totals: { processes: 0, threads: 0, running: 0, sleeping: 0, zombie: 0, kernelThreads: 0, unreadableIo: 0 } };

  const pending = (async () => {
    // A rate over a stale baseline (say, the last viewer left an hour ago)
    // would report an hour-long average as "now". Re-prime instead.
    let previous = state.__streamanatorProcs;
    if (!previous || Date.now() - previous.at > 15_000) {
      const primed = scan(undefined);
      previous = { at: Date.now(), entries: primed.entries };
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    const { table, entries } = scan(previous);
    state.__streamanatorProcs = { at: Date.now(), entries, table };
    return table;
  })();
  state.__streamanatorProcs = { ...(cache ?? { at: 0, entries: new Map() }), pending };
  try {
    return await pending;
  } finally {
    if (state.__streamanatorProcs) delete state.__streamanatorProcs.pending;
  }
}

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------

export interface SocketRow extends Socket {
  user: string;
  pid: number | null;
  process: string | null;
  container: string | null;
}

export interface SocketInventory {
  collectedAt: number;
  sockets: SocketRow[];
  /** Sockets whose owning process could not be identified (fd tables of other users are unreadable). */
  unattributed: number;
}

/** inode → pid for every process whose fd table is readable as this user. */
function socketOwners(): Map<number, number> {
  const owners = new Map<number, number>();
  let pids: string[] = [];
  try { pids = fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch { return owners; }
  for (const pid of pids) {
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match) owners.set(Number(match[1]), Number(pid));
      } catch { /* closed meanwhile */ }
    }
  }
  return owners;
}

export async function getSocketInventory(): Promise<SocketInventory> {
  const sockets: Socket[] = [];
  for (const [file, protocol, family] of [
    ["/proc/net/tcp", "tcp", 4], ["/proc/net/tcp6", "tcp", 6], ["/proc/net/udp", "udp", 4], ["/proc/net/udp6", "udp", 6],
  ] as const) {
    sockets.push(...parseNetSockets(read(file) ?? "", protocol, family));
  }
  const owners = socketOwners();
  const table = await getProcessTable(5000);
  const byPid = new Map(table.processes.map(p => [p.pid, p]));
  let unattributed = 0;
  const rows = sockets
    // TIME_WAIT sockets belong to no process and inflate the list a lot on a busy host.
    .map(socket => {
      const pid = socket.inode ? owners.get(socket.inode) ?? null : null;
      const proc = pid !== null ? byPid.get(pid) : undefined;
      if (pid === null && socket.state !== "TIME_WAIT") unattributed++;
      return {
        ...socket,
        user: userName(socket.uid),
        pid,
        process: proc?.name ?? null,
        container: proc?.container?.name ?? null,
      };
    });
  return { collectedAt: Date.now() / 1000, sockets: rows, unattributed };
}

// ---------------------------------------------------------------------------
// Single-process detail
// ---------------------------------------------------------------------------

export interface ProcessDetail {
  row: ProcessRow;
  children: ProcessRow[];
  ancestry: Array<Pick<ProcessRow, "pid" | "name">>;
  exe: string | null;
  cwd: string | null;
  openFiles: number | null;
  cgroup: string | null;
  limits: Record<string, string> | null;
  sockets: SocketRow[];
}

export async function getProcessDetail(pid: number): Promise<ProcessDetail | null> {
  const table = await getProcessTable(1500);
  const row = table.processes.find(p => p.pid === pid);
  if (!row) return null;
  const dir = `/proc/${pid}`;
  const link = (name: string) => { try { return fs.readlinkSync(path.join(dir, name)); } catch { return null; } };
  let openFiles: number | null = null;
  try { openFiles = fs.readdirSync(`${dir}/fd`).length; } catch { /* other user's process */ }

  const limitsText = read(`${dir}/limits`);
  let limits: Record<string, string> | null = null;
  if (limitsText) {
    limits = {};
    for (const line of limitsText.split("\n").slice(1)) {
      const match = /^(Max [\w ]+?)\s{2,}(\S+)\s+(\S+)/.exec(line);
      if (match) limits[match[1]] = match[2] === match[3] ? match[2] : `${match[2]} soft / ${match[3]} hard`;
    }
  }

  const byPid = new Map(table.processes.map(p => [p.pid, p]));
  const ancestry: ProcessDetail["ancestry"] = [];
  for (let cur = byPid.get(row.ppid); cur && ancestry.length < 32; cur = byPid.get(cur.ppid)) {
    ancestry.push({ pid: cur.pid, name: cur.name });
    if (cur.pid <= 1) break;
  }

  const inventory = await getSocketInventory();
  return {
    row,
    children: table.processes.filter(p => p.ppid === pid),
    ancestry,
    exe: link("exe"),
    cwd: link("cwd"),
    openFiles,
    cgroup: read(`${dir}/cgroup`)?.trim() ?? null,
    limits,
    sockets: inventory.sockets.filter(s => s.pid === pid),
  };
}
