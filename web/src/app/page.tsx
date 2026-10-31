import { getSettings } from "@/lib/config";
import DashboardClient from "@/components/DashboardClient";

export default function Home() {
  const settings = getSettings();

  return <DashboardClient hostname={settings.host.hostname} grafanaUrl={settings.grafana.link_url || null} />;
}
