"""Tests for the dead-man's switch.

The properties asserted here are the ones that decide whether the switch is
worth having. A ping that raises would kill the loop it exists to watch; a
plaintext URL would hand the ability to silence the alarm to anything on the
wire; and pinging success after a failed cycle would produce a green check over
a broken monitoring pipeline — the exact failure the feature is meant to
prevent.
"""

from __future__ import annotations

import pytest
import requests

from config import HeartbeatConfig
from services.heartbeat import (
    HeartbeatResult,
    send_heartbeat,
    validate_ping_url,
)
from utils.http import BoundedResponse, DeadlineExceeded


def _config(url: str | None = "https://hc-ping.com/abc") -> HeartbeatConfig:
    return HeartbeatConfig(ping_url=url, timeout_seconds=5.0)


# ---------------------------------------------------------------------------
# URL validation
# ---------------------------------------------------------------------------


def test_https_url_is_accepted():
    assert validate_ping_url("https://hc-ping.com/abc") == "https://hc-ping.com/abc"


def test_plaintext_url_is_rejected():
    """The ping URL is a capability: whoever sees it can ping the check and
    suppress a genuine 'the dashboard is down' alarm."""
    with pytest.raises(ValueError, match="https"):
        validate_ping_url("http://hc-ping.com/abc")


def test_url_with_embedded_credentials_is_rejected():
    with pytest.raises(ValueError, match="credentials"):
        validate_ping_url("https://user:pass@hc-ping.com/abc")


def test_url_with_control_characters_is_rejected():
    with pytest.raises(ValueError):
        validate_ping_url("https://hc-ping.com/abc\r\nHost: evil")


def test_empty_url_is_rejected():
    with pytest.raises(ValueError):
        validate_ping_url("   ")


# ---------------------------------------------------------------------------
# Pinging
# ---------------------------------------------------------------------------


def test_successful_ping_reports_ok():
    calls: list[str] = []

    def getter(url, **kwargs):
        calls.append(url)
        return BoundedResponse(status_code=200, body=b"OK")

    result = send_heartbeat(_config(), getter=getter)
    assert result.ok
    assert calls == ["https://hc-ping.com/abc"]


def test_failure_signal_appends_the_fail_suffix():
    """`/fail` trips the check immediately rather than waiting for its period,
    which is what makes a broken pipeline visible in minutes not hours."""
    calls: list[str] = []

    def getter(url, **kwargs):
        calls.append(url)
        return BoundedResponse(status_code=200, body=b"OK")

    result = send_heartbeat(_config(), failed=True, getter=getter)
    assert result.ok
    assert calls == ["https://hc-ping.com/abc/fail"]


def test_fail_suffix_does_not_double_the_slash():
    calls: list[str] = []

    def getter(url, **kwargs):
        calls.append(url)
        return BoundedResponse(status_code=200, body=b"OK")

    send_heartbeat(_config("https://hc-ping.com/abc/"), failed=True, getter=getter)
    assert calls == ["https://hc-ping.com/abc/fail"]


def test_unconfigured_config_does_not_ping():
    def getter(url, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("an unconfigured switch must not make a request")

    result = send_heartbeat(_config(None), getter=getter)
    assert not result.ok


def test_network_error_is_returned_not_raised():
    """A ping runs inside the notification loop. Raising here would stop the
    collection this feature exists to watch."""

    def getter(url, **kwargs):
        raise requests.ConnectionError("no route to host")

    result = send_heartbeat(_config(), getter=getter)
    assert isinstance(result, HeartbeatResult)
    assert not result.ok
    assert "ConnectionError" in result.message


def test_deadline_exceeded_is_returned_not_raised():
    def getter(url, **kwargs):
        raise DeadlineExceeded("too slow")

    result = send_heartbeat(_config(), getter=getter)
    assert not result.ok


def test_invalid_stored_url_is_returned_not_raised():
    """A typo in .env must not take down the worker on every cycle."""
    result = send_heartbeat(_config("http://insecure"), getter=None)
    assert not result.ok
    assert "https" in result.message


def test_non_2xx_response_is_a_failure():
    def getter(url, **kwargs):
        return BoundedResponse(status_code=500)

    result = send_heartbeat(_config(), getter=getter)
    assert not result.ok
    assert "500" in result.message


def test_404_explains_the_likely_cause():
    """A deleted check leaves a URL in .env that will never alarm again. The
    symptom is silence, so the message has to name the cause."""

    def getter(url, **kwargs):
        return BoundedResponse(status_code=404)

    result = send_heartbeat(_config(), getter=getter)
    assert not result.ok
    assert "deleted" in result.message


def test_ping_is_bounded_in_size_and_time():
    """A misdirected URL returning a large page must not be read into memory."""
    seen: dict = {}

    def getter(url, **kwargs):
        seen.update(kwargs)
        return BoundedResponse(status_code=200)

    send_heartbeat(_config(), getter=getter)
    assert seen["max_bytes"] <= 4096
    assert seen["timeout"] == 5.0


# ---------------------------------------------------------------------------
# Worker integration
# ---------------------------------------------------------------------------


def test_worker_pings_failure_when_a_cycle_raises(monkeypatch):
    """The cycle that raised is exactly the one whose failure must be reported
    outward — so the ping happens after the except block, not inside the try."""
    from config import Settings
    from services.notifications import (
        NotificationManager,
        NotificationStore,
        NotificationWorker,
    )

    recorded: list[bool] = []
    monkeypatch.setattr(
        "services.heartbeat.send_heartbeat",
        lambda config, failed=False: (
            recorded.append(failed) or HeartbeatResult(True, "ok")
        ),
    )

    def exploding_cycle(*args, **kwargs):
        raise RuntimeError("collection blew up")

    worker = NotificationWorker(
        manager=NotificationManager(NotificationStore("unused.json")),
        snapshot_factory=lambda: None,
        settings_factory=lambda: Settings(heartbeat=_config()),
        interval_seconds=60,
    )
    monkeypatch.setattr(worker.manager, "run_cycle", exploding_cycle)

    worker.last_error = "collection blew up"
    worker._ping_heartbeat(failed=True)
    assert recorded == [True]


def test_worker_records_a_successful_ping(monkeypatch):
    from config import Settings
    from services.notifications import (
        NotificationManager,
        NotificationStore,
        NotificationWorker,
    )

    monkeypatch.setattr(
        "services.heartbeat.send_heartbeat",
        lambda config, failed=False: HeartbeatResult(True, "Ping delivered."),
    )
    worker = NotificationWorker(
        manager=NotificationManager(NotificationStore("unused.json")),
        snapshot_factory=lambda: None,
        settings_factory=lambda: Settings(heartbeat=_config()),
        interval_seconds=60,
    )
    worker._ping_heartbeat(failed=False)
    assert worker.last_heartbeat is not None
    assert worker.last_heartbeat_error is None


def test_worker_skips_pinging_when_unconfigured(monkeypatch):
    from config import Settings
    from services.notifications import (
        NotificationManager,
        NotificationStore,
        NotificationWorker,
    )

    def must_not_run(*args, **kwargs):  # pragma: no cover
        raise AssertionError("must not ping without a configured URL")

    monkeypatch.setattr("services.heartbeat.send_heartbeat", must_not_run)
    worker = NotificationWorker(
        manager=NotificationManager(NotificationStore("unused.json")),
        snapshot_factory=lambda: None,
        settings_factory=lambda: Settings(heartbeat=_config(None)),
        interval_seconds=60,
    )
    worker._ping_heartbeat(failed=False)
    assert worker.last_heartbeat is None


def test_worker_survives_a_ping_that_raises(monkeypatch):
    """Belt and braces over send_heartbeat's own guarantee: if anything in the
    ping path ever raises, the collection loop still has to keep running."""
    from config import Settings
    from services.notifications import (
        NotificationManager,
        NotificationStore,
        NotificationWorker,
    )

    def exploding(*args, **kwargs):
        raise RuntimeError("unexpected")

    monkeypatch.setattr("services.heartbeat.send_heartbeat", exploding)
    worker = NotificationWorker(
        manager=NotificationManager(NotificationStore("unused.json")),
        snapshot_factory=lambda: None,
        settings_factory=lambda: Settings(heartbeat=_config()),
        interval_seconds=60,
    )
    worker._ping_heartbeat(failed=False)  # must not raise
    assert worker.last_heartbeat_error is not None
