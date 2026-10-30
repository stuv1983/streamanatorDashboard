import { NextResponse } from "next/server";
import { getServiceInventory } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getServiceInventory());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
