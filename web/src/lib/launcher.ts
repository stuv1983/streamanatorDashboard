/**
 * App launcher tiles for /home: one tile per monitored service endpoint, plus
 * bookmarks an admin adds. Built-in tiles come from config so they cannot drift
 * from what the dashboard probes; bookmarks live in var/launcher.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Settings } from './config';
import { endpointBase } from './integrations';

export interface Bookmark {
    name: string;
    url: string;
    /** A dashboard-icons slug (e.g. "jellyfin"); empty shows the initial. */
    icon: string;
    group: string;
    description: string;
}

export interface LauncherTile extends Bookmark {
    key: string;
    builtin: boolean;
    /** Endpoint key whose probe result gives this tile its status dot. */
    probeKey: string | null;
}

/** Where each service's UI lives relative to its base URL, and how it is grouped. */
const BUILTIN: Record<string, { icon: string; group: string; path?: string; description: string }> = {
    plex: { icon: "plex", group: "Media", path: "/web", description: "Media server" },
    immich: { icon: "immich", group: "Media", description: "Photos" },
    sonarr: { icon: "sonarr", group: "Downloads", description: "TV automation" },
    radarr: { icon: "radarr", group: "Downloads", description: "Film automation" },
    prowlarr: { icon: "prowlarr", group: "Downloads", description: "Indexers" },
    sabnzbd: { icon: "sabnzbd", group: "Downloads", description: "Usenet client" },
    qbittorrent: { icon: "qbittorrent", group: "Downloads", description: "Torrent client" },
    grafana: { icon: "grafana", group: "Monitoring", description: "Dashboards" },
    prometheus: { icon: "prometheus", group: "Monitoring", description: "Metrics" },
    aqualog: { icon: "", group: "Apps", description: "Aquarium log" },
    afldb: { icon: "", group: "Apps", description: "AFL database" },
};

export const MAX_BOOKMARKS = 60;

/**
 * Probe URLs often point at loopback (Grafana and Prometheus bind 127.0.0.1),
 * which a browser on another machine cannot open. Swap in the host address.
 */
export function browserUrl(base: string, hostAddress: string): string {
    try {
        const url = new URL(base);
        if (url.hostname === "127.0.0.1" || url.hostname === "localhost") url.hostname = hostAddress;
        return url.toString().replace(/\/$/, "");
    } catch {
        return base;
    }
}

export function builtinTiles(settings: Settings): LauncherTile[] {
    return settings.endpoints.flatMap(endpoint => {
        const meta = BUILTIN[endpoint.key] ?? { icon: "", group: "Apps", description: endpoint.hosting };
        let base = endpointBase(settings, endpoint.key);
        if (endpoint.key === "grafana" && settings.grafana.link_url) base = settings.grafana.link_url.replace(/\/$/, "");
        if (!base) return [];
        return [{
            key: endpoint.key,
            name: endpoint.display,
            url: browserUrl(base, settings.host.address) + (meta.path ?? ""),
            icon: meta.icon,
            group: meta.group,
            description: meta.description,
            builtin: true,
            probeKey: endpoint.key,
        }];
    });
}

function launcherPath(settings: Settings): string {
    const configured = settings.home.launcher_path;
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), "..", configured);
}

/**
 * Validate one bookmark from an admin request. Returns the cleaned bookmark or
 * a reason. Only http(s) URLs: anything else in an href is a script vector.
 */
export function validateBookmark(input: unknown): Bookmark | string {
    if (!input || typeof input !== "object") return "Each bookmark must be an object.";
    const raw = input as Record<string, unknown>;
    const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
    const name = text(raw.name, 60);
    const url = text(raw.url, 500);
    if (!name) return "Every bookmark needs a name.";
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return `"${name}": URL must start with http:// or https://.`;
    const icon = text(raw.icon, 60).toLowerCase();
    if (icon && !/^[a-z0-9-]+$/.test(icon)) return `"${name}": icon must be a dashboard-icons name such as "jellyfin".`;
    return { name, url, icon, group: text(raw.group, 40) || "Bookmarks", description: text(raw.description, 120) };
}

export function readBookmarks(settings: Settings): Bookmark[] {
    try {
        const payload = JSON.parse(fs.readFileSync(launcherPath(settings), "utf8"));
        const list: unknown[] = Array.isArray(payload?.bookmarks) ? payload.bookmarks : [];
        return list.map(validateBookmark).filter((b): b is Bookmark => typeof b !== "string");
    } catch {
        return [];
    }
}

export function writeBookmarks(settings: Settings, bookmarks: Bookmark[]): void {
    const file = launcherPath(settings);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ bookmarks }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
}

export function allTiles(settings: Settings): LauncherTile[] {
    const bookmarks = readBookmarks(settings).map((bookmark, index) => ({
        ...bookmark, key: `bookmark-${index}`, builtin: false, probeKey: null,
    }));
    return [...builtinTiles(settings), ...bookmarks];
}
