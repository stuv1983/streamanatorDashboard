"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { AuditRecord } from "@/lib/audit";
import type { EventRecord } from "@/lib/history";
import { Acquiring, EmptyState, ErrorState, PageHeader, Section, Segmented, Stamp, normaliseStatus } from "@/components/instrument";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

const PERIODS: Array<{ value: string; label: string; phrase: string }> = [
  { value: "1", label: "24 h", phrase: "in the last 24 hours" },
  { value: "7", label: "7 days", phrase: "in the last 7 days" },
  { value: "30", label: "30 days", phrase: "in the last 30 days" },
  { value: "90", label: "90 days", phrase: "in the last 90 days" },
  { value: "365", label: "1 year", phrase: "in the last year" },
];

/** Why an inventory change was flagged, mirroring changeStatus() in lib/inventory.ts. */
function warningExplanation(category: string): string {
  if (category === "inventory.users") return "A login account was added or changed. Confirm you made this change.";
  if (category === "inventory.files") return "A security-sensitive file changed (sudoers, SSH or password files). Confirm you made this change.";
  if (category === "inventory.listeners") return "A new port is listening on every network interface. Check it is meant to be reachable.";
  return "This change widens access to the host. Confirm it was intended.";
}

const AUDIT_OUTCOME: Record<string, string> = { success: "HEALTHY", refused: "WARNING", failed: "CRITICAL" };

/* Form controls: label above, recessed well, 40px tall. */
const FIELD = "h-10 w-full min-w-0 rounded-[3px] border border-seam-strong bg-well px-3 text-[15px] text-silk";

function Detail({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length === 1 && text.length <= 160) {
    return <p className="m-0 mt-1 break-words font-mono text-[13px] text-silk-dim">{text}</p>;
  }
  return (
    <details className="group mt-1">
      <summary className="flex min-h-10 cursor-pointer list-none items-center text-[13px] font-semibold text-trace">
        <span className="group-open:hidden">Show details · {lines.length} {lines.length === 1 ? "line" : "lines"}</span>
        <span className="hidden group-open:inline">Hide details</span>
      </summary>
      <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[3px] border border-seam bg-well p-3 font-mono text-[13px] leading-relaxed text-silk-dim">{text}</pre>
    </details>
  );
}

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

  const period = PERIODS.find(p => Number(p.value) === days) ?? PERIODS[1];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        group="Operations"
        title="Events and changes"
        description="What changed on this host, newest first: packages, units, ports, containers, container image updates and WAN address changes."
        meta={<>/api/events · {period.phrase.replace(/^in the /, "")} · refreshed every minute</>}
      >
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-silk-dim">Period</span>
            <Segmented label="Period" options={PERIODS.map(p => ({ value: p.value, label: p.label }))} value={String(days)} onChange={v => setDays(Number(v))} />
          </div>
          <label className="flex w-full flex-col gap-1.5 sm:w-60">
            <span className="text-[13px] font-semibold text-silk-dim">Category</span>
            <select value={category} onChange={e => setCategory(e.target.value)} className={FIELD}>
              <option value="all">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
      </PageHeader>

      {error && (
        <ErrorState title="Events didn't load" detail={error}>
          The request to <span className="font-mono">/api/events</span> failed. It retries every minute; check <span className="font-mono">/diagnostics</span> if the history store is unavailable.
        </ErrorState>
      )}

      {!data && !error && <Acquiring rows={4} />}

      {data && (
        <Section title="Timeline" count={events.length}>
          {events.length === 0 ? (
            <EmptyState title={category === "all" ? "No events in this period" : `No ${category} events in this period`}>
              {category === "all"
                ? `Nothing changed on the host ${period.phrase}. Choose a longer period to look further back.`
                : `Nothing in ${category} changed ${period.phrase}. Choose All categories or a longer period.`}
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-6">
              {byDay.map(([day, list]) => (
                <section key={day} aria-label={day} className="flex flex-col">
                  <div className="flex items-center gap-3 pb-2">
                    <h3 className="panel-label m-0 whitespace-nowrap text-silk-dim">{day} · {list.length}</h3>
                    <span className="h-px flex-1 bg-seam" aria-hidden />
                  </div>
                  <ol className="m-0 flex list-none flex-col p-0">
                    {list.map((e, i) => {
                      const status = normaliseStatus(e.status);
                      const flagged = status !== "INFO" && status !== "HEALTHY";
                      return (
                        <li key={i} className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-seam py-3 sm:grid-cols-[60px_170px_minmax(0,1fr)]">
                          <time dateTime={new Date(e.timestamp * 1000).toISOString()} className="pt-px font-mono text-[13px] tabular-nums text-graphite">
                            {new Date(e.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </time>
                          <span className="panel-label break-words pt-[3px] text-[9.5px]">{e.category.replace(/\./g, " · ")}</span>
                          <div className="col-start-2 min-w-0 sm:col-start-auto">
                            {flagged && (
                              <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                                <Stamp status={status} />
                                {status === "WARNING" && e.category.startsWith("inventory.") && (
                                  <span className="text-[13px] text-silk-dim">{warningExplanation(e.category)}</span>
                                )}
                              </div>
                            )}
                            <p className="m-0 break-words text-[15px] leading-normal text-silk">{e.summary}</p>
                            {e.detail && <Detail text={e.detail} />}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </Section>
      )}

      {data?.audit ? (
        <Section title="Admin audit log" count={data.audit.length} note="Up to the 300 most recent privileged actions.">
          {data.audit.length === 0 ? (
            <EmptyState title="No privileged actions recorded">Sign-ins, settings saves and alert rule edits are recorded here as they happen.</EmptyState>
          ) : (
            <div className="max-h-[28rem] overflow-auto rounded-[3px] border border-seam">
              <Table>
                <TableHeader className="sticky top-0 bg-well">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-3">When</TableHead>
                    <TableHead className="px-3">Outcome</TableHead>
                    <TableHead className="px-3">Action</TableHead>
                    <TableHead className="px-3">Target</TableHead>
                    <TableHead className="px-3">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.audit.map((a, i) => (
                    <TableRow key={i}>
                      <TableCell className="px-3 font-mono text-[13px] tabular-nums text-graphite">{new Date(a.at * 1000).toLocaleString()}</TableCell>
                      <TableCell className="px-3"><Stamp status={AUDIT_OUTCOME[a.outcome] ?? "UNKNOWN"} label={a.outcome.toUpperCase()} /></TableCell>
                      <TableCell className="px-3 font-mono text-[13px] text-silk">{a.action}</TableCell>
                      <TableCell className="px-3 font-mono text-[13px] text-silk-dim">{a.target}</TableCell>
                      <TableCell className="min-w-[16rem] whitespace-normal px-3 font-mono text-[13px] text-silk-dim">{a.detail || <span className="text-graphite">None recorded</span>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>
      ) : data ? (
        <Section title="Admin audit log">
          <p className="m-0 text-[15px] text-silk-dim">
            The audit log names who did what, so it stays behind the admin session. <Link href="/admin" className="text-trace underline">Sign in on the Admin page</Link> to see it.
          </p>
        </Section>
      ) : null}
    </div>
  );
}
