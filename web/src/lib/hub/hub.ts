/**
 * Data for the /hub home display: calendars, countdowns and photos, plus a
 * thin slice of what the rest of the dashboard already knows (weather,
 * headlines, Plex, server health).
 *
 * Feed URLs and the Immich key stay on the server. The browser only ever sees
 * event titles and opaque photo ids, so a kiosk with its screen showing
 * leaks nothing a visitor couldn't read off the wall anyway.
 */

import { Settings } from '../config';
import { endpointBase, getMediaOverview, type CalendarEntry } from '../integrations';
import { dateKey, expandCalendar, wallIn, type CalendarEvent } from './ical';

export interface HubEvent extends CalendarEvent {
    calendar: string;
    color: string;
}

export interface CalendarStatus {
    name: string;
    color: string;
    ok: boolean;
    error: string;
    count: number;
}

export interface Countdown {
    name: string;
    date: string;
    days: number;
}

// The dashboard's categorical palette (globals.css --series-*), in slot order.
export const CALENDAR_PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];

const FEED_TTL_MS = 10 * 60 * 1000;
const FEED_TIMEOUT_MS = 15000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;

const feedCache = new Map<string, { at: number; text: string }>();

async function fetchFeed(url: string): Promise<string> {
    const cached = feedCache.get(url);
    if (cached && Date.now() - cached.at < FEED_TTL_MS) return cached.text;
    try {
        const response = await fetch(url, {
            headers: { Accept: "text/calendar, */*", "User-Agent": "Streamanator-Hub" },
            signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(response.status === 404 ? "HTTP 404: the feed address has changed or been reset" : `HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > MAX_FEED_BYTES) throw new Error("Feed is larger than 10 MB");
        if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Not an iCalendar feed (check it is the iCal/ICS address)");
        feedCache.set(url, { at: Date.now(), text });
        return text;
    } catch (error) {
        // A feed that answered before keeps showing its last copy through a blip.
        if (cached) return cached.text;
        throw error;
    }
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.name === "TimeoutError" ? "Timed out" : error.message;
    return String(error);
}

function mediaEvents(entries: CalendarEntry[], tz: string): HubEvent[] {
    return entries.map(entry => {
        const start = entry.at * 1000;
        const end = start + (entry.source === "sonarr" ? 30 * 60 * 1000 : 0);
        return {
            uid: `${entry.source}-${entry.title}-${entry.at}`,
            title: entry.source === "sonarr" ? `${entry.title} · ${entry.detail}` : `${entry.title} · ${entry.detail}`,
            location: "",
            allDay: entry.source === "radarr",
            start, end,
            startDate: dateKey(start, tz),
            endDate: dateKey(start, tz),
            calendar: entry.source === "sonarr" ? "TV" : "Films",
            color: entry.source === "sonarr" ? "#898781" : "#6f6d68",
        };
    });
}

export async function getHubCalendar(settings: Settings): Promise<{ events: HubEvent[]; calendars: CalendarStatus[] }> {
    const tz = settings.host.timezone;
    const now = Date.now();
    // From local midnight today, so this morning's events are still listed.
    const today = wallIn(now, tz);
    const from = now - ((today.h * 60 + today.mi) * 60 + today.s) * 1000;
    const to = from + settings.hub.days * 86400000;

    const calendars: CalendarStatus[] = [];
    const events: HubEvent[] = [];
    await Promise.all(settings.hub.calendars.map(async (calendar, index) => {
        const color = calendar.color || CALENDAR_PALETTE[index % CALENDAR_PALETTE.length];
        const status: CalendarStatus = { name: calendar.name, color, ok: false, error: "", count: 0 };
        calendars[index] = status;
        try {
            const expanded = expandCalendar(await fetchFeed(calendar.url), from, to, tz);
            events.push(...expanded.map(event => ({ ...event, calendar: calendar.name, color })));
            status.ok = true;
            status.count = expanded.length;
        } catch (error) {
            status.error = errorText(error);
        }
    }));

    if (settings.hub.include_media_calendar) {
        try {
            const media = await getMediaOverview(settings);
            if (media.calendar.ok) {
                events.push(...mediaEvents(media.calendar.data, tz).filter(event => event.end >= from && event.start < to));
            }
        } catch {
            // Media is a garnish here; the family calendar must not depend on Sonarr.
        }
    }

    events.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
    return { events, calendars };
}

/** "Name|2026-12-25" once, or "Name|12-25" every year. Past one-offs drop off. */
export function parseCountdowns(raw: string, today: string): Countdown[] {
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    return raw.split(";").flatMap(entry => {
        const [name, value] = entry.split("|").map(part => part?.trim() ?? "");
        if (!name || !value) return [];
        let date = "";
        const yearly = value.match(/^(\d{2})-(\d{2})$/);
        if (yearly) {
            const year = Number(today.slice(0, 4));
            const thisYear = `${year}-${yearly[1]}-${yearly[2]}`;
            date = Date.parse(`${thisYear}T00:00:00Z`) >= todayMs ? thisYear : `${year + 1}-${yearly[1]}-${yearly[2]}`;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            date = value;
        }
        const target = Date.parse(`${date}T00:00:00Z`);
        if (!date || isNaN(target) || target < todayMs) return [];
        return [{ name, date, days: Math.round((target - todayMs) / 86400000) }];
    }).sort((a, b) => a.days - b.days);
}

// ─── Immich photos ───────────────────────────────────────────────────────────

const PHOTO_TTL_MS = 30 * 60 * 1000;
let photoCache: { at: number; ids: string[]; error: string } | null = null;

export const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function photosConfigured(settings: Settings): boolean {
    return Boolean(settings.hub.immich_api_key && settings.hub.photo_album_ids.length && endpointBase(settings, "immich"));
}

/** Image asset ids across the configured albums, cached for 30 minutes. */
export async function getPhotoIds(settings: Settings): Promise<{ ids: string[]; error: string }> {
    if (!photosConfigured(settings)) return { ids: [], error: "" };
    if (photoCache && Date.now() - photoCache.at < PHOTO_TTL_MS) return photoCache;
    const base = endpointBase(settings, "immich");
    const ids = new Set<string>();
    const errors: string[] = [];
    for (const album of settings.hub.photo_album_ids) {
        try {
            const response = await fetch(`${base}/api/albums/${encodeURIComponent(album)}`, {
                headers: { "x-api-key": settings.hub.immich_api_key!, Accept: "application/json" },
                signal: AbortSignal.timeout(10000),
            });
            if (response.status === 401 || response.status === 403) throw new Error("Immich rejected IMMICH_API_KEY (needs album.read and asset.view)");
            if (!response.ok) throw new Error(`album ${album}: HTTP ${response.status}`);
            const payload = await response.json();
            for (const asset of payload?.assets ?? []) {
                if (asset?.type === "IMAGE" && typeof asset.id === "string" && PHOTO_ID.test(asset.id) && !asset.isTrashed) ids.add(asset.id);
            }
        } catch (error) {
            errors.push(errorText(error));
        }
    }
    photoCache = { at: Date.now(), ids: [...ids], error: errors.join("; ") };
    return photoCache;
}

/** True only for ids from the configured albums: the proxy is not a window onto the whole library. */
export async function isAllowedPhoto(settings: Settings, id: string): Promise<boolean> {
    if (!PHOTO_ID.test(id)) return false;
    return (await getPhotoIds(settings)).ids.includes(id);
}

export async function fetchPhoto(settings: Settings, id: string): Promise<Response> {
    const base = endpointBase(settings, "immich");
    return fetch(`${base}/api/assets/${id}/thumbnail?size=preview`, {
        headers: { "x-api-key": settings.hub.immich_api_key! },
        signal: AbortSignal.timeout(15000),
    });
}
