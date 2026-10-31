import { NextRequest, NextResponse } from "next/server";
import { getHistoryStore, startSampler } from "@/lib/runtime";
import {
  M_CPU,
  M_IOWAIT,
  M_MEM_AVAIL,
  M_LATENCY,
  M_LOSS,
  M_DISK_READ_BPS,
  M_DISK_WRITE_BPS,
  M_DISK_UTIL,
  M_NET_RX_BPS,
  M_NET_TX_BPS,
} from "@/lib/collector";

export const dynamic = "force-dynamic";

const RANGES: Record<string, number> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};

export async function GET(request: NextRequest) {
  try {
    startSampler();
    const requested = request.nextUrl.searchParams.get("range") ?? "24h";
    const range = Object.hasOwn(RANGES, requested) ? requested : "24h";
    const since = Date.now() / 1000 - RANGES[range];
    const store = getHistoryStore();
    const read = (metric: string) => store.series(metric, null, since, 50_000);
    const memoryUsed = read(M_MEM_AVAIL).map(([ts, available]) => [ts, Math.max(0, 100 - available)]);

    return NextResponse.json({
      range,
      since,
      generated_at: Date.now() / 1000,
      series: {
        cpu: read(M_CPU),
        iowait: read(M_IOWAIT),
        memory_used: memoryUsed,
        disk_read: read(M_DISK_READ_BPS),
        disk_write: read(M_DISK_WRITE_BPS),
        disk_utilisation: read(M_DISK_UTIL),
        network_rx: read(M_NET_RX_BPS),
        network_tx: read(M_NET_TX_BPS),
        latency: read(M_LATENCY),
        packet_loss: read(M_LOSS),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
