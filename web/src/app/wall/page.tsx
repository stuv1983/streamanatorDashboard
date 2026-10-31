"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Lamp, ScoreRuler, Stamp, Void, normaliseStatus, type DataStateLike, type StatusLike } from "@/components/instrument";
import { LiveProvider, useLive } from "@/components/live/LiveProvider";
import { LiveGraph, type GraphSeries } from "@/components/live/LiveGraph";
import { StaleBanner } from "@/components/live/StaleBanner";
import type { LiveFrame } from "@/lib/live";
import type { Snapshot } from "@/lib/snapshot";
import { Status } from "@/lib/status";
import { cn } from "@/lib/utils";
import { humanBitsPerSecond, humanBytes, humanBytesPerSecond, humanDuration } from "@/lib/utils/formatting";

// The always-on screen. Designed to be read from across a room in a couple of
// seconds: the verdict first, then what needs attention, then live load. It
// has no controls and no hover, because nobody will be touching it.
//
// Everything is sized in em off the root's vw-based font-size, so the same
// layout fills a 7" Pi panel and a 4K TV. The instrument kit is px-sized for
// desk screens, so the wall scales its parts with em overrides below.

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

/** A snapshot older than this is shown as stale rather than as current health. */
const SNAPSHOT_STALE_SECONDS = 180;

const WORD: Record<string, string> = { HEALTHY: "Healthy", INFO: "Info", WARNING: "Warning", SERIOUS: "Serious", CRITICAL: "Critical", UNKNOWN: "Unknown" };
const wordOf = (s: StatusLike) => WORD[normaliseStatus(s)] ?? "Unknown";

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

/** "12.3 Mbps" -> { value: "12.3", unit: "Mbps" }, so the unit can sit smaller beside the figure. */
function split(text: string): { value: string; unit?: string } {
  const at = text.lastIndexOf(" ");
  return at > 0 ? { value: text.slice(0, at), unit: text.slice(at + 1) } : { value: text };
}

/* ------------------------------------------------------- em-scaled kit parts */

/** Silkscreened label, scaled with the wall. */
function WallLabel({ children, className, as: Tag = "span" }: { children: React.ReactNode; className?: string; as?: React.ElementType }) {
  return <Tag className={cn("panel-label m-0 text-[0.68em] leading-tight", className)}>{children}</Tag>;
}

/** The kit's hatched void, with its tag and note scaled with the wall. */
function WallVoid({ state, note, className }: { state: DataStateLike; note?: React.ReactNode; className?: string }) {
  return (
    <Void
      state={state}
      note={note}
      className={cn(
        "min-h-[2.4em] gap-[0.4em_0.6em] px-[0.6em] py-[0.4em]",
        "[&>span:first-child]:px-[0.5em] [&>span:first-child]:py-[0.2em] [&>span:first-child]:text-[0.66em]",
        "[&>span:nth-child(2)]:text-[0.9em]",
        className,
      )}
    />
  );
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

  // Live tiles never show a frozen number as if it were current.
  const liveState: DataStateLike = !latest ? (live.connected ? "ACQUIRING" : "NO_DATA") : live.stale ? "STALE" : "OK";
  const internetState: DataStateLike = latestLatency !== undefined ? "OK" : history ? "NO_DATA" : "ACQUIRING";

  // The verdict, in words.
  const verdictLabel = snapshotStale ? (snapshot ? "STALE" : "NO DATA") : normaliseStatus(overall);
  const headline = snapshotStale
    ? (snapshotError ? "Health check is failing" : snapshot ? `No health check for ${Math.round((snapshotAge ?? 0) / 60)} min` : "Waiting for the first health check")
    : attention.length === 0
      ? "Nothing needs attention"
      : `${attention[0].title}${attention.length > 1 ? `, and ${attention.length - 1} more` : ""}`;
  const subline = snapshotStale
    ? "Health is unknown until the next successful check. That isn't the same as healthy."
    : snapshot?.health.reason;

  const hostFacts = [
    latest?.uptimeSeconds != null ? `up ${humanDuration(latest.uptimeSeconds, 2)}` : null,
    info?.logicalCpus ? `${info.logicalCpus} CPUs` : null,
    info?.memTotal ? humanBytes(info.memTotal, true, 0) : null,
  ].filter(Boolean).join(" · ");

  const psiWorst = (f: LiveFrame) => (f.psi ? Math.max(f.psi.cpu.some ?? 0, f.psi.memory.some ?? 0, f.psi.io.some ?? 0) : null);
  const memPct = latest?.mem ? (100 * latest.mem.used) / latest.mem.total : null;

  return (
    <div className="fixed inset-0 z-[200] cursor-none overflow-hidden bg-enamel font-sans text-silk" style={{ fontSize: "clamp(12px, 1.05vw, 22px)" }}>
      <div className="flex h-full flex-col gap-[1.1em] p-[1.4em] transition-transform duration-[3000ms] motion-reduce:transition-none" style={{ transform: `translate(${shift.x}px, ${shift.y}px)` }}>

        {/* Verdict, score, time */}
        <header className="grid grid-cols-[minmax(0,1fr)_minmax(14em,20em)_auto] items-start gap-[2em] border-b border-seam pb-[1em]">
          <div className="flex min-w-0 flex-col gap-[0.55em]">
            <div className="flex min-w-0 items-baseline gap-[1em]">
              <span className="font-panel text-[0.8em] uppercase tracking-[0.16em] text-silk">{info?.hostname ?? "streamanator"}</span>
              {hostFacts && <span className="truncate font-mono text-[0.85em] text-graphite">{hostFacts}</span>}
            </div>
            <div className="flex min-w-0 items-center gap-[0.9em]">
              <Stamp
                status={overall}
                label={verdictLabel}
                size="lg"
                emphasis
                className="gap-[0.55em] px-[0.8em] py-[0.5em] text-[1.3em] tracking-[0.12em] [&_.lamp]:size-[0.6em]"
              />
              <p className="m-0 min-w-0 line-clamp-2 text-[2em] font-semibold leading-tight tracking-[-0.01em] text-balance">{headline}</p>
            </div>
            {subline && <p className="m-0 max-w-[60em] truncate text-[1em] text-silk-dim">{subline}</p>}
          </div>

          <div className="flex flex-col gap-[0.3em]">
            <WallLabel>Health score</WallLabel>
            {snapshotStale || !snapshot ? (
              <WallVoid state={snapshot ? "STALE" : snapshotError ? "ERROR" : "ACQUIRING"} className="mt-[0.2em]" />
            ) : (
              <>
                <p className="m-0 font-mono text-[3em] font-medium leading-none tabular-nums">
                  {snapshot.health.score.toFixed(0)}
                  <span className="ml-[0.15em] text-[0.4em] font-normal text-graphite">/ 100</span>
                </p>
                <ScoreRuler score={snapshot.health.score} raw={snapshot.health.rawScore} className="[&>span]:text-[0.62em]" />
              </>
            )}
          </div>

          <div className="text-right">
            <p className="m-0 font-mono text-[3.2em] font-medium leading-none tabular-nums">
              {now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--"}
            </p>
            <p className="m-0 mt-[0.35em] text-[0.95em] text-silk-dim">{now?.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</p>
          </div>
        </header>

        {/* Lost live samples take over plainly; the tiles below say STALE rather than show frozen figures. */}
        {live.stale && <StaleBanner large />}

        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] gap-[1.2em]">
          {/* Live load */}
          <section className="grid min-h-0 grid-cols-2 grid-rows-3 gap-[0.9em]" aria-label="Live load">
            <Tile title="CPU" state={liveState} reading={latest?.cpu ? { value: latest.cpu.total.toFixed(0), unit: "%" } : null}
              sub={latest?.load ? `load ${latest.load[0].toFixed(2)}${latest.cpu ? ` · iowait ${latest.cpu.iowait.toFixed(0)}%` : ""}` : undefined}
              frames={frames} max={100} series={[{ key: "c", label: "CPU", color: "var(--series-1)", value: f => f.cpu?.total }]} />
            <Tile title="Memory" state={liveState} reading={memPct !== null ? { value: memPct.toFixed(0), unit: "%" } : null}
              sub={latest?.mem ? `${humanBytes(latest.mem.used, true, 1)} of ${humanBytes(latest.mem.total, true, 0)}${latest.mem.swapUsed ? ` · swap ${humanBytes(latest.mem.swapUsed, true, 0)}` : ""}` : undefined}
              frames={frames} max={100} series={[{ key: "m", label: "Memory", color: "var(--series-7)", value: f => (f.mem ? (100 * f.mem.used) / f.mem.total : null) }]} />
            <Tile title="Storage" device={arrayDisk?.name} state={liveState} reading={diskNow ? { value: diskNow.busyPercent.toFixed(0), unit: "% active" } : null}
              sub={diskNow ? `read ${humanBytesPerSecond(diskNow.readBps, 0)} · write ${humanBytesPerSecond(diskNow.writeBps, 0)}` : undefined}
              frames={frames} max={100} series={[{ key: "d", label: "Active time", color: "var(--series-3)", value: f => diskOf(f)?.busyPercent }]} />
            <Tile title="Network" device={primaryNic?.name} state={liveState} reading={nicNow ? split(humanBitsPerSecond(nicNow.rxBps * 8, 0)) : null}
              sub={nicNow ? `sent ${humanBitsPerSecond(nicNow.txBps * 8, 0)}` : undefined}
              frames={frames} max="auto" series={[
                { key: "rx", label: "Receive", color: "var(--series-1)", value: f => nicOf(f)?.rxBps },
                { key: "tx", label: "Send", color: "var(--series-2)", value: f => nicOf(f)?.txBps, fill: false },
              ]} />
            <Tile title="Internet" device="1.1.1.1" state={internetState} reading={latestLatency !== undefined ? { value: latestLatency.toFixed(0), unit: "ms" } : null}
              sub={latestLoss !== undefined ? `${latestLoss.toFixed(0)}% packet loss · last 6 h` : "latency · last 6 h"}>
              <HistorySpark points={latency} color="var(--series-4)" />
            </Tile>
            {gpu ? (
              <Tile title="GPU" state={liveState} reading={gpu.utilPercent != null ? { value: gpu.utilPercent.toFixed(0), unit: "%" } : null}
                sub={[
                  gpu.decoderPercent != null ? `decode ${gpu.decoderPercent}%` : "decode n/a",
                  gpu.encoderPercent != null ? `encode ${gpu.encoderPercent}%` : "encode n/a",
                  gpu.temperatureC != null ? `${gpu.temperatureC} °C` : null,
                ].filter(Boolean).join(" · ")}
                frames={frames} max={100} series={[
                  { key: "u", label: "3D", color: "var(--series-5)", value: f => f.gpus[0]?.utilPercent },
                  { key: "d", label: "Decode", color: "var(--series-1)", value: f => f.gpus[0]?.decoderPercent, fill: false },
                ]} />
            ) : (
              <Tile title="Pressure" state={liveState} reading={latest?.psi ? { value: (psiWorst(latest) ?? 0).toFixed(1), unit: "% stalled" } : null}
                sub="worst of cpu / memory / io" frames={frames} max="auto"
                series={[{ key: "p", label: "Stall", color: "var(--series-4)", value: psiWorst }]} />
            )}
          </section>

          {/* Attention + subsystems */}
          <section className="flex min-h-0 flex-col gap-[0.9em]">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[3px] border border-seam bg-bezel p-[1em]">
              <WallLabel as="h2" className="mb-[0.8em]">
                Needs attention{!snapshotStale && attention.length > 0 ? ` · ${attention.length}` : ""}
              </WallLabel>
              {snapshotStale ? (
                <WallVoid state={snapshot ? "STALE" : snapshotError ? "ERROR" : "ACQUIRING"} note="Health is unknown until the next successful check." />
              ) : attention.length === 0 ? (
                <div className="flex items-center gap-[0.6em] text-[1.6em] font-semibold">
                  <Lamp status={Status.HEALTHY} className="size-[0.55em]" /> All clear
                </div>
              ) : (
                <FitList more={n => `and ${n} more on Overview`}>
                  {attention.map(a => (
                    <li key={a.key} className="flex gap-[0.7em] border-t border-seam pt-[0.6em] first:border-t-0 first:pt-0">
                      <Lamp status={a.status} className="mt-[0.5em] size-[0.7em]" label={wordOf(a.status)} />
                      <div className="min-w-0 flex-1">
                        <p className="m-0 truncate text-[1.25em] font-semibold leading-tight">{a.title}</p>
                        <p className="m-0 mt-[0.15em] line-clamp-2 text-[0.95em] leading-snug text-silk-dim">{a.detail}</p>
                        <p className="m-0 mt-[0.25em] flex gap-[0.8em]">
                          <span className="font-panel text-[0.62em] uppercase tracking-[0.12em] text-silk-dim">{wordOf(a.status)}</span>
                          {a.extra && <span className="truncate font-mono text-[0.8em] text-graphite">{a.extra}</span>}
                        </p>
                      </div>
                    </li>
                  ))}
                </FitList>
              )}
            </div>
            <div className="grid grid-cols-2 gap-[0.45em]" aria-label="Subsystems">
              {components.map(c => {
                const s = snapshotStale ? Status.UNKNOWN : c.status;
                return (
                  <div key={c.key} className="flex items-center gap-[0.55em] rounded-[2px] border border-seam bg-bezel px-[0.7em] py-[0.45em]">
                    <Lamp status={s} className="size-[0.62em]" />
                    <span className="min-w-0 flex-1 truncate text-[1.02em]">{c.label}</span>
                    <span className="font-panel text-[0.58em] uppercase tracking-[0.12em] text-silk-dim">{snapshotStale ? "Stale" : wordOf(s)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </main>

        {/* Recent changes ticker */}
        <footer className="flex items-baseline gap-[1.2em] overflow-hidden whitespace-nowrap border-t border-seam pt-[0.6em] text-[0.95em] text-silk-dim">
          <WallLabel className="shrink-0">Recent</WallLabel>
          {(snapshot?.changes ?? []).slice(0, 5).map((c, i) => (
            <span key={i} className="truncate">
              <span className="font-mono text-graphite">{new Date(c.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> {c.summary}
            </span>
          ))}
          {!snapshot?.changes?.length && <span>No changes recorded.</span>}
        </footer>
      </div>
    </div>
  );
}

function Tile({ title, device, reading, state, sub, frames, series, max, children }: {
  title: string;
  device?: string;
  reading: { value: string; unit?: string } | null;
  state: DataStateLike;
  sub?: string;
  frames?: LiveFrame[];
  series?: GraphSeries[];
  max?: number | "auto";
  children?: React.ReactNode;
}) {
  const current = state === "OK" && reading !== null;
  return (
    <div className="well flex min-h-0 flex-col px-[0.9em] py-[0.75em]">
      <div className="flex items-start justify-between gap-[0.6em]">
        <div className="flex min-w-0 flex-col gap-[0.3em] pt-[0.2em]">
          <WallLabel as="h2" className="text-silk-dim">{title}</WallLabel>
          {device && <span className="truncate font-mono text-[0.8em] leading-none text-graphite">{device}</span>}
        </div>
        {current ? (
          <p className="m-0 shrink-0 font-mono text-[2.4em] font-medium leading-none tabular-nums">
            {reading.value}
            {reading.unit && <span className="ml-[0.15em] text-[0.42em] font-normal text-graphite">{reading.unit}</span>}
          </p>
        ) : (
          <WallVoid state={state === "OK" ? "NO_DATA" : state} className="shrink-0" />
        )}
      </div>
      <div className="mt-[0.35em] flex items-center justify-between gap-[0.8em] text-[0.85em]">
        {/* Two traces in one graph: name them, so identity is never colour alone. */}
        <span className="flex shrink-0 gap-[0.9em] text-silk-dim">
          {series && series.length > 1 && series.map(s => (
            <span key={s.key} className="flex items-center gap-[0.4em]">
              <i className="inline-block h-[0.18em] w-[0.9em]" style={{ background: s.color }} aria-hidden />{s.label}
            </span>
          ))}
        </span>
        {current && sub && <span className="truncate font-mono text-silk-dim">{sub}</span>}
      </div>
      <div className="mt-[0.45em] min-h-0 flex-1">
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
      <ul ref={listRef} className="relative m-0 min-h-0 flex-1 list-none space-y-[0.7em] overflow-hidden p-0">{children}</ul>
      {hidden > 0 && <p className="m-0 mt-[0.5em] text-[0.95em] text-silk-dim">{more(hidden)}</p>}
    </>
  );
}

/** One-minute history from SQLite: the live stream has no internet latency. */
function HistorySpark({ points, color }: { points: [number, number][]; color: string }) {
  if (points.length < 2) return <WallVoid state="ACQUIRING" note="Collecting history" className="h-full" />;
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
