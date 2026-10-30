import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-session";
import { audit } from "@/lib/audit";
import { DEFAULT_CONDITIONS, getConditions, saveConditions, validateConditions } from "@/lib/conditions";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  if (!await isAdminAuthenticated()) return NextResponse.json({ error: "Sign in to Admin first." }, { status: 401 });
  let body: { conditions?: unknown; reset?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Expected JSON." }, { status: 400 }); }
  const parsed = body.reset ? DEFAULT_CONDITIONS : validateConditions(body.conditions);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
  saveConditions(parsed);
  audit({ action: body.reset ? "conditions.reset" : "conditions.update", target: `${parsed.length} conditions`, outcome: "success", remote: request.headers.get("x-forwarded-for") });
  return NextResponse.json(getConditions());
}
