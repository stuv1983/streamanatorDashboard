"use client";

import { useState } from "react";
import useSWR from "swr";
import type { Category, Change, InventoryState } from "@/lib/inventory";
import { humanAge } from "@/lib/utils/formatting";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Acquiring, EmptyState, ErrorState, Lamp, PageHeader, Panel, Readout, Section, Stamp } from "@/components/instrument";

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

/** Column headings for each category's name/value pairs. */
const COLUMNS: Record<Category, [string, string]> = {
  system: ["Property", "Value"],
  packages: ["Package", "Version"],
  containers: ["Container", "Image @ id"],
  units: ["Unit file", "State"],
  listeners: ["Protocol : bind : port", "State"],
  users: ["Account", "UID and shell"],
  files: ["Path", "Fingerprint"],
  modules: ["Module", "State"],
};

// Mirrors changeStatus() in lib/inventory.ts (same fs restriction): changes that widen access.
function changeWarning(c: Change): string | null {
  if (c.category === "users" && c.kind !== "removed") return "A login account was added or changed. Confirm you made this change.";
  if (c.category === "files" && /sudoers|sshd_config|authorized_keys|passwd|shadow/.test(c.item)) return "A security-sensitive file changed. Confirm you made this change.";
  if (c.category === "listeners" && c.kind === "added" && /^(tcp|udp)6?:\*:/.test(c.item)) return "A new port is listening on every network interface. Check it is meant to be reachable.";
  return null;
}

const KIND_LABEL: Record<Change["kind"], string> = { added: "Added", removed: "Removed", changed: "Changed" };

/* Form controls: label above, recessed well, 40px tall. */
const FIELD = "h-10 w-full min-w-0 rounded-[3px] border border-seam-strong bg-well px-3 text-[15px] text-silk placeholder:text-graphite";

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
  const shown = changes.slice(0, 300);
  const warnings = shown.map(c => [c, changeWarning(c)] as const).filter(([, w]) => w !== null);
  const routine = shown.filter(c => changeWarning(c) === null);
  // A partial failure keeps the previous values for the failed categories; anything else is a real failure.
  const partial = !message && data?.lastError?.startsWith("Not collected this time");
  const failure = message ?? (partial ? null : data?.lastError) ?? null;
  const total = inv ? Object.keys(inv[tab] ?? {}).length : 0;
  const [nameHeading, valueHeading] = COLUMNS[tab];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        group="Operations"
        title="Inventory"
        description="What is installed and running on the host: packages, units, containers, ports, accounts, kernel modules and watched files."
        meta={inv
          ? <>Snapshot {humanAge(inv.collectedAt)} · re-collected every 6 hours</>
          : data?.running ? "Collecting the first snapshot" : data ? "No snapshot yet" : "/api/inventory"}
        actions={<Button type="button" onClick={refresh} disabled={refreshing || data?.running}>{refreshing || data?.running ? "Collecting…" : "Re-collect now"}</Button>}
      />

      {error && (
        <ErrorState title={data ? "Inventory didn't refresh" : "Inventory didn't load"} detail={error}>
          The request to <span className="font-mono">/api/inventory</span> failed. It retries every minute.
        </ErrorState>
      )}
      {failure && (
        <ErrorState title={message ? "Re-collect failed" : "The last collection failed"} detail={failure}>
          The previous snapshot is still shown. Fix the cause, then re-collect.
        </ErrorState>
      )}
      {partial && data?.lastError && (
        <div role="status" className="flex flex-col gap-2 rounded-[3px] border border-seam bg-bezel px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Stamp status="WARNING" />
            <p className="m-0 text-base font-semibold">Part of the last collection failed</p>
          </div>
          <p className="m-0 text-sm text-silk-dim">Categories that couldn&apos;t be read keep their previous values, so they don&apos;t show up as removed.</p>
          <p className="m-0 break-words font-mono text-[13px] text-silk-dim">{data.lastError}</p>
        </div>
      )}

      {!data && !error && <Acquiring rows={3} />}

      {data && !inv && (
        data.running
          ? <Acquiring rows={3} />
          : <EmptyState title="No snapshot yet">The first snapshot is taken about 90 seconds after the service starts. Choose Re-collect now to take one immediately.</EmptyState>
      )}

      {changes.length > 0 && (
        <Section
          title="Most recent changes"
          count={changes.length}
          note={data?.previousAt ? `Since the snapshot ${humanAge(data.previousAt)}. Also recorded under Events and changes.` : "Also recorded under Events and changes."}
        >
          {warnings.length > 0 && (
            <div className="flex flex-col">
              {warnings.map(([c, why], i) => (
                <div key={`w${i}`} className="grid grid-cols-1 items-start gap-x-5 gap-y-2 border-t border-seam px-1 py-3 first:border-t-0 md:grid-cols-[128px_minmax(0,1fr)]">
                  <div><Stamp status="WARNING" /></div>
                  <div className="min-w-0">
                    <p className="m-0 text-[15px] text-silk">{why}</p>
                    <p className="m-0 mt-1 break-words font-mono text-[13px] text-silk-dim">
                      {CATEGORY_LABEL[c.category]} · {KIND_LABEL[c.kind].toLowerCase()} · {c.item}{c.kind === "changed" ? `: ${c.before} → ${c.after}` : ""}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {routine.length > 0 && (
            <div className="max-h-80 overflow-auto rounded-[3px] border border-seam">
              <Table>
                <TableHeader className="sticky top-0 bg-well">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-3">Category</TableHead>
                    <TableHead className="px-3">Change</TableHead>
                    <TableHead className="px-3">Item</TableHead>
                    <TableHead className="px-3">Before → after</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {routine.map((c, i) => (
                    <TableRow key={i}>
                      <TableCell className="px-3 py-2 text-[13px] text-silk-dim">{CATEGORY_LABEL[c.category]}</TableCell>
                      <TableCell className="px-3 py-2 text-[13px] text-silk">{KIND_LABEL[c.kind]}</TableCell>
                      <TableCell className="px-3 py-2 font-mono text-[13px] text-silk">{c.item}</TableCell>
                      <TableCell className="px-3 py-2 font-mono text-[13px] text-silk-dim">
                        {c.kind === "changed" ? `${c.before} → ${c.after}` : c.kind === "added" ? (c.after && c.after !== "present" ? c.after : "new") : "gone"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {changes.length > shown.length && <p className="m-0 text-[13px] text-graphite">Showing the first {shown.length} of {changes.length} changes.</p>}
        </Section>
      )}

      {inv && (
        <Section title="Snapshot" note={`Collected ${new Date(inv.collectedAt * 1000).toLocaleString()}`}>
          <div role="tablist" aria-label="Inventory category" className="flex flex-wrap gap-1 rounded-[3px] border border-seam bg-well p-1">
            {ORDER.map(c => (
              <button
                key={c}
                role="tab"
                type="button"
                aria-selected={tab === c}
                onClick={() => setTab(c)}
                className="inline-flex min-h-10 items-center gap-2 rounded-[2px] px-3 text-[13px] font-semibold text-silk-dim hover:text-silk aria-selected:bg-bezel aria-selected:text-silk aria-selected:shadow-[inset_0_0_0_1px_var(--seam-strong)]"
              >
                {CATEGORY_LABEL[c]}
                <span className="font-mono text-xs font-normal tabular-nums text-graphite">{Object.keys(inv[c] ?? {}).length}</span>
                {inv.unavailable?.[c] && <Lamp status="WARNING" label="Not collected this time" />}
              </button>
            ))}
          </div>

          <Panel padded={false} className="gap-0">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-seam px-5 py-4">
              <div className="flex flex-col gap-1">
                <span className="panel-label">{CATEGORY_LABEL[tab]}</span>
                <span className="font-mono text-[13px] text-graphite">{query ? `${items.length} of ${total} match` : `${total} items`}</span>
              </div>
              <label className="flex w-full flex-col gap-1.5 sm:w-64">
                <span className="text-[13px] font-semibold text-silk-dim">Filter</span>
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or value" className={`${FIELD} font-mono`} />
              </label>
            </div>

            {inv.unavailable?.[tab] && (
              <div className="flex flex-wrap items-center gap-3 border-b border-seam px-5 py-3">
                <Stamp status="WARNING" label="STALE" />
                <span className="text-sm text-silk-dim">Not collected this time; showing the previous values. <span className="font-mono text-[13px]">{inv.unavailable[tab]}</span></span>
              </div>
            )}

            {items.length === 0 ? (
              <div className="px-5 py-4">
                {query
                  ? <Readout value={null} state="NO_DATA" note={`Nothing in ${CATEGORY_LABEL[tab].toLowerCase()} matches “${query}”. Clear the filter to see all ${total}.`} size="sm" />
                  : <Readout value={null} state="NO_DATA" note={`No ${CATEGORY_LABEL[tab].toLowerCase()} were found in this snapshot.`} size="sm" />}
              </div>
            ) : (
              <div className="max-h-[40rem] overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-bezel">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-5">{nameHeading}</TableHead>
                      <TableHead className="px-5">{valueHeading}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map(([k, v]) => (
                      <TableRow key={k}>
                        <TableCell className="px-5 py-1.5 font-mono text-[13px] text-silk">{k}</TableCell>
                        <TableCell className="px-5 py-1.5 font-mono text-[13px] text-silk-dim">{v}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
          {tab === "files" && <p className="m-0 text-[13px] text-silk-dim">Files the dashboard account cannot read (sudoers, for example) are tracked by size and modification time instead of a content hash.</p>}
        </Section>
      )}
    </div>
  );
}
