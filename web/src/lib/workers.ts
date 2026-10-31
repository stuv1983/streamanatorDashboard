// Global cache for workers to avoid double-boot in dev mode.
const globalForWorkers = global as unknown as {
  __workersStarted?: boolean;
  __notificationTimer?: NodeJS.Timeout;
};

import { getHistoryStore, getSnapshot, startSampler } from './runtime';
import { getSettings } from './config';
import { runNotificationCycle } from './notifications';
import { getLiveSampler } from './live';
import { startConditionEngine } from './conditions';
import { startInventorySchedule } from './inventory';

export function startWorkers() {
  if (globalForWorkers.__workersStarted) {
    return;
  }
  
  console.log("Starting background workers (Sampler, NotificationWorker, etc.)...");
  
  startSampler();
  // Started at boot rather than on first viewer, so the ten-minute buffer is
  // already full when the wall display reconnects after a restart.
  const live = getLiveSampler();
  startConditionEngine(listener => live.subscribe(listener));
  startInventorySchedule((category, summary, detail, status) => getHistoryStore().addEvent(category, summary, detail, status));

  const notificationLoop = async () => {
    const settings = getSettings();
    try {
      await runNotificationCycle(settings, await getSnapshot(0));
    } finally {
      globalForWorkers.__notificationTimer = setTimeout(notificationLoop, settings.email.poll_interval_seconds * 1000);
    }
  };
  globalForWorkers.__notificationTimer = setTimeout(notificationLoop, 5_000);
  
  globalForWorkers.__workersStarted = true;
}
