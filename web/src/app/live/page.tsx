"use client";

import { useState } from "react";
import Link from "next/link";
import { LiveProvider, useLive } from "@/components/live/LiveProvider";
import { LiveGraph, Legend, type GraphSeries } from "@/components/live/LiveGraph";
import { StaleBanner } from "@/components/live/StaleBanner";
import { Acquiring, EmptyState, PageHeader, Panel, Readout, Segmented, Source, Void, statusColor } from "@/components/instrument";
import type { LiveFrame } from "@/lib/live";
import { cn } from "@/lib/utils";
import { humanBitsPerSecond, humanBytes, humanBytesPerSecond, humanDuration } from "@/lib/utils/formatting";

type Selection = { kind: "cpu" } | { kind: "memory" } | { kind: "pressure" } | { kind: "disk"; name: string } | { kind: "nic"; name: string } | { kind: "gpu"; index: number };

const pct = (v: number) => `${v.toFixed(0)}%`;
const bits = (bytesPerSec: number) => humanBitsPerSecond(bytesPerSec * 8);
const memPct = (f: LiveFrame) => (f.mem ? (100 * f.mem.used) / f.mem.total : null);
const isNum = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const windowLabel = (seconds: number) => (seconds >= 120 ? `${seconds / 60} min` : `${seconds} s`);

/** Above this a utilisation figure is tinted and says so in words. */
const BUSY = 90;

/** Splits a formatted "12.3 GiB" / "4.0 Mbps" / "12%" into number and unit for a Readout. */
function vu(text: string | null | undefined): { value: string | null; unit?: string } {
  if (text == null || text === "—") return { value: null };
  const m = /^(-?[\d.,]+)\s?([A-Za-z%°][A-Za-z/]*)$/.exec(text.trim());
  return m ? { value: m[1], unit: m[2] } : { value: text };
}
const p1 = (v: number | null | undefined) => (isNum(v) ? { value: v.toFixed(1), unit: "%" } : { value: null });

const WINDOWS = [
  { value: "60", label: "60 s" },
  { value: "300", label: "5 min" },
  { value: "600", label: "10 min" },
];

export default function LivePage() {
  return (
    <LiveProvider>
      <TaskManager />
    </LiveProvider>
  );
}

/** A compact device reading for the device list; a void when there's no sample. */
function Sub({ children }: { children: React.ReactNode }) {
  return <span className="block truncate font-mono text-xs tabular-nums text-silk-dim">{children}</span>;
}

function TaskManager() {
  const live = useLive();
  const [selected, setSelected] = useState<Selection>({ kind: "cpu" });
  const [windowSeconds, setWindowSeconds] = useState(60);
  const { info, latest, frames, intervalMs } = live;

  const devices: Array<{ sel: Selection; title: string; sub: React.ReactNode; series: GraphSeries; max?: number | "auto" }> = [
    {
      sel: { kind: "cpu" }, title: "CPU",
      sub: latest?.cpu
        ? <Sub><span style={latest.cpu.total >= BUSY ? { color: statusColor("WARNING") } : undefined}>{latest.cpu.total.toFixed(0)}%</span>{latest.cpuMhz ? ` · ${(latest.cpuMhz / 1000).toFixed(2)} GHz` : ""}</Sub>
        : <Void compact state="NO_DATA" />,
      series: { key: "cpu", label: "CPU", color: "var(--series-1)", value: f => f.cpu?.total }, max: 100,
    },
    {
      sel: { kind: "memory" }, title: "Memory",
      sub: latest?.mem
        ? <Sub>{humanBytes(latest.mem.used)} / {humanBytes(latest.mem.total)} · {memPct(latest)!.toFixed(0)}%</Sub>
        : <Void compact state="NO_DATA" />,
      series: { key: "mem", label: "Memory", color: "var(--series-7)", value: memPct }, max: 100,
    },
    ...(info?.disks ?? []).map(d => {
      const busy = latest?.disks.find(x => x.name === d.name)?.busyPercent;
      return {
        sel: { kind: "disk", name: d.name } as Selection, title: `Disk ${d.name}`,
        sub: <Sub>{d.kind.toUpperCase()} · {isNum(busy) ? pct(busy) : <span className="text-graphite">no sample</span>}</Sub>,
        series: { key: d.name, label: "Active time", color: "var(--series-3)", value: (f: LiveFrame) => f.disks.find(x => x.name === d.name)?.busyPercent }, max: 100,
      };
    }),
    ...(info?.nics ?? []).map(n => {
      const now = latest?.nets.find(x => x.name === n.name);
      return {
        sel: { kind: "nic", name: n.name } as Selection,
        title: `${n.wireless ? "Wi-Fi" : "Ethernet"} ${n.name}`,
        sub: n.operstate !== "up"
          ? <span className="block text-xs text-graphite">Not connected</span>
          : now
            ? <Sub><span aria-label="send">↑</span> {bits(now.txBps)} <span aria-label="receive">↓</span> {bits(now.rxBps)}</Sub>
            : <Void compact state="NO_DATA" />,
        series: { key: n.name, label: "Throughput", color: "var(--series-2)", value: (f: LiveFrame) => { const x = f.nets.find(y => y.name === n.name); return x ? x.rxBps + x.txBps : null; } },
        max: "auto" as const,
      };
    }),
    ...(info?.gpus ?? []).map(g => {
      const util = latest?.gpus.find(x => x.index === g.index)?.utilPercent;
      return {
        sel: { kind: "gpu", index: g.index } as Selection, title: `GPU ${g.index}`,
        sub: <Sub>{g.name} · {isNum(util) ? pct(util) : <span className="text-graphite">no sample</span>}</Sub>,
        series: { key: `gpu${g.index}`, label: "Utilisation", color: "var(--series-5)", value: (f: LiveFrame) => f.gpus.find(x => x.index === g.index)?.utilPercent }, max: 100,
      };
    }),
    {
      sel: { kind: "pressure" }, title: "Pressure stall",
      sub: latest?.psi
        ? <Sub>CPU {fmtPsi(latest.psi.cpu.some)} · Mem {fmtPsi(latest.psi.memory.some)} · I/O {fmtPsi(latest.psi.io.some)}</Sub>
        : <span className="block text-xs text-graphite">Not exposed by this kernel</span>,
      series: { key: "psi", label: "Worst stall", color: "var(--series-4)", value: f => f.psi ? Math.max(f.psi.cpu.some ?? 0, f.psi.memory.some ?? 0, f.psi.io.some ?? 0) : null }, max: "auto",
    },
  ];

  const same = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);
  const seconds = intervalMs / 1000;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        group="Live"
        title="Task Manager"
        description="What the CPU, memory, disks, network and GPU are doing right now, sampled continuously from /proc."
        meta={`${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s samples · history held in memory`}
        actions={<Segmented label="Graph window" options={WINDOWS} value={String(windowSeconds)} onChange={v => setWindowSeconds(Number(v))} />}
      >
        {info && (
          <Source className="text-[13px]">
            {info.hostname} · {info.cpuModel ?? "CPU model not reported"} · {info.logicalCpus} logical processors · kernel {info.kernel}
          </Source>
        )}
      </PageHeader>

      <StaleBanner />

      {!info && !latest ? (
        <Acquiring rows={3} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <nav aria-label="Devices" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
            {devices.map(d => {
              const active = same(d.sel, selected);
              return (
                <button
                  key={JSON.stringify(d.sel)}
                  type="button"
                  onClick={() => setSelected(d.sel)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex min-h-16 min-w-60 shrink-0 items-center gap-3 rounded-[3px] border px-2.5 py-2 text-left transition-colors lg:min-w-0",
                    active ? "border-seam-strong bg-bezel" : "border-transparent hover:bg-bezel/60",
                  )}
                >
                  <span className="well block h-12 w-20 shrink-0 overflow-hidden p-0">
                    <LiveGraph frames={frames} series={[d.series]} max={d.max} windowSeconds={60} compact className="h-full w-full" ariaLabel={`${d.title}, last 60 seconds`} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-sm font-semibold text-silk">{d.title}</span>
                    {d.sub}
                  </span>
                </button>
              );
            })}
          </nav>

          <Panel as="section" className="gap-5">
            {selected.kind === "cpu" && <CpuPanel windowSeconds={windowSeconds} />}
            {selected.kind === "memory" && <MemoryPanel windowSeconds={windowSeconds} />}
            {selected.kind === "pressure" && <PressurePanel windowSeconds={windowSeconds} />}
            {selected.kind === "disk" && <DiskPanel name={selected.name} windowSeconds={windowSeconds} />}
            {selected.kind === "nic" && <NicPanel name={selected.name} windowSeconds={windowSeconds} />}
            {selected.kind === "gpu" && <GpuPanel index={selected.index} windowSeconds={windowSeconds} />}
          </Panel>
        </div>
      )}
    </div>
  );
}

const fmtPsi = (v: number | null | undefined) => (isNum(v) ? `${v.toFixed(1)}%` : "n/a");

// ---------------------------------------------------------------------------

function DeviceHeader({ title, detail, action }: { title: string; detail?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="m-0 text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</h2>
        {detail ? <span className="font-mono text-[13px] text-graphite">{detail}</span> : null}
      </div>
      {action}
    </div>
  );
}

type Stat = {
  label: string;
  value?: React.ReactNode | null;
  unit?: string;
  /** Data state when there is no value (NO_DATA, NOT_REPORTED...). */
  state?: string;
  note?: React.ReactNode;
  color?: string;
  hint?: React.ReactNode;
  /** A worded fact instead of a measured value ("No swap", "Idle"). */
  word?: React.ReactNode;
};

function Stats({ items }: { items: Stat[] }) {
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-4">
      {items.map(item => (
        <div key={item.label} className="flex min-w-0 flex-col gap-1 border-t border-seam pt-2.5">
          <dt className="text-xs text-graphite">{item.label}</dt>
          <dd className="m-0 min-w-0">
            {item.word !== undefined
              ? <span className="text-[15px] leading-snug text-silk-dim">{item.word}</span>
              : <Readout value={item.value} unit={item.unit} state={item.value == null ? item.state ?? "NO_DATA" : undefined} note={item.note} size="sm" className="text-[17px]" color={item.color} />}
            {item.hint ? <span className="mt-0.5 block text-xs leading-snug" style={item.color ? { color: item.color } : undefined}>{item.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A utilisation stat that tints and says so above the busy threshold. */
function busyStat(label: string, v: number | null | undefined, word = "Near saturation"): Stat {
  const hot = isNum(v) && v >= BUSY;
  return { label, ...p1(v), color: hot ? statusColor("WARNING") : undefined, hint: hot ? word : undefined };
}

function GraphBox({ caption, note, series, frames, windowSeconds, max, format, className = "h-64" }: {
  caption: string; note?: string; series: GraphSeries[]; frames: LiveFrame[]; windowSeconds: number; max?: number | "auto"; format?: (v: number) => string; className?: string;
}) {
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1.5">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="panel-label">{caption}</span>
          <span className="font-mono text-xs text-graphite">last {windowLabel(windowSeconds)}</span>
          {note && <span className="text-xs text-graphite">{note}</span>}
        </span>
        {series.length > 1 && <Legend series={series} />}
      </figcaption>
      <div className={cn("well overflow-hidden p-0", className)}>
        <LiveGraph frames={frames} series={series} windowSeconds={windowSeconds} max={max} format={format} className="h-full w-full" />
      </div>
    </figure>
  );
}

function CpuPanel({ windowSeconds }: { windowSeconds: number }) {
  const { info, latest, frames } = useLive();
  const [perCore, setPerCore] = useState(false);
  const cores = latest?.cpu?.cores ?? [];
  const temps = latest?.temps ? Object.values(latest.temps) : [];
  return (
    <>
      <DeviceHeader
        title="CPU"
        detail={info?.cpuModel}
        action={
          <Segmented
            label="CPU graph"
            value={perCore ? "cores" : "overall"}
            onChange={v => setPerCore(v === "cores")}
            options={[{ value: "overall", label: "Overall" }, { value: "cores", label: "Logical processors" }]}
          />
        }
      />
      {perCore ? (
        <figure className="m-0 flex flex-col gap-2">
          <figcaption className="flex flex-wrap items-baseline gap-x-3">
            <span className="panel-label">Per logical processor</span>
            <span className="font-mono text-xs text-graphite">last {windowLabel(windowSeconds)} · 0–100%</span>
          </figcaption>
          {cores.length === 0 ? (
            <Void state="NO_DATA" note="No per-processor sample has arrived yet." />
          ) : (
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 xl:grid-cols-6">
              {cores.map((_, i) => {
                const v = cores[i];
                return (
                  <div key={i} className="well relative h-[72px] overflow-hidden p-0">
                    <LiveGraph frames={frames} windowSeconds={windowSeconds} max={100} compact className="h-full w-full"
                      series={[{ key: `c${i}`, label: `CPU ${i}`, color: "var(--series-1)", value: f => f.cpu?.cores[i] }]} ariaLabel={`Logical processor ${i}`} />
                    <span className="pointer-events-none absolute left-1 top-1 rounded-[2px] bg-well/80 px-1 font-mono text-[11px] tabular-nums text-graphite">
                      {i}{" "}
                      {isNum(v)
                        ? <span className="text-silk" style={v >= BUSY ? { color: statusColor("WARNING") } : undefined}>{v.toFixed(0)}%</span>
                        : <span>n/a</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </figure>
      ) : (
        <GraphBox caption="Utilisation" note="with time stalled on I/O" frames={frames} windowSeconds={windowSeconds} max={100} format={pct}
          series={[
            { key: "cpu", label: "Utilisation", color: "var(--series-1)", value: f => f.cpu?.total },
            { key: "io", label: "I/O wait", color: "var(--series-2)", value: f => f.cpu?.iowait, fill: false },
          ]} />
      )}
      <Stats items={[
        busyStat("Utilisation", latest?.cpu?.total),
        { label: "Speed", value: latest?.cpuMhz ? (latest.cpuMhz / 1000).toFixed(2) : null, unit: "GHz", state: latest ? "NOT_REPORTED" : "NO_DATA" },
        { label: "User / system", value: latest?.cpu ? `${latest.cpu.user.toFixed(0)}% / ${latest.cpu.system.toFixed(0)}%` : null },
        { label: "I/O wait", ...p1(latest?.cpu?.iowait) },
        { label: "Load (1 / 5 / 15 min)", value: latest?.load ? latest.load.map(v => v.toFixed(2)).join(" / ") : null },
        { label: "Runnable / tasks", value: latest?.tasks ? `${latest.tasks.running} / ${latest.tasks.total}` : null },
        { label: "Blocked on I/O", value: latest?.tasks?.blocked ?? null },
        { label: "Context switches", value: latest?.rates ? latest.rates.contextSwitches.toLocaleString() : null, unit: "/s" },
        { label: "Forks", value: latest?.rates ? latest.rates.forks : null, unit: "/s" },
        { label: "CPU pressure", ...p1(latest?.psi?.cpu.some), state: latest && !latest.psi ? "NOT_REPORTED" : undefined },
        { label: "Hottest sensor", value: temps.length ? Math.max(...temps).toFixed(0) : null, unit: "°C", state: latest && !latest.temps ? "NO_SENSOR" : undefined },
        { label: "Up time", value: isNum(latest?.uptimeSeconds) ? humanDuration(latest.uptimeSeconds, 3) : null },
        { label: "Base speed", value: info?.baseMhz ? (info.baseMhz / 1000).toFixed(2) : null, unit: "GHz", state: info ? "NOT_REPORTED" : undefined },
        { label: "Sockets / cores", value: info?.sockets ? `${info.sockets} / ${info.physicalCores ?? "?"}` : null, state: info ? "NOT_REPORTED" : undefined },
        { label: "Logical processors", value: info?.logicalCpus ?? null },
        { label: "Steal", ...p1(latest?.cpu?.steal) },
      ]} />
    </>
  );
}

function MemoryPanel({ windowSeconds }: { windowSeconds: number }) {
  const { latest, frames } = useLive();
  const m = latest?.mem;
  // Linux "available" already counts reclaimable cache, so the three segments
  // below partition total memory exactly: in use + reclaimable cache + free.
  const segments = m ? [
    { key: "used", label: "In use", bytes: m.used, color: "var(--series-7)" },
    { key: "cache", label: "Cache (reclaimable)", bytes: Math.max(0, m.available - m.free), color: "var(--series-1)" },
    { key: "free", label: "Free", bytes: m.free, color: "var(--seam-strong)" },
  ] : [];
  const used = latest ? memPct(latest) : null;
  return (
    <>
      <DeviceHeader title="Memory" detail={m ? `${humanBytes(m.total)} total` : null} />
      <GraphBox caption="Memory in use" frames={frames} windowSeconds={windowSeconds} max={100} format={pct}
        series={[{ key: "mem", label: "In use", color: "var(--series-7)", value: memPct }]} />
      {m ? (
        <figure className="m-0 flex flex-col gap-2">
          <figcaption className="panel-label">Composition</figcaption>
          <div className="well flex h-8 gap-[2px] overflow-hidden p-[3px]" role="img" aria-label={segments.map(s => `${s.label} ${humanBytes(s.bytes)}`).join(", ")}>
            {segments.map(s => (
              <div key={s.key} title={`${s.label}: ${humanBytes(s.bytes)}`} style={{ width: `${(100 * s.bytes) / m.total}%`, background: s.color }} className="h-full min-w-px rounded-[1px]" />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-silk-dim">
            {segments.map(s => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-2.5 w-3.5 rounded-[1px]" style={{ background: s.color }} />
                {s.label}
                <span className="font-mono tabular-nums text-silk">{humanBytes(s.bytes)}</span>
              </span>
            ))}
          </div>
        </figure>
      ) : null}
      <Stats items={[
        { label: "In use", ...vu(m ? humanBytes(m.used) : null), color: isNum(used) && used >= BUSY ? statusColor("WARNING") : undefined, hint: isNum(used) && used >= BUSY ? "Little memory left" : undefined },
        { label: "Available", ...vu(m ? humanBytes(m.available) : null) },
        { label: "Committed", value: m ? `${humanBytes(m.committed)} / ${humanBytes(m.commitLimit)}` : null },
        { label: "Cached", ...vu(m ? humanBytes(m.cached) : null) },
        { label: "Buffers", ...vu(m ? humanBytes(m.buffers) : null) },
        { label: "Shared (tmpfs)", ...vu(m ? humanBytes(m.shmem) : null) },
        { label: "Kernel slab", ...vu(m ? humanBytes(m.slab) : null) },
        { label: "Dirty (awaiting write)", ...vu(m ? humanBytes(m.dirty) : null) },
        m && !m.swapTotal
          ? { label: "Swap used", word: "No swap configured" }
          : { label: "Swap used", value: m ? `${humanBytes(m.swapUsed)} / ${humanBytes(m.swapTotal)}` : null },
        m && m.zswap === 0
          ? { label: "Compressed (zswap)", word: "Not in use" }
          : { label: "Compressed (zswap)", value: m && isNum(m.zswap) ? `${humanBytes(m.zswap)} holds ${humanBytes(m.zswapped ?? 0)}` : null, state: m ? "NOT_REPORTED" : undefined },
        { label: "Memory pressure (some)", ...p1(latest?.psi?.memory.some), state: latest && !latest.psi ? "NOT_REPORTED" : undefined },
        { label: "Memory pressure (full)", ...p1(latest?.psi?.memory.full), state: latest && !latest.psi ? "NOT_REPORTED" : undefined },
      ]} />
    </>
  );
}

function PressurePanel({ windowSeconds }: { windowSeconds: number }) {
  const { latest, frames } = useLive();
  if (!latest?.psi) {
    return (
      <>
        <DeviceHeader title="Pressure stall" />
        <EmptyState title={latest ? "This kernel doesn't report pressure stall information" : "No sample yet"}>
          {latest
            ? <>The dashboard reads PSI from <span className="font-mono">/proc/pressure</span>, which needs Linux 4.20 or newer built with <span className="font-mono">CONFIG_PSI</span>. Some distributions also need <span className="font-mono">psi=1</span> on the kernel command line.</>
            : "Pressure figures will appear with the first live sample."}
        </EmptyState>
      </>
    );
  }
  return (
    <>
      <DeviceHeader title="Pressure stall information" detail="share of time tasks were stalled · 10 s average" />
      <GraphBox caption="Some tasks stalled" frames={frames} windowSeconds={windowSeconds} max="auto" format={v => `${v.toFixed(1)}%`}
        series={[
          { key: "cpu", label: "CPU", color: "var(--series-1)", value: f => f.psi?.cpu.some, fill: false },
          { key: "mem", label: "Memory", color: "var(--series-2)", value: f => f.psi?.memory.some, fill: false },
          { key: "io", label: "I/O", color: "var(--series-3)", value: f => f.psi?.io.some, fill: false },
        ]} />
      <p className="m-0 max-w-[72ch] text-sm leading-relaxed text-silk-dim">
        Utilisation says how busy a resource is; pressure says how much work is waiting on it. A disk at 100% active time with near-zero I/O pressure is busy but coping. Rising I/O pressure is when things feel slow.
      </p>
      <Stats items={[
        { label: "CPU some", ...p1(latest.psi.cpu.some) },
        { label: "Memory some", ...p1(latest.psi.memory.some) },
        { label: "Memory full", ...p1(latest.psi.memory.full) },
        { label: "I/O some", ...p1(latest.psi.io.some) },
        { label: "I/O full", ...p1(latest.psi.io.full) },
      ]} />
    </>
  );
}

function DiskPanel({ name, windowSeconds }: { name: string; windowSeconds: number }) {
  const { info, latest, frames } = useLive();
  const disk = info?.disks.find(d => d.name === name);
  const now = latest?.disks.find(d => d.name === name);
  const pick = (f: LiveFrame) => f.disks.find(d => d.name === name);
  return (
    <>
      <DeviceHeader title={`Disk ${name}`} detail={[disk?.model, disk?.kind.toUpperCase()].filter(Boolean).join(" · ")} />
      <GraphBox caption="Active time" frames={frames} windowSeconds={windowSeconds} max={100} format={pct} className="h-48"
        series={[{ key: "busy", label: "Active time", color: "var(--series-3)", value: f => pick(f)?.busyPercent }]} />
      <GraphBox caption="Transfer rate" frames={frames} windowSeconds={windowSeconds} max="auto" format={v => humanBytesPerSecond(v, 0)} className="h-40"
        series={[
          { key: "r", label: "Read", color: "var(--series-1)", value: f => pick(f)?.readBps },
          { key: "w", label: "Write", color: "var(--series-2)", value: f => pick(f)?.writeBps, fill: false },
        ]} />
      <Stats items={[
        busyStat("Active time", now?.busyPercent, "Saturated"),
        now && !isNum(now.latencyMs)
          ? { label: "Average response", word: "Idle (nothing completed)" }
          : { label: "Average response", value: isNum(now?.latencyMs) ? now.latencyMs.toFixed(1) : null, unit: "ms" },
        { label: "Read speed", ...vu(now ? humanBytesPerSecond(now.readBps) : null) },
        { label: "Write speed", ...vu(now ? humanBytesPerSecond(now.writeBps) : null) },
        { label: "Read / write IOPS", value: now ? `${now.readIops.toFixed(0)} / ${now.writeIops.toFixed(0)}` : null },
        { label: "Capacity", ...vu(humanBytes(disk?.sizeBytes, false)), state: disk ? "NOT_REPORTED" : undefined },
        { label: "Type", value: disk?.kind.toUpperCase() ?? null },
      ]} />
      {disk?.kind === "raid" && (
        <p className="m-0 text-sm text-silk-dim">
          Array member health and rebuild state are on the <Link href="/raid" className="text-trace underline">RAID &amp; disks</Link> page.
        </p>
      )}
    </>
  );
}

function NicPanel({ name, windowSeconds }: { name: string; windowSeconds: number }) {
  const { info, latest, frames } = useLive();
  const nic = info?.nics.find(n => n.name === name);
  const now = latest?.nets.find(n => n.name === name);
  const pick = (f: LiveFrame) => f.nets.find(n => n.name === name);
  const errors = now?.errorsPerSec ?? 0;
  return (
    <>
      <DeviceHeader title={`${nic?.wireless ? "Wi-Fi" : "Ethernet"} ${name}`} detail={nic?.operstate === "up" ? `link ${nic.speedMbps ? `${nic.speedMbps >= 1000 ? nic.speedMbps / 1000 + " Gbps" : nic.speedMbps + " Mbps"}` : "up, speed not reported"}` : "not connected"} />
      <GraphBox caption="Throughput" frames={frames} windowSeconds={windowSeconds} max="auto" format={v => bits(v)}
        series={[
          { key: "rx", label: "Receive", color: "var(--series-1)", value: f => pick(f)?.rxBps },
          { key: "tx", label: "Send", color: "var(--series-2)", value: f => pick(f)?.txBps, fill: false },
        ]} />
      <Stats items={[
        { label: "Send", ...vu(now ? bits(now.txBps) : null) },
        { label: "Receive", ...vu(now ? bits(now.rxBps) : null) },
        { label: "Packets in / out", value: now ? `${now.rxPps.toFixed(0)} / ${now.txPps.toFixed(0)}` : null, unit: "per s" },
        { label: "Errors", value: now ? now.errorsPerSec : null, unit: "/s", color: errors > 0 ? statusColor("WARNING") : undefined, hint: errors > 0 ? "Errors on this link" : undefined },
        { label: "Drops", value: now ? now.dropsPerSec : null, unit: "/s" },
        { label: "Link utilisation", ...p1(now && nic?.speedMbps ? (100 * Math.max(now.rxBps, now.txBps) * 8) / (nic.speedMbps * 1e6) : null), state: now && !nic?.speedMbps ? "NOT_REPORTED" : undefined, note: now && !nic?.speedMbps ? "link speed unknown" : undefined },
        nic?.addresses.length
          ? { label: "Addresses", word: <span className="flex flex-col font-mono text-[13px] text-silk">{nic.addresses.map(a => <span key={a} className="break-all">{a}</span>)}</span> }
          : { label: "Addresses", value: null, state: nic ? "NONE" : undefined },
        nic?.mac
          ? { label: "MAC", word: <span className="font-mono text-[13px] text-silk">{nic.mac}</span> }
          : { label: "MAC", value: null, state: nic ? "NOT_REPORTED" : undefined },
      ]} />
    </>
  );
}

function GpuPanel({ index, windowSeconds }: { index: number; windowSeconds: number }) {
  const { info, latest, frames } = useLive();
  const gpu = info?.gpus.find(g => g.index === index);
  const now = latest?.gpus.find(g => g.index === index);
  const pick = (f: LiveFrame) => f.gpus.find(g => g.index === index);
  const unreported = now ? "NOT_REPORTED" : undefined;
  return (
    <>
      <DeviceHeader title={`GPU ${index}`} detail={[gpu?.name, gpu?.driver ? `driver ${gpu.driver}` : null].filter(Boolean).join(" · ")} />
      <GraphBox caption="Engines" note="3D / compute, with video decode and encode" frames={frames} windowSeconds={windowSeconds} max={100} format={pct}
        series={[
          { key: "u", label: "3D / compute", color: "var(--series-5)", value: f => pick(f)?.utilPercent },
          { key: "d", label: "Video decode", color: "var(--series-1)", value: f => pick(f)?.decoderPercent, fill: false },
          { key: "e", label: "Video encode", color: "var(--series-2)", value: f => pick(f)?.encoderPercent, fill: false },
        ]} />
      <GraphBox caption="Dedicated memory" frames={frames} windowSeconds={windowSeconds} max={now?.memTotalBytes ?? "auto"} format={v => humanBytes(v)} className="h-32"
        series={[{ key: "m", label: "Memory used", color: "var(--series-7)", value: f => pick(f)?.memUsedBytes }]} />
      <Stats items={[
        { ...busyStat("Utilisation", now?.utilPercent), state: unreported },
        { label: "Video decode", ...p1(now?.decoderPercent), state: unreported },
        { label: "Video encode", ...p1(now?.encoderPercent), state: unreported },
        { label: "Memory", value: now && isNum(now.memUsedBytes) && isNum(now.memTotalBytes) ? `${humanBytes(now.memUsedBytes)} / ${humanBytes(now.memTotalBytes)}` : null, state: unreported },
        { label: "Temperature", value: isNum(now?.temperatureC) ? now.temperatureC : null, unit: "°C", state: unreported },
        { label: "Power", value: isNum(now?.powerW) ? now.powerW.toFixed(0) : null, unit: "W", state: unreported },
        { label: "Fan", value: isNum(now?.fanPercent) ? now.fanPercent : null, unit: "%", state: unreported },
        { label: "Graphics clock", value: now?.clockMhz ? now.clockMhz : null, unit: "MHz", state: unreported },
      ]} />
      <p className="m-0 text-sm text-silk-dim">Plex hardware transcodes show up as video decode and encode, not as 3D utilisation.</p>
    </>
  );
}
