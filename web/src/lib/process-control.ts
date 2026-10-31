// Signal and renice, gated three ways:
//   1. the caller holds an admin session AND re-enters the password (step-up);
//   2. the target is matched on pid AND start time, so a pid that was
//      recycled between page load and click is refused rather than killed;
//   3. protectionReason() — the same rule the table uses to grey out buttons.
// The process runs unprivileged, so the kernel enforces a fourth: only this
// account's own processes can be signalled, and nice can only go up.

import os from "node:os";
import { getProcessTable, protectionReason, type ProcessRow } from "./processes";

export const ALLOWED_SIGNALS = ["SIGTERM", "SIGKILL", "SIGHUP", "SIGINT", "SIGSTOP", "SIGCONT"] as const;
export type AllowedSignal = typeof ALLOWED_SIGNALS[number];

export type ControlRequest =
  | { action: "signal"; pid: number; startedAt: number; signal: AllowedSignal }
  | { action: "renice"; pid: number; startedAt: number; nice: number };

export type ControlResult = { ok: true; message: string } | { ok: false; status: number; message: string };

export function parseControlRequest(body: unknown): ControlRequest | string {
  if (!body || typeof body !== "object") return "Expected a JSON object.";
  const b = body as Record<string, unknown>;
  const pid = Number(b.pid);
  const startedAt = Number(b.startedAt);
  if (!Number.isInteger(pid) || pid <= 1) return "pid must be an integer greater than 1.";
  if (!Number.isFinite(startedAt)) return "startedAt is required so a recycled pid cannot be hit by mistake.";
  if (b.action === "signal") {
    if (!ALLOWED_SIGNALS.includes(b.signal as AllowedSignal)) return `signal must be one of ${ALLOWED_SIGNALS.join(", ")}.`;
    return { action: "signal", pid, startedAt, signal: b.signal as AllowedSignal };
  }
  if (b.action === "renice") {
    const nice = Number(b.nice);
    if (!Number.isInteger(nice) || nice < -20 || nice > 19) return "nice must be an integer from -20 to 19.";
    return { action: "renice", pid, startedAt, nice };
  }
  return "action must be 'signal' or 'renice'.";
}

/** Start times are derived from clock ticks; allow one tick of rounding. */
export function sameProcess(row: Pick<ProcessRow, "startedAt">, startedAt: number): boolean {
  return row.startedAt !== null && Math.abs(row.startedAt - startedAt) <= 0.02;
}

export async function executeControl(request: ControlRequest): Promise<ControlResult> {
  const table = await getProcessTable(0);
  const row = table.processes.find(p => p.pid === request.pid);
  if (!row) return { ok: false, status: 404, message: `PID ${request.pid} is no longer running.` };
  if (!sameProcess(row, request.startedAt)) {
    return { ok: false, status: 409, message: `PID ${request.pid} now belongs to a different process (${row.name}). Refresh and try again.` };
  }
  const reason = protectionReason(row, table.selfUid);
  if (reason) return { ok: false, status: 403, message: reason };

  try {
    if (request.action === "signal") {
      process.kill(row.pid, request.signal);
      return { ok: true, message: `Sent ${request.signal} to ${row.name} (PID ${row.pid}).` };
    }
    // Unprivileged accounts may only lower priority (raise nice). Say so
    // rather than surfacing EACCES.
    if (request.nice < row.nice) {
      return { ok: false, status: 403, message: `Lowering nice from ${row.nice} to ${request.nice} needs root; the dashboard can only lower a process's priority.` };
    }
    os.setPriority(row.pid, request.nice);
    return { ok: true, message: `Set nice ${request.nice} on ${row.name} (PID ${row.pid}); it was ${row.nice}.` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: false, status: 404, message: `PID ${row.pid} exited before the action ran.` };
    if (code === "EPERM" || code === "EACCES") return { ok: false, status: 403, message: "The kernel refused: this account lacks permission for that process." };
    return { ok: false, status: 500, message: error instanceof Error ? error.message : String(error) };
  }
}
