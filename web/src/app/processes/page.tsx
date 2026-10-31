"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import type { ProcessDetail, ProcessRow, ProcessTable } from "@/lib/processes";
import { Acquiring, EmptyState, ErrorState, Facts, Lamp, Metric, PageHeader, PanelLabel, Section, Segmented, Stamp, Void, statusColor } from "@/components/instrument";
import { Button } from "@/components/ui/button";
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { humanAge, humanBytes, humanBytesPerSecond } from "@/lib/utils/formatting";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

type SortKey = "cpuPercent" | "rssBytes" | "name" | "pid" | "user" | "threads" | "io" | "startedAt";
type View = "list" | "tree" | "group";

const ioOf = (p: ProcessRow) => (p.readBps === null && p.writeBps === null ? null : (p.readBps ?? 0) + (p.writeBps ?? 0));

function sortValue(p: ProcessRow, key: SortKey): number | string {
  switch (key) {
    case "name": return p.name.toLowerCase();
    case "user": return p.user;
    case "io": return ioOf(p) ?? -1;
    default: return (p[key] as number | null) ?? -1;
  }
}

/** The service a process belongs to: its container, else its systemd unit, else its user. */
function groupOf(p: ProcessRow): string {
  if (p.kernelThread) return "Kernel threads";
  if (p.container) return `container: ${p.container.name ?? p.container.id.slice(0, 12)}`;
  if (p.unit) return p.unit;
  return `user: ${p.user}`;
}

const STATE_LABEL: Record<string, string> = { R: "Running", S: "Sleeping", D: "Disk wait", Z: "Zombie", T: "Stopped", t: "Traced", I: "Idle", X: "Dead" };

const VIEWS: Array<{ value: View; label: string }> = [
  { value: "list", label: "List" },
  { value: "tree", label: "Tree" },
  { value: "group", label: "By service" },
];

/** What the kernel won't show an unprivileged reader. Not zero, not a dash. */
function Hidden({ why = "Owned by another account. The kernel only shows this to the owner or root." }: { why?: string }) {
  return (
    <span title={why} className="inline-flex align-middle">
      <Void compact state="HIDDEN" className="inline-flex min-h-0" />
      <span className="sr-only">{why}</span>
    </span>
  );
}

/** A dense-table stand-in for a reading that should exist but has no value yet. */
function CellVoid({ state = "NO_DATA", why }: { state?: string; why?: string }) {
  return (
    <span title={why} className="inline-flex align-middle">
      <Void compact state={state} className="inline-flex min-h-0" />
      {why && <span className="sr-only">{why}</span>}
    </span>
  );
}

const inputClass = "h-10 rounded-[3px] border border-seam-strong bg-well px-3 text-sm text-silk placeholder:text-graphite focus-visible:border-trace";

export default function ProcessesPage() {
  const [paused, setPaused] = useState(false);
  const { data, error } = useSWR<ProcessTable>("/api/processes", fetcher, { refreshInterval: paused ? 0 : 2000, keepPreviousData: true });
  const { data: session } = useSWR<{ authenticated: boolean; actionsEnabled: boolean }>("/api/admin/session", fetcher);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "cpuPercent", desc: true });
  const [view, setView] = useState<View>("list");
  const [showKernel, setShowKernel] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [limit, setLimit] = useState(250);

  const rows = useMemo(() => {
    const all = data?.processes ?? [];
    const q = query.trim().toLowerCase();
    const filtered = all.filter(p => (showKernel || !p.kernelThread) && (!q
      || p.name.toLowerCase().includes(q) || p.command.toLowerCase().includes(q) || String(p.pid) === q
      || p.user.toLowerCase().includes(q) || (p.container?.name ?? "").toLowerCase().includes(q) || (p.unit ?? "").toLowerCase().includes(q)));
    const cmp = (a: ProcessRow, b: ProcessRow) => {
      const va = sortValue(a, sort.key), vb = sortValue(b, sort.key);
      const r = va < vb ? -1 : va > vb ? 1 : a.pid - b.pid;
      return sort.desc ? -r : r;
    };
    return { filtered: filtered.sort(cmp), cmp };
  }, [data, query, showKernel, sort]);

  type Line = { kind: "proc"; p: ProcessRow; depth: number; hasChildren: boolean } | { kind: "group"; name: string; members: ProcessRow[] };
  const lines: Line[] = useMemo(() => {
    const { filtered, cmp } = rows;
    if (view === "list") return filtered.map(p => ({ kind: "proc" as const, p, depth: 0, hasChildren: false }));
    if (view === "group") {
      const groups = new Map<string, ProcessRow[]>();
      for (const p of filtered) groups.set(groupOf(p), [...(groups.get(groupOf(p)) ?? []), p]);
      const total = (ps: ProcessRow[]) => ps.reduce((s, p) => s + (p.cpuPercent ?? 0), 0);
      const out: Line[] = [];
      for (const [name, members] of [...groups].sort((a, b) => total(b[1]) - total(a[1]))) {
        out.push({ kind: "group", name, members });
        if (!collapsed.has(name)) out.push(...members.map(p => ({ kind: "proc" as const, p, depth: 1, hasChildren: false })));
      }
      return out;
    }
    // Tree: roots are processes whose parent is not in the filtered set.
    const pids = new Set(filtered.map(p => p.pid));
    const children = new Map<number, ProcessRow[]>();
    for (const p of filtered) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
    const out: Line[] = [];
    const walk = (p: ProcessRow, depth: number) => {
      const kids = (children.get(p.pid) ?? []).sort(cmp);
      out.push({ kind: "proc", p, depth, hasChildren: kids.length > 0 });
      if (!collapsed.has(String(p.pid))) kids.forEach(k => walk(k, depth + 1));
    };
    filtered.filter(p => !pids.has(p.ppid) || p.ppid === p.pid).forEach(p => walk(p, 0));
    return out;
  }, [rows, view, collapsed]);

  const toggle = (key: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const header = (key: SortKey, label: React.ReactNode, className = "") => (
    <TableHead scope="col" className={cn("sticky top-0 z-10 bg-well px-2.5 shadow-[inset_0_-1px_0_var(--seam)]", className)} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        className={cn("inline-flex min-h-8 items-center gap-1 uppercase hover:text-silk", sort.key === key && "text-silk")}
        onClick={() => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== "name" && key !== "user" }))}
      >
        {label}
        <span aria-hidden className="font-mono text-[11px]">{sort.key === key ? (sort.desc ? "▾" : "▴") : ""}</span>
      </button>
    </TableHead>
  );
  const plainHead = (label: string, className = "") => (
    <TableHead scope="col" className={cn("sticky top-0 z-10 bg-well px-2.5 shadow-[inset_0_-1px_0_var(--seam)]", className)}>{label}</TableHead>
  );

  const totals = data?.totals;
  const totalCpu = rows.filtered.reduce((s, p) => s + (p.cpuPercent ?? 0), 0);
  const totalMem = rows.filtered.reduce((s, p) => s + (p.rssBytes ?? 0), 0);
  const firstRead = data != null && data.intervalSeconds === null;

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        group="Live"
        title="Processes"
        description="Every process on the host, what it belongs to and what it's using right now."
        meta={paused ? "/proc · refresh paused" : "/proc · every 2 s"}
      />

      {error && (
        <ErrorState title="The process table didn't refresh" detail={error}>
          The dashboard reads <span className="font-mono">/proc</span> through <span className="font-mono">/api/processes</span>.
          {data ? " The table below shows the last good read." : ""} If this keeps failing, check the dashboard service&apos;s log.
        </ErrorState>
      )}

      {!data && !error ? (
        <Acquiring rows={4} />
      ) : (
        <>
          {totals && (
            <div className="well grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-5">
              <Metric label="Processes" value={totals.processes.toLocaleString()} />
              <Metric label="Threads" value={totals.threads.toLocaleString()} />
              <Metric label="Running" value={totals.running.toLocaleString()} />
              <Metric
                label="Zombie"
                value={totals.zombie.toLocaleString()}
                color={totals.zombie > 0 ? statusColor("WARNING") : undefined}
                hint={totals.zombie > 0 ? "Exited, not yet reaped by the parent" : undefined}
              />
              <Metric label="Kernel threads" value={totals.kernelThreads.toLocaleString()} hint={showKernel ? "Shown in the table" : "Hidden from the table"} />
            </div>
          )}

          <Section
            title="Process table"
            count={rows.filtered.length}
            note={query ? `matching “${query.trim()}”` : undefined}
          >
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex min-w-0 flex-1 basis-60 sm:max-w-80">
                <span className="sr-only">Filter processes</span>
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, PID, user, container, unit" className={cn(inputClass, "w-full")} />
              </label>
              <Segmented label="View" options={VIEWS} value={view} onChange={setView} />
              <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-[3px] border border-seam px-3 text-[13px] font-semibold text-silk-dim hover:text-silk">
                <input type="checkbox" checked={showKernel} onChange={e => setShowKernel(e.target.checked)} className="size-4 accent-[var(--trace)]" />
                Kernel threads
              </label>
              <Button variant="outline" onClick={() => setPaused(p => !p)} aria-pressed={paused}>
                {paused ? "Resume refresh" : "Pause refresh"}
              </Button>
            </div>

            {totals && totals.unreadableIo > 0 && (
              <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-normal text-silk-dim">
                <Hidden />
                <span>
                  Disk I/O for <span className="font-mono text-silk">{totals.unreadableIo}</span> processes owned by other accounts.
                  The dashboard runs unprivileged and the kernel only shows a process&apos;s I/O counters to its owner or root.
                </span>
              </p>
            )}
            {firstRead && (
              <p className="m-0 text-[13px] text-silk-dim">CPU is measured between two reads, so it shows NO DATA until the next refresh.</p>
            )}

            {rows.filtered.length === 0 ? (
              <EmptyState title={query ? "No processes match this filter" : "No processes to show"}>
                {query ? <>Nothing matches <span className="font-mono">{query.trim()}</span>{showKernel ? "" : " outside kernel threads"}. Try a PID, a user or part of the command line.</> : "The process table came back empty."}
              </EmptyState>
            ) : (
              <div className="max-h-[calc(100vh-14rem)] min-h-64 overflow-auto rounded-[3px] border border-seam">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <TableHeader>
                    <TableRow className="border-0 hover:bg-transparent">
                      {header("name", "Name", "min-w-56")}
                      {header("pid", "PID", "text-right")}
                      {header("user", "User")}
                      {plainHead("Service")}
                      {plainHead("Status")}
                      {header("cpuPercent", <>CPU <span className="font-mono normal-case tracking-normal">{totalCpu.toFixed(0)}%</span></>, "text-right")}
                      {header("rssBytes", <>Memory <span className="font-mono normal-case tracking-normal">{humanBytes(totalMem, true, 0)}</span></>, "text-right")}
                      {header("io", "Disk", "text-right")}
                      {header("threads", "Threads", "text-right")}
                      {header("startedAt", "Started", "text-right")}
                    </TableRow>
                  </TableHeader>
                  <tbody>
                    {lines.slice(0, limit).map(line => line.kind === "group" ? (
                      <TableRow key={`g:${line.name}`} className="bg-well/50 hover:bg-well/70 has-aria-expanded:bg-well/50 [&>td]:border-b [&>td]:border-seam">
                        <TableCell className="px-1.5 py-0" colSpan={5}>
                          <button type="button" onClick={() => toggle(line.name)} className="flex min-h-10 w-full items-center gap-1.5 text-left font-semibold text-silk" aria-expanded={!collapsed.has(line.name)}>
                            {collapsed.has(line.name) ? <ChevronRight className="size-4 text-graphite" aria-hidden /> : <ChevronDown className="size-4 text-graphite" aria-hidden />}
                            <span className="truncate font-mono text-[13px]">{line.name}</span>
                            <span className="font-mono text-xs font-normal text-graphite">{line.members.length}</span>
                          </button>
                        </TableCell>
                        <TableCell className="px-2.5 text-right font-mono tabular-nums">{line.members.reduce((s, p) => s + (p.cpuPercent ?? 0), 0).toFixed(1)}%</TableCell>
                        <TableCell className="px-2.5 text-right font-mono tabular-nums">{humanBytes(line.members.reduce((s, p) => s + (p.rssBytes ?? 0), 0))}</TableCell>
                        <TableCell colSpan={3} />
                      </TableRow>
                    ) : (
                      <ProcessLine
                        key={line.p.pid}
                        p={line.p}
                        depth={line.depth}
                        tree={view === "tree"}
                        hasChildren={line.hasChildren}
                        collapsed={collapsed.has(String(line.p.pid))}
                        selected={selected === line.p.pid}
                        onToggle={() => toggle(String(line.p.pid))}
                        onSelect={() => setSelected(line.p.pid)}
                      />
                    ))}
                  </tbody>
                </table>
                {lines.length > limit && (
                  <div className="sticky left-0 border-t border-seam bg-well p-1.5">
                    <Button variant="ghost" className="w-full" onClick={() => setLimit(l => l + 500)}>
                      Show 500 more rows <span className="font-mono font-normal text-graphite">({lines.length - limit} not shown)</span>
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Section>
        </>
      )}

      {selected !== null && <ProcessDrawer pid={selected} admin={Boolean(session?.authenticated && session.actionsEnabled)} onClose={() => setSelected(null)} />}
    </div>
  );
}

const SELECTED_CELLS =
  "[&>td]:bg-bezel [&>td]:shadow-[inset_0_1px_0_var(--seam-strong),inset_0_-1px_0_var(--seam-strong)] [&>td:first-child]:shadow-[inset_1px_0_0_var(--seam-strong),inset_0_1px_0_var(--seam-strong),inset_0_-1px_0_var(--seam-strong)] [&>td:last-child]:shadow-[inset_-1px_0_0_var(--seam-strong),inset_0_1px_0_var(--seam-strong),inset_0_-1px_0_var(--seam-strong)]";

function ProcessLine({ p, depth, tree, hasChildren, collapsed, selected, onToggle, onSelect }: {
  p: ProcessRow; depth: number; tree: boolean; hasChildren: boolean; collapsed: boolean; selected: boolean; onToggle: () => void; onSelect: () => void;
}) {
  const io = ioOf(p);
  return (
    <TableRow
      onClick={onSelect}
      data-state={selected ? "selected" : undefined}
      className={cn("cursor-pointer border-0 has-aria-expanded:bg-transparent hover:has-aria-expanded:bg-bezel/60 [&>td]:border-b [&>td]:border-seam/70", selected && SELECTED_CELLS)}
    >
      <TableCell className="max-w-md py-0 pl-1.5 pr-2.5">
        <span className="flex min-h-10 items-center gap-1" style={{ paddingLeft: depth * 14 }}>
          {tree && (hasChildren
            ? (
              <button
                type="button"
                aria-label={collapsed ? `Expand ${p.name}` : `Collapse ${p.name}`}
                aria-expanded={!collapsed}
                onClick={e => { e.stopPropagation(); onToggle(); }}
                className="grid size-7 shrink-0 place-items-center rounded-[2px] text-graphite hover:bg-well hover:text-silk"
              >
                {collapsed ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
              </button>
            )
            : <span className="inline-block w-7 shrink-0" />)}
          <button type="button" onClick={e => { e.stopPropagation(); onSelect(); }} className="min-w-0 truncate text-left font-semibold text-silk hover:underline" title={p.command}>
            {p.name}
          </button>
          {!p.controllable && (
            <span title={p.protectedReason ?? "Not controllable from the dashboard"} className="shrink-0 text-graphite">
              <Lock className="size-3" aria-hidden />
              <span className="sr-only">Not controllable from the dashboard</span>
            </span>
          )}
        </span>
      </TableCell>
      <TableCell className="px-2.5 text-right font-mono text-[13px] tabular-nums text-silk-dim">{p.pid}</TableCell>
      <TableCell className="px-2.5 font-mono text-[13px]">{p.user}</TableCell>
      <TableCell className="max-w-48 truncate px-2.5 font-mono text-xs text-silk-dim">
        {p.container ? <><span className="text-graphite">container </span>{p.container.name ?? p.container.id.slice(0, 12)}</> : p.unit ?? ""}
      </TableCell>
      <TableCell className="px-2.5 text-[13px]">
        <span className="inline-flex items-center gap-1.5">
          {p.state === "Z" && <Lamp status="WARNING" />}
          {STATE_LABEL[p.state] ?? p.state}
          {p.nice ? <span className="font-mono text-xs text-graphite">nice {p.nice}</span> : null}
        </span>
      </TableCell>
      <TableCell className="px-2.5 text-right font-mono tabular-nums"><CpuCell value={p.cpuPercent} /></TableCell>
      <TableCell className="px-2.5 text-right font-mono tabular-nums">{p.rssBytes === null ? <CellVoid why="Memory use not readable" /> : humanBytes(p.rssBytes)}</TableCell>
      <TableCell className="px-2.5 text-right font-mono text-[13px] tabular-nums">{io === null ? <Hidden /> : humanBytesPerSecond(io, 0)}</TableCell>
      <TableCell className="px-2.5 text-right font-mono tabular-nums">{p.threads}</TableCell>
      <TableCell className="px-2.5 text-right text-[13px] text-silk-dim">{p.startedAt === null ? <CellVoid /> : humanAge(p.startedAt)}</TableCell>
    </TableRow>
  );
}

function CpuCell({ value }: { value: number | null }) {
  if (value === null) return <CellVoid why="CPU is measured between two reads" />;
  // A faint bar behind the number, so a heavy process stands out while you scroll.
  return (
    <span className="relative inline-block min-w-14 rounded-[2px] px-1">
      <span className="absolute inset-y-0 right-0 rounded-[2px] bg-[var(--series-1)]/25" style={{ width: `${Math.min(100, value * 4)}%` }} />
      <span className="relative">{value.toFixed(1)}%</span>
    </span>
  );
}

function DrawerHeading({ children, count }: { children: React.ReactNode; count?: number }) {
  return <h3 className="panel-label m-0">{children}{count != null ? ` · ${count}` : ""}</h3>;
}

function ProcessDrawer({ pid, admin, onClose }: { pid: number; admin: boolean; onClose: () => void }) {
  const { data, error } = useSWR<ProcessDetail>(`/api/processes/${pid}`, fetcher, { refreshInterval: 3000 });
  const p = data?.row;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const unreadable = "Owned by another account. Without root, the kernel doesn't let the dashboard read this.";

  return (
    <div role="dialog" aria-modal="true" aria-label={`Process ${pid}`} className="fixed inset-0 z-[90] flex justify-end bg-black/60" onClick={onClose}>
      <aside className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-seam bg-bezel shadow-[-12px_0_32px_rgb(0_0_0/0.45)]" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-seam bg-bezel px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <PanelLabel>Process</PanelLabel>
            <h2 className="m-0 truncate text-[22px] font-semibold leading-tight">{p?.name ?? `PID ${pid}`}</h2>
            <p className="m-0 truncate font-mono text-[13px] text-graphite">
              PID {pid}{p ? ` · ${p.user}` : ""}{p?.container?.name ? ` · container ${p.container.name}` : p?.unit ? ` · ${p.unit}` : ""}
            </p>
          </div>
          <Button variant="outline" autoFocus onClick={onClose}>Close</Button>
        </div>

        <div className="flex flex-col gap-6 px-5 py-5">
          {error && (
            <ErrorState title={`Process ${pid}'s details didn't load`} detail={error}>
              It may have exited since the table refreshed. Close this panel and pick it again from the table.
            </ErrorState>
          )}
          {!data && !error && <Acquiring rows={3} />}
          {data && p && (
            <>
              <section className="flex flex-col gap-2">
                <DrawerHeading>Command line</DrawerHeading>
                <pre className="well m-0 whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-xs leading-relaxed text-silk">{p.command}</pre>
              </section>

              <Facts
                className="[&_dd]:font-mono [&_dd]:text-[13px] [&_dd]:break-all"
                items={[
                  ["CPU", p.cpuPercent === null ? <CellVoid why="CPU is measured between two reads" /> : `${p.cpuPercent.toFixed(1)}%`],
                  ["Memory (RSS)", p.rssBytes === null ? <CellVoid /> : humanBytes(p.rssBytes)],
                  ["Swap", p.swapBytes === null ? <CellVoid /> : humanBytes(p.swapBytes)],
                  ["Threads", p.threads],
                  ["Status", <span key="s" className="inline-flex items-center gap-1.5">{p.state === "Z" && <Lamp status="WARNING" />}{STATE_LABEL[p.state] ?? p.state}, nice {p.nice}</span>],
                  ["Started", p.startedAt ? new Date(p.startedAt * 1000).toLocaleString() : <CellVoid />],
                  ["Disk read", p.readBps === null ? <Hidden why={unreadable} /> : humanBytesPerSecond(p.readBps)],
                  ["Disk write", p.writeBps === null ? <Hidden why={unreadable} /> : humanBytesPerSecond(p.writeBps)],
                  ["Open files", data.openFiles ?? <Hidden why={unreadable} />],
                  ["Executable", data.exe ?? <Hidden why={unreadable} />],
                  ["Working dir", data.cwd ?? <Hidden why={unreadable} />],
                ]}
              />

              <section className="flex flex-col gap-2">
                <DrawerHeading>Parent chain</DrawerHeading>
                {data.ancestry.length === 0 ? (
                  <p className="m-0 text-sm text-silk-dim">No parent: this is a root of the process tree.</p>
                ) : (
                  <ol className="well m-0 flex list-none flex-col gap-1 px-3 py-2.5 font-mono text-[13px]">
                    {data.ancestry.map((a, i) => (
                      <li key={a.pid} className="flex gap-2" style={{ paddingLeft: i * 12 }}>
                        <span className="text-graphite">{i === 0 ? "parent" : "←"}</span>
                        <span className="text-silk">{a.name}</span>
                        <span className="tabular-nums text-graphite">{a.pid}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {data.children.length > 0 && (
                <section className="flex flex-col gap-2">
                  <DrawerHeading count={data.children.length}>Children</DrawerHeading>
                  <div className="overflow-x-auto rounded-[3px] border border-seam">
                    <table className="w-full text-[13px]">
                      <thead className="bg-well">
                        <tr className="border-b border-seam">
                          <TableHead className="px-2.5 text-right">PID</TableHead>
                          <TableHead className="px-2.5">Name</TableHead>
                          <TableHead className="px-2.5 text-right">CPU</TableHead>
                          <TableHead className="px-2.5 text-right">Memory</TableHead>
                        </tr>
                      </thead>
                      <tbody className="font-mono tabular-nums">
                        {data.children.slice(0, 30).map(c => (
                          <tr key={c.pid} className="border-b border-seam/70 last:border-0">
                            <td className="px-2.5 py-1.5 text-right text-silk-dim">{c.pid}</td>
                            <td className="max-w-48 truncate px-2.5 py-1.5">{c.name}</td>
                            <td className="px-2.5 py-1.5 text-right">{c.cpuPercent === null ? <CellVoid /> : `${c.cpuPercent.toFixed(1)}%`}</td>
                            <td className="px-2.5 py-1.5 text-right">{c.rssBytes === null ? <CellVoid /> : humanBytes(c.rssBytes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {data.children.length > 30 && <p className="m-0 text-xs text-graphite">Showing the first 30 of {data.children.length}.</p>}
                </section>
              )}

              <section className="flex flex-col gap-2">
                <DrawerHeading count={data.openFiles === null ? undefined : data.sockets.length}>Network sockets</DrawerHeading>
                {data.openFiles === null ? (
                  <Void
                    state="HIDDEN"
                    note={<>This process belongs to another account, so without root its sockets can&apos;t be tied to it. The <Link href="/connections" className="text-trace underline">Connections</Link> page lists every socket by owner.</>}
                  />
                ) : data.sockets.length === 0 ? (
                  <p className="m-0 text-sm text-silk-dim">No open sockets.</p>
                ) : (
                  <ul className="well m-0 flex list-none flex-col gap-1 px-3 py-2.5 font-mono text-xs">
                    {data.sockets.slice(0, 40).map(s => (
                      <li key={`${s.protocol}${s.inode}`} className="break-all">
                        <span className="text-graphite">{s.protocol}{s.family === 6 ? "6" : ""}</span>{" "}
                        {s.localAddress}:{s.localPort}{" "}
                        {s.state === "LISTEN" || s.state === "UNCONN"
                          ? <span className="text-graphite">({s.state.toLowerCase()})</span>
                          : <>→ {s.remoteAddress}:{s.remotePort} <span className="text-graphite">{s.state}</span></>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {data.limits && (
                <details className="group">
                  <summary className="panel-label flex min-h-10 cursor-pointer list-none items-center gap-2 hover:text-silk">
                    <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
                    Resource limits · {Object.keys(data.limits).length}
                  </summary>
                  <Facts
                    className="mt-2 sm:grid-cols-[176px_minmax(0,1fr)] [&_dd]:font-mono [&_dd]:text-[13px]"
                    items={Object.entries(data.limits).map(([k, v]) => [k.replace(/^Max /, ""), v] as [string, string])}
                  />
                </details>
              )}

              <ProcessControls row={p} admin={admin} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

type Pending = { label: string; signal?: string; danger?: boolean; body: Record<string, unknown> };

function ProcessControls({ row, admin }: { row: ProcessRow; admin: boolean }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState("");
  const [nice, setNice] = useState(Math.min(19, row.nice + 5));
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!row.controllable) {
    return (
      <section className="flex flex-col gap-2.5 border-t border-seam pt-5">
        <DrawerHeading>Control</DrawerHeading>
        <div className="flex flex-wrap items-start gap-3">
          <Stamp status="UNKNOWN" label="LOCKED" />
          <p className="m-0 min-w-0 flex-1 text-sm leading-normal text-silk-dim">
            {row.protectedReason ?? "The dashboard can't signal this process."}
          </p>
        </div>
      </section>
    );
  }
  if (!admin) {
    return (
      <section className="flex flex-col gap-2.5 border-t border-seam pt-5">
        <DrawerHeading>Control</DrawerHeading>
        <div className="flex flex-wrap items-start gap-3">
          <Stamp status="UNKNOWN" label="SIGNED OUT" />
          <p className="m-0 min-w-0 flex-1 text-sm leading-normal text-silk-dim">
            Sign in on the <Link href="/admin" className="text-trace underline">Admin</Link> page to end, suspend or lower the priority of this process. Process actions also have to be enabled there.
          </p>
        </div>
      </section>
    );
  }

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/processes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...pending.body, pid: row.pid, startedAt: row.startedAt, password }),
      });
      const body = await response.json();
      setResult(response.ok ? { ok: true, message: body.message } : { ok: false, message: body.error });
      if (response.ok) setPending(null);
    } catch (error) {
      setResult({ ok: false, message: String(error) });
    } finally {
      setPassword("");
      setBusy(false);
    }
  };

  const choose = (next: Pending) => { setPending(next); setResult(null); };
  const action = (label: string, signal: string, danger = false) => (
    <Button
      variant={danger ? "destructive" : "outline"}
      aria-pressed={pending?.label === label}
      onClick={() => choose({ label, signal, danger, body: { action: "signal", signal } })}
    >
      {label}
      <span className={cn("font-mono text-xs font-normal", danger ? "text-white/80" : "text-graphite")}>{signal}</span>
    </Button>
  );

  return (
    <section className="flex flex-col gap-4 border-t border-seam pt-5">
      <DrawerHeading>Control</DrawerHeading>
      <div className="flex flex-wrap gap-2">
        {action("End task", "SIGTERM", true)}
        {action("Kill", "SIGKILL", true)}
        {action("Reload", "SIGHUP")}
        {row.state === "T" ? action("Resume", "SIGCONT") : action("Suspend", "SIGSTOP")}
      </div>
      <p className="m-0 text-[13px] leading-normal text-silk-dim">
        End task asks the process to exit cleanly. Kill stops it immediately with no chance to save state. Reload asks it to re-read its configuration, if it supports that.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor="nice" className="flex flex-col gap-1">
          <span className="text-xs text-graphite">Nice value</span>
          <input id="nice" type="number" min={row.nice} max={19} value={nice} onChange={e => setNice(Number(e.target.value))} className={cn(inputClass, "w-24 font-mono tabular-nums")} />
        </label>
        <Button variant="outline" aria-pressed={pending?.label === "Lower priority"} onClick={() => choose({ label: "Lower priority", body: { action: "renice", nice } })}>
          Lower priority
        </Button>
        <p className="m-0 basis-full text-[13px] leading-normal text-silk-dim">
          Now <span className="font-mono text-silk">{row.nice}</span>. Without root, priority can only be lowered (a higher nice value, up to <span className="font-mono">19</span>), never raised back.
        </p>
      </div>

      {pending && (
        <form onSubmit={e => { e.preventDefault(); void submit(); }} className="well flex flex-col gap-3 px-4 py-3.5">
          <p className="m-0 text-sm leading-normal text-silk">
            {pending.label} <strong className="font-semibold">{row.name}</strong> <span className="font-mono text-silk-dim">(PID {row.pid})</span>
            {pending.signal ? <> with <span className="font-mono">{pending.signal}</span></> : <> to nice <span className="font-mono">{String(pending.body.nice)}</span></>}?
            {" "}Re-enter the admin password to confirm.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="password"
              autoFocus
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              aria-label="Admin password"
              placeholder="Admin password"
              className={cn(inputClass, "min-w-0 flex-1 basis-48")}
            />
            <Button type="submit" variant={pending.danger ? "destructive" : "default"} disabled={busy}>
              {busy ? "Sending…" : pending.label}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
          </div>
        </form>
      )}

      {result && (
        <div role="status" className="flex flex-wrap items-start gap-3">
          {result.ok ? <Stamp status="HEALTHY" label="DONE" /> : <Stamp status="CRITICAL" label="REFUSED" />}
          <p className="m-0 min-w-0 flex-1 text-sm leading-normal text-silk">
            {result.message || (result.ok ? "The server accepted the request." : "The server refused the request without giving a reason.")}
          </p>
        </div>
      )}
    </section>
  );
}
