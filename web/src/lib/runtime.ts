import path from "node:path";
import { getSettings } from "./config";
import { HistoryStore, Sampler } from "./history";
import { sampleMetrics } from "./collector";
import { buildSnapshot, type Snapshot } from "./snapshot";
import { PrometheusClient } from "./prometheus";

type RuntimeState = {
  history?: HistoryStore;
  sampler?: Sampler;
  snapshot?: Snapshot;
  snapshotPromise?: Promise<Snapshot>;
  snapshotError?: string;
};

const state = globalThis as typeof globalThis & { __streamanatorRuntime?: RuntimeState };
const runtime = state.__streamanatorRuntime ??= {};

export function getHistoryStore(): HistoryStore {
  if (!runtime.history) {
    const settings = getSettings();
    const dbPath = path.isAbsolute(settings.dashboard.history_path)
      ? settings.dashboard.history_path
      : path.resolve(process.cwd(), "..", settings.dashboard.history_path);
    runtime.history = new HistoryStore(dbPath, settings.dashboard.history_retention_days);
  }
  return runtime.history;
}

export function startSampler(): Sampler {
  if (!runtime.sampler) {
    const settings = getSettings();
    runtime.sampler = new Sampler(
      getHistoryStore(),
      () => sampleMetrics(getSettings()),
      settings.dashboard.sample_interval_seconds,
    ).start();
  }
  return runtime.sampler;
}

export async function getSnapshot(maxAgeSeconds = 15): Promise<Snapshot> {
  const age = runtime.snapshot ? Date.now() / 1000 - runtime.snapshot.collected_at : Infinity;
  if (runtime.snapshot && age <= maxAgeSeconds) return runtime.snapshot;
  if (runtime.snapshotPromise) return runtime.snapshotPromise;

  const settings = getSettings();
  const prometheus = settings.prometheus.configured ? new PrometheusClient(settings.prometheus) : null;
  runtime.snapshotPromise = buildSnapshot(settings, getHistoryStore(), prometheus)
    .then((snapshot) => {
      runtime.snapshot = snapshot;
      runtime.snapshotError = undefined;
      return snapshot;
    })
    .catch((error: unknown) => {
      runtime.snapshotError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    })
    .finally(() => { runtime.snapshotPromise = undefined; });
  return runtime.snapshotPromise;
}

export function runtimeDiagnostics() {
  return {
    sampler: runtime.sampler ? {
      running: runtime.sampler.isRunning(),
      runs: runtime.sampler.runs,
      last_run: runtime.sampler.lastRun,
      last_error: runtime.sampler.lastError,
      interval_seconds: runtime.sampler.interval,
    } : { running: false, runs: 0, last_run: null, last_error: null },
    snapshot: runtime.snapshot ? {
      collected_at: runtime.snapshot.collected_at,
      duration_seconds: runtime.snapshot.duration_seconds,
      components: Object.keys(runtime.snapshot.components).length,
    } : null,
    snapshot_error: runtime.snapshotError ?? null,
  };
}
