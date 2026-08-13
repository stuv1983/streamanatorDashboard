"""Internet, WAN and gateway measurement.

UniFi telemetry would be the ideal source for most of this (see
`services/unifi.py`), but it is not deployed, so latency and loss are measured
directly with ICMP via the system `ping` binary — read-only, timeout bounded,
and cheap enough to run on the dashboard's sample interval rather than on every
page render.
"""

from __future__ import annotations

import ipaddress
import re
import time
from dataclasses import dataclass, field

import requests

from services.system import run_command
from utils.cache import ttl_cache
from utils.logging_setup import get_logger

log = get_logger("network")

#: Default ICMP targets: the gateway (proves the LAN path) and a public anycast
#: resolver (proves the Internet path). Split so a failure localises itself.
DEFAULT_GATEWAY = "10.0.40.1"
DEFAULT_INTERNET_TARGET = "1.1.1.1"


@dataclass
class PingResult:
    target: str
    #: None when no reply came back at all — distinct from 0 ms.
    latency_ms: float | None
    packet_loss_percent: float | None
    jitter_ms: float | None
    packets_sent: int
    packets_received: int
    error: str = ""
    checked_at: float = field(default_factory=time.time)

    @property
    def reachable(self) -> bool:
        return self.packets_received > 0


_PING_STATS = re.compile(
    r"(?P<sent>\d+) packets transmitted, (?P<received>\d+) (?:packets )?received"
    r"(?:.*?(?P<loss>[\d.]+)% packet loss)?",
    re.DOTALL,
)
_PING_RTT = re.compile(
    r"(?:rtt|round-trip) min/avg/max/(?:mdev|stddev) = "
    r"(?P<min>[\d.]+)/(?P<avg>[\d.]+)/(?P<max>[\d.]+)/(?P<mdev>[\d.]+)"
)


def parse_ping(output: str, target: str) -> PingResult:
    """Parse iputils/BSD ping summary output.

    Split out as a pure function so packet-loss classification can be tested
    without needing a network.
    """
    sent = received = 0
    loss: float | None = None
    stats = _PING_STATS.search(output)
    if stats:
        sent = int(stats.group("sent"))
        received = int(stats.group("received"))
        if stats.group("loss") is not None:
            loss = float(stats.group("loss"))
        elif sent:
            loss = 100.0 * (sent - received) / sent

    latency = jitter = None
    rtt = _PING_RTT.search(output)
    if rtt:
        latency = float(rtt.group("avg"))
        jitter = float(rtt.group("mdev"))

    return PingResult(
        target=target,
        latency_ms=latency,
        packet_loss_percent=loss,
        jitter_ms=jitter,
        packets_sent=sent,
        packets_received=received,
    )


@ttl_cache(seconds=50)
def ping(target: str, count: int = 5, timeout: float = 8.0) -> PingResult:
    """ICMP probe. A missing `ping` binary yields an error result, not a crash.

    Cached briefly: five packets at a 0.3s interval is over a second of wall
    clock, and running it fresh on every widget render would dominate the page
    budget for no extra information.
    """
    code, out, err = run_command(
        ["ping", "-n", "-c", str(count), "-W", "2", "-i", "0.3", target], timeout
    )
    if code == 127:
        return PingResult(
            target=target,
            latency_ms=None,
            packet_loss_percent=None,
            jitter_ms=None,
            packets_sent=0,
            packets_received=0,
            error="ping binary not available",
        )
    result = parse_ping(out, target)
    if result.packets_sent == 0:
        result.error = err.strip() or out.strip()[:120] or "ping produced no summary"
    return result


@dataclass
class WanIpInfo:
    ip: str | None
    city: str = ""
    region: str = ""
    country: str = ""
    org: str = ""
    error: str = ""
    checked_at: float = field(default_factory=time.time)

    @property
    def location(self) -> str:
        parts = [p for p in (self.city, self.region, self.country) if p]
        return ", ".join(parts)


@ttl_cache(seconds=120)
def get_public_ip(url: str = "https://ipinfo.io/json", timeout: float = 6.0) -> WanIpInfo:
    """Home WAN public IP, as seen from the host's normal route.

    Cached for two minutes: this is an outbound call to a third party, the
    address changes rarely, and hammering it on every refresh would be rude as
    well as slow.
    """
    try:
        response = requests.get(
            url,
            timeout=timeout,
            headers={"User-Agent": "streamanator-dashboard/1.0"},
        )
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        return WanIpInfo(ip=None, error=f"{type(exc).__name__}: {exc}")
    except ValueError as exc:
        return WanIpInfo(ip=None, error=f"Malformed response: {exc}")

    ip = str(payload.get("ip", "")).strip()
    if not _valid_ip(ip):
        return WanIpInfo(ip=None, error="Response did not contain a valid IP")
    return WanIpInfo(
        ip=ip,
        city=str(payload.get("city", "")),
        region=str(payload.get("region", "")),
        country=str(payload.get("country", "")),
        org=str(payload.get("org", "")),
    )


def _valid_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


@dataclass
class InterfaceCounters:
    name: str
    rx_bytes: int
    tx_bytes: int
    rx_errors: int
    tx_errors: int
    rx_dropped: int
    tx_dropped: int
    timestamp: float = field(default_factory=time.time)


def read_interface_counters() -> dict[str, InterfaceCounters]:
    """Per-interface counters from /proc/net/dev.

    These are the *server's* interfaces, not the gateway's WAN link. They are
    labelled as such in the UI — presenting host NIC throughput as "WAN
    throughput" would be wrong, and real WAN figures need UniFi telemetry.
    """
    try:
        with open("/proc/net/dev", encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError:
        return {}

    counters: dict[str, InterfaceCounters] = {}
    for line in lines[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        fields = rest.split()
        if len(fields) < 16 or name == "lo":
            continue
        try:
            counters[name] = InterfaceCounters(
                name=name,
                rx_bytes=int(fields[0]),
                rx_errors=int(fields[2]),
                rx_dropped=int(fields[3]),
                tx_bytes=int(fields[8]),
                tx_errors=int(fields[10]),
                tx_dropped=int(fields[11]),
            )
        except (ValueError, IndexError):
            continue
    return counters


_last_interface_counters: dict[str, InterfaceCounters] = {}


@dataclass
class InterfaceRate:
    name: str
    rx_bytes_per_sec: float
    tx_bytes_per_sec: float
    rx_error_delta: int
    tx_error_delta: int
    drop_delta: int


def get_interface_rates() -> dict[str, InterfaceRate]:
    """Throughput per interface since the previous call. Empty on first call."""
    global _last_interface_counters
    current = read_interface_counters()
    previous = _last_interface_counters
    _last_interface_counters = current
    if not previous:
        return {}

    rates: dict[str, InterfaceRate] = {}
    for name, counters in current.items():
        before = previous.get(name)
        if before is None:
            continue
        elapsed = counters.timestamp - before.timestamp
        if elapsed <= 0:
            continue
        rates[name] = InterfaceRate(
            name=name,
            rx_bytes_per_sec=max(0, counters.rx_bytes - before.rx_bytes) / elapsed,
            tx_bytes_per_sec=max(0, counters.tx_bytes - before.tx_bytes) / elapsed,
            rx_error_delta=max(0, counters.rx_errors - before.rx_errors),
            tx_error_delta=max(0, counters.tx_errors - before.tx_errors),
            drop_delta=max(
                0,
                (counters.rx_dropped + counters.tx_dropped)
                - (before.rx_dropped + before.tx_dropped),
            ),
        )
    return rates


def get_default_gateway() -> str | None:
    """The host's default gateway, read from the routing table."""
    code, out, _ = run_command(["ip", "-4", "route", "show", "default"], timeout=4.0)
    if code != 0:
        return None
    match = re.search(r"default via (\S+)", out)
    return match.group(1) if match else None
