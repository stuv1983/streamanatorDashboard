import fs from "node:fs";
import path from "node:path";
import { getSettings } from "./config";

export interface AuditEntry {
  action: string;
  target: string;
  outcome: "success" | "refused" | "failed";
  detail?: string;
  remote?: string | null;
}

/** One line of var/audit.log, in the shape the Python version wrote. */
export interface AuditRecord {
  at: number;
  actor: string;
  action: string;
  target: string;
  outcome: string;
  severity: string;
  detail: string;
  remote?: string | null;
}

function auditPath(): string {
  const configured = getSettings().auth.audit_path;
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), "..", configured);
}

/**
 * Append one JSON line per privileged action, refused or not. Refusals are
 * recorded too: a run of refused kills is exactly the pattern worth seeing.
 * Never put request bodies in here: they can carry the step-up password.
 */
export function audit(entry: AuditEntry): void {
  const record: AuditRecord & { role: string; breakglass: boolean } = {
    at: Date.now() / 1000,
    actor: "admin",
    role: "admin",
    action: entry.action,
    outcome: entry.outcome,
    severity: entry.outcome === "success" ? "notice" : "warning",
    target: entry.target,
    detail: entry.detail ?? "",
    breakglass: false,
    remote: entry.remote ?? null,
  };
  const line = JSON.stringify(record) + "\n";
  try {
    const file = auditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch (error) {
    // The journal still gets it, so an unwritable var/ doesn't erase the trail.
    console.error("audit log write failed", error);
  }
  console.log(`[audit] ${line.trim()}`);
}

/** Newest first. Lines that are not JSON objects with a timestamp are skipped. */
export function readAudit(limit = 200): AuditRecord[] {
  let text = "";
  try { text = fs.readFileSync(auditPath(), "utf8"); } catch { return []; }
  const out: AuditRecord[] = [];
  for (const line of text.trim().split("\n").reverse()) {
    if (out.length >= limit) break;
    try {
      const r = JSON.parse(line);
      if (typeof r?.at !== "number") continue;
      out.push({ at: r.at, actor: String(r.actor ?? "?"), action: String(r.action ?? ""), target: String(r.target ?? ""), outcome: String(r.outcome ?? ""), severity: String(r.severity ?? ""), detail: String(r.detail ?? ""), remote: r.remote ?? null });
    } catch { /* not JSON */ }
  }
  return out;
}
