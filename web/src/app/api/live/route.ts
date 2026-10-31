import { getLiveSampler } from "@/lib/live";

export const dynamic = "force-dynamic";

// Server-sent events rather than polling: one long-lived response per viewer
// and roughly 1.5 KB a second. That keeps a Raspberry Pi kiosk cheap, and a
// dropped connection is visible to the page instead of hiding behind
// a slow poll.
export async function GET(request: Request) {
  const sampler = getLiveSampler();
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { cleanup(); }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // The backlog lets a reconnecting kiosk redraw ten minutes of graph
      // immediately instead of starting from an empty axis.
      send("hello", {
        static: sampler.static(),
        intervalMs: sampler.intervalMs,
        capacity: sampler.capacity,
        history: sampler.history(),
      });
      const unsubscribe = sampler.subscribe(frame => send("frame", frame));
      // Comment lines keep idle proxies from timing out the connection.
      const heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed by the client */ }
      };
      request.signal.addEventListener("abort", () => cleanup());
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
