/**
 * The bench-instrument kit: every page builds from these so the whole
 * dashboard reads as one panel. Rules the components enforce:
 *
 *  - Status colour only lights a lamp; a word always says the status.
 *  - A reading without a current value renders as a hatched void with its
 *    data state (NO DATA, NOT CONFIGURED, STALE...), never as 0 or a blank.
 *  - Numbers, paths and names are mono; labels are silkscreened panel text.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ status */

export type StatusLike = "HEALTHY" | "INFO" | "WARNING" | "CRITICAL" | "UNKNOWN" | string | null | undefined;

const LAMP: Record<string, string> = {
  HEALTHY: "var(--status-good)",
  INFO: "var(--status-info)",
  WARNING: "var(--status-warning)",
  SERIOUS: "var(--status-serious)",
  CRITICAL: "var(--status-critical)",
};

export const STATUS_RANK: Record<string, number> = { CRITICAL: 4, WARNING: 3, UNKNOWN: 2, INFO: 1, HEALTHY: 0 };

export function normaliseStatus(status: StatusLike): string {
  const s = String(status ?? "UNKNOWN").toUpperCase();
  return s in STATUS_RANK || s === "SERIOUS" ? s : "UNKNOWN";
}

/** CSS colour for a status, for text that must carry tone (ledger cells, inline values). */
export function statusColor(status: StatusLike): string {
  return LAMP[normaliseStatus(status)] ?? "var(--graphite)";
}

export function worstStatus(statuses: StatusLike[]): string {
  return statuses.map(normaliseStatus).reduce((a, b) => (STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a, "HEALTHY");
}

export function Lamp({ status, className, label }: { status: StatusLike; className?: string; label?: string }) {
  const s = normaliseStatus(status);
  return (
    <span
      className={cn("lamp", s === "UNKNOWN" && "lamp-void", className)}
      style={s === "UNKNOWN" ? undefined : { backgroundColor: LAMP[s] }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

/**
 * The status word with its lamp. `emphasis` fills a CRITICAL stamp; use it
 * once per screen, for the overall verdict.
 */
export function Stamp({ status, label, size = "sm", emphasis = false, className, title }: {
  status: StatusLike;
  label?: string;
  size?: "sm" | "lg";
  emphasis?: boolean;
  className?: string;
  title?: string;
}) {
  const s = normaliseStatus(status);
  const filled = emphasis && s === "CRITICAL";
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[2px] border font-panel uppercase text-silk",
        size === "lg" ? "px-[11px] py-[7px] text-[11px] tracking-[0.12em]" : "px-[9px] py-[5px] text-[9.5px] tracking-[0.12em]",
        filled ? "border-crit-fill bg-crit-fill text-white" : "border-seam",
        className,
      )}
    >
      {filled ? <span className="lamp bg-white" aria-hidden /> : <Lamp status={s} />}
      {label ?? s}
    </span>
  );
}

/* -------------------------------------------------------------- data state */

export type DataStateLike = "OK" | "NO_DATA" | "NOT_CONFIGURED" | "STALE" | "ERROR" | "ACQUIRING" | string | null | undefined;

const STATE_TAG: Record<string, string> = {
  NO_DATA: "NO DATA",
  NOT_CONFIGURED: "NOT CONFIGURED",
  STALE: "STALE",
  ERROR: "ERROR",
  ACQUIRING: "ACQUIRING",
  UNKNOWN: "UNKNOWN",
  OFFLINE: "OFFLINE",
};

/** A hatched placeholder for a value that is not currently known. */
export function Void({ state = "NO_DATA", note, className, compact = false }: {
  state?: DataStateLike;
  note?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const key = String(state ?? "NO_DATA").toUpperCase();
  return (
    <span className={cn("void", key === "ACQUIRING" && "void-acquiring", compact && "min-h-0 px-1.5 py-[3px]", className)}>
      <span className="whitespace-nowrap border border-seam bg-enamel px-1.5 py-[3px] font-panel text-[9px] uppercase tracking-[0.12em] text-silk">
        {STATE_TAG[key] ?? key.replace(/_/g, " ")}
      </span>
      {note != null && note !== "" && (
        <span className="bg-enamel px-1 py-px text-[12.5px] leading-snug text-silk-dim">{note}</span>
      )}
    </span>
  );
}

/** True when a reading-like value has nothing current to show. */
export function isMissing(value: unknown, state?: DataStateLike): boolean {
  const s = String(state ?? "OK").toUpperCase();
  return value === null || value === undefined || value === "" || (s !== "OK" && s !== "");
}

/**
 * A measured value in mono, or a Void when it is missing. Prefer this over
 * printing `value ?? "—"`: a dash looks like a reading.
 */
export function Readout({ value, unit, state, note, size = "md", className, color }: {
  value: React.ReactNode;
  unit?: string;
  state?: DataStateLike;
  note?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  color?: string;
}) {
  if (isMissing(value, state)) {
    return <Void state={state && String(state).toUpperCase() !== "OK" ? state : "NO_DATA"} note={note} compact={size === "sm"} className={className} />;
  }
  const sizes = { sm: "text-sm", md: "text-[22px] leading-[1.1]", lg: "text-[32px] leading-none", xl: "text-[56px] leading-none tracking-[-0.02em]" };
  const unitSizes = { sm: "text-xs", md: "text-sm", lg: "text-base", xl: "text-lg" };
  return (
    <span className={cn("font-mono font-medium tabular-nums", sizes[size], className)} style={color ? { color } : undefined}>
      {value}
      {unit ? <span className={cn("ml-[3px] font-normal text-graphite", unitSizes[size])}>{unit.trim()}</span> : null}
    </span>
  );
}

/** A labelled readout for stat grids. */
export function Metric({ label, value, unit, state, note, size = "md", hint, className, color }: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: string;
  state?: DataStateLike;
  note?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  hint?: React.ReactNode;
  className?: string;
  color?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-xs text-graphite">{label}</span>
      <Readout value={value} unit={unit} state={state} note={note} size={size} color={color} />
      {hint ? <span className="text-xs leading-snug text-silk-dim">{hint}</span> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- ledger */

export type Delta = number | null | undefined;

function formatDelta(v: number, digits: number) {
  const fixed = v.toFixed(digits);
  return v > 0 ? `+${fixed}` : v === 0 ? `+${(0).toFixed(digits)}` : fixed;
}

/**
 * State, delta, trend: change over 1h / 24h / 7d / 30d. Zero stays grey so a
 * high but static count never looks like a fault; `concern` lights rises
 * that are themselves the problem.
 */
export function Ledger({ deltas, digits = 0, concern, labels = true, labelClassName, className }: {
  deltas: { "1h"?: Delta; "24h"?: Delta; "7d"?: Delta; "30d"?: Delta };
  digits?: number;
  /** Status to light non-zero rises with (e.g. WARNING when growth is the alert). */
  concern?: StatusLike;
  labels?: boolean;
  /** Extra classes for the 1 h / 24 h labels, e.g. "lg:hidden" under a shared header row. */
  labelClassName?: string;
  className?: string;
}) {
  const cells: Array<[string, Delta]> = [["1 h", deltas["1h"]], ["24 h", deltas["24h"]], ["7 d", deltas["7d"]], ["30 d", deltas["30d"]]];
  return (
    <div className={cn("grid grid-cols-4 gap-1", className)} role="group" aria-label="Change over time">
      {cells.map(([k, v]) => {
        const missing = v === null || v === undefined || Number.isNaN(v);
        const color = missing ? undefined : v === 0 ? "var(--graphite)" : concern && v > 0 ? statusColor(concern) : "var(--silk)";
        return (
          <div key={k} className={cn("flex flex-col items-end gap-0.5 rounded-[2px] border border-[#232b28] bg-well px-2 py-1.5", missing && "void-fill")}>
            {labels && <span className={cn("font-panel text-[8.5px] uppercase tracking-[0.12em] text-graphite", labelClassName)}>{k}</span>}
            <span className="font-mono text-sm tabular-nums" style={{ color }}>
              {missing ? <span className="bg-well px-0.5 text-graphite" aria-label="no data">n/a</span> : formatDelta(v as number, digits)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Reads `delta_1h` … `delta_30d` from a reading's `extra`. */
export function deltasFrom(extra: Record<string, any> | null | undefined) {
  const e = extra ?? {};
  return { "1h": e.delta_1h, "24h": e.delta_24h, "7d": e.delta_7d, "30d": e.delta_30d };
}

export function hasDeltas(extra: Record<string, any> | null | undefined) {
  const e = extra ?? {};
  return ["delta_1h", "delta_24h", "delta_7d", "delta_30d"].some(k => k in e);
}

/* ----------------------------------------------------------------- meters */

/**
 * A horizontal gauge with threshold ticks, for percentages and capacities.
 * The fill takes the colour of the band the value is in.
 */
export function Meter({ value, max = 100, warn, crit, label, className }: {
  value: number | null | undefined;
  max?: number;
  warn?: number;
  crit?: number;
  label?: string;
  className?: string;
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <div className={cn("h-2 rounded-[1px] border border-dashed border-seam-strong void-fill", className)} aria-label={label ? `${label}: no data` : "no data"} />;
  }
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const tone = crit != null && value >= crit ? "var(--status-critical)" : warn != null && value >= warn ? "var(--status-warning)" : "var(--silk-dim)";
  return (
    <div
      className={cn("relative h-2 rounded-[1px] bg-well shadow-[inset_0_0_0_1px_var(--seam)]", className)}
      role="meter"
      aria-valuenow={Math.round(value * 10) / 10}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div className="absolute inset-y-0 left-0 rounded-[1px]" style={{ width: `${pct}%`, background: tone }} />
      {warn != null && <span className="absolute -top-0.5 h-3 w-px bg-warn/70" style={{ left: `${(warn / max) * 100}%` }} aria-hidden />}
      {crit != null && <span className="absolute -top-0.5 h-3 w-px bg-crit/80" style={{ left: `${(crit / max) * 100}%` }} aria-hidden />}
    </div>
  );
}

/** The health-score ruler: bands at 70 and 90, solid needle = score, dashed tick = measured score when capped. */
export function ScoreRuler({ score, raw, className }: { score: number; raw?: number | null; className?: string }) {
  const capped = raw != null && Math.round(raw) !== Math.round(score);
  return (
    <div className={cn("relative h-11", className)} aria-hidden>
      <div className="absolute inset-x-0 top-2.5 h-1.5 rounded-[1px]" style={{ background: "linear-gradient(to right, #3a2321 0 70%, #3a3420 70% 90%, #1d3a22 90% 100%)" }} />
      <div className="absolute inset-x-0 top-[18px] h-[5px]" style={{ backgroundImage: "repeating-linear-gradient(to right, #4a5651 0 1px, transparent 1px 10%)" }} />
      {capped && <div className="absolute top-0.5 h-[22px] border-l border-dashed border-graphite" style={{ left: `${raw}%` }} />}
      <div className="absolute top-0 -ml-px h-[26px] w-0.5 bg-silk" style={{ left: `${Math.max(0, Math.min(100, score))}%` }} />
      {[["0", 0], ["70", 70], ["90", 90], ["100", 100]].map(([t, p]) => (
        <span key={t} className="absolute top-7 font-mono text-[11px] text-graphite" style={p === 0 ? { left: 0 } : p === 100 ? { right: 0 } : { left: `${p}%`, transform: "translateX(-50%)" }}>{t}</span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- structure */

export function PanelLabel({ as: Tag = "span", className, ...props }: React.HTMLAttributes<HTMLElement> & { as?: React.ElementType }) {
  return <Tag className={cn("panel-label m-0", className)} {...props} />;
}

/**
 * The header every page opens with: the nav group as an eyebrow, the page
 * name, one line on what the page answers, and where its data comes from.
 */
export function PageHeader({ group, title, description, status, meta, actions, children }: {
  group?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  status?: StatusLike;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-seam pb-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {group && <PanelLabel>{group}</PanelLabel>}
          {meta && <span className="font-mono text-[13px] text-graphite">{meta}</span>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="m-0 text-[clamp(26px,3vw,36px)] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
            {status && <Stamp status={status} size="lg" />}
          </div>
          {description && <p className="m-0 max-w-[68ch] text-base leading-relaxed text-silk-dim text-pretty">{description}</p>}
        </div>
      </div>
      {children}
    </header>
  );
}

/** A section of a page: silkscreened heading, optional count and action. */
export function Section({ title, count, action, note, children, className, id }: {
  title: React.ReactNode;
  count?: number;
  action?: React.ReactNode;
  note?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = id ?? (typeof title === "string" ? `s-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : undefined);
  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col gap-3.5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
        <h2 id={headingId} className="panel-label m-0">
          {title}{count != null ? ` · ${count}` : ""}
        </h2>
        {note && <span className="text-[13px] text-graphite">{note}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

/** A raised bezel panel. `title` puts a silkscreened label in its top edge. */
export function Panel({ title, status, action, children, className, padded = true, as: Tag = "div" }: {
  title?: React.ReactNode;
  status?: StatusLike;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  padded?: boolean;
  as?: React.ElementType;
}) {
  return (
    <Tag className={cn("flex min-w-0 flex-col gap-4 rounded-[3px] border border-seam bg-bezel", padded && "px-5 py-[18px]", className)}>
      {(title || status || action) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {status && <Stamp status={status} />}
            {title && <span className="panel-label">{title}</span>}
          </div>
          {action}
        </div>
      )}
      {children}
    </Tag>
  );
}

/** A recessed readout window. */
export function Well({ children, className, as: Tag = "div" }: { children?: React.ReactNode; className?: string; as?: React.ElementType }) {
  return <Tag className={cn("well px-5 py-[18px]", className)}>{children}</Tag>;
}

/** Explains-itself facts: Now / Threshold / Probable cause / Next check. */
export function Facts({ items, className }: { items: Array<[React.ReactNode, React.ReactNode] | null | undefined | false>; className?: string }) {
  const rows = items.filter(Boolean) as Array<[React.ReactNode, React.ReactNode]>;
  return (
    <dl className={cn("m-0 grid grid-cols-1 gap-x-[18px] gap-y-1 sm:grid-cols-[118px_minmax(0,1fr)] sm:gap-y-2.5", className)}>
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="panel-label pt-1">{k}</dt>
          <dd className="m-0 mb-2 text-[15px] leading-normal text-silk sm:mb-0">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** Nothing to show: say what that means and what to do. */
export function EmptyState({ title, children, action, className }: { title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <Well className={cn("flex flex-col gap-2 px-[22px] py-[22px]", className)}>
      <p className="m-0 text-lg font-semibold">{title}</p>
      {children && <div className="m-0 max-w-[70ch] text-[15px] leading-normal text-silk-dim">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </Well>
  );
}

/** A collection or request failure, stated plainly with what to check. */
export function ErrorState({ title = "Couldn't load this data", detail, children, className }: { title?: React.ReactNode; detail?: unknown; children?: React.ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col gap-3 rounded-[3px] border border-seam bg-bezel px-5 py-[18px]", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Stamp status="CRITICAL" label="ERROR" />
        <p className="m-0 text-base font-semibold">{title}</p>
      </div>
      {detail != null && <pre className="m-0 overflow-x-auto whitespace-pre-wrap rounded-[2px] bg-well p-3 font-mono text-xs text-silk-dim">{detail instanceof Error ? detail.message : String(detail)}</pre>}
      {children && <div className="text-sm text-silk-dim">{children}</div>}
    </div>
  );
}

/** Placeholder while the first sample is on its way. */
export function Acquiring({ className, rows = 3 }: { className?: string; rows?: number }) {
  return (
    <div className={cn("flex flex-col gap-3", className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="void void-acquiring h-16">
          {i === 0 && <span className="border border-seam bg-enamel px-1.5 py-[3px] font-panel text-[9px] uppercase tracking-[0.12em] text-silk">ACQUIRING</span>}
        </div>
      ))}
    </div>
  );
}

/** Mutually exclusive view switch (list / tree, 1 min / 10 min...). */
export function Segmented<T extends string>({ options, value, onChange, label, className }: {
  options: Array<{ value: T; label: React.ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex flex-wrap gap-1 rounded-[3px] border border-seam bg-well p-1", className)}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className="min-h-9 rounded-[2px] px-3 text-[13px] font-semibold text-silk-dim hover:text-silk aria-pressed:bg-bezel aria-pressed:text-silk aria-pressed:shadow-[inset_0_0_0_1px_var(--seam-strong)]"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Inline mono token for paths, container names, ports. */
export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("rounded-[2px] bg-well px-1 py-px font-mono text-[0.92em] text-silk", className)}>{children}</code>;
}

/** Text from collectors, with `backticked` commands rendered as Code. */
export function Prose({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  const parts = text.split(/`([^`]+)`/g);
  return <>{parts.map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : part))}</>;
}

/** Where a figure came from. */
export function Source({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs text-graphite", className)}>{children}</span>;
}
