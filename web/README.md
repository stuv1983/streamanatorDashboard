# Streamanator TypeScript application

The production dashboard is a Next.js 16 App Router application.

```bash
npm ci
npm run test
npm run typecheck
npm run lint
npm run build
npm run start -- --hostname 0.0.0.0 --port 8600
```

Collectors and health logic live in `src/lib`, UI routes in `src/app`, and background sampling/notifications start from `src/instrumentation.ts`. Use `/performance` for CPU, memory, disk, network and latency history, `/api/health` for service checks, and `/api/diagnostics` for runtime collection status. Node.js 22 or newer is required.
