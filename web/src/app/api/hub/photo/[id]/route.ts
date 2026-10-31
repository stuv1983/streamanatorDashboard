import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/config";
import { fetchPhoto, isAllowedPhoto } from "@/lib/hub/hub";

export const dynamic = "force-dynamic";

/** Proxies one album photo from Immich so the kiosk never holds the API key. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const settings = getSettings();
  if (!await isAllowedPhoto(settings, id)) return NextResponse.json({ error: "Not an album photo." }, { status: 404 });
  try {
    const upstream = await fetchPhoto(settings, id);
    if (!upstream.ok || !upstream.body) return NextResponse.json({ error: `Immich HTTP ${upstream.status}` }, { status: 502 });
    return new NextResponse(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Immich did not answer." }, { status: 504 });
  }
}
