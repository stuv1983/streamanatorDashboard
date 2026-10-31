/**
 * Utility widgets for /home: weather from Open-Meteo (no API key) and RSS/Atom
 * headlines. Both are fetched server-side and cached for 15 minutes, so a wall
 * of open tabs does not multiply the outbound requests.
 */

import { Settings } from './config';

export interface WeatherDay {
    date: string;
    max: number | null;
    min: number | null;
    code: number | null;
    summary: string;
    rainChance: number | null;
    uvMax: number | null;
    /** Local wall time as Open-Meteo returns it with timezone=auto, e.g. "2026-10-31T06:12". */
    sunrise: string;
    sunset: string;
}

export interface WeatherHour {
    time: string;
    temperature: number | null;
    rainChance: number | null;
    code: number | null;
    isDay: boolean;
}

export interface Weather {
    location: string;
    temperature: number | null;
    apparent: number | null;
    windKph: number | null;
    humidity: number | null;
    code: number | null;
    isDay: boolean;
    summary: string;
    days: WeatherDay[];
    /** The next 24 hours from the current hour. */
    hours: WeatherHour[];
}

export interface FeedItem {
    feed: string;
    title: string;
    link: string;
    at: number | null;
}

export interface WidgetData {
    weather: { configured: boolean; ok: boolean; error: string; data: Weather | null };
    rss: { configured: boolean; ok: boolean; error: string; data: FeedItem[] };
}

const TTL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 8000;

// WMO weather interpretation codes, as Open-Meteo returns them.
const WMO: Record<number, string> = {
    0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Light showers", 81: "Showers", 82: "Violent showers", 85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail",
};

export function weatherSummary(code: number | null | undefined): string {
    if (code === null || code === undefined) return "";
    return WMO[code] ?? `Code ${code}`;
}

function num(value: unknown): number | null {
    return typeof value === "number" && isFinite(value) ? value : null;
}

export function parseOpenMeteo(payload: any, location: string): Weather {
    const current = payload?.current ?? {};
    const daily = payload?.daily ?? {};
    const hourly = payload?.hourly ?? {};
    const dates: string[] = daily.time ?? [];
    const hourTimes: string[] = hourly.time ?? [];
    // Hourly times are local wall time; start from the current hour.
    const currentHour = typeof current.time === "string" ? current.time.slice(0, 13) : "";
    const firstHour = Math.max(0, hourTimes.findIndex(time => time.slice(0, 13) === currentHour));
    return {
        location,
        temperature: num(current.temperature_2m),
        apparent: num(current.apparent_temperature),
        windKph: num(current.wind_speed_10m),
        humidity: num(current.relative_humidity_2m),
        code: num(current.weather_code),
        isDay: current.is_day !== 0,
        summary: weatherSummary(num(current.weather_code)),
        days: dates.map((date, i) => ({
            date,
            max: num(daily.temperature_2m_max?.[i]),
            min: num(daily.temperature_2m_min?.[i]),
            code: num(daily.weather_code?.[i]),
            summary: weatherSummary(num(daily.weather_code?.[i])),
            rainChance: num(daily.precipitation_probability_max?.[i]),
            uvMax: num(daily.uv_index_max?.[i]),
            sunrise: String(daily.sunrise?.[i] ?? ""),
            sunset: String(daily.sunset?.[i] ?? ""),
        })),
        hours: hourTimes.slice(firstHour, firstHour + 24).map((time, j) => ({
            time,
            temperature: num(hourly.temperature_2m?.[firstHour + j]),
            rainChance: num(hourly.precipitation_probability?.[firstHour + j]),
            code: num(hourly.weather_code?.[firstHour + j]),
            isDay: hourly.is_day?.[firstHour + j] !== 0,
        })),
    };
}

function decodeEntities(text: string): string {
    return text
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .trim();
}

function tag(block: string, name: string): string {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    return match ? decodeEntities(match[1]) : "";
}

/** Only http(s) links are kept: a feed is untrusted input rendered as an <a href>. */
function safeLink(link: string): string {
    return /^https?:\/\//i.test(link) ? link : "";
}

/** RSS 2.0 <item> and Atom <entry>; enough for headline lists, not a full parser. */
export function parseFeed(xml: string, fallbackName: string, limit = 8): { name: string; items: FeedItem[] } {
    const channel = xml.match(/<channel[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i)
        ?? xml.match(/<feed[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
    const name = channel ? decodeEntities(channel[1]) || fallbackName : fallbackName;
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
    const items = blocks.slice(0, limit).map(block => {
        const atomLink = block.match(/<link[^>]*href="([^"]+)"/i);
        const link = tag(block, "link") || (atomLink ? decodeEntities(atomLink[1]) : "");
        const date = tag(block, "pubDate") || tag(block, "updated") || tag(block, "published") || tag(block, "dc:date");
        const at = Date.parse(date);
        return { feed: name, title: tag(block, "title") || "(untitled)", link: safeLink(link), at: isNaN(at) ? null : at / 1000 };
    });
    return { name, items };
}

async function fetchText(url: string, accept: string): Promise<string> {
    const response = await fetch(url, {
        headers: { Accept: accept, "User-Agent": "Streamanator-Dashboard" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.name === "TimeoutError" ? "Timed out" : error.message;
    return String(error);
}

export async function weather(settings: Settings): Promise<WidgetData["weather"]> {
    const { weather_latitude: lat, weather_longitude: lon, weather_location: location } = settings.home;
    if (lat === null || lon === null) return { configured: false, ok: false, error: "Weather is switched off.", data: null };
    const url = "https://api.open-meteo.com/v1/forecast"
        + `?latitude=${lat}&longitude=${lon}`
        + "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day"
        + "&hourly=temperature_2m,precipitation_probability,weather_code,is_day"
        + "&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,uv_index_max,sunrise,sunset"
        + "&forecast_days=7&timezone=auto";
    try {
        return { configured: true, ok: true, error: "", data: parseOpenMeteo(JSON.parse(await fetchText(url, "application/json")), location) };
    } catch (error) {
        return { configured: true, ok: false, error: errorText(error), data: null };
    }
}

export async function rss(settings: Settings): Promise<WidgetData["rss"]> {
    const feeds = settings.home.rss_feeds;
    if (feeds.length === 0) return { configured: false, ok: false, error: "Set RSS_FEEDS to a comma-separated list of feed URLs.", data: [] };
    const errors: string[] = [];
    const results = await Promise.all(feeds.map(async url => {
        try {
            return parseFeed(await fetchText(url, "application/rss+xml, application/atom+xml, application/xml, text/xml"), new URL(url).host).items;
        } catch (error) {
            errors.push(`${url}: ${errorText(error)}`);
            return [];
        }
    }));
    const items = results.flat().sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 15);
    return { configured: true, ok: items.length > 0 || errors.length === 0, error: errors.join("; "), data: items };
}

let cached: { at: number; value: WidgetData } | null = null;

export async function getWidgetData(settings: Settings): Promise<WidgetData> {
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
    const [w, r] = await Promise.all([weather(settings), rss(settings)]);
    const value = { weather: w, rss: r };
    // A failed fetch is retried on the next request rather than cached for 15 minutes.
    if (w.ok || !w.configured) cached = { at: Date.now(), value };
    return value;
}
