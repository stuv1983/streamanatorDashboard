"use client";

import * as React from "react";
import { Code, Facts, Meter, Metric, PageHeader, Panel, Readout, Section, Source, Stamp, Void, Well } from "@/components/instrument";
import { ReadingCards, SnapshotBoundary, useSnapshot } from "@/components/snapshot-ui";
import type { Snapshot } from "@/lib/snapshot";

function humanDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds < 0) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 && d === 0) parts.push(`${m}m`);
  return parts.join(" ") || "<1m";
}

function humanBytes(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fixed(v: unknown, digits = 1): string | null {
  return typeof v === "number" && !Number.isNaN(v) ? v.toFixed(digits) : null;
}

function sampleTime(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Pulls the warn / critical numbers out of a reading's threshold text ("warn >90%, critical >97%"). */
function limitsFrom(threshold: string | null | undefined): { warn?: number; crit?: number } {
  const t = threshold ?? "";
  const warn = t.match(/warn\s*[≥>]\s*([\d.]+)/i)?.[1];
  const crit = t.match(/critical\s*[≥>]\s*([\d.]+)/i)?.[1];
  return { warn: warn ? Number(warn) : undefined, crit: crit ? Number(crit) : undefined };
}

/** Available-memory limits are "below" thresholds ("warn <10%, critical <5% available"). */
function lowLimitsFrom(threshold: string | null | undefined): { warn?: number; crit?: number } {
  const t = threshold ?? "";
  const warn = t.match(/warn\s*<\s*([\d.]+)/i)?.[1];
  const crit = t.match(/critical\s*<\s*([\d.]+)/i)?.[1];
  return { warn: warn ? Number(warn) : undefined, crit: crit ? Number(crit) : undefined };
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

export default function ServerPage() {
  const { data, error, isLoading } = useSnapshot();
  return (
    <SnapshotBoundary data={data} error={error} isLoading={isLoading}>
      {(snapshot) => <ServerView snapshot={snapshot} />}
    </SnapshotBoundary>
  );
}

function ServerView({ snapshot }: { snapshot: Snapshot }) {
  const raw = (snapshot.raw?.server ?? {}) as Record<string, any>;
  const hostSnap = raw.snapshot ?? null;
  const cpu = hostSnap?.cpu ?? null;
  const memory = hostSnap?.memory ?? null;
  const load = hostSnap?.load ?? null;
  const component = snapshot.components?.server;
  const readings: any[] = (component?.readings as any[]) ?? [];
  const alerts: any[] = (component?.alerts as any[]) ?? [];
  const reading = (key: string) => readings.find((r) => r.key === key);
  const cpuReading = reading("server.cpu");
  const iowaitReading = reading("server.iowait");
  const memReading = reading("server.memory");
  const swapReading = reading("server.swap");
  const loadReading = reading("server.load");
  const tempReading = reading("server.temperature");

  const cpuLimits = limitsFrom(cpuReading?.threshold);
  const iowaitLimits = limitsFrom(iowaitReading?.threshold);
  const swapLimits = limitsFrom(swapReading?.threshold);
  const memLow = lowLimitsFrom(memReading?.threshold);

  const swapPercent: number | null = memory?.swapUsedPercent ?? memory?.swap_usedPercent ?? null;
  const noSwap = memory != null && memory.swapTotalBytes === 0;
  const availablePercent: number | null = memory?.availablePercent ?? null;
  const usedPercent = availablePercent == null ? null : 100 - availablePercent;

  const temperatures = (hostSnap?.temperatures ?? {}) as Record<string, number>;
  const sensorEntries = Object.entries(temperatures);
  const failedUnits = hostSnap?.failedUnits as any[] | null | undefined;
  const sampled = sampleTime(snapshot.collected_at);
  const source = snapshot.sources?.host;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        group="Infrastructure"
        title="Server"
        description="Is the streamanator host itself under pressure: processor, memory, temperature and systemd?"
        status={component?.status}
        meta={[source, sampled && `sampled ${sampled}`].filter(Boolean).join(" · ") || undefined}
      />

      <AlertPanels alerts={alerts} />

      <Section title="Host">
        <Well>
          <div className="grid grid-cols-1 gap-x-8 gap-y-6 min-[420px]:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-2">
              <Metric label="CPU" value={fixed(cpu?.usedPercent)} unit="%" state={cpuReading?.state} note={cpuReading?.detail || "CPU counters not read."} hint="Excludes iowait" />
              <Meter value={cpu?.usedPercent} warn={cpuLimits.warn} crit={cpuLimits.crit} label="CPU" />
            </div>
            <div className="flex flex-col gap-2">
              <Metric label="iowait" value={fixed(cpu?.iowaitPercent)} unit="%" state={iowaitReading?.state} note={iowaitReading?.detail || "CPU counters not read."} hint="Time waiting on storage" />
              <Meter value={cpu?.iowaitPercent} warn={iowaitLimits.warn} crit={iowaitLimits.crit} label="iowait" />
            </div>
            <div className="flex flex-col gap-2">
              <Metric label="RAM available" value={fixed(availablePercent)} unit="%" state={memReading?.state} note={memReading?.detail || "/proc/meminfo not read."} hint={memReading?.threshold || undefined} />
            </div>
            <div className="flex flex-col gap-2">
              <Metric
                label="Swap used"
                value={fixed(swapPercent)}
                unit="%"
                state={noSwap ? "NOT_CONFIGURED" : swapReading?.state}
                note={noSwap ? "No swap device on this host." : "Swap usage not read."}
              />
              {!noSwap && <Meter value={swapPercent} warn={swapLimits.warn} crit={swapLimits.crit} label="Swap used" />}
            </div>
            <Metric
              label="Load 1 / 5 / 15 min"
              value={load ? `${fixed(load.one, 2) ?? "n/a"} / ${fixed(load.five, 2) ?? "n/a"} / ${fixed(load.fifteen, 2) ?? "n/a"}` : null}
              size="sm"
              state={loadReading?.state}
              note="Load average not read."
              hint={loadReading?.threshold || undefined}
            />
            <Metric label="Uptime" value={humanDuration(hostSnap?.uptimeSeconds)} size="sm" note="Uptime not read." />
            <Metric label="Processes" value={hostSnap?.processCount ? (hostSnap.processCount as number).toLocaleString("en-AU") : null} size="sm" note="Process count not read." />
          </div>
        </Well>
      </Section>

      {memory && (
        <Section title="Memory" note="Availability is judged on MemAvailable, not free memory.">
          <Panel>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
              <Metric label="Total" value={humanBytes(memory.totalBytes)} size="sm" />
              <Metric label="Available" value={humanBytes(memory.availableBytes)} size="sm" />
              <Metric label="In use" value={humanBytes(memory.usedBytes)} size="sm" />
              <Metric label="Cache + buffers" value={humanBytes(memory.cachedBytes)} size="sm" />
            </div>
            <div className="flex flex-col gap-2">
              <Meter
                value={usedPercent}
                warn={memLow.warn != null ? 100 - memLow.warn : undefined}
                crit={memLow.crit != null ? 100 - memLow.crit : undefined}
                label="Memory in use"
              />
              <p className="m-0 text-xs leading-snug text-silk-dim">
                Bar shows memory in use. Cache is reclaimable memory doing useful work, so it counts as available.
                {memLow.warn != null && <> Ticks mark the alert points: warning below {memLow.warn}% available{memLow.crit != null && <>, critical below {memLow.crit}%</>}.</>}
              </p>
            </div>
          </Panel>
        </Section>
      )}

      <Section title="Temperatures" count={sensorEntries.length || undefined}>
        {sensorEntries.length > 0 ? (
          <Panel padded={false} className="px-5 py-1">
            <div className="flex flex-col">
              {sensorEntries.map(([sensor, temp], i) => (
                <div key={sensor} className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3 ${i ? "border-t border-seam" : ""}`}>
                  <span className="min-w-0 break-all font-mono text-sm text-silk-dim">{sensor}</span>
                  <Readout value={fixed(temp)} unit="°C" size="sm" />
                </div>
              ))}
            </div>
            {tempReading && (
              <div className="flex flex-wrap items-center gap-3 border-t border-seam py-3">
                <Stamp status={tempReading.status} />
                <span className="text-sm text-silk-dim">{tempReading.detail}</span>
              </div>
            )}
          </Panel>
        ) : (
          <Void state={tempReading?.state ?? "NO_DATA"} note={tempReading?.detail || "No temperature sensors reported."} />
        )}
      </Section>

      <Section title="systemd" count={Array.isArray(failedUnits) && failedUnits.length ? failedUnits.length : undefined} note={Array.isArray(failedUnits) && failedUnits.length ? "failed units" : undefined}>
        {failedUnits == null ? (
          <Void state="NO_DATA" note={<>systemd could not be queried. Check that the dashboard can run <Code>systemctl --failed</Code>.</>} />
        ) : failedUnits.length === 0 ? (
          <Panel>
            <div className="flex flex-wrap items-center gap-3">
              <Stamp status="HEALTHY" label="0 FAILED" />
              <span className="text-sm text-silk-dim">No failed systemd units.</span>
            </div>
          </Panel>
        ) : (
          <Panel padded={false} className="px-5 py-1">
            {failedUnits.map((unit, i) => (
              <div key={unit.name} className={`grid grid-cols-1 gap-x-5 gap-y-2.5 py-3.5 md:grid-cols-[110px_minmax(0,1fr)_minmax(0,320px)] ${i ? "border-t border-seam" : ""}`}>
                <div><Stamp status="CRITICAL" label="FAILED" /></div>
                <div className="min-w-0">
                  <p className="m-0 break-all font-mono text-[15px] font-semibold">{unit.name}</p>
                  {unit.description && <p className="m-0 mt-1 text-sm text-silk-dim">{unit.description}</p>}
                </div>
                <dl className="m-0 grid grid-cols-3 gap-2">
                  {([["Load", unit.load_state], ["Active", unit.active_state], ["Sub", unit.sub_state]] as const).map(([k, v]) => (
                    <div key={k} className="flex flex-col gap-0.5">
                      <dt className="text-xs text-graphite">{k}</dt>
                      <dd className="m-0"><Readout value={v || null} size="sm" /></dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </Panel>
        )}
      </Section>

      {readings.length > 0 && (
        <Section title="Health readings" count={readings.length}>
          <ReadingCards readings={readings} />
        </Section>
      )}
    </div>
  );
}
