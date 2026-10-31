"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { ServiceInventory, ServiceRow } from "@/lib/services";
import { Acquiring, Code, EmptyState, ErrorState, Lamp, Metric, PageHeader, Panel, Section, Segmented, Void, statusColor } from "@/components/instrument";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { humanAge, humanBytes } from "@/lib/utils/formatting";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

/** systemd's active state, as the lamp beside the word. */
const stateStatus = (s: ServiceRow) =>
  s.active === "failed" ? "CRITICAL" : s.active === "active" ? "HEALTHY" : s.active === "activating" || s.active === "reloading" ? "WARNING" : "UNKNOWN";

const when = (ts: number | null, none: string) => {
  if (!ts) return <span className="text-graphite">{none}</span>;
  const delta = ts - Date.now() / 1000;
  if (delta > 0) return `in ${delta < 3600 ? `${Math.round(delta / 60)} min` : delta < 86400 ? `${(delta / 3600).toFixed(1)} h` : `${(delta / 86400).toFixed(1)} d`}`;
  return humanAge(ts);
};

/** A value a running unit should have but systemd didn't report. */
function CellVoid({ why }: { why: string }) {
  return (
    <span title={why} className="inline-flex align-middle">
      <Void compact state="NO_DATA" className="inline-flex min-h-0" />
      <span className="sr-only">{why}</span>
    </span>
  );
}

/** Not running, so the figure doesn't apply. */
const NotApplicable = () => <span className="text-graphite" title="Not running">n/a</span>;

const headClass = "sticky top-0 z-10 bg-well px-3 shadow-[inset_0_-1px_0_var(--seam)]";
const rowClass = "border-0 [&>td]:border-b [&>td]:border-seam/70";

const FILTERS = [
  { value: "running" as const, label: "Active" },
  { value: "failed" as const, label: "Failed" },
  { value: "all" as const, label: "All loaded" },
];
const SORTS = [
  { value: "memory" as const, label: "Memory" },
  { value: "cpu" as const, label: "CPU" },
  { value: "name" as const, label: "Name" },
];

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
  const timers = useMemo(() => (data?.timers ?? []).slice().sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity)), [data]);
  const journal = (data?.errors ?? []).filter(e => !query || e.unit.includes(query));
  const firstRead = services.length > 0 && services.every(s => s.cpuPercent === null);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        group="Live"
        title="Services"
        description="What systemd is running, what has failed, what's scheduled, and which units logged errors today."
        meta="systemctl and journalctl · every 10 s"
      />

      {error && (
        <ErrorState title="The systemd state didn't refresh" detail={error}>
          The dashboard asks <span className="font-mono">systemctl</span> and <span className="font-mono">journalctl</span> through <span className="font-mono">/api/services</span>.
          {data ? " The tables below show the last good read." : " Check that the dashboard can reach the system bus."}
        </ErrorState>
      )}

      {!data && !error ? (
        <Acquiring rows={4} />
      ) : data ? (
        <>
          <div className="well grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-4">
            <Metric label="Running" value={running.toLocaleString()} />
            <Metric
              label="Failed"
              value={failed.length.toLocaleString()}
              color={failed.length > 0 ? statusColor("CRITICAL") : undefined}
              hint={failed.length > 0 ? "Listed below" : undefined}
            />
            <Metric label="Timers" value={data.timers.length.toLocaleString()} />
            <Metric
              label="Journal errors, 24 h"
              value={data.errors ? (data.errors.length >= 500 ? "500+" : data.errors.length.toLocaleString()) : null}
              state={data.errors ? undefined : "UNAVAILABLE"}
            />
          </div>

          {failed.length > 0 && (
            <Panel title={`Failed units · ${failed.length}`} status="CRITICAL">
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {failed.map(s => (
                  <li key={s.unit} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="font-mono text-sm text-silk">{s.unit}</span>
                    <span className="text-sm text-silk-dim">{s.description}</span>
                  </li>
                ))}
              </ul>
              <p className="m-0 text-[13px] leading-normal text-silk-dim">
                Inspect with <Code>systemctl status &lt;unit&gt;</Code> and <Code>journalctl -u &lt;unit&gt; -n 50</Code>.
              </p>
            </Panel>
          )}

          <Section title="Units" count={services.length} note={query ? `matching “${query}”` : undefined}>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex min-w-0 flex-1 basis-56 sm:max-w-72">
                <span className="sr-only">Filter units</span>
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Unit name or description"
                  className="h-10 w-full rounded-[3px] border border-seam-strong bg-well px-3 text-sm text-silk placeholder:text-graphite focus-visible:border-trace"
                />
              </label>
              {query && <Button variant="ghost" onClick={() => setQuery("")}>Clear filter</Button>}
              <Segmented label="Show" options={FILTERS} value={filter} onChange={setFilter} />
              <span className="flex items-center gap-2">
                <span className="text-xs text-graphite">Sort by</span>
                <Segmented label="Sort by" options={SORTS} value={sort} onChange={setSort} />
              </span>
            </div>

            {services.length === 0 ? (
              <EmptyState title={query ? "No units match this filter" : filter === "failed" ? "No failed units" : "No units to show"}>
                {query ? "Try part of the unit name or its description." : filter === "failed" ? "Nothing systemd manages is in the failed state." : "systemd returned no loaded units."}
              </EmptyState>
            ) : (
              <div className="max-h-[70vh] overflow-auto rounded-[3px] border border-seam">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <TableHeader>
                    <TableRow className="border-0 hover:bg-transparent">
                      <TableHead scope="col" className={cn(headClass, "min-w-64")}>Unit</TableHead>
                      <TableHead scope="col" className={headClass}>State</TableHead>
                      <TableHead scope="col" className={cn(headClass, "text-right")}>CPU</TableHead>
                      <TableHead scope="col" className={cn(headClass, "text-right")}>Memory</TableHead>
                      <TableHead scope="col" className={cn(headClass, "text-right")}>Tasks</TableHead>
                      <TableHead scope="col" className={cn(headClass, "text-right")}>Restarts</TableHead>
                      <TableHead scope="col" className={headClass}>Since</TableHead>
                      <TableHead scope="col" className={headClass}>Boot</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {services.map(s => {
                      const live = s.active === "active";
                      return (
                        <TableRow key={s.unit} className={rowClass}>
                          <TableCell className="max-w-md px-3 py-2 whitespace-normal">
                            <p className="m-0 truncate font-mono text-[13px] text-silk">{s.unit}</p>
                            <p className="m-0 truncate text-xs text-silk-dim">{s.description}</p>
                          </TableCell>
                          <TableCell className="px-3">
                            <span className="inline-flex items-center gap-2 font-mono text-[13px]">
                              <Lamp status={stateStatus(s)} />
                              <span className={s.active === "failed" ? "text-silk" : "text-silk-dim"}>{s.active}</span>
                              <span className="text-graphite">{s.sub}</span>
                            </span>
                          </TableCell>
                          <TableCell className="px-3 text-right font-mono text-[13px] tabular-nums">
                            {s.cpuPercent !== null ? `${s.cpuPercent.toFixed(1)}%` : live ? <CellVoid why="CPU is measured between two refreshes" /> : <NotApplicable />}
                          </TableCell>
                          <TableCell className="px-3 text-right font-mono text-[13px] tabular-nums">
                            {s.memoryBytes !== null ? humanBytes(s.memoryBytes) : live ? <CellVoid why="systemd isn't accounting memory for this unit" /> : <NotApplicable />}
                          </TableCell>
                          <TableCell className="px-3 text-right font-mono text-[13px] tabular-nums">
                            {s.tasks !== null ? s.tasks : live ? <CellVoid why="systemd isn't counting tasks for this unit" /> : <NotApplicable />}
                          </TableCell>
                          <TableCell className="px-3 text-right font-mono text-[13px] tabular-nums">
                            {s.restarts === null
                              ? <span className="text-graphite" title="Not reported">n/a</span>
                              : <span style={s.restarts > 0 ? { color: statusColor("WARNING") } : undefined} title={s.restarts > 0 ? "Restarted by systemd" : undefined}>{s.restarts}</span>}
                          </TableCell>
                          <TableCell className="px-3 text-[13px] text-silk-dim">{live ? humanAge(s.activeSince) : <NotApplicable />}</TableCell>
                          <TableCell className="px-3 font-mono text-[13px] text-graphite">{s.enabled ?? "n/a"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </table>
              </div>
            )}
            {firstRead && (
              <p className="m-0 text-[13px] text-silk-dim">CPU is measured between two refreshes, so it shows NO DATA until the next one, about 10 s from now.</p>
            )}
          </Section>

          <Section title="Timers" count={timers.length} note="soonest first">
            {timers.length === 0 ? (
              <EmptyState title="No timers loaded">systemd reported no timer units.</EmptyState>
            ) : (
              <div className="max-h-[60vh] overflow-auto rounded-[3px] border border-seam">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <TableHeader>
                    <TableRow className="border-0 hover:bg-transparent">
                      <TableHead scope="col" className={headClass}>Timer</TableHead>
                      <TableHead scope="col" className={headClass}>Runs</TableHead>
                      <TableHead scope="col" className={headClass}>Last</TableHead>
                      <TableHead scope="col" className={headClass}>Next</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {timers.map(t => (
                      <TableRow key={t.unit} className={rowClass}>
                        <TableCell className="px-3 font-mono text-[13px] text-silk">{t.unit}</TableCell>
                        <TableCell className="px-3 font-mono text-[13px] text-silk-dim">{t.activates}</TableCell>
                        <TableCell className="px-3 text-[13px]">{when(t.lastRun, "never")}</TableCell>
                        <TableCell className="px-3 text-[13px]">{when(t.nextRun, "not scheduled")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </table>
              </div>
            )}
          </Section>

          <Section
            title="Journal errors, last 24 hours"
            count={data.errors ? data.errors.length : undefined}
            note={data.errors && data.errors.length >= 500 ? "newest 500 shown; there are more" : "priority err and worse"}
          >
            {data.errorsUnavailable && <Void state="UNAVAILABLE" note={data.errorsUnavailable} />}
            {!data.errors ? (
              !data.errorsUnavailable && <Void state="NO_DATA" note="The journal wasn't read on this refresh." />
            ) : data.errors.length === 0 ? (
              <EmptyState title="No errors in the last 24 hours">Nothing was logged at error priority or worse.</EmptyState>
            ) : (
              <>
                {errorsByUnit.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs text-graphite">Errors by unit. Pick one to filter the units table and this log.</span>
                    <div className="flex flex-wrap gap-2">
                      {errorsByUnit.slice(0, 12).map(([unit, n]) => (
                        <button
                          key={unit}
                          type="button"
                          onClick={() => setQuery(unit)}
                          aria-pressed={query === unit}
                          className="inline-flex min-h-10 items-center gap-2 rounded-[3px] border border-seam bg-well px-3 text-[13px] hover:border-seam-strong aria-pressed:border-seam-strong aria-pressed:bg-bezel"
                        >
                          <span className="font-mono text-silk">{unit}</span>
                          <span className="font-mono tabular-nums text-graphite">{n}</span>
                        </button>
                      ))}
                      {query && <Button variant="ghost" onClick={() => setQuery("")}>Show all units</Button>}
                    </div>
                  </div>
                )}
                {journal.length === 0 ? (
                  <EmptyState title="No journal errors for this filter">
                    No error in the last 24 hours came from a unit matching <span className="font-mono">{query}</span>.
                  </EmptyState>
                ) : (
                  <ul className="well m-0 flex max-h-[32rem] list-none flex-col overflow-y-auto px-0 py-1 font-mono text-xs">
                    {journal.slice(0, 200).map((e, i) => (
                      <li key={i} className="grid grid-cols-1 gap-x-3 gap-y-0.5 border-b border-seam/60 px-3.5 py-2 last:border-0 sm:grid-cols-[7.5rem_12rem_minmax(0,1fr)]">
                        <span className="tabular-nums text-graphite">{new Date(e.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                        <span className="truncate text-silk-dim" title={e.unit}>{e.unit}</span>
                        <span className="break-words text-silk">{e.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {journal.length > 200 && <p className="m-0 text-xs text-graphite">Showing the newest 200 of {journal.length} matching errors.</p>}
              </>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}
