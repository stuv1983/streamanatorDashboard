"""Trend routing: Prometheus when it can answer, the local store otherwise.

The risk this guards against is silent divergence. The query registry keys are
strings that must match the collector's metric constants, and the expressions
must match the exporters the monitoring stack actually runs — neither is
checked by anything at import time, and both fail as an empty chart rather than
an error.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from queries import promql_for
from queries.trends import TREND_QUERIES

REPO = Path(__file__).resolve().parents[1]


def test_registry_keys_are_real_collector_metrics():
    """Every mapped key is a metric the collector actually records.

    A typo here is invisible: `promql_for` returns None and the chart quietly
    stays on the local store forever.
    """
    from core import collector

    recorded = {
        value
        for name, value in vars(collector).items()
        if name.startswith("M_") and isinstance(value, str)
    }
    assert recorded, "collector exposes no M_* metric constants"
    unknown = set(TREND_QUERIES) - recorded
    assert not unknown, f"queries reference metrics the collector never records: {unknown}"


def test_metrics_without_an_equivalent_are_not_mapped():
    """Measurements Prometheus cannot reproduce must stay on the local store.

    Packet loss is the one that matters: blackbox `probe_success` is a probe
    failure rate, not ICMP loss. Mapping it would change what the line means
    partway back through the window.
    """
    for metric in (
        "net.packet_loss_percent",
        "container.restarts",
        "sportsdb.size_bytes",
    ):
        assert promql_for(metric, {}) is None


def test_label_dependent_queries_need_their_label():
    """Without the identifying label there is no single series to plot."""
    assert promql_for("fs.used_bytes", {}) is None
    assert promql_for("smart.temperature", {}) is None
    assert promql_for("fs.used_bytes", {"mount": "/srv"}) is not None
    assert promql_for("smart.temperature", {"serial": "ABC123"}) is not None


def test_label_values_are_escaped():
    """A serial or mount point with a quote in it must not break the query."""
    query = promql_for("fs.used_bytes", {"mount": '/mnt/we"ird\\path'})
    assert query is not None
    assert '\\"' in query.promql
    assert '\\\\' in query.promql
    # The matcher must still be balanced: one opening brace per closing one.
    assert query.promql.count("{") == query.promql.count("}")


def test_required_metrics_match_the_expression():
    """`requires` must name a metric the expression actually uses.

    It is the gate that decides whether to query at all, so a mismatch either
    suppresses a working chart or issues a query against a missing exporter.
    """
    samples = {
        "host.cpu_percent": {},
        "host.iowait_percent": {},
        "host.mem_available_percent": {},
        "fs.used_bytes": {"mount": "/"},
        "smart.temperature": {"serial": "S1"},
        "smart.udma_crc": {"serial": "S1"},
        "smart.reallocated": {"serial": "S1"},
        "smart.pending": {"serial": "S1"},
        "net.latency_ms": {},
    }
    assert set(samples) == set(TREND_QUERIES)
    for metric, labels in samples.items():
        query = promql_for(metric, labels)
        assert query is not None, metric
        assert query.requires in query.promql, metric


def test_expressions_use_metrics_the_stack_declares():
    """Cross-check against the exporters `deploy/monitoring-stack` scrapes.

    The Grafana dashboard shipped with the stack is the closest thing to a
    verified list of metric names for this host, so it is the reference.
    """
    dashboard = json.loads(
        (
            REPO
            / "deploy"
            / "monitoring-stack"
            / "grafana"
            / "dashboards"
            / "streamanator.json"
        ).read_text(encoding="utf-8")
    )
    known = " ".join(
        target.get("expr", "")
        for panel in dashboard["panels"]
        for target in panel.get("targets", [])
    )
    required = {query.requires for query in _all_queries()}
    for metric in required:
        assert metric in known, (
            f"{metric} is not scraped by the shipped monitoring stack — "
            "either the query is wrong or the stack needs another exporter"
        )


def _all_queries():
    labels = {"mount": "/", "serial": "S1"}
    for metric in TREND_QUERIES:
        query = promql_for(metric, labels)
        if query is not None:
            yield query


class _StubClient:
    """Minimal stand-in for PrometheusClient."""

    def __init__(self, results=None, metrics=("node_cpu_seconds_total",), up=True):
        self._results = results or []
        self._metrics = list(metrics)
        self._up = up
        self.queries: list[str] = []

    def available(self, recheck_after: float = 30.0) -> bool:
        return self._up

    def metric_names(self):
        return self._metrics

    def query_range_over(self, promql, window_seconds, max_points=480):
        self.queries.append(promql)
        return self._results


class _Range:
    def __init__(self, samples):
        self.samples = samples
        self.labels = {}


@pytest.fixture()
def runtime(monkeypatch):
    from core import runtime as runtime_module

    monkeypatch.setattr(
        runtime_module, "prometheus_metric_names", lambda: frozenset(
            {"node_cpu_seconds_total", "node_filesystem_size_bytes"}
        )
    )
    return runtime_module


def test_trend_prefers_prometheus(runtime, monkeypatch):
    client = _StubClient(results=[_Range([(1.0, 10.0), (2.0, 11.0)])])
    monkeypatch.setattr(runtime, "prometheus_client", lambda: client)
    monkeypatch.setattr(
        runtime, "history_series", lambda *a, **k: [(9.0, 99.0)]
    )

    trend = runtime.trend_series("host.cpu_percent", None, 3600)

    assert list(trend) == [(1.0, 10.0), (2.0, 11.0)]
    assert trend.source == "prometheus"
    assert client.queries, "Prometheus was never queried"


def test_trend_falls_back_when_prometheus_is_down(runtime, monkeypatch):
    monkeypatch.setattr(runtime, "prometheus_client", lambda: _StubClient(up=False))
    monkeypatch.setattr(runtime, "history_series", lambda *a, **k: [(9.0, 99.0)])

    trend = runtime.trend_series("host.cpu_percent", None, 3600)

    assert list(trend) == [(9.0, 99.0)]
    assert trend.source == "history"


def test_trend_falls_back_when_the_exporter_is_missing(runtime, monkeypatch):
    """smartctl metrics are not in the stub inventory, so no query is issued."""
    client = _StubClient(results=[_Range([(1.0, 40.0)])])
    monkeypatch.setattr(runtime, "prometheus_client", lambda: client)
    monkeypatch.setattr(runtime, "history_series", lambda *a, **k: [(9.0, 30.0)])

    trend = runtime.trend_series("smart.temperature", {"serial": "S1"}, 3600)

    assert trend.source == "history"
    assert not client.queries


def test_trend_falls_back_when_a_query_raises(runtime, monkeypatch):
    """A chart must never take a page down with it."""

    class Exploding(_StubClient):
        def query_range_over(self, promql, window_seconds, max_points=480):
            raise RuntimeError("boom")

    monkeypatch.setattr(runtime, "prometheus_client", lambda: Exploding())
    monkeypatch.setattr(runtime, "history_series", lambda *a, **k: [(9.0, 99.0)])

    trend = runtime.trend_series("host.cpu_percent", None, 3600)

    assert list(trend) == [(9.0, 99.0)]
    assert trend.source == "history"


def test_trend_reports_no_source_when_nothing_has_data(runtime, monkeypatch):
    monkeypatch.setattr(runtime, "prometheus_client", lambda: _StubClient())
    monkeypatch.setattr(runtime, "history_series", lambda *a, **k: [])

    trend = runtime.trend_series("host.cpu_percent", None, 3600)

    assert trend.source == "none"
    assert not trend


def test_trend_behaves_like_a_list(runtime, monkeypatch):
    """Every existing caller treats the result as a plain list of samples."""
    monkeypatch.setattr(runtime, "prometheus_client", lambda: None)
    monkeypatch.setattr(
        runtime, "history_series", lambda *a, **k: [(1.0, 2.0), (3.0, 4.0)]
    )

    trend = runtime.trend_series("sportsdb.size_bytes", {"db": "x"}, 3600)

    assert len(trend) == 2
    assert trend[-1] == (3.0, 4.0)
    assert [ts for ts, _ in trend] == [1.0, 3.0]
    assert bool(trend) is True


def test_smart_queries_identify_the_disk_by_serial_not_device_name():
    """Device names are not stable across reboots; serials are.

    smartctl_exporter labels its measurement series by kernel device name and
    only exposes the serial on the `smartctl_device` info metric, so the query
    has to join. Filtering on `device` directly would attribute one disk's
    history to another the first time the controller re-enumerated.
    """
    for metric in ("smart.temperature", "smart.udma_crc", "smart.reallocated"):
        query = promql_for(metric, {"serial": "WPV2E65M"})
        assert query is not None
        assert 'smartctl_device{serial_number="WPV2E65M"}' in query.promql, metric
        assert "on(device, instance)" in query.promql, metric
        # The join must not filter on a label the measurement series lacks.
        assert 'smartctl_device_temperature{serial_number' not in query.promql
        assert 'smartctl_device_attribute{serial_number' not in query.promql
