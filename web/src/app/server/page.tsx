"use client";

import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/lib/status";
import type { Snapshot } from "@/lib/snapshot";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function StatusBadge({ status }: { status: Status }) {
  const colorMap: Record<string, string> = {
    [Status.HEALTHY]: "bg-green-500 text-white",
    [Status.INFO]: "bg-blue-500 text-white",
    [Status.WARNING]: "bg-yellow-500 text-white",
    [Status.CRITICAL]: "bg-red-500 text-white",
  };
  return (
    <Badge className={`${colorMap[status] ?? "bg-gray-500 text-white"} px-2 py-0.5 text-xs font-semibold`}>
      {status}
    </Badge>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="flex-1 min-w-[130px]">
      <CardHeader className="pb-1 pt-4 px-4">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{label}</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <p className="text-2xl font-bold">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function humanDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "â€”";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 && d === 0) parts.push(`${m}m`);
  return parts.join(" ") || "<1m";
}

function humanBytes(bytes: number): string {
  if (bytes == null) return "â€”";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

export default function ServerPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, {
    refreshInterval: 60000,
    keepPreviousData: true,
  });

  if (error) return <div className="text-red-500 py-10">Failed to load snapshot: {String(error)}</div>;
  if (isLoading && !data) return <Skeleton className="h-96 w-full" />;

  const snapshot = data!;
  const raw = (snapshot.raw?.server ?? {}) as Record<string, any>;
  const hostSnap = raw.snapshot ?? null;
  const cpu = hostSnap?.cpu ?? null;
  const memory = hostSnap?.memory ?? null;
  const load = hostSnap?.load ?? null;
  const component = snapshot.components?.server;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Server</h1>
        <p className="text-muted-foreground mt-1">Host health</p>
      </div>

      {/* KPI Row */}
      <div className="flex flex-wrap gap-3">
        <MetricCard label="CPU" value={cpu ? `${(cpu.usedPercent as number)?.toFixed(1)}%` : "â€”"} sub="excl. iowait" />
        <MetricCard label="iowait" value={cpu ? `${(cpu.iowaitPercent as number)?.toFixed(1)}%` : "â€”"} />
        <MetricCard label="RAM available" value={memory ? `${(memory.availablePercent as number)?.toFixed(1)}%` : "â€”"} />
        <MetricCard label="Swap" value={memory ? `${(memory.swap_usedPercent as number)?.toFixed(1)}%` : "â€”"} />
        <MetricCard
          label="Load (1/5/15)"
          value={load ? `${(load.one as number)?.toFixed(2)} / ${(load.five as number)?.toFixed(2)} / ${(load.fifteen as number)?.toFixed(2)}` : "â€”"}
        />
        <MetricCard
          label="Uptime"
          value={hostSnap?.uptimeSeconds ? humanDuration(hostSnap.uptimeSeconds as number) : "â€”"}
        />
        <MetricCard
          label="Processes"
          value={hostSnap?.processCount ? (hostSnap.processCount as number).toLocaleString() : "â€”"}
        />
      </div>

      {/* Memory breakdown */}
      {memory && (
        <Card>
          <CardHeader><CardTitle className="text-base">Memory breakdown</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {([
                ["Total", memory.totalBytes],
                ["Available", memory.availableBytes],
                ["Used", memory.usedBytes],
                ["Cache + buffers", memory.cachedBytes],
              ] as [string, number][]).map(([label, val]) => (
                <div key={label}>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="font-bold">{humanBytes(val)}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Cache is reclaimable memory doing useful work â€” availability is judged on MemAvailable, not free memory.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Temperatures */}
      {hostSnap?.temperatures && Object.keys(hostSnap.temperatures as object).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Temperatures</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-xs border-b">
                  <th className="text-left py-1 pr-4">Sensor</th>
                  <th className="text-left py-1">Temperature</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(hostSnap.temperatures as Record<string, number>).map(([sensor, temp]) => (
                  <tr key={sensor} className="border-b border-border/40 last:border-0">
                    <td className="py-1.5 pr-4 font-medium">{sensor}</td>
                    <td className="py-1.5">{temp.toFixed(1)} Â°C</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* systemd */}
      <div>
        <h2 className="text-xl font-semibold mb-3">systemd</h2>
        {hostSnap?.failedUnits == null ? (
          <div className="text-yellow-500 text-sm">systemd could not be queried.</div>
        ) : (hostSnap.failedUnits as any[]).length === 0 ? (
          <div className="text-green-500 text-sm">âœ“ No failed units.</div>
        ) : (
          <div className="space-y-2">
            <div className="text-red-500 text-sm">{(hostSnap.failedUnits as any[]).length} failed unit(s)</div>
            {(hostSnap.failedUnits as any[]).map((unit) => (
              <Card key={unit.name} className="border-red-500/30">
                <CardHeader className="pb-1">
                  <CardTitle className="text-sm text-red-500">{unit.name}</CardTitle>
                  {unit.description && <p className="text-xs text-muted-foreground">{unit.description}</p>}
                </CardHeader>
                <CardContent className="text-xs space-y-0.5">
                  <p><span className="font-medium">Load:</span> {unit.load_state}</p>
                  <p><span className="font-medium">Active:</span> {unit.active_state}</p>
                  <p><span className="font-medium">Sub:</span> {unit.sub_state}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Readings table */}
      {component?.readings && (component.readings as any[]).length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-3">Health readings</h2>
          <Card>
            <CardContent className="pt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b">
                    <th className="text-left py-1 pr-4">Metric</th>
                    <th className="text-left py-1 pr-4">Value</th>
                    <th className="text-left py-1">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(component.readings as any[]).map((r) => (
                    <tr key={r.key} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-4 font-medium">{r.label}</td>
                      <td className="py-1.5 pr-4 font-mono text-xs">{r.value ?? "â€”"}{r.unit ?? ""}</td>
                      <td className="py-1.5"><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

