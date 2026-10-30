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
  if (!s) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d > 0 && `${d}d`, h > 0 && `${h}h`, m > 0 && d === 0 && `${m}m`].filter(Boolean).join(" ") || "<1m";
}

const STATUS_RANK: Record<string, number> = {
  [Status.CRITICAL]: 4, [Status.WARNING]: 3, [Status.UNKNOWN]: 2, [Status.INFO]: 1, [Status.HEALTHY]: 0,
};

export default function DockerPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });

  if (error) return <div className="text-red-500 py-10">Failed to load snapshot: {String(error)}</div>;
  if (isLoading && !data) return <Skeleton className="h-96 w-full" />;

  const snapshot = data!;
  const raw = (snapshot.raw?.containers ?? {}) as Record<string, any>;
  const containers: any[] = raw.containers ?? [];
  const unexpected: any[] = raw.unexpected ?? [];
  const component = snapshot.components?.applications;
  const readings: any[] = (component?.readings as any[]) ?? [];

  const dockerAlert = snapshot.alerts?.find((a: any) => a.key === "server.docker");

  if (!containers.length && dockerAlert) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Docker</h1>
        <div className="bg-red-500/10 border border-red-500/30 rounded p-4 text-red-500">
          <p className="font-bold">Docker unavailable</p>
          <p className="text-sm mt-1">{dockerAlert.detail || "Docker daemon could not be queried."}</p>
        </div>
      </div>
    );
  }

  const rows = containers
    .map((c: any) => {
      const reading = readings.find((r: any) => r.key === `container.${c.name}`);
      const status: Status = reading?.status ?? Status.UNKNOWN;
      return { ...c, status, reading };
    })
    .sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Docker</h1>
        <p className="text-muted-foreground mt-1">
          {raw.running_count ?? "—"} of {raw.expected_count ?? "—"} expected containers running
        </p>
      </div>

      <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3 text-xs text-blue-400">
        Media-stack ports are published by <strong>gluetun</strong>, not by application containers. This is why Sonarr, SABnzbd etc. show no ports in `docker ps`.
      </div>

      {/* Container table */}
      <Card>
        <CardHeader><CardTitle className="text-base">Container inventory</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="text-muted-foreground text-xs border-b">
                {["Status","Name","State","Health","Image","Uptime","Restarts","VPN"].map(h => (
                  <th key={h} className="text-left py-1 pr-4 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c: any) => (
                <tr key={c.name} className="border-b border-border/40 last:border-0">
                  <td className="py-1.5 pr-4"><StatusBadge status={c.status} /></td>
                  <td className="py-1.5 pr-4 font-medium">{c.name}</td>
                  <td className="py-1.5 pr-4">{c.state ?? "missing"}</td>
                  <td className="py-1.5 pr-4">{c.health ?? "no healthcheck"}</td>
                  <td className="py-1.5 pr-4 font-mono text-xs max-w-[200px] truncate">{c.image ?? "—"}</td>
                  <td className="py-1.5 pr-4">{c.uptime_seconds ? humanDuration(c.uptime_seconds) : "—"}</td>
                  <td className="py-1.5 pr-4">{c.restart_count ?? "—"}</td>
                  <td className="py-1.5">{c.reading?.extra?.behind_vpn ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground mt-2">Sorted worst-first.</p>
        </CardContent>
      </Card>

      {/* Unexpected containers */}
      {unexpected.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-3">Unexpected containers</h2>
          <p className="text-xs text-muted-foreground mb-2">Running but not in the expected inventory.</p>
          <Card>
            <CardContent className="pt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b">
                    {["Name","Image","State","Uptime"].map(h => <th key={h} className="text-left py-1 pr-4">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {unexpected.map((c: any) => (
                    <tr key={c.name} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-4 font-medium">{c.name}</td>
                      <td className="py-1.5 pr-4 font-mono text-xs">{c.image}</td>
                      <td className="py-1.5 pr-4">{c.state}</td>
                      <td className="py-1.5">{c.uptime_seconds ? humanDuration(c.uptime_seconds) : "—"}</td>
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


