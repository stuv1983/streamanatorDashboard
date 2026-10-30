"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { AuditRecord } from "@/lib/audit";
import type { EventRecord } from "@/lib/history";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

const STATUS_COLOR: Record<string, string> = {
  CRITICAL: "var(--status-critical)", WARNING: "var(--status-warning)", HEALTHY: "var(--status-good)", INFO: "var(--series-1)", UNKNOWN: "var(--chart-muted)",
};

export default function EventsPage() {
  const [days, setDays] = useState(7);
  const { data, error } = useSWR<{ events: EventRecord[]; audit: AuditRecord[] | null }>(`/api/events?days=${days}`, fetcher, { refreshInterval: 60_000, keepPreviousData: true });
  const [category, setCategory] = useState("all");

  const categories = useMemo(() => [...new Set((data?.events ?? []).map(e => e.category.split(".")[0]))].sort(), [data]);
  const events = (data?.events ?? []).filter(e => category === "all" || e.category === category || e.category.startsWith(`${category}.`));
  const byDay = useMemo(() => {
    const m = new Map<string, EventRecord[]>();
    for (const e of events) {
      const d = new Date(e.timestamp * 1000).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
      m.set(d, [...(m.get(d) ?? []), e]);
    }
    return [...m];
  }, [events]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Events &amp; changes</h1>
          <p className="mt-1 text-muted-foreground">What changed on this host, newest first: package, unit, port and container changes, container image updates, WAN address changes.</p>
        </div>
        <div className="flex gap-2">
          <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Category" className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="all">All categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Period" className="h-9 rounded-md border bg-background px-2 text-sm">
            {[1, 7, 30, 90, 365].map(d => <option key={d} value={d}>Last {d === 1 ? "24 hours" : `${d} days`}</option>)}
          </select>
        </div>
      </div>
      {error && <p className="text-sm text-[var(--status-critical)]">{String(error.message ?? error)}</p>}
      {data && events.length === 0 && <p className="text-muted-foreground">No events recorded in this period.</p>}

      <div className="space-y-6">
        {byDay.map(([day, list]) => (
          <section key={day}>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{day}</h2>
            <ol className="space-y-2 border-l pl-4">
              {list.map((e, i) => (
                <li key={i} className="relative">
                  <span className="absolute -left-[1.32rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background" style={{ background: STATUS_COLOR[e.status] ?? STATUS_COLOR.INFO }} />
                  <p className="text-sm"><span className="mr-2 font-mono text-xs text-muted-foreground">{new Date(e.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    {e.status !== "INFO" && <span className="mr-1.5 text-xs font-semibold" style={{ color: STATUS_COLOR[e.status] }}>{e.status}</span>}
                    {e.summary}
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{e.category}</span></p>
                  {e.detail && (
                    <details className="mt-1"><summary className="cursor-pointer text-xs text-muted-foreground">Details</summary>
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-xs">{e.detail}</pre></details>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      {data?.audit && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Admin audit log</h2>
          <ul className="max-h-96 space-y-1 overflow-y-auto rounded-xl border p-3 font-mono text-xs">
            {data.audit.map((a, i) => <li key={i}><span className="text-muted-foreground">{new Date(a.at * 1000).toLocaleString()}</span> {a.action} {a.target} → <strong>{a.outcome}</strong>{a.detail ? ` · ${a.detail}` : ""}</li>)}
            {data.audit.length === 0 && <li className="text-muted-foreground">No privileged actions recorded.</li>}
          </ul>
        </section>
      )}
    </div>
  );
}
