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

function CheckRow({ label, value }: { label: string; value: boolean | null }) {
  const icon = value == null ? "○" : value ? "●" : "●";
  const color = value == null ? "text-muted-foreground" : value ? "text-green-500" : "text-red-500";
  const text = value == null ? "unknown" : value ? "ok" : "failed";
  return (
    <div className="flex items-center gap-2 text-sm py-0.5">
      <span className={color}>{icon}</span>
      <span className="flex-1">{label}</span>
      <span className={`font-medium ${color}`}>{text}</span>
    </div>
  );
}

export default function VpnPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });

  if (error) return <div className="text-red-500 py-10">Failed to load snapshot: {String(error)}</div>;
  if (isLoading && !data) return <Skeleton className="h-96 w-full" />;

  const snapshot = data!;
  const raw = (snapshot.raw?.vpn ?? {}) as Record<string, any>;
  const status = raw.status ?? null;
  const leak = raw.leak ?? null;
  const component = snapshot.components?.vpn;
  const readings: any[] = (component?.readings as any[]) ?? [];
  const leakReading = readings.find((r: any) => r.key === "vpn.leak");
  const tunnelReading = readings.find((r: any) => r.key === "vpn.gluetun");
  const vpnAlerts = snapshot.alerts?.filter((a: any) => a.key?.startsWith("vpn.")) ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">VPN</h1>
        <p className="text-muted-foreground mt-1">Gluetun state, leak check and diagnosis</p>
      </div>

      {/* Leak check — always first */}
      {leakReading && (
        <div>
          {leakReading.status === Status.CRITICAL && (
            <div className="bg-red-500/10 border-2 border-red-500 rounded p-4">
              <p className="text-red-500 font-bold text-lg">⚠ POSSIBLE VPN LEAK</p>
              <p className="text-sm mt-1">{leakReading.detail}</p>
              <p className="text-sm mt-1 text-muted-foreground">Download-client traffic may be leaving through the home WAN address.</p>
            </div>
          )}
          {leakReading.status === Status.UNKNOWN && (
            <div className="bg-yellow-500/10 border border-yellow-500/50 rounded p-4">
              <p className="text-yellow-500 font-bold">Leak check inconclusive</p>
              <p className="text-sm mt-1">{leakReading.detail}</p>
            </div>
          )}
          {leakReading.status === Status.HEALTHY && (
            <div className="bg-green-500/10 border border-green-500/50 rounded p-4">
              <p className="text-green-500 font-bold">✓ Leak check: PASS</p>
              <p className="text-sm mt-1">{leakReading.detail}</p>
            </div>
          )}
        </div>
      )}

      {leak && (
        <div className="flex flex-wrap gap-3">
          {[
            ["VPN exit IP", leak.vpn_ip ?? "unknown"],
            ["Home WAN IP", leak.wan_ip ?? "unknown"],
            ["Result", leak.passed === true ? "PASS" : leak.passed === false ? "FAIL" : "UNKNOWN"],
          ].map(([l, v]) => (
            <Card key={l} className="flex-1 min-w-[150px]">
              <CardHeader className="pb-1 pt-4 px-4"><p className="text-xs text-muted-foreground uppercase tracking-wider">{l}</p></CardHeader>
              <CardContent className="px-4 pb-4"><p className={`text-xl font-bold font-mono ${l === "Result" && v === "FAIL" ? "text-red-500" : ""}`}>{v}</p></CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Tunnel state */}
      <div>
        <h2 className="text-xl font-semibold mb-3">Tunnel</h2>
        {status == null ? (
          <div className="text-red-500 text-sm">Gluetun state could not be determined.</div>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base">Gluetun</CardTitle>
                  {tunnelReading && <StatusBadge status={tunnelReading.status} />}
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold font-mono">{status.public_ip ?? "no tunnel"}</p>
                {tunnelReading?.detail && <p className="text-xs text-muted-foreground mt-1">{tunnelReading.detail}</p>}
                <div className="grid grid-cols-3 gap-3 mt-4 text-sm">
                  <div><p className="text-xs text-muted-foreground">Provider</p><p className="font-bold">{status.provider ?? "—"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Uptime</p><p className="font-bold">{status.uptime_seconds ? humanDuration(status.uptime_seconds) : "—"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Restarts</p><p className="font-bold">{status.restart_count ?? "—"}</p></div>
                </div>
                {status.location && <p className="text-xs text-muted-foreground mt-2">Exit: {status.location} · {status.org}</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">State checks</CardTitle></CardHeader>
              <CardContent>
                <CheckRow label="Container present" value={status.container_present} />
                <CheckRow label="Container running" value={status.container_running} />
                <CheckRow label="Docker healthcheck" value={status.container_healthy} />
                <CheckRow label="Tunnel up" value={status.tunnel_up} />
                <CheckRow label="DNS resolution" value={status.dns_ok} />
                <CheckRow label="Outbound HTTPS" value={status.https_ok} />
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Diagnosis */}
      {status && (status.container_healthy === false || status.tunnel_up === false || status.dns_ok === false) && (
        <div>
          <h2 className="text-xl font-semibold mb-3">Diagnosis</h2>
          <Card className="border-yellow-500/40">
            <CardContent className="pt-4 space-y-2 text-sm">
              {status.error && <p><span className="font-bold">Likely cause:</span> {status.error}</p>}
              {status.auth_failures > 0 && <p className="text-red-500">{status.auth_failures} AUTH_FAILED entries in recent logs.</p>}
              {status.reconnects > 0 && <p>{status.reconnects} reconnect events in recent logs.</p>}
              {status.recent_errors?.length > 0 && (
                <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-40">{status.recent_errors.join("\n")}</pre>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Active alerts */}
      {vpnAlerts.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-3">Active alerts</h2>
          <div className="space-y-2">
            {vpnAlerts.map((alert: any) => (
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
        </div>
      )}
    </div>
  );
}


