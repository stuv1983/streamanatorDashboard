"use client";

import { Stamp } from "@/components/instrument";
import { cn } from "@/lib/utils";
import { useLive } from "./LiveProvider";

/**
 * An instrument strip that says plainly when the numbers on screen stopped
 * updating, and since when. `large` scales it for the wall kiosk.
 */
export function StaleBanner({ large = false }: { large?: boolean }) {
  const { stale, lastFrameAt, connected } = useLive();
  if (!stale) return null;
  const since = lastFrameAt ? new Date(lastFrameAt).toLocaleTimeString() : null;
  // Nothing received yet is a different situation from a stream that stopped:
  // there are no old figures on screen to distrust.
  const neverReceived = since === null;
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center rounded-[3px] border border-seam bg-bezel",
        large ? "gap-x-6 gap-y-3 px-6 py-4 text-2xl leading-snug" : "gap-x-4 gap-y-2 px-4 py-3 text-[15px] leading-normal",
      )}
    >
      {neverReceived
        ? <Stamp status="UNKNOWN" label="ACQUIRING" size={large ? "lg" : "sm"} className={large ? "px-4 py-2.5 text-[15px]" : undefined} />
        : <Stamp status="WARNING" label="STALE" size={large ? "lg" : "sm"} className={large ? "px-4 py-2.5 text-[15px]" : undefined} />}
      <p className="m-0 min-w-0 flex-1 text-silk text-pretty">
        {neverReceived
          ? connected
            ? "Connected to the live stream; waiting for the first sample."
            : "Connecting to the live stream. No samples have arrived yet."
          : connected
            ? "Connected, but no new samples are arriving."
            : "The live stream disconnected. Reconnecting automatically."}
        {since && (
          <>
            {" "}Figures shown are from <span className="font-mono tabular-nums">{since}</span>.
          </>
        )}
      </p>
    </div>
  );
}
