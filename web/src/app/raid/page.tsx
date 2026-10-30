"use client";

import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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

function humanDuration(s: number): string {
  if (!s) return "â€”";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d > 0 && `${d}d`, h > 0 && `${h}h`, m > 0 && d === 0 && `${m}m`].filter(Boolean).join(" ") || "<1m";
}

export default function RaidPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });

  if (error) return <div className="text-red-500 py-10">Failed to load snapshot: {String(error)}</div>;
  if (isLoading && !data) return <Skeleton className="h-96 w-full" />;

  const snapshot = data!;
  const raw = (snapshot.raw?.raid ?? {}) as Record<string, any>;
  const component = snapshot.components?.raid_disks;
  const readings: any[] = (component?.readings as any[]) ?? [];
  const arrayReading = readings.find((r: any) => r.key?.startsWith("raid."));
  const smartDisks: Record<string, any> = raw.smart ?? {};
  const diskSerials = Object.keys(smartDisks);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">RAID &amp; Disks</h1>
        <p className="text-muted-foreground mt-1">Identified by serial, never by /dev/sdX</p>
      </div>

      {/* Array state */}
      {arrayReading && (
        <Card className={arrayReading.status === Status.CRITICAL ? "border-red-500/50" : ""}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{arrayReading.label}</CardTitle>
              <StatusBadge status={arrayReading.status} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-lg font-bold">{arrayReading.value} [{arrayReading.extra?.state_string ?? ""}]</p>
            {arrayReading.detail && <p className="text-sm text-muted-foreground">{arrayReading.detail}</p>}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm border-t pt-3">
              <div><p className="text-xs text-muted-foreground">Level</p><p className="font-medium">{arrayReading.extra?.level ?? "â€”"}</p></div>
              <div><p className="text-xs text-muted-foreground">Members</p><p className="font-medium font-mono text-xs">{(arrayReading.extra?.members ?? []).join(", ") || "â€”"}</p></div>
              <div><p className="text-xs text-muted-foreground">Sync action</p><p className="font-medium">{arrayReading.extra?.sync_action || "idle"}</p></div>
              {arrayReading.extra?.sync_percent != null && (
                <div><p className="text-xs text-muted-foreground">Sync progress</p><p className="font-medium">{arrayReading.extra.sync_percent.toFixed(1)}%</p></div>
              )}
            </div>
            {arrayReading.status === Status.CRITICAL && (
              <div className="bg-red-500/10 border border-red-500/30 rounded p-3 text-sm text-red-500">
                The array has lost redundancy. Identify the missing member by serial with `lsblk -o NAME,SIZE,MODEL,SERIAL`.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Physical disks */}
      {diskSerials.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-3">Physical disks</h2>
          <div className="space-y-3">
            {diskSerials.map((serial) => {
              const disk = smartDisks[serial];
              const diskReadings = readings.filter((r: any) => r.key?.startsWith(`disk.${serial}.`));
              const crcReading = diskReadings.find((r: any) => r.key === `disk.${serial}.crc`);
              const otherReadings = diskReadings.filter((r: any) => r.key !== `disk.${serial}.crc`);
              const statusRank: Record<string, number> = { [Status.CRITICAL]: 4, [Status.WARNING]: 3, [Status.UNKNOWN]: 2, [Status.INFO]: 1, [Status.HEALTHY]: 0 };
              const diskStatus = diskReadings.length > 0
                ? diskReadings.reduce((best: any, r: any) => {
                    return (statusRank[r.status as string] ?? 0) > (statusRank[best.status as string] ?? 0) ? r : best;
                  }).status
                : disk.passed === false ? Status.CRITICAL : Status.HEALTHY;

              return (
                <Card key={serial} className={diskStatus === Status.CRITICAL ? "border-red-500/40" : diskStatus === Status.WARNING ? "border-yellow-500/40" : ""}>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <CardTitle className="text-sm font-mono">{serial}</CardTitle>
                        <p className="text-xs text-muted-foreground">{disk.model ?? "unknown"} {disk.device ? `Â· ${disk.device}` : ""}</p>
                      </div>
                      <StatusBadge status={diskStatus} />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div><p className="text-xs text-muted-foreground">Temperature</p><p className="font-bold">{disk.temperatureCelsius != null ? `${disk.temperatureCelsius.toFixed(0)} Â°C` : "â€”"}</p></div>
                      <div><p className="text-xs text-muted-foreground">Power-on hours</p><p className="font-bold">{disk.powerOnHours != null ? disk.powerOnHours.toLocaleString() : "â€”"}</p></div>
                      <div><p className="text-xs text-muted-foreground">Power cycles</p><p className="font-bold">{disk.powerCycleCount != null ? disk.powerCycleCount.toLocaleString() : "â€”"}</p></div>
                      <div><p className="text-xs text-muted-foreground">Pending sectors</p><p className={`font-bold ${disk.currentPendingSectors ? "text-red-500" : ""}`}>{disk.currentPendingSectors?.toLocaleString() ?? "0"}</p></div>
                    </div>

                    {crcReading && (
                      <div className="border-t pt-3">
                        <p className="text-xs text-muted-foreground mb-1">UDMA CRC errors</p>
                        <div className="flex items-center gap-3">
                          <span className="text-lg font-bold">{crcReading.value?.toLocaleString() ?? "â€”"}</span>
                          <StatusBadge status={crcReading.status} />
                        </div>
                        {crcReading.extra && (
                          <div className="grid grid-cols-4 gap-2 mt-2 text-xs text-muted-foreground">
                            {[["1h", crcReading.extra.delta_1h], ["24h", crcReading.extra.delta_24h], ["7d", crcReading.extra.delta_7d], ["30d", crcReading.extra.delta_30d]].map(([l, v]) => (
                              <div key={l}><span className="block">{l} delta</span><span className={`font-bold ${v ? "text-foreground" : ""}`}>{v != null ? `+${v}` : "â€”"}</span></div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {otherReadings.length > 0 && (
                      <div className="border-t pt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {otherReadings.map((r: any) => (
                          <div key={r.key}>
                            <p className="text-xs text-muted-foreground">{r.label}</p>
                            <div className="flex items-center gap-1">
                              <span className="font-bold text-sm">{r.value ?? "â€”"}</span>
                              <StatusBadge status={r.status} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {diskSerials.length === 0 && !arrayReading && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">SMART data unavailable. Install smartctl or deploy smartctl_exporter.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

