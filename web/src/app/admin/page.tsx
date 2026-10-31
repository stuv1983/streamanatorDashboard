"use client";

import { useState, useEffect, useId } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Acquiring, Code, ErrorState, Facts, Lamp, PageHeader, Panel, Segmented, Stamp, Well, type StatusLike } from "@/components/instrument";

// ─── Simple fetch helpers ────────────────────────────────────────────────────
async function apiFetch(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) } });
  const json = await r.json();
  return { ok: r.ok, status: r.status, data: json };
}

// ─── UI Primitives ───────────────────────────────────────────────────────────
/** A labelled field: label above, recessed well input, help text under it. */
function Input({ label, name, value, type = "text", placeholder, onChange, readOnly, help }: {
  label: string; name: string; value: string; type?: string;
  placeholder?: string; onChange?: (v: string) => void; readOnly?: boolean; help?: React.ReactNode;
}) {
  const id = useId();
  // Secrets come back from the server masked; the server ignores the mask and blank values on save.
  const note = help ?? (type === "password" ? "Masked when set. Leave it unchanged to keep the current value." : null);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-silk-dim">{label}</label>
      <input
        id={id}
        name={name} type={type} value={value} readOnly={readOnly}
        placeholder={placeholder ?? ""}
        onChange={e => onChange?.(e.target.value)}
        aria-describedby={note ? `${id}-help` : undefined}
        className="h-10 w-full min-w-0 rounded-[3px] border border-seam-strong bg-well px-3 font-mono text-sm text-silk placeholder:font-sans placeholder:text-graphite disabled:opacity-50 read-only:cursor-default read-only:opacity-60"
      />
      {note && <p id={`${id}-help`} className="m-0 text-[13px] leading-snug text-silk-dim">{note}</p>}
    </div>
  );
}

/** A status line: lamp plus words, never a coloured box. */
function Notice({ status, children, role = "status" }: { status: StatusLike; children: React.ReactNode; role?: "status" | "alert" }) {
  return (
    <p role={role} className="m-0 flex items-start gap-2 text-sm text-silk">
      <Lamp status={status} className="mt-[5px]" />
      <span>{children}</span>
    </p>
  );
}

function SaveBar({ saving, message, error, onSave }: { saving: boolean; message?: string; error?: string; onSave: () => void }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-seam bg-enamel px-1 py-4">
      <Button type="button" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
      {message && <Notice status={message.startsWith("No changes") ? "INFO" : "HEALTHY"}>{message}</Notice>}
      {error && <Notice status="CRITICAL" role="alert">Couldn&apos;t save: {error}</Notice>}
      {!message && !error && <span className="text-[13px] text-silk-dim">Writes to <span className="font-mono">.env</span>; changes apply after a service restart.</span>}
    </div>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2">{children}</div>;
}

function Intro({ children }: { children: React.ReactNode }) {
  return <p className="m-0 max-w-[75ch] text-sm leading-relaxed text-silk-dim">{children}</p>;
}

// ─── Login Form ──────────────────────────────────────────────────────────────
function LoginForm({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { ok, data } = await apiFetch("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (ok) { onLogin(); }
    else { setError(data.error ?? "Sign-in failed. Check the password and try again."); }
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        group="Admin"
        title="Admin sign-in"
        description="Sign in to change server settings, edit alert rules and read the audit log."
        meta="Session lasts 8 hours"
      />
      <Panel title="Sign in" className="w-full max-w-[440px]">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Input label="Password" name="password" type="password" value={password} onChange={setPassword} help="The ADMIN_PASSWORD set in .env on the server." />
            {error && <Notice status="CRITICAL" role="alert">{error}</Notice>}
          </div>
          <Button type="submit" disabled={loading || !password} className="w-full">
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="m-0 border-t border-seam pt-4 text-[13px] leading-relaxed text-silk-dim">
          No password yet? Set <Code>ADMIN_PASSWORD</Code> in <Code>.env</Code> on the server, then restart the service.
        </p>
      </Panel>
    </div>
  );
}

// ─── Thresholds tab ──────────────────────────────────────────────────────────
function ThresholdsTab({ env, onUpdate }: { env: Record<string, string>; onUpdate: (key: string, val: string) => void }) {
  const fields = [
    { key: "TH_FS_WARNING", label: "Filesystem warning (%)", placeholder: "80" },
    { key: "TH_FS_CRITICAL", label: "Filesystem critical (%)", placeholder: "95" },
    { key: "TH_DISK_TEMP_WARNING", label: "Disk temp warning (°C)", placeholder: "50" },
    { key: "TH_DISK_TEMP_CRITICAL", label: "Disk temp critical (°C)", placeholder: "55" },
    { key: "TH_CRC_DELTA_WARNING", label: "CRC delta warning (count)", placeholder: "1" },
    { key: "TH_BACKUP_WARNING_DAYS", label: "Backup age warning (days)", placeholder: "4" },
    { key: "TH_BACKUP_CRITICAL_DAYS", label: "Backup age critical (days)", placeholder: "7" },
    { key: "TH_LATENCY_WARNING", label: "Latency warning (ms)", placeholder: "100" },
  ];
  return (
    <Panel title="Alert thresholds">
      <Intro>Limits the snapshot health checks compare against. Live-stream rules are edited on the Alert rules page.</Intro>
      <FieldGrid>
        {fields.map(f => (
          <Input key={f.key} label={f.label} name={f.key} value={env[f.key] ?? ""} placeholder={f.placeholder} onChange={v => onUpdate(f.key, v)} />
        ))}
      </FieldGrid>
    </Panel>
  );
}

// ─── VPN tab ─────────────────────────────────────────────────────────────────
function VpnTab({ env, onUpdate }: { env: Record<string, string>; onUpdate: (key: string, val: string) => void }) {
  const fields = [
    { key: "VPN_PROVIDER", label: "VPN provider", placeholder: "protonvpn" },
    { key: "VPN_PROTOCOL", label: "VPN protocol", placeholder: "wireguard" },
    { key: "GLUETUN_CONTAINER", label: "Gluetun container name", placeholder: "media-vpn_gluetun_1" },
    { key: "GLUETUN_CONTROL_URL", label: "Gluetun control URL", placeholder: "http://10.0.40.100:8000" },
    { key: "GLUETUN_API_KEY", label: "Gluetun API key", type: "password", placeholder: "leave blank to keep current" },
    { key: "VPN_IP_CHECK_URL", label: "IP check URL (VPN side)", placeholder: "https://ipinfo.io/json" },
    { key: "WAN_IP_CHECK_URL", label: "IP check URL (WAN side)", placeholder: "https://ipinfo.io/json" },
  ];
  return (
    <Panel title="VPN monitoring">
      <Intro>
        These settings control what the dashboard monitors, not the VPN tunnel itself. A new container name or provider takes effect after the next service restart.
      </Intro>
      <FieldGrid>
        {fields.map(f => (
          <Input key={f.key} label={f.label} name={f.key} type={f.type ?? "text"} value={env[f.key] ?? ""} placeholder={f.placeholder} onChange={v => onUpdate(f.key, v)} />
        ))}
      </FieldGrid>
    </Panel>
  );
}

// ─── UniFi tab ───────────────────────────────────────────────────────────────
function UnifiTab({ env, onUpdate }: { env: Record<string, string>; onUpdate: (key: string, val: string) => void }) {
  const fields = [
    { key: "UNIFI_CONTROLLER_URL", label: "Controller URL", placeholder: "https://10.0.0.1" },
    { key: "UNIFI_SITE", label: "Site", placeholder: "default" },
    { key: "UNIFI_API_KEY", label: "API key", type: "password", placeholder: "leave blank to keep current" },
    { key: "UNIFI_VERIFY_TLS", label: "Verify TLS (true/false)", placeholder: "false" },
  ];
  return (
    <Panel title="UniFi controller">
      <Intro>
        Create the API key at UniFi Console → Settings → Control Plane → Integrations. The dashboard only issues GET requests.
      </Intro>
      <FieldGrid>
        {fields.map(f => (
          <Input key={f.key} label={f.label} name={f.key} type={f.type ?? "text"} value={env[f.key] ?? ""} placeholder={f.placeholder} onChange={v => onUpdate(f.key, v)} />
        ))}
      </FieldGrid>
    </Panel>
  );
}

// ─── Service Endpoints tab ────────────────────────────────────────────────────
function EndpointsTab({ env, onUpdate }: { env: Record<string, string>; onUpdate: (key: string, val: string) => void }) {
  const fields = [
    { key: "PLEX_URL", label: "Plex URL" },
    { key: "IMMICH_URL", label: "Immich URL" },
    { key: "AQUALOG_URL", label: "AquaLog URL" },
    { key: "AFLDB_URL", label: "AFLDB URL" },
    { key: "SABNZBD_URL", label: "SABnzbd URL" },
    { key: "SONARR_URL", label: "Sonarr URL" },
    { key: "RADARR_URL", label: "Radarr URL" },
    { key: "PROWLARR_URL", label: "Prowlarr URL" },
    { key: "QBITTORRENT_URL", label: "qBittorrent URL" },
    { key: "SONARR_API_KEY", label: "Sonarr API key", type: "password" },
    { key: "RADARR_API_KEY", label: "Radarr API key", type: "password" },
    { key: "PROWLARR_API_KEY", label: "Prowlarr API key", type: "password" },
    { key: "PLEX_TOKEN", label: "Plex token", type: "password" },
    { key: "SABNZBD_API_KEY", label: "SABnzbd API key", type: "password" },
  ];
  const urls = fields.filter(f => !f.type);
  const keys = fields.filter(f => f.type === "password");
  const render = (f: (typeof fields)[number]) => (
    <Input key={f.key} label={f.label} name={f.key} type={f.type ?? "text"} value={env[f.key] ?? ""} placeholder={env[f.key] ? "" : "not set"} onChange={v => onUpdate(f.key, v)} />
  );
  return (
    <>
      <Panel title="Service URLs">
        <Intro>Where the dashboard reaches each service for health checks and the home pages.</Intro>
        <FieldGrid>{urls.map(render)}</FieldGrid>
      </Panel>
      <Panel title="Service API keys">
        <FieldGrid>{keys.map(render)}</FieldGrid>
      </Panel>
    </>
  );
}

function NotificationsTab({ env, onUpdate }: { env: Record<string, string>; onUpdate: (key: string, val: string) => void }) {
  const fields = [
    { key: "EMAIL_SMTP_HOST", label: "SMTP host" },
    { key: "EMAIL_SMTP_PORT", label: "SMTP port" },
    { key: "EMAIL_SMTP_USER", label: "SMTP username" },
    { key: "EMAIL_SMTP_APP_PASSWORD", label: "SMTP app password", type: "password" },
    { key: "EMAIL_FROM", label: "From address" },
    { key: "EMAIL_RECIPIENTS", label: "Recipients (comma-separated)" },
    { key: "HEALTHCHECKS_PING_URL", label: "Heartbeat URL", type: "password" },
  ];
  return (
    <Panel title="Notifications">
      <Intro>Alert email delivery and the dead-man heartbeat the server pings while it is running.</Intro>
      <FieldGrid>
        {fields.map((field) => <Input key={field.key} label={field.label} name={field.key} type={field.type ?? "text"} value={env[field.key] ?? ""} onChange={(value) => onUpdate(field.key, value)} />)}
      </FieldGrid>
    </Panel>
  );
}

function HomeTab({ env, onUpdate }: { env: Record<string, string>; onUpdate: (key: string, val: string) => void }) {
  const hubFields = [
    { key: "HUB_TITLE", label: "Hub title", placeholder: "Home" },
    { key: "HUB_CALENDARS", label: "Calendars (Name|#colour|ical-url; …)", type: "password", placeholder: "Family|#3987e5|https://calendar.google.com/…/basic.ics" },
    { key: "HUB_LISTS", label: "Lists (comma-separated)", placeholder: "To do,Shopping" },
    { key: "HUB_COUNTDOWNS", label: "Countdowns (Name|YYYY-MM-DD or Name|MM-DD; …)", placeholder: "Christmas|12-25;Holiday|2027-01-10" },
    { key: "HUB_NIGHT", label: "Night dimming (HH:MM-HH:MM)", placeholder: "22:00-06:30" },
    { key: "HUB_MEDIA_CALENDAR", label: "Show Sonarr/Radarr on the calendar (true/false)", placeholder: "true" },
    { key: "IMMICH_API_KEY", label: "Immich API key (photos)", type: "password" },
    { key: "HUB_PHOTO_ALBUMS", label: "Immich album ids (comma-separated)", placeholder: "from the album URL: /albums/<id>" },
    { key: "HUB_PHOTO_SECONDS", label: "Seconds per photo", placeholder: "60" },
  ];
  const fields = [
    { key: "WEATHER_LOCATION", label: "Weather location name", placeholder: "Melbourne" },
    { key: "WEATHER_LATITUDE", label: "Latitude (or off)", placeholder: "-37.8136" },
    { key: "WEATHER_LONGITUDE", label: "Longitude", placeholder: "144.9631" },
    { key: "CALENDAR_DAYS", label: "Calendar look-ahead (days)", placeholder: "7" },
    { key: "RSS_FEEDS", label: "RSS feeds (comma-separated URLs)", placeholder: "https://…/rss, https://…/atom.xml" },
    { key: "QBITTORRENT_USER", label: "qBittorrent username" },
    { key: "QBITTORRENT_PASSWORD", label: "qBittorrent password", type: "password" },
  ];
  return (
    <>
      <Panel title="Home hub · /hub">
        <Intro>
          The family display on the Pi. Calendar addresses are private links: Google Calendar → Settings → your calendar → “Secret address in iCal format”; iCloud → share calendar → Public Calendar; Outlook → Settings → Shared calendars → Publish → ICS. They stay on the server.
          The Immich key needs album.read and asset.view permissions.
        </Intro>
        <FieldGrid>
          {hubFields.map(f => (
            <Input key={f.key} label={f.label} name={f.key} type={f.type ?? "text"} value={env[f.key] ?? ""} placeholder={f.placeholder} onChange={v => onUpdate(f.key, v)} />
          ))}
        </FieldGrid>
      </Panel>
      <Panel title="Apps, media and weather · /home">
        <Intro>
          Weather is shared by both pages. Plex, Sonarr, Radarr and SABnzbd use the keys on the Service endpoints tab. Bookmarks are edited on the page itself.
        </Intro>
        <FieldGrid>
          {fields.map(f => (
            <Input key={f.key} label={f.label} name={f.key} type={f.type ?? "text"} value={env[f.key] ?? ""} placeholder={f.placeholder} onChange={v => onUpdate(f.key, v)} />
          ))}
        </FieldGrid>
      </Panel>
    </>
  );
}

// ─── Main Admin Page ──────────────────────────────────────────────────────────
export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"thresholds" | "vpn" | "unifi" | "endpoints" | "home" | "notifications" | "security">("thresholds");
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  async function loadSettings() {
    setLoading(true);
    const { ok, data } = await apiFetch("/api/admin/settings");
    setLoading(false);
    if (ok) {
      setSettings(data);
      setEdits(data.env ?? {});
      setAuthed(true);
    } else if (data?.error === "Unauthorized") {
      setAuthed(false);
    } else {
      setAuthed(true); // logged in but settings fetch failed
    }
  }

  useEffect(() => { loadSettings(); }, []);

  function handleFieldUpdate(key: string, value: string) {
    setEdits(prev => ({ ...prev, [key]: value }));
    setSaveMessage("");
    setSaveError("");
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    const { ok, data } = await apiFetch("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ updates: edits }),
    });
    setSaving(false);
    if (ok) { setSaveMessage(data.message ?? "Changes saved."); }
    else { setSaveError(data.error ?? "The server didn't write .env. Check the service log, then save again."); }
  }

  async function handleLogout() {
    await apiFetch("/api/admin/logout", { method: "POST" });
    setAuthed(false);
    setSettings(null);
    setEdits({});
  }

  if (authed === null) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader group="Admin" title="Admin" description="Checking whether this browser has an admin session." />
        <Acquiring rows={3} />
      </div>
    );
  }
  if (authed === false) return <LoginForm onLogin={loadSettings} />;

  const tabs: { id: typeof tab; label: string }[] = [
    { id: "thresholds", label: "Alert thresholds" },
    { id: "vpn", label: "VPN" },
    { id: "unifi", label: "UniFi" },
    { id: "endpoints", label: "Service endpoints" },
    { id: "home", label: "Home & hub" },
    { id: "notifications", label: "Notifications" },
    { id: "security", label: "Security" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        group="Admin"
        title="Settings"
        description="Change the server settings the dashboard reads from .env; saved changes apply after a service restart."
        meta={<>Writes to .env on the server · session lasts 8 hours</>}
        actions={
          <>
            <Stamp status="HEALTHY" label="SIGNED IN" />
            <Button type="button" variant="outline" onClick={handleLogout}>Sign out</Button>
          </>
        }
      />

      <Well className="flex flex-col gap-2">
        <p className="m-0 text-sm text-silk-dim">
          Saved changes are written to <Code>.env</Code> on the server. Restart the service for them to take effect:
        </p>
        <Code className="block w-fit max-w-full overflow-x-auto whitespace-nowrap px-2 py-1">sudo systemctl restart streamanator-dashboard</Code>
      </Well>

      {loading ? (
        <Acquiring rows={3} />
      ) : (
        <div className="flex flex-col gap-5">
          {!settings && (
            <ErrorState title="Settings didn't load">
              Your session is valid, but <span className="font-mono">/api/admin/settings</span> returned an error, so current values aren&apos;t shown. Reload the page to try again.
            </ErrorState>
          )}

          <Segmented label="Settings group" options={tabs.map(t => ({ value: t.id, label: t.label }))} value={tab} onChange={setTab} />

          {tab === "thresholds" && <ThresholdsTab env={edits} onUpdate={handleFieldUpdate} />}
          {tab === "vpn" && <VpnTab env={edits} onUpdate={handleFieldUpdate} />}
          {tab === "unifi" && <UnifiTab env={edits} onUpdate={handleFieldUpdate} />}
          {tab === "endpoints" && <EndpointsTab env={edits} onUpdate={handleFieldUpdate} />}
          {tab === "home" && <HomeTab env={edits} onUpdate={handleFieldUpdate} />}
          {tab === "notifications" && <NotificationsTab env={edits} onUpdate={handleFieldUpdate} />}
          {tab === "security" && (
            <>
              <Panel title="Credentials">
                <FieldGrid>
                  <Input label="Admin password" name="ADMIN_PASSWORD" type="password" value={edits.ADMIN_PASSWORD ?? ""} placeholder="set new password" onChange={v => handleFieldUpdate("ADMIN_PASSWORD", v)} />
                  <Input label="Session secret (JWT signing key)" name="ADMIN_SESSION_SECRET" type="password" value={edits.ADMIN_SESSION_SECRET ?? ""} placeholder="set new secret (long random string)" onChange={v => handleFieldUpdate("ADMIN_SESSION_SECRET", v)} />
                </FieldGrid>
                <Facts
                  className="border-t border-seam pt-4"
                  items={[
                    ["Password", "Entered at sign-in and stored in the server-only .env file."],
                    ["Session secret", "Signs the sign-in cookie and must be at least 32 characters. There is no insecure fallback."],
                    ["After a change", "Restart the service, then sign in again."],
                  ]}
                />
              </Panel>

              {/* Active threshold display (read-only) */}
              {settings?.thresholds && (
                <Panel title="Active thresholds" action={<span className="text-[13px] text-graphite">Read-only. Edit them under Alert thresholds.</span>}>
                  <div className="overflow-x-auto rounded-[3px] border border-seam">
                    <Table>
                      <TableHeader className="bg-well">
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="px-3">Setting</TableHead>
                          <TableHead className="px-3 text-right">Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {Object.entries(settings.thresholds).map(([section, values]) => (
                          typeof values === "object" ? Object.entries(values as Record<string, unknown>).map(([k, v]) => (
                            <TableRow key={`${section}.${k}`}>
                              <TableCell className="px-3 py-2 font-mono text-[13px] text-silk-dim">{section}.{k}</TableCell>
                              <TableCell className="px-3 py-2 text-right font-mono text-[13px] tabular-nums text-silk">{String(v)}</TableCell>
                            </TableRow>
                          )) : null
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Panel>
              )}
            </>
          )}
          <SaveBar saving={saving} message={saveMessage} error={saveError} onSave={handleSave} />
        </div>
      )}
    </div>
  );
}
