import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { checkAdminPassword, isAdminAuthenticated, passwordLockedOut } from "@/lib/admin-session";
import { getSettings } from "@/lib/config";
import { executeControl, parseControlRequest } from "@/lib/process-control";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const remote = request.headers.get("x-forwarded-for") ?? null;
  if (!await isAdminAuthenticated()) {
    return NextResponse.json({ error: "Sign in to Admin first." }, { status: 401 });
  }
  if (!getSettings().auth.actions_enabled) {
    return NextResponse.json({ error: "ADMIN_ACTIONS_ENABLED=false: process control is switched off." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Expected JSON." }, { status: 400 }); }

  const parsed = parseControlRequest(body);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  const target = `pid ${parsed.pid}`;
  const action = parsed.action === "signal" ? `process.${parsed.signal}` : `process.renice ${parsed.nice}`;

  // Step-up: a session cookie left open on a shared screen is not enough to
  // kill something. The password is checked, never logged.
  if (passwordLockedOut()) {
    audit({ action, target, outcome: "refused", detail: "password lockout active", remote });
    return NextResponse.json({ error: "Too many failed password attempts. Try again in 15 minutes." }, { status: 429 });
  }
  if (!checkAdminPassword(body.password)) {
    audit({ action, target, outcome: "refused", detail: "step-up password incorrect", remote });
    return NextResponse.json({ error: "Password incorrect." }, { status: 401 });
  }

  const result = await executeControl(parsed);
  audit({ action, target, outcome: result.ok ? "success" : result.status >= 500 ? "failed" : "refused", detail: result.message, remote });
  return result.ok
    ? NextResponse.json({ ok: true, message: result.message })
    : NextResponse.json({ error: result.message }, { status: result.status });
}
