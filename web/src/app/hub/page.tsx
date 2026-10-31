"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { AgendaPanel, ClockPanel, CountdownStrip, LABEL, ListsPanel, PANEL, WeatherPanel } from "@/components/hub/panels";
import { Lamp, Void } from "@/components/instrument";
import type { CalendarStatus, Countdown, HubEvent } from "@/lib/hub/hub";
import { inWindow } from "@/lib/hub/night";
import type { ListItem } from "@/lib/hub/store";
import type { PlexSession } from "@/lib/integrations";
import { Status } from "@/lib/status";
import type { FeedItem, Weather } from "@/lib/widgets";

// The family screen. It is read from across a room and occasionally touched:
// big type, few words, every control at least finger-sized, and nothing that
// needs hover. Server health is one quiet line, not the point of the page.

interface HubData {
  buildId: string | null;
  title: string;
  timezone: string;
  today: string;
  night: string;
  photoSeconds: number;
  photos: { configured: boolean; count: number; error: string };
  calendar: { events: HubEvent[]; calendars: CalendarStatus[] };
  weather: { configured: boolean; ok: boolean; error: string; data: Weather | null } | null;
  headlines: FeedItem[];
  lists: { lists: string[]; items: ListItem[] };
  countdowns: Countdown[];
  nowPlaying: PlexSession[];
  health: { status: string; attention: { status: string; title: string }[]; collectedAt: number | null };
  generatedAt: number;
}

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

/** Data older than this means the server is unreachable; say so instead of showing yesterday as today. */
const OFFLINE_AFTER_MS = 5 * 60_000;

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Two stacked layers crossfading, so a photo never pops in half-loaded. */
function PhotoBackdrop({ enabled, seconds }: { enabled: boolean; seconds: number }) {
  const { data } = useSWR<{ ids: string[] }>(enabled ? "/api/hub/photos" : null, fetcher, { refreshInterval: 30 * 60_000, revalidateOnFocus: false });
  const ids = useMemo(() => data?.ids ?? [], [data]);
  const [layers, setLayers] = useState<[string | null, string | null]>([null, null]);
  const [front, setFront] = useState(0);
  const frontRef = useRef(0);
  const index = useRef(0);

  useEffect(() => {
    if (ids.length === 0) return;
    const show = () => {
      const id = ids[index.current % ids.length];
      index.current += 1;
      const img = new Image();
      img.onload = () => {
        // Load into the hidden layer, then flip which layer is visible.
        const next = 1 - frontRef.current;
        frontRef.current = next;
        setLayers(previous => (next === 0 ? [img.src, previous[1]] : [previous[0], img.src]));
        setFront(next);
      };
      img.src = `/api/hub/photo/${id}`;
    };
    show();
    const timer = setInterval(show, Math.max(10, seconds) * 1000);
    return () => clearInterval(timer);
  }, [ids, seconds]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-enamel" aria-hidden>
      {layers.map((src, i) => (
        <div key={i} className="absolute inset-0 bg-cover bg-center transition-opacity duration-[2500ms] ease-in-out motion-reduce:transition-none"
          style={{ backgroundImage: src ? `url(${src})` : undefined, opacity: src && i === front ? 1 : 0 }} />
      ))}
      {/* Darken the edges where the panels sit; the middle of the photo stays bright. */}
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,0.55),rgba(0,0,0,0.15)_35%,rgba(0,0,0,0.15)_65%,rgba(0,0,0,0.55))]" />
    </div>
  );
}

function StatusLine({ data, offline }: { data: HubData; offline: boolean }) {
  const { health, nowPlaying, headlines } = data;
  const [headline, setHeadline] = useState(0);
  useEffect(() => {
    if (headlines.length < 2) return;
    const timer = setInterval(() => setHeadline(i => (i + 1) % headlines.length), 12_000);
    return () => clearInterval(timer);
  }, [headlines.length]);

  const issue = health.attention[0];
  // Offline: the last known status is not current, so the lamp goes void.
  const lamp = offline ? Status.UNKNOWN : health.status;
  const playing = nowPlaying.filter(session => session.state !== "paused");

  return (
    <footer className="flex min-w-0 items-center gap-[1.5em] rounded-[3px] border border-seam bg-[rgb(20_25_23/0.8)] px-[1.2em] py-[0.55em] text-[clamp(0.8rem,1vmax,1.2rem)] text-silk-dim backdrop-blur-md">
      <span className="flex shrink-0 items-center gap-[0.6em] text-silk">
        <Lamp status={lamp} className="size-[0.6em]" />
        {offline ? "Can't reach the server: showing the last update" : issue ? `Server: ${issue.title}` : health.status === Status.UNKNOWN ? "Server status unknown" : "Server healthy"}
      </span>
      {playing.length > 0 && (
        <span className="flex min-w-0 shrink items-baseline gap-[0.6em] truncate">
          <span className={LABEL}>Playing</span>
          <span className="truncate">{playing.map(session => session.title).join(" · ")}</span>
        </span>
      )}
      {headlines.length > 0 && (
        <span className="ml-auto min-w-0 truncate">{headlines[headline % headlines.length]?.title}</span>
      )}
    </footer>
  );
}

export default function HubPage() {
  const now = useNow();
  const [lastGood, setLastGood] = useState<number | null>(null);
  const firstBuild = useRef<string | null>(null);
  const { data, error, mutate } = useSWR<HubData>("/api/hub", fetcher, {
    refreshInterval: 60_000, keepPreviousData: true, revalidateOnFocus: false,
    onSuccess: fresh => {
      // Arrival time on this clock, not the server's: a Pi with a drifting clock must not look offline.
      setLastGood(Date.now());
      // A redeploy changes the build id: reload so an unattended screen never runs old UI against a new API.
      if (firstBuild.current && fresh.buildId && fresh.buildId !== firstBuild.current) window.location.reload();
      firstBuild.current ??= fresh.buildId;
    },
  });
  const [frameMode, setFrameMode] = useState(false);
  const [listError, setListError] = useState("");

  // Photos-only mode times out so the calendar is never hidden for long by a stray tap.
  useEffect(() => {
    if (!frameMode) return;
    const timer = setTimeout(() => setFrameMode(false), 10 * 60_000);
    return () => clearTimeout(timer);
  }, [frameMode]);

  const listAction = useCallback(async (body: Record<string, unknown>) => {
    setListError("");
    try {
      const response = await fetch("/api/hub/lists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) setListError(result.error ?? "Could not save.");
      if (result.items) await mutate(current => current ? { ...current, lists: { lists: result.lists, items: result.items } } : current, { revalidate: false });
    } catch {
      setListError("Can't reach the server, so that wasn't saved.");
    }
  }, [mutate]);

  const offline = Boolean(error) && lastGood !== null && now !== null && now.getTime() - lastGood > OFFLINE_AFTER_MS;
  const timezone = data?.timezone ?? "Australia/Melbourne";
  const night = Boolean(data && now && data.night && inWindow(data.night, now, timezone));

  if (!data) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-enamel p-8 text-[clamp(1rem,1.4vmax,1.6rem)] text-silk-dim">
        {error ? <Void state="ERROR" note={`Can't reach the dashboard: ${String(error)}`} /> : <Void state="ACQUIRING" note="Loading the home hub" />}
      </div>
    );
  }

  if (night) {
    // Night: a dim clock and the first thing tomorrow, nothing bright enough to light a room.
    const next = data.calendar.events.find(event => event.start > Date.now() && !event.allDay);
    return (
      <div className="fixed inset-0 z-50 flex cursor-none flex-col items-center justify-center bg-black text-silk">
        {/* Opacity, not colour: the clock sets its own text colour, and the whole screen must stay dim. */}
        <div className="flex flex-col items-center opacity-35">
          <ClockPanel now={now} timezone={timezone} title={data.title} onTap={() => undefined} />
          {next && (
            <p className="m-0 mt-6 text-[clamp(1rem,1.5vmax,1.8rem)]">
              Next: {next.title} · <span className="font-mono">{new Date(next.start).toLocaleString("en-AU", { timeZone: timezone, weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
            </p>
          )}
        </div>
      </div>
    );
  }

  const calendarErrors = data.calendar.calendars.filter(calendar => !calendar.ok).map(calendar => `${calendar.name}: ${calendar.error}`);

  return (
    <div className="fixed inset-0 z-50 cursor-none select-none overflow-hidden bg-black font-sans text-silk [@media(pointer:fine)]:cursor-auto">
      <PhotoBackdrop enabled={data.photos.configured} seconds={data.photoSeconds} />

      {frameMode ? (
        <div className="absolute bottom-[4vh] left-[3vmax]">
          <ClockPanel now={now} timezone={timezone} title={data.title} onTap={() => setFrameMode(false)} />
        </div>
      ) : (
        <div className="relative grid h-full grid-cols-1 grid-rows-[auto_minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-[clamp(0.75rem,1.4vmax,1.75rem)] overflow-hidden p-[clamp(1rem,2.2vmax,2.75rem)] landscape:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)] landscape:grid-rows-[minmax(0,1fr)_auto]">
          <div className="flex min-h-0 flex-col gap-[clamp(0.75rem,1.4vmax,1.75rem)]">
            <ClockPanel now={now} timezone={timezone} title={data.title} onTap={() => data.photos.configured && setFrameMode(true)} />
            {data.weather?.data ? <WeatherPanel weather={data.weather.data} /> : data.weather?.configured && (
              <section className={`${PANEL} flex flex-col gap-3`} aria-label="Weather">
                <h2 className={LABEL}>Weather</h2>
                {data.weather.error ? <Void state="ERROR" note={data.weather.error} /> : <Void state="ACQUIRING" />}
              </section>
            )}
          </div>

          <AgendaPanel
            events={data.calendar.events}
            today={data.today}
            timezone={timezone}
            now={now?.getTime() ?? Date.now()}
            days={7}
            setupHint={data.calendar.calendars.length === 0}
            errors={calendarErrors}
          />

          {/* Landscape: lists over countdowns. Portrait: side by side under the agenda. */}
          <div className="flex min-h-0 flex-col gap-[clamp(0.75rem,1.4vmax,1.75rem)] portrait:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
              <ListsPanel lists={data.lists.lists} items={data.lists.items} onAction={listAction} />
              {listError && (
                <p role="alert" className="m-0 flex items-center gap-[0.6em] rounded-[3px] border border-seam bg-[rgb(20_25_23/0.85)] px-[1em] py-[0.5em] text-[clamp(0.85rem,1vmax,1.2rem)] text-silk backdrop-blur-md">
                  <Lamp status="WARNING" label="Warning" className="size-[0.6em]" />{listError}
                </p>
              )}
            </div>
            <div className="portrait:w-[38%] portrait:shrink-0">
              <CountdownStrip countdowns={data.countdowns} />
            </div>
          </div>

          <div className="landscape:col-span-3">
            <StatusLine data={data} offline={offline} />
          </div>
        </div>
      )}
    </div>
  );
}
