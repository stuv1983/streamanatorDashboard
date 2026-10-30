// User-configurable alert conditions over the one-second live stream:
// "metric OP threshold for N seconds". Evaluated on every frame, so a
// condition fires on sustained load, not on the one sample a 60 s poll happens
// to land on, and a single spike doesn't page anyone.
//
// Active conditions become Alerts in the snapshot, which is what the wall,
// the incident list and the email path already consume.

import fs from "node:fs";
import path from "node:path";
import type { LiveFrame } from "./live";
import { Alert, Reading, Status } from "./status";

export interface MetricDef {
  id: string;
  label: string;
  unit: string;
  /** Per-device metrics take the worst device, and name it in the alert. */
  read: (f: LiveFrame) => { value: number; device?: string } | null;
}

const worstOf = <T,>(items: T[], value: (t: T) => number | null | undefined, name: (t: T) => string) => {
  let best: { value: number; device?: string } | null = null;
  for (const item of items) {
    const v = value(item);
    if (v !== null && v !== undefined && Number.isFinite(v) && (!best || v > best.value)) best = { value: v, device: name(item) };
  }
  return best;
};
const scalar = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : { value: v });

export const METRICS: MetricDef[] = [
  { id: "cpu.total", label: "CPU utilisation", unit: "%", read: f => scalar(f.cpu?.total) },
  { id: "cpu.iowait", label: "CPU I/O wait", unit: "%", read: f => scalar(f.cpu?.iowait) },
  { id: "cpu.steal", label: "CPU steal", unit: "%", read: f => scalar(f.cpu?.steal) },
  { id: "load.per_cpu", label: "Load (1 min) per logical CPU", unit: "", read: f => scalar(f.load && f.cpu ? f.load[0] / Math.max(1, f.cpu.cores.length) : null) },
  { id: "mem.used_percent", label: "Memory in use", unit: "%", read: f => scalar(f.mem ? (100 * f.mem.used) / f.mem.total : null) },
  { id: "swap.used_percent", label: "Swap in use", unit: "%", read: f => scalar(f.mem && f.mem.swapTotal ? (100 * f.mem.swapUsed) / f.mem.swapTotal : null) },
  { id: "psi.cpu.some", label: "CPU pressure (some)", unit: "%", read: f => scalar(f.psi?.cpu.some) },
  { id: "psi.memory.some", label: "Memory pressure (some)", unit: "%", read: f => scalar(f.psi?.memory.some) },
  { id: "psi.memory.full", label: "Memory pressure (full)", unit: "%", read: f => scalar(f.psi?.memory.full) },
  { id: "psi.io.some", label: "I/O pressure (some)", unit: "%", read: f => scalar(f.psi?.io.some) },
  { id: "psi.io.full", label: "I/O pressure (full)", unit: "%", read: f => scalar(f.psi?.io.full) },
  { id: "disk.busy", label: "Disk active time (any disk)", unit: "%", read: f => worstOf(f.disks, d => d.busyPercent, d => d.name) },
  { id: "disk.latency", label: "Disk response time (any disk)", unit: " ms", read: f => worstOf(f.disks, d => d.latencyMs, d => d.name) },
  { id: "net.rx_mbps", label: "Network receive (any NIC)", unit: " Mbps", read: f => worstOf(f.nets, n => (n.rxBps * 8) / 1e6, n => n.name) },
  { id: "net.tx_mbps", label: "Network send (any NIC)", unit: " Mbps", read: f => worstOf(f.nets, n => (n.txBps * 8) / 1e6, n => n.name) },
  { id: "net.errors", label: "Network errors (any NIC)", unit: "/s", read: f => worstOf(f.nets, n => n.errorsPerSec, n => n.name) },
  { id: "net.drops", label: "Network drops (any NIC)", unit: "/s", read: f => worstOf(f.nets, n => n.dropsPerSec, n => n.name) },
  { id: "temp.max", label: "Hottest temperature sensor", unit: " °C", read: f => (f.temps ? worstOf(Object.entries(f.temps), ([, v]) => v, ([k]) => k) : null) },
  { id: "gpu.temp", label: "GPU temperature", unit: " °C", read: f => worstOf(f.gpus, g => g.temperatureC, g => `GPU ${g.index}`) },
  { id: "gpu.util", label: "GPU utilisation", unit: "%", read: f => worstOf(f.gpus, g => g.utilPercent, g => `GPU ${g.index}`) },
  { id: "gpu.mem_percent", label: "GPU memory in use", unit: "%", read: f => worstOf(f.gpus, g => (g.memUsedBytes !== null && g.memTotalBytes ? (100 * g.memUsedBytes) / g.memTotalBytes : null), g => `GPU ${g.index}`) },
];

export interface Condition {
  id: string;
  name: string;
  metric: string;
  operator: ">" | "<";
  threshold: number;
  forSeconds: number;
  severity: "WARNING" | "CRITICAL";
  enabled: boolean;
}

export const DEFAULT_CONDITIONS: Condition[] = [
  { id: "cpu-high", name: "CPU saturated", metric: "cpu.total", operator: ">", threshold: 90, forSeconds: 300, severity: "WARNING", enabled: true },
  { id: "iowait-high", name: "CPU stalled on storage", metric: "cpu.iowait", operator: ">", threshold: 25, forSeconds: 300, severity: "WARNING", enabled: true },
  { id: "load-high", name: "Run queue longer than the CPU count", metric: "load.per_cpu", operator: ">", threshold: 1.5, forSeconds: 600, severity: "WARNING", enabled: true },
  { id: "mem-high", name: "Memory nearly exhausted", metric: "mem.used_percent", operator: ">", threshold: 90, forSeconds: 300, severity: "WARNING", enabled: true },
  { id: "mem-critical", name: "Memory exhausted", metric: "mem.used_percent", operator: ">", threshold: 97, forSeconds: 60, severity: "CRITICAL", enabled: true },
  { id: "swap-high", name: "Heavy swapping", metric: "swap.used_percent", operator: ">", threshold: 50, forSeconds: 600, severity: "WARNING", enabled: true },
  { id: "psi-mem-full", name: "Tasks stalled on memory", metric: "psi.memory.full", operator: ">", threshold: 10, forSeconds: 60, severity: "CRITICAL", enabled: true },
  { id: "psi-io", name: "I/O pressure", metric: "psi.io.some", operator: ">", threshold: 40, forSeconds: 300, severity: "WARNING", enabled: true },
  { id: "disk-busy", name: "Disk saturated", metric: "disk.busy", operator: ">", threshold: 95, forSeconds: 900, severity: "WARNING", enabled: true },
  { id: "disk-latency", name: "Disk responding slowly", metric: "disk.latency", operator: ">", threshold: 250, forSeconds: 300, severity: "WARNING", enabled: true },
  { id: "net-errors", name: "Network interface errors", metric: "net.errors", operator: ">", threshold: 1, forSeconds: 300, severity: "WARNING", enabled: true },
  { id: "temp-high", name: "Running hot", metric: "temp.max", operator: ">", threshold: 90, forSeconds: 120, severity: "WARNING", enabled: true },
  { id: "gpu-temp", name: "GPU running hot", metric: "gpu.temp", operator: ">", threshold: 85, forSeconds: 120, severity: "WARNING", enabled: true },
];

export function validateConditions(input: unknown): Condition[] | string {
  if (!Array.isArray(input)) return "Expected a list of conditions.";
  if (input.length > 100) return "At most 100 conditions.";
  const seen = new Set<string>();
  const out: Condition[] = [];
  for (const [i, raw] of input.entries()) {
    const c = raw as Partial<Condition>;
    const where = `Condition ${i + 1}`;
    if (typeof c.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(c.id)) return `${where}: id must be 1–40 lowercase letters, digits or dashes.`;
    if (seen.has(c.id)) return `${where}: duplicate id ${c.id}.`;
    seen.add(c.id);
    if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 80) return `${where}: name is required (max 80 characters).`;
    if (!METRICS.some(m => m.id === c.metric)) return `${where}: unknown metric ${String(c.metric)}.`;
    if (c.operator !== ">" && c.operator !== "<") return `${where}: operator must be > or <.`;
    if (typeof c.threshold !== "number" || !Number.isFinite(c.threshold)) return `${where}: threshold must be a number.`;
    if (!Number.isInteger(c.forSeconds) || c.forSeconds! < 0 || c.forSeconds! > 86_400) return `${where}: duration must be 0–86400 seconds.`;
    if (c.severity !== "WARNING" && c.severity !== "CRITICAL") return `${where}: severity must be WARNING or CRITICAL.`;
    out.push({ id: c.id, name: c.name.trim(), metric: c.metric!, operator: c.operator, threshold: c.threshold, forSeconds: c.forSeconds!, severity: c.severity, enabled: c.enabled !== false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface ConditionState {
  id: string;
  value: number | null;
  device: string | null;
  /** When the metric first crossed the threshold in the current run; null when not breaching. */
  breachingSince: number | null;
  /** When the condition fired (breach sustained for forSeconds). */
  firingSince: number | null;
  /** While firing: when the value went back inside the threshold. */
  clearSince: number | null;
  lastSeen: number | null;
}

/** How long a firing condition must be clear before it resolves, so a value hovering at the line doesn't flap. */
export const CLEAR_AFTER_MS = 30_000;
/** No sample for this long and the condition reports no data instead of keeping its last state. */
export const NO_DATA_AFTER_MS = 30_000;

export function evaluate(condition: Condition, prev: ConditionState | undefined, frame: LiveFrame): ConditionState {
  const metric = METRICS.find(m => m.id === condition.metric);
  const reading = metric?.read(frame) ?? null;
  const st: ConditionState = prev ? { ...prev } : { id: condition.id, value: null, device: null, breachingSince: null, firingSince: null, clearSince: null, lastSeen: null };
  if (!reading) {
    // Missing data neither fires nor clears a condition; staleness is judged on read.
    st.value = null;
    return st;
  }
  st.value = reading.value;
  st.device = reading.device ?? null;
  st.lastSeen = frame.ts;
  const breaching = condition.operator === ">" ? reading.value > condition.threshold : reading.value < condition.threshold;
  if (breaching) {
    st.breachingSince ??= frame.ts;
    if (st.firingSince === null && frame.ts - st.breachingSince >= condition.forSeconds * 1000) st.firingSince = frame.ts;
    st.clearSince = null;
  } else {
    st.breachingSince = null;
    if (st.firingSince !== null) {
      st.clearSince ??= frame.ts;
      if (frame.ts - st.clearSince >= CLEAR_AFTER_MS) { st.firingSince = null; st.clearSince = null; }
    }
  }
  return st;
}

// ---------------------------------------------------------------------------
// Engine (persistence + subscription to the live sampler)
// ---------------------------------------------------------------------------

function storePath(): string {
  return path.resolve(process.cwd(), "..", process.env.ALERT_CONDITIONS_PATH ?? "var/alert-conditions.json");
}

const runtime = globalThis as typeof globalThis & {
  __streamanatorConditions?: { conditions: Condition[]; states: Map<string, ConditionState>; customised: boolean; started?: boolean };
};

function engine() {
  if (!runtime.__streamanatorConditions) {
    let conditions = DEFAULT_CONDITIONS;
    let customised = false;
    try {
      const parsed = validateConditions(JSON.parse(fs.readFileSync(storePath(), "utf8")));
      if (typeof parsed !== "string") { conditions = parsed; customised = true; }
      else console.error(`alert conditions file ignored: ${parsed}`);
    } catch { /* absent: defaults */ }
    runtime.__streamanatorConditions = { conditions, states: new Map(), customised };
  }
  return runtime.__streamanatorConditions;
}

export function getConditions() {
  const e = engine();
  return { conditions: e.conditions, customised: e.customised, states: e.conditions.map(c => e.states.get(c.id) ?? null) };
}

export function saveConditions(conditions: Condition[]) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(conditions, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  const e = engine();
  e.conditions = conditions;
  e.customised = true;
  // Keep state for unchanged conditions so editing one doesn't reset the timers on the others.
  for (const id of [...e.states.keys()]) if (!conditions.some(c => c.id === id)) e.states.delete(id);
}

export function startConditionEngine(subscribe: (listener: (frame: LiveFrame) => void) => () => void) {
  const e = engine();
  if (e.started) return;
  e.started = true;
  subscribe(frame => {
    for (const c of e.conditions) {
      if (!c.enabled) { e.states.delete(c.id); continue; }
      e.states.set(c.id, evaluate(c, e.states.get(c.id), frame));
    }
  });
}

const fmt = (v: number, unit: string) => `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}${unit}`;

/** Readings and alerts for the snapshot's "Alert conditions" component. */
export function conditionFindings(now = Date.now()): { readings: Reading[]; alerts: Alert[] } {
  const e = engine();
  const readings: Reading[] = [];
  const alerts: Alert[] = [];
  for (const c of e.conditions.filter(c => c.enabled)) {
    const metric = METRICS.find(m => m.id === c.metric)!;
    const st = e.states.get(c.id);
    const key = `condition.${c.id}`;
    if (!st || st.lastSeen === null) {
      // This host has never produced the metric (no GPU, no sensors): not
      // applicable, so it must not hold the score at UNKNOWN forever.
      readings.push(new Reading({ key, label: c.name, status: Status.UNKNOWN, detail: `${metric.label} is not reported by this host.`, source: "live", optional: true }));
      continue;
    }
    if (now - st.lastSeen > NO_DATA_AFTER_MS) {
      // It used to report and stopped: that IS unknown, and counts.
      readings.push(Reading.no_data(key, c.name, `${metric.label} has not been sampled since ${new Date(st.lastSeen).toLocaleTimeString()}.`, "live"));
      continue;
    }
    const where = st.device ? ` on ${st.device}` : "";
    const rule = `${c.operator} ${fmt(c.threshold, metric.unit)} for ${c.forSeconds >= 60 ? `${c.forSeconds / 60} min` : `${c.forSeconds} s`}`;
    const firing = st.firingSince !== null;
    readings.push(new Reading({
      key, label: c.name, value: st.value === null ? null : Number(st.value.toFixed(2)), unit: metric.unit.trim(),
      status: firing ? (c.severity === "CRITICAL" ? Status.CRITICAL : Status.WARNING) : Status.HEALTHY,
      detail: firing ? `${metric.label}${where} has been ${rule.replace(/ for .*/, "")} since ${new Date(st.breachingSince ?? st.firingSince!).toLocaleTimeString()}.` : `Rule: ${metric.label} ${rule}.`,
      source: "live",
    }));
    if (firing) {
      alerts.push(new Alert({
        key, status: c.severity === "CRITICAL" ? Status.CRITICAL : Status.WARNING, title: c.name, component: "Alert conditions",
        detail: `${metric.label}${where} is ${st.value === null ? "unknown" : fmt(st.value, metric.unit)}.`,
        current_value: st.value === null ? "" : fmt(st.value, metric.unit),
        threshold: rule,
        since: (st.breachingSince ?? st.firingSince!) / 1000,
        recommended_action: "Open Task Manager and Processes to see what is driving it.",
      }));
    }
  }
  return { readings, alerts };
}
