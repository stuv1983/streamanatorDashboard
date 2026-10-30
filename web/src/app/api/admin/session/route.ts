import { NextResponse } from "next/server";
import { isAdminAuthenticated, sessionIsConfigured } from "@/lib/admin-session";
import { getSettings } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Lets client pages decide whether to offer admin controls; the APIs re-check on every call. */
export async function GET() {
  return NextResponse.json({
    configured: sessionIsConfigured(),
    authenticated: sessionIsConfigured() && await isAdminAuthenticated(),
    actionsEnabled: getSettings().auth.actions_enabled,
  });
}
