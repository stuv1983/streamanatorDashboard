/**
 * Read-only integrations with the media stack for the /home widgets: what Plex
 * is playing, what SABnzbd and qBittorrent are downloading, and what Sonarr and
 * Radarr expect to arrive.
 *
 * Every call is a GET (qBittorrent's login aside), short-timeout and cached
 * briefly, so a slow application cannot stall the page. Each section reports
 * `configured` separately from `ok`: a missing API key is a setup step, not
 * an outage.
 */

import { Settings } from './config';

export interface Section<T> {
    configured: boolean;
    ok: boolean;
    error: string;
    data: T;
}

export interface PlexSession {
    title: string;
    subtitle: string;
    user: string;
    player: string;
    state: string;
    progress: number | null;
    transcoding: boolean;
}

export interface DownloadItem {
    name: string;
    progress: number;
    speedBytes: number | null;
    etaSeconds: number | null;
    sizeBytes: number | null;
    state: string;
}

export interface DownloadClient {
    speedBytes: number;
    uploadBytes: number | null;
    paused: boolean;
    items: DownloadItem[];
}

export interface CalendarEntry {
    source: "sonarr" | "radarr";
    title: string;
    detail: string;
    at: number;
    hasFile: boolean;
}

export interface MediaOverview {
    plex: Section<PlexSession[]>;
    sabnzbd: Section<DownloadClient | null>;
    qbittorrent: Section<DownloadClient | null>;
    calendar: Section<CalendarEntry[]>;
    collectedAt: number;
}

const TIMEOUT_MS = 6000;

/** Endpoint URLs carry the probe path; strip it to get the application's base URL. */
export function endpointBase(settings: Settings, key: string): string {
    const endpoint = settings.endpoints.find(e => e.key === key);
    if (!endpoint?.url) return "";
    return endpoint.url
        .replace(/\/(ping|identity|api\/server\/ping|api\/health|-\/healthy)$/, "")
        .replace(/\/$/, "");
}

function section<T>(configured: boolean, data: T): Section<T> {
    return { configured, ok: false, error: configured ? "" : "Not configured", data };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
    const response = await fetch(url, {
        headers: { Accept: "application/json", ...headers },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
        throw new Error(`HTTP ${response.status}: check the API key`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function errorText(error: unknown): string {
    if (error instanceof Error) {
        return error.name === "TimeoutError" ? "Timed out" : error.message;
    }
    return String(error);
}

// ─── Plex ────────────────────────────────────────────────────────────────────

export function parsePlexSessions(payload: any): PlexSession[] {
    const items: any[] = payload?.MediaContainer?.Metadata ?? [];
    return items.map(item => {
        const episode = item.type === "episode";
        const title = episode ? (item.grandparentTitle || item.title) : item.title;
        const subtitle = episode
            ? `S${String(item.parentIndex ?? "?").padStart(2, "0")}E${String(item.index ?? "?").padStart(2, "0")} · ${item.title}`
            : item.type === "track" ? [item.grandparentTitle, item.parentTitle].filter(Boolean).join(" · ") : (item.year ? String(item.year) : "");
        const duration = Number(item.duration) || 0;
        const offset = Number(item.viewOffset) || 0;
        return {
            title: title || "Unknown",
            subtitle,
            user: item.User?.title ?? "",
            player: [item.Player?.title, item.Player?.product].filter(Boolean).join(" · "),
            state: item.Player?.state ?? "",
            progress: duration > 0 ? Math.min(100, (offset / duration) * 100) : null,
            transcoding: Boolean(item.TranscodeSession) && item.TranscodeSession?.videoDecision === "transcode",
        };
    });
}

async function plexSessions(settings: Settings): Promise<Section<PlexSession[]>> {
    const base = endpointBase(settings, "plex");
    const token = settings.api.plex_token;
    const result = section<PlexSession[]>(Boolean(base && token), []);
    if (!result.configured) {
        result.error = "Set PLEX_TOKEN to show what is playing.";
        return result;
    }
    try {
        result.data = parsePlexSessions(await getJson(`${base}/status/sessions`, { "X-Plex-Token": token! }));
        result.ok = true;
    } catch (error) {
        result.error = errorText(error);
    }
    return result;
}

// ─── SABnzbd ─────────────────────────────────────────────────────────────────

/** SABnzbd reports "1:02:03" or "0:00:00"; unknown is "" or "unknown". */
function parseClock(value: unknown): number | null {
    const parts = String(value ?? "").split(":").map(Number);
    if (parts.length < 2 || parts.some(isNaN)) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
}

export function parseSabQueue(payload: any): DownloadClient {
    const queue = payload?.queue ?? {};
    const slots: any[] = queue.slots ?? [];
    return {
        speedBytes: (Number(queue.kbpersec) || 0) * 1024,
        uploadBytes: null,
        paused: Boolean(queue.paused),
        items: slots.slice(0, 10).map(slot => ({
            name: slot.filename ?? "",
            progress: Number(slot.percentage) || 0,
            speedBytes: null,
            etaSeconds: parseClock(slot.timeleft),
            sizeBytes: slot.mb != null ? Number(slot.mb) * 1024 * 1024 : null,
            state: String(slot.status ?? "").toLowerCase(),
        })),
    };
}

async function sabnzbdQueue(settings: Settings): Promise<Section<DownloadClient | null>> {
    const base = endpointBase(settings, "sabnzbd");
    const key = settings.api.sabnzbd_api_key;
    const result = section<DownloadClient | null>(Boolean(base && key), null);
    if (!result.configured) {
        result.error = "Set SABNZBD_API_KEY to show the queue.";
        return result;
    }
    try {
        const url = `${base}/api?mode=queue&output=json&limit=10&apikey=${encodeURIComponent(key!)}`;
        const payload = await getJson(url);
        if (payload?.error) throw new Error(String(payload.error));
        result.data = parseSabQueue(payload);
        result.ok = true;
    } catch (error) {
        result.error = errorText(error);
    }
    return result;
}

// ─── qBittorrent ─────────────────────────────────────────────────────────────

export function parseQbittorrent(transfer: any, torrents: any[]): DownloadClient {
    return {
        speedBytes: Number(transfer?.dl_info_speed) || 0,
        uploadBytes: Number(transfer?.up_info_speed) || 0,
        paused: false,
        items: (torrents ?? []).slice(0, 10).map(torrent => ({
            name: torrent.name ?? "",
            progress: (Number(torrent.progress) || 0) * 100,
            speedBytes: Number(torrent.dlspeed) || 0,
            // qBittorrent uses 8640000 (100 days) for "unknown".
            etaSeconds: torrent.eta != null && torrent.eta < 8640000 ? Number(torrent.eta) : null,
            sizeBytes: torrent.size != null ? Number(torrent.size) : null,
            state: String(torrent.state ?? ""),
        })),
    };
}

const qbitSession: { cookie: string | null } = { cookie: null };

async function qbitLogin(base: string, user: string, password: string): Promise<string> {
    const response = await fetch(`${base}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: base },
        body: new URLSearchParams({ username: user, password }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok || text.trim() !== "Ok.") {
        throw new Error(response.status === 403 ? "qBittorrent has banned this IP after failed logins" : "qBittorrent login rejected: check QBITTORRENT_USER/QBITTORRENT_PASSWORD");
    }
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    if (!cookie) throw new Error("qBittorrent login returned no session cookie");
    return cookie;
}

async function qbitGet(base: string, route: string): Promise<Response> {
    return fetch(`${base}${route}`, {
        headers: { Referer: base, ...(qbitSession.cookie ? { Cookie: qbitSession.cookie } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
}

async function qbittorrentQueue(settings: Settings): Promise<Section<DownloadClient | null>> {
    const base = endpointBase(settings, "qbittorrent");
    const user = settings.api.qbittorrent_user;
    const password = settings.api.qbittorrent_password;
    // qBittorrent can bypass auth for the LAN, so a missing login is worth trying.
    const result = section<DownloadClient | null>(Boolean(base), null);
    if (!result.configured) return result;
    try {
        let transfer = await qbitGet(base, "/api/v2/transfer/info");
        if (transfer.status === 403 && user && password) {
            qbitSession.cookie = await qbitLogin(base, user, password);
            transfer = await qbitGet(base, "/api/v2/transfer/info");
        }
        if (transfer.status === 403) {
            throw new Error("qBittorrent requires a login: set QBITTORRENT_USER and QBITTORRENT_PASSWORD");
        }
        if (!transfer.ok) throw new Error(`HTTP ${transfer.status}`);
        const torrents = await qbitGet(base, "/api/v2/torrents/info?filter=active&sort=dlspeed&reverse=true&limit=10");
        result.data = parseQbittorrent(await transfer.json(), torrents.ok ? await torrents.json() : []);
        result.ok = true;
    } catch (error) {
        result.error = errorText(error);
    }
    return result;
}

// ─── Sonarr / Radarr calendar ────────────────────────────────────────────────

export function parseSonarrCalendar(payload: any[]): CalendarEntry[] {
    return (payload ?? []).flatMap(episode => {
        const at = Date.parse(episode.airDateUtc ?? "");
        if (isNaN(at)) return [];
        const code = `S${String(episode.seasonNumber ?? 0).padStart(2, "0")}E${String(episode.episodeNumber ?? 0).padStart(2, "0")}`;
        return [{
            source: "sonarr" as const,
            title: episode.series?.title ?? "Unknown series",
            detail: [code, episode.title].filter(Boolean).join(" · "),
            at: at / 1000,
            hasFile: Boolean(episode.hasFile),
        }];
    });
}

/** A film has several release dates; show whichever falls inside the window. */
export function parseRadarrCalendar(payload: any[], startMs: number, endMs: number): CalendarEntry[] {
    const kinds: Array<[string, string]> = [["digitalRelease", "Digital"], ["physicalRelease", "Physical"], ["inCinemas", "Cinemas"]];
    return (payload ?? []).flatMap(movie => {
        for (const [field, label] of kinds) {
            const at = Date.parse(movie[field] ?? "");
            if (!isNaN(at) && at >= startMs && at <= endMs) {
                return [{
                    source: "radarr" as const,
                    title: movie.year ? `${movie.title} (${movie.year})` : movie.title,
                    detail: `${label} release`,
                    at: at / 1000,
                    hasFile: Boolean(movie.hasFile),
                }];
            }
        }
        return [];
    });
}

async function calendar(settings: Settings): Promise<Section<CalendarEntry[]>> {
    const sonarr = endpointBase(settings, "sonarr");
    const radarr = endpointBase(settings, "radarr");
    const sonarrKey = settings.api.sonarr_api_key;
    const radarrKey = settings.api.radarr_api_key;
    const result = section<CalendarEntry[]>(Boolean((sonarr && sonarrKey) || (radarr && radarrKey)), []);
    if (!result.configured) {
        result.error = "Set SONARR_API_KEY and/or RADARR_API_KEY to show upcoming releases.";
        return result;
    }

    const startMs = Date.now() - 24 * 3600 * 1000;
    const endMs = Date.now() + settings.home.calendar_days * 24 * 3600 * 1000;
    const range = `start=${new Date(startMs).toISOString()}&end=${new Date(endMs).toISOString()}`;
    const errors: string[] = [];
    const entries: CalendarEntry[] = [];

    await Promise.all([
        sonarr && sonarrKey ? getJson(`${sonarr}/api/v3/calendar?${range}&includeSeries=true`, { "X-Api-Key": sonarrKey })
            .then(payload => entries.push(...parseSonarrCalendar(payload)))
            .catch(error => errors.push(`Sonarr: ${errorText(error)}`)) : null,
        radarr && radarrKey ? getJson(`${radarr}/api/v3/calendar?${range}`, { "X-Api-Key": radarrKey })
            .then(payload => entries.push(...parseRadarrCalendar(payload, startMs, endMs)))
            .catch(error => errors.push(`Radarr: ${errorText(error)}`)) : null,
    ]);

    result.data = entries.sort((a, b) => a.at - b.at);
    result.ok = errors.length === 0 || entries.length > 0;
    result.error = errors.join("; ");
    return result;
}

// ─── Overview ────────────────────────────────────────────────────────────────

let cached: { at: number; value: MediaOverview; promise?: Promise<MediaOverview> } | null = null;

export async function getMediaOverview(settings: Settings, maxAgeMs = 10000): Promise<MediaOverview> {
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
    if (cached?.promise) return cached.promise;

    const promise = (async () => {
        const [plex, sabnzbd, qbittorrent, cal] = await Promise.all([
            plexSessions(settings), sabnzbdQueue(settings), qbittorrentQueue(settings), calendar(settings),
        ]);
        return { plex, sabnzbd, qbittorrent, calendar: cal, collectedAt: Date.now() / 1000 };
    })();
    cached = { at: cached?.at ?? 0, value: cached?.value as MediaOverview, promise };
    try {
        const value = await promise;
        cached = { at: Date.now(), value };
        return value;
    } catch (error) {
        cached = null;
        throw error;
    }
}
