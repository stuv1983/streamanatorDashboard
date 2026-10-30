"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, CheckCircle2, HelpCircle, Info, OctagonAlert } from "lucide-react";
import { LiveProvider, useLive } from "@/components/live/LiveProvider";
import { LiveGraph, type GraphSeries } from "@/components/live/LiveGraph";
import type { LiveFrame } from "@/lib/live";
import type { Snapshot } from "@/lib/snapshot";
import { Status } from "@/lib/status";
import { humanBitsPerSecond, humanBytes, humanBytesPerSecond, humanDuration } from "@/lib/utils/formatting";

// The always-on screen. Designed to be read from across a room in a couple of
// seconds: status first, then what needs attention, then live load. It has
// no controls and no hover, because nobody will be touching it.

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

const STATUS_STYLE: Record<string, { color: string; icon: typeof CheckCircle2; label: string }> = {
  [Status.HEALTHY]: { color: "var(--status-good)", icon: CheckCircle2, label: "Healthy" },
  [Status.INFO]: { color: "var(--series-1)", icon: Info, label: "Info" },
  [Status.WARNING]: { color: "var(--status-warning)", icon: AlertTriangle, label: "Warning" },
  [Status.CRITICAL]: { color: "var(--status-critical)", icon: OctagonAlert, label: "Critical" },
  [Status.UNKNOWN]: { color: "var(--chart-muted)", icon: HelpCircle, label: "Unknown" },
};
const styleOf = (s?: string) => STATUS_STYLE[s ?? Status.UNKNOWN] ?? STATUS_STYLE[Status.UNKNOWN];

/** A snapshot older than this is shown as stale rather than as current health. */
const SNAPSHOT_STALE_SECONDS = 180;

export default function WallPage() {
  return (
    <LiveProvider>
      <Wall />
    </LiveProvider>
  );
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Shift the whole layout a few pixels every few minutes so static text doesn't burn into the panel. */
function useBurnInShift() {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const timer = setInterval(() => setOffset({ x: Math.round(Math.random() * 8 - 4), y: Math.round(Math.random() * 6 - 3) }), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
  return offset;
}

function Wall() {
  const live = useLive();
  const now = useClock();
  const shift = useBurnInShift();
  const { data: snapshot, error: snapshotError } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 30_000, keepPreviousData: true, revalidateOnFocus: false });
  const { data: history } = useSWR<{ series: Record<string, [number, number][]> }>("/api/history?range=6h", fetcher, { refreshInterval: 60_000, keepPreviousData: true, revalidateOnFocus: false });

  const snapshotAge = snapshot && now ? now.getTime() / 1000 - snapshot.collected_at : null;
  const snapshotStale = Boolean(snapshotError) || snapshotAge === null || snapshotAge > SNAPSHOT_STALE_SECONDS;
  const overall = snapshotStale ? Status.UNKNOWN : snapshot?.health.status;
  const st = styleOf(overall);
  const Icon = st.icon;

  // Incidents first (cause + collapsed effects), then any actionable alert
  // that isn't already folded into one.
  const incidentKeys = new Set((snapshot?.incidents ?? []).flatMap(i => [i.cause.key, ...i.effects.map(e => e.key)]));
  const attention = [
    ...(snapshot?.incidents ?? []).map(i => ({ key: i.cause.key, status: i.cause.status, title: i.title || i.cause.title, detail: i.explanation || i.cause.detail, extra: i.effects.length ? `+${i.effects.length} related` : null })),
    ...(snapshot?.alerts ?? []).filter(a => (a.status === Status.CRITICAL || a.status === Status.WARNING) && !incidentKeys.has(a.key))
      .map(a => ({ key: a.key, status: a.status, title: a.title, detail: a.current_value ? `${a.current_value}${a.threshold ? ` (threshold ${a.threshold})` : ""}` : a.detail, extra: a.component })),
  ];

  const components = Object.values(snapshot?.components ?? {});
  const latency = history?.series.latency ?? [];
  const loss = history?.series.packet_loss ?? [];
  const latestLatency = latency.at(-1)?.[1];
  const latestLoss = loss.at(-1)?.[1];
  const { info, latest, frames } = live;
  const primaryNic = info?.nics.find(n => n.operstate === "up") ?? info?.nics[0];
  const arrayDisk = info?.disks.find(d => d.kind === "raid") ?? info?.disks[0];
  const nicOf = (f: LiveFrame) => f.nets.find(n => n.name === primaryNic?.name);
  const diskOf = (f: LiveFrame) => f.disks.find(d => d.name === arrayDisk?.name);
  const gpu = latest?.gpus[0];
  const diskNow = latest ? diskOf(latest) : undefined;
  const nicNow = latest ? nicOf(latest) : undefined;

  return (
    <div className="fixed inset-0 z-[200] cursor-none overflow-hidden bg-background text-foreground" style={{ fontSize: "clamp(12px, 1.05vw, 22px)" }}>
      <div className="flex h-full flex-col gap-[1.2em] p-[1.4em] transition-transform duration-[3000ms]" style={{ transform: `translate(${shift.x}px, ${shift.y}px)` }}>

        {/* Header: who, overall state, when */}
        <header className="flex items-center justify-between gap-[1.5em]">
          <div>
            <p className="text-[1.9em] font-semibold leading-none tracking-tight">{info?.hostname ?? "streamanator"}</p>
            <p className="mt-[0.3em] text-[0.95em] text-muted-foreground">
              up {humanDuration(latest?.uptimeSeconds, 2)} · {info?.logicalCpus ?? "—"} CPUs · {humanBytes(info?.memTotal, true, 0)}
            </p>
          </div>
          <div className="flex items-center gap-[0.8em] rounded-[0.6em] border-2 px-[1.2em] py-[0.5em]" style={{ borderColor: st.color }}>
            <Icon style={{ color: st.color, width: "2.6em", height: "2.6em" }} aria-hidden />
            <div>
              <p className="text-[2.2em] font-bold leading-none" style={{ color: st.color }}>{snapshotStale ? "NO CURRENT DATA" : st.label.toUpperCase()}</p>
              <p className="mt-[0.25em] max-w-[34em] truncate text-[0.95em] text-muted-foreground">
                {snapshotStale
                  ? (snapshotError ? "Health check failing" : snapshot ? `Last health check ${Math.round((snapshotAge ?? 0) / 60)} min ago` : "Waiting for the first health check")
                  : `Score ${snapshot!.health.score.toFixed(0)}/100 · ${snapshot!.health.reason}`}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-mono text-[3.2em] font-semibold leading-none tabular-nums">{now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--"}</p>
            <p className="mt-[0.3em] text-[0.95em] text-muted-foreground">{now?.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</p>
          </div>
        </header>

        {live.stale && (
          <div role="status" className="rounded-[0.5em] border-2 border-[var(--status-warning)] bg-[var(--status-warning)]/10 px-[1em] py-[0.4em] text-[1.2em]">
            <strong className="text-[var(--status-warning)]">STALE</strong>{" "}
            {live.connected ? "Live samples stopped arriving." : "Lost connection to the server, reconnecting."}
            {live.lastFrameAt ? ` Graphs frozen at ${new Date(live.lastFrameAt).toLocaleTimeString()}.` : ""}
          </div>
        )}

        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] gap-[1.2em]">
          {/* Live load */}
          <section className="grid min-h-0 grid-cols-2 grid-rows-3 gap-[1em]" aria-label="Live load">
            <Tile title="CPU" value={latest?.cpu ? `${latest.cpu.total.toFixed(0)}%` : "—"}
              sub={latest?.load ? `load ${latest.load[0].toFixed(2)} · iowait ${latest.cpu?.iowait.toFixed(0) ?? "—"}%` : ""}
              frames={frames} max={100} series={[{ key: "c", label: "CPU", color: "var(--series-1)", value: f => f.cpu?.total }]} />
            <Tile title="Memory" value={latest?.mem ? `${((100 * latest.mem.used) / latest.mem.total).toFixed(0)}%` : "—"}
              sub={latest?.mem ? `${humanBytes(latest.mem.used, true, 1)} of ${humanBytes(latest.mem.total, true, 0)}${latest.mem.swapUsed ? ` · swap ${humanBytes(latest.mem.swapUsed, true, 0)}` : ""}` : ""}
              frames={frames} max={100} series={[{ key: "m", label: "Memory", color: "var(--series-7)", value: f => (f.mem ? (100 * f.mem.used) / f.mem.total : null) }]} />
            <Tile title={`Storage ${arrayDisk?.name ?? ""}`} value={diskNow ? `${diskNow.busyPercent.toFixed(0)}%` : "—"}
              sub={diskNow ? `R ${humanBytesPerSecond(diskNow.readBps, 0)} · W ${humanBytesPerSecond(diskNow.writeBps, 0)}` : "active time"}
              frames={frames} max={100} series={[{ key: "d", label: "Active time", color: "var(--series-3)", value: f => diskOf(f)?.busyPercent }]} />
            <Tile title={`Network ${primaryNic?.name ?? ""}`} value={nicNow ? humanBitsPerSecond(nicNow.rxBps * 8, 0) : "—"}
              sub={nicNow ? `sent ${humanBitsPerSecond(nicNow.txBps * 8, 0)}` : ""}
              frames={frames} max="auto" series={[
                { key: "rx", label: "Receive", color: "var(--series-1)", value: f => nicOf(f)?.rxBps },
                { key: "tx", label: "Send", color: "var(--series-2)", value: f => nicOf(f)?.txBps, fill: false },
              ]} />
            <Tile title="Internet" value={latestLatency !== undefined ? `${latestLatency.toFixed(0)} ms` : "—"}
              sub={latestLoss !== undefined ? `${latestLoss.toFixed(0)}% packet loss · last 6 h` : "latency to 1.1.1.1"}>
              <HistorySpark points={latency} color="var(--series-4)" />
            </Tile>
            {gpu ? (
              <Tile title="GPU" value={`${(gpu.utilPercent ?? 0).toFixed(0)}%`}
                sub={`decode ${gpu.decoderPercent ?? "—"}% · encode ${gpu.encoderPercent ?? "—"}%${gpu.temperatureC !== null ? ` · ${gpu.temperatureC} °C` : ""}`}
                frames={frames} max={100} series={[
                  { key: "u", label: "3D", color: "var(--series-5)", value: f => f.gpus[0]?.utilPercent },
                  { key: "d", label: "Decode", color: "var(--series-1)", value: f => f.gpus[0]?.decoderPercent, fill: false },
                ]} />
            ) : (
              <Tile title="Pressure" value={latest?.psi ? `${Math.max(latest.psi.cpu.some ?? 0, latest.psi.memory.some ?? 0, latest.psi.io.some ?? 0).toFixed(1)}%` : "—"}
                sub="worst stall: cpu / memory / io" frames={frames} max="auto"
                series={[{ key: "p", label: "Stall", color: "var(--series-4)", value: f => f.psi ? Math.max(f.psi.cpu.some ?? 0, f.psi.memory.some ?? 0, f.psi.io.some ?? 0) : null }]} />
            )}
          </section>

          {/* Attention + subsystems */}
          <section className="flex min-h-0 flex-col gap-[1em]">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[0.6em] border bg-card p-[1em]">
              <h2 className="mb-[0.6em] text-[0.85em] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                Needs attention{!snapshotStale && attention.length > 0 ? ` · ${attention.length}` : ""}
              </h2>
              {snapshotStale ? (
                <p className="text-[1.3em] text-muted-foreground">Health is unknown until the next successful check. That isn&apos;t the same as healthy.</p>
              ) : attention.length === 0 ? (
                <div className="flex items-center gap-[0.6em] text-[1.6em]" style={{ color: "var(--status-good)" }}>
                  <CheckCircle2 style={{ width: "1.3em", height: "1.3em" }} aria-hidden /> All clear
                </div>
              ) : (
                <FitList more={n => `and ${n} more — see Overview`}>
                  {attention.map(a => {
                    const s = styleOf(a.status);
                    const AIcon = s.icon;
                    return (
                      <li key={a.key} className="flex gap-[0.6em] border-l-4 pl-[0.6em]" style={{ borderColor: s.color }}>
                        <AIcon style={{ color: s.color, width: "1.4em", height: "1.4em", flexShrink: 0 }} aria-label={s.label} />
                        <div className="min-w-0">
                          <p className="truncate text-[1.25em] font-semibold leading-tight">{a.title}</p>
                          <p className="line-clamp-2 text-[0.95em] text-muted-foreground">{a.detail}{a.extra ? ` · ${a.extra}` : ""}</p>
                        </div>
                      </li>
                    );
                  })}
                </FitList>
              )}
            </div>
            <div className="grid grid-cols-2 gap-[0.5em]" aria-label="Subsystems">
              {components.map(c => {
                const s = styleOf(snapshotStale ? Status.UNKNOWN : c.status);
                const CIcon = s.icon;
                return (
                  <div key={c.key} className="flex items-center gap-[0.5em] rounded-[0.5em] border bg-card px-[0.7em] py-[0.45em]">
                    <CIcon style={{ color: s.color, width: "1.3em", height: "1.3em", flexShrink: 0 }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[1.05em]">{c.label}</span>
                    <span className="text-[0.8em] font-semibold uppercase" style={{ color: s.color }}>{s.label}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </main>

        {/* Recent changes ticker */}
        <footer className="flex items-center gap-[1em] overflow-hidden whitespace-nowrap border-t pt-[0.6em] text-[0.95em] text-muted-foreground">
          <span className="font-semibold uppercase tracking-[0.15em]">Recent</span>
          {(snapshot?.changes ?? []).slice(0, 5).map((c, i) => (
            <span key={i} className="truncate">
              <span className="font-mono">{new Date(c.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> {c.summary}
            </span>
          ))}
          {!snapshot?.changes?.length && <span>No changes recorded.</span>}
        </footer>
      </div>
    </div>
  );
}

function Tile({ title, value, sub, frames, series, max, children }: {
  title: string; value: string; sub: string; frames?: LiveFrame[]; series?: GraphSeries[]; max?: number | "auto"; children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-[0.6em] border bg-card p-[0.9em]">
      <div className="flex items-baseline justify-between gap-[0.5em]">
        <h2 className="truncate text-[0.85em] font-semibold uppercase tracking-[0.15em] text-muted-foreground">{title}</h2>
        <p className="font-mono text-[2.3em] font-semibold leading-none tabular-nums">{value}</p>
      </div>
      <div className="mt-[0.2em] flex items-center justify-between gap-[0.8em] text-[0.85em] text-muted-foreground">
        {/* Two series in one sparkline: name them, so identity is never colour alone. */}
        <span className="flex shrink-0 gap-[0.8em]">
          {series && series.length > 1 && series.map(s => (
            <span key={s.key} className="flex items-center gap-[0.35em]">
              <i className="inline-block h-[0.6em] w-[0.6em] rounded-full" style={{ background: s.color }} />{s.label}
            </span>
          ))}
        </span>
        <span className="truncate">{sub}</span>
      </div>
      <div className="mt-[0.4em] min-h-0 flex-1">
        {children ?? (frames && series && <LiveGraph frames={frames} series={series} max={max} windowSeconds={600} compact className="h-full w-full" />)}
      </div>
    </div>
  );
}

/**
 * Shows as many whole items as fit the space, then "and N more". A fixed
 * count either wastes a large screen or cuts an item in half on a small one.
 */
function FitList({ children, more }: { children: React.ReactNode[]; more: (hidden: number) => string }) {
  const listRef = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState(children.length);
  const signature = children.map(c => (c as React.ReactElement).key).join("|");
  useLayoutEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    const measure = () => {
      const items = Array.from(ul.children) as HTMLElement[];
      for (const li of items) li.style.display = "";
      let n = 0;
      for (const li of items) {
        if (li.offsetTop + li.offsetHeight <= ul.clientHeight) n++;
        else break;
      }
      items.forEach((li, i) => { li.style.display = i < n ? "" : "none"; });
      setFit(n);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ul);
    return () => observer.disconnect();
  }, [signature]);
  const hidden = children.length - fit;
  return (
    <>
      <ul ref={listRef} className="relative min-h-0 flex-1 space-y-[0.7em] overflow-hidden">{children}</ul>
      {hidden > 0 && <p className="mt-[0.4em] text-[0.95em] text-muted-foreground">{more(hidden)}</p>}
    </>
  );
}

/** One-minute history from SQLite: the live stream has no internet latency. */
function HistorySpark({ points, color }: { points: [number, number][]; color: string }) {
  if (points.length < 2) return <p className="text-[0.85em] text-muted-foreground">Collecting history…</p>;
  const t0 = points[0][0], t1 = points.at(-1)![0];
  const max = Math.max(...points.map(p => p[1]), 1) * 1.15;
  const path = points.map(([t, v], i) => `${i ? "L" : "M"}${(((t - t0) / (t1 - t0 || 1)) * 100).toFixed(2)},${(100 - (v / max) * 100).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" role="img" aria-label="Internet latency, last 6 hours">
      <path d={`${path} L100,100 L0,100 Z`} fill={color} opacity={0.16} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
