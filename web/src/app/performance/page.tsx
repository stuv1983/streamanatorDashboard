"use client";

import { useEffect, useId, useMemo, useState } from "react";
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
import { Activity, Cpu, Database, Expand, HardDrive, Network, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Point = [number, number];
type HistoryResponse = {
  range: string;
  generated_at: number;
  series: Record<string, Point[]>;
};

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

function SignalLane({ title, subtitle, icon, data, lines, domain, formatter }: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  data: Record<string, number>[];
  lines: { key: string; label: string; color: string }[];
  domain?: [number | "auto", number | "auto"];
  formatter: (value: number) => string;
}) {
  const current = data.at(-1)?.[lines[0].key];
  const [expanded, setExpanded] = useState(false);
  const gradientId = useId().replaceAll(":", "");

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const chart = (large = false) => {
    const chartGradientId = `${gradientId}-${large ? "expanded" : "card"}`;
    return data.length < 2 ? (
    <div className="grid h-full place-items-center text-xs text-muted-foreground">Collecting samples—this lane fills in over the next few minutes.</div>
  ) : (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: large ? 20 : 8, bottom: 0, left: large ? 12 : 0 }}>
        <defs>{lines.map(line => <linearGradient key={line.key} id={`${chartGradientId}-fill-${line.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={line.color} stopOpacity={0.35}/><stop offset="100%" stopColor={line.color} stopOpacity={0.02}/></linearGradient>)}</defs>
        <CartesianGrid strokeDasharray="2 5" vertical={false} stroke="var(--border)" opacity={0.5}/>
        <XAxis dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} tickFormatter={value => new Date(value * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} tick={{ fontSize: large ? 12 : 10 }} minTickGap={42}/>
        <YAxis domain={domain ?? [0, "auto"]} tickFormatter={value => formatter(Number(value))} tick={{ fontSize: large ? 12 : 10 }} width={large ? 76 : 62}/>
        <Tooltip labelFormatter={value => new Date(Number(value) * 1000).toLocaleString()} formatter={(value: any, name: any) => [formatter(Number(value)), lines.find(line => line.key === name)?.label ?? name]} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}/>
        {lines.map(line => <Area key={line.key} type="monotone" dataKey={line.key} stroke={line.color} fill={`url(#${chartGradientId}-fill-${line.key})`} strokeWidth={large ? 2.4 : 1.8} dot={false} connectNulls isAnimationActive={false}/>) }
      </AreaChart>
    </ResponsiveContainer>
    );
  };

  return (
    <>
    <Card className="group overflow-hidden border-border/70 bg-card/70 transition hover:border-cyan-500/40">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-1">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-start gap-2 text-right">
          <div>
          <p className="font-mono text-lg font-semibold tabular-nums">{current == null ? "—" : formatter(current)}</p>
          <div className="flex justify-end gap-3 text-[10px] text-muted-foreground">
            {lines.map(line => <span key={line.key}><i className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: line.color }} />{line.label}</span>)}
          </div>
          </div>
          <button type="button" aria-label={`Expand ${title} graph`} onClick={() => setExpanded(true)} className="grid h-11 w-11 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Expand className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent onClick={() => setExpanded(true)} role="button" tabIndex={0} aria-label={`Expand ${title} graph`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setExpanded(true); } }} className="h-48 cursor-zoom-in px-1 pb-1 pt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {chart()}
      </CardContent>
    </Card>
    {expanded && (
      <div role="dialog" aria-modal="true" aria-label={`${title} expanded graph`} className="fixed inset-0 z-[100] flex flex-col bg-background/98 p-3 backdrop-blur md:p-8">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div><h2 className="text-xl font-semibold">{title}</h2><p className="text-sm text-muted-foreground">{subtitle}</p></div>
          <button autoFocus type="button" aria-label={`Close ${title} graph`} onClick={() => setExpanded(false)} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>
        <div className="min-h-0 flex-1">{chart(true)}</div>
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

  if (error) return <div className="py-10 text-red-500">Performance history could not load: {String(error)}</div>;
  if (isLoading && !data) return <Skeleton className="h-[38rem] w-full" />;

  const summary = [
    { label: "CPU now", value: latest(series.cpu), format: (v: number) => `${v.toFixed(1)}%` },
    { label: "CPU peak", value: peak(series.cpu), format: (v: number) => `${v.toFixed(1)}%` },
    { label: "Memory now", value: latest(series.memory_used), format: (v: number) => `${v.toFixed(1)}%` },
    { label: "Latency peak", value: peak(series.latency), format: (v: number) => `${v.toFixed(0)} ms` },
    { label: "Disk peak", value: Math.max(peak(series.disk_read) ?? 0, peak(series.disk_write) ?? 0), format: formatBytes },
    { label: "Network peak", value: Math.max(peak(series.network_rx) ?? 0, peak(series.network_tx) ?? 0), format: formatBytes },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-500">Live signal desk</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Performance</h1>
          <p className="mt-1 text-muted-foreground">One-minute history for spotting pressure, stalls, and traffic spikes.</p>
        </div>
        <div className="flex rounded-lg border bg-muted/25 p-1">{["1h", "6h", "24h", "7d", "30d"].map(option => <button key={option} onClick={() => setRange(option)} className={`rounded-md px-3 py-1.5 font-mono text-xs transition ${range === option ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{option}</button>)}</div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-3 xl:grid-cols-6">
        {summary.map(item => <div key={item.label} className="bg-card px-4 py-3"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{item.label}</p><p className="mt-1 font-mono text-lg font-semibold tabular-nums">{item.value == null ? "—" : item.format(item.value)}</p></div>)}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SignalLane title="Processor" subtitle="Total CPU pressure and time waiting on storage" icon={<Cpu className="h-4 w-4 text-cyan-500"/>} data={lanes.cpu} lines={[{ key: "cpu", label: "CPU", color: "#22d3ee" }, { key: "iowait", label: "I/O wait", color: "#f59e0b" }]} domain={[0, 100]} formatter={value => `${value.toFixed(0)}%`}/>
        <SignalLane title="Memory" subtitle="Physical memory in active use" icon={<Database className="h-4 w-4 text-violet-500"/>} data={lanes.memory} lines={[{ key: "memory_used", label: "Used", color: "#8b5cf6" }]} domain={[0, 100]} formatter={value => `${value.toFixed(0)}%`}/>
        <SignalLane title="Storage throughput" subtitle="Aggregate reads and writes across block devices" icon={<HardDrive className="h-4 w-4 text-emerald-500"/>} data={lanes.disk} lines={[{ key: "disk_read", label: "Read", color: "#10b981" }, { key: "disk_write", label: "Write", color: "#f97316" }]} formatter={formatBytes}/>
        <SignalLane title="Network throughput" subtitle="Physical interfaces; virtual container links excluded" icon={<Network className="h-4 w-4 text-blue-500"/>} data={lanes.network} lines={[{ key: "network_rx", label: "Receive", color: "#3b82f6" }, { key: "network_tx", label: "Send", color: "#ec4899" }]} formatter={formatBytes}/>
        <div className="xl:col-span-2"><SignalLane title="Network response" subtitle="Internet latency with packet-loss pressure" icon={<Activity className="h-4 w-4 text-amber-500"/>} data={lanes.latency} lines={[{ key: "latency", label: "Latency", color: "#f59e0b" }]} formatter={value => `${value.toFixed(0)} ms`}/></div>
      </div>
    </div>
  );
}
