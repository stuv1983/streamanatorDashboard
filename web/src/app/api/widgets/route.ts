import { NextResponse } from "next/server";
import { getSettings } from "@/lib/config";
import { getWidgetData } from "@/lib/widgets";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getWidgetData(getSettings()));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
