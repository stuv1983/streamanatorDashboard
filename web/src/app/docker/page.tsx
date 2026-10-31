"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  Acquiring, Code, ErrorState, Facts, Lamp, Ledger, Metric, PageHeader, Panel, PanelLabel, Readout, Section, Source, Stamp, Well,
  deltasFrom, hasDeltas,
} from "@/components/instrument";
import type { Snapshot } from "@/lib/snapshot";
import { Status } from "@/lib/status";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function humanDuration(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d > 0 && `${d}d`, h > 0 && `${h}h`, m > 0 && d === 0 && `${m}m`].filter(Boolean).join(" ") || "<1m";
}

function sampledAt(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

/** Renders `code` spans in collector text, and bare shell commands, as mono. */
function withCode(text: string): React.ReactNode {
  if (!text) return text;
  if (!text.includes("`") && /^(docker|sudo|systemctl|journalctl|curl)\s/.test(text)) return <Code>{text}</Code>;
  return text.split("`").map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : part));
}

const STATUS_RANK: Record<string, number> = {
  [Status.CRITICAL]: 4, [Status.WARNING]: 3, [Status.UNKNOWN]: 2, [Status.INFO]: 1, [Status.HEALTHY]: 0,
};

type PendingAction = { action: "start" | "stop" | "restart"; name: string; id: string; dependants: string[] };

const VERB: Record<PendingAction["action"], { label: string; busy: string; done: string }> = {
  start: { label: "Start", busy: "Starting…", done: "Started" },
  stop: { label: "Stop", busy: "Stopping…", done: "Stopped" },
  restart: { label: "Restart", busy: "Restarting…", done: "Restarted" },
};

/** An alert that explains itself: now, threshold, probable cause, next check, and any effects grouped under it. */
function AlertPanel({ alert, all }: { alert: any; all: any[] }) {
  const effects = ((alert.effects ?? []) as string[]).map((key) => all.find((a: any) => a.key === key)).filter(Boolean);
  const cause = alert.caused_by ? all.find((a: any) => a.key === alert.caused_by) : null;
  return (
    <Panel status={alert.status} title={alert.component}>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-base font-semibold">{alert.title}</p>
        {alert.detail && <p className="m-0 text-sm leading-normal text-silk-dim text-pretty">{withCode(alert.detail)}</p>}
      </div>
      <Facts items={[
        ["Now", <Readout key="now" value={alert.current_value || null} size="sm" note="The rule didn't report a current value." />],
        alert.threshold && ["Threshold", <span key="t" className="font-mono">{alert.threshold}</span>],
        alert.probable_cause && ["Probable cause", withCode(alert.probable_cause)],
        alert.recommended_action && ["Next check", withCode(alert.recommended_action)],
        alert.since && ["Since", <span key="s" className="font-mono">{new Date(alert.since * 1000).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}</span>],
      ]} />
      {effects.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-seam pt-3">
          <PanelLabel>Grouped into this incident · {effects.length}</PanelLabel>
          <div className="flex flex-wrap gap-1.5">
            {effects.map((effect: any) => (
              <span key={effect.key} className="inline-flex items-center gap-2 rounded-[2px] border border-seam bg-well px-2 py-1 text-[13px]">
                <Lamp status={effect.status} />{effect.title}
              </span>
            ))}
          </div>
        </div>
      )}
      {cause && <p className="m-0 text-sm text-silk-dim">An effect of <span className="font-semibold text-silk">{cause.title}</span>. Fix that first.</p>}
    </Panel>
  );
}

/**
 * Step-up confirmation for a container action, as on the Processes drawer:
 * the admin password is re-entered for every action and never stored.
 */
function ConfirmAction({ pending, onDone, onCancel }: { pending: PendingAction; onDone: (message: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const verb = VERB[pending.action];

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/containers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: pending.action, name: pending.name, id: pending.id, password }),
      });
      const body = await response.json();
      if (response.ok) onDone(body.message);
      else setError(body.error ?? `HTTP ${response.status}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setPassword("");
      setBusy(false);
    }
  };

  const sharesNetwork = pending.action !== "start" && pending.dependants.length > 0;

  return (
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
    <Panel title={`Confirm ${pending.action}`} className="border-seam-strong">
      <Facts items={[
        ["Command", <Code key="c">docker {pending.action} {pending.name}</Code>],
        sharesNetwork && ["Also affected", (
          <div key="a" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Lamp status="WARNING" />
              {pending.dependants.map((name) => <Code key={name}>{name}</Code>)}
            </div>
            <p className="m-0 text-sm leading-normal text-silk-dim">
              {pending.dependants.length === 1 ? "Shares" : "Share"} this container&apos;s network namespace and will lose connectivity until it is back.
            </p>
          </div>
        )],
        ["Password", (
          <div key="p" className="flex flex-col gap-1.5">
            <input
              type="password" autoFocus required value={password} onChange={e => setPassword(e.target.value)}
              autoComplete="current-password" aria-label="Admin password"
              className="h-10 w-full max-w-sm rounded-[2px] border border-seam-strong bg-well px-3 font-mono text-sm text-silk"
            />
            <span className="text-xs text-graphite">Re-entered for every action and never stored.</span>
          </div>
        )],
      ]} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy} variant={pending.action === "stop" ? "destructive" : "default"}>
          {busy ? verb.busy : `${verb.label} ${pending.name}`}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <Stamp status="CRITICAL" label="FAILED" />
          <span className="text-sm">{error}</span>
        </div>
      )}
    </Panel>
    </form>
  );
}

export default function DockerPage() {
  const { data, error, isLoading, mutate } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });
  const { data: session } = useSWR<{ authenticated: boolean; actionsEnabled: boolean }>("/api/admin/session", fetcher);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [result, setResult] = useState("");
  const [resultLabel, setResultLabel] = useState("DONE");
  const admin = Boolean(session?.authenticated && session.actionsEnabled);

  const component = data?.components?.containers;
  const source = (component?.readings as any[] | undefined)?.find((r: any) => r.source)?.source;
  const time = sampledAt(data?.collected_at);
  const header = (
    <PageHeader
      group="Services"
      title="Docker"
      description="Which containers are running, healthy and restarting, and the controls to act on them."
      status={component?.status}
      meta={[source, time && `sampled ${time}`].filter(Boolean).join(" · ") || undefined}
    />
  );

  if (error) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <ErrorState title="The snapshot didn't load" detail={error}>Check that the dashboard server is running and that <Code>/api/snapshot</Code> responds.</ErrorState>
      </div>
    );
  }
  if (isLoading && !data) return <div className="flex flex-col gap-8">{header}<Acquiring rows={4} /></div>;

  const snapshot = data!;
  const raw = (snapshot.raw?.containers ?? {}) as Record<string, any>;
  const containers: any[] = raw.containers ?? [];
  const unexpected: any[] = raw.unexpected ?? [];
  const readings: any[] = (component?.readings as any[]) ?? [];

  const dockerAlert = snapshot.alerts?.find((a: any) => a.key === "server.docker");

  if (!containers.length && dockerAlert) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <ErrorState title={dockerAlert.title || "Docker daemon unavailable"} detail={dockerAlert.detail || "Docker daemon could not be queried."}>
          {dockerAlert.recommended_action ? withCode(dockerAlert.recommended_action) : "Check that the Docker daemon is running and the dashboard user can reach its socket."}
        </ErrorState>
      </div>
    );
  }

  const rows = containers
    .map((c: any) => {
      // Readings are keyed by the expected name, which can differ in separators from the live name.
      const reading = readings.find((r: any) => r.key === `container.${c.name}` || r.extra?.container?.name === c.name);
      const status: Status = reading?.status ?? Status.UNKNOWN;
      return { ...c, status, reading };
    })
    .sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0));

  const attention = rows.filter((c: any) => c.status === Status.WARNING || c.status === Status.CRITICAL).length;
  const containerAlerts = (snapshot.alerts ?? []).filter((a: any) => a.key?.startsWith("container."));

  return (
    <div className="flex flex-col gap-10">
      {header}

      <Well className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Metric label="Running" value={raw.running_count} unit={raw.expected_count != null ? `of ${raw.expected_count} expected` : undefined} size="lg" />
        <Metric label="Need attention" value={rows.length ? attention : null} size="lg" note="No containers listed." />
        <Metric label="Unexpected" value={raw.unexpected != null ? unexpected.length : null} size="lg" hint="Running, not in the inventory" />
        <Metric label="Docker engine" value={raw.docker_version?.engine} note="docker version returned nothing." />
      </Well>

      {containerAlerts.length > 0 && (
        <Section title="Container alerts" count={containerAlerts.length}>
          <div className="flex flex-col gap-3">
            {containerAlerts.map((alert: any) => <AlertPanel key={alert.key} alert={alert} all={snapshot.alerts ?? []} />)}
          </div>
        </Section>
      )}

      <Section title="Containers" count={rows.length} note="Worst first">
        <p className="m-0 max-w-[75ch] text-sm leading-normal text-silk-dim">
          Media-stack ports are published by <Code>gluetun</Code>, not by the application containers, so Sonarr, SABnzbd and the rest show no ports in <Code>docker ps</Code>.
        </p>

        {result && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-[3px] border border-seam bg-bezel px-4 py-3">
            <Stamp status="HEALTHY" label={resultLabel} />
            <span className="font-mono text-sm">{result}</span>
          </div>
        )}

        {rows.length === 0 ? (
          <Readout value={null} state="NO_DATA" note="Docker answered but listed no containers." />
        ) : (
          <div className="flex flex-col border-b border-seam">
            {rows.map((c: any) => {
              const extra = c.reading?.extra;
              const deltas = hasDeltas(extra) ? deltasFrom(extra) : { "1h": extra?.restart_delta };
              const actions = c.state === "running" ? ["restart", "stop"] as const : ["start"] as const;
              const isPending = pending?.name === c.name;
              return (
                <div key={c.name} className="border-t border-seam">
                  <div className={`grid grid-cols-1 items-center gap-x-5 gap-y-3 px-1 py-3.5 md:grid-cols-[128px_minmax(0,1fr)] ${admin ? "xl:grid-cols-[128px_minmax(0,1fr)_minmax(0,1.4fr)_200px_auto]" : "xl:grid-cols-[128px_minmax(0,1fr)_minmax(0,1.4fr)_200px]"}`}>
                    <div><Stamp status={c.status} /></div>

                    <div className="min-w-0">
                      <p className="m-0 truncate font-mono text-[15px] font-semibold" title={c.name}>{c.name}</p>
                      <p className="m-0 mt-0.5 truncate font-mono text-xs text-graphite" title={c.image ?? undefined}>
                        {c.image ?? "image not reported"}
                      </p>
                      {extra?.expected?.behind_vpn && <span className="mt-1.5 inline-block panel-label">Behind VPN</span>}
                    </div>

                    <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 md:col-start-2 xl:col-start-auto">
                      <Cell label="State"><Readout value={c.state ?? null} state={c.state ? "OK" : "NO_DATA"} size="sm" note="missing" /></Cell>
                      <Cell label="Health">
                        {c.health ? <Readout value={c.health} size="sm" /> : <Readout value={null} state="NOT_CONFIGURED" size="sm" note="no healthcheck" />}
                      </Cell>
                      <Cell label="Uptime">
                        <Readout value={c.uptime_seconds ? humanDuration(c.uptime_seconds) : null} size="sm" note={c.state !== "running" ? "not running" : undefined} />
                      </Cell>
                      <Cell label="Restarts"><Readout value={c.restart_count ?? null} size="sm" /></Cell>
                    </div>

                    <div className="flex min-w-0 flex-col gap-1 md:col-start-2 xl:col-start-auto">
                      <span className="text-xs text-graphite">Restarts added</span>
                      <Ledger deltas={deltas} concern="WARNING" />
                    </div>

                    {admin && (
                      <div className="flex flex-wrap gap-2 md:col-start-2 xl:col-start-auto xl:justify-end">
                        {actions.map(action => (
                          <Button
                            key={action}
                            type="button"
                            variant="outline"
                            aria-label={`${VERB[action].label} ${c.name}`}
                            aria-expanded={isPending && pending?.action === action}
                            onClick={() => {
                              setResult("");
                              setPending({
                                action, name: c.name, id: c.id,
                                dependants: containers.filter((o: any) => o.name !== c.name && (o.behind_container === c.id || o.behind_container === c.name)).map((o: any) => o.name),
                              });
                            }}
                          >
                            {VERB[action].label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>

                  {pending && isPending && (
                    <div className="pb-4 md:pl-[148px]">
                      <ConfirmAction
                        key={`${pending.name}:${pending.action}`}
                        pending={pending}
                        onCancel={() => setPending(null)}
                        onDone={message => { setResultLabel(VERB[pending.action].done.toUpperCase()); setPending(null); setResult(message); void mutate(); }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {unexpected.length > 0 && (
        <Section title="Unexpected containers" count={unexpected.length} note="Running but not in the expected inventory">
          <div className="overflow-x-auto rounded-[3px] border border-seam">
            <table className="w-full whitespace-nowrap text-sm">
              <thead className="bg-well">
                <tr className="border-b border-seam">
                  {["Name", "Image", "State", "Uptime"].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left font-panel text-[9.5px] font-normal uppercase tracking-[0.12em] text-graphite">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {unexpected.map((c: any) => (
                  <tr key={c.name} className="border-b border-seam last:border-0">
                    <td className="px-3 py-2.5 font-mono font-semibold">{c.name}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-silk-dim">{c.image ?? <Readout value={null} size="sm" />}</td>
                    <td className="px-3 py-2.5 font-mono">{c.state ?? <Readout value={null} size="sm" />}</td>
                    <td className="px-3 py-2.5"><Readout value={c.uptime_seconds ? humanDuration(c.uptime_seconds) : null} size="sm" note={c.state !== "running" ? "not running" : undefined} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {source && <Source>Containers read from {source}. Restart changes come from the history store.</Source>}
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-graphite">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
