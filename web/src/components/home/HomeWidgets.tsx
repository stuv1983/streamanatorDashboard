"use client";

import { EmptyState, Lamp, Meter, Panel, Readout, Stamp, Void } from "@/components/instrument";
import { WeatherIcon } from "@/components/hub/panels";
import type { CalendarEntry, DownloadClient, MediaOverview, PlexSession, Section } from "@/lib/integrations";
import type { WidgetData } from "@/lib/widgets";

export function humanRate(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function humanEta(seconds: number | null): string {
  if (seconds == null) return "no ETA";
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function relativeDay(at: number): string {
  const date = new Date(at * 1000);
  const today = new Date();
  const days = Math.round((new Date(date.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / 86400000);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  return date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

const round = (v: number | null | undefined) => (v == null ? null : Math.round(v));

/** A small silkscreened tag for a state that isn't a health status (paused, TV, film). */
function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-[2px] border border-seam px-1.5 py-[3px] font-panel text-[9px] uppercase leading-none tracking-[0.12em] text-silk-dim">
      {children}
    </span>
  );
}

export function Widget({ title, aside, children }: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Panel as="section" title={title} action={aside ? <div className="text-[13px] text-graphite">{aside}</div> : undefined}>
      {children}
    </Panel>
  );
}

/** Shows why a section is empty: not set up, failing, or genuinely idle. */
function SectionNote({ section, idle }: { section?: Section<unknown>; idle: string }) {
  if (!section) return <Void state="ACQUIRING" />;
  if (!section.configured) return <Void state="NOT_CONFIGURED" note={section.error || undefined} />;
  if (!section.ok) return <Void state="ERROR" note={section.error || undefined} />;
  return <EmptyState title={idle} className="px-4 py-3.5 [&>p]:text-[15px] [&>p]:font-normal [&>p]:text-silk-dim" />;
}

export function NowPlaying({ media }: { media?: MediaOverview }) {
  const sessions: PlexSession[] = media?.plex.data ?? [];
  return (
    <Widget title="Now playing" aside={sessions.length ? <span className="font-mono">{sessions.length} stream{sessions.length === 1 ? "" : "s"}</span> : undefined}>
      {sessions.length === 0 ? <SectionNote section={media?.plex} idle="Nothing is playing on Plex." /> : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {sessions.map((session, i) => (
            <li key={`${session.user}-${session.title}-${i}`} className="flex flex-col gap-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold">{session.title}</span>
                {session.state === "paused" && <Tag>Paused</Tag>}
                {session.transcoding && <Stamp status="WARNING" label="Transcode" />}
              </div>
              {session.subtitle && <p className="m-0 truncate text-[13px] text-silk-dim">{session.subtitle}</p>}
              <div className="flex items-center gap-3">
                <Meter value={session.progress} label={`${session.title} progress`} className="flex-1" />
                {session.progress != null && <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-silk-dim">{session.progress.toFixed(0)}%</span>}
              </div>
              <p className="m-0 truncate text-xs text-graphite">{[session.user, session.player].filter(Boolean).join(" · ")}</p>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

function ClientQueue({ name, section, idle }: { name: string; section?: Section<DownloadClient | null>; idle: string }) {
  const client = section?.data;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-[15px] font-semibold">{name}</span>
        {client?.paused && <Tag>Paused</Tag>}
        {client && !client.paused && (
          <span className="ml-auto flex gap-3 font-mono text-xs tabular-nums text-silk-dim">
            <span><span className="text-graphite">down</span> {client.speedBytes != null ? humanRate(client.speedBytes) : "n/a"}</span>
            {client.uploadBytes != null && <span><span className="text-graphite">up</span> {humanRate(client.uploadBytes)}</span>}
          </span>
        )}
      </div>
      {!client || client.items.length === 0 ? <SectionNote section={section} idle={idle} /> : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {client.items.slice(0, 5).map((item, i) => (
            <li key={`${item.name}-${i}`} className="flex flex-col gap-1.5">
              <div className="flex gap-3 text-[13px]">
                <span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-silk-dim">{item.progress.toFixed(0)}% · {humanEta(item.etaSeconds)}</span>
              </div>
              <Meter value={item.progress} label={`${item.name} progress`} />
            </li>
          ))}
          {client.items.length > 5 && <li className="text-xs text-graphite">+{client.items.length - 5} more in the queue</li>}
        </ul>
      )}
    </div>
  );
}

export function Downloads({ media }: { media?: MediaOverview }) {
  return (
    <Widget title="Downloads">
      <div className="flex flex-col gap-5">
        <ClientQueue name="SABnzbd" section={media?.sabnzbd} idle="Nothing downloading." />
        <div className="border-t border-seam" aria-hidden />
        <ClientQueue name="qBittorrent" section={media?.qbittorrent} idle="Nothing downloading." />
      </div>
    </Widget>
  );
}

export function Upcoming({ media }: { media?: MediaOverview }) {
  const entries: CalendarEntry[] = media?.calendar.data ?? [];
  const partial = media?.calendar.ok && media.calendar.error;
  return (
    <Widget title="Upcoming" aside={partial ? <span className="flex items-center gap-2 text-silk-dim"><Lamp status="WARNING" label="Warning" />{media.calendar.error}</span> : undefined}>
      {entries.length === 0 ? <SectionNote section={media?.calendar} idle="Nothing due in the next week." /> : (
        <ul className="m-0 flex list-none flex-col divide-y divide-seam p-0">
          {entries.slice(0, 12).map((entry, i) => (
            <li key={`${entry.source}-${entry.title}-${entry.at}-${i}`} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
              <span className="w-11 shrink-0"><Tag>{entry.source === "sonarr" ? "TV" : "Film"}</Tag></span>
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-[15px]">{entry.title}</p>
                {entry.detail && <p className="m-0 truncate text-xs text-silk-dim">{entry.detail}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                <span className="font-mono tabular-nums text-silk-dim">{relativeDay(entry.at)}</span>
                {entry.hasFile && <span className="flex items-center gap-1.5 text-silk-dim"><Lamp status="HEALTHY" />Downloaded</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

export function Headlines({ widgets }: { widgets?: WidgetData }) {
  const rss = widgets?.rss;
  const items = rss?.data ?? [];
  return (
    <Widget title="Headlines">
      {items.length === 0 ? (
        !rss ? <Void state="ACQUIRING" />
          : !rss.configured ? <Void state="NOT_CONFIGURED" note={rss.error || undefined} />
            : !rss.ok ? <Void state="ERROR" note={rss.error || undefined} />
              : <EmptyState title={rss.error || "No headlines right now."} className="px-4 py-3.5 [&>p]:text-[15px] [&>p]:font-normal [&>p]:text-silk-dim" />
      ) : (
        <ul className="m-0 grid list-none gap-x-8 gap-y-3 p-0 md:grid-cols-2">
          {items.map((item, i) => (
            <li key={`${item.link}-${i}`} className="flex min-w-0 flex-col gap-0.5">
              {item.link
                ? <a href={item.link} target="_blank" rel="noopener noreferrer" className="text-[15px] leading-snug text-silk hover:text-trace hover:underline">{item.title}</a>
                : <span className="text-[15px] leading-snug">{item.title}</span>}
              <span className="text-xs text-graphite">{item.feed}{item.at ? <> · <span className="font-mono">{relativeDay(item.at)}</span></> : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

/** Current conditions and the next three days, as a readout window for the page header. */
export function WeatherChip({ widgets }: { widgets?: WidgetData }) {
  const weather = widgets?.weather;
  if (!widgets) {
    return <WeatherWell><Void state="ACQUIRING" /></WeatherWell>;
  }
  if (!weather?.configured) {
    return <WeatherWell><Void state="NOT_CONFIGURED" note={weather?.error || "Set a weather location in Admin to show the forecast."} /></WeatherWell>;
  }
  const data = weather.data;
  if (!data) {
    return <WeatherWell><Void state={weather.ok ? "ACQUIRING" : "ERROR"} note={weather.error || undefined} /></WeatherWell>;
  }
  return (
    <WeatherWell location={data.location}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          <WeatherIcon code={data.code} isDay={data.isDay} className="h-8 w-8 shrink-0 text-silk-dim" />
          <Readout value={round(data.temperature)} unit="°C" size="lg" />
          <div className="flex flex-col">
            <span className="text-[15px]">{data.summary}</span>
            {data.apparent != null && <span className="text-xs text-silk-dim">feels <span className="font-mono">{Math.round(data.apparent)}°</span></span>}
          </div>
        </div>
        <ul className="m-0 flex list-none gap-5 border-l border-seam p-0 pl-5">
          {data.days.slice(1, 4).map(day => (
            <li key={day.date} className="flex flex-col gap-0.5">
              <span className="panel-label">{new Date(`${day.date}T12:00:00`).toLocaleDateString([], { weekday: "short" })}</span>
              <span className="font-mono text-sm tabular-nums">
                {day.max != null ? `${Math.round(day.max)}°` : "n/a"} <span className="text-graphite">{day.min != null ? `${Math.round(day.min)}°` : "n/a"}</span>
              </span>
              <span className="max-w-[7rem] truncate text-xs text-silk-dim" title={day.summary}>{day.summary}</span>
            </li>
          ))}
        </ul>
      </div>
    </WeatherWell>
  );
}

function WeatherWell({ location, children }: { location?: string; children: React.ReactNode }) {
  return (
    <div className="well flex min-w-0 flex-1 flex-col gap-2.5 px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="panel-label">Weather</span>
        {location && <span className="truncate text-xs text-graphite">{location}</span>}
      </div>
      {children}
    </div>
  );
}
