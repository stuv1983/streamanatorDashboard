"use client";

import { Code, EmptyState, Facts, Lamp, PageHeader, Panel, PanelLabel, Readout, Section, Stamp } from "@/components/instrument";
import { ReadingCards, SnapshotBoundary, useSnapshot } from "@/components/snapshot-ui";

function sampledAt(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

/** IDS timestamps arrive as epoch seconds, epoch milliseconds or ISO strings. */
function eventTime(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const d = new Date(value > 1e12 ? value : value * 1000);
    return d.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
}

/** Renders `code` spans in collector text as mono. */
function withCode(text: string): React.ReactNode {
  if (!text) return text;
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
        {alert.detail && <p className="m-0 break-words font-mono text-sm leading-normal text-silk-dim">{alert.detail}</p>}
      </div>
      <Facts items={[
        ["Now", <Readout key="now" value={alert.current_value || null} size="sm" note="The rule didn't report a current value." />],
        alert.threshold && ["Threshold", <span key="t" className="font-mono">{alert.threshold}</span>],
        alert.probable_cause && ["Probable cause", withCode(alert.probable_cause)],
        alert.recommended_action && ["Next check", withCode(alert.recommended_action)],
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

const TH = "whitespace-nowrap px-3 py-2.5 text-left font-panel text-[9.5px] font-normal uppercase tracking-[0.12em] text-graphite";
const TD = "px-3 py-2.5";

export default function SecurityPage() {
  const result = useSnapshot();
  const time = sampledAt(result.data?.collected_at);
  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        group="Operations"
        title="Security"
        description="Which ports listen beyond loopback, what is exposed to the internet, and what UniFi IDS/IPS has seen."
        status={result.data?.components.security?.status}
        meta={time ? `sampled ${time}` : undefined}
      />
      <SnapshotBoundary {...result}>{(snapshot) => {
        const component = snapshot.components.security;
        const raw = snapshot.raw.security ?? {};
        const listeners = (raw.listeners ?? []).map((item: any) => ({ address: item.address, port: item.port, protocol: item.protocol, process: item.process, loopback_only: item.loopbackOnly ?? item.loopback_only }));
        const events = (raw.ids_events ?? []).map((item: any) => ({ time: item.timestamp ?? item.time, severity: item.severity, source: item.source_ip ?? item.source, destination: item.destination_ip ?? item.destination, signature: item.signature ?? item.message }));
        const exposed = listeners.filter((item: any) => !item.loopback_only);
        const unexpected = new Set(((raw.unexpected_listeners ?? []) as any[]).map((l: any) => `${l.address}:${l.port}`));
        const alerts = (snapshot.alerts ?? []).filter((a: any) => a.key?.startsWith("security."));

        return (
          <div className="flex flex-col gap-10">
            <Section title="Readings" count={(component?.readings ?? []).length} note={component?.detail}>
              <ReadingCards readings={component?.readings ?? []} />
            </Section>

            {alerts.length > 0 && (
              <Section title="Active alerts" count={alerts.length}>
                <div className="flex flex-col gap-3">
                  {alerts.map((alert: any) => <AlertPanel key={alert.key} alert={alert} all={snapshot.alerts ?? []} />)}
                </div>
              </Section>
            )}

            <Section title="Non-loopback listeners" count={raw.listeners ? exposed.length : undefined}>
              {raw.listeners == null ? (
                <Readout value={null} state="NO_DATA" note={<><Code>ss</Code> is unavailable, so local listeners could not be enumerated.</>} />
              ) : exposed.length === 0 ? (
                <EmptyState title="Nothing listens beyond loopback">
                  Every listening socket is bound to <Code>127.0.0.1</Code> or <Code>::1</Code>, so no service on this host accepts connections from the network.
                </EmptyState>
              ) : (
                <div className="overflow-x-auto rounded-[3px] border border-seam">
                  <table className="w-full text-sm">
                    <thead className="bg-well">
                      <tr className="border-b border-seam">
                        {["Inventory", "Address", "Port", "Protocol", "Process"].map((h) => <th key={h} className={TH}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {exposed.map((item: any, i: number) => {
                        const isUnexpected = unexpected.has(`${item.address}:${item.port}`);
                        return (
                          <tr key={`${item.address}:${item.port}:${item.protocol}:${i}`} className="border-b border-seam last:border-0">
                            <td className={TD}><Stamp status={isUnexpected ? "WARNING" : "HEALTHY"} label={isUnexpected ? "UNEXPECTED" : "EXPECTED"} /></td>
                            <td className={`${TD} whitespace-nowrap font-mono`}>{item.address ?? <Readout value={null} size="sm" />}</td>
                            <td className={`${TD} font-mono`}>{item.port ?? <Readout value={null} size="sm" />}</td>
                            <td className={`${TD} font-mono text-silk-dim`}>{item.protocol ?? <Readout value={null} size="sm" />}</td>
                            <td className={`${TD} font-mono`}>{item.process || <Readout value={null} size="sm" note="not reported" />}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section title="UniFi IDS/IPS events" count={raw.ids_events ? events.length : undefined}>
              {!raw.unifi?.configured ? (
                <Readout value={null} state="NOT_CONFIGURED" note="UniFi is not configured; no claim about event absence can be made." />
              ) : raw.ids_events == null ? (
                <Readout value={null} state="NO_DATA" note="The UniFi Integration API doesn't expose IDS/IPS events, so an empty list can't be read as no intrusions." />
              ) : events.length === 0 ? (
                <EmptyState title="No recent events reported">UniFi answered and listed no IDS/IPS events in its recent window.</EmptyState>
              ) : (
                <div className="overflow-x-auto rounded-[3px] border border-seam">
                  <table className="w-full text-sm">
                    <thead className="bg-well">
                      <tr className="border-b border-seam">
                        {["Time", "Severity", "Source", "Destination", "Signature"].map((h) => <th key={h} className={TH}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((event: any, i: number) => {
                        const t = eventTime(event.time);
                        return (
                          <tr key={i} className="border-b border-seam last:border-0">
                            <td className={`${TD} whitespace-nowrap font-mono text-[13px]`}>{t ?? <Readout value={null} size="sm" />}</td>
                            <td className={`${TD} font-mono text-[13px]`}>{event.severity ?? <Readout value={null} size="sm" />}</td>
                            <td className={`${TD} whitespace-nowrap font-mono text-[13px]`}>{event.source ?? <Readout value={null} size="sm" />}</td>
                            <td className={`${TD} whitespace-nowrap font-mono text-[13px]`}>{event.destination ?? <Readout value={null} size="sm" />}</td>
                            <td className={`${TD} min-w-[220px] text-[13px] leading-normal`}>{event.signature ?? <Readout value={null} size="sm" />}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </div>
        );
      }}</SnapshotBoundary>
    </div>
  );
}
