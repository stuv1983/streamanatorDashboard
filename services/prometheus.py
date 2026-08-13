"""Prometheus client.

Prometheus is the preferred source of truth for telemetry, but on this host it
is *not currently deployed* — the 13 Aug 2026 survey found no listener on 9090
and no prometheus container, only an unused `prom/prometheus:latest` image. So
this client is written to be completely optional: `available()` returns False
when unconfigured or unreachable, and every consumer falls back to the local
collectors rather than erroring.

All PromQL lives in the `queries/` package; this module only knows how to talk
to the HTTP API and normalise the response shapes.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Sequence

import requests

from core.errors import (
    NotConfiguredError,
    ParseError,
    QueryError,
    SourceTimeoutError,
    SourceUnavailableError,
)
from utils.logging_setup import get_logger

log = get_logger("prometheus")


@dataclass(frozen=True)
class InstantResult:
    """One series from an instant query."""

    labels: dict[str, str]
    value: float
    timestamp: float

    @property
    def age_seconds(self) -> float:
        return max(0.0, time.time() - self.timestamp)


@dataclass(frozen=True)
class RangeResult:
    """One series from a range query."""

    labels: dict[str, str]
    #: Ascending (timestamp, value) pairs.
    samples: list[tuple[float, float]]

    @property
    def latest(self) -> tuple[float, float] | None:
        return self.samples[-1] if self.samples else None


@dataclass(frozen=True)
class TargetHealth:
    job: str
    instance: str
    health: str
    last_error: str
    last_scrape: float
    scrape_interval: str

    @property
    def healthy(self) -> bool:
        return self.health == "up"


class PrometheusClient:
    """Thin, timeout-protected wrapper over the Prometheus HTTP API."""

    def __init__(self, url: str, timeout: float = 4.0) -> None:
        self.url = url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({"Accept": "application/json"})
        #: Cached availability probe result, so a down Prometheus is not
        #: re-dialled on every widget during one page render.
        self._available: bool | None = None
        self._available_checked_at = 0.0

    @property
    def configured(self) -> bool:
        return bool(self.url)

    def close(self) -> None:
        """Release the connection pool. Called on configuration reload so a
        replaced client does not leave sockets to the garbage collector."""
        try:
            self._session.close()
        except Exception:  # noqa: BLE001 - closing is best-effort
            pass

    # -- transport -------------------------------------------------------

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.configured:
            raise NotConfiguredError(
                "Prometheus URL is not set",
                source="prometheus",
                hint="Set PROMETHEUS_URL, or deploy deploy/monitoring-stack/.",
            )
        url = f"{self.url}{path}"
        try:
            response = self._session.get(url, params=params, timeout=self.timeout)
        except requests.Timeout as exc:
            raise SourceTimeoutError(
                f"Prometheus did not respond within {self.timeout}s",
                source="prometheus",
                hint=f"Check that {self.url} is reachable.",
            ) from exc
        except requests.RequestException as exc:
            raise SourceUnavailableError(
                f"Could not reach Prometheus: {exc}",
                source="prometheus",
                hint=f"Check that {self.url} is up and routable.",
            ) from exc

        if response.status_code >= 400:
            raise QueryError(
                f"Prometheus returned HTTP {response.status_code}",
                source="prometheus",
                hint=response.text[:200],
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise ParseError(
                "Prometheus returned a non-JSON body", source="prometheus"
            ) from exc
        if payload.get("status") != "success":
            raise QueryError(
                f"Prometheus query failed: {payload.get('error', 'unknown error')}",
                source="prometheus",
            )
        return payload.get("data", {})

    # -- availability ----------------------------------------------------

    def available(self, recheck_after: float = 30.0) -> bool:
        """Is Prometheus configured and answering? Result cached briefly."""
        if not self.configured:
            return False
        now = time.time()
        if (
            self._available is not None
            and (now - self._available_checked_at) < recheck_after
        ):
            return self._available
        try:
            self._get("/-/healthy") if False else self._get(
                "/api/v1/query", {"query": "1"}
            )
            self._available = True
        except Exception as exc:  # noqa: BLE001 - availability probe
            log.debug("Prometheus unavailable: %s", exc)
            self._available = False
        self._available_checked_at = now
        return self._available

    # -- queries ---------------------------------------------------------

    def query(self, promql: str) -> list[InstantResult]:
        """Instant query. Returns [] for a valid query that matched nothing."""
        data = self._get("/api/v1/query", {"query": promql})
        if data.get("resultType") not in {"vector", "scalar"}:
            raise ParseError(
                f"Unexpected result type {data.get('resultType')} for instant query",
                source="prometheus",
            )
        results: list[InstantResult] = []
        for item in data.get("result", []):
            try:
                timestamp, raw = item["value"]
                value = float(raw)
            except (KeyError, TypeError, ValueError):
                # Prometheus encodes NaN as the string "NaN"; skip rather than
                # coercing it to 0, which would fabricate a measurement.
                continue
            results.append(
                InstantResult(
                    labels=item.get("metric", {}),
                    value=value,
                    timestamp=float(timestamp),
                )
            )
        return results

    def query_one(self, promql: str) -> float | None:
        """First value of an instant query, or None when nothing matched."""
        results = self.query(promql)
        return results[0].value if results else None

    def query_range(
        self, promql: str, start: float, end: float, step: float
    ) -> list[RangeResult]:
        """Range query with a step chosen to keep the point count sane."""
        data = self._get(
            "/api/v1/query_range",
            {"query": promql, "start": start, "end": end, "step": f"{max(1, int(step))}s"},
        )
        results: list[RangeResult] = []
        for item in data.get("result", []):
            samples: list[tuple[float, float]] = []
            for point in item.get("values", []):
                try:
                    samples.append((float(point[0]), float(point[1])))
                except (TypeError, ValueError, IndexError):
                    continue
            results.append(RangeResult(labels=item.get("metric", {}), samples=samples))
        return results

    def query_range_over(
        self, promql: str, window_seconds: float, max_points: int = 480
    ) -> list[RangeResult]:
        """Range query for the trailing `window_seconds`, auto-stepped."""
        end = time.time()
        start = end - window_seconds
        step = max(15.0, window_seconds / max_points)
        return self.query_range(promql, start, end, step)

    # -- metadata --------------------------------------------------------

    def metric_names(self) -> list[str]:
        """Every metric name Prometheus knows — drives feature detection.

        Used instead of assuming metric names: node_exporter versions differ in
        whether they expose `node_md_disks_active` vs `node_md_disks{state=...}`.
        """
        data = self._get("/api/v1/label/__name__/values")
        return list(data) if isinstance(data, list) else []

    def has_metric(self, name: str) -> bool:
        try:
            return name in set(self.metric_names())
        except Exception:  # noqa: BLE001
            return False

    def targets(self) -> list[TargetHealth]:
        """Scrape target health, for the diagnostics page."""
        data = self._get("/api/v1/targets", {"state": "any"})
        targets: list[TargetHealth] = []
        for item in data.get("activeTargets", []):
            labels = item.get("labels", {})
            last_scrape = item.get("lastScrape", "")
            targets.append(
                TargetHealth(
                    job=labels.get("job", "?"),
                    instance=labels.get("instance", "?"),
                    health=item.get("health", "unknown"),
                    last_error=item.get("lastError", ""),
                    last_scrape=_parse_rfc3339(last_scrape),
                    scrape_interval=item.get("scrapeInterval", ""),
                )
            )
        return targets

    def build_info(self) -> dict[str, str]:
        data = self._get("/api/v1/status/buildinfo")
        return {k: str(v) for k, v in data.items()}


def _parse_rfc3339(value: str) -> float:
    """Parse Prometheus' RFC3339 timestamps into a Unix float."""
    if not value:
        return 0.0
    from datetime import datetime

    text = value.replace("Z", "+00:00")
    # Prometheus emits nanosecond precision, which fromisoformat rejects.
    if "." in text:
        head, _, tail = text.partition(".")
        digits = "".join(ch for ch in tail if ch.isdigit())[:6]
        offset = tail[len(digits) :] if len(tail) > len(digits) else ""
        offset = offset.lstrip("0123456789")
        text = f"{head}.{digits}{offset}"
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return 0.0


#: Metric families the dashboard would use if the exporters existed. Shown on
#: the diagnostics page as an inventory of what is present vs missing, instead
#: of guessing at names that were never verified.
EXPECTED_METRIC_FAMILIES: dict[str, tuple[str, ...]] = {
    "node_exporter": (
        "node_cpu_seconds_total",
        "node_memory_MemAvailable_bytes",
        "node_memory_MemTotal_bytes",
        "node_load1",
        "node_filesystem_avail_bytes",
        "node_filesystem_size_bytes",
        "node_filesystem_files_free",
        "node_md_disks",
        "node_md_state",
        "node_disk_read_bytes_total",
        "node_disk_io_time_seconds_total",
        "node_boot_time_seconds",
        "node_systemd_unit_state",
        "node_hwmon_temp_celsius",
    ),
    "cadvisor": (
        "container_cpu_usage_seconds_total",
        "container_memory_working_set_bytes",
        "container_network_receive_bytes_total",
        "container_start_time_seconds",
        "container_last_seen",
    ),
    "smartctl_exporter": (
        "smartctl_device_temperature",
        "smartctl_device_attribute",
        "smartctl_device_smart_status",
        "smartctl_device_power_on_seconds",
    ),
    "blackbox_exporter": (
        "probe_success",
        "probe_duration_seconds",
        "probe_http_status_code",
        "probe_ssl_earliest_cert_expiry",
        "probe_dns_lookup_time_seconds",
    ),
    "unifi_exporter": (
        "unpoller_device_uptime_seconds",
        "unpoller_client_count",
        "unpoller_uap_stations",
    ),
}


def detect_features(client: PrometheusClient) -> dict[str, bool]:
    """Which exporter families are actually present.

    Feature detection rather than assumption: the dashboard enables sections
    based on metrics that really exist, so a partially-deployed monitoring
    stack degrades to NOT CONFIGURED panels instead of empty charts.
    """
    if not client.available():
        return {family: False for family in EXPECTED_METRIC_FAMILIES}
    try:
        present = set(client.metric_names())
    except Exception as exc:  # noqa: BLE001
        log.warning("Metric inventory failed: %s", exc)
        return {family: False for family in EXPECTED_METRIC_FAMILIES}
    return {
        family: any(metric in present for metric in metrics)
        for family, metrics in EXPECTED_METRIC_FAMILIES.items()
    }


def missing_metrics(client: PrometheusClient) -> dict[str, Sequence[str]]:
    """Per-family list of expected-but-absent metric names."""
    if not client.available():
        return {f: metrics for f, metrics in EXPECTED_METRIC_FAMILIES.items()}
    try:
        present = set(client.metric_names())
    except Exception:  # noqa: BLE001
        return {f: metrics for f, metrics in EXPECTED_METRIC_FAMILIES.items()}
    return {
        family: [m for m in metrics if m not in present]
        for family, metrics in EXPECTED_METRIC_FAMILIES.items()
    }
