"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { SocketInventory, SocketRow } from "@/lib/processes";

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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Connections</h1>
          <p className="mt-1 text-muted-foreground">Every TCP and UDP socket on the host, read from /proc/net.</p>
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter by address, port, process…" aria-label="Filter connections" className="h-9 w-72 rounded-md border bg-background px-3 text-sm" />
      </div>
      {error && <p className="text-sm text-[var(--status-critical)]">{String(error.message ?? error)}</p>}

      <div className="flex flex-wrap gap-2">
        {view.states.map(([state, count]) => (
          <div key={state} className="rounded-lg border bg-card px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{state.replace("_", " ")}</p>
            <p className="font-mono text-lg tabular-nums">{count}</p>
          </div>
        ))}
      </div>
      {data && data.unattributed > 0 && (
        <p className="text-xs text-muted-foreground">
          {data.unattributed} sockets belong to processes run by other accounts (root, containers). Without root, the kernel only reveals their owning <em>user</em>, not the process, so those rows show the uid instead.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Listening ({view.listening.length})</h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-card text-left text-xs text-muted-foreground"><tr className="border-b">
              <th className="px-3 py-2 font-medium">Port</th><th className="px-3 py-2 font-medium">Protocol</th><th className="px-3 py-2 font-medium">Bound to</th><th className="px-3 py-2 font-medium">Reachable from</th><th className="px-3 py-2 font-medium">Owner</th>
            </tr></thead>
            <tbody>
              {view.listening.map(s => {
                const sc = scope(s.localAddress);
                return (
                  <tr key={`${s.protocol}${s.family}${s.inode}`} className="border-b border-border/40">
                    <td className="px-3 py-1.5 font-mono tabular-nums">{s.localPort}</td>
                    <td className="px-3 font-mono text-xs">{s.protocol}{s.family === 6 ? "6" : ""}</td>
                    <td className="px-3 font-mono text-xs">{s.localAddress}</td>
                    <td className={`px-3 text-xs ${sc === "any" || sc === "public" ? "font-medium" : "text-muted-foreground"}`}>{SCOPE_LABEL[sc]}</td>
                    <td className="px-3 text-xs">{owner(s)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Established, by remote host ({view.established.length} connections)</h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-card text-left text-xs text-muted-foreground"><tr className="border-b">
              <th className="px-3 py-2 font-medium">Remote</th><th className="px-3 py-2 font-medium">Where</th><th className="px-3 py-2 text-right font-medium">Connections</th><th className="px-3 py-2 font-medium">Remote ports</th><th className="px-3 py-2 font-medium">Local side</th>
            </tr></thead>
            <tbody>
              {view.byRemote.map(([remote, list]) => (
                <tr key={remote} className="border-b border-border/40 align-top">
                  <td className="px-3 py-1.5 font-mono text-xs">{remote}</td>
                  <td className="px-3 text-xs text-muted-foreground">{SCOPE_LABEL[scope(remote)]}</td>
                  <td className="px-3 text-right font-mono tabular-nums">{list.length}</td>
                  <td className="px-3 font-mono text-xs">{[...new Set(list.map(s => s.remotePort))].slice(0, 8).join(", ")}</td>
                  <td className="px-3 text-xs">{[...new Set(list.map(s => `${owner(s)} :${s.localPort}`))].slice(0, 4).join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
