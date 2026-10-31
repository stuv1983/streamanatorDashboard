"use client";

import useSWR from "swr";
import { Acquiring, Code, EmptyState, ErrorState, Metric, PageHeader, Readout, Section, Source, Stamp, Well } from "@/components/instrument";
import type { Snapshot } from "@/lib/snapshot";
import { Status } from "@/lib/status";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const STATUS_RANK: Record<string, number> = {
  [Status.CRITICAL]: 4, [Status.WARNING]: 3, [Status.UNKNOWN]: 2, [Status.INFO]: 1, [Status.HEALTHY]: 0,
};

/** Probe stages in the order they run; a later stage has no timing when an earlier one failed. */
const STAGE_ORDER: Record<string, number> = { config: 0, dns: 1, tcp: 2, http: 3, status: 4 };

function sampledAt(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

/** Why a stage timing is missing, when the probe says. */
function stageNote(probe: any, stage: "dns" | "tcp" | "http"): string | undefined {
  if (probe.failed_stage === "unknown") return "not measured";
  const failed = STAGE_ORDER[probe.failed_stage];
  if (failed == null) return undefined;
  if (failed === STAGE_ORDER[stage]) return "failed here";
  if (failed < STAGE_ORDER[stage]) return "not reached";
  return undefined;
}

function ms(value: number | null | undefined) {
  return value != null ? Math.round(value) : null;
}

export default function ApplicationsPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });

  const component = data?.components?.applications;
  const time = sampledAt(data?.collected_at);
  const source = (component?.readings as any[] | undefined)?.find((r: any) => r.source && r.state === "OK")?.source;
  const header = (
    <PageHeader
      group="Services"
      title="Applications"
      description="Whether each hosted application answers its HTTP probe, and which stage fails when it doesn't."
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
  const raw = (snapshot.raw?.applications ?? {}) as Record<string, any>;
  const probes: Record<string, any> = raw.probes ?? {};
  const readings: any[] = (component?.readings as any[]) ?? [];

  const probeRows = Object.entries(probes)
    .map(([key, probe]: [string, any]) => {
      const reading = readings.find((r: any) => r.key === `probe.${key}`);
      return { key, probe, reading, status: reading?.status ?? Status.UNKNOWN };
    })
    .sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0));

  const failing = probeRows.filter(({ probe }) => probe.success === false).length;

  return (
    <div className="flex flex-col gap-10">
      {header}

      {probeRows.length > 0 && (
        <Well className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
          <Metric label="Probed" value={probeRows.length} size="lg" />
          <Metric label="Answering" value={probeRows.length - failing} size="lg" />
          <Metric label="Failing" value={failing} size="lg" />
        </Well>
      )}

      <Section title="Service probes" count={probeRows.length} note={probeRows.length ? "Worst first" : undefined}>
        {probeRows.length === 0 ? (
          <EmptyState title="No probes configured">
            No application has a URL to probe, so nothing here says whether they are up. Set the application URLs in the dashboard&apos;s environment (see <Code>.env.example</Code>) and they will appear on the next sample.
          </EmptyState>
        ) : (
          <>
            <div className="flex flex-col border-b border-seam">
              {probeRows.map(({ key, probe, status }) => {
                const tlsApplies = typeof probe.url !== "string" || !probe.url.startsWith("http://");
                return (
                  <div key={key} className="grid grid-cols-1 items-center gap-x-5 gap-y-3 border-t border-seam px-1 py-3.5 md:grid-cols-[128px_minmax(0,1fr)] xl:grid-cols-[128px_minmax(0,1fr)_minmax(0,1.5fr)]">
                    <div><Stamp status={status} /></div>
                    <div className="min-w-0">
                      <p className="m-0 text-base font-semibold">{probe.display ?? key}</p>
                      {probe.url
                        ? <p className="m-0 mt-0.5 break-all font-mono text-xs text-graphite">{probe.url}</p>
                        : <Readout value={null} state="NOT_CONFIGURED" size="sm" note="no URL" className="mt-1" />}
                      {probe.success === false && probe.error && (
                        <p className="m-0 mt-1.5 text-sm leading-normal text-silk-dim text-pretty">
                          {probe.failed_stage && probe.failed_stage !== "unknown" && <span className="panel-label mr-2">Failed at {probe.failed_stage}</span>}
                          {probe.error}
                        </p>
                      )}
                    </div>
                    <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-5 md:col-start-2 xl:col-start-auto">
                      <Metric label="HTTP" value={probe.status_code ?? null} size="sm" note={stageNote(probe, "http")} />
                      <Metric label="Latency" value={ms(probe.latency_ms)} unit="ms" size="sm" note={stageNote(probe, "http")} />
                      <Metric label="DNS" value={ms(probe.dns_ms)} unit="ms" size="sm" note={stageNote(probe, "dns")} />
                      <Metric label="TCP" value={ms(probe.connect_ms)} unit="ms" size="sm" note={stageNote(probe, "tcp")} />
                      {tlsApplies
                        ? <Metric label="TLS expiry" value={probe.tls_days_remaining != null ? Math.round(probe.tls_days_remaining) : null} unit="d" size="sm" />
                        : <Metric label="TLS expiry" value={null} state="NOT_APPLICABLE" note="plain HTTP" size="sm" />}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="m-0 max-w-[75ch] text-sm leading-normal text-silk-dim">
              Stage timings are kept separate on purpose: a DNS failure and an application returning 500 are different problems.
            </p>
            {source && <Source>Probed by {source}.</Source>}
          </>
        )}
      </Section>
    </div>
  );
}
