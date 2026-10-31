import { NextResponse } from "next/server";
import { getHistoryStore, runtimeDiagnostics } from "@/lib/runtime";
import { getSettings } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = getSettings();
  return NextResponse.json({
    runtime: runtimeDiagnostics(),
    history: getHistoryStore().stats(),
    collection: {
      local_enabled: settings.local.enabled,
      prometheus_configured: Boolean(settings.prometheus.url),
      unifi_configured: Boolean(settings.unifi.controller_url && settings.unifi.api_key),
      filesystems: settings.filesystems.map((item) => item.mountpoint),
      expected_containers: settings.containers.length,
      service_endpoints: settings.endpoints.filter((item) => item.url).length,
    },
  });
}
