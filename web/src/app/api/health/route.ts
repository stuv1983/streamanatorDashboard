import { NextResponse } from "next/server";
import { getSnapshot, runtimeDiagnostics } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await getSnapshot(90);
    return NextResponse.json({ ok: true, status: snapshot.health.status, ...runtimeDiagnostics() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error), ...runtimeDiagnostics() },
      { status: 503 },
    );
  }
}
