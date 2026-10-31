import { NextResponse } from "next/server";
import { getConditions, METRICS } from "@/lib/conditions";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...getConditions(), metrics: METRICS.map(({ id, label, unit }) => ({ id, label, unit })) });
}
