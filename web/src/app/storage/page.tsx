"use client";

import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import type { Snapshot } from "@/lib/snapshot";
import { Status } from "@/lib/status";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function StatusBadge({ status }: { status: Status }) {
  const colorMap: Record<string, string> = {
    [Status.HEALTHY]: "bg-green-500 text-white",
    [Status.INFO]: "bg-blue-500 text-white",
    [Status.WARNING]: "bg-yellow-500 text-white",
    [Status.CRITICAL]: "bg-red-500 text-white",
  };
  return <Badge className={`${colorMap[status] ?? "bg-gray-500 text-white"} px-2 py-0.5 text-xs font-semibold`}>{status}</Badge>;
}

function humanBytes(bytes: number): string {
  if (bytes == null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" });
}

export default function StoragePage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });

  if (error) return <div className="text-red-500 py-10">Failed to load snapshot: {String(error)}</div>;
  if (isLoading && !data) return <Skeleton className="h-96 w-full" />;

  const snapshot = data!;
  const raw = (snapshot.raw?.storage ?? {}) as Record<string, any>;
  const component = snapshot.components?.storage;
  const readings: any[] = (component?.readings as any[]) ?? [];
  const filesystems: any[] = raw.filesystems ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Storage</h1>
        <p className="text-muted-foreground mt-1">Filesystem capacity, growth rate and projected fill dates</p>
      </div>

      {filesystems.length === 0 && readings.length === 0 ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">No filesystem data available yet.</CardContent></Card>
      ) : (
        <div className="space-y-4">
          {readings.filter((r: any) => r.key?.startsWith("storage.")).map((reading: any) => {
            const usage = reading.extra?.usage ?? null;
            const forecast = reading.extra?.forecast ?? null;
            const pct = typeof reading.value === "number" ? reading.value : null;
            const isWarn = reading.status === Status.WARNING || reading.status === Status.CRITICAL;

            return (
              <Card key={reading.key} className={isWarn ? "border-yellow-500/50" : ""}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-mono">{reading.label ?? reading.key}</CardTitle>
                    <StatusBadge status={reading.status} />
                  </div>
                  {reading.detail && <p className="text-xs text-muted-foreground">{reading.detail}</p>}
                </CardHeader>
                <CardContent className="space-y-4">
                  {pct != null && (
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground mb-1">
                        <span>{pct}% used</span>
                        {usage && <span>{humanBytes(usage.freeBytes)} free of {humanBytes(usage.totalBytes)}</span>}
                      </div>
                      <Progress value={pct} className={`h-2 ${pct >= 90 ? "bg-red-500" : pct >= 80 ? "bg-yellow-500" : ""}`} />
                    </div>
                  )}

                  {usage && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      {([["Total", usage.totalBytes], ["Used", usage.usedBytes], ["Free", usage.freeBytes]] as [string, number][]).map(([l, v]) => (
                        <div key={l}>
                          <p className="text-xs text-muted-foreground">{l}</p>
                          <p className="font-bold">{humanBytes(v)}</p>
                        </div>
                      ))}
                      {usage.inodesUsedPercent != null && (
                        <div>
                          <p className="text-xs text-muted-foreground">Inodes used</p>
                          <p className="font-bold">{usage.inodesUsedPercent.toFixed(1)}%</p>
                        </div>
                      )}
                    </div>
                  )}

                  {forecast?.available && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t pt-4 mt-2">
                      <div>
                        <p className="text-xs text-muted-foreground">Growth</p>
                        <p className="font-bold">{humanBytes(forecast.growthBytesPerDay)}/day</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Reaches 80%</p>
                        <p className="font-bold">{formatDate(forecast.date80Percent)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Reaches 90%</p>
                        <p className="font-bold">{formatDate(forecast.date90Percent)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Full</p>
                        <p className="font-bold">{formatDate(forecast.date_full)}</p>
                      </div>
                      <p className="col-span-full text-xs text-muted-foreground">
                        Linear fit over {forecast.history_days?.toFixed(1)} days, {forecast.sample_count} samples, R²={forecast.r_squared?.toFixed(2)}
                      </p>
                    </div>
                  )}

                  {forecast && !forecast.available && forecast.reason && (
                    <p className="text-xs text-muted-foreground border-t pt-2">Forecast unavailable: {forecast.reason}</p>
                  )}

                  {forecast && (
                    <div className="grid grid-cols-3 gap-3 text-sm border-t pt-3">
                      {([["7-day growth", forecast.growthBytes7d], ["30-day growth", forecast.growthBytes30d], ["90-day growth", forecast.growthBytes90d]] as [string, number | null][]).map(([l, v]) => (
                        <div key={l}>
                          <p className="text-xs text-muted-foreground">{l}</p>
                          <p className="font-bold">{v != null ? humanBytes(v) : "—"}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

