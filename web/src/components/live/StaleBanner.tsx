"use client";

import { useLive } from "./LiveProvider";

/** Says plainly when the numbers on screen stopped updating, and since when. */
export function StaleBanner({ large = false }: { large?: boolean }) {
  const { stale, lastFrameAt, connected } = useLive();
  if (!stale) return null;
  const since = lastFrameAt ? new Date(lastFrameAt).toLocaleTimeString() : null;
  return (
    <div role="status" className={`flex items-center gap-3 rounded-lg border border-[var(--status-warning)]/60 bg-[var(--status-warning)]/10 px-4 py-2 ${large ? "text-2xl" : "text-sm"}`}>
      <span className="font-semibold text-[var(--status-warning)]">STALE</span>
      <span>
        {connected ? "Connected, but no new samples are arriving." : "Live stream disconnected. Reconnecting…"}
        {since ? ` Figures shown are from ${since}.` : " No data received yet."}
      </span>
    </div>
  );
}
