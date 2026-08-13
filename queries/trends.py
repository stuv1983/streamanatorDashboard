"""PromQL behind the trend charts.

Each entry maps one of the history store's metric keys (the `M_*` constants in
`core/collector.py`) onto the equivalent Prometheus expression, so a chart can
be served from either source without the page knowing which.

Two rules govern what appears here:

1. **Same measurement, or no entry.** A metric is only mapped when Prometheus
   can answer the *same question* the local sampler answers. Packet loss is the
   worked example of the exception: the sampler measures real ICMP loss, while
   Prometheus only has blackbox `probe_success`, which is a probe failure rate.
   Charting one as the other would silently change the meaning of the line
   partway back through the window, so `net.packet_loss_percent` is absent and
   stays on the local store.

2. **Expressions are the ones already proven on this stack.** These match the
   panels in `deploy/monitoring-stack/grafana/dashboards/streamanator.json`,
   which is the configuration actually scraping this host. Where that dashboard
   filters on a label (`temperature_type="current"`, `attribute_value_type=
   "raw"`), the same filter is applied here rather than a guess at the shape of
   the series.

Every query names the metric it depends on in `requires`. The caller checks
that against Prometheus' own metric inventory, so a partially deployed stack
falls back to the local store instead of drawing an empty axis.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Mapping

#: SMART attribute ids, as exposed by smartctl_exporter's
#: `smartctl_device_attribute{attribute_id=...}` series.
_ATTR_REALLOCATED = "5"
_ATTR_PENDING = "197"
_ATTR_UDMA_CRC = "199"

#: Pseudo-filesystems the storage panels exclude, matching the Grafana
#: dashboard's "Filesystem used" panel.
_REAL_FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs"'


@dataclass(frozen=True)
class TrendQuery:
    """One chartable expression plus the metric it needs to exist."""

    promql: str
    #: Metric name that must be present in Prometheus for this query to be
    #: meaningful. Checked before the query is issued.
    requires: str


def _quote(value: str) -> str:
    """Escape a label value for a PromQL matcher.

    Mount points and disk serials come from collected data, not from a human
    typing a query, but they still reach a query string — so they are escaped
    rather than trusted to be free of quotes and backslashes.
    """
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _host_cpu(_: Mapping[str, str]) -> TrendQuery:
    return TrendQuery(
        '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
        "node_cpu_seconds_total",
    )


def _host_iowait(_: Mapping[str, str]) -> TrendQuery:
    return TrendQuery(
        'avg(rate(node_cpu_seconds_total{mode="iowait"}[5m])) * 100',
        "node_cpu_seconds_total",
    )


def _host_mem_available(_: Mapping[str, str]) -> TrendQuery:
    return TrendQuery(
        "node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100",
        "node_memory_MemAvailable_bytes",
    )


def _fs_used(labels: Mapping[str, str]) -> TrendQuery | None:
    """Bytes used on one mount point.

    The local sampler records used bytes; node_exporter reports size and
    available, so the subtraction happens here. `max()` collapses the result to
    a single series — a mount point can be reported by more than one device
    after a bind mount, and two identical lines on one chart is noise.
    """
    mount = labels.get("mount")
    if not mount:
        return None
    selector = f'{{mountpoint="{_quote(mount)}",{_REAL_FS}}}'
    return TrendQuery(
        f"max(node_filesystem_size_bytes{selector} "
        f"- node_filesystem_avail_bytes{selector})",
        "node_filesystem_size_bytes",
    )


def _by_serial(expression: str, serial: str) -> str:
    """Restrict a per-disk series to one drive, identified by serial number.

    The measurement series — temperature, attributes — are labelled by kernel
    device name (`sda`), not by serial. Only `smartctl_device`, the info
    metric, carries both, so the two are joined on the device.

    Device names are not stable across reboots on a machine with six drives,
    which is why the history store keys on the serial in the first place;
    querying Prometheus by `device` directly would attribute one disk's
    history to another after a controller re-enumerates.

    `and on(...)` rather than the more familiar `* on(...) group_left()`: `and`
    filters the left side and leaves its values untouched, so the result does
    not depend on the info metric's value being exactly 1.
    """
    return (
        f"max({expression} and on(device, instance) "
        f'smartctl_device{{serial_number="{_quote(serial)}"}})'
    )


def _smart_attribute(labels: Mapping[str, str], attribute_id: str) -> TrendQuery | None:
    serial = labels.get("serial")
    if not serial:
        return None
    return TrendQuery(
        _by_serial(
            f'smartctl_device_attribute{{attribute_id="{attribute_id}",'
            f'attribute_value_type="raw"}}',
            serial,
        ),
        "smartctl_device_attribute",
    )


def _smart_temperature(labels: Mapping[str, str]) -> TrendQuery | None:
    serial = labels.get("serial")
    if not serial:
        return None
    return TrendQuery(
        _by_serial(
            'smartctl_device_temperature{temperature_type="current"}', serial
        ),
        "smartctl_device_temperature",
    )


def _net_latency(_: Mapping[str, str]) -> TrendQuery:
    """Internet round-trip time, in milliseconds.

    Scoped to the ICMP job so it is the same measurement the local sampler
    takes — an HTTP probe's duration includes TLS and server think-time, and
    would read as a latency spike that never happened on the network.
    """
    return TrendQuery(
        'avg(probe_duration_seconds{job="blackbox-icmp"}) * 1000',
        "probe_duration_seconds",
    )


#: Metric key -> builder. Keys mirror the `M_*` constants in
#: `core/collector.py`; `tests/test_trend_queries.py` asserts they stay in step.
#:
#: Deliberately absent, because Prometheus cannot answer the same question:
#:   net.packet_loss_percent  - see the module docstring
#:   container.restarts       - cadvisor exposes start time, not a restart count
#:   sportsdb.size_bytes      - no exporter reads application databases
TREND_QUERIES: dict[str, Callable[[Mapping[str, str]], TrendQuery | None]] = {
    "host.cpu_percent": _host_cpu,
    "host.iowait_percent": _host_iowait,
    "host.mem_available_percent": _host_mem_available,
    "fs.used_bytes": _fs_used,
    "smart.temperature": _smart_temperature,
    "smart.udma_crc": lambda labels: _smart_attribute(labels, _ATTR_UDMA_CRC),
    "smart.reallocated": lambda labels: _smart_attribute(labels, _ATTR_REALLOCATED),
    "smart.pending": lambda labels: _smart_attribute(labels, _ATTR_PENDING),
    "net.latency_ms": _net_latency,
}


def promql_for(metric: str, labels: Mapping[str, str] | None = None) -> TrendQuery | None:
    """The Prometheus equivalent of a history-store series, if there is one.

    Returns None when the metric has no equivalent, or when the labels needed
    to identify a single series are missing — both cases mean "use the local
    store", never "draw nothing".
    """
    builder = TREND_QUERIES.get(metric)
    if builder is None:
        return None
    return builder(labels or {})
