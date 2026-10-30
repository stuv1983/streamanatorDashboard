// systemd units, timers and recent journal errors.
//
// All read-only, all through systemctl/journalctl JSON output (systemd ≥ 250).
// The dashboard account is in the `adm` group, which is what lets it read the
// system journal; without that, journal errors come back as unavailable.

import { runCommand } from "./system";

export interface ServiceRow {
  unit: string;
  description: string;
  load: string;
  active: string;
  sub: string;
  enabled: string | null;
  mainPid: number | null;
  memoryBytes: number | null;
  tasks: number | null;
  /** Share of one CPU between the last two reads; null on the first read. */
  cpuPercent: number | null;
  restarts: number | null;
  activeSince: number | null;
}

export interface TimerRow {
  unit: string;
  activates: string;
  nextRun: number | null;
  lastRun: number | null;
}

export interface JournalError {
  ts: number;
  unit: string;
  priority: number;
  message: string;
}

export interface ServiceInventory {
  collectedAt: number;
  services: ServiceRow[];
  timers: TimerRow[];
  errors: JournalError[] | null;
  errorsUnavailable: string | null;
}

const SHOW_PROPS = "Id,Description,MainPID,MemoryCurrent,CPUUsageNSec,TasksCurrent,NRestarts,ActiveEnterTimestamp,UnitFileState";

/** Parse `systemctl show` output: KEY=value lines, units separated by blank lines. */
export function parseSystemctlShow(text: string): Array<Record<string, string>> {
  return text.split(/\n\s*\n/).map(block => {
    const out: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }).filter(b => b.Id);
}

/** systemd prints "[not set]" or a uint64 max sentinel for counters it isn't tracking. */
export function systemdNumber(value: string | undefined): number | null {
  if (!value || value === "[not set]" || value === "18446744073709551615") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const microsToSeconds = (v: number | null | undefined) => (v ? v / 1_000_000 : null);

const state = globalThis as typeof globalThis & {
  __streamanatorServices?: { at: number; cpu: Map<string, number>; value?: ServiceInventory; pending?: Promise<ServiceInventory> };
};

async function collect(): Promise<ServiceInventory> {
  const previous = state.__streamanatorServices;
  const now = Date.now();
  const [[listCode, listOut], [showCode, showOut], [timerCode, timerOut], [jCode, jOut, jErr]] = await Promise.all([
    runCommand(["systemctl", "list-units", "--type=service", "--all", "--output=json", "--no-pager"], 8),
    runCommand(["systemctl", "show", "*.service", `-p${SHOW_PROPS}`, "--timestamp=unix", "--no-pager"], 8),
    runCommand(["systemctl", "list-timers", "--all", "--output=json", "--no-pager"], 8),
    runCommand(["journalctl", "-p", "err", "--since", "-24h", "-o", "json", "--no-pager", "-n", "500",
      "--output-fields=MESSAGE,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY"], 10),
  ]);

  const shown = new Map<string, Record<string, string>>();
  if (showCode === 0) for (const b of parseSystemctlShow(showOut)) shown.set(b.Id, b);

  const cpu = new Map<string, number>();
  const elapsed = previous ? (now - previous.at) / 1000 : 0;
  let services: ServiceRow[] = [];
  if (listCode === 0) {
    const units = JSON.parse(listOut) as Array<{ unit: string; load: string; active: string; sub: string; description: string }>;
    services = units.map(u => {
      const s = shown.get(u.unit) ?? {};
      const cpuNs = systemdNumber(s.CPUUsageNSec);
      if (cpuNs !== null) cpu.set(u.unit, cpuNs);
      const before = previous?.cpu.get(u.unit);
      // --timestamp=unix prints "@1793393717"; locale-formatted dates don't parse portably.
      const since = Number(/^@(\d+)/.exec(s.ActiveEnterTimestamp ?? "")?.[1]);
      return {
        unit: u.unit,
        description: u.description,
        load: u.load,
        active: u.active,
        sub: u.sub,
        enabled: s.UnitFileState || null,
        mainPid: systemdNumber(s.MainPID) || null,
        memoryBytes: systemdNumber(s.MemoryCurrent),
        tasks: systemdNumber(s.TasksCurrent),
        cpuPercent: cpuNs !== null && before !== undefined && elapsed > 0 && elapsed < 120
          ? Math.round((1000 * Math.max(0, cpuNs - before)) / 1e9 / elapsed) / 10 : null,
        restarts: systemdNumber(s.NRestarts),
        activeSince: since > 0 ? since : null,
      };
    });
  }

  const timers: TimerRow[] = timerCode === 0
    ? (JSON.parse(timerOut) as Array<{ unit: string; activates: string; next: number | null; last: number | null }>).map(t => ({
        unit: t.unit, activates: t.activates, nextRun: microsToSeconds(t.next), lastRun: microsToSeconds(t.last),
      }))
    : [];

  let errors: JournalError[] | null = null;
  let errorsUnavailable: string | null = null;
  if (jCode === 0) {
    errors = [];
    for (const line of jOut.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, string | number[]>;
        // journald encodes non-UTF-8 messages as byte arrays.
        const message = Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE).toString("utf8") : String(e.MESSAGE ?? "");
        errors.push({
          ts: Number(e.__REALTIME_TIMESTAMP) / 1_000_000,
          unit: String(e._SYSTEMD_UNIT ?? e.SYSLOG_IDENTIFIER ?? "kernel"),
          priority: Number(e.PRIORITY ?? 3),
          message: message.slice(0, 500),
        });
      } catch { /* a truncated line at the -n limit */ }
    }
    errors.reverse();
  } else {
    errorsUnavailable = /permission|not seeing messages/i.test(jErr)
      ? "The dashboard account cannot read the system journal. Add it to the adm or systemd-journal group."
      : `journalctl failed: ${jErr.trim().slice(0, 200)}`;
  }

  state.__streamanatorServices = { at: now, cpu };
  return { collectedAt: now / 1000, services, timers, errors, errorsUnavailable };
}

export async function getServiceInventory(maxAgeMs = 5000): Promise<ServiceInventory> {
  const cache = state.__streamanatorServices;
  if (cache?.value && Date.now() - cache.at < maxAgeMs) return cache.value;
  if (cache?.pending) return cache.pending;
  const pending = collect();
  state.__streamanatorServices = { at: cache?.at ?? 0, cpu: cache?.cpu ?? new Map(), pending };
  try {
    const value = await pending;
    state.__streamanatorServices = { ...state.__streamanatorServices!, value, pending: undefined };
    return value;
  } catch (error) {
    if (state.__streamanatorServices) state.__streamanatorServices.pending = undefined;
    throw error;
  }
}
