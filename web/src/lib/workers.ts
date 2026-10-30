// Global cache for workers to avoid double-boot in dev mode.
const globalForWorkers = global as unknown as {
  __workersStarted?: boolean;
  __notificationTimer?: NodeJS.Timeout;
};

import { getSnapshot, startSampler } from './runtime';
import { getSettings } from './config';
import { runNotificationCycle } from './notifications';

export function startWorkers() {
  if (globalForWorkers.__workersStarted) {
    return;
  }
  
  console.log("Starting background workers (Sampler, NotificationWorker, etc.)...");
  
  startSampler();

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
