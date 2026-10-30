import { getSettings } from "@/lib/config";
import DashboardClient from "@/components/DashboardClient";

export default function Home() {
  const settings = getSettings();
  
  return (
    <main className="container mx-auto py-8">
      <DashboardClient hostname={settings.host.hostname} />
    </main>
  );
}
