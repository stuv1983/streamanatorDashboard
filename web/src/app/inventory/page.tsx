"use client";

import { useState } from "react";
import useSWR from "swr";
import type { Category, InventoryState } from "@/lib/inventory";
import { humanAge } from "@/lib/utils/formatting";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

// Mirrors CATEGORY_LABEL in lib/inventory.ts, which can't be imported here: it pulls in fs and child_process.
const CATEGORY_LABEL: Record<Category, string> = {
  packages: "Packages", units: "Enabled units", listeners: "Listening ports", containers: "Containers",
  users: "Accounts", modules: "Kernel modules", files: "Watched files", system: "System",
};

const ORDER: Category[] = ["system", "packages", "containers", "units", "listeners", "users", "files", "modules"];

export default function InventoryPage() {
  const { data, error, mutate } = useSWR<InventoryState>("/api/inventory", fetcher, { refreshInterval: 60_000 });
  const [tab, setTab] = useState<Category>("system");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setMessage(null);
    const response = await fetch("/api/inventory", { method: "POST" });
    const body = await response.json();
    if (!response.ok) setMessage(body.error ?? body.lastError ?? "Refresh failed.");
    await mutate();
    setRefreshing(false);
  };

  const inv = data?.current;
  const items = inv ? Object.entries(inv[tab] ?? {}).filter(([k, v]) => !query || k.toLowerCase().includes(query.toLowerCase()) || v.toLowerCase().includes(query.toLowerCase())).sort(([a], [b]) => a.localeCompare(b)) : [];
  const changes = data?.lastChanges ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
          <p className="mt-1 text-muted-foreground">
            {inv ? `Snapshot ${humanAge(inv.collectedAt)} · re-collected every 6 hours; differences are recorded under Events & changes.` : data?.running ? "Collecting the first snapshot…" : "No snapshot yet: the first is taken about 90 seconds after start."}
          </p>
        </div>
        <button type="button" onClick={refresh} disabled={refreshing || data?.running} className="h-9 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50">{refreshing ? "Collecting…" : "Re-collect now"}</button>
      </div>
      {(error || message || data?.lastError) && <p className="text-sm text-[var(--status-critical)]">{message ?? data?.lastError ?? String(error?.message ?? error)}</p>}

      {changes.length > 0 && (
        <section className="rounded-xl border p-4">
          <h2 className="mb-2 font-semibold">Most recent changes {data?.previousAt ? <span className="font-normal text-muted-foreground">(since the snapshot {humanAge(data.previousAt)})</span> : null}</h2>
          <ul className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-xs">
            {changes.slice(0, 300).map((c, i) => (
              <li key={i}><span className="text-muted-foreground">{CATEGORY_LABEL[c.category]}</span> {c.kind === "added" ? "+" : c.kind === "removed" ? "−" : "~"} {c.item}{c.kind === "changed" ? `: ${c.before} → ${c.after}` : ""}</li>
            ))}
          </ul>
        </section>
      )}

      {inv && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap rounded-lg border bg-muted/25 p-1" role="tablist">
              {ORDER.map(c => (
                <button key={c} role="tab" type="button" aria-selected={tab === c} onClick={() => setTab(c)} className={`rounded-md px-2.5 py-1 text-xs ${tab === c ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                  {CATEGORY_LABEL[c]} <span className="text-muted-foreground">{Object.keys(inv[c] ?? {}).length}</span>
                </button>
              ))}
            </div>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter…" aria-label="Filter inventory" className="ml-auto h-9 w-56 rounded-md border bg-background px-3 text-sm" />
          </div>
          <div className="max-h-[40rem] overflow-y-auto rounded-xl border">
            <table className="w-full text-sm">
              <tbody>{items.map(([k, v]) => <tr key={k} className="border-b border-border/40"><td className="px-3 py-1 font-mono text-xs">{k}</td><td className="px-3 font-mono text-xs text-muted-foreground">{v}</td></tr>)}</tbody>
            </table>
          </div>
          {tab === "files" && <p className="text-xs text-muted-foreground">Files the dashboard account cannot read (sudoers, for example) are tracked by size and modification time instead of a content hash.</p>}
        </section>
      )}
    </div>
  );
}
