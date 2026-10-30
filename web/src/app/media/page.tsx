"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, ReadingCards, SnapshotBoundary, StatusBadge, useSnapshot } from "@/components/snapshot-ui";

export default function MediaPage() {
  const result = useSnapshot();
  return <div className="space-y-8"><header><h1 className="text-3xl font-bold">Media</h1><p className="mt-1 text-muted-foreground">Plex, Immich and the download automation stack</p></header><SnapshotBoundary {...result}>{(snapshot) => {
    const appReadings = snapshot.components.applications?.readings ?? [];
    const mediaKeys = ["plex", "immich", "sabnzbd", "sonarr", "radarr", "prowlarr", "qbittorrent"];
    const readings = appReadings.filter((reading: any) => mediaKeys.some((key) => reading.key?.toLowerCase().includes(key)));
    const probes = snapshot.raw.applications?.probes ?? {};
    const rows = Object.entries(probes).filter(([key]) => mediaKeys.some((media) => key.toLowerCase().includes(media))).map(([service, probe]: [string, any]) => ({
      service, status: probe.statusCode ?? probe.status_code, latency_ms: probe.latencyMs ?? probe.latency_ms, reachable: probe.reachable, error: probe.error,
    }));
    return <div className="space-y-6"><div className="flex items-center gap-3"><StatusBadge status={snapshot.components.applications?.status} /><span className="text-sm text-muted-foreground">Live probes and application freshness</span></div><ReadingCards readings={readings} /><Card><CardHeader><CardTitle>Media service probes</CardTitle></CardHeader><CardContent><DataTable rows={rows} empty="No media service endpoints are configured." /></CardContent></Card></div>;
  }}</SnapshotBoundary></div>;
}
