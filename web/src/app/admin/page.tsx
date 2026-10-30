"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

// ─── Simple fetch helpers ────────────────────────────────────────────────────
async function apiFetch(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) } });
  const json = await r.json();
  return { ok: r.ok, status: r.status, data: json };
}

// ─── UI Primitives ───────────────────────────────────────────────────────────
function Input({ label, name, value, type = "text", placeholder, onChange, readOnly }: {
  label: string; name: string; value: string; type?: string;
  placeholder?: string; onChange?: (v: string) => void; readOnly?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
      <input
        name={name} type={type} value={value} readOnly={readOnly}
        placeholder={placeholder ?? ""}
        onChange={e => onChange?.(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 read-only:opacity-60 read-only:cursor-default"
      />
    </div>
  );
}

function SaveBar({ saving, message, error, onSave }: { saving: boolean; message?: string; error?: string; onSave: () => void }) {
  return (
    <div className="flex items-center gap-3 mt-4 pt-4 border-t">
      <button
        onClick={onSave} disabled={saving}
        className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition"
      >
        {saving ? "Saving…" : "Save to .env"}
      </button>
      {message && <span className="text-sm text-green-500">{message}</span>}
      {error && <span className="text-sm text-red-500">{error}</span>}
      {!message && !error && <span className="text-xs text-muted-foreground">Changes apply after service restart.</span>}
    </div>
  );
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
    else { setError(data.error ?? "Login failed"); }
  }

  return (
    <div className="max-w-sm mx-auto mt-16">
      <Card>
        <CardHeader>
          <CardTitle>Admin sign-in</CardTitle>
          <CardDescription>Privileged access to configuration and actions</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input label="Password" name="password" type="password" value={password} onChange={setPassword} />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <button
              type="submit" disabled={loading || !password}
              className="w-full px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 transition"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="text-xs text-muted-foreground mt-4">
            Set <code className="font-mono bg-muted px-1 rounded">ADMIN_PASSWORD</code> in <code className="font-mono bg-muted px-1 rounded">.env</code> on the server, then restart the service.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Tab button ──────────────────────────────────────────────────────────────
function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-t-md border-b-2 transition ${
        active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
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
    <div className="grid sm:grid-cols-2 gap-4">
      {fields.map(f => (
        <Input key={f.key} label={f.label} name={f.key} value={env[f.key] ?? ""} placeholder={f.placeholder} onChange={v => onUpdate(f.key, v)} />
      ))}
    </div>
  );
}

// ─── VPN tab ─────────────────────────────────────────────────────────────────
function VpnTab({ env, onUpdate }: { env: Record<string, string>; onUpdate: (key: string, val: string) => void }) {
  const fields = [
    { key: "VPN_PROVIDER", label: "VPN provider", placeholder: "nordvpn" },
    { key: "VPN_PROTOCOL", label: "VPN protocol", placeholder: "openvpn" },
    { key: "GLUETUN_CONTAINER", label: "Gluetun container name", placeholder: "media-vpn_gluetun_1" },
    { key: "GLUETUN_CONTROL_URL", label: "Gluetun control URL", placeholder: "http://10.0.40.100:8000" },
    { key: "GLUETUN_API_KEY", label: "Gluetun API key", type: "password", placeholder: "leave blank to keep current" },
    { key: "VPN_IP_CHECK_URL", label: "IP check URL (VPN side)", placeholder: "https://ipinfo.io/json" },
    { key: "WAN_IP_CHECK_URL", label: "IP check URL (WAN side)", placeholder: "https://ipinfo.io/json" },
  ];
  return (
    <div className="space-y-4">
      <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3 text-xs text-blue-400">
        VPN settings control what the dashboard monitors — not the VPN tunnel itself. Changing the container name or provider reloads on next service restart.
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        {fields.map(f => (
          <Input key={f.key} label={f.label} name={f.key} type={f.type ?? "text"} value={env[f.key] ?? ""} placeholder={f.placeholder} onChange={v => onUpdate(f.key, v)} />
        ))}
      </div>
    </div>
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
    <div className="space-y-4">
      <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3 text-xs text-blue-400">
        Create the API key at UniFi Console → Settings → Control Plane → Integrations. The dashboard only issues GET requests.
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        {fields.map(f => (
          <Input key={f.key} label={f.label} name={f.key} type={f.type ?? "text"} value={env[f.key] ?? ""} placeholder={f.placeholder} onChange={v => onUpdate(f.key, v)} />
        ))}
      </div>
    </div>
  );
}

// ─── Service Endpoints tab ────────────────────────────────────────────────────
function EndpointsTab({ env, onUpdate }: { env: Record<string, string>; onUpdate: (key: string, val: string) => void }) {
  const fields = [
    { key: "PLEX_URL", label: "Plex URL" },
    { key: "IMMICH_URL", label: "Immich URL" },
    { key: "SPORTS_DATA_LAB_URL", label: "Sports Data Lab URL" },
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
  return (
    <div className="grid sm:grid-cols-2 gap-4">
      {fields.map(f => (
        <Input key={f.key} label={f.label} name={f.key} type={f.type ?? "text"} value={env[f.key] ?? ""} placeholder={env[f.key] ? "" : "not set"} onChange={v => onUpdate(f.key, v)} />
      ))}
    </div>
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
  return <div className="space-y-4"><p className="text-sm text-muted-foreground">Alert delivery and dead-man heartbeat configuration.</p><div className="grid sm:grid-cols-2 gap-4">{fields.map((field) => <Input key={field.key} label={field.label} name={field.key} type={field.type ?? "text"} value={env[field.key] ?? ""} onChange={(value) => onUpdate(field.key, value)} />)}</div></div>;
}

// ─── Main Admin Page ──────────────────────────────────────────────────────────
export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"thresholds" | "vpn" | "unifi" | "endpoints" | "notifications" | "security">("thresholds");
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
    if (ok) { setSaveMessage(data.message ?? "Saved."); }
    else { setSaveError(data.error ?? "Failed to save."); }
  }

  async function handleLogout() {
    await apiFetch("/api/admin/logout", { method: "POST" });
    setAuthed(false);
    setSettings(null);
    setEdits({});
  }

  if (authed === null) return <Skeleton className="h-64 w-full" />;
  if (authed === false) return <LoginForm onLogin={loadSettings} />;

  const tabs: { id: typeof tab; label: string }[] = [
    { id: "thresholds", label: "Alert thresholds" },
    { id: "vpn", label: "VPN" },
    { id: "unifi", label: "UniFi" },
    { id: "endpoints", label: "Service endpoints" },
    { id: "notifications", label: "Notifications" },
    { id: "security", label: "Security" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
          <p className="text-muted-foreground mt-1">Configuration and privileged actions</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge className="bg-green-500 text-white">Authenticated</Badge>
          <button onClick={handleLogout} className="text-sm text-muted-foreground hover:text-foreground transition">Sign out</button>
        </div>
      </div>

      <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3 text-xs text-blue-400">
        Changes are written to <code className="font-mono bg-blue-900/20 px-1 rounded">.env</code> on the server. The service must be restarted for them to take effect: <code className="font-mono bg-blue-900/20 px-1 rounded">sudo systemctl restart streamanator-dashboard</code>
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <Card>
          <CardHeader className="pb-0">
            <div className="flex gap-1 border-b -mb-px">
              {tabs.map(t => <Tab key={t.id} label={t.label} active={tab === t.id} onClick={() => setTab(t.id)} />)}
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {tab === "thresholds" && <ThresholdsTab env={edits} onUpdate={handleFieldUpdate} />}
            {tab === "vpn" && <VpnTab env={edits} onUpdate={handleFieldUpdate} />}
            {tab === "unifi" && <UnifiTab env={edits} onUpdate={handleFieldUpdate} />}
            {tab === "endpoints" && <EndpointsTab env={edits} onUpdate={handleFieldUpdate} />}
            {tab === "notifications" && <NotificationsTab env={edits} onUpdate={handleFieldUpdate} />}
            {tab === "security" && (
              <div className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <Input label="Admin password" name="ADMIN_PASSWORD" type="password" value={edits.ADMIN_PASSWORD ?? ""} placeholder="set new password" onChange={v => handleFieldUpdate("ADMIN_PASSWORD", v)} />
                  <Input label="Session secret (JWT signing key)" name="ADMIN_SESSION_SECRET" type="password" value={edits.ADMIN_SESSION_SECRET ?? ""} placeholder="set new secret (long random string)" onChange={v => handleFieldUpdate("ADMIN_SESSION_SECRET", v)} />
                </div>
                <div className="text-xs text-muted-foreground space-y-1 p-3 bg-muted/30 rounded">
                  <p>• <strong>Admin password</strong> — entered at login and stored in the server-only .env file.</p>
                  <p>• <strong>Session secret</strong> — signs the login cookie and must be at least 32 characters. There is no insecure fallback.</p>
                  <p>• Changing either requires a service restart and a new login.</p>
                </div>

                {/* Active threshold display (read-only) */}
                {settings?.thresholds && (
                  <div className="mt-4">
                    <h3 className="text-sm font-semibold mb-2">Active thresholds (read-only — edit in Thresholds tab)</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <tbody>
                          {Object.entries(settings.thresholds).map(([section, values]) => (
                            typeof values === "object" ? Object.entries(values as Record<string, unknown>).map(([k, v]) => (
                              <tr key={`${section}.${k}`} className="border-b border-border/30">
                                <td className="py-1 pr-4 font-mono text-muted-foreground">{section}.{k}</td>
                                <td className="py-1 font-bold">{String(v)}</td>
                              </tr>
                            )) : null
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
            <SaveBar saving={saving} message={saveMessage} error={saveError} onSave={handleSave} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
