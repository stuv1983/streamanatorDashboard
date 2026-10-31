import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-session";
import { readAudit } from "@/lib/audit";
import { getHistoryStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const days = Math.min(400, Math.max(1, Number(request.nextUrl.searchParams.get("days")) || 7));
  const since = Date.now() / 1000 - days * 86400;
  const events = getHistoryStore().recentEvents(2000, since);
  // The audit trail names who did what; it stays behind the admin session.
  const audit = await isAdminAuthenticated() ? readAudit(300) : null;
  return NextResponse.json({ days, events, audit });
}
