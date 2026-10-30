"use client";

import { useState } from "react";
import { Cpu, Gauge, HardDrive, MemoryStick, MonitorCog, Network, Wifi } from "lucide-react";
import { LiveProvider, useLive } from "@/components/live/LiveProvider";
import { LiveGraph, Legend, type GraphSeries } from "@/components/live/LiveGraph";
import { StaleBanner } from "@/components/live/StaleBanner";
import type { LiveFrame } from "@/lib/live";
import { humanBitsPerSecond, humanBytes, humanBytesPerSecond, humanDuration } from "@/lib/utils/formatting";

type Selection = { kind: "cpu" } | { kind: "memory" } | { kind: "pressure" } | { kind: "disk"; name: string } | { kind: "nic"; name: string } | { kind: "gpu"; index: number };

const pct = (v: number) => `${v.toFixed(0)}%`;
const pct1 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v.toFixed(1)}%`);
const bits = (bytesPerSec: number) => humanBitsPerSecond(bytesPerSec * 8);
const memPct = (f: LiveFrame) => (f.mem ? (100 * f.mem.used) / f.mem.total : null);

export default function LivePage() {
  return (
    <LiveProvider>
      <TaskManager />
    </LiveProvider>
  );
}

function TaskManager() {
  const live = useLive();
  const [selected, setSelected] = useState<Selection>({ kind: "cpu" });
  const [windowSeconds, setWindowSeconds] = useState(60);
  const { info, latest, frames } = live;

  const devices: Array<{ sel: Selection; icon: React.ReactNode; title: string; sub: string; series: GraphSeries; max?: number | "auto" }> = [
    {
      sel: { kind: "cpu" }, icon: <Cpu className="h-4 w-4" />, title: "CPU",
      sub: latest?.cpu ? `${latest.cpu.total.toFixed(0)}%${latest.cpuMhz ? `  ${(latest.cpuMhz / 1000).toFixed(2)} GHz` : ""}` : "—",
      series: { key: "cpu", label: "CPU", color: "var(--series-1)", value: f => f.cpu?.total }, max: 100,
    },
    {
      sel: { kind: "memory" }, icon: <MemoryStick className="h-4 w-4" />, title: "Memory",
      sub: latest?.mem ? `${humanBytes(latest.mem.used)} / ${humanBytes(latest.mem.total)} (${memPct(latest)!.toFixed(0)}%)` : "—",
      series: { key: "mem", label: "Memory", color: "var(--series-7)", value: memPct }, max: 100,
    },
    ...(info?.disks ?? []).map(d => ({
      sel: { kind: "disk", name: d.name } as Selection, icon: <HardDrive className="h-4 w-4" />, title: `Disk ${d.name}`,
      sub: `${d.kind.toUpperCase()} · ${pct(latest?.disks.find(x => x.name === d.name)?.busyPercent ?? 0)}`,
      series: { key: d.name, label: "Active time", color: "var(--series-3)", value: (f: LiveFrame) => f.disks.find(x => x.name === d.name)?.busyPercent }, max: 100,
    })),
    ...(info?.nics ?? []).map(n => {
      const now = latest?.nets.find(x => x.name === n.name);
      return {
        sel: { kind: "nic", name: n.name } as Selection, icon: n.wireless ? <Wifi className="h-4 w-4" /> : <Network className="h-4 w-4" />,
        title: `${n.wireless ? "Wi-Fi" : "Ethernet"} ${n.name}`,
        sub: n.operstate !== "up" ? "Not connected" : now ? `S: ${bits(now.txBps)}  R: ${bits(now.rxBps)}` : "—",
        series: { key: n.name, label: "Throughput", color: "var(--series-2)", value: (f: LiveFrame) => { const x = f.nets.find(y => y.name === n.name); return x ? x.rxBps + x.txBps : null; } },
        max: "auto" as const,
      };
    }),
    ...(info?.gpus ?? []).map(g => ({
      sel: { kind: "gpu", index: g.index } as Selection, icon: <MonitorCog className="h-4 w-4" />, title: `GPU ${g.index}`,
      sub: `${g.name} · ${pct(latest?.gpus.find(x => x.index === g.index)?.utilPercent ?? 0)}`,
      series: { key: `gpu${g.index}`, label: "Utilisation", color: "var(--series-5)", value: (f: LiveFrame) => f.gpus.find(x => x.index === g.index)?.utilPercent }, max: 100,
    })),
    {
      sel: { kind: "pressure" }, icon: <Gauge className="h-4 w-4" />, title: "Pressure stall",
      sub: latest?.psi ? `CPU ${pct1(latest.psi.cpu.some)} · Mem ${pct1(latest.psi.memory.some)} · I/O ${pct1(latest.psi.io.some)}` : "PSI unavailable",
      series: { key: "psi", label: "Worst stall", color: "var(--series-4)", value: f => f.psi ? Math.max(f.psi.cpu.some ?? 0, f.psi.memory.some ?? 0, f.psi.io.some ?? 0) : null }, max: "auto",
    },
  ];

  const same = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--series-1)]">Live · 1 s</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Task Manager</h1>
          <p className="mt-1 text-muted-foreground">
            {info ? `${info.hostname} · ${info.cpuModel ?? "CPU"} · ${info.logicalCpus} logical processors · kernel ${info.kernel}` : "Connecting to the live stream…"}
          </p>
        </div>
        <div className="flex rounded-lg border bg-muted/25 p-1" role="group" aria-label="Graph window">
          {[[60, "60 s"], [300, "5 min"], [600, "10 min"]].map(([s, label]) => (
            <button key={s} type="button" onClick={() => setWindowSeconds(s as number)} aria-pressed={windowSeconds === s}
              className={`rounded-md px-3 py-1.5 font-mono text-xs transition ${windowSeconds === s ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>
          ))}
        </div>
      </div>

      <StaleBanner />

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <nav aria-label="Devices" className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
          {devices.map(d => {
            const active = same(d.sel, selected);
            return (
              <button key={JSON.stringify(d.sel)} type="button" onClick={() => setSelected(d.sel)} aria-current={active}
                className={`flex min-w-56 items-center gap-3 rounded-lg border p-2 text-left transition lg:min-w-0 ${active ? "border-[var(--series-1)] bg-accent" : "border-transparent hover:bg-accent/60"}`}>
                <LiveGraph frames={frames} series={[d.series]} max={d.max} windowSeconds={60} compact className="h-12 w-20 shrink-0 rounded border bg-card" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">{d.icon}{d.title}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{d.sub}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <section className="min-w-0 rounded-xl border bg-card p-4 md:p-5">
          {selected.kind === "cpu" && <CpuPanel windowSeconds={windowSeconds} />}
          {selected.kind === "memory" && <MemoryPanel windowSeconds={windowSeconds} />}
          {selected.kind === "pressure" && <PressurePanel windowSeconds={windowSeconds} />}
          {selected.kind === "disk" && <DiskPanel name={selected.name} windowSeconds={windowSeconds} />}
          {selected.kind === "nic" && <NicPanel name={selected.name} windowSeconds={windowSeconds} />}
          {selected.kind === "gpu" && <GpuPanel index={selected.index} windowSeconds={windowSeconds} />}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PanelHeader({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
    </div>
  );
}

function Stats({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-mono text-lg tabular-nums">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function GraphBox({ caption, series, frames, windowSeconds, max, format, className = "h-64" }: {
  caption: string; series: GraphSeries[]; frames: LiveFrame[]; windowSeconds: number; max?: number | "auto"; format?: (v: number) => string; className?: string;
}) {
  return (
    <figure className="space-y-1.5">
      <figcaption className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{caption} · last {windowSeconds >= 120 ? `${windowSeconds / 60} min` : `${windowSeconds} s`}</span>
        {series.length > 1 && <Legend series={series} />}
      </figcaption>
      <LiveGraph frames={frames} series={series} windowSeconds={windowSeconds} max={max} format={format} className={`rounded-md border bg-background/40 ${className}`} />
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
      <PanelHeader title="CPU" detail={info?.cpuModel} />
      <div className="mb-2 flex justify-end">
        <button type="button" onClick={() => setPerCore(v => !v)} className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent" aria-pressed={perCore}>
          {perCore ? "Show overall utilisation" : "Show logical processors"}
        </button>
      </div>
      {perCore ? (
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 xl:grid-cols-6">
          {cores.map((_, i) => (
            <div key={i} className="relative">
              <LiveGraph frames={frames} windowSeconds={windowSeconds} max={100} compact className="h-20 rounded border bg-background/40"
                series={[{ key: `c${i}`, label: `CPU ${i}`, color: "var(--series-1)", value: f => f.cpu?.cores[i] }]} ariaLabel={`Logical processor ${i}`} />
              <span className="pointer-events-none absolute left-1.5 top-1 font-mono text-[10px] text-muted-foreground">{i} · {cores[i]?.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      ) : (
        <GraphBox caption="% utilisation, with time stalled on I/O" frames={frames} windowSeconds={windowSeconds} max={100} format={pct}
          series={[
            { key: "cpu", label: "Utilisation", color: "var(--series-1)", value: f => f.cpu?.total },
            { key: "io", label: "I/O wait", color: "var(--series-2)", value: f => f.cpu?.iowait, fill: false },
          ]} />
      )}
      <Stats items={[
        ["Utilisation", pct1(latest?.cpu?.total)],
        ["Speed", latest?.cpuMhz ? `${(latest.cpuMhz / 1000).toFixed(2)} GHz` : "—"],
        ["User / System", latest?.cpu ? `${latest.cpu.user.toFixed(0)}% / ${latest.cpu.system.toFixed(0)}%` : "—"],
        ["I/O wait", pct1(latest?.cpu?.iowait)],
        ["Load (1/5/15)", latest?.load ? latest.load.map(v => v.toFixed(2)).join(" / ") : "—"],
        ["Runnable / tasks", latest?.tasks ? `${latest.tasks.running} / ${latest.tasks.total}` : "—"],
        ["Blocked on I/O", latest?.tasks?.blocked ?? "—"],
        ["Context switches", latest?.rates ? `${latest.rates.contextSwitches.toLocaleString()}/s` : "—"],
        ["Forks", latest?.rates ? `${latest.rates.forks}/s` : "—"],
        ["CPU pressure", pct1(latest?.psi?.cpu.some)],
        ["Hottest sensor", temps.length ? `${Math.max(...temps).toFixed(0)} °C` : "—"],
        ["Up time", humanDuration(latest?.uptimeSeconds, 3)],
        ["Base speed", info?.baseMhz ? `${(info.baseMhz / 1000).toFixed(2)} GHz` : "—"],
        ["Sockets / cores", info?.sockets ? `${info.sockets} / ${info.physicalCores}` : "—"],
        ["Logical processors", info?.logicalCpus ?? "—"],
        ["Steal", pct1(latest?.cpu?.steal)],
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
    { key: "free", label: "Free", bytes: m.free, color: "var(--chart-axis)" },
  ] : [];
  return (
    <>
      <PanelHeader title="Memory" detail={m ? `${humanBytes(m.total)} total` : null} />
      <GraphBox caption="Memory in use" frames={frames} windowSeconds={windowSeconds} max={100} format={pct}
        series={[{ key: "mem", label: "In use", color: "var(--series-7)", value: memPct }]} />
      {m && (
        <figure className="mt-4">
          <figcaption className="mb-1.5 text-xs text-muted-foreground">Memory composition</figcaption>
          <div className="flex h-7 gap-[2px] overflow-hidden rounded-md" role="img" aria-label={segments.map(s => `${s.label} ${humanBytes(s.bytes)}`).join(", ")}>
            {segments.map(s => (
              <div key={s.key} title={`${s.label}: ${humanBytes(s.bytes)}`} style={{ width: `${(100 * s.bytes) / m.total}%`, background: s.color }} className="first:rounded-l-md last:rounded-r-md" />
            ))}
          </div>
          <div className="mt-1.5"><Legend series={segments} /></div>
        </figure>
      )}
      <Stats items={[
        ["In use", m ? humanBytes(m.used) : "—"],
        ["Available", m ? humanBytes(m.available) : "—"],
        ["Committed", m ? `${humanBytes(m.committed)} / ${humanBytes(m.commitLimit)}` : "—"],
        ["Cached", m ? humanBytes(m.cached) : "—"],
        ["Buffers", m ? humanBytes(m.buffers) : "—"],
        ["Shared (tmpfs)", m ? humanBytes(m.shmem) : "—"],
        ["Kernel slab", m ? humanBytes(m.slab) : "—"],
        ["Dirty (awaiting write)", m ? humanBytes(m.dirty) : "—"],
        ["Swap used", m ? (m.swapTotal ? `${humanBytes(m.swapUsed)} / ${humanBytes(m.swapTotal)}` : "No swap") : "—"],
        ["Compressed (zswap)", m?.zswap === null || m?.zswap === undefined ? "—" : m.zswap ? `${humanBytes(m.zswap)} holds ${humanBytes(m.zswapped ?? 0)}` : "Not in use"],
        ["Memory pressure (some)", pct1(latest?.psi?.memory.some)],
        ["Memory pressure (full)", pct1(latest?.psi?.memory.full)],
      ]} />
    </>
  );
}

function PressurePanel({ windowSeconds }: { windowSeconds: number }) {
  const { latest, frames } = useLive();
  if (!latest?.psi) return <><PanelHeader title="Pressure stall" /><p className="text-muted-foreground">This kernel does not expose /proc/pressure (PSI).</p></>;
  return (
    <>
      <PanelHeader title="Pressure stall information" detail="Share of time at least one task was stalled waiting (avg over 10 s)" />
      <GraphBox caption="% of time some tasks stalled" frames={frames} windowSeconds={windowSeconds} max="auto" format={v => `${v.toFixed(1)}%`}
        series={[
          { key: "cpu", label: "CPU", color: "var(--series-1)", value: f => f.psi?.cpu.some, fill: false },
          { key: "mem", label: "Memory", color: "var(--series-2)", value: f => f.psi?.memory.some, fill: false },
          { key: "io", label: "I/O", color: "var(--series-3)", value: f => f.psi?.io.some, fill: false },
        ]} />
      <p className="mt-3 text-sm text-muted-foreground">
        Utilisation says how busy a resource is; pressure says how much work is waiting on it. A disk at 100% active time with near-zero I/O pressure is busy but coping. Rising I/O pressure is when things feel slow.
      </p>
      <Stats items={[
        ["CPU some", pct1(latest.psi.cpu.some)],
        ["Memory some", pct1(latest.psi.memory.some)],
        ["Memory full", pct1(latest.psi.memory.full)],
        ["I/O some", pct1(latest.psi.io.some)],
        ["I/O full", pct1(latest.psi.io.full)],
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
      <PanelHeader title={`Disk ${name}`} detail={[disk?.model, disk?.kind.toUpperCase()].filter(Boolean).join(" · ")} />
      <GraphBox caption="Active time" frames={frames} windowSeconds={windowSeconds} max={100} format={pct} className="h-48"
        series={[{ key: "busy", label: "Active time", color: "var(--series-3)", value: f => pick(f)?.busyPercent }]} />
      <div className="mt-4">
        <GraphBox caption="Transfer rate" frames={frames} windowSeconds={windowSeconds} max="auto" format={v => humanBytesPerSecond(v, 0)} className="h-40"
          series={[
            { key: "r", label: "Read", color: "var(--series-1)", value: f => pick(f)?.readBps },
            { key: "w", label: "Write", color: "var(--series-2)", value: f => pick(f)?.writeBps, fill: false },
          ]} />
      </div>
      <Stats items={[
        ["Active time", pct1(now?.busyPercent)],
        ["Average response", now?.latencyMs === null || now?.latencyMs === undefined ? "idle" : `${now.latencyMs.toFixed(1)} ms`],
        ["Read speed", humanBytesPerSecond(now?.readBps)],
        ["Write speed", humanBytesPerSecond(now?.writeBps)],
        ["Read / write IOPS", now ? `${now.readIops.toFixed(0)} / ${now.writeIops.toFixed(0)}` : "—"],
        ["Capacity", humanBytes(disk?.sizeBytes, false)],
        ["Type", disk?.kind.toUpperCase() ?? "—"],
      ]} />
      {disk?.kind === "raid" && <p className="mt-3 text-sm text-muted-foreground">Array member health and rebuild state are on the RAID &amp; Disks page.</p>}
    </>
  );
}

function NicPanel({ name, windowSeconds }: { name: string; windowSeconds: number }) {
  const { info, latest, frames } = useLive();
  const nic = info?.nics.find(n => n.name === name);
  const now = latest?.nets.find(n => n.name === name);
  const pick = (f: LiveFrame) => f.nets.find(n => n.name === name);
  return (
    <>
      <PanelHeader title={`${nic?.wireless ? "Wi-Fi" : "Ethernet"} ${name}`} detail={nic?.operstate === "up" ? `Link ${nic.speedMbps ? `${nic.speedMbps >= 1000 ? nic.speedMbps / 1000 + " Gbps" : nic.speedMbps + " Mbps"}` : "up"}` : "Not connected"} />
      <GraphBox caption="Throughput" frames={frames} windowSeconds={windowSeconds} max="auto" format={v => bits(v)}
        series={[
          { key: "rx", label: "Receive", color: "var(--series-1)", value: f => pick(f)?.rxBps },
          { key: "tx", label: "Send", color: "var(--series-2)", value: f => pick(f)?.txBps, fill: false },
        ]} />
      <Stats items={[
        ["Send", now ? bits(now.txBps) : "—"],
        ["Receive", now ? bits(now.rxBps) : "—"],
        ["Packets in / out", now ? `${now.rxPps.toFixed(0)} / ${now.txPps.toFixed(0)} per s` : "—"],
        ["Errors", now ? `${now.errorsPerSec}/s` : "—"],
        ["Drops", now ? `${now.dropsPerSec}/s` : "—"],
        ["Link utilisation", now && nic?.speedMbps ? pct1((100 * Math.max(now.rxBps, now.txBps) * 8) / (nic.speedMbps * 1e6)) : "—"],
        ["Addresses", nic?.addresses.length ? <span className="text-sm">{nic.addresses.join(", ")}</span> : "—"],
        ["MAC", nic?.mac ? <span className="text-sm">{nic.mac}</span> : "—"],
      ]} />
    </>
  );
}

function GpuPanel({ index, windowSeconds }: { index: number; windowSeconds: number }) {
  const { info, latest, frames } = useLive();
  const gpu = info?.gpus.find(g => g.index === index);
  const now = latest?.gpus.find(g => g.index === index);
  const pick = (f: LiveFrame) => f.gpus.find(g => g.index === index);
  return (
    <>
      <PanelHeader title={`GPU ${index}`} detail={`${gpu?.name ?? ""}${gpu?.driver ? ` · driver ${gpu.driver}` : ""}`} />
      <GraphBox caption="Utilisation, with video encode/decode engines" frames={frames} windowSeconds={windowSeconds} max={100} format={pct}
        series={[
          { key: "u", label: "3D / compute", color: "var(--series-5)", value: f => pick(f)?.utilPercent },
          { key: "d", label: "Video decode", color: "var(--series-1)", value: f => pick(f)?.decoderPercent, fill: false },
          { key: "e", label: "Video encode", color: "var(--series-2)", value: f => pick(f)?.encoderPercent, fill: false },
        ]} />
      <div className="mt-4">
        <GraphBox caption="Dedicated memory" frames={frames} windowSeconds={windowSeconds} max={now?.memTotalBytes ?? "auto"} format={v => humanBytes(v)} className="h-32"
          series={[{ key: "m", label: "Memory used", color: "var(--series-7)", value: f => pick(f)?.memUsedBytes }]} />
      </div>
      <Stats items={[
        ["Utilisation", pct1(now?.utilPercent)],
        ["Video decode", pct1(now?.decoderPercent)],
        ["Video encode", pct1(now?.encoderPercent)],
        ["Memory", now ? `${humanBytes(now.memUsedBytes)} / ${humanBytes(now.memTotalBytes)}` : "—"],
        ["Temperature", now?.temperatureC !== null && now?.temperatureC !== undefined ? `${now.temperatureC} °C` : "—"],
        ["Power", now?.powerW !== null && now?.powerW !== undefined ? `${now.powerW.toFixed(0)} W` : "Not reported"],
        ["Fan", now?.fanPercent !== null && now?.fanPercent !== undefined ? `${now.fanPercent}%` : "—"],
        ["Graphics clock", now?.clockMhz ? `${now.clockMhz} MHz` : "—"],
      ]} />
      <p className="mt-3 text-sm text-muted-foreground">Plex hardware transcodes show up as video decode/encode, not 3D utilisation.</p>
    </>
  );
}
