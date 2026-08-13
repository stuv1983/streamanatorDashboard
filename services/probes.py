"""Synthetic service probes.

A running container is not a working application — the 9 Aug 2026 Gluetun
incident is the proof: every dependent container stayed "Up" while Prowlarr
could not resolve DNS or reach a single indexer. So availability is measured by
actually asking each service a question and checking the answer.

Prefers Blackbox Exporter metrics when it is deployed (it probes continuously
and gives history). Falls back to probing directly from the dashboard process,
concurrently and with per-probe timeouts, so ten services cost one timeout
rather than ten.
"""

from __future__ import annotations

import socket
import ssl
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from urllib.parse import urlparse

import requests

from utils.cache import ttl_cache
from utils.logging_setup import get_logger

log = get_logger("probes")


@dataclass
class ProbeResult:
    """Outcome of one synthetic probe."""

    key: str
    display: str
    url: str
    success: bool
    #: None when the probe never got far enough to measure anything.
    latency_ms: float | None = None
    status_code: int | None = None
    error: str = ""
    #: Which stage failed — makes "DNS broken" distinguishable from "app 500s".
    failed_stage: str = ""
    dns_ms: float | None = None
    connect_ms: float | None = None
    tls_expiry: float | None = None
    checked_at: float = field(default_factory=time.time)
    source: str = "direct"

    @property
    def tls_days_remaining(self) -> float | None:
        if self.tls_expiry is None:
            return None
        return (self.tls_expiry - time.time()) / 86400.0


def probe_http(
    key: str,
    display: str,
    url: str,
    expect_status: tuple[int, ...] = (200,),
    timeout: float = 5.0,
    verify_tls: bool = True,
) -> ProbeResult:
    """Probe one HTTP endpoint, timing each stage separately.

    Never raises: a probe failure is a *result*, not an exception, because the
    dashboard has to keep rendering when a service is down.
    """
    if not url:
        return ProbeResult(
            key=key,
            display=display,
            url=url,
            success=False,
            error="No URL configured",
            failed_stage="config",
        )

    parsed = urlparse(url)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    # Stage 1: DNS. Separating this is what lets the VPN diagnostics say
    # "DNS failed" rather than a generic connection error.
    dns_ms: float | None = None
    if host and not _is_ip_literal(host):
        started = time.perf_counter()
        try:
            socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
            dns_ms = (time.perf_counter() - started) * 1000.0
        except socket.gaierror as exc:
            return ProbeResult(
                key=key,
                display=display,
                url=url,
                success=False,
                error=f"DNS resolution failed: {exc}",
                failed_stage="dns",
            )

    # Stage 2: TCP connect.
    connect_ms: float | None = None
    started = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            connect_ms = (time.perf_counter() - started) * 1000.0
    except OSError as exc:
        return ProbeResult(
            key=key,
            display=display,
            url=url,
            success=False,
            error=f"TCP connect failed: {exc}",
            failed_stage="tcp",
            dns_ms=dns_ms,
        )

    # Stage 3: TLS expiry, when applicable.
    tls_expiry: float | None = None
    if parsed.scheme == "https":
        tls_expiry = _tls_expiry(host, port, timeout)

    # Stage 4: the actual HTTP exchange.
    started = time.perf_counter()
    try:
        response = requests.get(
            url,
            timeout=timeout,
            verify=verify_tls,
            allow_redirects=False,
            headers={"User-Agent": "streamanator-dashboard/1.0 (health probe)"},
        )
        latency_ms = (time.perf_counter() - started) * 1000.0
    except requests.Timeout:
        return ProbeResult(
            key=key, display=display, url=url, success=False,
            error=f"HTTP request timed out after {timeout}s",
            failed_stage="http", dns_ms=dns_ms, connect_ms=connect_ms,
        )
    except requests.RequestException as exc:
        return ProbeResult(
            key=key, display=display, url=url, success=False,
            error=f"HTTP request failed: {type(exc).__name__}",
            failed_stage="http", dns_ms=dns_ms, connect_ms=connect_ms,
        )

    ok = response.status_code in expect_status
    return ProbeResult(
        key=key,
        display=display,
        url=url,
        success=ok,
        latency_ms=latency_ms,
        status_code=response.status_code,
        error="" if ok else f"Unexpected HTTP {response.status_code}",
        failed_stage="" if ok else "status",
        dns_ms=dns_ms,
        connect_ms=connect_ms,
        tls_expiry=tls_expiry,
    )


def _is_ip_literal(host: str) -> bool:
    try:
        socket.inet_aton(host)
        return True
    except OSError:
        return ":" in host


def _tls_expiry(host: str, port: int, timeout: float) -> float | None:
    """Certificate notAfter as a Unix timestamp."""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    try:
        with socket.create_connection((host, port), timeout=timeout) as raw:
            with context.wrap_socket(raw, server_hostname=host) as tls:
                cert = tls.getpeercert()
    except (OSError, ssl.SSLError):
        return None
    if not cert or "notAfter" not in cert:
        return None
    try:
        return ssl.cert_time_to_seconds(cert["notAfter"])
    except ValueError:
        return None


def probe_tcp(host: str, port: int, timeout: float = 4.0) -> tuple[bool, float | None]:
    """Plain TCP reachability check. Returns (reachable, latency_ms)."""
    started = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, (time.perf_counter() - started) * 1000.0
    except OSError:
        return False, None


# TTL chosen to outlast the 60s sampler interval's warming pass while staying
# short enough that a service going down is noticed within one refresh cycle.
@ttl_cache(seconds=45)
def _probe_many_cached(
    targets: tuple[tuple[str, str, str, tuple[int, ...]], ...],
    timeout: float,
    max_workers: int,
) -> tuple[ProbeResult, ...]:
    return tuple(_probe_many_uncached(list(targets), timeout, max_workers))


def probe_many(
    targets: list[tuple[str, str, str, tuple[int, ...]]],
    timeout: float = 5.0,
    max_workers: int = 8,
) -> list[ProbeResult]:
    """Probe several endpoints concurrently, with a short result cache.

    Concurrency matters for the performance budget: probing ten services
    sequentially at a 5s timeout could cost 50s on a bad day, which would blow
    the page target every time one service was down. The TTL then keeps a
    second render within the same refresh window free.
    """
    if not targets:
        return []
    return list(_probe_many_cached(tuple(targets), timeout, max_workers))


def _probe_many_uncached(
    targets: list[tuple[str, str, str, tuple[int, ...]]],
    timeout: float,
    max_workers: int,
) -> list[ProbeResult]:
    if not targets:
        return []
    with ThreadPoolExecutor(max_workers=min(max_workers, len(targets))) as pool:
        futures = [
            pool.submit(probe_http, key, display, url, expect, timeout)
            for key, display, url, expect in targets
        ]
        return [future.result() for future in futures]


@ttl_cache(seconds=30)
def probe_dns(hostname: str = "cloudflare.com", timeout: float = 4.0) -> tuple[bool, float | None]:
    """Can we resolve a well-known name? Used for the internet health check."""
    original = socket.getdefaulttimeout()
    socket.setdefaulttimeout(timeout)
    started = time.perf_counter()
    try:
        socket.getaddrinfo(hostname, 443, proto=socket.IPPROTO_TCP)
        return True, (time.perf_counter() - started) * 1000.0
    except (socket.gaierror, OSError):
        return False, None
    finally:
        socket.setdefaulttimeout(original)


# ---------------------------------------------------------------------------
# Blackbox Exporter
# ---------------------------------------------------------------------------


def probes_from_blackbox(client, timeout: float = 4.0) -> dict[str, ProbeResult]:
    """Probe results sourced from Blackbox Exporter metrics in Prometheus.

    Returns an empty mapping when Blackbox is not deployed, which is the
    current state on this host — the caller then falls back to direct probes.
    """
    results: dict[str, ProbeResult] = {}
    if not client or not client.available():
        return results
    try:
        successes = client.query("probe_success")
    except Exception as exc:  # noqa: BLE001
        log.debug("Blackbox query failed: %s", exc)
        return results
    if not successes:
        return results

    durations = {}
    statuses = {}
    expiries = {}
    try:
        durations = {
            item.labels.get("instance", ""): item.value
            for item in client.query("probe_duration_seconds")
        }
        statuses = {
            item.labels.get("instance", ""): item.value
            for item in client.query("probe_http_status_code")
        }
        expiries = {
            item.labels.get("instance", ""): item.value
            for item in client.query("probe_ssl_earliest_cert_expiry")
        }
    except Exception:  # noqa: BLE001
        pass

    for item in successes:
        instance = item.labels.get("instance", "")
        key = instance
        results[key] = ProbeResult(
            key=key,
            display=instance,
            url=instance,
            success=bool(item.value),
            latency_ms=(durations.get(instance, 0.0) * 1000.0) or None,
            status_code=int(statuses[instance]) if instance in statuses else None,
            tls_expiry=expiries.get(instance),
            checked_at=item.timestamp,
            source="prometheus:blackbox",
        )
    return results
