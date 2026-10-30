import { NextResponse } from "next/server";
import { getSocketInventory } from "@/lib/processes";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getSocketInventory());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
