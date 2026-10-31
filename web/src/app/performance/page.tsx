"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Acquiring, ErrorState, Metric, PageHeader, Readout, Section, Segmented, Void, Well } from "@/components/instrument";

type Point = [number, number];
type HistoryResponse = {
  range: string;
  generated_at: number;
  series: Record<string, Point[]>;
};

const RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;

const fetcher = (url: string) => fetch(url).then(async response => {
  if (!response.ok) throw new Error((await response.json()).error ?? "History request failed");
  return response.json();
});

function mergeSeries(series: Record<string, Point[]>, keys: string[]) {
  const rows = new Map<number, Record<string, number>>();
  for (const key of keys) {
    for (const [timestamp, value] of series[key] ?? []) {
      const row = rows.get(timestamp) ?? { timestamp };
      row[key] = value;
      rows.set(timestamp, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function formatBytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB/s`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB/s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB/s`;
  return `${Math.round(value)} B/s`;
}

function latest(points: Point[] = []) { return points.at(-1)?.[1] ?? null; }
function peak(points: Point[] = []) { return points.length ? Math.max(...points.map(point => point[1])) : null; }
/** Highest of several peaks; null only when none of them has data (never a fake zero). */
function maxOf(...values: Array<number | null>) {
  const known = values.filter((v): v is number => v != null);
  return known.length ? Math.max(...known) : null;
}

const AXIS_TICK = { fill: "var(--graphite)", fontFamily: "var(--font-mono)" };

function SignalLane({ title, subtitle, data, lines, domain, formatter }: {
  title: string;
  subtitle: string;
  data: Record<string, number>[];
  lines: { key: string; label: string; color: string }[];
  domain?: [number | "auto", number | "auto"];
  formatter: (value: number) => string;
}) {
  const current = data.at(-1)?.[lines[0].key];
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const chart = (large = false) => data.length < 2 ? (
    <Void state="ACQUIRING" className="h-full" note="Collecting samples. This lane fills in over the next few minutes." />
  ) : (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 6, right: large ? 20 : 10, bottom: 0, left: large ? 12 : 0 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="timestamp"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={value => new Date(value * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          tick={{ ...AXIS_TICK, fontSize: large ? 12 : 10.5 }}
          stroke="var(--chart-axis)"
          tickLine={false}
          minTickGap={42}
        />
        <YAxis
          domain={domain ?? [0, "auto"]}
          tickFormatter={value => formatter(Number(value))}
          tick={{ ...AXIS_TICK, fontSize: large ? 12 : 10.5 }}
          stroke="var(--chart-axis)"
          tickLine={false}
          axisLine={false}
          width={large ? 80 : 66}
        />
        <Tooltip
          labelFormatter={value => new Date(Number(value) * 1000).toLocaleString()}
          formatter={(value: any, name: any) => [formatter(Number(value)), lines.find(line => line.key === name)?.label ?? name]}
          contentStyle={{ background: "var(--bezel)", border: "1px solid var(--seam-strong)", borderRadius: 3, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--silk)" }}
          labelStyle={{ color: "var(--graphite)" }}
          itemStyle={{ color: "var(--silk)" }}
          cursor={{ stroke: "var(--seam-strong)" }}
        />
        {lines.map(line => (
          <Area
            key={line.key}
            type="monotone"
            dataKey={line.key}
            stroke={line.color}
            fill={line.color}
            fillOpacity={0.12}
            strokeWidth={large ? 2 : 1.5}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );

  const legend = (
    <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs text-silk-dim">
      {lines.map(line => (
        <span key={line.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3" style={{ background: line.color }} aria-hidden />
          {line.label}
        </span>
      ))}
    </div>
  );

  return (
    <>
      <div className="flex min-w-0 flex-col gap-3 rounded-[3px] border border-seam bg-bezel px-5 py-[18px]">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h3 className="panel-label m-0">{title}</h3>
            <p className="m-0 mt-1.5 text-sm leading-snug text-silk-dim">{subtitle}</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex flex-col items-end gap-1">
              {data.length >= 2 && <Readout value={current == null ? null : formatter(current)} size="md" note="No latest sample." />}
              {legend}
            </div>
            <button
              type="button"
              aria-label={`Expand ${title} graph`}
              onClick={() => setExpanded(true)}
              className="min-h-10 shrink-0 rounded-[2px] border border-seam px-3 text-[13px] font-semibold text-silk-dim hover:border-seam-strong hover:text-silk"
            >
              Expand
            </button>
          </div>
        </div>
        <div
          onClick={() => setExpanded(true)}
          role="button"
          tabIndex={0}
          aria-label={`Expand ${title} graph`}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setExpanded(true); } }}
          className="well h-48 cursor-zoom-in px-1 pb-1 pt-2"
        >
          {chart()}
        </div>
      </div>
      {expanded && (
        <div role="dialog" aria-modal="true" aria-label={`${title} expanded graph`} className="fixed inset-0 z-[100] flex flex-col gap-4 bg-enamel p-4 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-seam pb-4">
            <div className="min-w-0">
              <h2 className="panel-label m-0">{title}</h2>
              <p className="m-0 mt-1.5 text-base text-silk-dim">{subtitle}</p>
            </div>
            <div className="flex items-center gap-4">
              {legend}
              <button
                autoFocus
                type="button"
                aria-label={`Close ${title} graph`}
                onClick={() => setExpanded(false)}
                className="min-h-10 shrink-0 rounded-[2px] border border-seam-strong bg-bezel px-4 text-sm font-semibold text-silk hover:bg-well"
              >
                Close
              </button>
            </div>
          </div>
          <div className="well min-h-0 flex-1 p-2">{chart(true)}</div>
        </div>
      )}
    </>
  );
}

export default function PerformancePage() {
  const [range, setRange] = useState("24h");
  const { data, error, isLoading } = useSWR<HistoryResponse>(`/api/history?range=${range}`, fetcher, { refreshInterval: 30000, keepPreviousData: true });
  const series = useMemo(() => data?.series ?? {}, [data?.series]);
  const lanes = useMemo(() => ({
    cpu: mergeSeries(series, ["cpu", "iowait"]),
    memory: mergeSeries(series, ["memory_used"]),
    disk: mergeSeries(series, ["disk_read", "disk_write"]),
    network: mergeSeries(series, ["network_rx", "network_tx"]),
    latency: mergeSeries(series, ["latency", "packet_loss"]),
  }), [series]);

  const header = (
    <PageHeader
      group="Infrastructure"
      title="Performance history"
      description="Where has the host been under pressure, stalled or busy with traffic over the chosen window?"
      meta={["local history · 1-minute samples", data?.generated_at && `generated ${new Date(data.generated_at * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`].filter(Boolean).join(" · ")}
      actions={
        <Segmented
          label="History window"
          options={RANGES.map(option => ({ value: option, label: <span className="font-mono">{option}</span> }))}
          value={range as (typeof RANGES)[number]}
          onChange={setRange}
        />
      }
    >
      {error && data ? (
        <Void state="STALE" note={`The latest refresh failed (${error instanceof Error ? error.message : String(error)}). Showing the previous history until it recovers.`} />
      ) : null}
    </PageHeader>
  );

  if (error && !data) {
    return (
      <div className="flex flex-col gap-10">
        {header}
        <ErrorState title="Performance history didn't load" detail={error}>
          The request to <span className="font-mono">/api/history?range={range}</span> failed. Check that the history store is writable and see <span className="font-mono">/diagnostics</span>.
        </ErrorState>
      </div>
    );
  }
  if (isLoading && !data) {
    return (
      <div className="flex flex-col gap-10">
        {header}
        <Acquiring rows={4} />
      </div>
    );
  }

  const pct = (v: number) => v.toFixed(1);
  const summary: Array<{ label: string; value: number | null; format: (v: number) => string; unit?: string }> = [
    { label: "CPU now", value: latest(series.cpu), format: pct, unit: "%" },
    { label: "CPU peak", value: peak(series.cpu), format: pct, unit: "%" },
    { label: "Memory now", value: latest(series.memory_used), format: pct, unit: "%" },
    { label: "Latency peak", value: peak(series.latency), format: (v: number) => v.toFixed(0), unit: "ms" },
    { label: "Disk peak", value: maxOf(peak(series.disk_read), peak(series.disk_write)), format: formatBytes },
    { label: "Network peak", value: maxOf(peak(series.network_rx), peak(series.network_tx)), format: formatBytes },
  ];

  return (
    <div className="flex flex-col gap-10">
      {header}

      <Section title="Window summary" note={`Last ${range}`}>
        <Well>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-6">
            {summary.map(item => (
              <Metric
                key={item.label}
                label={item.label}
                value={item.value == null ? null : item.format(item.value)}
                unit={item.value == null ? undefined : item.unit}
                note="No samples in this window."
              />
            ))}
          </div>
        </Well>
      </Section>

      <Section title="Signals" count={5}>
        <div className="grid gap-4 xl:grid-cols-2">
          <SignalLane title="Processor" subtitle="Total CPU pressure and time waiting on storage" data={lanes.cpu} lines={[{ key: "cpu", label: "CPU", color: "var(--series-1)" }, { key: "iowait", label: "I/O wait", color: "var(--series-2)" }]} domain={[0, 100]} formatter={value => `${value.toFixed(0)}%`} />
          <SignalLane title="Memory" subtitle="Physical memory in active use" data={lanes.memory} lines={[{ key: "memory_used", label: "Used", color: "var(--series-1)" }]} domain={[0, 100]} formatter={value => `${value.toFixed(0)}%`} />
          <SignalLane title="Storage throughput" subtitle="Aggregate reads and writes across block devices" data={lanes.disk} lines={[{ key: "disk_read", label: "Read", color: "var(--series-1)" }, { key: "disk_write", label: "Write", color: "var(--series-2)" }]} formatter={formatBytes} />
          <SignalLane title="Network throughput" subtitle="Physical interfaces only; virtual container links are excluded" data={lanes.network} lines={[{ key: "network_rx", label: "Receive", color: "var(--series-1)" }, { key: "network_tx", label: "Send", color: "var(--series-2)" }]} formatter={formatBytes} />
          <div className="xl:col-span-2">
            <SignalLane title="Network response" subtitle="Internet latency to the ping target" data={lanes.latency} lines={[{ key: "latency", label: "Latency", color: "var(--series-1)" }]} formatter={value => `${value.toFixed(0)} ms`} />
          </div>
        </div>
      </Section>
    </div>
  );
}
