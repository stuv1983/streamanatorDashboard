"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, ReadingCards, SnapshotBoundary, StatusBadge, useSnapshot } from "@/components/snapshot-ui";

export default function SecurityPage() {
  const result = useSnapshot();
  return <div className="space-y-8"><header><h1 className="text-3xl font-bold">Security</h1><p className="mt-1 text-muted-foreground">Listener inventory, declared exposure and UniFi IDS/IPS visibility</p></header><SnapshotBoundary {...result}>{(snapshot) => {
    const component = snapshot.components.security;
    const raw = snapshot.raw.security ?? {};
    const listeners = (raw.listeners ?? []).map((item: any) => ({ address: item.address, port: item.port, protocol: item.protocol, process: item.process, loopback_only: item.loopbackOnly ?? item.loopback_only }));
    const events = (raw.ids_events ?? []).map((item: any) => ({ time: item.timestamp ?? item.time, severity: item.severity, source: item.source_ip ?? item.source, destination: item.destination_ip ?? item.destination, signature: item.signature ?? item.message }));
    return <div className="space-y-6"><div className="flex items-center gap-3"><StatusBadge status={component?.status} /><span className="text-sm text-muted-foreground">{component?.detail}</span></div><ReadingCards readings={component?.readings ?? []} /><Card><CardHeader><CardTitle>Non-loopback listeners</CardTitle></CardHeader><CardContent><DataTable rows={listeners.filter((item: any) => !item.loopback_only)} /></CardContent></Card><Card><CardHeader><CardTitle>Recent UniFi IDS/IPS events</CardTitle></CardHeader><CardContent><DataTable rows={events} empty={raw.unifi?.configured ? "No recent events reported." : "UniFi is not configured; no claim about event absence can be made."} /></CardContent></Card></div>;
  }}</SnapshotBoundary></div>;
}
