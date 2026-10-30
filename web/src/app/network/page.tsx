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

export default function NetworkPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, {
    refreshInterval: 60000,
    keepPreviousData: true,
  });

  if (error) return <div className="text-red-500 py-10">Failed to load snapshot: {String(error)}</div>;
  if (isLoading && !data) return <Skeleton className="h-96 w-full" />;

  const snapshot = data!;
  const raw = (snapshot.raw?.network ?? {}) as Record<string, any>;
  const internet = raw.internet_ping ?? null;
  const gatewayPing = raw.gateway_ping ?? null;
  const wan = raw.wan ?? null;
  const wanChange = raw.wan_ip_change ?? null;
  const vlans: any[] = raw.vlans ?? [];
  const devices: any[] = raw.unifi_devices ?? [];
  const gatewayStatus = raw.gateway_status ?? null;
  const controller = raw.unifi_controller ?? null;
  const unifiNetworks: any[] = raw.unifi_networks ?? [];
  const firewallPolicies: any[] = raw.unifi_firewall_policies ?? [];
  const component = snapshot.components?.network;
  const readings: any[] = (component?.readings as any[]) ?? [];
  const dnsReading = readings.find((r) => r.key === "network.dns");
  const wanReading = readings.find((r) => r.key === "network.wan_ip");

  function humanBps(bps: number | null): string {
    if (bps == null) return "—";
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let v = bps; let i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  function uptime(seconds: number | null): string {
    if (seconds == null) return "—";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return days ? `${days}d ${hours}h` : `${hours}h`;
  }

  function radioBand(frequency: number | null): string {
    if (frequency == null) return "Radio";
    if (frequency >= 5.9) return "6 GHz";
    if (frequency >= 4.9) return "5 GHz";
    return "2.4 GHz";
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Network</h1>
        <p className="text-muted-foreground mt-1">Internet reachability, WAN state and UniFi infrastructure</p>
      </div>

      {/* Internet KPIs */}
      <div className="flex flex-wrap gap-3">
        <MetricCard
          label="Internet latency"
          value={internet?.latency_ms != null ? `${Math.round(internet.latency_ms)} ms` : "—"}
          sub={internet?.target ? `ICMP to ${internet.target}` : undefined}
        />
        <MetricCard
          label="Packet loss"
          value={internet?.packet_loss_percent != null ? `${internet.packet_loss_percent.toFixed(1)}%` : "—"}
        />
        <MetricCard
          label="Jitter"
          value={internet?.jitter_ms != null ? `${internet.jitter_ms.toFixed(1)} ms` : "—"}
        />
        <MetricCard
          label="Local gateway"
          value={gatewayPing?.latency_ms != null ? `${gatewayPing.latency_ms.toFixed(1)} ms` : "unreachable"}
          sub={raw.gateway_ip ? `Default gateway ${raw.gateway_ip}` : undefined}
        />
        <MetricCard label="DNS" value={dnsReading?.display_value ?? dnsReading?.value ?? "—"} />
      </div>

      {/* WAN IP */}
      {(wanReading || wanChange) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              WAN public IP
              {wanReading && <StatusBadge status={wanReading.status} />}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Current</p>
                <p className="font-mono font-bold text-lg">{wanReading?.value ?? "unknown"}</p>
                {wanReading?.detail && <p className="text-xs text-muted-foreground mt-1">{wanReading.detail}</p>}
              </div>
              {wanChange && (
                <div className="space-y-1 text-xs">
                  <p><span className="font-medium">Previous:</span> {wanChange.previous ?? "—"}</p>
                  {wan?.org && <p className="text-muted-foreground">{wan.org} · {wan.location}</p>}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* UniFi fabric */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">UniFi fabric</h2>
            <p className="text-sm text-muted-foreground">Gateway, switches, access points, radios and physical ports from the read-only Integration API.</p>
          </div>
          {controller?.reachable && <Badge variant="outline" className="font-mono">Network {controller.version || "connected"}</Badge>}
        </div>

        {raw.unifi_devices_error && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-300">
            UniFi inventory unavailable: {raw.unifi_devices_error}
          </div>
        )}

        {gatewayStatus?.configured && (
          <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Gateway", gatewayStatus.name || gatewayStatus.model || "—"],
              ["State", gatewayStatus.state || "—"],
              ["CPU", gatewayStatus.cpuPercent == null ? "—" : `${gatewayStatus.cpuPercent.toFixed(1)}%`],
              ["Memory", gatewayStatus.memoryPercent == null ? "—" : `${gatewayStatus.memoryPercent.toFixed(1)}%`],
              ["Uptime", uptime(gatewayStatus.uptimeSeconds)],
            ].map(([label, value]) => <div key={label} className="bg-card px-4 py-3"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 font-mono text-sm font-semibold">{value}</p></div>)}
          </div>
        )}

        {devices.length > 0 && (
          <Card>
            <CardContent className="overflow-x-auto pt-4">
              <table className="w-full whitespace-nowrap text-sm">
                <thead><tr className="border-b text-left text-xs text-muted-foreground">{["Device", "Role", "State", "Address", "Model", "CPU", "Memory", "Uptime", "Firmware"].map(header => <th key={header} className="py-2 pr-4">{header}</th>)}</tr></thead>
                <tbody>{devices.map(device => <tr key={device.deviceId || device.mac} className="border-b border-border/40 last:border-0">
                  <td className="py-2 pr-4 font-medium">{device.name || device.mac}</td>
                  <td className="py-2 pr-4 capitalize">{device.role}</td>
                  <td className="py-2 pr-4"><Badge className={String(device.state).toUpperCase() === "ONLINE" ? "bg-emerald-500 text-white" : "bg-red-500 text-white"}>{device.state || "unknown"}</Badge></td>
                  <td className="py-2 pr-4 font-mono text-xs">{device.ipAddress || "—"}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{device.model || "—"}</td>
                  <td className="py-2 pr-4 font-mono">{device.cpuPercent == null ? "—" : `${device.cpuPercent.toFixed(1)}%`}</td>
                  <td className="py-2 pr-4 font-mono">{device.memoryPercent == null ? "—" : `${device.memoryPercent.toFixed(1)}%`}</td>
                  <td className="py-2 pr-4 font-mono">{uptime(device.uptimeSeconds)}</td>
                  <td className="py-2 font-mono text-xs">{device.firmwareVersion || "—"}{device.firmwareUpdatable ? " · update" : ""}</td>
                </tr>)}</tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {devices.some(device => device.radios?.length) && (
          <div className="grid gap-3 lg:grid-cols-2">
            {devices.filter(device => device.radios?.length).map(device => <Card key={`radio-${device.deviceId}`}><CardHeader className="pb-2"><CardTitle className="text-sm">{device.name || device.model} radios</CardTitle></CardHeader><CardContent className="space-y-2">{device.radios.map((radio: any, index: number) => <div key={index} className="grid grid-cols-4 gap-2 rounded-md bg-muted/35 px-3 py-2 text-xs"><strong>{radioBand(radio.frequencyGhz)}</strong><span>Ch {radio.channel ?? "—"}</span><span>{radio.channelWidthMhz ? `${radio.channelWidthMhz} MHz` : "—"}</span><span className="text-right">{radio.txRetriesPercent == null ? "—" : `${radio.txRetriesPercent.toFixed(1)}% retry`}</span></div>)}</CardContent></Card>)}
          </div>
        )}

        {devices.some(device => device.ports?.length) && (
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Switch ports</CardTitle></CardHeader><CardContent className="overflow-x-auto"><table className="w-full whitespace-nowrap text-xs"><thead><tr className="border-b text-left text-muted-foreground">{["Switch", "Port", "State", "Speed", "PoE"].map(header => <th key={header} className="py-2 pr-4">{header}</th>)}</tr></thead><tbody>{devices.flatMap(device => (device.ports ?? []).map((port: any) => <tr key={`${device.deviceId}-${port.index}`} className="border-b border-border/40 last:border-0"><td className="py-2 pr-4 font-medium">{device.name || device.model}</td><td className="py-2 pr-4 font-mono">{port.index ?? "—"}</td><td className="py-2 pr-4">{port.state || "—"}</td><td className="py-2 pr-4 font-mono">{port.speedMbps == null ? "—" : `${port.speedMbps} Mbps`}</td><td className="py-2">{port.poeState || (port.poeEnabled ? "enabled" : "—")}</td></tr>))}</tbody></table></CardContent></Card>
        )}

        {(unifiNetworks.length > 0 || firewallPolicies.length > 0) && <p className="text-xs text-muted-foreground">Controller inventory: {unifiNetworks.length} networks · {firewallPolicies.filter(policy => policy.enabled).length} enabled firewall policies.</p>}
      </div>

      {/* VLANs */}
      {vlans.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-3">VLANs</h2>
          <Card>
            <CardContent className="pt-4 overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b">
                    {["VLAN","Name","Subnet","Clients","RX","TX","Firewall blocks"].map(h => (
                      <th key={h} className="text-left py-1 pr-4">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {vlans.map((vlan: any) => (
                    <tr key={vlan.vlanId} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-4 font-mono">{vlan.vlanId}</td>
                      <td className="py-1.5 pr-4 font-medium">{vlan.name}</td>
                      <td className="py-1.5 pr-4 font-mono text-xs">{vlan.subnet}</td>
                      <td className="py-1.5 pr-4">{vlan.clientCount?.toLocaleString() ?? "—"}</td>
                      <td className="py-1.5 pr-4">{humanBps(vlan.rxBytesPerSec)}</td>
                      <td className="py-1.5 pr-4">{humanBps(vlan.txBytesPerSec)}</td>
                      <td className="py-1.5">{vlan.firewallBlocks?.toLocaleString() ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground mt-2">An em dash means UniFi does not expose that measurement; it does not mean zero.</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Readings */}
      {readings.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-3">Health readings</h2>
          <Card>
            <CardContent className="pt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b">
                    <th className="text-left py-1 pr-4">Metric</th>
                    <th className="text-left py-1 pr-4">Value</th>
                    <th className="text-left py-1 pr-4">Status</th>
                    <th className="text-left py-1">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {readings.map((r: any) => (
                    <tr key={r.key} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-4 font-medium">{r.label}</td>
                      <td className="py-1.5 pr-4 font-mono text-xs">{r.value ?? "—"}{r.unit ?? ""}</td>
                      <td className="py-1.5 pr-4"><StatusBadge status={r.status} /></td>
                      <td className="py-1.5 text-xs text-muted-foreground">{r.detail ?? ""}</td>
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

