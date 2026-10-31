"use client";

import { EmptyState, PageHeader, Readout, Section, worstStatus } from "@/components/instrument";
import { ReadingCards, SnapshotBoundary, useSnapshot } from "@/components/snapshot-ui";

const mediaKeys = ["plex", "immich", "sabnzbd", "sonarr", "radarr", "prowlarr", "qbittorrent"];

function mediaReadings(snapshot: any): any[] {
  const appReadings = snapshot?.components?.applications?.readings ?? [];
  return appReadings.filter((reading: any) => mediaKeys.some((key) => reading.key?.toLowerCase().includes(key)));
}

function sampledAt(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

export default function MediaPage() {
  const result = useSnapshot();
  const headerReadings = mediaReadings(result.data);
  const time = sampledAt(result.data?.collected_at);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        group="Services"
        title="Media"
        description="Whether Plex, Immich and the download automation stack are answering their probes."
        status={headerReadings.length ? worstStatus(headerReadings.map((r: any) => r.status)) : undefined}
        meta={[headerReadings.find((r: any) => r.source)?.source, time && `sampled ${time}`].filter(Boolean).join(" · ") || undefined}
      />
      <SnapshotBoundary {...result}>{(snapshot) => {
        const readings = mediaReadings(snapshot);
        const probes = snapshot.raw.applications?.probes ?? {};
        const rows = Object.entries(probes).filter(([key]) => mediaKeys.some((media) => key.toLowerCase().includes(media))).map(([service, probe]: [string, any]) => ({
          service, status: probe.statusCode ?? probe.status_code, latency_ms: probe.latencyMs ?? probe.latency_ms, reachable: probe.reachable, error: probe.error,
          // Kept for display only: probes report `success`, not `reachable`.
          success: probe.success as boolean | undefined,
        }));

        return (
          <div className="flex flex-col gap-10">
            <Section title="Media services" count={readings.length}>
              <ReadingCards readings={readings} />
            </Section>

            <Section title="Endpoint probes" count={rows.length}>
              {rows.length === 0 ? (
                <EmptyState title="No media endpoints configured">
                  None of Plex, Immich, SABnzbd, Sonarr, Radarr, Prowlarr or qBittorrent has a URL to probe. Set their URLs in the dashboard&apos;s environment to check them here.
                </EmptyState>
              ) : (
                <div className="overflow-x-auto rounded-[3px] border border-seam">
                  <table className="w-full text-sm">
                    <thead className="bg-well">
                      <tr className="border-b border-seam">
                        {["Service", "HTTP", "Latency", "Reachable", "Error"].map((h) => (
                          <th key={h} className="whitespace-nowrap px-3 py-2.5 text-left font-panel text-[9.5px] font-normal uppercase tracking-[0.12em] text-graphite">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const reachable = row.reachable ?? row.success;
                        return (
                          <tr key={row.service} className="border-b border-seam last:border-0">
                            <td className="whitespace-nowrap px-3 py-2.5 font-mono font-semibold">{row.service}</td>
                            <td className="px-3 py-2.5"><Readout value={row.status ?? null} size="sm" /></td>
                            <td className="whitespace-nowrap px-3 py-2.5"><Readout value={row.latency_ms != null ? Math.round(row.latency_ms) : null} unit="ms" size="sm" /></td>
                            <td className="px-3 py-2.5"><Readout value={reachable == null ? null : reachable ? "yes" : "no"} size="sm" /></td>
                            <td className="min-w-[200px] px-3 py-2.5 text-[13px] leading-normal text-silk-dim">
                              {row.error || <span className="text-graphite">none</span>}
                            </td>
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
