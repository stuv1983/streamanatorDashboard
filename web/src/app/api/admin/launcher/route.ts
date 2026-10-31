import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { isAdminAuthenticated } from "@/lib/admin-session";
import { getSettings } from "@/lib/config";
import { MAX_BOOKMARKS, validateBookmark, writeBookmarks, type Bookmark } from "@/lib/launcher";

export const dynamic = "force-dynamic";

/** Replace the /home bookmarks. Built-in service tiles come from config and are not editable here. */
export async function PUT(request: NextRequest) {
  const remote = request.headers.get("x-forwarded-for") ?? null;
  if (!await isAdminAuthenticated()) {
    return NextResponse.json({ error: "Sign in to Admin first." }, { status: 401 });
  }

  let body: { bookmarks?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Expected JSON." }, { status: 400 }); }
  if (!Array.isArray(body.bookmarks)) return NextResponse.json({ error: "bookmarks must be a list." }, { status: 400 });
  if (body.bookmarks.length > MAX_BOOKMARKS) return NextResponse.json({ error: `At most ${MAX_BOOKMARKS} bookmarks.` }, { status: 400 });

  const bookmarks: Bookmark[] = [];
  for (const input of body.bookmarks) {
    const result = validateBookmark(input);
    if (typeof result === "string") return NextResponse.json({ error: result }, { status: 400 });
    bookmarks.push(result);
  }

  try {
    writeBookmarks(getSettings(), bookmarks);
  } catch (error) {
    audit({ action: "launcher.save", target: "bookmarks", outcome: "failed", detail: String(error), remote });
    return NextResponse.json({ error: "Could not write the bookmarks file." }, { status: 500 });
  }
  audit({ action: "launcher.save", target: "bookmarks", outcome: "success", detail: `${bookmarks.length} bookmarks`, remote });
  return NextResponse.json({ ok: true, count: bookmarks.length });
}
