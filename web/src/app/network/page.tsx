"use client";

import * as React from "react";
import { Code, ErrorState, Facts, Meter, Metric, PageHeader, Panel, Readout, Section, Source, Stamp, Void, Well } from "@/components/instrument";
import { ReadingCards, SnapshotBoundary, useSnapshot } from "@/components/snapshot-ui";
import type { Snapshot } from "@/lib/snapshot";

function humanBps(bps: number | null | undefined): string | null {
  if (bps == null) return null;
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = bps; let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function uptime(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
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

function pct(v: number | null | undefined): string | null {
  return v == null ? null : v.toFixed(1);
}

function sampleTime(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Renders `backtick` spans in collector text as inline code. */
function withCode(text: string): React.ReactNode {
  return text.split(/`([^`]+)`/g).map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : <React.Fragment key={i}>{part}</React.Fragment>));
}

function AlertPanels({ alerts }: { alerts: any[] }) {
  if (!alerts.length) return null;
  return (
    <Section title="Alerts" count={alerts.length}>
      <div className="flex flex-col gap-3">
        {alerts.map((alert) => (
          <Panel key={alert.key}>
            <div className="flex flex-wrap items-center gap-3">
              <Stamp status={alert.status} />
              <p className="m-0 text-base font-semibold">{alert.title}</p>
              {alert.component && <Source>{alert.component}</Source>}
            </div>
            {alert.detail && <p className="m-0 text-sm leading-normal text-silk-dim text-pretty">{alert.detail}</p>}
            <Facts
              items={[
                alert.current_value && ["Now", <span key="n" className="font-mono">{alert.current_value}</span>],
                alert.threshold && ["Threshold", <span key="t" className="font-mono">{alert.threshold}</span>],
                alert.probable_cause && ["Probable cause", alert.probable_cause],
                alert.recommended_action && ["Next check", withCode(alert.recommended_action)],
              ]}
            />
          </Panel>
        ))}
      </div>
    </Section>
  );
}

const TH = "px-3 py-2.5 text-left font-panel text-[9.5px] font-normal uppercase tracking-[0.12em] text-graphite";
const TD = "px-3 py-2.5 align-middle font-mono text-[13px]";

function Table({ headers, children, label }: { headers: string[]; children: React.ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto rounded-[3px] border border-seam">
      <table className="w-full whitespace-nowrap text-sm" aria-label={label}>
        <thead className="bg-well">
          <tr className="border-b border-seam">{headers.map((h) => <th key={h} scope="col" className={TH}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <tr className="border-b border-seam last:border-0 hover:bg-bezel/60">{children}</tr>;
}

/** A table cell value, or a compact void when it is not reported. */
function Cell({ value, unit, note }: { value: React.ReactNode; unit?: string; note?: string }) {
  return <Readout value={value} unit={unit} size="sm" note={note} className="text-[13px]" />;
}

export default function NetworkPage() {
  const { data, error, isLoading } = useSnapshot();
  return (
    <SnapshotBoundary data={data} error={error} isLoading={isLoading}>
      {(snapshot) => <NetworkView snapshot={snapshot} />}
    </SnapshotBoundary>
  );
}

function NetworkView({ snapshot }: { snapshot: Snapshot }) {
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
  const alerts: any[] = (component?.alerts as any[]) ?? [];
  const dnsReading = readings.find((r) => r.key === "network.dns");
  const wanReading = readings.find((r) => r.key === "network.wan_ip");
  const internetReading = readings.find((r) => r.key === "network.internet");
  const gatewayReading = readings.find((r) => r.key === "network.gateway");
  const unifiReading = readings.find((r) => r.key === "network.unifi");

  const gatewayUnreachable = gatewayPing && gatewayPing.latency_ms == null && gatewayPing.packets_sent;
  const dnsDisplay = dnsReading?.display_value ?? dnsReading?.value ?? null;
  const ports = devices.flatMap((device) => (device.ports ?? []).map((port: any) => ({ device, port })));
  const radioDevices = devices.filter((device) => device.radios?.length);
  const sampled = sampleTime(snapshot.collected_at);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        group="Infrastructure"
        title="Network"
        description="Can streamanator reach the internet, and is the UniFi gateway, switching and Wi-Fi fabric up?"
        status={component?.status}
        meta={["local:ping", sampled && `sampled ${sampled}`].filter(Boolean).join(" · ")}
      />

      <AlertPanels alerts={alerts} />

      <Section title="Internet" note={internet?.target ? `ICMP to ${internet.target}` : undefined}>
        <Well>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
            <Metric
              label="Latency"
              value={internet?.latency_ms != null ? Math.round(internet.latency_ms) : null}
              unit="ms"
              state={internetReading?.state}
              note={internetReading?.detail || "No ping reply."}
            />
            <Metric
              label="Packet loss"
              value={pct(internet?.packet_loss_percent)}
              unit="%"
              note="No ping result."
            />
            <Metric label="Jitter" value={pct(internet?.jitter_ms)} unit="ms" note="Not measured." />
            <Metric
              label="Local gateway"
              value={gatewayPing?.latency_ms != null ? gatewayPing.latency_ms.toFixed(1) : null}
              unit="ms"
              state={gatewayUnreachable ? "OFFLINE" : undefined}
              note={gatewayUnreachable ? "No reply to ping." : gatewayReading?.detail || "Gateway could not be probed."}
              hint={raw.gateway_ip ? <span className="font-mono">{raw.gateway_ip}</span> : undefined}
            />
            <Metric
              label="DNS lookup"
              value={dnsDisplay}
              unit={dnsReading?.display_value == null && dnsDisplay != null ? dnsReading?.unit : undefined}
              state={dnsReading?.state}
              note={dnsReading?.detail || "No DNS probe result."}
            />
          </div>
        </Well>
      </Section>

      {(wanReading || wanChange) && (
        <Section title="WAN public IP">
          <Panel>
            <div className="flex flex-wrap items-center gap-3">
              {wanReading && <Stamp status={wanReading.status} />}
              {wanReading?.detail && <p className="m-0 text-sm text-silk-dim text-pretty">{wanReading.detail}</p>}
            </div>
            <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-3">
              <Metric label="Current" value={wanReading?.value ?? null} state={wanReading?.state} note={wanReading?.detail} />
              {wanChange && (
                <Metric label="Previous" value={wanChange.previous ?? null} size="sm" note="No change recorded since first seen." />
              )}
              {wanChange && (wan?.org || wan?.location) && (
                <Metric label="Provider" value={[wan?.org, wan?.location].filter(Boolean).join(" · ")} size="sm" />
              )}
            </div>
            {wanReading?.source && <Source>{wanReading.source}</Source>}
          </Panel>
        </Section>
      )}

      <Section
        title="UniFi fabric"
        count={devices.length || undefined}
        note={controller?.reachable ? `Network ${controller.version || "connected"} · read-only Integration API` : "Read-only Integration API"}
      >
        {raw.unifi_devices_error && (
          <ErrorState title="UniFi device inventory didn't load" detail={raw.unifi_devices_error}>
            Check the controller URL and API key in the dashboard settings, and that the controller is reachable from streamanator.
          </ErrorState>
        )}

        {!devices.length && !raw.unifi_devices_error && (
          <Void
            state={unifiReading?.state ?? "NO_DATA"}
            note={unifiReading?.detail || "The controller returned no devices."}
          />
        )}

        {gatewayStatus?.configured && (
          <Panel title="Gateway">
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
              <Metric label="Device" value={gatewayStatus.name || gatewayStatus.model || null} size="sm" />
              <Metric label="State" value={gatewayStatus.state || null} size="sm" />
              <div className="flex flex-col gap-2">
                <Metric label="CPU" value={pct(gatewayStatus.cpuPercent)} unit="%" size="sm" note="Not reported." />
                <Meter value={gatewayStatus.cpuPercent} label="Gateway CPU" />
              </div>
              <div className="flex flex-col gap-2">
                <Metric label="Memory" value={pct(gatewayStatus.memoryPercent)} unit="%" size="sm" note="Not reported." />
                <Meter value={gatewayStatus.memoryPercent} label="Gateway memory" />
              </div>
              <Metric label="Uptime" value={uptime(gatewayStatus.uptimeSeconds)} size="sm" note="Not reported." />
            </div>
          </Panel>
        )}

        {devices.length > 0 && (
          <Table label="UniFi devices" headers={["Device", "Role", "State", "Address", "Model", "CPU", "Memory", "Uptime", "Firmware"]}>
            {devices.map((device) => {
              const online = String(device.state).toUpperCase() === "ONLINE";
              return (
                <Row key={device.deviceId || device.mac}>
                  <td className={TD}>{device.name || device.mac}</td>
                  <td className="px-3 py-2.5 text-[13px] capitalize text-silk-dim">{device.role}</td>
                  <td className="px-3 py-2.5">
                    <Stamp status={device.state ? (online ? "HEALTHY" : "CRITICAL") : "UNKNOWN"} label={device.state ? String(device.state).toUpperCase() : "UNKNOWN"} />
                  </td>
                  <td className={TD}><Cell value={device.ipAddress || null} /></td>
                  <td className={TD}><Cell value={device.model || null} /></td>
                  <td className={TD}><Cell value={pct(device.cpuPercent)} unit="%" /></td>
                  <td className={TD}><Cell value={pct(device.memoryPercent)} unit="%" /></td>
                  <td className={TD}><Cell value={uptime(device.uptimeSeconds)} /></td>
                  <td className={TD}>
                    <span className="inline-flex items-center gap-2">
                      <Cell value={device.firmwareVersion || null} />
                      {device.firmwareUpdatable && <span className="font-sans text-xs text-silk-dim">update available</span>}
                    </span>
                  </td>
                </Row>
              );
            })}
          </Table>
        )}

        {(unifiNetworks.length > 0 || firewallPolicies.length > 0) && (
          <Source>
            Controller inventory: {unifiNetworks.length} networks · {firewallPolicies.filter((policy) => policy.enabled).length} enabled firewall policies
          </Source>
        )}
      </Section>

      {radioDevices.length > 0 && (
        <Section title="Radios" count={radioDevices.reduce((n, d) => n + d.radios.length, 0)}>
          <div className="grid gap-3 lg:grid-cols-2">
            {radioDevices.map((device) => (
              <Panel key={`radio-${device.deviceId}`}>
                <p className="m-0 font-mono text-[15px] font-semibold">{device.name || device.model}</p>
                <div className="flex flex-col">
                  {device.radios.map((radio: any, index: number) => (
                    <div key={index} className="grid grid-cols-2 items-center gap-x-4 gap-y-2 border-t border-seam py-3 sm:grid-cols-4">
                      <span className="font-mono text-sm font-semibold">{radioBand(radio.frequencyGhz)}</span>
                      <Metric label="Channel" value={radio.channel ?? null} size="sm" />
                      <Metric label="Width" value={radio.channelWidthMhz || null} unit="MHz" size="sm" />
                      <Metric label="TX retries" value={pct(radio.txRetriesPercent)} unit="%" size="sm" />
                    </div>
                  ))}
                </div>
              </Panel>
            ))}
          </div>
        </Section>
      )}

      {ports.length > 0 && (
        <Section title="Switch ports" count={ports.length}>
          <Table label="Switch ports" headers={["Switch", "Port", "State", "Speed", "PoE"]}>
            {ports.map(({ device, port }) => (
              <Row key={`${device.deviceId}-${port.index}`}>
                <td className={TD}>{device.name || device.model}</td>
                <td className={TD}><Cell value={port.index ?? null} /></td>
                <td className="px-3 py-2.5 text-[13px]"><Cell value={port.state || null} /></td>
                <td className={TD}><Cell value={port.speedMbps ?? null} unit="Mbps" /></td>
                <td className="px-3 py-2.5 text-[13px]"><Cell value={port.poeState || (port.poeEnabled ? "enabled" : null)} note="No PoE" /></td>
              </Row>
            ))}
          </Table>
        </Section>
      )}

      {vlans.length > 0 && (
        <Section title="VLANs" count={vlans.length} note="Hatched cells mean UniFi does not expose that measurement. They are not zero.">
          <Table label="VLANs" headers={["VLAN", "Name", "Subnet", "Clients", "RX", "TX", "Firewall blocks"]}>
            {vlans.map((vlan: any) => (
              <Row key={vlan.vlanId}>
                <td className={TD}>{vlan.vlanId}</td>
                <td className="px-3 py-2.5 text-[13px] font-semibold">{vlan.name}</td>
                <td className={TD}><Cell value={vlan.subnet || null} /></td>
                <td className={TD}><Cell value={vlan.clientCount?.toLocaleString("en-AU") ?? null} /></td>
                <td className={TD}><Cell value={humanBps(vlan.rxBytesPerSec)} /></td>
                <td className={TD}><Cell value={humanBps(vlan.txBytesPerSec)} /></td>
                <td className={TD}><Cell value={vlan.firewallBlocks?.toLocaleString("en-AU") ?? null} /></td>
              </Row>
            ))}
          </Table>
        </Section>
      )}

      {readings.length > 0 && (
        <Section title="Health readings" count={readings.length}>
          <ReadingCards readings={readings} />
        </Section>
      )}
    </div>
  );
}
