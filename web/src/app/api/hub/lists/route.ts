import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/config";
import { getLists, parseListAction, updateLists } from "@/lib/hub/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getLists(getSettings()));
}

/** Household lists are editable from the screen without signing in; see lib/hub/store.ts. */
export async function POST(request: NextRequest) {
  const settings = getSettings();
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Expected JSON." }, { status: 400 }); }
  const action = parseListAction(body, settings.hub.lists);
  if (typeof action === "string") return NextResponse.json({ error: action }, { status: 400 });
  try {
    const result = updateLists(settings, action);
    if (typeof result === "string") return NextResponse.json({ error: result, ...getLists(settings) }, { status: 409 });
    return NextResponse.json(result);
  } catch (error) {
    console.error("hub list write failed", error);
    return NextResponse.json({ error: "Could not save the list." }, { status: 500 });
  }
}
