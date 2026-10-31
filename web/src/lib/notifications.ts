import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import os from "node:os";
import type { Settings } from "./config";
import type { Snapshot } from "./snapshot";

type Preferences = { enabled: boolean; recipients: string[]; severities: string[]; immediate_enabled: boolean; recovery_enabled: boolean; weekly_enabled: boolean; weekly_weekday: number; weekly_hour: number };
type DeliveryState = { notified: Record<string, string>; last_weekly_period: string };
const defaults: Preferences = { enabled: false, recipients: [], severities: ["CRITICAL", "WARNING"], immediate_enabled: true, recovery_enabled: true, weekly_enabled: true, weekly_weekday: 1, weekly_hour: 8 };

function projectPath(value: string) { return path.isAbsolute(value) ? value : path.resolve(process.cwd(), "..", value); }

function loadFile(settings: Settings) {
  const filePath = projectPath(settings.email.preferences_path);
  let payload: any = null;
  try { payload = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
  const envRecipients = (process.env.EMAIL_RECIPIENTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const preferences = { ...defaults, ...(payload?.preferences ?? {}) } as Preferences;
  if (!preferences.recipients.length && envRecipients.length) preferences.recipients = envRecipients;
  if (envRecipients.length) preferences.enabled = true;
  const state: DeliveryState = { notified: payload?.state?.notified ?? {}, last_weekly_period: payload?.state?.last_weekly_period ?? "" };
  return { filePath, preferences, state };
}

function saveFile(filePath: string, preferences: Preferences, state: DeliveryState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, preferences, state }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function isoWeek(date: Date) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  copy.setUTCDate(copy.getUTCDate() + 4 - (copy.getUTCDay() || 7));
  const start = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  return `${copy.getUTCFullYear()}-W${String(Math.ceil((((copy.getTime() - start.getTime()) / 86400000) + 1) / 7)).padStart(2, "0")}`;
}

async function sendSmtp(settings: Settings, recipients: string[], subject: string, body: string) {
  const email = settings.email;
  if (!email.configured || !email.username || !email.app_password || !email.from_address) throw new Error("SMTP is not configured");
  const socket = tls.connect({ host: email.smtp_host, port: email.smtp_port, servername: email.smtp_host, rejectUnauthorized: true });
  socket.setEncoding("utf8");
  let buffer = "";
  const response = () => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SMTP response timed out")), email.timeout_seconds * 1000);
    const onData = (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\r\n");
      const end = lines.findIndex((line) => /^\d{3} /.test(line));
      if (end >= 0) { const value = lines.slice(0, end + 1).join("\r\n"); buffer = lines.slice(end + 1).join("\r\n"); clearTimeout(timer); socket.off("data", onData); resolve(value); }
    };
    socket.on("data", onData); socket.once("error", reject);
  });
  const command = async (value: string, expected: RegExp) => { socket.write(`${value}\r\n`); const reply = await response(); if (!expected.test(reply)) throw new Error(`SMTP command failed (${reply.slice(0, 3)})`); };
  await new Promise<void>((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
  if (!/^220/.test(await response())) throw new Error("SMTP greeting rejected");
  await command(`EHLO ${os.hostname()}`, /^250/); await command("AUTH LOGIN", /^334/);
  await command(Buffer.from(email.username).toString("base64"), /^334/); await command(Buffer.from(email.app_password).toString("base64"), /^235/);
  await command(`MAIL FROM:<${email.from_address}>`, /^250/);
  for (const recipient of recipients) await command(`RCPT TO:<${recipient}>`, /^25[01]/);
  await command("DATA", /^354/);
  socket.write(`From: ${email.from_address}\r\nTo: ${recipients.join(", ")}\r\nSubject: ${subject.replace(/[\r\n]/g, " ")}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body.replace(/^\./gm, "..")}\r\n.\r\n`);
  if (!/^250/.test(await response())) throw new Error("SMTP message rejected");
  socket.end("QUIT\r\n");
}

async function heartbeat(settings: Settings, failed: boolean) {
  if (!settings.heartbeat.ping_url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.heartbeat.timeout_seconds * 1000);
  try { await fetch(failed ? `${settings.heartbeat.ping_url.replace(/\/$/, "")}/fail` : settings.heartbeat.ping_url, { signal: controller.signal, cache: "no-store" }); }
  finally { clearTimeout(timer); }
}

export async function runNotificationCycle(settings: Settings, snapshot: Snapshot) {
  let failed = false;
  try {
    const { preferences, state, filePath } = loadFile(settings);
    if (preferences.enabled && preferences.recipients.length && settings.email.configured) {
      const active = Object.fromEntries(snapshot.alerts.filter((alert) => preferences.severities.includes(alert.status)).map((alert) => [alert.key, alert]));
      const added = Object.values(active).filter((alert: any) => state.notified[alert.key] !== alert.status);
      const recovered = Object.keys(state.notified).filter((key) => !(key in active));
      if (preferences.immediate_enabled && (added.length || (preferences.recovery_enabled && recovered.length))) {
        const body = [`Streamanator: ${snapshot.health.status} (${snapshot.health.score.toFixed(0)}/100)`, ...added.map((alert: any) => `[${alert.status}] ${alert.title}\n${alert.detail || ""}\nNext: ${alert.recommended_action || "Review the dashboard."}`), ...(preferences.recovery_enabled ? recovered.map((key) => `[RECOVERED] ${key}`) : [])].join("\n\n");
        await sendSmtp(settings, preferences.recipients, `[Streamanator] ${added.length ? `${added.length} new alert(s)` : "recovery"}`, body);
        state.notified = Object.fromEntries(Object.entries(active).map(([key, alert]: [string, any]) => [key, alert.status]));
      }
      const now = new Date(), period = isoWeek(now);
      const mondayBasedWeekday = (now.getDay() + 6) % 7;
      if (preferences.weekly_enabled && mondayBasedWeekday === preferences.weekly_weekday && now.getHours() >= preferences.weekly_hour && state.last_weekly_period !== period) {
        await sendSmtp(settings, preferences.recipients, `[Streamanator] Weekly summary ${period}`, [`Weekly summary for ${os.hostname()}`, `Overall: ${snapshot.health.status} (${snapshot.health.score.toFixed(0)}/100)`, ...Object.values(snapshot.components).map((component) => `${component.label}: ${component.status} — ${component.detail}`)].join("\n"));
        state.last_weekly_period = period;
      }
      saveFile(filePath, preferences, state);
    }
  } catch (error) { failed = true; console.error("Notification cycle failed", error); }
  try { await heartbeat(settings, failed); } catch (error) { console.error("Heartbeat ping failed", error); }
}
