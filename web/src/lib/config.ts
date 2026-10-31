// D:\dev\streamanatorDashboard\web\src\lib\config.ts

function envStr(key: string, defaultValue: string = ""): string {
  const val = process.env[key];
  if (val === undefined || val === null || val.trim() === "") {
    return defaultValue;
  }
  return val.trim();
}

function envOpt(key: string): string | null {
  const val = process.env[key];
  if (val === undefined || val === null || val.trim() === "") {
    return null;
  }
  return val.trim();
}

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined || val === null || val.trim() === "") {
    return defaultValue;
  }
  const parsed = parseInt(val.trim(), 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function envFloat(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined || val === null || val.trim() === "") {
    return defaultValue;
  }
  const parsed = parseFloat(val.trim());
  return isNaN(parsed) ? defaultValue : parsed;
}

function envBool(key: string, defaultValue: boolean = false): boolean {
  const val = process.env[key];
  if (val === undefined || val === null || val.trim() === "") {
    return defaultValue;
  }
  const raw = val.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function envList(key: string, defaultValue: string[] = []): string[] {
  const val = process.env[key];
  if (val === undefined || val === null || val.trim() === "") {
    return defaultValue;
  }
  return val.split(",").map(item => item.trim()).filter(item => item !== "");
}

// --------------------------------------------------------------------------
// Host / identity
// --------------------------------------------------------------------------

export interface HostConfig {
  hostname: string;
  address: string;
  primary_user: string;
  vlan: string;
  timezone: string;
  cpu_cores: number;
}

export interface Vlan {
  vlan_id: number;
  name: string;
  subnet: string;
  trusted: boolean;
}

export const VLANS: Vlan[] = [
  { vlan_id: 10, name: "Home", subnet: "10.0.10.0/24", trusted: true },
  { vlan_id: 20, name: "IoT", subnet: "10.0.20.0/24", trusted: false },
  { vlan_id: 30, name: "Guest", subnet: "10.0.30.0/24", trusted: false },
  { vlan_id: 40, name: "Media", subnet: "10.0.40.0/24", trusted: false },
  { vlan_id: 50, name: "DMZ", subnet: "10.0.50.0/24", trusted: true },
];

// --------------------------------------------------------------------------
// Telemetry sources
// --------------------------------------------------------------------------

export interface PrometheusConfig {
  url: string;
  timeout_seconds: number;
  stale_after_seconds: number;
  configured: boolean;
}

export interface GrafanaConfig {
  url: string;
  browser_url: string;
  link_url: string;
  configured: boolean;
}

export interface UnifiConfig {
  exporter_url: string;
  controller_url: string;
  api_key: string | null;
  site: string;
  verify_tls: boolean;
  ca_bundle: string;
  tls_verify: boolean | string;
  configured: boolean;
}

export interface BlackboxConfig {
  url: string;
  configured: boolean;
}

export interface LocalCollectorConfig {
  enabled: boolean;
  command_timeout: number;
  proc_mdstat: string;
  docker_socket: string;
  smartctl_via_sudo: boolean;
  smartctl_path: string;
}

// --------------------------------------------------------------------------
// Storage / RAID
// --------------------------------------------------------------------------

export interface RaidConfig {
  device: string;
  level: string;
  required_members: number;
}

export interface DiskConfig {
  serial: string;
  model: string;
  role: string;
  watch_crc: boolean;
}

export const DISKS: DiskConfig[] = [
  { serial: "WPV2E65M", model: "ST8000VN002-2ZM1", role: "RAID5 member (md127)", watch_crc: false },
  { serial: "WPV36EV6", model: "ST8000VN002-2ZM1", role: "RAID5 member (md127)", watch_crc: false },
  { serial: "WPV2E6KL", model: "ST8000VN002-2ZM1", role: "RAID5 member (md127)", watch_crc: false },
  { serial: "WPV2E6LL", model: "ST8000VN002-2ZM1", role: "RAID5 member (md127)", watch_crc: true },
  { serial: "S2ZWNDAHA21787", model: "SAMSUNG MZ7TY256", role: "Boot / root LVM", watch_crc: false },
  { serial: "2518106901831", model: "BIWIN M100 1TB", role: "Download staging (/mnt/ssd)", watch_crc: false },
  { serial: "2246AP402020", model: "Portable SSD", role: "Backup target (/mnt/backup)", watch_crc: false },
];

export interface Filesystem {
  mountpoint: string;
  label: string;
  forecast: boolean;
  critical: boolean;
}

export const FILESYSTEMS: Filesystem[] = [
  { mountpoint: "/mnt/media", label: "Media (RAID5 md127)", forecast: true, critical: true },
  { mountpoint: "/mnt/ssd", label: "Download staging (SSD)", forecast: true, critical: true },
  { mountpoint: "/mnt/backup", label: "Backup target (portable SSD)", forecast: true, critical: false },
  { mountpoint: "/", label: "Root", forecast: true, critical: true },
  { mountpoint: "/boot", label: "Boot", forecast: false, critical: false },
];

export const MEDIA_DIRECTORIES = [
  "/mnt/media/movies",
  "/mnt/media/tv",
  "/mnt/media/photos",
  "/mnt/media/music",
];

// --------------------------------------------------------------------------
// Containers and applications
// --------------------------------------------------------------------------

export interface ExpectedContainer {
  name: string;
  display: string;
  stack: string;
  behind_vpn: boolean;
  critical: boolean;
}

export const EXPECTED_CONTAINERS: ExpectedContainer[] = [
  { name: "media-vpn_gluetun_1", display: "Gluetun", stack: "media-vpn", behind_vpn: false, critical: true },
  { name: "media-vpn-sabnzbd-1", display: "SABnzbd", stack: "media-vpn", behind_vpn: true, critical: true },
  { name: "media-vpn_sonarr_1", display: "Sonarr", stack: "media-vpn", behind_vpn: true, critical: true },
  { name: "media-vpn_radarr_1", display: "Radarr", stack: "media-vpn", behind_vpn: true, critical: true },
  { name: "media-vpn_prowlarr_1", display: "Prowlarr", stack: "media-vpn", behind_vpn: true, critical: true },
  { name: "media-vpn_qbittorrent_1", display: "qBittorrent", stack: "media-vpn", behind_vpn: true, critical: true },
  { name: "immich-server", display: "Immich server", stack: "immich", behind_vpn: false, critical: true },
  { name: "immich-microservices", display: "Immich microservices", stack: "immich", behind_vpn: false, critical: true },
  { name: "immich-machine-learning", display: "Immich ML", stack: "immich", behind_vpn: false, critical: false },
  { name: "immich-db", display: "Immich database", stack: "immich", behind_vpn: false, critical: true },
  { name: "immich-redis", display: "Immich Redis", stack: "immich", behind_vpn: false, critical: true },
];

// --------------------------------------------------------------------------
// Compose stacks
// --------------------------------------------------------------------------

export interface ComposeStack {
  key: string;
  display: string;
  env_var: string;
  directory: string;
  explain: string;
  critical: boolean;
  configured: boolean;
}

export const GLUETUN_PUBLISHED_PORTS: Record<number, string> = {
  8080: "SABnzbd",
  8081: "Sonarr (container 8989)",
  8082: "Radarr (container 7878)",
  8085: "Prowlarr (container 9696)",
  8086: "qBittorrent",
  6881: "qBittorrent BitTorrent",
};

export interface ServiceEndpoint {
  key: string;
  display: string;
  url: string;
  expect_status: number[];
  critical: boolean;
  hosting: string;
}

export interface AppApiConfig {
  plex_token: string | null;
  sonarr_api_key: string | null;
  radarr_api_key: string | null;
  prowlarr_api_key: string | null;
  sabnzbd_api_key: string | null;
  qbittorrent_user: string | null;
  qbittorrent_password: string | null;
  tautulli_url: string;
  tautulli_api_key: string | null;
  gluetun_control_url: string;
  gluetun_api_key: string | null;
}

export interface HomeConfig {
  /** Admin-edited bookmarks shown on /home beside the built-in service tiles. */
  launcher_path: string;
  weather_latitude: number | null;
  weather_longitude: number | null;
  weather_location: string;
  rss_feeds: string[];
  calendar_days: number;
}

export interface HubCalendar {
  name: string;
  /** CSS colour; empty takes the next palette slot. */
  color: string;
  /** Private feed URL (Google "secret address in iCal format", iCloud public link, Outlook ICS). Never sent to browsers. */
  url: string;
}

export interface HubConfig {
  title: string;
  calendars: HubCalendar[];
  include_media_calendar: boolean;
  days: number;
  lists: string[];
  store_path: string;
  immich_api_key: string | null;
  photo_album_ids: string[];
  photo_seconds: number;
  /** "Name|YYYY-MM-DD" (one-off) or "Name|MM-DD" (every year), separated by ";". */
  countdowns: string;
  /** "HH:MM-HH:MM" during which the hub dims to a night clock; empty for never. */
  night: string;
}

export interface VpnConfig {
  container: string;
  provider: string;
  protocol: string;
  ip_check_url: string;
  wan_ip_check_url: string;
}

export interface BackupJob {
  key: string;
  display: string;
  directory: string;
  pattern: string;
  schedule: string;
  expected_interval_days: number;
  min_plausible_bytes: number;
  source: string;
  schedule_weekdays: number[];
  schedule_hour: number;
  schedule_grace_hours: number;
}

export const WATCHED_UNITS = [
  "backup-nightly.service",
  "aqualog.service",
  "plexmediaserver.service",
  "docker.service",
  "mdmonitor.service",
];

export interface ExposedPort {
  port: number;
  expected: boolean;
  service: string;
  note: string;
}

export const EXTERNAL_PORTS: ExposedPort[] = [
  { port: 32400, expected: true, service: "Plex", note: "Remote access; attracts IDS/IPS scan traffic" },
  { port: 80, expected: true, service: "HTTP", note: "Standard unencrypted web endpoint" },
  { port: 443, expected: true, service: "HTTPS", note: "Standard TLS-encrypted web endpoint" },
];

export const REFRESH_CHOICES: [string, number][] = [
  ["Off", 0],
  ["15 sec", 15],
  ["30 sec", 30],
  ["60 sec", 60],
  ["5 min", 300],
];

export const TIME_RANGES: [string, number][] = [
  ["1h", 3600],
  ["6h", 21600],
  ["24h", 86400],
  ["7d", 604800],
  ["30d", 2592000],
  ["90d", 7776000],
];

export interface DashboardConfig {
  port: number;
  bind_address: string;
  history_path: string;
  history_retention_days: number;
  sample_interval_seconds: number;
  log_level: string;
  log_file: string;
}

export interface EmailConfig {
  smtp_host: string;
  smtp_port: number;
  username: string | null;
  app_password: string | null;
  sender: string | null;
  timeout_seconds: number;
  preferences_path: string;
  poll_interval_seconds: number;
  configured: boolean;
  from_address: string;
}

export interface HeartbeatConfig {
  ping_url: string | null;
  timeout_seconds: number;
  configured: boolean;
}

export interface AuthConfig {
  accounts_path: string;
  audit_path: string;
  env_file: string;
  require_auth_for_all: boolean;
  actions_enabled: boolean;
  totp_issuer: string;
}

export interface UpdatesConfig {
  check_registry: boolean;
  registry_timeout_seconds: number;
}

export interface Settings {
  host: HostConfig;
  auth: AuthConfig;
  dashboard: DashboardConfig;
  email: EmailConfig;
  heartbeat: HeartbeatConfig;
  prometheus: PrometheusConfig;
  grafana: GrafanaConfig;
  unifi: UnifiConfig;
  blackbox: BlackboxConfig;
  local: LocalCollectorConfig;
  raid: RaidConfig;
  vpn: VpnConfig;
  home: HomeConfig;
  hub: HubConfig;
  api: AppApiConfig;
  updates: UpdatesConfig;

  vlans: Vlan[];
  disks: DiskConfig[];
  filesystems: Filesystem[];
  containers: ExpectedContainer[];
  stacks: ComposeStack[];
  endpoints: ServiceEndpoint[];
  backups: BackupJob[];
  external_ports: ExposedPort[];
  expected_listeners: Record<number, string>;
  default_refresh_seconds: number;
  default_time_range: string;
  crc_watch_serial: string;
}

export function getSettings(): Settings {
  const HOST_ADDR = envStr("STREAMANATOR_ADDR", "10.0.40.100");
  const PROJECT_ROOT_VAR = "/app";
  
  const prometheus_url = envStr("PROMETHEUS_URL", "");
  const grafana_url = envStr("GRAFANA_URL", "");
  const grafana_browser_url = envStr("GRAFANA_BROWSER_URL", "");
  const grafana_probe_url = grafana_url || grafana_browser_url;
  const _stack_hint = "Not deployed — run deploy/monitoring-stack/deploy.sh";

  const host: HostConfig = {
    hostname: envStr("STREAMANATOR_HOST", "streamanator"),
    address: HOST_ADDR,
    primary_user: envStr("STREAMANATOR_USER", "arm"),
    vlan: "VLAN 40 - Media-DMZ",
    timezone: envStr("STREAMANATOR_TZ", "Australia/Melbourne"),
    cpu_cores: envInt("STREAMANATOR_CPU_CORES", 24),
  };

  const prometheus: PrometheusConfig = {
    url: prometheus_url,
    timeout_seconds: envFloat("PROMETHEUS_TIMEOUT", 4.0),
    stale_after_seconds: envInt("PROMETHEUS_STALE_AFTER", 180),
    configured: Boolean(prometheus_url),
  };

  const grafana: GrafanaConfig = {
    url: grafana_url,
    browser_url: grafana_browser_url,
    link_url: grafana_browser_url || grafana_url,
    configured: Boolean(grafana_browser_url || grafana_url),
  };

  const unifi_ca_bundle = envStr("UNIFI_CA_BUNDLE", "");
  const unifi_verify_tls = envBool("UNIFI_VERIFY_TLS", false);
  const unifi: UnifiConfig = {
    exporter_url: envStr("UNIFI_EXPORTER_URL", ""),
    controller_url: envStr("UNIFI_CONTROLLER_URL", ""),
    api_key: envOpt("UNIFI_API_KEY"),
    site: envStr("UNIFI_SITE", "default"),
    verify_tls: unifi_verify_tls,
    ca_bundle: unifi_ca_bundle,
    tls_verify: unifi_ca_bundle ? unifi_ca_bundle : unifi_verify_tls,
    configured: Boolean(envStr("UNIFI_EXPORTER_URL", "") || (envStr("UNIFI_CONTROLLER_URL", "") && envOpt("UNIFI_API_KEY"))),
  };

  const blackbox: BlackboxConfig = {
    url: envStr("BLACKBOX_URL", ""),
    configured: Boolean(envStr("BLACKBOX_URL", "")),
  };

  const local: LocalCollectorConfig = {
    enabled: envBool("LOCAL_COLLECTORS", true),
    command_timeout: envFloat("LOCAL_COMMAND_TIMEOUT", 5.0),
    proc_mdstat: envStr("PROC_MDSTAT", "/proc/mdstat"),
    docker_socket: envStr("DOCKER_SOCKET", "/var/run/docker.sock"),
    smartctl_via_sudo: envBool("SMARTCTL_SUDO", false),
    smartctl_path: envStr("SMARTCTL_PATH", "/usr/sbin/smartctl"),
  };

  const raid: RaidConfig = {
    device: envStr("RAID_DEVICE", "md127"),
    level: "raid5",
    required_members: envInt("RAID_REQUIRED_MEMBERS", 4),
  };

  const vpn: VpnConfig = {
    container: envStr("GLUETUN_CONTAINER", "media-vpn_gluetun_1"),
    provider: envStr("VPN_PROVIDER", "protonvpn"),
    protocol: envStr("VPN_PROTOCOL", "wireguard"),
    ip_check_url: envStr("VPN_IP_CHECK_URL", "https://ipinfo.io/json"),
    wan_ip_check_url: envStr("WAN_IP_CHECK_URL", "https://ipinfo.io/json"),
  };

  const dashboard: DashboardConfig = {
    port: envInt("DASHBOARD_PORT", 8600),
    bind_address: envStr("DASHBOARD_BIND", "0.0.0.0"),
    history_path: envStr("HISTORY_DB_PATH", "var/history.sqlite3"),
    history_retention_days: envInt("HISTORY_RETENTION_DAYS", 400),
    sample_interval_seconds: envInt("HISTORY_SAMPLE_INTERVAL", 60),
    log_level: envStr("LOG_LEVEL", "INFO"),
    log_file: envStr("LOG_FILE", ""),
  };

  const email: EmailConfig = {
    smtp_host: envStr("EMAIL_SMTP_HOST", "smtp.gmail.com"),
    smtp_port: envInt("EMAIL_SMTP_PORT", 465),
    username: envOpt("EMAIL_SMTP_USER"),
    app_password: envOpt("EMAIL_SMTP_APP_PASSWORD"),
    sender: envOpt("EMAIL_FROM"),
    timeout_seconds: Math.max(1.0, envFloat("EMAIL_SMTP_TIMEOUT", 15.0)),
    preferences_path: envStr("NOTIFICATION_CONFIG_PATH", "var/notifications.json"),
    poll_interval_seconds: Math.max(60, envInt("NOTIFICATION_POLL_INTERVAL", 300)),
    configured: Boolean(envStr("EMAIL_SMTP_HOST", "smtp.gmail.com") && envOpt("EMAIL_SMTP_USER") && envOpt("EMAIL_SMTP_APP_PASSWORD")),
    from_address: envOpt("EMAIL_FROM") || envOpt("EMAIL_SMTP_USER") || "",
  };

  const heartbeat: HeartbeatConfig = {
    ping_url: envOpt("HEALTHCHECKS_PING_URL"),
    timeout_seconds: Math.max(1.0, envFloat("HEALTHCHECKS_TIMEOUT", 8.0)),
    configured: Boolean(envOpt("HEALTHCHECKS_PING_URL")),
  };

  const auth: AuthConfig = {
    accounts_path: envStr("ADMIN_ACCOUNTS_PATH", "var/accounts.json"),
    audit_path: envStr("ADMIN_AUDIT_PATH", "var/audit.log"),
    env_file: envStr("STREAMANATOR_ENV_FILE", ".env"),
    require_auth_for_all: envBool("REQUIRE_AUTH_FOR_ALL", false),
    actions_enabled: envBool("ADMIN_ACTIONS_ENABLED", true),
    totp_issuer: envStr("ADMIN_TOTP_ISSUER", "Streamanator Dashboard"),
  };

  // Melbourne matches the default STREAMANATOR_TZ; WEATHER_LATITUDE=off hides the widget.
  const weather_off = envStr("WEATHER_LATITUDE", "").toLowerCase() === "off";
  const home: HomeConfig = {
    launcher_path: envStr("LAUNCHER_PATH", "var/launcher.json"),
    weather_latitude: weather_off ? null : envFloat("WEATHER_LATITUDE", -37.8136),
    weather_longitude: weather_off ? null : envFloat("WEATHER_LONGITUDE", 144.9631),
    weather_location: envStr("WEATHER_LOCATION", "Melbourne"),
    rss_feeds: envStr("RSS_FEEDS", "").split(",").map(feed => feed.trim()).filter(Boolean),
    calendar_days: envInt("CALENDAR_DAYS", 7),
  };

  // HUB_CALENDARS: "Name|#colour|url;Name||url". Colour is optional.
  const hub: HubConfig = {
    title: envStr("HUB_TITLE", "Home"),
    calendars: envStr("HUB_CALENDARS", "").split(";").flatMap(entry => {
      const [name, color, ...rest] = entry.split("|");
      const url = rest.join("|").trim().replace(/^webcal:\/\//i, "https://");
      return name?.trim() && /^https?:\/\//i.test(url) ? [{ name: name.trim(), color: (color ?? "").trim(), url }] : [];
    }),
    include_media_calendar: envBool("HUB_MEDIA_CALENDAR", true),
    days: envInt("HUB_DAYS", 7),
    lists: envStr("HUB_LISTS", "To do,Shopping").split(",").map(list => list.trim()).filter(Boolean),
    store_path: envStr("HUB_STORE_PATH", "var/hub.json"),
    immich_api_key: envOpt("IMMICH_API_KEY"),
    photo_album_ids: envStr("HUB_PHOTO_ALBUMS", "").split(",").map(id => id.trim()).filter(Boolean),
    photo_seconds: envInt("HUB_PHOTO_SECONDS", 60),
    countdowns: envStr("HUB_COUNTDOWNS", ""),
    night: envStr("HUB_NIGHT", ""),
  };

  const updates: UpdatesConfig = {
    check_registry: envBool("UPDATES_CHECK_REGISTRY", true),
    registry_timeout_seconds: envFloat("UPDATES_REGISTRY_TIMEOUT", 8.0),
  };

  const api: AppApiConfig = {
    plex_token: envOpt("PLEX_TOKEN"),
    sonarr_api_key: envOpt("SONARR_API_KEY"),
    radarr_api_key: envOpt("RADARR_API_KEY"),
    prowlarr_api_key: envOpt("PROWLARR_API_KEY"),
    sabnzbd_api_key: envOpt("SABNZBD_API_KEY"),
    qbittorrent_user: envOpt("QBITTORRENT_USER"),
    qbittorrent_password: envOpt("QBITTORRENT_PASSWORD"),
    tautulli_url: envStr("TAUTULLI_URL", ""),
    tautulli_api_key: envOpt("TAUTULLI_API_KEY"),
    gluetun_control_url: envStr("GLUETUN_CONTROL_URL", ""),
    gluetun_api_key: envOpt("GLUETUN_API_KEY"),
  };

  const stacks: ComposeStack[] = [
    {
      key: "media-vpn",
      display: "Media stack (behind Gluetun)",
      env_var: "MEDIA_STACK_DIR",
      directory: envStr("MEDIA_STACK_DIR", ""),
      explain: "Pulls new images for Gluetun, SABnzbd, Sonarr, Radarr, Prowlarr and qBittorrent, then recreates whichever of them changed. Recreating Gluetun drops the network namespace every other container in this stack shares, so all of them lose connectivity until the tunnel is back up. In-progress downloads are interrupted; SABnzbd and qBittorrent resume from their queues.",
      critical: true,
      configured: Boolean(envStr("MEDIA_STACK_DIR", "")),
    },
    {
      key: "immich",
      display: "Immich",
      env_var: "IMMICH_STACK_DIR",
      directory: envStr("IMMICH_STACK_DIR", ""),
      explain: "Pulls new Immich images and recreates the changed containers, including the database. Immich is unavailable while it restarts, and a major-version jump can run a one-way database migration — read Immich's release notes before taking a version bump.",
      critical: true,
      configured: Boolean(envStr("IMMICH_STACK_DIR", "")),
    },
    {
      key: "monitoring",
      display: "Monitoring stack",
      env_var: "MONITORING_STACK_DIR",
      directory: envStr("MONITORING_STACK_DIR", "deploy/monitoring-stack"),
      explain: "Pulls new Prometheus, Grafana, node-exporter, cAdvisor, smartctl-exporter and blackbox-exporter images and recreates the changed ones. Named volumes survive, so Prometheus history and Grafana dashboards are kept. Metrics gap for a few seconds.",
      critical: false,
      configured: Boolean(envStr("MONITORING_STACK_DIR", "deploy/monitoring-stack")),
    }
  ];

  const endpoints: ServiceEndpoint[] = [
    {
      key: "plex",
      display: "Plex",
      url: envStr("PLEX_URL", `http://${HOST_ADDR}:32400`) + "/identity",
      expect_status: [200],
      critical: true,
      hosting: "native systemd (plexmediaserver.service), not Docker",
    },
    {
      key: "immich",
      display: "Immich",
      url: envStr("IMMICH_URL", `http://${HOST_ADDR}:2283`) + "/api/server/ping",
      expect_status: [200],
      critical: true,
      hosting: "Docker (immich-server)",
    },
    {
      key: "aqualog",
      display: "AquaLog",
      url: envStr("AQUALOG_URL", `http://${HOST_ADDR}:8501`) + "/_stcore/health",
      expect_status: [200],
      critical: false,
      hosting: "systemd aqualog.service (Streamlit, port 8501)",
    },
    {
      key: "afldb",
      display: "AFLDB",
      url: envStr("AFLDB_URL", `http://${HOST_ADDR}:8090`),
      expect_status: [200, 301, 302, 307, 308, 401, 403],
      critical: false,
      hosting: "AFLDB application on port 8090",
    },
    {
      key: "sabnzbd",
      display: "SABnzbd",
      url: envStr("SABNZBD_URL", `http://${HOST_ADDR}:8080`),
      expect_status: [200],
      critical: false,
      hosting: "Docker via gluetun published port 8080",
    },
    {
      key: "sonarr",
      display: "Sonarr",
      url: envStr("SONARR_URL", `http://${HOST_ADDR}:8081`) + "/ping",
      expect_status: [200],
      critical: false,
      hosting: "Docker via gluetun published port 8081",
    },
    {
      key: "radarr",
      display: "Radarr",
      url: envStr("RADARR_URL", `http://${HOST_ADDR}:8082`) + "/ping",
      expect_status: [200],
      critical: false,
      hosting: "Docker via gluetun published port 8082",
    },
    {
      key: "prowlarr",
      display: "Prowlarr",
      url: envStr("PROWLARR_URL", `http://${HOST_ADDR}:8085`) + "/ping",
      expect_status: [200],
      critical: false,
      hosting: "Docker via gluetun published port 8085",
    },
    {
      key: "qbittorrent",
      display: "qBittorrent",
      url: envStr("QBITTORRENT_URL", `http://${HOST_ADDR}:8086`),
      expect_status: [200, 401, 403],
      critical: false,
      hosting: "Docker via gluetun published port 8086",
    },
    {
      key: "grafana",
      display: "Grafana",
      url: grafana_probe_url ? grafana_probe_url.replace(/\/$/, "") + "/api/health" : "",
      expect_status: [200],
      critical: false,
      hosting: grafana_url ? "Docker · monitoring stack · 127.0.0.1:3000" : (grafana_browser_url ? `Monitoring stack via browser URL: ${grafana_browser_url}` : _stack_hint),
    },
    {
      key: "prometheus",
      display: "Prometheus",
      url: prometheus_url ? prometheus_url + "/-/healthy" : "",
      expect_status: [200],
      critical: false,
      hosting: prometheus_url ? "Docker · monitoring stack · 127.0.0.1:9090" : _stack_hint,
    },
  ];

  const backups: BackupJob[] = [
    {
      key: "nightly_system",
      display: "Nightly system backup",
      directory: envStr("NIGHTLY_BACKUP_DIR", "/mnt/backup/nightly"),
      pattern: "*",
      schedule: "Daily 02:00 (backup-nightly.timer)",
      expected_interval_days: 1.0,
      min_plausible_bytes: 1_000_000,
      source: "/usr/local/bin/backup.sh",
      schedule_weekdays: [0, 1, 2, 3, 4, 5, 6],
      schedule_hour: 2,
      schedule_grace_hours: 3.0,
    },
  ];

  const expected_listeners: Record<number, string> = {
    22: "SSH",
    139: "Samba (NetBIOS)",
    445: "Samba (SMB)",
    2283: "Immich",
    6881: "qBittorrent BitTorrent (via gluetun)",
    8000: "Gluetun HTTP control API",
    8080: "SABnzbd (via gluetun)",
    8081: "Sonarr (via gluetun)",
    8082: "Radarr (via gluetun)",
    8085: "Prowlarr (via gluetun)",
    8086: "qBittorrent (via gluetun)",
    8090: "AFLDB",
    8501: "AquaLog (Streamlit)",
    32400: "Plex",
    [envInt("DASHBOARD_PORT", 8600)]: "Streamanator Dashboard",
  };

  return {
    host,
    auth,
    dashboard,
    email,
    heartbeat,
    prometheus,
    grafana,
    unifi,
    blackbox,
    local,
    raid,
    vpn,
    home,
    hub,
    api,
    updates,
    vlans: VLANS,
    disks: DISKS,
    filesystems: FILESYSTEMS,
    containers: EXPECTED_CONTAINERS,
    stacks,
    endpoints,
    backups,
    external_ports: EXTERNAL_PORTS,
    expected_listeners,
    default_refresh_seconds: envInt("DASHBOARD_REFRESH_SECONDS", 30),
    default_time_range: envStr("DASHBOARD_DEFAULT_RANGE", "24h"),
    crc_watch_serial: envStr("CRC_WATCH_SERIAL", "WPV2E6LL"),
  };
}
