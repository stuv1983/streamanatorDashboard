"""Dead-man's switch pings to an external uptime service (Healthchecks.io).

Everything else in this dashboard answers "is the system healthy?". This module
answers a question the dashboard cannot answer about itself: **is the monitoring
still running at all?**

The distinction matters because the failure modes are opposite. A failing disk
raises an alert and an email goes out. A kernel panic, a power cut, an OOM kill
or a crashed Streamlit process produces *silence* — and silence looks exactly
like health. The alerting lives inside the process that just died, so it cannot
report its own death.

So the direction of monitoring is inverted here. The dashboard pings an outside
service on every notification cycle, and that service alerts when the pings
stop. Nothing on this host has to be working for that alarm to fire; that is
the entire point.

Two rules shape the code below.

**Liveness is not health.** A degraded RAID array must never ping ``/fail``.
That is a real finding, it already has an email path, and duplicating it here
would train you to ignore the one signal that means "your monitoring is
broken". ``/fail`` is reserved for the pipeline itself failing: the collection
raised, or an alert email could not be delivered.

**This can never take the worker down.** A ping is best-effort. Every failure
path returns a result rather than raising, because a typo in a URL must not
stop the collection loop it is supposed to be watching.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from urllib.parse import urlparse

import requests

from config import HeartbeatConfig
from utils.http import DeadlineExceeded, ResponseTooLarge, get_bounded
from utils.logging_setup import get_logger

log = get_logger("heartbeat")

#: Healthchecks.io answers a ping with the literal body "OK". Nothing here
#: needs the body, so the cap exists only to bound a misdirected URL that
#: returns a large page.
MAX_PING_BYTES = 4096


@dataclass(frozen=True)
class HeartbeatResult:
    ok: bool
    message: str
    status_code: int | None = None
    duration_seconds: float = 0.0


def validate_ping_url(value: str) -> str:
    """Return a usable ping URL or raise ValueError.

    HTTPS is required rather than preferred. The URL is a capability: anyone who
    observes it can ping the check themselves and suppress a genuine "the
    dashboard is down" alarm. Sending it in plaintext over the LAN would hand
    that capability to anything on the wire, which defeats the switch quietly —
    the worst way for a safety net to fail.
    """
    url = (value or "").strip()
    if not url:
        raise ValueError("The ping URL is empty.")
    if any(char in url for char in ("\r", "\n", "\x00", " ")):
        raise ValueError("The ping URL contains whitespace or control characters.")
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(
            "The ping URL must use https. It is a capability URL — anyone who "
            "sees it can silence the alarm it is meant to raise."
        )
    if not parsed.netloc:
        raise ValueError("The ping URL has no host.")
    if parsed.username or parsed.password:
        raise ValueError("The ping URL must not embed credentials.")
    return url


def send_heartbeat(
    config: HeartbeatConfig,
    *,
    failed: bool = False,
    getter=get_bounded,
) -> HeartbeatResult:
    """Ping the dead-man's switch. Never raises.

    `failed=True` appends Healthchecks.io's ``/fail`` suffix, which trips the
    check immediately instead of waiting for its period to lapse. Reserve it for
    the monitoring pipeline breaking — see the module docstring on why a
    degraded array does not belong here.

    `getter` is injected so the tests exercise every branch without a socket.
    """
    if not config.configured:
        return HeartbeatResult(False, "No ping URL is configured.")

    started = time.perf_counter()
    try:
        url = validate_ping_url(config.ping_url or "")
    except ValueError as exc:
        return HeartbeatResult(False, str(exc))

    if failed:
        url = url.rstrip("/") + "/fail"

    try:
        response = getter(
            url,
            timeout=config.timeout_seconds,
            max_bytes=MAX_PING_BYTES,
        )
    except (requests.RequestException, ResponseTooLarge, DeadlineExceeded, OSError) as exc:
        # Logged at debug, not warning: an internet outage makes this fail every
        # cycle, and that is the one situation where the switch is doing its job
        # rather than misbehaving. Filling the journal with it helps nobody.
        log.debug("Heartbeat ping failed: %s: %s", type(exc).__name__, exc)
        return HeartbeatResult(
            False,
            f"Ping failed: {type(exc).__name__}: {exc}",
            duration_seconds=time.perf_counter() - started,
        )

    duration = time.perf_counter() - started
    if 200 <= response.status_code < 300:
        return HeartbeatResult(
            True,
            "Ping delivered." if not failed else "Failure signal delivered.",
            status_code=response.status_code,
            duration_seconds=duration,
        )
    # A 404 here almost always means the check was deleted in Healthchecks.io
    # while the URL stayed in .env — worth saying plainly, because the symptom
    # otherwise is an alarm that silently never fires.
    hint = (
        " The check may have been deleted — verify the URL in Healthchecks.io."
        if response.status_code == 404
        else ""
    )
    return HeartbeatResult(
        False,
        f"Ping rejected with HTTP {response.status_code}.{hint}",
        status_code=response.status_code,
        duration_seconds=duration,
    )
