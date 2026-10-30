// Server-only helper for admin session cookies.
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "admin_session";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

function getSecret(): Uint8Array {
  const raw = process.env.ADMIN_SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error("ADMIN_SESSION_SECRET must be at least 32 characters");
  }
  return new TextEncoder().encode(raw);
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, getSecret());
    return true;
  } catch {
    return false;
  }
}

export async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.ADMIN_SECURE_COOKIE === "true",
    sameSite: "lax",
    maxAge: SESSION_DURATION_SECONDS,
    path: "/",
  });
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function isAdminAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return false;
  return verifySessionToken(token);
}

export function getAdminPassword(): string {
  const env = process.env;
  return env.ADMIN_PASSWORD ?? "";
}

// Failed password checks, shared by login and step-up. In memory on purpose:
// a restart clears it, which is acceptable for a LAN-only tool, and it never
// writes attacker-controlled input to disk.
const failures: number[] = [];
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

export function passwordLockedOut(now = Date.now()): boolean {
  while (failures.length && now - failures[0] > FAILURE_WINDOW_MS) failures.shift();
  return failures.length >= MAX_FAILURES;
}

/** Constant-time comparison against ADMIN_PASSWORD; counts failures toward the lockout. */
export function checkAdminPassword(candidate: unknown): boolean {
  const expected = getAdminPassword();
  if (!expected || typeof candidate !== "string" || passwordLockedOut()) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) failures.push(Date.now());
  return ok;
}

export function sessionIsConfigured(): boolean {
  return Boolean(getAdminPassword() && process.env.ADMIN_SESSION_SECRET && process.env.ADMIN_SESSION_SECRET.length >= 32);
}
