import { NextRequest, NextResponse } from "next/server";
import { checkAdminPassword, createSessionToken, passwordLockedOut, sessionIsConfigured } from "@/lib/admin-session";

export async function POST(req: NextRequest) {
  const { password } = await req.json();

  if (!sessionIsConfigured()) {
    return NextResponse.json(
      { error: "ADMIN_PASSWORD and a 32+ character ADMIN_SESSION_SECRET must be configured." },
      { status: 503 }
    );
  }

  if (passwordLockedOut()) {
    return NextResponse.json({ error: "Too many failed attempts. Try again in 15 minutes." }, { status: 429 });
  }

  if (!checkAdminPassword(password)) {
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
