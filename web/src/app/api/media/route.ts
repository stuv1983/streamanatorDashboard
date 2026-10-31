import { NextResponse } from "next/server";
import { getSettings } from "@/lib/config";
import { getMediaOverview } from "@/lib/integrations";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getMediaOverview(getSettings()));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
