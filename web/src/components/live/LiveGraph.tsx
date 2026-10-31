"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveFrame } from "@/lib/live";
import { cn } from "@/lib/utils";

export interface GraphSeries {
  key: string;
  label: string;
  /** A CSS colour or var(--token); tokens are resolved against the canvas. */
  color: string;
  value: (frame: LiveFrame) => number | null | undefined;
  /** Filled area under the line. Off for secondary lines so they don't muddy the first. */
  fill?: boolean;
}

interface Props {
  frames: LiveFrame[];
  series: GraphSeries[];
  windowSeconds?: number;
  /** Fixed ceiling (e.g. 100 for percentages), or "auto" to fit the visible data. */
  max?: number | "auto";
  format?: (value: number) => string;
  /** Sparkline mode: no grid labels, no hover, thinner line. */
  compact?: boolean;
  className?: string;
  ariaLabel?: string;
}

const resolveColor = (el: HTMLElement, color: string) => {
  const match = /^var\((--[\w-]+)\)$/.exec(color.trim());
  return match ? getComputedStyle(el).getPropertyValue(match[1]).trim() || "#888" : color;
};

/** Round an auto-scaled ceiling up to 1, 2 or 5 × 10^n so gridlines land on readable values. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const m = value / exp;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * exp;
}

const windowLabel = (seconds: number) => (seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`);

const isValue = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** Axis lettering: mono, graphite, 11 px, on a well-coloured backing so traces never cross it. */
function AxisLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("pointer-events-none absolute rounded-[2px] bg-well/80 px-1 font-mono text-[11px] leading-[15px] tabular-nums text-graphite", className)}>
      {children}
    </span>
  );
}

/** A short line swatch: series identity, distinct from the square status lamp. */
function Swatch({ color, fill }: { color: string; fill?: boolean }) {
  return (
    <span aria-hidden className="relative inline-block h-2.5 w-3.5 shrink-0">
      {fill !== false && <span className="absolute inset-x-0 bottom-0 top-1 opacity-25" style={{ background: color }} />}
      <span className="absolute inset-x-0 top-1 h-[2px]" style={{ background: color }} />
    </span>
  );
}

export function LiveGraph({ frames, series, windowSeconds = 60, max = "auto", format = v => v.toFixed(0), compact = false, className = "", ariaLabel }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const end = frames.at(-1)?.ts ?? Date.now();
  const start = end - windowSeconds * 1000;
  const visible = frames.filter(f => f.ts >= start);
  const expectedGap = visible.length > 1 ? (visible.at(-1)!.ts - visible[0].ts) / (visible.length - 1) : 1000;

  let ceiling = typeof max === "number" ? max : 0;
  if (max === "auto") {
    for (const f of visible) for (const s of series) ceiling = Math.max(ceiling, s.value(f) ?? 0);
    ceiling = niceCeiling(ceiling * 1.1);
  }

  useEffect(() => {
    const el = canvas.current;
    if (!el || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = size.w * dpr;
    el.height = size.h * dpr;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const x = (ts: number) => ((ts - start) / (end - start || 1)) * size.w;
    const y = (v: number) => size.h - (Math.min(v, ceiling) / (ceiling || 1)) * (size.h - 2) - 1;

    // Recessive graticule: quarters, hairline.
    ctx.strokeStyle = resolveColor(el, "var(--chart-grid)");
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gy = Math.round((size.h * i) / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(size.w, gy); ctx.stroke();
    }
    if (!compact) {
      // Vertical divisions every 10 % of the window; they scroll with the trace.
      const step = (windowSeconds * 1000) / 10;
      for (let t = Math.ceil(start / step) * step; t < end; t += step) {
        const gx = Math.round(x(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, size.h); ctx.stroke();
      }
      // Baseline in the axis colour, so zero reads as a floor rather than a missing line.
      ctx.strokeStyle = resolveColor(el, "var(--chart-axis)");
      ctx.beginPath(); ctx.moveTo(0, size.h - 0.5); ctx.lineTo(size.w, size.h - 0.5); ctx.stroke();
    }

    for (const s of series) {
      const color = resolveColor(el, s.color);
      // Split into runs wherever a value is missing or frames are more than
      // three intervals apart. A gap is drawn as a gap, never as zero.
      const runs: Array<Array<[number, number]>> = [];
      let run: Array<[number, number]> = [];
      let prevTs: number | null = null;
      for (const f of visible) {
        const v = s.value(f);
        const broken = prevTs !== null && f.ts - prevTs > expectedGap * 3;
        if (!isValue(v) || broken) {
          if (run.length) runs.push(run);
          run = [];
        }
        if (isValue(v)) run.push([x(f.ts), y(v)]);
        prevTs = f.ts;
      }
      if (run.length) runs.push(run);

      for (const points of runs) {
        if (points.length === 1) {
          // A lone sample between gaps: mark it, so it isn't silently lost.
          ctx.fillStyle = color;
          ctx.fillRect(points[0][0] - 1.5, points[0][1] - 1.5, 3, 3);
          continue;
        }
        if (s.fill !== false) {
          ctx.beginPath();
          ctx.moveTo(points[0][0], size.h);
          for (const [px, py] of points) ctx.lineTo(px, py);
          ctx.lineTo(points.at(-1)![0], size.h);
          ctx.closePath();
          ctx.globalAlpha = 0.14;
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.strokeStyle = color;
        ctx.lineWidth = compact ? 1.25 : 1.75;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }

    if (hoverX !== null && !compact) {
      ctx.strokeStyle = resolveColor(el, "var(--chart-muted)");
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(hoverX) + 0.5, 0); ctx.lineTo(Math.round(hoverX) + 0.5, size.h); ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [visible, series, size, start, end, ceiling, compact, hoverX, windowSeconds, expectedGap]);

  // Nearest frame to the pointer for the readout. If the pointer is over a
  // gap in the stream, say so instead of borrowing a neighbouring sample.
  let hovered: LiveFrame | null = null;
  let inGap = false;
  let hoverTs = 0;
  if (hoverX !== null && size.w) {
    hoverTs = start + (hoverX / size.w) * (end - start);
    if (visible.length) {
      hovered = visible.reduce((best, f) => (Math.abs(f.ts - hoverTs) < Math.abs(best.ts - hoverTs) ? f : best), visible[0]);
      inGap = Math.abs(hovered.ts - hoverTs) > expectedGap * 1.5;
    } else {
      inGap = true;
    }
  }
  const showReadout = hoverX !== null && !compact && size.w > 0;

  return (
    <div
      ref={wrap}
      className={cn("relative min-h-0 overflow-hidden", className)}
      role="img"
      aria-label={ariaLabel ?? series.map(s => s.label).join(", ")}
      onPointerMove={compact ? undefined : e => setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
      onPointerLeave={compact ? undefined : () => setHoverX(null)}
    >
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} className="absolute inset-0" />
      {!compact && (
        <>
          <AxisLabel className="right-1 top-1">{format(ceiling)}</AxisLabel>
          {size.h >= 120 && <AxisLabel className="right-1 top-1/2 -translate-y-1/2">{format(ceiling / 2)}</AxisLabel>}
          <AxisLabel className="bottom-1 left-1">−{windowLabel(windowSeconds)}</AxisLabel>
          <AxisLabel className="bottom-1 right-1">now</AxisLabel>
        </>
      )}
      {showReadout && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-[2px] border border-seam-strong bg-bezel px-2.5 py-2 text-xs shadow-[0_6px_18px_rgb(0_0_0/0.45)]"
          style={hoverX! > size.w / 2 ? { right: size.w - hoverX! + 10 } : { left: hoverX! + 10 }}
        >
          <p className="m-0 mb-1.5 font-mono text-[11px] tabular-nums text-graphite">
            {new Date(inGap || !hovered ? hoverTs : hovered.ts).toLocaleTimeString()}
          </p>
          {inGap || !hovered ? (
            <p className="m-0 text-silk-dim">No samples here: the stream had a gap.</p>
          ) : (
            series.map(s => {
              const v = s.value(hovered!);
              return (
                <p key={s.key} className="m-0 flex items-center justify-between gap-4 py-px">
                  <span className="flex items-center gap-1.5 text-silk-dim"><Swatch color={s.color} fill={s.fill} />{s.label}</span>
                  {isValue(v)
                    ? <span className="font-mono tabular-nums text-silk">{format(v)}</span>
                    : <span className="font-panel text-[9px] uppercase tracking-[0.12em] text-graphite">no data</span>}
                </p>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export function Legend({ series }: { series: Array<Pick<GraphSeries, "key" | "label" | "color"> & { fill?: boolean }> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-silk-dim">
      {series.map(s => (
        <span key={s.key} className="flex items-center gap-1.5">
          <Swatch color={s.color} fill={s.fill} />{s.label}
        </span>
      ))}
    </div>
  );
}
