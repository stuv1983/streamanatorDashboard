"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { ServiceInventory, ServiceRow } from "@/lib/services";
import { humanAge, humanBytes } from "@/lib/utils/formatting";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

const stateColor = (s: ServiceRow) =>
  s.active === "failed" ? "var(--status-critical)" : s.active === "active" ? "var(--status-good)" : s.active === "activating" || s.active === "reloading" ? "var(--status-warning)" : "var(--chart-muted)";

const when = (ts: number | null) => {
  if (!ts) return "—";
  const delta = ts - Date.now() / 1000;
  if (delta > 0) return `in ${delta < 3600 ? `${Math.round(delta / 60)} min` : delta < 86400 ? `${(delta / 3600).toFixed(1)} h` : `${(delta / 86400).toFixed(1)} d`}`;
  return humanAge(ts);
};

export default function ServicesPage() {
  const { data, error } = useSWR<ServiceInventory>("/api/services", fetcher, { refreshInterval: 10_000, keepPreviousData: true });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"running" | "all" | "failed">("running");
  const [sort, setSort] = useState<"memory" | "cpu" | "name">("memory");

  const services = useMemo(() => {
    const q = query.toLowerCase();
    return (data?.services ?? [])
      .filter(s => s.load !== "not-found")
      .filter(s => filter === "all" || (filter === "failed" ? s.active === "failed" : s.active === "active" || s.active === "failed"))
      .filter(s => !q || s.unit.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .sort((a, b) => sort === "name" ? a.unit.localeCompare(b.unit) : sort === "cpu" ? (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) : (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1));
  }, [data, query, filter, sort]);

  const failed = (data?.services ?? []).filter(s => s.active === "failed");
  const running = (data?.services ?? []).filter(s => s.sub === "running").length;
  const errorsByUnit = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data?.errors ?? []) m.set(e.unit, (m.get(e.unit) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Services</h1>
        <p className="mt-1 text-muted-foreground">
          {data ? `${running} running · ${failed.length} failed · ${data.timers.length} timers · ${data.errors ? (data.errors.length >= 500 ? "500+" : data.errors.length) : "?"} journal errors in 24 h` : "Loading systemd state…"}
        </p>
      </div>
      {error && <p className="text-sm text-[var(--status-critical)]">{String(error.message ?? error)}</p>}

      {failed.length > 0 && (
        <section className="rounded-xl border border-[var(--status-critical)]/50 p-4">
          <h2 className="mb-2 font-semibold text-[var(--status-critical)]">Failed units</h2>
          <ul className="space-y-1 text-sm">{failed.map(s => <li key={s.unit}><span className="font-mono">{s.unit}</span> <span className="text-muted-foreground">— {s.description}</span></li>)}</ul>
          <p className="mt-2 text-xs text-muted-foreground">Inspect with <code>systemctl status &lt;unit&gt;</code> and <code>journalctl -u &lt;unit&gt; -n 50</code>.</p>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-semibold">Units</h2>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter units…" aria-label="Filter units" className="h-9 w-56 rounded-md border bg-background px-3 text-sm" />
          <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)} aria-label="Show" className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="running">Active</option><option value="failed">Failed</option><option value="all">All loaded</option>
          </select>
          <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} aria-label="Sort by" className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="memory">Memory</option><option value="cpu">CPU</option><option value="name">Name</option>
          </select>
        </div>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-card text-left text-xs text-muted-foreground"><tr className="border-b">
              <th className="px-3 py-2 font-medium">Unit</th><th className="px-3 py-2 font-medium">State</th><th className="px-3 py-2 text-right font-medium">CPU</th>
              <th className="px-3 py-2 text-right font-medium">Memory</th><th className="px-3 py-2 text-right font-medium">Tasks</th><th className="px-3 py-2 text-right font-medium">Restarts</th>
              <th className="px-3 py-2 font-medium">Since</th><th className="px-3 py-2 font-medium">Boot</th>
            </tr></thead>
            <tbody>
              {services.map(s => (
                <tr key={s.unit} className="border-b border-border/40">
                  <td className="max-w-md px-3 py-1.5"><p className="truncate font-mono text-xs">{s.unit}</p><p className="truncate text-xs text-muted-foreground">{s.description}</p></td>
                  <td className="px-3 text-xs"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: stateColor(s) }} />{s.active} ({s.sub})</td>
                  <td className="px-3 text-right font-mono text-xs tabular-nums">{s.cpuPercent === null ? "—" : `${s.cpuPercent.toFixed(1)}%`}</td>
                  <td className="px-3 text-right font-mono text-xs tabular-nums">{humanBytes(s.memoryBytes)}</td>
                  <td className="px-3 text-right font-mono text-xs tabular-nums">{s.tasks ?? "—"}</td>
                  <td className="px-3 text-right font-mono text-xs tabular-nums">{s.restarts ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 text-xs text-muted-foreground">{s.active === "active" ? humanAge(s.activeSince) : "—"}</td>
                  <td className="px-3 text-xs text-muted-foreground">{s.enabled ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">CPU is measured between refreshes, so it reads “—” on the first load.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Timers</h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-card text-left text-xs text-muted-foreground"><tr className="border-b"><th className="px-3 py-2 font-medium">Timer</th><th className="px-3 py-2 font-medium">Runs</th><th className="px-3 py-2 font-medium">Last</th><th className="px-3 py-2 font-medium">Next</th></tr></thead>
            <tbody>{(data?.timers ?? []).sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity)).map(t => (
              <tr key={t.unit} className="border-b border-border/40"><td className="px-3 py-1.5 font-mono text-xs">{t.unit}</td><td className="px-3 font-mono text-xs text-muted-foreground">{t.activates}</td><td className="px-3 text-xs">{when(t.lastRun)}</td><td className="px-3 text-xs">{when(t.nextRun)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Journal errors, last 24 hours</h2>
        {data?.errorsUnavailable && <p className="text-sm text-muted-foreground">{data.errorsUnavailable}</p>}
        {errorsByUnit.length > 0 && (
          <div className="flex flex-wrap gap-2">{errorsByUnit.slice(0, 12).map(([unit, n]) => (
            <button key={unit} type="button" onClick={() => setQuery(unit)} className="rounded-md border px-2 py-1 text-xs hover:bg-accent"><span className="font-mono">{unit}</span> · {n}</button>
          ))}</div>
        )}
        {data?.errors && data.errors.length === 0 && <p className="text-sm text-muted-foreground">No error-priority messages in the last 24 hours.</p>}
        <ul className="max-h-[32rem] space-y-1 overflow-y-auto rounded-xl border p-3 font-mono text-xs">
          {(data?.errors ?? []).filter(e => !query || e.unit.includes(query)).slice(0, 200).map((e, i) => (
            <li key={i} className="grid grid-cols-[7rem_12rem_1fr] gap-2"><span className="text-muted-foreground">{new Date(e.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><span className="truncate">{e.unit}</span><span className="break-words">{e.message}</span></li>
          ))}
        </ul>
        {data?.errors && data.errors.length >= 500 && <p className="text-xs text-muted-foreground">Showing the newest 500 errors; there are more.</p>}
      </section>
    </div>
  );
}
