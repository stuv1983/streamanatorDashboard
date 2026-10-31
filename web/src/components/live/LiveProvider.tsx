"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { LiveFrame, LiveStatic } from "@/lib/live";

export interface LiveState {
  info: LiveStatic | null;
  frames: LiveFrame[];
  latest: LiveFrame | null;
  intervalMs: number;
  connected: boolean;
  /** No frame for 5 s or more. The UI must say so rather than keep showing the last value. */
  stale: boolean;
  lastFrameAt: number | null;
}

const LiveContext = createContext<LiveState | null>(null);

const STALE_AFTER_MS = 5_000;

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [frames, setFrames] = useState<LiveFrame[]>([]);
  const capacity = useRef(600);
  const firstBuild = useRef<string | null>(null);
  const [info, setInfo] = useState<LiveStatic | null>(null);
  const [intervalMs, setIntervalMs] = useState(1000);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Arrival time on THIS clock. Comparing the server's timestamps with the
  // browser's clock would make a Pi with a drifting clock look permanently stale.
  const [receivedAt, setReceivedAt] = useState<number | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/live");
    source.addEventListener("hello", event => {
      const hello = JSON.parse((event as MessageEvent).data) as { static: LiveStatic; intervalMs: number; capacity: number; history: LiveFrame[] };
      // A new build ID after a reconnect means the server was redeployed.
      // Reload so an unattended screen never runs stale UI against a new API.
      const build = hello.static.buildId;
      if (firstBuild.current && build && build !== firstBuild.current) {
        window.location.reload();
        return;
      }
      firstBuild.current ??= build;
      capacity.current = hello.capacity;
      setFrames(hello.history);
      setInfo(hello.static);
      setIntervalMs(hello.intervalMs);
      setConnected(true);
      if (hello.history.length) setReceivedAt(Date.now());
    });
    source.addEventListener("frame", event => {
      const frame = JSON.parse((event as MessageEvent).data) as LiveFrame;
      const limit = capacity.current;
      setFrames(list => {
        const next = list.length >= limit ? list.slice(list.length - limit + 1) : list.slice();
        next.push(frame);
        return next;
      });
      setReceivedAt(Date.now());
      setConnected(true);
    });
    // EventSource retries on its own; this only records that we're blind meanwhile.
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  // Ticks independently of the stream, so staleness is detected even when no
  // events arrive at all.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const value = useMemo<LiveState>(() => {
    const latest = frames.at(-1) ?? null;
    const lastFrameAt = latest?.ts ?? null;
    return {
      info,
      frames,
      latest,
      intervalMs,
      connected,
      stale: !connected || receivedAt === null || now - receivedAt > STALE_AFTER_MS,
      lastFrameAt,
    };
  }, [frames, info, intervalMs, connected, now, receivedAt]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const value = useContext(LiveContext);
  if (!value) throw new Error("useLive must be used inside <LiveProvider>");
  return value;
}
