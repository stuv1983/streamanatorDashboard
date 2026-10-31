import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { isAdminAuthenticated } from "@/lib/admin-session";
import { getThresholds } from "@/lib/health/thresholds";
import { getSettings } from "@/lib/config";

export const dynamic = "force-dynamic";

const MASK = "••••••••";
const EDITABLE_KEYS = new Set([
  "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "ADMIN_SECURE_COOKIE",
  "TH_FS_WARNING", "TH_FS_CRITICAL", "TH_DISK_TEMP_WARNING", "TH_DISK_TEMP_CRITICAL",
  "TH_CRC_DELTA_WARNING", "TH_BACKUP_WARNING_DAYS", "TH_BACKUP_CRITICAL_DAYS", "TH_LATENCY_WARNING",
  "VPN_PROVIDER", "VPN_PROTOCOL", "GLUETUN_CONTAINER", "GLUETUN_CONTROL_URL", "GLUETUN_API_KEY",
  "VPN_IP_CHECK_URL", "WAN_IP_CHECK_URL", "UNIFI_CONTROLLER_URL", "UNIFI_API_KEY", "UNIFI_SITE", "UNIFI_VERIFY_TLS",
  "PLEX_URL", "IMMICH_URL", "AQUALOG_URL", "AFLDB_URL", "SABNZBD_URL", "SONARR_URL", "RADARR_URL",
  "PROWLARR_URL", "QBITTORRENT_URL", "SONARR_API_KEY", "RADARR_API_KEY", "PROWLARR_API_KEY", "PLEX_TOKEN",
  "SABNZBD_API_KEY", "EMAIL_SMTP_HOST", "EMAIL_SMTP_PORT", "EMAIL_SMTP_USER", "EMAIL_SMTP_APP_PASSWORD", "EMAIL_FROM",
  "EMAIL_RECIPIENTS", "HEALTHCHECKS_PING_URL", "QBITTORRENT_USER", "QBITTORRENT_PASSWORD",
  "WEATHER_LOCATION", "WEATHER_LATITUDE", "WEATHER_LONGITUDE", "RSS_FEEDS", "CALENDAR_DAYS",
  "HUB_TITLE", "HUB_CALENDARS", "HUB_LISTS", "HUB_COUNTDOWNS", "HUB_NIGHT", "HUB_MEDIA_CALENDAR",
  "IMMICH_API_KEY", "HUB_PHOTO_ALBUMS", "HUB_PHOTO_SECONDS",
]);
const SECRET_KEYS = new Set([
  "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "GLUETUN_API_KEY", "UNIFI_API_KEY", "SONARR_API_KEY", "RADARR_API_KEY",
  "PROWLARR_API_KEY", "PLEX_TOKEN", "SABNZBD_API_KEY", "EMAIL_SMTP_APP_PASSWORD", "HEALTHCHECKS_PING_URL", "QBITTORRENT_PASSWORD",
  "HUB_CALENDARS", "IMMICH_API_KEY",
]);

function getEnvPath() {
  return process.env.ENV_FILE_PATH ?? path.resolve(process.cwd(), "..", ".env");
}

function readEnv(filePath: string): { lines: string[]; values: Record<string, string> } {
  let text = "";
  try { text = fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8"); } catch {}
  const lines = text.split("\n");
  const values: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return { lines, values };
}

export async function GET() {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const settings = getSettings();
  const { values } = readEnv(getEnvPath());
  const env = Object.fromEntries([...EDITABLE_KEYS].map((key) => [key, SECRET_KEYS.has(key) && values[key] ? MASK : values[key] ?? ""]));
  return NextResponse.json({
    thresholds: getThresholds(),
    vpn: settings.vpn,
    unifi: { controller_url: settings.unifi.controller_url, site: settings.unifi.site, api_key_set: Boolean(settings.unifi.api_key) },
    endpoints: settings.endpoints.map(({ key, display, url, critical, hosting }) => ({ key, display, url, critical, hosting })),
    env,
  });
}

export async function PATCH(req: NextRequest) {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as { updates?: Record<string, unknown> };
  const updates = Object.fromEntries(Object.entries(body.updates ?? {}).filter(([key, value]) =>
    EDITABLE_KEYS.has(key) && typeof value === "string" && value !== "" && value !== MASK && !value.includes("\n") && !value.includes("\r")
  )) as Record<string, string>;
  if (!Object.keys(updates).length) return NextResponse.json({ ok: true, message: "No changes to save." });

  const filePath = getEnvPath();
  try {
    const { lines } = readEnv(filePath);
    const applied = new Set<string>();
    const next = lines.map((line) => {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (!match || !(match[1] in updates)) return line;
      applied.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    });
    for (const [key, value] of Object.entries(updates)) if (!applied.has(key)) next.push(`${key}=${value}`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, next.join("\n"), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    return NextResponse.json({ ok: true, message: "Settings saved. Restart the service to apply them." });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
