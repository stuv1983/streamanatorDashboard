"use client";

import Link from "next/link";
import type { Snapshot } from "@/lib/snapshot";
import type { Alert } from "@/lib/status";
import { useSnapshot, SnapshotBoundary } from "@/components/snapshot-ui";
import {
  EmptyState, Facts, Ledger, Lamp, PanelLabel, Prose, Readout, ScoreRuler, Section, Source, Stamp,
  STATUS_RANK, deltasFrom, hasDeltas, normaliseStatus,
} from "@/components/instrument";

interface DashboardClientProps {
  hostname: string;
  grafanaUrl?: string | null;
}

/** Where each scored component is explained in full. */
const COMPONENT_PAGE: Record<string, string> = {
  raid_disks: "/raid", storage: "/storage", server: "/server", network: "/network", containers: "/docker",
  vpn: "/vpn", applications: "/applications", backups: "/backups", security: "/security", conditions: "/alerts",
};

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

const toMs = (t: number | null | undefined) => (t == null ? null : t > 1e12 ? t : t * 1000);

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "18:02" today, "Fri 21:40" otherwise. */
function when(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? clock(ms)
    : `${d.toLocaleDateString("en-AU", { weekday: "short" })} ${clock(ms)}`;
}

function trimStop(s: string) {
  return s.trim().replace(/[.\s]+$/, "");
}

type Attention = { alert: Alert; effects: Alert[]; incidentTitle?: string; explanation?: string };

function attentionItems(snapshot: Snapshot): Attention[] {
  const grouped = new Set<string>();
  const items: Attention[] = [];
  for (const incident of snapshot.incidents ?? []) {
    if (!incident.cause) continue;
    grouped.add(incident.cause.key);
    for (const e of incident.effects ?? []) grouped.add(e.key);
    items.push({ alert: incident.cause, effects: incident.effects ?? [], incidentTitle: incident.title, explanation: incident.explanation });
  }
  for (const alert of snapshot.alerts ?? []) {
    if (grouped.has(alert.key)) continue;
    if (normaliseStatus(alert.status) === "HEALTHY" || normaliseStatus(alert.status) === "INFO") continue;
    items.push({ alert, effects: [] });
  }
  return items.sort((a, b) => (STATUS_RANK[normaliseStatus(b.alert.status)] ?? 0) - (STATUS_RANK[normaliseStatus(a.alert.status)] ?? 0));
}

/** The one sentence the page opens with. */
function verdictFor(snapshot: Snapshot, items: Attention[]) {
  const status = normaliseStatus(snapshot.health.status);
  const unknown = Object.values(snapshot.components).filter(c => normaliseStatus(c.status) === "UNKNOWN");
  const lead = items[0];

  let verdict: string;
  if (!items.length && status === "HEALTHY") verdict = "Everything is healthy.";
  else if (!items.length && unknown.length) verdict = `Nothing is failing, but ${unknown.map(c => c.label).join(", ")} can't be measured right now.`;
  else if (!items.length) verdict = trimStop(snapshot.health.reason) + ".";
  else if (lead.effects.length) {
    const title = trimStop(lead.incidentTitle || lead.alert.title);
    const n = lead.effects.length;
    const others = items.length - 1;
    verdict = others > 0
      ? `${title}, and ${others === 1 ? "one other thing needs" : `${NUMBER_WORDS[others]?.toLowerCase() ?? others} other things need`} attention.`
      : `${title}, with ${n === 1 ? "one related alert" : `${n} related alerts`} grouped into it.`;
  } else if (items.length === 1) verdict = `One thing needs attention: ${trimStop(lead.alert.title)}.`;
  else if (items.length === 2) verdict = `Two things need attention: ${trimStop(items[0].alert.title)}, and ${trimStop(items[1].alert.title)}.`;
  else verdict = `${NUMBER_WORDS[items.length] ?? items.length} things need attention, starting with ${trimStop(lead.alert.title)}.`;

  const notes: string[] = [];
  if (unknown.length && items.length) {
    notes.push(`${unknown.map(c => c.label).join(", ")} ${unknown.length === 1 ? "shows" : "show"} as unknown rather than healthy, because ${unknown.length === 1 ? "it" : "they"} couldn't be measured.`);
  }
  if (!items.length && status === "HEALTHY") notes.push("Nothing needs you.");
  return { verdict, sub: notes.join(" ") };
}

function scoreNote(score: number, raw: number | undefined, status: string) {
  if (raw != null && Math.round(raw) !== Math.round(score)) {
    return `Measured ${Math.round(raw)}, capped at ${Math.round(score)} because a component is ${status.toLowerCase()}. The score never hides a fault.`;
  }
  return score >= 90 ? "In the healthy band, which starts at 90." : "Below the healthy band, which starts at 90.";
}

/** The reading that best represents a component: its worst, else its first. */
function headlineReading(readings: any[]) {
  if (!readings?.length) return null;
  return readings.reduce((best, r) => ((STATUS_RANK[normaliseStatus(r.status)] ?? 0) > (STATUS_RANK[normaliseStatus(best.status)] ?? 0) ? r : best), readings[0]);
}

function formatValue(value: unknown) {
  if (value == null) return null;
  if (typeof value === "number") return value.toLocaleString("en-AU", { maximumFractionDigits: 1 });
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export default function DashboardClient({ hostname, grafanaUrl }: DashboardClientProps) {
  const { data, error, isLoading } = useSnapshot();

  return (
    <div className="flex flex-col gap-11">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-seam pb-[18px]">
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2">
          <PanelLabel className="text-silk">Overview</PanelLabel>
          <span className="font-mono text-[13px] text-graphite">
            {hostname}
            {data ? ` · sampled ${new Date(toMs(data.collected_at)!).toLocaleTimeString("en-AU", { hour12: false })}` : ""}
            {data?.sources?.host ? ` · source ${data.sources.host}` : ""}
            {error && data ? " · last refresh failed, showing the previous sample" : ""}
          </span>
        </div>
        {grafanaUrl && (
          <a href={grafanaUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-[3px] border border-seam bg-bezel px-3.5 text-sm font-semibold text-silk no-underline hover:border-seam-strong hover:text-silk">
            Open Grafana
          </a>
        )}
      </div>

      <SnapshotBoundary data={data} error={error} isLoading={isLoading}>
        {(snapshot) => <Overview snapshot={snapshot} />}
      </SnapshotBoundary>
    </div>
  );
}

function Overview({ snapshot }: { snapshot: Snapshot }) {
  const health = snapshot.health;
  const status = normaliseStatus(health.status);
  const items = attentionItems(snapshot);
  const { verdict, sub } = verdictFor(snapshot, items);
  const nowMs = Date.now();
  const changes = (snapshot.changes ?? []).filter(c => (toMs(c.timestamp) ?? 0) >= nowMs - 86_400_000);
  const components = Object.values(snapshot.components).sort(
    (a, b) => (STATUS_RANK[normaliseStatus(b.status)] ?? 0) - (STATUS_RANK[normaliseStatus(a.status)] ?? 0),
  );
  const scored = components.filter(c => c.weight > 0).length;
  const changeSentence = changes.length === 0 ? "Nothing changed in the last 24 hours." : `${changes.length === 1 ? "There was one change" : `There were ${changes.length} changes`} in the last 24 hours.`;

  return (
    <>
      <section aria-labelledby="verdict" className="grid grid-cols-1 items-end gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
            <Stamp status={status} size="lg" emphasis />
            <span className="text-sm text-silk-dim">{health.reason}</span>
          </div>
          <h1 id="verdict" className="m-0 mt-[18px] max-w-[28ch] text-[clamp(30px,3.5vw,50px)] font-semibold leading-[1.08] tracking-[-0.018em] text-balance">
            {verdict}
          </h1>
          <p className="m-0 mt-[18px] max-w-[58ch] text-lg leading-normal text-silk-dim text-pretty">
            {[sub, changeSentence].filter(Boolean).join(" ")}
          </p>
        </div>
        <div className="well px-5 pb-4 pt-[18px]" aria-label={`Health score ${Math.round(health.score)} of 100`}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="panel-label m-0">Health score</h2>
            {health.rawScore != null && Math.round(health.rawScore) !== Math.round(health.score) && <span className="panel-label text-serious">Capped</span>}
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <Readout value={Math.round(health.score)} size="xl" />
            <span className="font-mono text-lg text-graphite">/ 100</span>
          </div>
          <ScoreRuler score={health.score} raw={health.rawScore} className="mt-4" />
          <p className="m-0 mt-2.5 text-[13px] leading-snug text-silk-dim">{scoreNote(health.score, health.rawScore, status)}</p>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Section title="Needs attention" count={items.length || undefined}>
          {items.length === 0 ? (
            <EmptyState title="Nothing needs attention." action={<Link href="/alerts" className="text-sm">Review alert rules</Link>}>
              All {scored} scored subsystems are within their thresholds.
            </EmptyState>
          ) : (
            items.map(item => <AttentionCard key={item.alert.key} item={item} />)
          )}
        </Section>

        <Section title="What changed · last 24 h">
          {changes.length === 0 ? (
            <p className="m-0 border-t border-seam pt-3 text-[15px] text-silk-dim">No inventory, address or state changes were recorded.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {changes.slice(0, 8).map((c, i) => (
                <li key={i} className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3.5 gap-y-1 border-t border-seam py-3">
                  <span className="pt-0.5 font-mono text-[13px] text-graphite">{when(toMs(c.timestamp)!)}</span>
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <span className="flex items-center gap-2 text-[15px] font-semibold">
                      {normaliseStatus(c.status) !== "INFO" && <Lamp status={c.status} label={String(c.status).toLowerCase()} />}
                      {c.summary}
                    </span>
                    {c.detail && <span className="break-words font-mono text-[13px] text-silk-dim">{c.detail}</span>}
                    {c.category && <PanelLabel className="text-[9px]">{c.category}</PanelLabel>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Link href="/events" className="text-sm">All events and changes</Link>
        </Section>
      </div>

      <Section title="Subsystems · worst first" note="Hatched readings have no current value. They are never shown as zero.">
        <div>
          <div aria-hidden className="hidden grid-cols-[128px_minmax(0,1fr)_206px_296px] gap-5 px-1 pb-2.5 lg:grid">
            <PanelLabel>State</PanelLabel>
            <PanelLabel>Subsystem</PanelLabel>
            <PanelLabel>Reading</PanelLabel>
            <div className="grid grid-cols-4 gap-1 text-right">
              {["1 h", "24 h", "7 d", "30 d"].map(k => <PanelLabel key={k} className="pr-2">{k}</PanelLabel>)}
            </div>
          </div>
          {components.map(component => {
            const reading = headlineReading(component.readings as any[]);
            const href = COMPONENT_PAGE[component.key];
            return (
              <div key={component.key} className="grid grid-cols-1 items-center gap-x-5 gap-y-2.5 border-t border-seam px-1 py-3.5 md:grid-cols-[128px_minmax(0,1fr)_206px] lg:grid-cols-[128px_minmax(0,1fr)_206px_296px]">
                <div><Stamp status={component.status} /></div>
                <div className="min-w-0">
                  {href ? (
                    <Link href={href} className="text-base font-semibold text-silk no-underline hover:text-trace hover:underline">{component.label}</Link>
                  ) : (
                    <span className="text-base font-semibold">{component.label}</span>
                  )}
                  <p className="m-0 mt-1 text-sm leading-normal text-silk-dim text-pretty">{component.detail || reading?.detail || `${component.readings.length} readings`}</p>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  {reading ? (
                    <>
                      <span className="text-xs text-graphite">{reading.label}</span>
                      <Readout value={formatValue(reading.value)} unit={reading.value != null ? reading.unit : undefined} state={reading.state} note={reading.state === "NOT_CONFIGURED" ? "See Admin" : undefined} />
                      {reading.source && <Source>{reading.source}</Source>}
                    </>
                  ) : (
                    <Readout value={null} state="NO_DATA" note="No readings yet" />
                  )}
                </div>
                <div className="min-w-0 md:col-span-3 lg:col-span-1">
                  {reading && hasDeltas(reading.extra) && <Ledger deltas={deltasFrom(reading.extra)} labelClassName="lg:hidden" />}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <p className="m-0 border-t border-seam pt-[18px] text-[13px] text-graphite">
        Read-only. This dashboard observes and explains; it never restarts a container, touches the array or changes configuration on its own.
      </p>
    </>
  );
}

function AttentionCard({ item }: { item: Attention }) {
  const a = item.alert;
  const sinceMs = toMs(a.since);
  return (
    <article className="flex flex-col gap-4 rounded-[3px] border border-seam bg-bezel px-5 pb-5 pt-[18px]">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
        <Stamp status={a.status} />
        <PanelLabel>{a.component}{item.effects.length ? " · incident" : ""}</PanelLabel>
        {sinceMs && <span className="ml-auto font-mono text-xs text-graphite">since {when(sinceMs)}</span>}
      </div>
      <h3 className="m-0 text-xl font-semibold leading-tight text-balance">{item.incidentTitle || a.title}</h3>
      {(item.explanation || a.detail) && <p className="m-0 text-[15px] leading-normal text-silk-dim"><Prose text={item.explanation || a.detail} /></p>}
      <Facts
        items={[
          a.current_value ? ["Now", <Prose key="n" text={a.current_value} />] : null,
          a.threshold ? ["Threshold", <Prose key="t" text={a.threshold} />] : null,
          a.probable_cause ? ["Probable cause", <Prose key="p" text={a.probable_cause} />] : null,
          a.recommended_action ? ["Next check", <Prose key="r" text={a.recommended_action} />] : null,
        ]}
      />
      {item.effects.length > 0 && (
        <div className="flex flex-col gap-2.5 border-t border-seam pt-3.5">
          <PanelLabel>Grouped into this incident</PanelLabel>
          <div className="flex flex-wrap gap-1.5">
            {item.effects.map(e => (
              <span key={e.key} className="inline-flex min-h-[30px] items-center gap-2 rounded-[2px] border border-seam bg-well px-2.5 text-[13px]">
                <Lamp status={e.status} />
                <span>{e.title}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}
