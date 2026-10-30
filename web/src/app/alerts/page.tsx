"use client";

import { useState } from "react";
import useSWR from "swr";
import type { Condition, ConditionState } from "@/lib/conditions";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

type Payload = { conditions: Condition[]; customised: boolean; states: Array<ConditionState | null>; metrics: Array<{ id: string; label: string; unit: string }> };

function stateOf(c: Condition, s: ConditionState | null, now: number): { label: string; color: string } {
  if (!c.enabled) return { label: "Disabled", color: "var(--chart-muted)" };
  if (!s || s.lastSeen === null) return { label: "Not reported here", color: "var(--chart-muted)" };
  if (now - s.lastSeen > 30_000) return { label: "No data", color: "var(--chart-muted)" };
  if (s.firingSince !== null) return { label: c.severity === "CRITICAL" ? "FIRING · critical" : "FIRING · warning", color: c.severity === "CRITICAL" ? "var(--status-critical)" : "var(--status-warning)" };
  if (s.breachingSince !== null) {
    const left = Math.max(0, c.forSeconds - Math.round((now - s.breachingSince) / 1000));
    return { label: `Pending · fires in ${left}s`, color: "var(--status-serious)" };
  }
  return { label: "OK", color: "var(--status-good)" };
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
    setMessage({ ok: true, text: "Saved. Rules apply from the next sample." });
    setDraft(null);
    await mutate();
  };

  const edit = (i: number, patch: Partial<Condition>) => setDraft(d => d!.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const rows = draft ?? data?.conditions ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Alert rules</h1>
          <p className="mt-1 max-w-3xl text-muted-foreground">
            Threshold rules checked against the one-second live stream. A rule fires only when the condition holds for its whole duration, and clears after 30 seconds back inside the threshold. Firing rules appear on the wall, in incidents and in alert email.
          </p>
        </div>
        {session?.authenticated && !draft && (
          <div className="flex gap-2">
            <button type="button" onClick={() => setDraft(data?.conditions ?? [])} className="h-9 rounded-md border px-3 text-sm hover:bg-accent">Edit rules</button>
            {data?.customised && <button type="button" onClick={() => { if (confirm("Replace all rules with the defaults?")) void save({ reset: true }); }} className="h-9 rounded-md border px-3 text-sm hover:bg-accent">Reset to defaults</button>}
          </div>
        )}
        {draft && (
          <div className="flex gap-2">
            <button type="button" onClick={() => setDraft(d => [...d!, { id: `rule-${Date.now().toString(36)}`, name: "New rule", metric: "cpu.total", operator: ">", threshold: 80, forSeconds: 300, severity: "WARNING", enabled: true }])} className="h-9 rounded-md border px-3 text-sm hover:bg-accent">Add rule</button>
            <button type="button" onClick={() => void save({ conditions: draft })} className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground">Save</button>
            <button type="button" onClick={() => { setDraft(null); setMessage(null); }} className="h-9 rounded-md border px-3 text-sm">Cancel</button>
          </div>
        )}
      </div>
      {!session?.authenticated && <p className="text-xs text-muted-foreground">Sign in on the Admin page to change rules.</p>}
      {error && <p className="text-sm text-[var(--status-critical)]">{String(error.message ?? error)}</p>}
      {message && <p role="status" className={`text-sm ${message.ok ? "text-[var(--status-good)]" : "text-[var(--status-critical)]"}`}>{message.text}</p>}

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-card text-left text-xs text-muted-foreground"><tr className="border-b">
            <th className="px-3 py-2 font-medium">Rule</th><th className="px-3 py-2 font-medium">Condition</th><th className="px-3 py-2 font-medium">Severity</th>
            <th className="px-3 py-2 text-right font-medium">Now</th><th className="px-3 py-2 font-medium">State</th>{draft && <th className="px-3 py-2" />}
          </tr></thead>
          <tbody>
            {rows.map((c, i) => {
              const m = metricOf(c.metric);
              const s = draft ? null : data?.states[i] ?? null;
              const st = stateOf(c, s, now);
              return draft ? (
                <tr key={c.id} className="border-b border-border/40 align-top">
                  <td className="px-3 py-2"><input value={c.name} onChange={e => edit(i, { name: e.target.value })} aria-label="Rule name" className="h-8 w-full min-w-48 rounded border bg-background px-2" />
                    <label className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={c.enabled} onChange={e => edit(i, { enabled: e.target.checked })} />Enabled</label></td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <select value={c.metric} onChange={e => edit(i, { metric: e.target.value })} aria-label="Metric" className="h-8 rounded border bg-background px-1">{data?.metrics.map(mm => <option key={mm.id} value={mm.id}>{mm.label}</option>)}</select>
                      <select value={c.operator} onChange={e => edit(i, { operator: e.target.value as ">" | "<" })} aria-label="Operator" className="h-8 rounded border bg-background px-1"><option value=">">above</option><option value="<">below</option></select>
                      <input type="number" step="any" value={c.threshold} onChange={e => edit(i, { threshold: Number(e.target.value) })} aria-label="Threshold" className="h-8 w-20 rounded border bg-background px-2" />
                      <span className="text-xs text-muted-foreground">{m?.unit} for</span>
                      <input type="number" min={0} value={c.forSeconds} onChange={e => edit(i, { forSeconds: Number(e.target.value) })} aria-label="Duration in seconds" className="h-8 w-20 rounded border bg-background px-2" />
                      <span className="text-xs text-muted-foreground">s</span>
                    </div>
                  </td>
                  <td className="px-3 py-2"><select value={c.severity} onChange={e => edit(i, { severity: e.target.value as Condition["severity"] })} aria-label="Severity" className="h-8 rounded border bg-background px-1"><option>WARNING</option><option>CRITICAL</option></select></td>
                  <td /><td />
                  <td className="px-3 py-2"><button type="button" onClick={() => setDraft(d => d!.filter((_, j) => j !== i))} className="text-xs text-[var(--status-critical)] hover:underline">Delete</button></td>
                </tr>
              ) : (
                <tr key={c.id} className="border-b border-border/40">
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{m?.label ?? c.metric} {c.operator === ">" ? "above" : "below"} {c.threshold}{m?.unit} for {c.forSeconds >= 60 ? `${c.forSeconds / 60} min` : `${c.forSeconds} s`}</td>
                  <td className="px-3 py-2 text-xs">{c.severity}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{s?.value === null || s?.value === undefined ? "—" : `${s.value.toFixed(1)}${m?.unit ?? ""}`}{s?.device && s.value !== null ? <span className="text-muted-foreground"> · {s.device}</span> : null}</td>
                  <td className="px-3 py-2 text-xs"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: st.color }} />{st.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
