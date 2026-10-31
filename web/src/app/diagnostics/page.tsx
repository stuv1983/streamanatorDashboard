"use client";

import useSWR from "swr";
import { Code, EmptyState, ErrorState, Metric, PageHeader, Panel, Readout, Section, Stamp, Void, Well } from "@/components/instrument";
import { DataTable, SnapshotBoundary, useSnapshot } from "@/components/snapshot-ui";

const fetcher = async (url: string) => { const response = await fetch(url); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`); return body; };

function clock(ts: number | null | undefined, withDate = false): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleString("en-AU", withDate ? { dateStyle: "medium", timeStyle: "short" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function DiagnosticsPage() {
  const snapshotResult = useSnapshot();
  const diagnostics = useSWR("/api/diagnostics", fetcher, { refreshInterval: 60_000 });
  const collected = clock(snapshotResult.data?.collected_at);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        group="Operations"
        title="Diagnostics"
        description="Whether the collector, the history sampler and each data source are working, and which ones failed."
        meta={collected ? `snapshot ${collected}` : undefined}
      />
      <SnapshotBoundary {...snapshotResult}>{(snapshot) => {
        const errorRows: Array<Record<string, unknown>> = [];
        for (const [area, value] of Object.entries(snapshot.raw)) {
          if (value && typeof value === "object") for (const [key, detail] of Object.entries(value as Record<string, unknown>)) if (key.includes("error") && detail) errorRows.push({ area, collector: key, detail });
        }
        const sourceRows = Object.entries(snapshot.sources).map(([area, source]) => ({ area, source }));
        const d = diagnostics.data;
        const sampler = d?.runtime?.sampler;
        const history = d?.history;
        const pendingState = diagnostics.error ? "ERROR" : "ACQUIRING";
        const pendingNote = diagnostics.error ? "/api/diagnostics failed" : undefined;

        return (
          <div className="flex flex-col gap-10">
            {diagnostics.error && (
              <ErrorState title="The diagnostics endpoint didn't load" detail={diagnostics.error}>
                Sampler and history figures below are unavailable. Check the dashboard server log for <Code>/api/diagnostics</Code>.
              </ErrorState>
            )}

            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title="Snapshot">
                <Well className="grid grid-cols-2 gap-x-6 gap-y-5">
                  <Metric label="Collection took" value={snapshot.duration_seconds?.toFixed(2)} unit="s" size="lg" />
                  <Metric label="Collected" value={clock(snapshot.collected_at)} size="sm" hint={clock(snapshot.collected_at, true)} />
                </Well>
              </Panel>

              <Panel title="History sampler" action={sampler ? <Stamp status={sampler.running ? "HEALTHY" : "WARNING"} label={sampler.running ? "RUNNING" : "STOPPED"} /> : undefined}>
                <Well className="grid grid-cols-2 gap-x-6 gap-y-5">
                  <Metric label="Runs" value={sampler?.runs ?? null} state={d ? "OK" : pendingState} note={pendingNote} size="lg" />
                  <Metric label="Last run" value={clock(sampler?.last_run)} state={d ? "OK" : pendingState} size="sm" note={d ? "hasn't run yet" : undefined} />
                  {sampler?.interval_seconds != null && <Metric label="Interval" value={sampler.interval_seconds} unit="s" size="sm" />}
                </Well>
                {d ? (
                  sampler?.last_error
                    ? <div className="flex flex-col gap-2"><Stamp status="WARNING" label="LAST ERROR" /><pre className="well m-0 overflow-x-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-xs text-silk-dim">{sampler.last_error}</pre></div>
                    : <p className="m-0 text-sm text-silk-dim">No sampler error since the server started.</p>
                ) : null}
              </Panel>

              <Panel title="History store">
                <Well className="grid grid-cols-2 gap-x-6 gap-y-5">
                  <Metric label="Samples retained" value={history?.samples != null ? history.samples.toLocaleString("en-AU") : null} state={d ? "OK" : pendingState} note={pendingNote} size="lg" />
                  <Metric label="Metrics" value={history?.metrics ?? null} state={d ? "OK" : pendingState} size="sm" />
                  <Metric label="Oldest" value={clock(history?.oldest, true)} state={d ? "OK" : pendingState} size="sm" note={d ? "empty store" : undefined} />
                  <Metric label="Newest" value={clock(history?.newest, true)} state={d ? "OK" : pendingState} size="sm" note={d ? "empty store" : undefined} />
                </Well>
              </Panel>
            </div>

            <Section title="Collector source routing" count={sourceRows.length} note="Where each area's figures come from">
              {sourceRows.length ? <DataTable rows={sourceRows} /> : <Void note="The snapshot listed no sources." />}
            </Section>

            <Section title="Collector errors" count={errorRows.length}>
              {errorRows.length === 0 ? (
                <EmptyState title="No collector errors">
                  No collector reported an error in the current snapshot. Areas that aren&apos;t configured show as voids on their own pages, not here.
                </EmptyState>
              ) : (
                <DataTable rows={errorRows} />
              )}
            </Section>

            {d?.runtime?.snapshot_error && (
              <Section title="Last snapshot failure">
                <Readout value={null} state="ERROR" note={<span className="font-mono">{d.runtime.snapshot_error}</span>} />
              </Section>
            )}
          </div>
        );
      }}</SnapshotBoundary>
    </div>
  );
}
