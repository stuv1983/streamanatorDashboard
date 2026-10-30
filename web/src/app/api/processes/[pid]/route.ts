import { NextResponse } from "next/server";
import { getProcessDetail } from "@/lib/processes";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ pid: string }> }) {
  const pid = Number((await params).pid);
  if (!Number.isInteger(pid) || pid < 1) return NextResponse.json({ error: "Invalid pid." }, { status: 400 });
  const detail = await getProcessDetail(pid);
  if (!detail) return NextResponse.json({ error: `PID ${pid} is not running.` }, { status: 404 });
  return NextResponse.json(detail);
}
