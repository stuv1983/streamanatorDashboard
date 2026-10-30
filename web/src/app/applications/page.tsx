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

const STATUS_RANK: Record<string, number> = {
  [Status.CRITICAL]: 4, [Status.WARNING]: 3, [Status.UNKNOWN]: 2, [Status.INFO]: 1, [Status.HEALTHY]: 0,
};

export default function ApplicationsPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });

  if (error) return <div className="text-red-500 py-10">Failed to load snapshot: {String(error)}</div>;
  if (isLoading && !data) return <Skeleton className="h-96 w-full" />;

  const snapshot = data!;
  const raw = (snapshot.raw?.applications ?? {}) as Record<string, any>;
  const probes: Record<string, any> = raw.probes ?? {};
  const sportsDatabases: any[] = raw.sports_databases ?? [];
  const component = snapshot.components?.applications;
  const readings: any[] = (component?.readings as any[]) ?? [];

  const probeRows = Object.entries(probes)
    .map(([key, probe]: [string, any]) => {
      const reading = readings.find((r: any) => r.key === `probe.${key}`);
      return { key, probe, reading, status: reading?.status ?? Status.UNKNOWN };
    })
    .sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0));

  function humanBytes(bytes: number): string {
    if (bytes == null) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0; let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  function humanAge(ts: number | null): string {
    if (!ts) return "—";
    const seconds = Math.floor(Date.now() / 1000) - ts;
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Applications</h1>
        <p className="text-muted-foreground mt-1">Synthetic HTTP probes and application data freshness</p>
      </div>

      {/* Service probes */}
      <div>
        <h2 className="text-xl font-semibold mb-3">Service probes</h2>
        {probeRows.length === 0 ? (
          <Card><CardContent className="pt-6 text-sm text-muted-foreground">No probes configured.</CardContent></Card>
        ) : (
          <Card>
            <CardContent className="pt-4 overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b">
                    {["Status","Service","HTTP","Latency","DNS","TCP","TLS expiry","URL"].map(h => (
                      <th key={h} className="text-left py-1 pr-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {probeRows.map(({ key, probe, status }) => (
                    <tr key={key} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-4"><StatusBadge status={status} /></td>
                      <td className="py-1.5 pr-4 font-medium">{probe.display ?? key}</td>
                      <td className="py-1.5 pr-4">{probe.status_code ?? "—"}</td>
                      <td className="py-1.5 pr-4">{probe.latency_ms != null ? `${Math.round(probe.latency_ms)} ms` : "—"}</td>
                      <td className="py-1.5 pr-4">{probe.dns_ms != null ? `${Math.round(probe.dns_ms)} ms` : "—"}</td>
                      <td className="py-1.5 pr-4">{probe.connect_ms != null ? `${Math.round(probe.connect_ms)} ms` : "—"}</td>
                      <td className="py-1.5 pr-4">{probe.tls_days_remaining != null ? `${Math.round(probe.tls_days_remaining)} d` : "—"}</td>
                      <td className="py-1.5 font-mono text-xs">{probe.url ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground mt-2">Stage timings are separated deliberately — a DNS failure and an application returning 500 are very different problems.</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Sports databases */}
      {sportsDatabases.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-3">Sports databases</h2>
          <div className="space-y-3">
            {sportsDatabases.map((db: any) => (
              <Card key={db.key ?? db.path} className={!db.exists ? "border-red-500/30" : db.stale ? "border-yellow-500/30" : ""}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{db.display}</CardTitle>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">{db.path}</p>
                    </div>
                    <Badge className={db.stale ? "bg-yellow-500 text-white" : db.exists ? "bg-green-500 text-white" : "bg-red-500 text-white"}>
                      {db.stale ? "Stale" : db.exists ? "Current" : "Missing"}
                    </Badge>
                  </div>
                </CardHeader>
                {db.exists && (
                  <CardContent>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                      <div><p className="text-xs text-muted-foreground">Size</p><p className="font-bold">{humanBytes(db.size_bytes)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Age</p><p className="font-bold">{humanAge(db.modified_at)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Snapshots</p><p className="font-bold">{db.backup_count ?? "—"}</p></div>
                      <div><p className="text-xs text-muted-foreground">Latest snapshot</p><p className="font-bold">{humanAge(db.latest_backup_at)}</p></div>
                    </div>
                  </CardContent>
                )}
                {!db.exists && db.error && (
                  <CardContent><p className="text-xs text-muted-foreground">{db.error}</p></CardContent>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


