import { NextResponse } from "next/server";
import { getSettings } from "@/lib/config";
import { getHubCalendar, getPhotoIds, parseCountdowns, photosConfigured } from "@/lib/hub/hub";
import { dateKey } from "@/lib/hub/ical";
import { getLists } from "@/lib/hub/store";
import { getMediaOverview } from "@/lib/integrations";
import { readBuildId } from "@/lib/live";
import { getSnapshot } from "@/lib/runtime";
import { Status } from "@/lib/status";
import { getWidgetData } from "@/lib/widgets";

export const dynamic = "force-dynamic";

/** Resolve within `ms` or give up: the clock and calendar must not wait on a slow collector. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
}

export async function GET() {
  const settings = getSettings();
  const tz = settings.host.timezone;
  const today = dateKey(Date.now(), tz);

  const [calendar, widgets, media, snapshot, photos] = await Promise.allSettled([
    getHubCalendar(settings),
    getWidgetData(settings),
    within(getMediaOverview(settings), 8000),
    within(getSnapshot(90), 5000),
    getPhotoIds(settings),
  ]);

  const value = <T,>(result: PromiseSettledResult<T>): T | null => (result.status === "fulfilled" ? result.value : null);
  const snap = value(snapshot);
  const attention = (snap?.alerts ?? [])
    .filter(alert => alert.status === Status.CRITICAL || alert.status === Status.WARNING)
    .slice(0, 3)
    .map(alert => ({ status: alert.status, title: alert.title }));

  return NextResponse.json({
    buildId: readBuildId(),
    title: settings.hub.title,
    timezone: tz,
    today,
    night: settings.hub.night,
    photoSeconds: settings.hub.photo_seconds,
    photos: { configured: photosConfigured(settings), count: value(photos)?.ids.length ?? 0, error: value(photos)?.error ?? "" },
    calendar: value(calendar) ?? { events: [], calendars: [] },
    weather: value(widgets)?.weather ?? null,
    headlines: value(widgets)?.rss.data ?? [],
    lists: getLists(settings),
    countdowns: parseCountdowns(settings.hub.countdowns, today),
    nowPlaying: value(media)?.plex.data ?? [],
    health: snap
      ? { status: snap.health.status, attention, collectedAt: snap.collected_at }
      : { status: Status.UNKNOWN, attention: [], collectedAt: null },
    generatedAt: Date.now() / 1000,
  });
}
