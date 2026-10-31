"use client";

import * as React from "react";
import { Code, EmptyState, Facts, Ledger, Meter, Metric, PageHeader, Panel, Readout, Section, Source, Stamp, Void, Well, deltasFrom, hasDeltas, worstStatus } from "@/components/instrument";
import { SnapshotBoundary, useSnapshot } from "@/components/snapshot-ui";
import type { Snapshot } from "@/lib/snapshot";
import { Status } from "@/lib/status";

function humanDuration(s: number | null | undefined): string | null {
  if (!s) return null;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d > 0 && `${d}d`, h > 0 && `${h}h`, m > 0 && d === 0 && `${m}m`].filter(Boolean).join(" ") || "<1m";
}

function sampleTime(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function count(v: number | null | undefined): string | null {
  return v == null ? null : v.toLocaleString("en-AU");
}

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

/** Reading labels repeat the serial ("ZX12 temperature"); the disk panel already names it. */
function shortLabel(label: string, serial: string): string {
  const rest = label.startsWith(serial) ? label.slice(serial.length).trim() : label;
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : label;
}

export default function RaidPage() {
  const { data, error, isLoading } = useSnapshot();
  return (
    <SnapshotBoundary data={data} error={error} isLoading={isLoading}>
      {(snapshot) => <RaidView snapshot={snapshot} />}
    </SnapshotBoundary>
  );
}

function RaidView({ snapshot }: { snapshot: Snapshot }) {
  const raw = (snapshot.raw?.raid ?? {}) as Record<string, any>;
  const component = snapshot.components?.raid_disks;
  const readings: any[] = (component?.readings as any[]) ?? [];
  const alerts: any[] = (component?.alerts as any[]) ?? [];
  const arrayReading = readings.find((r: any) => r.key?.startsWith("raid."));
  const smartDisks: Record<string, any> = raw.smart ?? {};
  const diskSerials = Object.keys(smartDisks);
  const smartReading = readings.find((r: any) => r.key === "disk.smart");
  const smartNote: string = raw.smart_error || smartReading?.detail || "No SMART source available. Deploy smartctl_exporter, or grant the dashboard read-only smartctl access.";
  const sampled = sampleTime(snapshot.collected_at);
  const sources = [snapshot.sources?.raid, snapshot.sources?.smart].filter(Boolean).join(" + ");
  const extra = arrayReading?.extra ?? {};

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        group="Infrastructure"
        title="RAID & disks"
        description="Is the array still redundant, and is every physical disk healthy? Disks are identified by serial, never by /dev/sdX."
        status={component?.status}
        meta={[sources, sampled && `sampled ${sampled}`].filter(Boolean).join(" · ") || undefined}
      />

      <AlertPanels alerts={alerts} />

      {arrayReading && (
        <Section title="Array">
          <Panel>
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-3">
                  <Stamp status={arrayReading.status} />
                  <p className="m-0 font-mono text-base font-semibold">{arrayReading.label}</p>
                </div>
                {arrayReading.detail && <p className="m-0 text-sm leading-normal text-silk-dim text-pretty">{arrayReading.detail}</p>}
              </div>
              <div className="flex items-baseline gap-3">
                <Readout value={arrayReading.value} state={arrayReading.state} size="lg" />
                {arrayReading.value != null && extra.state_string && <span className="font-mono text-lg text-silk-dim">[{extra.state_string}]</span>}
              </div>
            </div>

            <Well className="px-4 py-4">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 min-[420px]:grid-cols-2 md:grid-cols-4">
                <Metric label="Level" value={extra.level ?? null} size="sm" />
                <Metric
                  label="Member partitions"
                  value={(extra.members ?? []).join(", ") || null}
                  size="sm"
                  hint="Kernel names can change across boots. Match to a serial before acting."
                />
                <Metric label="Sync action" value={extra.sync_action || "idle"} size="sm" />
                {extra.sync_percent != null && (
                  <div className="flex flex-col gap-2">
                    <Metric label="Sync progress" value={extra.sync_percent.toFixed(1)} unit="%" size="sm" />
                    <Meter value={extra.sync_percent} label="Sync progress" />
                    {(extra.sync_speed_kbps != null || extra.sync_finish_minutes != null) && (
                      <Source>
                        {[
                          extra.sync_speed_kbps != null && `${Math.round(extra.sync_speed_kbps / 1024)} MiB/s`,
                          extra.sync_finish_minutes != null && `${humanDuration(extra.sync_finish_minutes * 60) ?? "<1m"} left`,
                        ].filter(Boolean).join(" · ")}
                      </Source>
                    )}
                  </div>
                )}
              </div>
            </Well>

            {arrayReading.status === Status.CRITICAL && (
              <Facts
                items={[
                  ["Meaning", "The array has lost redundancy. One more failure loses data."],
                  ["Next check", <>Identify the missing member by serial with <Code>lsblk -o NAME,SIZE,MODEL,SERIAL</Code>.</>],
                ]}
              />
            )}
            {arrayReading.source && <Source>{arrayReading.source}</Source>}
          </Panel>
        </Section>
      )}

      {diskSerials.length > 0 ? (
        <Section title="Physical disks" count={diskSerials.length}>
          <div className="flex flex-col gap-3">
            {diskSerials.map((serial) => {
              const disk = smartDisks[serial];
              const diskReadings = readings.filter((r: any) => r.key?.startsWith(`disk.${serial}.`));
              const crcReading = diskReadings.find((r: any) => r.key === `disk.${serial}.crc`);
              const otherReadings = diskReadings.filter((r: any) => r.key !== `disk.${serial}.crc`);
              const diskStatus = diskReadings.length > 0
                ? worstStatus(diskReadings.map((r: any) => r.status))
                : disk.passed === false ? Status.CRITICAL : Status.HEALTHY;
              const coverage = humanDuration(crcReading?.extra?.coverage_seconds);

              return (
                <Panel key={serial}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="m-0 break-all font-mono text-lg font-semibold">{serial}</p>
                      <Readout value={disk.model || null} size="sm" className="text-silk-dim" note="Model not reported." />
                    </div>
                    <Stamp status={diskStatus} />
                  </div>

                  <Well className="px-4 py-4">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                      <Metric label="Temperature" value={disk.temperatureCelsius != null ? disk.temperatureCelsius.toFixed(0) : null} unit="°C" size="sm" />
                      <Metric label="Power-on hours" value={count(disk.powerOnHours)} size="sm" />
                      <Metric label="Power cycles" value={count(disk.powerCycleCount)} size="sm" />
                      <Metric label="Pending sectors" value={count(disk.currentPendingSectors)} size="sm" />
                    </div>
                  </Well>

                  {crcReading && (
                    <div className="grid grid-cols-1 items-center gap-x-5 gap-y-2.5 border-t border-seam pt-4 md:grid-cols-[minmax(0,1fr)_260px]">
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-3">
                          <Stamp status={crcReading.status} />
                          <span className="text-base font-semibold">UDMA CRC errors</span>
                        </div>
                        <Readout value={count(crcReading.value)} state={crcReading.state} note={crcReading.detail} />
                        {crcReading.detail && crcReading.value != null && <p className="m-0 text-sm leading-normal text-silk-dim text-pretty">{crcReading.detail}</p>}
                        {coverage && <Source>History covers {coverage}</Source>}
                      </div>
                      {crcReading.extra && <Ledger deltas={deltasFrom(crcReading.extra)} concern="WARNING" />}
                    </div>
                  )}

                  {otherReadings.length > 0 && (
                    <div className="flex flex-col">
                      {otherReadings.map((r: any) => (
                        <div key={r.key} className="grid grid-cols-1 items-center gap-x-5 gap-y-2 border-t border-seam py-3 sm:grid-cols-[118px_minmax(0,1fr)_minmax(110px,auto)] lg:grid-cols-[118px_minmax(0,1fr)_minmax(110px,auto)_260px]">
                          <div><Stamp status={r.status} /></div>
                          <div className="min-w-0">
                            <p className="m-0 text-sm font-semibold">{shortLabel(String(r.label ?? r.key), serial)}</p>
                            {r.detail && <p className="m-0 mt-0.5 text-[13px] leading-normal text-silk-dim text-pretty">{r.detail}</p>}
                          </div>
                          <div className="min-w-0">
                            <Readout value={typeof r.value === "number" ? count(r.value) : r.value} unit={r.value != null ? r.unit : undefined} state={r.state} size="sm" />
                          </div>
                          <div className="min-w-0">{hasDeltas(r.extra) && <Ledger deltas={deltasFrom(r.extra)} concern="WARNING" />}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        </Section>
      ) : arrayReading ? (
        <Section title="Physical disks">
          <Void state={smartReading?.state ?? "NOT_CONFIGURED"} note={smartNote} />
        </Section>
      ) : null}

      {diskSerials.length === 0 && !arrayReading && (
        <EmptyState title="No RAID or SMART data">
          {smartNote} Until then this page can&rsquo;t say whether the array is redundant or the disks are healthy.
        </EmptyState>
      )}
    </div>
  );
}
