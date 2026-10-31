"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { SocketInventory, SocketRow } from "@/lib/processes";
import { Acquiring, EmptyState, ErrorState, PageHeader, Section, Void } from "@/components/instrument";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

function scope(address: string): "loopback" | "private" | "docker" | "public" | "any" {
  if (address === "0.0.0.0" || address === "::") return "any";
  if (address.startsWith("127.") || address === "::1") return "loopback";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return "docker";
  if (/^(10\.|192\.168\.|169\.254\.|fe80:|f[cd])/i.test(address)) return "private";
  return "public";
}

const SCOPE_LABEL = { loopback: "This host only", any: "All interfaces", private: "LAN", docker: "Docker network", public: "Internet" };

const owner = (s: SocketRow) => s.process ? `${s.process}${s.pid ? ` (${s.pid})` : ""}${s.container ? ` · ${s.container}` : ""}` : `uid ${s.user}`;

const HIDDEN_WHY = "Run by another account. Without root the kernel reveals only the owning user, not the process.";

/** The socket's owner: the process when the kernel lets us see it, else the user plus a hidden marker. */
function Owner({ s }: { s: SocketRow }) {
  if (s.process) {
    return (
      <span className="font-mono text-[13px]">
        <span className="text-silk">{s.process}</span>
        {s.pid ? <span className="text-graphite"> {s.pid}</span> : null}
        {s.container ? <span className="text-silk-dim"> · {s.container}</span> : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2" title={HIDDEN_WHY}>
      <span className="font-mono text-[13px] text-silk-dim">{s.user}</span>
      <Void compact state="HIDDEN" className="inline-flex min-h-0" />
      <span className="sr-only">{HIDDEN_WHY}</span>
    </span>
  );
}

const headClass = "sticky top-0 z-10 bg-well px-3 shadow-[inset_0_-1px_0_var(--seam)]";

export default function ConnectionsPage() {
  const { data, error } = useSWR<SocketInventory>("/api/connections", fetcher, { refreshInterval: 5000, keepPreviousData: true });
  const [query, setQuery] = useState("");

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sockets = (data?.sockets ?? []).filter(s => !q || [s.localAddress, s.remoteAddress, String(s.localPort), String(s.remotePort), s.process ?? "", s.container ?? "", s.user].some(v => v.toLowerCase().includes(q)));
    const listening = sockets
      .filter(s => s.state === "LISTEN" || (s.protocol === "udp" && s.state === "UNCONN"))
      // Dual-stack services list the same port on v4 and v6; one row per port/protocol/owner reads better.
      .filter((s, i, all) => all.findIndex(o => o.protocol === s.protocol && o.localPort === s.localPort && o.uid === s.uid && scope(o.localAddress) === scope(s.localAddress)) === i)
      .sort((a, b) => a.localPort - b.localPort);
    const established = sockets.filter(s => s.state === "ESTABLISHED" && s.protocol === "tcp");
    const byRemote = new Map<string, SocketRow[]>();
    for (const s of established) byRemote.set(s.remoteAddress, [...(byRemote.get(s.remoteAddress) ?? []), s]);
    const states = new Map<string, number>();
    for (const s of sockets.filter(s => s.protocol === "tcp")) states.set(s.state, (states.get(s.state) ?? 0) + 1);
    return { listening, established, byRemote: [...byRemote].sort((a, b) => b[1].length - a[1].length), states: [...states].sort((a, b) => b[1] - a[1]) };
  }, [data, query]);

  const filtered = query.trim() !== "";

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        group="Live"
        title="Connections"
        description="Every TCP and UDP socket on the host: what's listening, where it can be reached from, and who's connected."
        meta="/proc/net · every 5 s"
        actions={
          <label className="flex w-full min-w-0 sm:w-80">
            <span className="sr-only">Filter connections</span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Address, port, process, user"
              className="h-10 w-full rounded-[3px] border border-seam-strong bg-well px-3 text-sm text-silk placeholder:text-graphite focus-visible:border-trace"
            />
          </label>
        }
      />

      {error && (
        <ErrorState title="The socket list didn't refresh" detail={error}>
          The dashboard reads <span className="font-mono">/proc/net/tcp</span>, <span className="font-mono">tcp6</span>, <span className="font-mono">udp</span> and <span className="font-mono">udp6</span> through <span className="font-mono">/api/connections</span>.
          {data ? " The tables below show the last good read." : ""}
        </ErrorState>
      )}

      {!data && !error ? (
        <Acquiring rows={3} />
      ) : data ? (
        <>
          <Section title="TCP states" note={filtered ? "matching the filter" : undefined}>
            {view.states.length === 0 ? (
              <Void state="NO_DATA" note={filtered ? "No TCP sockets match the filter." : "No TCP sockets were found."} />
            ) : (
              <div className="flex flex-wrap gap-2">
                {view.states.map(([state, count]) => (
                  <div key={state} className="well flex min-w-28 flex-col gap-1 px-3.5 py-2.5">
                    <span className="panel-label text-[9px]">{state.replace(/_/g, " ")}</span>
                    <span className="font-mono text-[20px] font-medium leading-none tabular-nums">{count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            {data.unattributed > 0 && (
              <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-normal text-silk-dim">
                <Void compact state="HIDDEN" className="inline-flex min-h-0" />
                <span>
                  The owning process of <span className="font-mono text-silk">{data.unattributed}</span> sockets. They belong to processes run by other accounts (root, containers); without root the kernel only reveals the owning user, so those rows show the user.
                </span>
              </p>
            )}
          </Section>

          <Section title="Listening" count={view.listening.length} note="one row per port, protocol and owner">
            {view.listening.length === 0 ? (
              <EmptyState title={filtered ? "No listening sockets match this filter" : "Nothing is listening"}>
                {filtered ? "Try a port number, an address or a process name." : "No TCP listener or unconnected UDP socket was found."}
              </EmptyState>
            ) : (
              <div className="max-h-[70vh] overflow-auto rounded-[3px] border border-seam">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <TableHeader>
                    <TableRow className="border-0 hover:bg-transparent">
                      <TableHead scope="col" className={cn(headClass, "text-right")}>Port</TableHead>
                      <TableHead scope="col" className={headClass}>Protocol</TableHead>
                      <TableHead scope="col" className={headClass}>Bound to</TableHead>
                      <TableHead scope="col" className={headClass}>Reachable from</TableHead>
                      <TableHead scope="col" className={headClass}>Owner</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.listening.map(s => {
                      const sc = scope(s.localAddress);
                      const wide = sc === "any" || sc === "public";
                      return (
                        <TableRow key={`${s.protocol}${s.family}${s.inode}`} className="border-0 [&>td]:border-b [&>td]:border-seam/70">
                          <TableCell className="px-3 text-right font-mono font-medium tabular-nums">{s.localPort}</TableCell>
                          <TableCell className="px-3 font-mono text-[13px] text-silk-dim">{s.protocol}{s.family === 6 ? "6" : ""}</TableCell>
                          <TableCell className="px-3 font-mono text-[13px]">{s.localAddress}</TableCell>
                          <TableCell className={cn("px-3 text-[13px]", wide ? "font-semibold text-silk" : "text-silk-dim")}>{SCOPE_LABEL[sc]}</TableCell>
                          <TableCell className="px-3"><Owner s={s} /></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Established, by remote host" count={view.byRemote.length} note={`${view.established.length.toLocaleString()} TCP connections`}>
            {view.byRemote.length === 0 ? (
              <EmptyState title={filtered ? "No established connections match this filter" : "No established TCP connections"}>
                {filtered ? "Try a remote address, a port or a process name." : "Nothing is connected to or from this host over TCP right now."}
              </EmptyState>
            ) : (
              <div className="max-h-[70vh] overflow-auto rounded-[3px] border border-seam">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <TableHeader>
                    <TableRow className="border-0 hover:bg-transparent">
                      <TableHead scope="col" className={headClass}>Remote</TableHead>
                      <TableHead scope="col" className={headClass}>Where</TableHead>
                      <TableHead scope="col" className={cn(headClass, "text-right")}>Connections</TableHead>
                      <TableHead scope="col" className={headClass}>Remote ports</TableHead>
                      <TableHead scope="col" className={headClass}>Local side</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.byRemote.map(([remote, list]) => {
                      // One entry per owner and local port, keeping the first socket for display.
                      const local = new Map<string, SocketRow>();
                      for (const s of list) { const k = `${owner(s)} :${s.localPort}`; if (!local.has(k)) local.set(k, s); }
                      const locals = [...local.values()];
                      const ports = [...new Set(list.map(s => s.remotePort))];
                      return (
                        <TableRow key={remote} className="border-0 align-top [&>td]:border-b [&>td]:border-seam/70">
                          <TableCell className="px-3 font-mono text-[13px]">{remote}</TableCell>
                          <TableCell className="px-3 text-[13px] text-silk-dim">{SCOPE_LABEL[scope(remote)]}</TableCell>
                          <TableCell className="px-3 text-right font-mono font-medium tabular-nums">{list.length}</TableCell>
                          <TableCell className="px-3 font-mono text-[13px] text-silk-dim">
                            {ports.slice(0, 8).join(", ")}
                            {ports.length > 8 && <span className="text-graphite"> +{ports.length - 8}</span>}
                          </TableCell>
                          <TableCell className="px-3">
                            <span className="flex flex-col gap-1">
                              {locals.slice(0, 4).map(s => (
                                <span key={`${owner(s)} :${s.localPort}`} className="inline-flex flex-wrap items-center gap-x-2">
                                  <Owner s={s} />
                                  <span className="font-mono text-[13px] text-graphite">:{s.localPort}</span>
                                </span>
                              ))}
                              {locals.length > 4 && <span className="text-xs text-graphite">and {locals.length - 4} more</span>}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </table>
              </div>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}
