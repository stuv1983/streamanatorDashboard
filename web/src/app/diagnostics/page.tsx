"use client";

import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, SnapshotBoundary, StatusBadge, useSnapshot } from "@/components/snapshot-ui";

const fetcher = async (url: string) => { const response = await fetch(url); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`); return body; };

export default function DiagnosticsPage() {
  const snapshotResult = useSnapshot();
  const diagnostics = useSWR("/api/diagnostics", fetcher, { refreshInterval: 60_000 });
  return <div className="space-y-8"><header><h1 className="text-3xl font-bold">Diagnostics</h1><p className="mt-1 text-muted-foreground">Collector sources, history sampler and data-path health</p></header><SnapshotBoundary {...snapshotResult}>{(snapshot) => {
    const errorRows: Array<Record<string, unknown>> = [];
    for (const [area, value] of Object.entries(snapshot.raw)) {
      if (value && typeof value === "object") for (const [key, detail] of Object.entries(value as Record<string, unknown>)) if (key.includes("error") && detail) errorRows.push({ area, collector: key, detail });
    }
    return <div className="space-y-6"><div className="grid gap-4 md:grid-cols-3"><Card><CardHeader><CardTitle>Snapshot</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{snapshot.duration_seconds.toFixed(2)}s</p><p className="text-xs text-muted-foreground">{new Date(snapshot.collected_at * 1000).toLocaleString()}</p></CardContent></Card><Card><CardHeader><CardTitle>History sampler</CardTitle></CardHeader><CardContent><div className="flex items-center gap-2"><StatusBadge status={diagnostics.data?.runtime?.sampler?.running ? "healthy" : "warning"} /><span>{diagnostics.data?.runtime?.sampler?.runs ?? 0} runs</span></div><p className="mt-2 text-xs text-muted-foreground">{diagnostics.data?.runtime?.sampler?.last_error || "No sampler error"}</p></CardContent></Card><Card><CardHeader><CardTitle>History store</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{diagnostics.data?.history?.samples ?? "—"}</p><p className="text-xs text-muted-foreground">samples retained</p></CardContent></Card></div><Card><CardHeader><CardTitle>Collector source routing</CardTitle></CardHeader><CardContent><DataTable rows={Object.entries(snapshot.sources).map(([area, source]) => ({ area, source }))} /></CardContent></Card><Card><CardHeader><CardTitle>Collector errors</CardTitle></CardHeader><CardContent><DataTable rows={errorRows} empty="No collector errors are present in the current snapshot." /></CardContent></Card></div>;
  }}</SnapshotBoundary></div>;
}
