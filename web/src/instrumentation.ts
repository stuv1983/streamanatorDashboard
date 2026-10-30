export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Only run this on the Node server, not the edge runtime
    const { startWorkers } = await import('./lib/workers');
    startWorkers();
  }
}
