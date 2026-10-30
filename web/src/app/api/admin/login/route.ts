import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createSessionToken, getAdminPassword, sessionIsConfigured } from "@/lib/admin-session";

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  const adminPassword = getAdminPassword();

  if (!sessionIsConfigured()) {
    return NextResponse.json(
      { error: "ADMIN_PASSWORD and a 32+ character ADMIN_SESSION_SECRET must be configured." },
      { status: 503 }
    );
  }

  if (typeof password !== "string" || !equalSecret(password, adminPassword)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const token = await createSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set("admin_session", token, {
    httpOnly: true,
    secure: process.env.ADMIN_SECURE_COOKIE === "true",
    sameSite: "lax",
    maxAge: 8 * 60 * 60,
    path: "/",
  });
  return res;
}
