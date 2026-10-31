// Host inventory and change tracking: what is installed and configured, and
// what changed since the last look.
//
// Every few hours the collector snapshots packages, kernel, enabled units,
// listening ports, containers, accounts, kernel modules and a handful of
// security-relevant config files. The diff against the previous snapshot
// becomes events in the history store, so "what changed before this broke?"
// has an answer.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseNetSockets } from "./procfs";
import { runCommand } from "./system";
import { Status } from "./status";

export type Category = "packages" | "units" | "listeners" | "containers" | "users" | "modules" | "files" | "system";

/** Each category maps an item name to a comparable value (version, image, hash…). */
export type Inventory = {
  collectedAt: number;
  /** Categories whose collector failed this time, with the reason. */
  unavailable?: Partial<Record<Category, string>>;
} & Record<Category, Record<string, string>>;

/**
 * A category that could not be collected keeps its previous contents. Left
 * empty, one failed `docker ps` would report every container as removed, and
 * the next good run would report them all as added again.
 */
export function carryForward(previous: Inventory | null, next: Inventory): Inventory {
  const out = { ...next };
  for (const category of Object.keys(next.unavailable ?? {}) as Category[]) {
    out[category] = previous?.[category] ?? {};
  }
  return out;
}

export interface Change {
  category: Category;
  kind: "added" | "removed" | "changed";
  item: string;
  before: string | null;
  after: string | null;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  packages: "Packages", units: "Enabled units", listeners: "Listening ports", containers: "Containers",
  users: "Accounts", modules: "Kernel modules", files: "Watched files", system: "System",
};

const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[];

export function diffInventory(before: Inventory, after: Inventory): Change[] {
  const changes: Change[] = [];
  for (const category of CATEGORIES) {
    const a = before[category] ?? {}, b = after[category] ?? {};
    for (const [item, value] of Object.entries(b)) {
      if (!(item in a)) changes.push({ category, kind: "added", item, before: null, after: value });
      else if (a[item] !== value) changes.push({ category, kind: "changed", item, before: a[item], after: value });
    }
    for (const [item, value] of Object.entries(a)) {
      if (!(item in b)) changes.push({ category, kind: "removed", item, before: value, after: null });
    }
  }
  return changes;
}

/**
 * Severity for one change. Changes that widen access are WARNING: a new port
 * listening on every interface, a new login account, an edited sudoers or
 * sshd file. Routine package churn is INFO.
 */
export function changeStatus(change: Change): Status {
  if (change.category === "users" && change.kind !== "removed") return Status.WARNING;
  if (change.category === "files" && /sudoers|sshd_config|authorized_keys|passwd|shadow/.test(change.item)) return Status.WARNING;
  if (change.category === "listeners" && change.kind === "added" && /^(tcp|udp)6?:\*:/.test(change.item)) return Status.WARNING;
  return Status.INFO;
}

/** Turns a raw diff into a few readable events: 40 package upgrades become one line, not 40. */
export function summariseChanges(changes: Change[]): Array<{ category: Category; summary: string; detail: string; status: Status }> {
  const out: Array<{ category: Category; summary: string; detail: string; status: Status }> = [];
  const describe = (c: Change) =>
    c.kind === "changed" ? `${c.item}: ${c.before} → ${c.after}` : c.kind === "added" ? `+ ${c.item}${c.after && c.after !== "present" ? ` (${c.after})` : ""}` : `− ${c.item}`;
  for (const category of CATEGORIES) {
    const group = changes.filter(c => c.category === category);
    if (!group.length) continue;
    // Anything security-relevant gets its own event so it isn't buried in a bulk line.
    const notable = group.filter(c => changeStatus(c) !== Status.INFO);
    for (const c of notable) {
      out.push({ category, summary: `${CATEGORY_LABEL[category]}: ${describe(c)}`, detail: "", status: changeStatus(c) });
    }
    const routine = group.filter(c => changeStatus(c) === Status.INFO);
    if (!routine.length) continue;
    if (routine.length <= 3) {
      for (const c of routine) out.push({ category, summary: `${CATEGORY_LABEL[category]}: ${describe(c)}`, detail: "", status: Status.INFO });
    } else {
      const counts = (["changed", "added", "removed"] as const).map(k => [k, routine.filter(c => c.kind === k).length] as const).filter(([, n]) => n);
      const verb = { changed: category === "packages" ? "upgraded" : "changed", added: "added", removed: "removed" };
      out.push({
        category,
        summary: `${CATEGORY_LABEL[category]}: ${counts.map(([k, n]) => `${n} ${verb[k]}`).join(", ")}`,
        detail: routine.map(describe).join("\n"),
        status: Status.INFO,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

const WATCHED_FILES = [
  "/etc/ssh/sshd_config", "/etc/fstab", "/etc/hosts", "/etc/crontab", "/etc/resolv.conf",
  "/etc/sudoers", "/etc/mdadm/mdadm.conf", "/etc/docker/daemon.json", "/etc/netplan",
  "/etc/sudoers.d", "/etc/cron.d", "/etc/ssh/sshd_config.d", "/etc/systemd/system",
];

/** sha256 when readable; size+mtime when not (root-only files such as sudoers). */
function fingerprint(file: string): string | null {
  try {
    const st = fs.statSync(file);
    try {
      return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
    } catch {
      return `unreadable size=${st.size} mtime=${Math.round(st.mtimeMs / 1000)}`;
    }
  } catch {
    return null;
  }
}

function watchedFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of WATCHED_FILES) {
    let st: fs.Stats;
    try { st = fs.statSync(entry); } catch { continue; }
    const files = st.isDirectory()
      ? fs.readdirSync(entry).filter(n => !n.startsWith(".")).map(n => path.join(entry, n)).filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } })
      : [entry];
    for (const file of files) {
      const fp = fingerprint(file);
      if (fp) out[file] = fp;
    }
  }
  const keys = path.join(os.homedir(), ".ssh", "authorized_keys");
  const fp = fingerprint(keys);
  if (fp) out[keys] = fp;
  return out;
}

export async function collectInventory(): Promise<Inventory> {
  const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const unavailable: Partial<Record<Category, string>> = {};
  const failed = (category: Category, command: string, code: number, stderr: string) => {
    unavailable[category] = `${command} failed (exit ${code})${stderr.trim() ? `: ${stderr.trim().split("\n")[0].slice(0, 200)}` : ""}`;
  };
  const [[pkgCode, pkgOut, pkgErr], [unitCode, unitOut, unitErr], [idsCode, idsOut, idsErr]] = await Promise.all([
    runCommand(["dpkg-query", "-W", "-f", "${Package}\t${Version}\n"], 20),
    runCommand(["systemctl", "list-unit-files", "--state=enabled", "--output=json", "--no-pager"], 10),
    runCommand(["docker", "ps", "-aq", "--no-trunc"], 10),
  ]);

  const packages: Record<string, string> = {};
  if (pkgCode === 0) for (const line of pkgOut.split("\n")) { const [n, v] = line.split("\t"); if (n && v) packages[n] = v; }
  else failed("packages", "dpkg-query", pkgCode, pkgErr);

  const units: Record<string, string> = {};
  if (unitCode === 0) for (const u of JSON.parse(unitOut) as Array<{ unit_file: string; state: string }>) units[u.unit_file] = u.state;
  else failed("units", "systemctl list-unit-files", unitCode, unitErr);

  const containers: Record<string, string> = {};
  const ids = idsOut.split("\n").filter(Boolean);
  if (idsCode !== 0) failed("containers", "docker ps", idsCode, idsErr);
  else if (ids.length) {
    // `docker ps` has no image id field; inspect has the id the container runs.
    const [code, out, err] = await runCommand(["docker", "inspect", "--format", "{{.Name}}\t{{.Config.Image}}\t{{.Image}}", ...ids], 15);
    if (code !== 0) failed("containers", "docker inspect", code, err);
    for (const line of code === 0 ? out.split("\n") : []) {
      const [name, image, imageId] = line.split("\t");
      // Image id, not just the tag: `:latest` pulling a new build is a change.
      if (name) containers[name.replace(/^\//, "")] = `${image} @${(imageId ?? "").replace("sha256:", "").slice(0, 12)}`;
    }
  }

  // Ports, not sockets: the key is protocol + bind scope + port, so a service
  // restarting with a new socket inode isn't reported as a change.
  const listeners: Record<string, string> = {};
  for (const [file, proto, family] of [["/proc/net/tcp", "tcp", 4], ["/proc/net/tcp6", "tcp", 6], ["/proc/net/udp", "udp", 4], ["/proc/net/udp6", "udp", 6]] as const) {
    for (const s of parseNetSockets(read(file), proto, family)) {
      if (!(s.state === "LISTEN" || (proto === "udp" && s.state === "UNCONN" && s.remotePort === 0))) continue;
      const scope = s.localAddress === "0.0.0.0" || s.localAddress === "::" ? "*" : s.localAddress.startsWith("127.") || s.localAddress === "::1" ? "lo" : s.localAddress;
      // Ephemeral UDP client ports churn constantly; only track well-known/registered ones.
      if (proto === "udp" && s.localPort >= 32768) continue;
      listeners[`${proto}:${scope}:${s.localPort}`] = "present";
    }
  }

  const users: Record<string, string> = {};
  for (const line of read("/etc/passwd").split("\n")) {
    const f = line.split(":");
    const uid = Number(f[2]);
    // Accounts that can log in: uid 0 or human range, with a real shell.
    if (f.length >= 7 && (uid === 0 || uid >= 1000) && uid !== 65534 && !/(nologin|false)$/.test(f[6])) users[f[0]] = `uid=${uid} shell=${f[6]}`;
  }

  const modules: Record<string, string> = {};
  for (const line of read("/proc/modules").split("\n")) { const name = line.split(" ")[0]; if (name) modules[name] = "loaded"; }

  const osRelease = /^PRETTY_NAME="?([^"\n]+)/m.exec(read("/etc/os-release"))?.[1] ?? "unknown";
  return {
    collectedAt: Date.now() / 1000,
    ...(Object.keys(unavailable).length ? { unavailable } : {}),
    packages, units, containers, listeners, users, modules,
    files: watchedFiles(),
    system: { kernel: os.release(), os: osRelease, hostname: os.hostname() },
  };
}

// ---------------------------------------------------------------------------
// Persistence and schedule
// ---------------------------------------------------------------------------

export interface InventoryState {
  current: Inventory | null;
  previousAt: number | null;
  lastChanges: Change[];
  lastError: string | null;
  running: boolean;
}

const runtime = globalThis as typeof globalThis & { __streamanatorInventory?: InventoryState & { timer?: NodeJS.Timeout; lastManual?: number } };

function storePath(): string {
  return path.resolve(process.cwd(), "..", process.env.INVENTORY_PATH ?? "var/inventory.json");
}

function load(): { current: Inventory | null; previousAt: number | null; lastChanges: Change[] } {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    return { current: data.current ?? null, previousAt: data.previousAt ?? null, lastChanges: data.lastChanges ?? [] };
  } catch {
    return { current: null, previousAt: null, lastChanges: [] };
  }
}

export function inventoryState(): InventoryState {
  runtime.__streamanatorInventory ??= { ...load(), lastError: null, running: false };
  return runtime.__streamanatorInventory;
}

/**
 * Collect, diff against the stored snapshot, record events, persist.
 * `addEvent` is injected so this module doesn't pull SQLite into tests.
 */
export async function refreshInventory(addEvent: (category: string, summary: string, detail: string, status: string) => void): Promise<InventoryState> {
  const st = inventoryState();
  if (st.running) return st;
  st.running = true;
  try {
    const next = carryForward(st.current, await collectInventory());
    // The first snapshot is a baseline, not 1,600 "package added" events.
    const changes = st.current ? diffInventory(st.current, next) : [];
    for (const event of summariseChanges(changes)) addEvent(`inventory.${event.category}`, event.summary, event.detail, event.status);
    if (changes.length || !st.current) {
      st.previousAt = st.current?.collectedAt ?? null;
      st.lastChanges = changes.length ? changes : st.lastChanges;
    }
    st.current = next;
    st.lastError = next.unavailable
      ? `Not collected this time, previous values kept: ${Object.entries(next.unavailable).map(([c, why]) => `${c} (${why})`).join("; ")}`
      : null;
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ current: st.current, previousAt: st.previousAt, lastChanges: st.lastChanges }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) {
    st.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    st.running = false;
  }
  return st;
}

/** The serialisable part of the state: the runtime object also holds a timer handle. */
export function publicInventoryState(): InventoryState {
  const { current, previousAt, lastChanges, lastError, running } = inventoryState();
  return { current, previousAt, lastChanges, lastError, running };
}

/** Manual refresh from the page, at most once a minute so it can't be used to spin dpkg. */
export function manualRefreshAllowed(now = Date.now()): boolean {
  const st = inventoryState() as InventoryState & { lastManual?: number };
  if (st.lastManual && now - st.lastManual < 60_000) return false;
  st.lastManual = now;
  return true;
}

export function startInventorySchedule(addEvent: (category: string, summary: string, detail: string, status: string) => void) {
  const st = inventoryState() as InventoryState & { timer?: NodeJS.Timeout };
  if (st.timer) return;
  const hours = Math.max(1, Number(process.env.INVENTORY_INTERVAL_HOURS) || 6);
  const run = () => void refreshInventory(addEvent);
  // Shortly after boot (so a reboot that came with a kernel or package change
  // is caught quickly), then on the interval.
  setTimeout(run, 90_000).unref();
  st.timer = setInterval(run, hours * 3600_000);
  st.timer.unref();
}
