import type { PrometheusConfig } from "./config";

export type PrometheusSample = { labels: Record<string, string>; value: number; timestamp: number };

export class PrometheusClient {
  private names: { at: number; values: Set<string> } | null = null;
  constructor(private readonly config: PrometheusConfig) {}

  available() { return this.config.configured; }

  private async request(path: string) {
    if (!this.config.url) throw new Error("Prometheus is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_seconds * 1000);
    try {
      const response = await fetch(`${this.config.url.replace(/\/$/, "")}${path}`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`Prometheus HTTP ${response.status}`);
      const body = await response.json();
      if (body.status !== "success") throw new Error(body.error ?? "Prometheus query failed");
      return body.data;
    } finally { clearTimeout(timer); }
  }

  async query(promql: string): Promise<PrometheusSample[]> {
    const data = await this.request(`/api/v1/query?query=${encodeURIComponent(promql)}`);
    if (data.resultType !== "vector") return [];
    return data.result.map((item: any) => ({ labels: item.metric ?? {}, timestamp: Number(item.value?.[0] ?? 0), value: Number(item.value?.[1]) }));
  }

  async queryOne(promql: string): Promise<number | null> {
    const values = await this.query(promql);
    return values.length ? values[0].value : null;
  }

  async features(): Promise<Record<string, boolean>> {
    if (!this.names || Date.now() - this.names.at > 60_000) {
      const values = await this.request("/api/v1/label/__name__/values");
      this.names = { at: Date.now(), values: new Set(values) };
    }
    const has = (name: string) => this.names!.values.has(name);
    return {
      node_exporter: has("node_uname_info"),
      cadvisor: has("container_last_seen") || has("container_cpu_usage_seconds_total"),
      smartctl_exporter: has("smartctl_device"),
      blackbox_exporter: has("probe_success"),
      unifi_exporter: has("unpoller_site_num_user") || has("unpoller_device_uptime_seconds"),
    };
  }
}
