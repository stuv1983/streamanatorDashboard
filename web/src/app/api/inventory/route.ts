import { NextResponse } from "next/server";
import { manualRefreshAllowed, publicInventoryState, refreshInventory } from "@/lib/inventory";
import { getHistoryStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(publicInventoryState());
}

/** Re-collect now. Read-only on the host; rate-limited to once a minute. */
export async function POST() {
  if (!manualRefreshAllowed()) return NextResponse.json({ error: "Inventory was refreshed less than a minute ago." }, { status: 429 });
  await refreshInventory((category, summary, detail, status) => getHistoryStore().addEvent(category, summary, detail, status));
  const state = publicInventoryState();
  return NextResponse.json(state, { status: state.lastError ? 500 : 200 });
}
