"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Acquiring, Code, ErrorState, Lamp, PageHeader, Panel, Section } from "@/components/instrument";
import { Downloads, Headlines, NowPlaying, Upcoming, WeatherChip } from "@/components/home/HomeWidgets";
import type { MediaOverview } from "@/lib/integrations";
import type { Bookmark, LauncherTile } from "@/lib/launcher";
import type { WidgetData } from "@/lib/widgets";
import { cn } from "@/lib/utils";

type Tile = LauncherTile & { up: boolean | null; latency_ms: number | null; error: string };

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

const ICON_CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
const GROUP_ORDER = ["Media", "Downloads", "Monitoring", "Apps"];

const BUTTON = "inline-flex min-h-9 items-center gap-2 rounded-[2px] border border-seam-strong bg-bezel px-3 text-[13px] font-semibold text-silk hover:border-graphite disabled:opacity-50";
const BUTTON_PRIMARY = "inline-flex min-h-9 items-center gap-2 rounded-[2px] border border-silk bg-silk px-3 text-[13px] font-semibold text-enamel hover:bg-silk-dim disabled:opacity-50";
const INPUT = "h-9 min-w-0 rounded-[2px] border border-seam bg-well px-2.5 text-sm text-silk placeholder:text-graphite focus:border-trace focus:outline-none";

function Clock() {
  // Rendered only after mount: the server's clock and timezone are not the viewer's.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="well flex shrink-0 flex-col gap-2 px-5 py-4">
      <span className="panel-label">Local time</span>
      <p className="m-0 font-mono text-[40px] font-medium leading-none tabular-nums tracking-[-0.02em]">
        {now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : " "}
      </p>
      <p className="m-0 text-sm text-silk-dim">
        {now ? now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : " "}
      </p>
    </div>
  );
}

/** dashboard-icons SVG, then PNG, then the first letter: icons are cosmetic and never block a tile. */
function AppIcon({ icon, name }: { icon: string; name: string }) {
  const [stage, setStage] = useState(icon ? 0 : 2);
  useEffect(() => setStage(icon ? 0 : 2), [icon]);
  if (stage === 2) {
    return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] border border-seam bg-well font-mono text-base font-semibold text-silk-dim" aria-hidden>{name.charAt(0).toUpperCase()}</span>;
  }
  const src = stage === 0 ? `${ICON_CDN}/svg/${icon}.svg` : `${ICON_CDN}/png/${icon}.png`;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={36} height={36} className="h-9 w-9 shrink-0 object-contain" loading="lazy" onError={() => setStage(stage + 1)} />;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function TileCard({ tile }: { tile: Tile }) {
  const status = tile.up === null ? "UNKNOWN" : tile.up ? "HEALTHY" : "CRITICAL";
  const word = tile.up === null ? "Not probed" : tile.up ? "Up" : "Down";
  return (
    <a href={tile.url} target="_blank" rel="noopener noreferrer"
      className="group flex min-w-0 flex-col gap-2.5 rounded-[3px] border border-seam bg-bezel px-4 py-3.5 text-silk no-underline transition-colors hover:border-seam-strong motion-reduce:transition-none">
      <div className="flex min-w-0 items-center gap-3">
        <AppIcon icon={tile.icon} name={tile.name} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold group-hover:text-trace">{tile.name}</span>
          {tile.up === false
            ? <span className="truncate text-xs text-silk-dim" title={tile.error}>{tile.error || "Not answering"}</span>
            : tile.description && <span className="truncate text-xs text-silk-dim">{tile.description}</span>}
        </div>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3 border-t border-seam pt-2.5">
        <span className="flex shrink-0 items-center gap-2 text-[13px] font-semibold">
          <Lamp status={status} />
          {word}
          {tile.up && tile.latency_ms != null && <span className="font-mono text-xs font-normal text-graphite">{Math.round(tile.latency_ms)} ms</span>}
        </span>
        <span className="truncate font-mono text-xs text-graphite">{hostOf(tile.url)}</span>
      </div>
    </a>
  );
}

type Suggestion = { label: string; hint: string; url: string };

function SearchBar({ tiles }: { tiles: Tile[] }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // "/" focuses search from anywhere on the page, as in most launchers.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(target.tagName)) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const suggestions = useMemo<Suggestion[]>(() => {
    const q = query.trim();
    if (!q) return [];
    const lower = q.toLowerCase();
    const apps = tiles
      .filter(tile => `${tile.name} ${tile.description} ${tile.group}`.toLowerCase().includes(lower))
      .slice(0, 6)
      .map(tile => ({ label: tile.name, hint: "Open", url: tile.url }));
    const term = encodeURIComponent(q);
    const sonarr = tiles.find(tile => tile.key === "sonarr");
    const radarr = tiles.find(tile => tile.key === "radarr");
    return [
      ...apps,
      ...(sonarr ? [{ label: `Find series “${q}”`, hint: "Sonarr", url: `${sonarr.url}/add/new?term=${term}` }] : []),
      ...(radarr ? [{ label: `Find film “${q}”`, hint: "Radarr", url: `${radarr.url}/add/new?term=${term}` }] : []),
      { label: `Search the web for “${q}”`, hint: "DuckDuckGo", url: `https://duckduckgo.com/?q=${term}` },
    ];
  }, [query, tiles]);

  useEffect(() => setActive(0), [query]);

  const open = (suggestion?: Suggestion) => {
    if (!suggestion) return;
    window.open(suggestion.url, "_blank", "noopener,noreferrer");
    setQuery("");
  };

  return (
    <div className="relative w-full max-w-xl">
      <input
        ref={input}
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActive(i => Math.min(i + 1, suggestions.length - 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
          if (event.key === "Enter") { event.preventDefault(); open(suggestions[active]); }
          if (event.key === "Escape") setQuery("");
        }}
        placeholder="Search apps, Sonarr, Radarr or the web"
        aria-label="Search"
        aria-keyshortcuts="/"
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls="home-search-results"
        className="peer well h-11 w-full px-3.5 pr-12 text-[15px] text-silk placeholder:text-graphite focus:border-trace focus:outline-none"
      />
      {!query && (
        <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-[2px] border border-seam-strong bg-bezel px-[7px] py-px font-mono text-xs text-silk-dim peer-focus:hidden" aria-hidden>/</kbd>
      )}
      {suggestions.length > 0 && (
        <ul id="home-search-results" role="listbox" className="absolute z-20 m-0 mt-1 w-full list-none overflow-hidden rounded-[3px] border border-seam-strong bg-bezel p-1 shadow-[0_8px_24px_rgb(0_0_0/0.45)]">
          {suggestions.map((suggestion, i) => (
            <li key={`${suggestion.url}-${i}`} role="option" aria-selected={i === active}>
              <button type="button" onMouseEnter={() => setActive(i)} onClick={() => open(suggestion)}
                className={cn("flex min-h-9 w-full items-center gap-3 rounded-[2px] px-3 text-left text-sm", i === active ? "bg-well text-silk shadow-[inset_0_0_0_1px_var(--seam-strong)]" : "text-silk-dim")}>
                <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
                <span className="shrink-0 font-panel text-[9px] uppercase tracking-[0.12em] text-graphite">{suggestion.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const EMPTY_BOOKMARK: Bookmark = { name: "", url: "", icon: "", group: "Bookmarks", description: "" };

function BookmarkEditor({ initial, onSaved, onCancel }: { initial: Bookmark[]; onSaved: () => void; onCancel: () => void }) {
  const [rows, setRows] = useState<Bookmark[]>(initial.length ? initial : [{ ...EMPTY_BOOKMARK }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const update = (index: number, field: keyof Bookmark, value: string) =>
    setRows(current => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const bookmarks = rows.filter(row => row.name.trim() || row.url.trim());
      const response = await fetch("/api/admin/launcher", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookmarks }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (index: number, key: keyof Bookmark, placeholder: string, className = "") => (
    <input value={rows[index][key]} onChange={event => update(index, key, event.target.value)} placeholder={placeholder} aria-label={placeholder}
      className={cn(INPUT, key === "url" || key === "icon" ? "font-mono" : "", className)} />
  );

  return (
    <Panel as="section" title="Edit bookmarks">
      <p className="m-0 text-sm leading-normal text-silk-dim">
        Icon names come from <a className="text-trace underline" href="https://dashboardicons.com" target="_blank" rel="noopener noreferrer">dashboardicons.com</a> (e.g. <Code>jellyfin</Code>, <Code>home-assistant</Code>). Built-in service tiles follow the endpoint settings on the Admin page.
      </p>
      <div className="flex flex-col gap-2">
        <div className="hidden grid-cols-[1fr_2fr_1fr_1fr_80px] gap-2 sm:grid" aria-hidden>
          {["Name", "URL", "Icon", "Group", ""].map(h => <span key={h} className="panel-label">{h}</span>)}
        </div>
        {rows.map((_, index) => (
          <div key={index} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_2fr_1fr_1fr_80px]">
            {field(index, "name", "Name")}
            {field(index, "url", "https://…", "col-span-2 sm:col-span-1")}
            {field(index, "icon", "Icon")}
            {field(index, "group", "Group")}
            <button type="button" onClick={() => setRows(current => current.filter((__, i) => i !== index))}
              className={cn(BUTTON, "h-9 justify-center font-normal text-silk-dim hover:text-silk")} aria-label={`Remove bookmark ${rows[index].name || index + 1}`}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setRows(current => [...current, { ...EMPTY_BOOKMARK }])} className={BUTTON}>Add bookmark</button>
        <button type="button" disabled={busy} onClick={() => void save()} className={BUTTON_PRIMARY}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onCancel} className={BUTTON}>Cancel</button>
        {error && (
          <p role="alert" className="m-0 flex items-center gap-2 text-sm text-silk">
            <Lamp status="CRITICAL" label="Error" />Not saved: {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

export default function HomePage() {
  const launcher = useSWR<{ tiles: Tile[] }>("/api/launcher", fetcher, { refreshInterval: 30_000, keepPreviousData: true });
  const media = useSWR<MediaOverview>("/api/media", fetcher, { refreshInterval: 15_000, keepPreviousData: true });
  const widgets = useSWR<WidgetData>("/api/widgets", fetcher, { refreshInterval: 15 * 60_000, keepPreviousData: true });
  const { data: session } = useSWR<{ authenticated: boolean }>("/api/admin/session", fetcher);
  const [editing, setEditing] = useState(false);

  const tiles = useMemo(() => launcher.data?.tiles ?? [], [launcher.data]);
  const groups = useMemo(() => {
    const byGroup = new Map<string, Tile[]>();
    for (const tile of tiles) byGroup.set(tile.group, [...(byGroup.get(tile.group) ?? []), tile]);
    const rank = (group: string) => (GROUP_ORDER.includes(group) ? GROUP_ORDER.indexOf(group) : GROUP_ORDER.length);
    return [...byGroup.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  }, [tiles]);
  const down = tiles.filter(tile => tile.up === false).length;

  return (
    <div className="flex flex-col gap-9">
      <PageHeader
        group="Home"
        title="Apps & media"
        description="Open the apps on streamanator, see what's playing, and what's downloading or due this week."
        actions={session?.authenticated && !editing ? (
          <button type="button" onClick={() => setEditing(true)} className={BUTTON}>Edit bookmarks</button>
        ) : undefined}
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <Clock />
          <WeatherChip widgets={widgets.data} />
        </div>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <SearchBar tiles={tiles} />
        {tiles.length > 0 && (
          <p className="m-0 flex items-center gap-2 text-sm text-silk-dim">
            {down === 0
              ? <><Lamp status="HEALTHY" />All <span className="font-mono text-silk">{tiles.length}</span> apps answering</>
              : <><Lamp status="CRITICAL" /><span className="font-mono text-silk">{down}</span> of <span className="font-mono text-silk">{tiles.length}</span> apps not answering</>}
          </p>
        )}
      </div>

      {editing && (
        <BookmarkEditor
          initial={tiles.filter(tile => !tile.builtin).map(({ name, url, icon, group, description }) => ({ name, url, icon, group, description }))}
          onSaved={() => { setEditing(false); void launcher.mutate(); }}
          onCancel={() => setEditing(false)}
        />
      )}

      {launcher.error && <ErrorState title="Couldn't load the app launcher" detail={launcher.error}>The tiles and their up/down checks come from <Code>/api/launcher</Code>.</ErrorState>}
      {!launcher.data && !launcher.error && <Acquiring rows={2} />}

      {groups.map(([group, groupTiles]) => (
        <Section key={group} title={group} count={groupTiles.length}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {groupTiles.map(tile => <TileCard key={tile.key} tile={tile} />)}
          </div>
        </Section>
      ))}

      <Section title="Playing and due" id="s-media-activity">
        {media.error && <ErrorState title="Couldn't load the media widgets" detail={media.error} />}
        <div className="grid items-start gap-4 lg:grid-cols-3">
          <NowPlaying media={media.data} />
          <Downloads media={media.data} />
          <Upcoming media={media.data} />
        </div>
      </Section>
      {widgets.data?.rss.configured && <Headlines widgets={widgets.data} />}
    </div>
  );
}
