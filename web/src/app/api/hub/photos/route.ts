import { NextResponse } from "next/server";
import { getSettings } from "@/lib/config";
import { getPhotoIds } from "@/lib/hub/hub";

export const dynamic = "force-dynamic";

/** Album photo ids in a fresh random order on every call. */
export async function GET() {
  const { ids, error } = await getPhotoIds(getSettings());
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return NextResponse.json({ ids: shuffled, error });
}
