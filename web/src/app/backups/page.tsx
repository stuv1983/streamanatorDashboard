"use client";

import useSWR from "swr";
import {
  Acquiring, Code, EmptyState, ErrorState, Facts, Lamp, Meter, Metric, PageHeader, Panel, PanelLabel, Readout, Section, Stamp, Well,
} from "@/components/instrument";
import type { Snapshot } from "@/lib/snapshot";
import { Status } from "@/lib/status";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Bytes as [number, unit] so the unit can sit in graphite beside the readout. */
function bytesParts(bytes: number): [string, string] {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0; let v = Math.abs(bytes);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return [`${bytes < 0 ? "-" : ""}${v.toFixed(1)}`, units[i]];
}

function humanBytes(bytes: number): string {
  const [v, u] = bytesParts(bytes);
  return `${v} ${u}`;
}

function humanAge(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000) - ts;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
}

function sampledAt(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

function basename(p: string | undefined): string {
  return p ? p.split("/").filter(Boolean).pop() ?? p : "";
}

/** Renders `code` spans in collector text, and bare shell commands, as mono. */
function withCode(text: string): React.ReactNode {
  if (!text) return text;
  if (!text.includes("`") && /^(docker|sudo|systemctl|journalctl|curl)\s/.test(text)) return <Code>{text}</Code>;
  return text.split("`").map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : part));
}

/**
 * BackupStatus exposes age, growth and used-percent as class getters, which
 * don't survive JSON. Read them when present, otherwise derive the same
 * figures from the fields that do.
 */
function derived(job: any) {
  const ageDays: number | null = job.age_days ?? (job.latest?.modified_at ? Math.max(0, Date.now() / 1000 - job.latest.modified_at) / 86400 : null);
  const usedPercent: number | null = job.destination_used_percent
    ?? (job.destination_total_bytes ? (100 * (job.destination_total_bytes - (job.destination_free_bytes || 0))) / job.destination_total_bytes : null);
  const growth: number | null = job.growth_bytes
    ?? (job.latest && job.previous && job.latest.size_known !== false && job.previous.size_known !== false ? job.latest.size_bytes - job.previous.size_bytes : null);
  return { ageDays, usedPercent, growth };
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
        alert.since && ["Since", <span key="s" className="font-mono">{formatTs(alert.since)}</span>],
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

export default function BackupsPage() {
  const { data, error, isLoading } = useSWR<Snapshot>("/api/snapshot", fetcher, { refreshInterval: 60000, keepPreviousData: true });

  const component = data?.components?.backups;
  const time = sampledAt(data?.collected_at);
  const header = (
    <PageHeader
      group="Operations"
      title="Backups"
      description="Whether each backup ran on time, looks the right size and passed its integrity check."
      status={component?.status}
      meta={[(component?.readings as any[] | undefined)?.find((r: any) => r.source)?.source, time && `sampled ${time}`].filter(Boolean).join(" · ") || undefined}
    >
      <p className="m-0 max-w-[75ch] text-sm leading-normal text-silk-dim">
        The RAID array is not a backup. It survives a single disk failure, not deletion, corruption, ransomware or fire.
      </p>
    </PageHeader>
  );

  if (error) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <ErrorState title="The snapshot didn't load" detail={error}>Check that the dashboard server is running and that <Code>/api/snapshot</Code> responds.</ErrorState>
      </div>
    );
  }
  if (isLoading && !data) return <div className="flex flex-col gap-8">{header}<Acquiring rows={3} /></div>;

  const snapshot = data!;
  const raw = (snapshot.raw?.backups ?? {}) as Record<string, any>;
  const jobs: any[] = raw.jobs ?? [];
  const readings: any[] = (component?.readings as any[]) ?? [];
  const backupAlerts = snapshot.alerts?.filter((a: any) => a.key?.startsWith("backup.")) ?? [];

  return (
    <div className="flex flex-col gap-10">
      {header}

      <Section title="Jobs" count={jobs.length}>
        {jobs.length === 0 ? (
          <EmptyState title="No backup jobs configured">
            Nothing on this page can say whether data is backed up. Point the backup directories in the dashboard&apos;s environment (for example <Code>NIGHTLY_BACKUP_DIR</Code>) at where the jobs write.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-4">
            {jobs.map((job: any, idx: number) => {
              const reading = readings.find((r: any) => r.key === `backup.${job.key}`);
              const integrityReading = readings.find((r: any) => r.key === `backup.integrity.${job.key}`);
              const { ageDays, usedPercent, growth } = derived(job);
              const size = job.latest?.size_bytes != null && job.latest?.size_known !== false ? bytesParts(job.latest.size_bytes) : null;
              const free = job.destination_free_bytes != null ? bytesParts(job.destination_free_bytes) : null;
              const growthParts = growth != null ? bytesParts(growth) : null;
              const files = [job.latest, job.previous].filter(Boolean);

              return (
                <Panel key={job.key ?? idx}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="m-0 text-lg font-semibold">{job.display ?? job.key}</p>
                      <p className="m-0 mt-0.5 break-all font-mono text-xs text-graphite">
                        {job.directory}{job.schedule ? ` · ${job.schedule}` : ""}
                      </p>
                    </div>
                    {reading ? <Stamp status={reading.status} /> : <Stamp status="UNKNOWN" label="NOT ASSESSED" />}
                  </div>
                  {reading?.detail && <p className="m-0 text-[15px] leading-normal text-silk-dim text-pretty">{reading.detail}</p>}
                  {job.error && (
                    <div className="flex flex-wrap items-center gap-3">
                      <Stamp status={Status.CRITICAL} label="SCAN FAILED" />
                      <span className="text-sm">{job.error}</span>
                    </div>
                  )}

                  <Well className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                    <Metric
                      label="Last backup"
                      value={job.latest?.modified_at ? formatTs(job.latest.modified_at) : null}
                      size="sm"
                      note={job.latest ? undefined : "no backup file found"}
                    />
                    <Metric label="Age" value={ageDays != null ? ageDays.toFixed(1) : null} unit="days" note={job.latest ? undefined : "no backup"} />
                    <Metric label="Size" value={size?.[0] ?? null} unit={size?.[1]} note={job.latest ? "size unknown" : "no backup"} />
                    <Metric label="Retained" value={job.retained_count ?? null} />
                    <Metric label="Destination free" value={free?.[0] ?? null} unit={free?.[1]} />
                    {usedPercent != null && (
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-xs text-graphite">Destination used</span>
                        <Readout value={usedPercent.toFixed(0)} unit="%" />
                        <Meter value={usedPercent} label="Destination used" className="mt-1" />
                      </div>
                    )}
                    {growthParts && (
                      <Metric label="Size change" value={`${growth! > 0 ? "+" : ""}${growthParts[0]}`} unit={growthParts[1]} hint="Latest against previous" />
                    )}
                  </Well>

                  {integrityReading && (
                    <div className="flex flex-col gap-2 border-t border-seam pt-3.5">
                      <div className="flex flex-wrap items-center gap-3">
                        <PanelLabel>Integrity</PanelLabel>
                        <Stamp status={integrityReading.status} />
                        {integrityReading.extra?.checked_at && (
                          <span className="font-mono text-xs text-graphite">checked {humanAge(integrityReading.extra.checked_at)}</span>
                        )}
                      </div>
                      {integrityReading.state && integrityReading.state !== "OK"
                        ? <Readout value={null} state={integrityReading.state} note={integrityReading.detail} size="sm" />
                        : integrityReading.detail && <p className="m-0 text-[15px] leading-normal">{integrityReading.detail}</p>}
                    </div>
                  )}

                  {job.retained_count > 0 && job.latest && (
                    <details className="group border-t border-seam pt-1">
                      <summary className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-silk-dim hover:text-silk">
                        Retained backups <span className="font-mono">· {job.retained_count}</span>
                        {job.retained_count > files.length && <span className="text-graphite">(newest {files.length} shown)</span>}
                      </summary>
                      <div className="mt-1 flex flex-col">
                        {files.map((f: any) => (
                          <div key={f.path ?? f.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-t border-seam py-2 font-mono text-xs sm:grid-cols-[minmax(0,1fr)_100px_90px]">
                            <span className="truncate" title={f.path}>{f.name ?? basename(f.path)}</span>
                            <span className="text-right text-silk-dim">{f.size_known === false ? "size unknown" : humanBytes(f.size_bytes)}</span>
                            <span className="col-span-2 text-graphite sm:col-span-1 sm:text-right">{humanAge(f.modified_at)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </Panel>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Backup alerts" count={backupAlerts.length}>
        {backupAlerts.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-seam px-1 py-3.5">
            <Stamp status={Status.HEALTHY} label="CLEAR" />
            <span className="text-[15px] text-silk-dim">No backup alerts are active in this snapshot.</span>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {backupAlerts.map((alert: any) => <AlertPanel key={alert.key} alert={alert} all={snapshot.alerts ?? []} />)}
          </div>
        )}
      </Section>
    </div>
  );
}
