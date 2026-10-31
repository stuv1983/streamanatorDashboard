"use client";

import * as React from "react";
import { Code, EmptyState, Facts, Ledger, Meter, Metric, PageHeader, Panel, Readout, Section, Source, Stamp, Void, deltasFrom, hasDeltas } from "@/components/instrument";
import { SnapshotBoundary, useSnapshot } from "@/components/snapshot-ui";
import type { Snapshot } from "@/lib/snapshot";

function humanBytes(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0; let v = Math.abs(bytes);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${bytes < 0 ? "-" : ""}${v.toFixed(1)} ${units[i]}`;
}

function formatDate(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" });
}

function sampleTime(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Pulls the warn / critical numbers out of a reading's threshold text ("warn ≥80%, high ≥90%, critical ≥95%"). */
function limitsFrom(threshold: string | null | undefined): { warn?: number; crit?: number } {
  const t = threshold ?? "";
  const warn = t.match(/warn\s*[≥>]\s*([\d.]+)/i)?.[1];
  const crit = t.match(/critical\s*[≥>]\s*([\d.]+)/i)?.[1];
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

/** Growth over 7 / 30 / 90 days in the ledger's shape: zero stays grey, missing is hatched. */
function GrowthLedger({ cells }: { cells: Array<[string, number | null | undefined]> }) {
  return (
    <div className="grid grid-cols-3 gap-1" role="group" aria-label="Growth over time">
      {cells.map(([k, v]) => {
        const missing = v == null || Number.isNaN(v);
        const text = missing ? null : `${(v as number) > 0 ? "+" : ""}${humanBytes(v)}`;
        return (
          <div key={k} className={`flex flex-col items-end gap-0.5 rounded-[2px] border border-[#232b28] bg-well px-2 py-1.5 ${missing ? "void-fill" : ""}`}>
            <span className="font-panel text-[8.5px] uppercase tracking-[0.12em] text-graphite">{k}</span>
            <span className="font-mono text-sm tabular-nums" style={{ color: missing ? undefined : v === 0 ? "var(--graphite)" : "var(--silk)" }}>
              {missing ? <span className="bg-well px-0.5 text-graphite" aria-label="no data">n/a</span> : text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FilesystemRow({ reading }: { reading: any }) {
  const usage = reading.extra?.usage ?? null;
  const forecast = reading.extra?.forecast ?? null;
  const pct = typeof reading.value === "number" ? reading.value : null;
  const limits = limitsFrom(reading.threshold);
  const isInodes = String(reading.key).startsWith("storage.inodes.");
  const mount = String(reading.key).replace(/^storage\.(inodes\.)?/, "");

  return (
    <div className="flex flex-col gap-5 border-t border-seam px-1 py-5 first:border-t-0 first:pt-1">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <Stamp status={reading.status} />
            <p className="m-0 text-base font-semibold">{reading.label ?? reading.key}</p>
            {mount && mount !== reading.label && <span className="break-all font-mono text-sm text-silk-dim">{mount}</span>}
          </div>
          {reading.detail && <p className="m-0 text-sm leading-normal text-silk-dim text-pretty">{reading.detail}</p>}
        </div>
        <Readout value={pct} unit={isInodes ? "% inodes" : "% used"} state={reading.state} size="lg" />
      </div>

      {pct != null && (
        <div className="flex flex-col gap-1.5">
          <Meter value={pct} warn={limits.warn} crit={limits.crit} label={`${reading.label ?? reading.key} used`} />
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-xs text-graphite">
            <span>{usage ? `${humanBytes(usage.freeBytes)} free of ${humanBytes(usage.totalBytes)}` : ""}</span>
            {reading.threshold && <span>{reading.threshold}</span>}
          </div>
        </div>
      )}

      {usage && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Metric label="Total" value={humanBytes(usage.totalBytes)} size="sm" />
          <Metric label="Used" value={humanBytes(usage.usedBytes)} size="sm" />
          <Metric label="Free" value={humanBytes(usage.freeBytes)} size="sm" />
          <Metric label="Inodes used" value={usage.inodesUsedPercent != null ? usage.inodesUsedPercent.toFixed(1) : null} unit="%" size="sm" note="Not reported for this filesystem." />
        </div>
      )}

      {forecast?.available && (
        <div className="flex flex-col gap-3 rounded-[3px] border border-seam bg-well px-4 py-3.5">
          <span className="panel-label">Forecast</span>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <Metric label="Growth" value={humanBytes(forecast.growthBytesPerDay)} unit="/ day" size="sm" />
            <Metric label="Reaches 80%" value={formatDate(forecast.date80Percent)} state={forecast.date80Percent ? undefined : "NOT_PROJECTED"} size="sm" />
            <Metric label="Reaches 90%" value={formatDate(forecast.date90Percent)} state={forecast.date90Percent ? undefined : "NOT_PROJECTED"} size="sm" />
            <Metric label="Full" value={formatDate(forecast.date_full)} state={forecast.date_full ? undefined : "NOT_PROJECTED"} size="sm" />
          </div>
          <Source>
            Linear fit over {forecast.history_days?.toFixed(1) ?? "n/a"} days · {forecast.sample_count ?? "n/a"} samples · R² {forecast.r_squared?.toFixed(2) ?? "n/a"}
          </Source>
        </div>
      )}

      {forecast && !forecast.available && forecast.reason && (
        <Void state="NO_DATA" note={`Forecast unavailable: ${forecast.reason}`} />
      )}

      {forecast && (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-graphite">Growth in used space</span>
          <GrowthLedger cells={[["7 d", forecast.growthBytes7d], ["30 d", forecast.growthBytes30d], ["90 d", forecast.growthBytes90d]]} />
        </div>
      )}

      {hasDeltas(reading.extra) && <Ledger deltas={deltasFrom(reading.extra)} digits={1} />}
    </div>
  );
}

export default function StoragePage() {
  const { data, error, isLoading } = useSnapshot();
  return (
    <SnapshotBoundary data={data} error={error} isLoading={isLoading}>
      {(snapshot) => <StorageView snapshot={snapshot} />}
    </SnapshotBoundary>
  );
}

function StorageView({ snapshot }: { snapshot: Snapshot }) {
  const raw = (snapshot.raw?.storage ?? {}) as Record<string, any>;
  const component = snapshot.components?.storage;
  const readings: any[] = (component?.readings as any[]) ?? [];
  const alerts: any[] = (component?.alerts as any[]) ?? [];
  const filesystems = raw.filesystems ?? [];
  const filesystemCount = Array.isArray(filesystems) ? filesystems.length : Object.keys(filesystems).length;
  const fsReadings = readings.filter((r: any) => r.key?.startsWith("storage."));
  const sampled = sampleTime(snapshot.collected_at);
  const source = snapshot.sources?.storage;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        group="Infrastructure"
        title="Storage"
        description="How full is each filesystem, how fast is it growing, and when will it run out?"
        status={component?.status}
        meta={[source, sampled && `sampled ${sampled}`].filter(Boolean).join(" · ") || undefined}
      />

      <AlertPanels alerts={alerts} />

      {filesystemCount === 0 && readings.length === 0 ? (
        <EmptyState title="No filesystems are being measured">
          The collector has not reported any filesystem usage yet. Check that the mountpoints listed in the dashboard settings exist and are mounted on streamanator.
        </EmptyState>
      ) : (
        <Section title="Filesystems" count={fsReadings.length}>
          {fsReadings.length > 0 ? (
            <Panel>
              <div className="flex flex-col">
                {fsReadings.map((reading: any) => <FilesystemRow key={reading.key} reading={reading} />)}
              </div>
            </Panel>
          ) : (
            <Void state="NO_DATA" note="Filesystem usage was collected but produced no readings." />
          )}
        </Section>
      )}
    </div>
  );
}
