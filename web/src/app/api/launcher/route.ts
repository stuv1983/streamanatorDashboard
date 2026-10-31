import { NextResponse } from "next/server";
import { getSettings } from "@/lib/config";
import { allTiles } from "@/lib/launcher";
import { probeHttp, probeMany } from "@/lib/probes";

export const dynamic = "force-dynamic";

const BOOKMARK_UP_STATUSES = [200, 204, 301, 302, 303, 307, 308, 401, 403];

/** Launcher tiles, each with a live up/down status. */
export async function GET() {
  const settings = getSettings();
  const tiles = allTiles(settings);
  const endpoints = new Map(settings.endpoints.map(endpoint => [endpoint.key, endpoint]));

  // Built-ins use their health endpoint and expected statuses (cached 45 s in
  // probeMany). Bookmarks only need to answer: a login page or redirect counts
  // as up, and LAN gear with self-signed certificates is not marked down for it.
  const builtins: Array<[string, string, string, number[]]> = tiles.flatMap(tile => {
    const endpoint = tile.probeKey ? endpoints.get(tile.probeKey) : undefined;
    return endpoint ? [[tile.key, tile.name, endpoint.url, endpoint.expect_status] as [string, string, string, number[]]] : [];
  });
  const results = [
    ...await probeMany(builtins, 5.0),
    ...await Promise.all(tiles.filter(tile => !tile.builtin).map(tile =>
      probeHttp(tile.key, tile.name, tile.url, BOOKMARK_UP_STATUSES, 5.0, false))),
  ];
  const byKey = new Map(results.map(result => [result.key, result]));

  return NextResponse.json({
    tiles: tiles.map(tile => {
      const probe = byKey.get(tile.key);
      return {
        ...tile,
        up: probe ? probe.success : null,
        latency_ms: probe?.latency_ms ?? null,
        error: probe && !probe.success ? probe.error : "",
      };
    }),
    collectedAt: Date.now() / 1000,
  });
}
