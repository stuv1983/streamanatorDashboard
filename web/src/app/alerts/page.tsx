"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { Condition, ConditionState } from "@/lib/conditions";
import { Button } from "@/components/ui/button";
import { Acquiring, EmptyState, ErrorState, Lamp, Metric, PageHeader, Panel, Readout, Section, Source, Stamp, Well, worstStatus, type StatusLike } from "@/components/instrument";
import { humanDuration } from "@/lib/utils/formatting";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

type Payload = { conditions: Condition[]; customised: boolean; states: Array<ConditionState | null>; metrics: Array<{ id: string; label: string; unit: string }> };

type RuleState = {
  kind: "disabled" | "unreported" | "stale" | "firing" | "pending" | "ok";
  status: StatusLike;
  label: string;
  /** Seconds left before a pending rule fires. */
  left?: number;
};

function stateOf(c: Condition, s: ConditionState | null, now: number): RuleState {
  if (!c.enabled) return { kind: "disabled", status: "UNKNOWN", label: "DISABLED" };
  if (!s || s.lastSeen === null) return { kind: "unreported", status: "UNKNOWN", label: "NOT REPORTED" };
  if (now - s.lastSeen > 30_000) return { kind: "stale", status: "UNKNOWN", label: "NO DATA" };
  if (s.firingSince !== null) return { kind: "firing", status: c.severity, label: c.severity };
  if (s.breachingSince !== null) {
    const left = Math.max(0, c.forSeconds - Math.round((now - s.breachingSince) / 1000));
    return { kind: "pending", status: "SERIOUS", label: "PENDING", left };
  }
  return { kind: "ok", status: "HEALTHY", label: "OK" };
}

const unitText = (unit: string | undefined) => (unit ?? "").trim();
const withUnit = (n: number | string, unit: string | undefined) => (unitText(unit) ? `${n} ${unitText(unit)}` : `${n}`);
const duration = (seconds: number) => (seconds >= 60 ? `${seconds / 60} min` : `${seconds} s`);
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/* Form controls: label above, recessed well, 40px tall. */
const FIELD = "h-10 w-full min-w-0 rounded-[3px] border border-seam-strong bg-well px-3 text-[15px] text-silk placeholder:text-graphite";

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`}>
      <span className="text-[13px] font-semibold text-silk-dim">{label}</span>
      {children}
    </label>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-2 text-sm text-silk">
      <Lamp status="CRITICAL" className="mt-[5px]" />
      <span><span className="font-semibold">Error:</span> {children}</span>
    </p>
  );
}

export default function AlertRulesPage() {
  const { data, error, mutate } = useSWR<Payload>("/api/conditions", fetcher, { refreshInterval: 2000, keepPreviousData: true });
  const { data: session } = useSWR<{ authenticated: boolean }>("/api/admin/session", fetcher);
  const [draft, setDraft] = useState<Condition[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const now = Date.now();
  const metricOf = (id: string) => data?.metrics.find(m => m.id === id);

  const save = async (body: object) => {
    const response = await fetch("/api/admin/conditions", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) { setMessage({ ok: false, text: result.error }); return; }
    setMessage({ ok: true, text: "reset" in body ? "Default rules restored. They apply from the next sample." : "Changes saved. Rules apply from the next sample." });
    setDraft(null);
    await mutate();
  };

  const edit = (i: number, patch: Partial<Condition>) => setDraft(d => d!.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const rows = draft ?? data?.conditions ?? [];

  // The server names the failing rule as "Condition N: ..."; show that error under the rule too.
  const failed = message && !message.ok ? /^Condition (\d+):\s*(.*)$/.exec(message.text ?? "") : null;
  const failedIndex = failed ? Number(failed[1]) - 1 : -1;

  const states = !draft && data ? data.conditions.map((c, i) => stateOf(c, data.states[i] ?? null, now)) : [];
  const count = (k: RuleState["kind"]) => states.filter(s => s.kind === k).length;
  const verdict = !draft && data && data.conditions.length
    ? count("firing") ? worstStatus(states.filter(s => s.kind === "firing").map(s => s.status)) : states.some(s => s.kind === "ok" || s.kind === "pending") ? "HEALTHY" : "UNKNOWN"
    : undefined;

  const actions = (
    <>
      {session?.authenticated && !draft && (
        <>
          <Button type="button" onClick={() => setDraft(data?.conditions ?? [])} disabled={!data}>Edit rules</Button>
          {data?.customised && <Button type="button" variant="destructive" onClick={() => { if (confirm("Replace all rules with the defaults?")) void save({ reset: true }); }}>Reset to defaults</Button>}
        </>
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        group="Operations"
        title="Alert rules"
        description="Which threshold rules are firing on the one-second live stream right now, and how close the rest are."
        status={verdict}
        meta={<>/api/conditions · polled every 2 s · {data ? (data.customised ? "custom rules" : "default rules") : "waiting for first response"}</>}
        actions={actions}
      />

      {!session?.authenticated && (
        <p className="m-0 text-[15px] text-silk-dim">
          Rules are read-only here. <Link href="/admin" className="text-trace underline">Sign in on the Admin page</Link> to change them.
        </p>
      )}

      {error && (
        <ErrorState title="The alert rules didn't load" detail={error}>
          The request to <span className="font-mono">/api/conditions</span> failed. It retries every 2 seconds; check <span className="font-mono">/diagnostics</span> if it keeps failing.
        </ErrorState>
      )}

      {message && !draft && (
        <p role="status" className="m-0 flex items-start gap-2 text-[15px] text-silk">
          <Lamp status={message.ok ? "HEALTHY" : "CRITICAL"} className="mt-[6px]" />
          <span>{message.ok ? message.text : <>Couldn&apos;t save the rules: {message.text}</>}</span>
        </p>
      )}

      {!data && !error && <Acquiring rows={4} />}

      {data && !draft && rows.length > 0 && (
        <Well className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Metric label="Firing" value={count("firing")} />
          <Metric label="Pending" value={count("pending")} hint="Breaching, not yet for the full duration" />
          <Metric label="OK" value={count("ok")} />
          <Metric label="No data or disabled" value={count("unreported") + count("stale") + count("disabled")} />
        </Well>
      )}

      {data && !draft && (
        <Section title="Rules" count={rows.length} note="A rule fires when its condition holds for the whole duration, and clears after 30 s back inside the threshold. Firing rules appear on the wall, in incidents and in alert email.">
          {rows.length === 0 ? (
            <EmptyState title="No alert rules" action={session?.authenticated ? <Button type="button" onClick={() => setDraft([])}>Edit rules</Button> : undefined}>
              {session?.authenticated
                ? "Nothing is being watched on the live stream. Add a rule with Edit rules, or reset to the defaults."
                : "Nothing is being watched on the live stream. Sign in on the Admin page to add rules."}
            </EmptyState>
          ) : (
            <div className="flex flex-col border-b border-seam">
              <div className="hidden gap-x-5 px-1 pb-2 md:grid md:grid-cols-[128px_minmax(0,1fr)_minmax(140px,190px)_minmax(170px,230px)]">
                <span className="panel-label">State</span>
                <span className="panel-label">Rule and condition</span>
                <span className="panel-label">Now</span>
                <span className="panel-label">Firing since</span>
              </div>
              {rows.map((c, i) => {
                const m = metricOf(c.metric);
                const s = data.states[i] ?? null;
                const st = states[i] ?? stateOf(c, s, now);
                const live = st.kind === "firing" || st.kind === "pending" || st.kind === "ok";
                return (
                  <div key={c.id} className="grid grid-cols-1 items-center gap-x-5 gap-y-2.5 border-t border-seam px-1 py-3.5 md:grid-cols-[128px_minmax(0,1fr)_minmax(140px,190px)_minmax(170px,230px)]">
                    <div><Stamp status={st.status} label={st.label} /></div>
                    <div className="min-w-0">
                      <p className="m-0 text-base font-semibold">{c.name}</p>
                      <p className="m-0 mt-1 break-words font-mono text-sm text-silk" title={m?.label}>
                        {c.metric} {c.operator} {withUnit(c.threshold, m?.unit)} for {duration(c.forSeconds)}
                      </p>
                      <p className="m-0 mt-0.5 text-[13px] text-silk-dim">
                        {m?.label ?? "Unknown metric"}, {c.operator === ">" ? "above" : "below"} the threshold · raises {c.severity.toLowerCase()}
                      </p>
                    </div>
                    <div className="min-w-0">
                      {live ? (
                        <>
                          <Readout value={s?.value === null || s?.value === undefined ? null : s.value.toFixed(1)} unit={unitText(m?.unit) || undefined} />
                          {s?.device && s.value !== null && <Source className="mt-1 block">{s.device}</Source>}
                        </>
                      ) : st.kind === "disabled" ? (
                        <Readout value={null} state="DISABLED" note="Not evaluated" size="sm" />
                      ) : st.kind === "stale" ? (
                        <Readout value={null} state="STALE" note="No sample for 30 s" size="sm" />
                      ) : (
                        <Readout value={null} state="NO_DATA" note="Not reported on this host" size="sm" />
                      )}
                    </div>
                    <div className="min-w-0 text-sm">
                      {st.kind === "firing" && s?.firingSince != null ? (
                        <>
                          <span className="font-mono text-silk">{clock(s.firingSince)}</span>
                          <span className="block text-[13px] text-silk-dim">for {humanDuration((now - s.firingSince) / 1000)}{s.clearSince != null ? " · back inside, clearing" : ""}</span>
                        </>
                      ) : st.kind === "pending" && s?.breachingSince != null ? (
                        <>
                          <span className="font-mono text-silk">fires in {st.left} s</span>
                          <span className="block text-[13px] text-silk-dim">breaching since {clock(s.breachingSince)}</span>
                        </>
                      ) : (
                        <span className="text-silk-dim">{live ? "Not firing" : "Not evaluated"}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {draft && (
        <Section title="Editing rules" count={draft.length} note="Changes apply from the next sample after you save.">
          {draft.length === 0 && (
            <EmptyState title="No rules in this draft">Add a rule, or cancel to keep the current rules.</EmptyState>
          )}
          {draft.map((c, i) => {
            const m = metricOf(c.metric);
            return (
              <Panel
                key={c.id}
                title={`Condition ${i + 1}`}
                action={<Button type="button" variant="outline" onClick={() => setDraft(d => d!.filter((_, j) => j !== i))}>Delete rule</Button>}
              >
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
                  <Field label="Rule name" className="sm:col-span-2 lg:col-span-3">
                    <input value={c.name} onChange={e => edit(i, { name: e.target.value })} className={FIELD} />
                  </Field>
                  <Field label="Metric" className="sm:col-span-2 lg:col-span-3">
                    <select value={c.metric} onChange={e => edit(i, { metric: e.target.value })} className={FIELD}>
                      {data?.metrics.map(mm => <option key={mm.id} value={mm.id}>{mm.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Fires when the value is" className="lg:col-span-2">
                    <select value={c.operator} onChange={e => edit(i, { operator: e.target.value as ">" | "<" })} className={FIELD}>
                      <option value=">">above</option>
                      <option value="<">below</option>
                    </select>
                  </Field>
                  <Field label={unitText(m?.unit) ? `Threshold (${unitText(m?.unit)})` : "Threshold"}>
                    <input type="number" step="any" value={c.threshold} onChange={e => edit(i, { threshold: Number(e.target.value) })} className={`${FIELD} font-mono`} />
                  </Field>
                  <Field label="For (seconds)">
                    <input type="number" min={0} value={c.forSeconds} onChange={e => edit(i, { forSeconds: Number(e.target.value) })} className={`${FIELD} font-mono`} />
                  </Field>
                  <Field label="Severity">
                    <select value={c.severity} onChange={e => edit(i, { severity: e.target.value as Condition["severity"] })} className={FIELD}>
                      <option>WARNING</option>
                      <option>CRITICAL</option>
                    </select>
                  </Field>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-semibold text-silk-dim" aria-hidden>State</span>
                    <label className="flex h-10 items-center gap-2.5 text-[15px] text-silk">
                      <input type="checkbox" checked={c.enabled} onChange={e => edit(i, { enabled: e.target.checked })} className="size-[18px] accent-[var(--silk)]" />
                      Enabled
                    </label>
                  </div>
                </div>
                <p className="m-0 font-mono text-[13px] text-silk-dim">
                  {c.metric} {c.operator} {withUnit(c.threshold, m?.unit)} for {duration(c.forSeconds)}
                </p>
                {failedIndex === i && failed && <FieldError>{failed[2]}</FieldError>}
              </Panel>
            );
          })}

          <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-3 border-t border-seam bg-enamel px-1 py-4">
            {message && !message.ok && (
              <div role="alert">
                <FieldError>Couldn&apos;t save the rules: {message.text}{failed ? " Fix that rule above, then save again." : ""}</FieldError>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => void save({ conditions: draft })}>Save changes</Button>
              <Button type="button" variant="outline" onClick={() => setDraft(d => [...d!, { id: `rule-${Date.now().toString(36)}`, name: "New rule", metric: "cpu.total", operator: ">", threshold: 80, forSeconds: 300, severity: "WARNING", enabled: true }])}>Add rule</Button>
              <Button type="button" variant="ghost" onClick={() => { setDraft(null); setMessage(null); }}>Cancel</Button>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
