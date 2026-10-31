"use client";

import useSWR from "swr";
import {
  Acquiring, Code, ErrorState, Facts, Lamp, Metric, PageHeader, Panel, PanelLabel, Readout, Section, Source, Stamp, Void, Well,
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

/** One state check: the word says pass or fail; a check that couldn't run is a void, not a failure. */
function CheckRow({ label, value, notConfigured = false }: { label: string; value: boolean | null; notConfigured?: boolean }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-seam py-1.5 first:border-t-0">
      <span className="text-[15px]">{label}</span>
      {value == null
        ? <Void compact state={notConfigured ? "NOT_CONFIGURED" : "NO_DATA"} />
        : <Stamp status={value ? Status.HEALTHY : Status.CRITICAL} label={value ? "OK" : "FAILED"} />}
    </div>
  );
}

const LEAK_TITLE: Record<string, string> = {
  [Status.CRITICAL]: "Possible VPN leak",
  [Status.UNKNOWN]: "Leak check inconclusive",
  [Status.HEALTHY]: "No leak: traffic exits through the VPN",
};

export default function VpnPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });

  const component = data?.components?.vpn;
  const time = sampledAt(data?.collected_at);
  const source = (component?.readings as any[] | undefined)?.find((r: any) => r.source)?.source;
  const header = (
    <PageHeader
      group="Services"
      title="VPN"
      description="Whether download traffic is leaving through the Gluetun tunnel, and why not when it isn't."
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
  const raw = (snapshot.raw?.vpn ?? {}) as Record<string, any>;
  const status = raw.status ?? null;
  const leak = raw.leak ?? null;
  const readings: any[] = (component?.readings as any[]) ?? [];
  const leakReading = readings.find((r: any) => r.key === "vpn.leak");
  const tunnelReading = readings.find((r: any) => r.key === "vpn.gluetun");
  const vpnAlerts = snapshot.alerts?.filter((a: any) => a.key?.startsWith("vpn.")) ?? [];

  return (
    <div className="flex flex-col gap-10">
      {header}

      {/* Leak check: always first */}
      <Section title="Leak check">
        {!leakReading && !leak ? (
          <Readout value={null} state="NO_DATA" note="The leak check hasn't reported in this snapshot." />
        ) : (
          <Panel status={leakReading?.status} title={leakReading ? undefined : "Leak check"}>
            {leakReading && (
              <div className="flex flex-col gap-1">
                <p className="m-0 text-lg font-semibold">{LEAK_TITLE[leakReading.status] ?? "Leak check"}</p>
                {leakReading.detail && <p className="m-0 text-[15px] leading-normal text-silk-dim text-pretty">{leakReading.detail}</p>}
                {leakReading.status === Status.CRITICAL && (
                  <p className="m-0 text-[15px] leading-normal text-silk">Download-client traffic may be leaving through the home WAN address.</p>
                )}
              </div>
            )}
            {leak && (
              <Well className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-3">
                <Metric label="VPN exit IP" value={leak.vpnIp ?? null} note="lookup returned nothing" />
                <Metric label="Home WAN IP" value={leak.wanIp ?? null} note="lookup returned nothing" />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-graphite">Result</span>
                  {leak.passed === true || leak.passed === false
                    ? <div><Stamp status={leak.passed ? Status.HEALTHY : Status.CRITICAL} label={leak.passed ? "PASS" : "FAIL"} size="lg" /></div>
                    : <Void note="inconclusive" />}
                </div>
              </Well>
            )}
          </Panel>
        )}
      </Section>

      {/* Tunnel state */}
      <Section title="Tunnel">
        {status == null ? (
          <Readout value={null} state="NO_DATA" note="Gluetun state could not be determined. Check that the gluetun container exists and the dashboard can reach Docker." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel status={tunnelReading?.status} title="Gluetun">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-graphite">Exit IP</span>
                {status.publicIp
                  ? <Readout value={status.publicIp} size="lg" className="break-all" />
                  : status.tunnelUp
                    ? <Void note="The tunnel is up but the exit IP lookup returned nothing." />
                    : <Void state="OFFLINE" note="No tunnel." />}
                {status.publicIpSource && <Source>from {status.publicIpSource}</Source>}
                {tunnelReading?.detail && <p className="m-0 mt-1 text-sm leading-normal text-silk-dim text-pretty">{tunnelReading.detail}</p>}
              </div>
              <Well className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
                <Metric label="Provider" value={status.provider || null} size="sm" />
                <Metric label="Protocol" value={status.protocol || null} size="sm" />
                <Metric label="Forwarded port" value={status.forwardedPort ?? null} size="sm" />
                <Metric label="Uptime" value={status.uptimeSeconds ? humanDuration(status.uptimeSeconds) : null} size="sm" />
                <Metric label="Restarts" value={status.restartCount ?? null} size="sm" />
              </Well>
              {(status.location || status.serverFilter) && (
                <Facts items={[
                  status.location && ["Exit", [status.location, status.org].filter(Boolean).join(" · ")],
                  status.serverFilter && ["Server filter", <Code key="f">{status.serverFilter}</Code>],
                ]} />
              )}
            </Panel>

            <Panel title="State checks">
              <div className="flex flex-col">
                <CheckRow label="Container present" value={status.containerPresent} />
                <CheckRow label="Container running" value={status.containerRunning} />
                <CheckRow label="Docker healthcheck" value={status.containerHealthy} />
                <CheckRow label="Tunnel up" value={status.tunnelUp} />
                <CheckRow label="DNS resolution" value={status.dnsOk} />
                <CheckRow label="Outbound HTTPS" value={status.httpsOk} />
                <CheckRow label="Control server" value={status.control?.configured ? status.control.authorised : null} notConfigured={!status.control?.configured} />
              </div>
              {status.control?.detail && <p className="m-0 text-sm leading-normal text-silk-dim">{status.control.detail}</p>}
            </Panel>
          </div>
        )}
      </Section>

      {/* Diagnosis */}
      {status && (status.containerHealthy === false || status.tunnelUp === false || status.dnsOk === false || status.error) && (
        <Section title="Diagnosis">
          <Panel>
            <Facts items={[
              ["Probable cause", status.error ? withCode(status.error) : <Void key="c" compact note="Nothing in the recent logs matched a known cause." />],
              status.recommendation && ["Next check", withCode(status.recommendation)],
              status.authFailures > 0 && ["Auth failures", <span key="a"><span className="font-mono">{status.authFailures}</span> <Code>AUTH_FAILED</Code> entries in recent logs</span>],
              status.reconnects > 0 && ["Reconnects", <span key="r"><span className="font-mono">{status.reconnects}</span> reconnect events in recent logs</span>],
            ]} />
            {status.recentErrors?.length > 0 && (
              <div className="flex flex-col gap-2">
                <PanelLabel>Recent log errors · {status.recentErrors.length}</PanelLabel>
                <pre className="well m-0 max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-xs leading-relaxed text-silk-dim">{status.recentErrors.join("\n")}</pre>
              </div>
            )}
          </Panel>
        </Section>
      )}

      {/* Active alerts */}
      {vpnAlerts.length > 0 && (
        <Section title="Active alerts" count={vpnAlerts.length}>
          <div className="flex flex-col gap-3">
            {vpnAlerts.map((alert: any) => <AlertPanel key={alert.key} alert={alert} all={snapshot.alerts ?? []} />)}
          </div>
        </Section>
      )}
    </div>
  );
}
