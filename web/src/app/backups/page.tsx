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

function formatTs(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
}

export default function BackupsPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });

  if (error) return <div className="text-red-500 py-10">Failed to load snapshot: {String(error)}</div>;
  if (isLoading && !data) return <Skeleton className="h-96 w-full" />;

  const snapshot = data!;
  const raw = (snapshot.raw?.backups ?? {}) as Record<string, any>;
  const jobs: any[] = raw.jobs ?? [];
  const component = snapshot.components?.backups;
  const readings: any[] = (component?.readings as any[]) ?? [];
  const backupAlerts = snapshot.alerts?.filter((a: any) => a.key?.startsWith("backup.")) ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Backups</h1>
        <p className="text-muted-foreground mt-1">Backup recency, plausibility and integrity</p>
      </div>

      <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3 text-xs text-blue-400">
        The RAID array is not a backup. It protects against a single disk failure, not against deletion, corruption, ransomware or fire.
      </div>

      {jobs.length === 0 ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">No backup jobs configured.</CardContent></Card>
      ) : (
        <div className="space-y-4">
          {jobs.map((job: any, idx: number) => {
            const reading = readings.find((r: any) => r.key === `backup.${job.key}`);
            const integrityReading = readings.find((r: any) => r.key === `backup.integrity.${job.key}`);
            const isCrit = reading?.status === Status.CRITICAL;
            const isWarn = reading?.status === Status.WARNING;

            return (
              <Card key={job.key ?? idx} className={isCrit ? "border-red-500/40" : isWarn ? "border-yellow-500/40" : ""}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{job.display ?? job.key}</CardTitle>
                      <p className="text-xs text-muted-foreground mt-0.5">{job.directory} · {job.schedule}</p>
                    </div>
                    {reading && <StatusBadge status={reading.status} />}
                  </div>
                  {job.error && <p className="text-xs text-red-500 mt-1">{job.error}</p>}
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Facts grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Last backup</p>
                      <p className="font-bold">{formatTs(job.latest?.modified_at)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Age</p>
                      <p className="font-bold">{job.age_days != null ? `${job.age_days.toFixed(1)} days` : "—"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Size</p>
                      <p className="font-bold">{job.latest?.size_bytes ? humanBytes(job.latest.size_bytes) : "—"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Retained</p>
                      <p className="font-bold">{job.retained_count ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Destination free</p>
                      <p className="font-bold">{job.destination_free_bytes != null ? humanBytes(job.destination_free_bytes) : "—"}</p>
                    </div>
                    {job.destination_used_percent != null && (
                      <div>
                        <p className="text-xs text-muted-foreground">Destination used</p>
                        <p className="font-bold">{job.destination_used_percent.toFixed(0)}%</p>
                      </div>
                    )}
                    {job.growth_bytes != null && (
                      <div>
                        <p className="text-xs text-muted-foreground">Size change</p>
                        <p className="font-bold">{humanBytes(job.growth_bytes)}</p>
                      </div>
                    )}
                  </div>

                  {/* Integrity */}
                  {integrityReading && (
                    <div className={`rounded p-3 text-sm ${
                      integrityReading.status === Status.HEALTHY ? "bg-green-500/10 border border-green-500/30 text-green-400"
                      : integrityReading.status === Status.CRITICAL ? "bg-red-500/10 border border-red-500/30 text-red-400"
                      : "bg-yellow-500/10 border border-yellow-500/30 text-yellow-400"
                    }`}>
                      <span className="font-medium">Integrity: </span>{integrityReading.detail}
                      {integrityReading.extra?.checked_at && (
                        <span className="text-xs text-muted-foreground ml-2">({humanAge(integrityReading.extra.checked_at)})</span>
                      )}
                    </div>
                  )}

                  {/* Retained files list */}
                  {job.retained_count > 0 && job.latest && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        Retained backups ({job.retained_count})
                      </summary>
                      <div className="mt-2 space-y-1">
                        {[job.latest, job.previous].filter(Boolean).map((f: any) => (
                          <div key={f.name} className="flex gap-4 text-xs border-b border-border/40 pb-1">
                            <span className="font-mono flex-1 truncate">{f.name}</span>
                            <span>{humanBytes(f.size_bytes)}</span>
                            <span className="text-muted-foreground">{humanAge(f.modified_at)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Alerts */}
      <div>
        <h2 className="text-xl font-semibold mb-3">Backup alerts</h2>
        {backupAlerts.length === 0 ? (
          <div className="text-green-500 text-sm">✓ No backup problems detected.</div>
        ) : (
          <div className="space-y-2">
            {backupAlerts.map((alert: any) => (
              <Card key={alert.key} className="border-red-500/30">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusBadge status={alert.status} />
                    <span className="font-medium text-sm">{alert.title}</span>
                  </div>
                  {alert.detail && <p className="text-xs text-muted-foreground">{alert.detail}</p>}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


