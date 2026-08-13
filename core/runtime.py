"""Streamlit runtime wiring: cached resources and the snapshot cache.

Caching strategy, per the spec's performance budget:

* **`st.cache_resource`** for things that must exist exactly once per process —
  the Prometheus client (holds a connection pool), the history store (holds
  SQLite handles) and the background sampler thread.
* **`st.cache_data`** with a short TTL for the snapshot itself. The TTL is
  deliberately shorter than the fastest auto-refresh interval so a refresh
  always produces genuinely current health values — caching *health state* for
  minutes would defeat the point of the dashboard.
* Expensive, rarely-changing lookups (metric inventory, Docker versions) get
  long TTLs.
"""

from __future__ import annotations

import time

import streamlit as st

from config import Settings, get_settings
from core.collector import Snapshot, build_snapshot, sample_metrics
from core.history import HistoryStore, Sampler
from health.thresholds import get_thresholds
from utils.logging_setup import configure_logging, get_logger

log = get_logger("runtime")

#: Health values are cached only long enough to keep one page render coherent
#: across its widgets, never long enough to show a stale verdict. Shorter than
#: the fastest selectable auto-refresh interval (15s) so a refresh always
#: re-collects rather than replaying the previous verdict.
SNAPSHOT_TTL_SECONDS = 10


@st.cache_resource
def settings() -> Settings:
    """Process-wide settings, with logging configured on first access."""
    config = get_settings()
    configure_logging(config.dashboard.log_level, config.dashboard.log_file)
    log.info(
        "Dashboard starting for %s (%s); prometheus=%s",
        config.host.hostname,
        config.host.address,
        config.prometheus.url or "not configured",
    )
    return config


@st.cache_resource
def prometheus_client():
    """Prometheus client, or None when no URL is configured.

    Returning None rather than a dead client keeps the "is Prometheus
    deployed?" question in one place instead of spread through the collectors.
    """
    config = settings()
    if not config.prometheus.configured:
        log.info("Prometheus not configured — using local collectors")
        return None
    from services.prometheus import PrometheusClient

    return PrometheusClient(
        config.prometheus.url, timeout=config.prometheus.timeout_seconds
    )


@st.cache_resource
def account_store():
    """The admin account store. One instance per process."""
    from auth.accounts import AccountStore

    return AccountStore(settings().auth.accounts_path)


@st.cache_resource
def audit_log():
    """The privileged-action audit log."""
    from auth.audit import AuditLog

    return AuditLog(settings().auth.audit_path)


def reload_configuration() -> None:
    """Re-read .env and drop every cache that could hold a stale credential.

    Called after the admin console saves a credential. The order matters: the
    settings singleton is rebuilt first, then `settings.clear()` forces the
    cached resource to fetch the new object, then the snapshot and service
    caches go so the next render actually re-collects with the new key rather
    than replaying the NOT CONFIGURED result from ten seconds ago.
    """
    from config import reload_settings

    reload_settings()
    settings.clear()
    # Close the old client's connection pool before dropping it — clear()
    # alone abandons open sockets to the garbage collector.
    try:
        client = prometheus_client()
        if client is not None:
            client.close()
    except Exception:  # noqa: BLE001 - closing is best-effort
        pass
    prometheus_client.clear()
    clear_caches()
    log.info("Configuration reloaded from .env")


@st.cache_resource
def history_store() -> HistoryStore:
    config = settings()
    store = HistoryStore(
        config.dashboard.history_path, config.dashboard.history_retention_days
    )
    log.info("History store at %s", config.dashboard.history_path)
    return store


@st.cache_resource
def sampler() -> Sampler:
    """Start the background history sampler exactly once per process."""
    config = settings()
    store = history_store()
    instance = Sampler(
        store=store,
        # get_settings() per pass, NOT the `config` object captured above: the
        # sampler thread outlives configuration reloads, and a captured
        # snapshot would keep polling with the credentials the process booted
        # with — stale keys forever, however many times the admin console
        # saved new ones.
        collect=lambda: sample_metrics(get_settings()),
        interval_seconds=config.dashboard.sample_interval_seconds,
    )
    instance.start()
    return instance


@st.cache_resource(ttl=SNAPSHOT_TTL_SECONDS, show_spinner=False, max_entries=4)
def _cached_snapshot(cache_key: int) -> Snapshot:
    """Collect a full snapshot.

    `cache_key` exists so a manual refresh can bypass the TTL by passing a new
    value; it is otherwise unused.

    Uses `cache_resource`, not `cache_data`, deliberately. A Snapshot is a live
    in-memory object graph — readings holding dataclasses holding collector
    results — not serializable data. `cache_data` pickles every entry, which
    costs real time on an object this size and, worse, breaks outright when
    Streamlit's file watcher hot-reloads a module: the reloaded class is no
    longer the same object pickle recorded, and every read fails with
    UnserializableReturnValueError until the process restarts. That is exactly
    what happens when the project is redeployed under a running server.

    `cache_resource` hands the same object to every caller with no copying,
    which is correct here because pages only ever read from a snapshot.
    """
    return build_snapshot(
        settings=settings(),
        history=history_store(),
        prometheus_client=prometheus_client(),
        thresholds=get_thresholds(),
    )


def get_snapshot(force: bool = False) -> Snapshot:
    """Current snapshot, honouring the manual-refresh counter."""
    # Ensure the sampler is running before the first collection so history
    # starts accruing from process start, not first page view.
    sampler()
    if force:
        st.session_state["refresh_counter"] = (
            st.session_state.get("refresh_counter", 0) + 1
        )
    counter = st.session_state.get("refresh_counter", 0)
    return _cached_snapshot(counter)


def clear_caches() -> None:
    """Drop cached data (not resources) — used by the manual refresh button.

    Clears both the snapshot cache and the service-layer TTL caches, so
    "Refresh now" really does re-measure rather than replaying a cached ping.
    """
    from utils.cache import clear_all

    _cached_snapshot.clear()
    clear_all()


@st.cache_data(ttl="10m", show_spinner=False)
def prometheus_features() -> dict[str, bool]:
    client = prometheus_client()
    if client is None:
        return {}
    from services.prometheus import detect_features

    return detect_features(client)


@st.cache_data(ttl="10m", show_spinner=False)
def prometheus_targets() -> list:
    client = prometheus_client()
    if client is None or not client.available():
        return []
    try:
        return client.targets()
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not read Prometheus targets: %s", exc)
        return []


@st.cache_data(ttl="1h", show_spinner=False)
def docker_versions() -> dict[str, str]:
    from services.docker_service import docker_version

    try:
        return docker_version()
    except Exception:  # noqa: BLE001
        return {}


def history_series(
    metric: str, labels: dict[str, str] | None, window_seconds: float
) -> list[tuple[float, float]]:
    """Series from the local history store for charting."""
    return history_store().series(
        metric, labels, since=time.time() - window_seconds
    )


def init_session_state() -> None:
    """Initialise shared session state in one place."""
    from config import DEFAULT_REFRESH_SECONDS, DEFAULT_TIME_RANGE

    defaults: dict[str, object] = {
        "refresh_counter": 0,
        "refresh_seconds": DEFAULT_REFRESH_SECONDS,
        "time_range": DEFAULT_TIME_RANGE,
    }
    for key, value in defaults.items():
        st.session_state.setdefault(key, value)
