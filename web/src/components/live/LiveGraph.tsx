"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveFrame } from "@/lib/live";

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

    // Recessive grid: quarters, hairline.
    ctx.strokeStyle = resolveColor(el, "var(--chart-grid)");
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gy = Math.round((size.h * i) / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(size.w, gy); ctx.stroke();
    }
    if (!compact) {
      // Vertical lines every 10 % of the window, like Task Manager's moving grid.
      const step = (windowSeconds * 1000) / 10;
      for (let t = Math.ceil(start / step) * step; t < end; t += step) {
        const gx = Math.round(x(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, size.h); ctx.stroke();
      }
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
        if (v === null || v === undefined || !Number.isFinite(v) || broken) {
          if (run.length) runs.push(run);
          run = [];
        }
        if (v !== null && v !== undefined && Number.isFinite(v)) run.push([x(f.ts), y(v)]);
        prevTs = f.ts;
      }
      if (run.length) runs.push(run);

      for (const points of runs) {
        if (s.fill !== false && points.length > 1) {
          ctx.beginPath();
          ctx.moveTo(points[0][0], size.h);
          for (const [px, py] of points) ctx.lineTo(px, py);
          ctx.lineTo(points.at(-1)![0], size.h);
          ctx.closePath();
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.strokeStyle = color;
        ctx.lineWidth = compact ? 1.25 : 2;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }

    if (hoverX !== null && !compact) {
      ctx.strokeStyle = resolveColor(el, "var(--chart-muted)");
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hoverX + 0.5, 0); ctx.lineTo(hoverX + 0.5, size.h); ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [visible, series, size, start, end, ceiling, compact, hoverX, windowSeconds, expectedGap]);

  // Nearest frame to the pointer for the tooltip.
  let hovered: LiveFrame | null = null;
  if (hoverX !== null && visible.length && size.w) {
    const target = start + (hoverX / size.w) * (end - start);
    hovered = visible.reduce((best, f) => (Math.abs(f.ts - target) < Math.abs(best.ts - target) ? f : best), visible[0]);
  }

  return (
    <div
      ref={wrap}
      className={`relative min-h-0 overflow-hidden ${className}`}
      role="img"
      aria-label={ariaLabel ?? series.map(s => s.label).join(", ")}
      onPointerMove={compact ? undefined : e => setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
      onPointerLeave={compact ? undefined : () => setHoverX(null)}
    >
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} className="absolute inset-0" />
      {!compact && (
        <span className="pointer-events-none absolute right-1.5 top-1 font-mono text-[10px] tabular-nums text-[var(--chart-muted)]">
          {format(ceiling)}
        </span>
      )}
      {hovered && hoverX !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-lg"
          style={hoverX > size.w / 2 ? { right: size.w - hoverX + 10 } : { left: hoverX + 10 }}
        >
          <p className="mb-1 font-mono text-[10px] text-muted-foreground">{new Date(hovered.ts).toLocaleTimeString()}</p>
          {series.map(s => {
            const v = s.value(hovered!);
            return (
              <p key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</span>
                <span className="font-mono tabular-nums">{v === null || v === undefined ? "no data" : format(v)}</span>
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Legend({ series }: { series: Pick<GraphSeries, "key" | "label" | "color">[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {series.map(s => (
        <span key={s.key} className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}
        </span>
      ))}
    </div>
  );
}
