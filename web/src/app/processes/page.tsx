"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { ChevronDown, ChevronRight, Lock, Search, X } from "lucide-react";
import type { ProcessDetail, ProcessRow, ProcessTable } from "@/lib/processes";
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

  const header = (key: SortKey, label: string, className = "") => (
    <th scope="col" className={`whitespace-nowrap px-2 py-2 font-medium ${className}`} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="hover:text-foreground" onClick={() => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== "name" && key !== "user" }))}>
        {label}{sort.key === key ? (sort.desc ? " ▾" : " ▴") : ""}
      </button>
    </th>
  );

  const totals = data?.totals;
  const totalCpu = rows.filtered.reduce((s, p) => s + (p.cpuPercent ?? 0), 0);
  const totalMem = rows.filtered.reduce((s, p) => s + (p.rssBytes ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Processes</h1>
          <p className="mt-1 text-muted-foreground">
            {totals ? `${totals.processes} processes · ${totals.threads.toLocaleString()} threads · ${totals.running} running${totals.zombie ? ` · ${totals.zombie} zombie` : ""}` : "Loading…"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <span className="sr-only">Filter processes</span>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, PID, user, container…" className="h-9 w-64 rounded-md border bg-background pl-8 pr-2 text-sm" />
          </label>
          <div className="flex rounded-lg border bg-muted/25 p-1" role="group" aria-label="View">
            {([["list", "List"], ["tree", "Tree"], ["group", "By service"]] as const).map(([v, label]) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={`rounded-md px-2.5 py-1 text-xs ${view === v ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={showKernel} onChange={e => setShowKernel(e.target.checked)} />Kernel threads</label>
          <button type="button" onClick={() => setPaused(p => !p)} className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent" aria-pressed={paused}>{paused ? "Resume" : "Pause"}</button>
        </div>
      </div>

      {error && <p className="text-sm text-[var(--status-critical)]">Process table unavailable: {String(error.message ?? error)}</p>}
      {totals && totals.unreadableIo > 0 && (
        <p className="text-xs text-muted-foreground">
          Disk I/O is shown as “—” for {totals.unreadableIo} processes owned by other accounts: the dashboard runs unprivileged and the kernel does not expose their I/O counters to it.
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
            <tr className="border-b">
              {header("name", "Name", "min-w-56")}
              {header("pid", "PID", "text-right")}
              {header("user", "User")}
              <th scope="col" className="px-2 py-2 font-medium">Service</th>
              <th scope="col" className="px-2 py-2 font-medium">Status</th>
              {header("cpuPercent", `CPU ${totalCpu.toFixed(0)}%`, "text-right")}
              {header("rssBytes", `Memory ${humanBytes(totalMem, true, 0)}`, "text-right")}
              {header("io", "Disk", "text-right")}
              {header("threads", "Threads", "text-right")}
              {header("startedAt", "Started", "text-right")}
            </tr>
          </thead>
          <tbody>
            {lines.slice(0, limit).map(line => line.kind === "group" ? (
              <tr key={`g:${line.name}`} className="border-b bg-muted/30">
                <td className="px-2 py-1.5" colSpan={5}>
                  <button type="button" onClick={() => toggle(line.name)} className="flex items-center gap-1 font-medium" aria-expanded={!collapsed.has(line.name)}>
                    {collapsed.has(line.name) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    {line.name} <span className="font-normal text-muted-foreground">({line.members.length})</span>
                  </button>
                </td>
                <td className="px-2 text-right font-mono tabular-nums">{line.members.reduce((s, p) => s + (p.cpuPercent ?? 0), 0).toFixed(1)}%</td>
                <td className="px-2 text-right font-mono tabular-nums">{humanBytes(line.members.reduce((s, p) => s + (p.rssBytes ?? 0), 0))}</td>
                <td colSpan={3} />
              </tr>
            ) : (
              <tr key={line.p.pid} onClick={() => setSelected(line.p.pid)} className={`cursor-pointer border-b border-border/40 hover:bg-accent/50 ${selected === line.p.pid ? "bg-accent" : ""}`}>
                <td className="max-w-md px-2 py-1.5">
                  <span className="flex items-center gap-1" style={{ paddingLeft: line.depth * 14 }}>
                    {view === "tree" && (line.hasChildren
                      ? <button type="button" aria-label={collapsed.has(String(line.p.pid)) ? "Expand" : "Collapse"} onClick={e => { e.stopPropagation(); toggle(String(line.p.pid)); }}>{collapsed.has(String(line.p.pid)) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</button>
                      : <span className="inline-block w-3.5" />)}
                    <span className="truncate font-medium" title={line.p.command}>{line.p.name}</span>
                    {!line.p.controllable && <Lock className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-label="Not controllable from the dashboard" />}
                  </span>
                </td>
                <td className="px-2 text-right font-mono text-xs tabular-nums">{line.p.pid}</td>
                <td className="px-2 text-xs">{line.p.user}</td>
                <td className="max-w-48 truncate px-2 text-xs text-muted-foreground">{line.p.container?.name ? `🐳 ${line.p.container.name}` : line.p.unit ?? ""}</td>
                <td className="px-2 text-xs">{STATE_LABEL[line.p.state] ?? line.p.state}{line.p.nice ? ` · nice ${line.p.nice}` : ""}</td>
                <td className="px-2 text-right font-mono tabular-nums"><CpuCell value={line.p.cpuPercent} /></td>
                <td className="px-2 text-right font-mono tabular-nums">{humanBytes(line.p.rssBytes)}</td>
                <td className="px-2 text-right font-mono text-xs tabular-nums">{ioOf(line.p) === null ? "—" : humanBytesPerSecond(ioOf(line.p), 0)}</td>
                <td className="px-2 text-right font-mono tabular-nums">{line.p.threads}</td>
                <td className="whitespace-nowrap px-2 text-right text-xs text-muted-foreground">{humanAge(line.p.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {lines.length > limit && (
          <button type="button" onClick={() => setLimit(l => l + 500)} className="w-full border-t py-2 text-sm text-muted-foreground hover:bg-accent">
            Show more ({lines.length - limit} hidden)
          </button>
        )}
      </div>

      {selected !== null && <ProcessDrawer pid={selected} admin={Boolean(session?.authenticated && session.actionsEnabled)} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CpuCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  // A faint bar behind the number, so a heavy process stands out while you scroll.
  return (
    <span className="relative inline-block min-w-14 rounded px-1">
      <span className="absolute inset-y-0 right-0 rounded bg-[var(--series-1)]/25" style={{ width: `${Math.min(100, value * 4)}%` }} />
      <span className="relative">{value.toFixed(1)}%</span>
    </span>
  );
}

function ProcessDrawer({ pid, admin, onClose }: { pid: number; admin: boolean; onClose: () => void }) {
  const { data, error } = useSWR<ProcessDetail>(`/api/processes/${pid}`, fetcher, { refreshInterval: 3000 });
  const p = data?.row;
  return (
    <div role="dialog" aria-modal="true" aria-label={`Process ${pid}`} className="fixed inset-0 z-[90] flex justify-end bg-black/50" onClick={onClose}>
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l bg-background p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold">{p?.name ?? `PID ${pid}`}</h2>
            <p className="text-sm text-muted-foreground">PID {pid}{p ? ` · ${p.user}` : ""}{p?.container?.name ? ` · container ${p.container.name}` : p?.unit ? ` · ${p.unit}` : ""}</p>
          </div>
          <button type="button" autoFocus onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-lg border hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        {error && <p className="text-sm text-[var(--status-critical)]">{String(error.message ?? error)}</p>}
        {data && p && (
          <div className="space-y-5 text-sm">
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Command line</h3>
              <pre className="whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 font-mono text-xs">{p.command}</pre>
            </section>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              {([
                ["CPU", p.cpuPercent === null ? "—" : `${p.cpuPercent.toFixed(1)}%`],
                ["Memory (RSS)", humanBytes(p.rssBytes)],
                ["Swap", humanBytes(p.swapBytes)],
                ["Threads", p.threads],
                ["Status", `${STATE_LABEL[p.state] ?? p.state}, nice ${p.nice}`],
                ["Started", p.startedAt ? new Date(p.startedAt * 1000).toLocaleString() : "—"],
                ["Disk read", p.readBps === null ? "Not readable" : humanBytesPerSecond(p.readBps)],
                ["Disk write", p.writeBps === null ? "Not readable" : humanBytesPerSecond(p.writeBps)],
                ["Open files", data.openFiles ?? "Not readable"],
                ["Executable", data.exe ?? "Not readable"],
                ["Working dir", data.cwd ?? "Not readable"],
                ["Parent chain", data.ancestry.map(a => `${a.name} (${a.pid})`).join(" ← ") || "—"],
              ] as Array<[string, React.ReactNode]>).map(([k, v]) => (
                <div key={k} className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="break-all font-mono text-xs">{v}</dd></div>
              ))}
            </dl>
            {data.children.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Children ({data.children.length})</h3>
                <ul className="space-y-0.5 font-mono text-xs">{data.children.slice(0, 30).map(c => <li key={c.pid}>{c.pid} {c.name} · {c.cpuPercent?.toFixed(1) ?? "—"}% · {humanBytes(c.rssBytes)}</li>)}</ul>
              </section>
            )}
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Network sockets</h3>
              {data.openFiles === null ? (
                <p className="text-xs text-muted-foreground">This process belongs to another account, so its sockets cannot be attributed to it. The Connections page lists all sockets by owner.</p>
              ) : data.sockets.length === 0 ? <p className="text-xs text-muted-foreground">No sockets.</p> : (
                <ul className="space-y-0.5 font-mono text-xs">{data.sockets.slice(0, 40).map(s => (
                  <li key={`${s.protocol}${s.inode}`}>{s.protocol}{s.family === 6 ? "6" : ""} {s.localAddress}:{s.localPort} {s.state === "LISTEN" || s.state === "UNCONN" ? `(${s.state.toLowerCase()})` : `→ ${s.remoteAddress}:${s.remotePort} ${s.state}`}</li>
                ))}</ul>
              )}
            </section>
            {data.limits && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resource limits</summary>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">{Object.entries(data.limits).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>)}</dl>
              </details>
            )}
            <ProcessControls row={p} admin={admin} />
          </div>
        )}
      </aside>
    </div>
  );
}

function ProcessControls({ row, admin }: { row: ProcessRow; admin: boolean }) {
  const [pending, setPending] = useState<{ label: string; body: Record<string, unknown> } | null>(null);
  const [password, setPassword] = useState("");
  const [nice, setNice] = useState(Math.min(19, row.nice + 5));
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!row.controllable) {
    return <section className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"><Lock className="mr-1 inline h-3 w-3" />{row.protectedReason}</section>;
  }
  if (!admin) {
    return <section className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">Sign in on the Admin page to end or reprioritise this process.</section>;
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

  const action = (label: string, body: Record<string, unknown>, danger = false) => (
    <button type="button" onClick={() => { setPending({ label, body }); setResult(null); }}
      className={`rounded-md border px-3 py-1.5 text-xs hover:bg-accent ${danger ? "border-[var(--status-critical)]/60 text-[var(--status-critical)]" : ""}`}>{label}</button>
  );

  return (
    <section className="space-y-3 rounded-md border p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Control</h3>
      <div className="flex flex-wrap gap-2">
        {action("End task (SIGTERM)", { action: "signal", signal: "SIGTERM" })}
        {action("Kill (SIGKILL)", { action: "signal", signal: "SIGKILL" }, true)}
        {action("Reload (SIGHUP)", { action: "signal", signal: "SIGHUP" })}
        {row.state === "T" ? action("Resume (SIGCONT)", { action: "signal", signal: "SIGCONT" }) : action("Suspend (SIGSTOP)", { action: "signal", signal: "SIGSTOP" })}
      </div>
      <div className="flex items-center gap-2 text-xs">
        <label htmlFor="nice">Nice</label>
        <input id="nice" type="number" min={row.nice} max={19} value={nice} onChange={e => setNice(Number(e.target.value))} className="h-8 w-16 rounded-md border bg-background px-2" />
        {action("Apply priority", { action: "renice", nice })}
        <span className="text-muted-foreground">Can only be raised (lower priority) without root.</span>
      </div>
      {pending && (
        <form onSubmit={e => { e.preventDefault(); void submit(); }} className="space-y-2 rounded-md bg-muted/40 p-3">
          <p className="text-xs">Confirm <strong>{pending.label}</strong> on <strong>{row.name}</strong> (PID {row.pid}). Re-enter the admin password:</p>
          <div className="flex gap-2">
            <input type="password" autoFocus required value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" className="h-8 flex-1 rounded-md border bg-background px-2 text-sm" aria-label="Admin password" />
            <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50">{busy ? "Sending…" : "Confirm"}</button>
            <button type="button" onClick={() => setPending(null)} className="rounded-md border px-3 text-xs">Cancel</button>
          </div>
        </form>
      )}
      {result && <p role="status" className={`text-xs ${result.ok ? "text-[var(--status-good)]" : "text-[var(--status-critical)]"}`}>{result.ok ? "✓ " : "✕ "}{result.message}</p>}
    </section>
  );
}
