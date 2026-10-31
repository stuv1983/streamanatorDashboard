"use client";

import useSWR from "swr";
import type { Snapshot } from "@/lib/snapshot";
import { Acquiring, ErrorState, Ledger, Readout, Source, Stamp, deltasFrom, hasDeltas, type StatusLike } from "@/components/instrument";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

export function useSnapshot() {
  return useSWR<Snapshot>("/api/snapshot", fetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
    revalidateOnFocus: true,
  });
}

export function SnapshotBoundary({ data, error, isLoading, children }: {
  data?: Snapshot;
  error?: unknown;
  isLoading: boolean;
  children: (snapshot: Snapshot) => React.ReactNode;
}) {
  if (error && !data) return <ErrorState title="The snapshot didn't load" detail={error}>The collector at <span className="font-mono">/api/snapshot</span> returned an error. Check <span className="font-mono">/diagnostics</span> for which source failed.</ErrorState>;
  if (isLoading && !data) return <Acquiring rows={4} />;
  return data ? <>{children(data)}</> : null;
}

/** Kept for existing callers; renders the instrument stamp. */
export function StatusBadge({ status, label }: { status?: StatusLike; label?: string }) {
  return <Stamp status={status ?? "UNKNOWN"} label={label} />;
}

/** One instrument row per reading: status, label and detail, value or void, change ledger, source. */
export function ReadingCards({ readings }: { readings: any[] }) {
  if (!readings.length) {
    return <Readout value={null} state="NO_DATA" note="No readings have been collected for this area yet." />;
  }
  return (
    <div className="flex flex-col">
      {readings.map((reading) => {
        const ledger = hasDeltas(reading.extra);
        return (
          <div key={reading.key} className="grid grid-cols-1 items-center gap-x-5 gap-y-2.5 border-t border-seam px-1 py-3.5 md:grid-cols-[128px_minmax(0,1fr)_minmax(150px,220px)] xl:grid-cols-[128px_minmax(0,1fr)_minmax(150px,220px)_260px]">
            <div><Stamp status={reading.status} /></div>
            <div className="min-w-0">
              <p className="m-0 text-base font-semibold">{reading.label}</p>
              {reading.detail && <p className="m-0 mt-1 text-sm leading-normal text-silk-dim text-pretty">{reading.detail}</p>}
              {reading.source && <Source className="mt-1 block">{reading.source}</Source>}
            </div>
            <div className="min-w-0">
              <Readout value={formatValue(reading.value)} unit={reading.value != null ? reading.unit : undefined} state={reading.state} />
            </div>
            <div className="min-w-0">{ledger && <Ledger deltas={deltasFrom(reading.extra)} />}</div>
          </div>
        );
      })}
    </div>
  );
}

export function DataTable({ rows, empty = "No data available." }: { rows: Array<Record<string, unknown>>; empty?: string }) {
  if (!rows.length) return <Readout value={null} state="NO_DATA" note={empty} />;
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return (
    <div className="overflow-x-auto rounded-[3px] border border-seam">
      <table className="w-full text-sm">
        <thead className="bg-well">
          <tr className="border-b border-seam">
            {columns.map((column) => <th key={column} className="px-3 py-2.5 text-left font-panel text-[9.5px] font-normal uppercase tracking-[0.12em] text-graphite">{column.replace(/_/g, " ")}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-seam last:border-0 hover:bg-bezel/60">
              {columns.map((column) => {
                const v = row[column];
                const missing = v == null || v === "";
                return <td key={column} className="px-3 py-2.5 font-mono text-[13px]">{missing ? <span className="text-graphite">n/a</span> : formatCell(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatValue(value: unknown): React.ReactNode {
  if (value == null) return null;
  if (typeof value === "number") return value.toLocaleString("en-AU", { maximumFractionDigits: 2 });
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatCell(value: unknown): string {
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
