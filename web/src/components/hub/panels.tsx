"use client";

import { useState } from "react";
import {
  Check, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun,
  Moon, Plus, Sun, Trash2,
} from "lucide-react";
import { Lamp, Void } from "@/components/instrument";
import type { Countdown, HubEvent } from "@/lib/hub/hub";
import type { ListItem } from "@/lib/hub/store";
import type { Weather } from "@/lib/widgets";

// Shared by every panel on the hub: translucent enamel over the photo, with a
// hairline seam. 80 % keeps silk-dim text above 4.5:1 even over a white photo.
export const PANEL = "rounded-[3px] border border-seam bg-[rgb(20_25_23/0.8)] p-[clamp(1rem,1.6vmax,2rem)] text-silk backdrop-blur-md";
/** Silkscreened section label (AGENDA, TO DO, SHOPPING). Never a sentence. */
export const LABEL = "panel-label m-0 text-[clamp(0.62rem,0.78vmax,0.95rem)] text-silk-dim";

export function WeatherIcon({ code, isDay = true, className }: { code: number | null; isDay?: boolean; className?: string }) {
  const Icon =
    code === null ? Cloud
      : code <= 1 ? (isDay ? Sun : Moon)
        : code === 2 ? (isDay ? CloudSun : CloudMoon)
          : code === 3 ? Cloud
            : code <= 48 ? CloudFog
              : code <= 57 ? CloudDrizzle
                : code <= 67 || (code >= 80 && code <= 82) ? CloudRain
                  : code <= 77 || code === 85 || code === 86 ? CloudSnow
                    : CloudLightning;
  return <Icon className={className} aria-hidden />;
}

const time = (iso: string) => iso.slice(11, 16);

function hourLabel(iso: string): string {
  const h = Number(iso.slice(11, 13));
  return h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;
}

/** A missing forecast figure: said, not drawn as a number. */
const NA = <span className="text-silk-dim">n/a</span>;
const deg = (v: number | null | undefined) => (v == null ? NA : `${Math.round(v)}°`);

export function ClockPanel({ now, timezone, title, onTap }: { now: Date | null; timezone: string; title: string; onTap: () => void }) {
  const opts = { timeZone: timezone };
  const hour = now ? Number(now.toLocaleString("en-AU", { ...opts, hour: "numeric", hourCycle: "h23" })) : 12;
  const greeting = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <button type="button" onClick={onTap} className="block rounded-[3px] text-left text-silk drop-shadow-[0_2px_12px_rgba(0,0,0,0.85)]" aria-label="Show photos only">
      <p className="m-0 text-[clamp(1rem,1.5vmax,1.8rem)] font-medium text-silk">{greeting} · {title}</p>
      <p className="m-0 font-mono font-medium leading-none tabular-nums tracking-[-0.03em] text-[clamp(4rem,9vmax,11rem)]">
        {now ? now.toLocaleTimeString("en-AU", { ...opts, hour: "numeric", minute: "2-digit" }).replace(/\s?[ap]m$/i, "") : " "}
        <span className="ml-[0.15em] font-sans text-[0.28em] font-medium tracking-normal text-silk-dim">
          {now ? now.toLocaleTimeString("en-AU", { ...opts, hour: "numeric" }).match(/[ap]m/i)?.[0] : ""}
        </span>
      </p>
      <p className="m-0 mt-[0.2em] text-[clamp(1.1rem,1.9vmax,2.4rem)] text-silk">
        {now ? now.toLocaleDateString("en-AU", { ...opts, weekday: "long", day: "numeric", month: "long" }) : " "}
      </p>
    </button>
  );
}

export function WeatherPanel({ weather }: { weather: Weather | null }) {
  if (!weather) return null;
  const today = weather.days[0];
  return (
    <section className={PANEL} aria-label="Weather">
      <div className="flex items-center gap-[clamp(0.75rem,1.2vmax,1.5rem)]">
        <WeatherIcon code={weather.code} isDay={weather.isDay} className="h-[clamp(3rem,5vmax,6rem)] w-[clamp(3rem,5vmax,6rem)] shrink-0 text-silk" />
        <div className="min-w-0">
          {weather.temperature != null ? (
            <p className="m-0 font-mono text-[clamp(2.5rem,4.5vmax,5.5rem)] font-medium leading-none tabular-nums">{Math.round(weather.temperature)}°</p>
          ) : (
            <Void state="NO_DATA" note="No current temperature" />
          )}
          <p className="m-0 mt-[0.2em] truncate text-[clamp(0.9rem,1.2vmax,1.4rem)] text-silk-dim">
            {weather.summary}{weather.apparent != null ? <> · feels <span className="font-mono">{Math.round(weather.apparent)}°</span></> : ""}
          </p>
        </div>
        {today && (
          <dl className="m-0 ml-auto grid grid-cols-[auto_auto] items-baseline gap-x-[0.7em] gap-y-[0.2em] text-right text-[clamp(0.8rem,1vmax,1.2rem)]">
            <dt className="text-silk-dim">High / low</dt>
            <dd className="m-0 font-mono tabular-nums"><span className="text-silk">{deg(today.max)}</span> <span className="text-silk-dim">{deg(today.min)}</span></dd>
            {today.rainChance != null && <><dt className="text-silk-dim">Rain</dt><dd className="m-0 font-mono tabular-nums">{today.rainChance}%</dd></>}
            {today.uvMax != null && <><dt className="text-silk-dim">UV</dt><dd className="m-0 font-mono tabular-nums">{Math.round(today.uvMax)}</dd></>}
          </dl>
        )}
      </div>

      <div className="mt-[clamp(0.75rem,1.2vmax,1.5rem)] grid grid-cols-6 gap-1 rounded-[2px] border border-seam bg-[rgb(15_19_17/0.6)] px-1 py-[0.6em] text-center text-[clamp(0.7rem,0.9vmax,1.05rem)]">
        {weather.hours.filter((_, i) => i % 3 === 0).slice(0, 6).map(hour => (
          <div key={hour.time} className="flex flex-col items-center gap-[0.3em]">
            <span className="text-silk-dim">{hourLabel(hour.time)}</span>
            <WeatherIcon code={hour.code} isDay={hour.isDay} className="h-[1.6em] w-[1.6em] text-silk" />
            <span className="font-mono tabular-nums">{deg(hour.temperature)}</span>
            <span className={`font-mono tabular-nums ${hour.rainChance && hour.rainChance >= 40 ? "font-semibold text-silk" : "text-silk-dim"}`}>{hour.rainChance != null ? `${hour.rainChance}%` : " "}</span>
          </div>
        ))}
      </div>

      <div className="mt-[clamp(0.75rem,1.2vmax,1.5rem)] flex flex-col gap-[0.25em] text-[clamp(0.8rem,1vmax,1.2rem)]">
        {weather.days.slice(1, 6).map(day => (
          <div key={day.date} className="flex items-center gap-3">
            <span className="w-[3.2em] text-silk-dim">{new Date(`${day.date}T12:00:00`).toLocaleDateString("en-AU", { weekday: "short" })}</span>
            <WeatherIcon code={day.code} className="h-[1.3em] w-[1.3em] shrink-0 text-silk" />
            <span className="min-w-0 flex-1 truncate text-silk-dim">{day.summary}</span>
            {day.rainChance != null && day.rainChance >= 20 && <span className="font-mono tabular-nums text-silk">rain {day.rainChance}%</span>}
            <span className="w-[5.5em] text-right font-mono tabular-nums">{deg(day.max)} <span className="text-silk-dim">{deg(day.min)}</span></span>
          </div>
        ))}
      </div>
      {today?.sunrise && (
        <p className="m-0 mt-[0.7em] flex gap-[1.2em] border-t border-seam pt-[0.6em] text-[clamp(0.75rem,0.9vmax,1.05rem)] text-silk-dim">
          <span>Sunrise <span className="font-mono text-silk">{time(today.sunrise)}</span></span>
          <span>Sunset <span className="font-mono text-silk">{time(today.sunset)}</span></span>
          <span className="ml-auto truncate">{weather.location}</span>
        </p>
      )}
    </section>
  );
}

function dayKeys(today: string, count: number): string[] {
  const start = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
}

function dayHeading(key: string, today: string): string {
  const offset = Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  return new Date(`${key}T12:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" });
}

/** An event belongs to every display day it touches; all-day end dates are exclusive. */
function onDay(event: HubEvent, key: string): boolean {
  return event.allDay ? event.startDate <= key && key < event.endDate : event.startDate <= key && key <= event.endDate;
}

export function AgendaPanel({ events, today, timezone, now, days, setupHint, errors }: {
  events: HubEvent[]; today: string; timezone: string; now: number; days: number; setupHint: boolean; errors: string[];
}) {
  const fmt = (ms: number) => new Date(ms).toLocaleTimeString("en-AU", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "");
  const groups = dayKeys(today, days)
    .map(key => ({
      key,
      events: events.filter(event => onDay(event, key) && (key !== today || event.allDay || event.end > now)),
    }))
    .filter((group, index) => index < 2 || group.events.length > 0);

  return (
    <section className={`${PANEL} flex min-h-0 flex-col`} aria-label="Calendar">
      <h2 className={LABEL}>Agenda</h2>
      {setupHint && (
        <div className="mt-3 flex flex-col items-start gap-2">
          <Void state="NOT_CONFIGURED" />
          <p className="m-0 text-[clamp(0.9rem,1.1vmax,1.3rem)] leading-snug text-silk-dim">
            Add your family calendars under Admin → Home page → Calendars (Google: Settings → your calendar → “Secret address in iCal format”).
          </p>
        </div>
      )}
      {/* Fades out rather than slicing a day in half where the panel ends. */}
      <div className="mt-[0.6em] min-h-0 flex-1 space-y-[clamp(0.6rem,1vmax,1.25rem)] overflow-hidden [mask-image:linear-gradient(to_bottom,black_85%,transparent)]">
        {groups.map(group => (
          <div key={group.key}>
            <h3 className="m-0 mb-[0.35em] border-b border-seam pb-[0.2em] text-[clamp(1rem,1.35vmax,1.6rem)] font-semibold text-silk">{dayHeading(group.key, today)}</h3>
            {group.events.length === 0 ? (
              <p className="m-0 text-[clamp(0.9rem,1.1vmax,1.3rem)] text-silk-dim">Nothing on</p>
            ) : (
              <ul className="m-0 list-none space-y-[clamp(0.25rem,0.45vmax,0.6rem)] p-0">
                {group.events.slice(0, 8).map(event => {
                  const happening = !event.allDay && event.start <= now && now < event.end;
                  return (
                    <li key={`${event.calendar}-${event.uid}-${event.start}`} className="flex items-baseline gap-[0.7em] text-[clamp(0.95rem,1.2vmax,1.45rem)]">
                      {/* The calendar's own colour: identity, not status. */}
                      <span className="lamp size-[0.55em] self-center" style={{ backgroundColor: event.color }} title={event.calendar} aria-hidden />
                      <span className="w-[4.4em] shrink-0 font-mono text-[0.9em] tabular-nums text-silk-dim">{event.allDay ? "All day" : fmt(event.start)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-1">{event.title}</span>
                        {event.location && <span className="line-clamp-1 text-[0.8em] text-silk-dim">{event.location.split("\n")[0]}</span>}
                      </span>
                      {happening && (
                        <span className="self-center rounded-[2px] border border-trace px-[0.5em] py-[0.25em] font-panel text-[0.55em] uppercase leading-none tracking-[0.12em] text-trace">Now</span>
                      )}
                    </li>
                  );
                })}
                {group.events.length > 8 && <li className="pl-[5.6em] text-[clamp(0.8rem,1vmax,1.2rem)] text-silk-dim">+{group.events.length - 8} more</li>}
              </ul>
            )}
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <p className="m-0 mt-[0.6em] flex min-w-0 items-center gap-[0.5em] text-[clamp(0.75rem,0.9vmax,1.05rem)] text-silk-dim" title={errors.join("\n")}>
          <Lamp status="WARNING" label="Warning" />
          <span className="truncate">Couldn&apos;t read {errors.join(" · ")}</span>
        </p>
      )}
    </section>
  );
}

export function ListsPanel({ lists, items, onAction }: {
  lists: string[];
  items: ListItem[];
  onAction: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [active, setActive] = useState(lists[0] ?? "");
  const [draft, setDraft] = useState("");
  const list = lists.includes(active) ? active : lists[0];
  const shown = items.filter(item => item.list === list).sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt - b.createdAt);
  const openCount = (name: string) => items.filter(item => item.list === name && !item.done).length;

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await onAction({ action: "add", list, text });
  };

  return (
    <section className={`${PANEL} flex min-h-0 flex-1 flex-col`} aria-label="Lists">
      {/* List names are the section labels: TO DO, SHOPPING. */}
      <div className="flex flex-wrap gap-1 self-start rounded-[3px] border border-seam bg-[rgb(15_19_17/0.7)] p-1" role="tablist">
        {lists.map(name => (
          <button key={name} type="button" role="tab" aria-selected={name === list} onClick={() => setActive(name)}
            className={`flex min-h-12 items-center gap-[0.6em] rounded-[2px] px-[1em] font-panel text-[clamp(0.66rem,0.82vmax,1rem)] uppercase tracking-[0.12em] transition-colors motion-reduce:transition-none ${name === list ? "bg-bezel text-silk shadow-[inset_0_0_0_1px_var(--seam-strong)]" : "text-silk-dim"}`}>
            {name}
            {openCount(name) > 0 && <span className="font-mono text-[1.25em] tracking-normal tabular-nums">{openCount(name)}</span>}
          </button>
        ))}
      </div>
      <ul className="m-0 mt-[0.6em] min-h-0 flex-1 list-none overflow-y-auto overscroll-contain p-0">
        {shown.length === 0 && <li className="py-2 text-[clamp(0.9rem,1.1vmax,1.3rem)] text-silk-dim">All clear.</li>}
        {shown.map(item => (
          <li key={item.id} className="flex items-center border-b border-seam last:border-0">
            <button type="button" onClick={() => void onAction({ action: "toggle", id: item.id })}
              className="flex min-h-12 flex-1 items-center gap-[0.7em] py-1 text-left text-[clamp(1rem,1.25vmax,1.5rem)]" aria-pressed={item.done}>
              <span className={`flex h-[1.3em] w-[1.3em] shrink-0 items-center justify-center rounded-[2px] border-2 ${item.done ? "border-silk-dim bg-silk-dim text-enamel" : "border-silk-dim bg-[rgb(15_19_17/0.6)]"}`}>
                {item.done && <Check className="h-[0.9em] w-[0.9em]" strokeWidth={3} aria-hidden />}
              </span>
              <span className={item.done ? "text-silk-dim line-through decoration-silk-dim" : "text-silk"}>{item.text}</span>
            </button>
            {item.done && (
              <button type="button" onClick={() => void onAction({ action: "delete", id: item.id })} className="flex min-h-12 min-w-12 items-center justify-center rounded-[2px] text-silk-dim" aria-label={`Remove ${item.text}`}>
                <Trash2 className="h-5 w-5" aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={event => { event.preventDefault(); void add(); }} className="mt-[0.7em] flex gap-2">
        <input value={draft} onChange={event => setDraft(event.target.value)} maxLength={140} placeholder={`Add to ${list}…`} aria-label={`Add to ${list}`}
          className="min-h-12 min-w-0 flex-1 rounded-[2px] border border-seam bg-[rgb(15_19_17/0.75)] px-[0.9em] text-[clamp(0.95rem,1.15vmax,1.35rem)] text-silk shadow-[inset_0_2px_0_rgb(0_0_0/0.35)] outline-none placeholder:text-silk-dim focus:border-trace" />
        <button type="submit" className="flex min-h-12 min-w-12 items-center justify-center rounded-[2px] border border-silk bg-silk text-enamel" aria-label="Add">
          <Plus className="h-6 w-6" aria-hidden />
        </button>
      </form>
      {shown.some(item => item.done) && (
        <button type="button" onClick={() => void onAction({ action: "clear-done", list })}
          className="mt-2 min-h-12 self-start rounded-[2px] border border-seam px-[1em] text-[clamp(0.8rem,0.95vmax,1.1rem)] text-silk-dim">
          Clear ticked
        </button>
      )}
    </section>
  );
}

export function CountdownStrip({ countdowns }: { countdowns: Countdown[] }) {
  if (countdowns.length === 0) return null;
  return (
    <section className={PANEL} aria-label="Countdowns">
      <h2 className={`${LABEL} mb-[0.8em]`}>Countdowns</h2>
      <ul className="m-0 list-none space-y-[0.6em] p-0 text-[clamp(0.95rem,1.15vmax,1.4rem)]">
        {countdowns.slice(0, 4).map(countdown => (
          <li key={`${countdown.name}-${countdown.date}`} className="flex items-center gap-[0.8em]">
            {countdown.days === 0 ? (
              <span className="min-w-[2.2em] text-right text-[1.1em] font-semibold leading-none text-trace">Today</span>
            ) : (
              <span className="min-w-[2.2em] text-right font-mono text-[1.8em] font-medium leading-none tabular-nums">{countdown.days}</span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{countdown.name}</span>
              <span className="block text-[0.75em] text-silk-dim">{countdown.days === 0 ? "it's today" : countdown.days === 1 ? "day to go" : "days to go"}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
