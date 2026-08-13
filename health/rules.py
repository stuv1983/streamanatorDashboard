"""Health classification rules.

Every rule is a pure function: values in, `(Status, detail)` or a `Reading`
out. No I/O, no Streamlit, no globals. That is what makes the critical logic —
degraded RAID, CRC deltas, VPN leaks, backup age — unit testable, and the tests
in `tests/` exercise these functions directly.

Two invariants hold throughout:

* `None` in means `Status.UNKNOWN` out. A rule never treats absent data as a
  passing measurement.
* A non-healthy verdict always carries a `detail` string explaining what was
  measured against what limit.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from core.status import Alert, Reading, Status
from health.thresholds import Thresholds, get_thresholds
from utils.formatting import (
    format_delta,
    format_percent,
    human_bytes,
    human_duration,
)


@dataclass(frozen=True)
class Verdict:
    """A status plus the reasoning behind it."""

    status: Status
    detail: str
    threshold: str = ""


def _unknown(reason: str) -> Verdict:
    return Verdict(Status.UNKNOWN, reason)


# ---------------------------------------------------------------------------
# RAID
# ---------------------------------------------------------------------------


def classify_raid(
    active: int | None,
    required: int | None,
    sync_action: str | None = None,
    sync_percent: float | None = None,
    array_active: bool = True,
) -> Verdict:
    """Classify MD array state.

    Losing a member of a RAID5 array removes all redundancy: a second failure
    during the rebuild loses the data. That is CRITICAL regardless of whether
    the filesystem is still serving reads.
    """
    if active is None or required is None:
        return _unknown("RAID member counts could not be read.")

    if not array_active:
        return Verdict(
            Status.CRITICAL,
            "Array is not active. The filesystem is offline.",
            "array must be active",
        )

    if active < required:
        missing = required - active
        detail = (
            f"Array is DEGRADED — {active}/{required} members active, "
            f"{missing} missing. RAID5 has no remaining redundancy; a second "
            f"disk failure would lose the array."
        )
        if sync_action:
            detail += (
                f" A {sync_action} is in progress"
                + (f" ({sync_percent:.1f}%)" if sync_percent is not None else "")
                + "."
            )
        return Verdict(Status.CRITICAL, detail, f"{required}/{required} required")

    if active > required:
        return Verdict(
            Status.INFO,
            f"{active} members present for a {required}-device array "
            f"(spare or rebuilding member attached).",
            f"{required} required",
        )

    if sync_action and sync_action.lower() not in {"idle", "none"}:
        progress = f" at {sync_percent:.1f}%" if sync_percent is not None else ""
        return Verdict(
            Status.WARNING,
            f"All {active}/{required} members present, but a {sync_action} is "
            f"running{progress}. Redundancy is restored only when it completes.",
            f"{required}/{required} required",
        )

    return Verdict(
        Status.HEALTHY,
        f"All {active}/{required} members active.",
        f"{required}/{required} required",
    )


# ---------------------------------------------------------------------------
# Physical disks
# ---------------------------------------------------------------------------


def classify_smart_health(passed: bool | None) -> Verdict:
    if passed is None:
        return _unknown("SMART overall health could not be read.")
    if not passed:
        return Verdict(
            Status.CRITICAL,
            "SMART overall self-assessment has FAILED. The drive predicts its "
            "own imminent failure — replace it.",
            "must report PASSED",
        )
    return Verdict(Status.HEALTHY, "SMART self-assessment PASSED.", "PASSED")


def classify_pending_sectors(count: float | None, thresholds: Thresholds | None = None) -> Verdict:
    t = (thresholds or get_thresholds()).disk
    if count is None:
        return _unknown("Pending sector count unavailable.")
    if count > t.pending_sectors_critical:
        return Verdict(
            Status.CRITICAL,
            f"{int(count)} sectors are pending reallocation — blocks the drive "
            f"could not read. Back up now and plan replacement.",
            f"must be {t.pending_sectors_critical}",
        )
    return Verdict(Status.HEALTHY, "No pending sectors.", "0")


def classify_offline_uncorrectable(
    count: float | None, thresholds: Thresholds | None = None
) -> Verdict:
    t = (thresholds or get_thresholds()).disk
    if count is None:
        return _unknown("Offline uncorrectable count unavailable.")
    if count > t.offline_uncorrectable_critical:
        return Verdict(
            Status.CRITICAL,
            f"{int(count)} sectors are uncorrectable — data in those blocks is "
            f"already unreadable.",
            f"must be {t.offline_uncorrectable_critical}",
        )
    return Verdict(Status.HEALTHY, "No uncorrectable sectors.", "0")


def classify_disk_temperature(
    celsius: float | None, thresholds: Thresholds | None = None
) -> Verdict:
    t = (thresholds or get_thresholds()).disk
    if celsius is None:
        return _unknown("Disk temperature unavailable.")
    limits = f"warn >{t.temp_warning:.0f} °C, critical >{t.temp_critical:.0f} °C"
    if celsius > t.temp_critical:
        return Verdict(
            Status.CRITICAL,
            f"{celsius:.0f} °C exceeds the {t.temp_critical:.0f} °C limit. "
            f"Check chassis airflow immediately.",
            limits,
        )
    if celsius > t.temp_warning:
        return Verdict(
            Status.WARNING,
            f"{celsius:.0f} °C is above the {t.temp_warning:.0f} °C guideline.",
            limits,
        )
    if celsius > t.temp_watch:
        return Verdict(
            Status.INFO,
            f"{celsius:.0f} °C — warm but within tolerance.",
            limits,
        )
    return Verdict(Status.HEALTHY, f"{celsius:.0f} °C.", limits)


def classify_crc_delta(
    current: float | None,
    delta_24h: float | None,
    delta_7d: float | None = None,
    delta_1h: float | None = None,
    thresholds: Thresholds | None = None,
) -> Verdict:
    """Classify UDMA CRC errors by movement, not absolute value.

    This is the rule the whole disk page is built around. `WPV2E6LL` carries
    roughly 5670 CRC errors from the July/August 2026 SATA-path incidents. That
    number will never go down, and treating it as a fault would mean a
    permanently red dashboard. What matters is whether it is still climbing:
    a rising counter means the cable/port/backplane path is still faulty.
    """
    t = (thresholds or get_thresholds()).disk

    if current is None:
        return _unknown("CRC error count unavailable.")

    known_deltas = [d for d in (delta_1h, delta_24h, delta_7d) if d is not None]
    if not known_deltas:
        return Verdict(
            Status.UNKNOWN,
            f"Count is {int(current):,}, but no historical sample exists yet to "
            f"compare against. The trend — not the total — is what matters here.",
            f"delta must stay below +{t.crc_delta_warning}",
        )

    worst_delta = max(known_deltas)
    limits = f"warn ≥ +{t.crc_delta_warning}, critical ≥ +{t.crc_delta_critical}"

    if worst_delta >= t.crc_delta_critical:
        return Verdict(
            Status.CRITICAL,
            f"CRC errors are climbing fast (+{worst_delta:,.0f}). The SATA data "
            f"path is actively failing. Total is now {int(current):,}.",
            limits,
        )
    if worst_delta >= t.crc_delta_warning:
        return Verdict(
            Status.WARNING,
            f"CRC error count is INCREASING ({format_delta(worst_delta)}). Total "
            f"is {int(current):,}. This points at the SATA cable, connector, "
            f"backplane or controller port — not the disk media.",
            limits,
        )
    return Verdict(
        Status.HEALTHY,
        f"STABLE — count is {int(current):,} and has not increased "
        f"({format_delta(delta_24h, '')} over 24h"
        + (f", {format_delta(delta_7d, '')} over 7d" if delta_7d is not None else "")
        + "). A high but static count reflects a past fault, not a current one.",
        limits,
    )


def classify_reallocated_delta(
    current: float | None, delta: float | None, thresholds: Thresholds | None = None
) -> Verdict:
    t = (thresholds or get_thresholds()).disk
    if current is None:
        return _unknown("Reallocated sector count unavailable.")
    if delta is None:
        if current > 0:
            return Verdict(
                Status.INFO,
                f"{int(current):,} reallocated sectors recorded; no history yet "
                f"to tell whether the count is still growing.",
            )
        return Verdict(Status.HEALTHY, "No reallocated sectors.")
    if delta >= t.reallocated_delta_warning:
        return Verdict(
            Status.WARNING,
            f"Reallocated sectors increased by {format_delta(delta)} to "
            f"{int(current):,}. The drive is actively retiring bad blocks.",
            f"delta must stay below +{t.reallocated_delta_warning}",
        )
    if current > 0:
        return Verdict(
            Status.INFO,
            f"{int(current):,} reallocated sectors, stable ({format_delta(delta)}).",
        )
    return Verdict(Status.HEALTHY, "No reallocated sectors.")


# ---------------------------------------------------------------------------
# Filesystems
# ---------------------------------------------------------------------------


def classify_filesystem(
    used_percent: float | None,
    free_bytes: int | None = None,
    thresholds: Thresholds | None = None,
) -> Verdict:
    t = (thresholds or get_thresholds()).storage
    if used_percent is None:
        return _unknown("Filesystem usage could not be read.")

    limits = (
        f"warn ≥{t.warning_percent:.0f}%, high ≥{t.high_percent:.0f}%, "
        f"critical ≥{t.critical_percent:.0f}%"
    )
    free_text = f" {human_bytes(free_bytes)} free." if free_bytes is not None else ""

    if used_percent >= t.critical_percent:
        return Verdict(
            Status.CRITICAL,
            f"{format_percent(used_percent)} used.{free_text} Writes will start "
            f"failing shortly.",
            limits,
        )
    if used_percent >= t.high_percent:
        return Verdict(
            Status.WARNING,
            f"{format_percent(used_percent)} used.{free_text} Free space is "
            f"getting short.",
            limits,
        )
    if used_percent >= t.warning_percent:
        return Verdict(
            Status.WARNING,
            f"{format_percent(used_percent)} used.{free_text}",
            limits,
        )
    return Verdict(
        Status.HEALTHY, f"{format_percent(used_percent)} used.{free_text}", limits
    )


def classify_inodes(
    inode_used_percent: float | None, thresholds: Thresholds | None = None
) -> Verdict:
    t = (thresholds or get_thresholds()).storage
    if inode_used_percent is None:
        return _unknown("Inode usage unavailable.")
    if inode_used_percent >= t.inode_warning_percent:
        return Verdict(
            Status.WARNING,
            f"{format_percent(inode_used_percent)} of inodes used — the "
            f"filesystem can run out of inodes before it runs out of space.",
            f"warn ≥{t.inode_warning_percent:.0f}%",
        )
    return Verdict(Status.HEALTHY, f"{format_percent(inode_used_percent)} of inodes used.")


def classify_forecast(forecast, thresholds: Thresholds | None = None) -> Verdict:
    """Turn a capacity forecast into a status.

    An unavailable forecast is INFO, not a warning: not knowing the growth rate
    is a gap in observation, not a fault in the filesystem.
    """
    t = (thresholds or get_thresholds()).storage
    if forecast is None or not forecast.available:
        reason = getattr(forecast, "reason", "") or "No forecast available."
        return Verdict(Status.INFO, f"Forecast unavailable — {reason}")

    days = forecast.days_until_90
    if days is None:
        if forecast.shrinking:
            return Verdict(Status.HEALTHY, "Usage is falling; no fill date projected.")
        return Verdict(
            Status.HEALTHY, "No 90% crossing projected within the planning horizon."
        )
    if days <= t.forecast_critical_days:
        return Verdict(
            Status.CRITICAL,
            f"Projected to reach 90% in {days:.0f} days at the current growth "
            f"rate ({human_bytes(forecast.growth_bytes_per_day)}/day).",
            f"critical ≤{t.forecast_critical_days:.0f} days",
        )
    if days <= t.forecast_warning_days:
        return Verdict(
            Status.WARNING,
            f"Projected to reach 90% in {days:.0f} days "
            f"({human_bytes(forecast.growth_bytes_per_day)}/day).",
            f"warn ≤{t.forecast_warning_days:.0f} days",
        )
    return Verdict(
        Status.HEALTHY,
        f"90% is about {days:.0f} days away at "
        f"{human_bytes(forecast.growth_bytes_per_day)}/day.",
    )


# ---------------------------------------------------------------------------
# Host
# ---------------------------------------------------------------------------


def classify_cpu(percent: float | None, thresholds: Thresholds | None = None) -> Verdict:
    t = (thresholds or get_thresholds()).host
    if percent is None:
        return _unknown("CPU utilisation not yet sampled.")
    limits = f"warn >{t.cpu_warning_percent:.0f}%, critical >{t.cpu_critical_percent:.0f}%"
    if percent > t.cpu_critical_percent:
        return Verdict(Status.CRITICAL, f"CPU at {format_percent(percent)}.", limits)
    if percent > t.cpu_warning_percent:
        return Verdict(Status.WARNING, f"CPU at {format_percent(percent)}.", limits)
    return Verdict(Status.HEALTHY, f"CPU at {format_percent(percent)}.", limits)


def classify_memory_available(
    available_percent: float | None, thresholds: Thresholds | None = None
) -> Verdict:
    """Judge memory on MemAvailable, not free.

    This host shows ~800 MiB "free" alongside 27 GiB of page cache and 28 GiB
    available. Reporting free memory would show a permanent false emergency.
    """
    t = (thresholds or get_thresholds()).host
    if available_percent is None:
        return _unknown("Memory availability unavailable.")
    limits = (
        f"warn <{t.memory_available_warning_percent:.0f}%, "
        f"critical <{t.memory_available_critical_percent:.0f}% available"
    )
    if available_percent < t.memory_available_critical_percent:
        return Verdict(
            Status.CRITICAL,
            f"Only {format_percent(available_percent)} of RAM is available.",
            limits,
        )
    if available_percent < t.memory_available_warning_percent:
        return Verdict(
            Status.WARNING,
            f"{format_percent(available_percent)} of RAM available.",
            limits,
        )
    return Verdict(
        Status.HEALTHY,
        f"{format_percent(available_percent)} of RAM available.",
        limits,
    )


def classify_swap(percent: float | None, thresholds: Thresholds | None = None) -> Verdict:
    t = (thresholds or get_thresholds()).host
    if percent is None:
        return _unknown("Swap usage unavailable.")
    limits = f"warn >{t.swap_warning_percent:.0f}%"
    if percent > t.swap_critical_percent:
        return Verdict(Status.CRITICAL, f"Swap {format_percent(percent)} used.", limits)
    if percent > t.swap_warning_percent:
        return Verdict(Status.WARNING, f"Swap {format_percent(percent)} used.", limits)
    return Verdict(Status.HEALTHY, f"Swap {format_percent(percent)} used.", limits)


def classify_iowait(percent: float | None, thresholds: Thresholds | None = None) -> Verdict:
    t = (thresholds or get_thresholds()).host
    if percent is None:
        return _unknown("iowait not yet sampled.")
    limits = f"warn >{t.iowait_warning_percent:.0f}%"
    if percent > t.iowait_critical_percent:
        return Verdict(
            Status.CRITICAL,
            f"iowait at {format_percent(percent)} — the CPU is mostly waiting on "
            f"storage.",
            limits,
        )
    if percent > t.iowait_warning_percent:
        return Verdict(
            Status.WARNING,
            f"iowait at {format_percent(percent)} — storage may be a bottleneck.",
            limits,
        )
    return Verdict(Status.HEALTHY, f"iowait at {format_percent(percent)}.", limits)


def classify_load(
    load1: float | None, cpu_cores: int, thresholds: Thresholds | None = None
) -> Verdict:
    """Load average judged against core count, not an absolute number."""
    t = (thresholds or get_thresholds()).host
    if load1 is None or cpu_cores <= 0:
        return _unknown("Load average unavailable.")
    ratio = load1 / cpu_cores
    limits = f"warn >{t.load_warning_ratio:.1f}× cores ({cpu_cores})"
    if ratio > t.load_critical_ratio:
        return Verdict(
            Status.CRITICAL,
            f"Load {load1:.2f} is {ratio:.1f}× the {cpu_cores} available cores.",
            limits,
        )
    if ratio > t.load_warning_ratio:
        return Verdict(
            Status.WARNING,
            f"Load {load1:.2f} exceeds the {cpu_cores} available cores.",
            limits,
        )
    return Verdict(
        Status.HEALTHY, f"Load {load1:.2f} across {cpu_cores} cores.", limits
    )


def classify_failed_units(units: list | None) -> Verdict:
    """Any failed systemd unit is worth surfacing by name."""
    if units is None:
        return _unknown("systemd state could not be queried.")
    if not units:
        return Verdict(Status.HEALTHY, "No failed systemd units.")
    names = ", ".join(getattr(u, "name", str(u)) for u in units[:5])
    suffix = "" if len(units) <= 5 else f" (+{len(units) - 5} more)"
    return Verdict(
        Status.WARNING,
        f"{len(units)} failed unit(s): {names}{suffix}.",
        "0 failed units",
    )


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------


def classify_internet(
    reachable: bool | None,
    latency_ms: float | None,
    packet_loss_percent: float | None,
    down_since: float | None = None,
    thresholds: Thresholds | None = None,
) -> Verdict:
    t = (thresholds or get_thresholds()).network

    if reachable is None:
        return _unknown("Internet reachability could not be tested.")

    if not reachable:
        if down_since is not None:
            outage = time.time() - down_since
            if outage < t.internet_down_seconds:
                return Verdict(
                    Status.WARNING,
                    f"No response for {human_duration(outage)} — below the "
                    f"{t.internet_down_seconds}s threshold for a critical alert.",
                    f"critical after {t.internet_down_seconds}s",
                )
            return Verdict(
                Status.CRITICAL,
                f"Internet unreachable for {human_duration(outage)}.",
                f"critical after {t.internet_down_seconds}s",
            )
        return Verdict(Status.CRITICAL, "Internet is unreachable.", "must respond")

    if packet_loss_percent is not None:
        if packet_loss_percent >= t.packet_loss_critical_percent:
            return Verdict(
                Status.CRITICAL,
                f"{format_percent(packet_loss_percent)} packet loss.",
                f"critical ≥{t.packet_loss_critical_percent:.0f}%",
            )
        if packet_loss_percent >= t.packet_loss_warning_percent:
            return Verdict(
                Status.WARNING,
                f"{format_percent(packet_loss_percent)} packet loss.",
                f"warn ≥{t.packet_loss_warning_percent:.0f}%",
            )

    if latency_ms is not None:
        if latency_ms >= t.latency_critical_ms:
            return Verdict(
                Status.CRITICAL,
                f"Latency {latency_ms:.0f} ms.",
                f"critical ≥{t.latency_critical_ms:.0f} ms",
            )
        if latency_ms >= t.latency_warning_ms:
            return Verdict(
                Status.WARNING,
                f"Latency {latency_ms:.0f} ms.",
                f"warn ≥{t.latency_warning_ms:.0f} ms",
            )

    latency_text = f"{latency_ms:.0f} ms" if latency_ms is not None else "reachable"
    loss_text = (
        f", {format_percent(packet_loss_percent)} loss"
        if packet_loss_percent is not None
        else ""
    )
    return Verdict(Status.HEALTHY, f"Internet up — {latency_text}{loss_text}.")


# ---------------------------------------------------------------------------
# VPN
# ---------------------------------------------------------------------------


def classify_vpn(status) -> Verdict:
    """Classify Gluetun, naming the probable cause when one is known."""
    if status is None:
        return _unknown("VPN state could not be determined.")

    if not status.container_present:
        return Verdict(
            Status.CRITICAL,
            "Gluetun container is missing. The entire download and indexer "
            "stack depends on its network namespace.",
            "container must exist",
        )
    if not status.container_running:
        return Verdict(
            Status.CRITICAL,
            f"Gluetun is not running ({status.error or 'stopped'}). Every "
            f"container sharing its namespace has lost connectivity.",
            "container must be running",
        )

    problems: list[str] = []
    if status.container_healthy is False:
        problems.append("Docker healthcheck failing")
    if status.tunnel_up is False:
        problems.append("tunnel down")
    if status.dns_ok is False:
        problems.append("DNS resolution failing")
    if status.https_ok is False:
        problems.append("outbound HTTPS failing")

    if problems:
        detail = "VPN unhealthy: " + ", ".join(problems) + "."
        if status.error:
            detail += f" Likely cause: {status.error}."
        if status.auth_failures:
            detail += f" {status.auth_failures} AUTH_FAILED entries in recent logs."
        return Verdict(Status.CRITICAL, detail, "tunnel up, DNS and HTTPS working")

    if status.container_healthy is None and status.tunnel_up is None:
        return _unknown("Gluetun is running but its tunnel state is unknown.")

    location = f" ({status.location})" if status.location else ""
    return Verdict(
        Status.HEALTHY,
        f"{status.provider or 'VPN'} connected via {status.public_ip}{location}.",
    )


def classify_leak(leak) -> Verdict:
    """Classify the VPN leak check.

    An inconclusive check is UNKNOWN, never a pass. Claiming "PASS" without
    both addresses would be asserting something about where torrent traffic is
    going that has not actually been verified.
    """
    if leak is None:
        return _unknown("Leak check not performed.")
    if leak.passed is None:
        return Verdict(Status.UNKNOWN, leak.detail, "VPN IP must differ from WAN IP")
    if not leak.passed:
        return Verdict(
            Status.CRITICAL,
            f"POSSIBLE VPN LEAK — the download stack's public IP ({leak.vpn_ip}) "
            f"matches the home WAN IP. Traffic is bypassing the tunnel.",
            "VPN IP must differ from WAN IP",
        )
    return Verdict(
        Status.HEALTHY,
        f"PASS — download stack exits on {leak.vpn_ip}, home WAN is {leak.wan_ip}.",
        "VPN IP must differ from WAN IP",
    )


# ---------------------------------------------------------------------------
# Containers
# ---------------------------------------------------------------------------


def classify_container(
    container,
    expected_critical: bool = True,
    restart_delta: int | None = None,
    thresholds: Thresholds | None = None,
) -> Verdict:
    t = (thresholds or get_thresholds()).container

    if container is None:
        severity = Status.CRITICAL if expected_critical else Status.WARNING
        return Verdict(
            severity,
            "Expected container is missing entirely.",
            "container must exist",
        )

    if not container.running:
        severity = Status.CRITICAL if expected_critical else Status.WARNING
        return Verdict(
            severity, f"Container is {container.state}.", "must be running"
        )

    if restart_delta is not None and restart_delta >= t.restart_delta_critical:
        return Verdict(
            Status.CRITICAL,
            f"Container has restarted {restart_delta} times recently — this is a "
            f"crash loop.",
            f"critical ≥{t.restart_delta_critical} restarts",
        )
    if restart_delta is not None and restart_delta >= t.restart_delta_warning:
        return Verdict(
            Status.WARNING,
            f"Container restarted {restart_delta} time(s) recently.",
            f"warn ≥{t.restart_delta_warning} restarts",
        )

    if container.healthy is False:
        return Verdict(
            Status.CRITICAL,
            f"Docker healthcheck reports '{container.health}'.",
            "healthcheck must pass",
        )

    uptime = container.uptime_seconds
    if uptime is not None and uptime < t.recent_start_seconds:
        return Verdict(
            Status.INFO,
            f"Running, but started only {human_duration(uptime)} ago.",
        )

    health_text = " and healthy" if container.healthy else ""
    return Verdict(
        Status.HEALTHY,
        f"Running{health_text} for {human_duration(uptime)}."
        if uptime
        else f"Running{health_text}.",
    )


# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------


def classify_probe(
    result, critical: bool = False, thresholds: Thresholds | None = None
) -> Verdict:
    t = (thresholds or get_thresholds()).probe
    if result is None:
        return _unknown("Service was not probed.")

    if not result.success:
        severity = Status.CRITICAL if critical else Status.WARNING
        stage = {
            "dns": "DNS resolution failed",
            "tcp": "TCP connection refused or timed out",
            "http": "HTTP request failed",
            "status": "unexpected HTTP status",
            "config": "no URL configured",
        }.get(result.failed_stage, "probe failed")
        if result.failed_stage == "config":
            return Verdict(Status.UNKNOWN, "No URL configured for this service.")
        return Verdict(
            severity,
            f"{stage}: {result.error}",
            "must return an expected status",
        )

    latency = result.latency_ms
    if latency is not None and latency >= t.latency_critical_ms:
        return Verdict(
            Status.WARNING,
            f"Responding, but very slowly ({latency:.0f} ms).",
            f"warn ≥{t.latency_warning_ms:.0f} ms",
        )
    if latency is not None and latency >= t.latency_warning_ms:
        return Verdict(
            Status.WARNING,
            f"Responding slowly ({latency:.0f} ms).",
            f"warn ≥{t.latency_warning_ms:.0f} ms",
        )

    return Verdict(
        Status.HEALTHY,
        f"HTTP {result.status_code} in {latency:.0f} ms."
        if latency is not None
        else f"HTTP {result.status_code}.",
    )


def classify_tls_expiry(
    days_remaining: float | None, thresholds: Thresholds | None = None
) -> Verdict:
    t = (thresholds or get_thresholds()).probe
    if days_remaining is None:
        return _unknown("No TLS certificate observed.")
    if days_remaining < 0:
        return Verdict(Status.CRITICAL, "Certificate has expired.", "must not be expired")
    if days_remaining <= t.tls_expiry_critical_days:
        return Verdict(
            Status.CRITICAL,
            f"Certificate expires in {days_remaining:.0f} days.",
            f"critical ≤{t.tls_expiry_critical_days:.0f} days",
        )
    if days_remaining <= t.tls_expiry_high_days:
        return Verdict(
            Status.WARNING,
            f"Certificate expires in {days_remaining:.0f} days.",
            f"high ≤{t.tls_expiry_high_days:.0f} days",
        )
    if days_remaining <= t.tls_expiry_warning_days:
        return Verdict(
            Status.WARNING,
            f"Certificate expires in {days_remaining:.0f} days.",
            f"warn ≤{t.tls_expiry_warning_days:.0f} days",
        )
    return Verdict(Status.HEALTHY, f"Certificate valid for {days_remaining:.0f} days.")


# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------


def classify_backup_age(
    age_days: float | None,
    expected_interval_days: float = 1.0,
    thresholds: Thresholds | None = None,
) -> Verdict:
    """Classify how stale the most recent backup is."""
    t = (thresholds or get_thresholds()).backup
    if age_days is None:
        return Verdict(
            Status.CRITICAL,
            "No backup found at all. This job has never produced output, or the "
            "destination is unreadable.",
            f"expected every {expected_interval_days:.1f} days",
        )
    limits = (
        f"warn >{t.warning_days:.0f} days, critical >{t.critical_days:.0f} days "
        f"(expected every {expected_interval_days:.1f})"
    )
    if age_days > t.critical_days:
        return Verdict(
            Status.CRITICAL,
            f"Last backup is {age_days:.1f} days old.",
            limits,
        )
    if age_days > t.warning_days:
        return Verdict(
            Status.WARNING,
            f"Last backup is {age_days:.1f} days old — a scheduled run appears "
            f"to have been missed.",
            limits,
        )
    # A job that should run daily but last ran two days ago is already late,
    # even though it is well inside the absolute warning window.
    if age_days > expected_interval_days * 1.5:
        return Verdict(
            Status.WARNING,
            f"Last backup is {age_days:.1f} days old, but this job is expected "
            f"every {expected_interval_days:.1f} days.",
            limits,
        )
    return Verdict(Status.HEALTHY, f"Last backup is {age_days:.1f} days old.", limits)


def classify_missed_run(
    missed_at: float | None, schedule: str, age_days: float | None
) -> Verdict:
    """Classify a scheduled backup run that produced no output.

    This catches a failure that raw age misses. A twice-weekly job whose
    Wednesday run silently fails still looks "3.9 days old" on Thursday, well
    inside a 4-day warning window — but a scheduled run has definitively not
    happened, and that is worth knowing immediately.
    """
    if missed_at is None:
        return Verdict(Status.HEALTHY, "All scheduled runs have produced output.")
    when = time.strftime("%a %d %b %H:%M", time.localtime(missed_at))
    age_text = (
        f" The most recent backup is {age_days:.1f} days old."
        if age_days is not None
        else " No backup exists at all."
    )
    return Verdict(
        Status.WARNING,
        f"A scheduled run was missed: nothing was written for the {when} run "
        f"({schedule}).{age_text}",
        f"expected output after every scheduled run",
    )


def classify_backup_integrity(ok: bool | None, detail: str = "") -> Verdict:
    if ok is None:
        return Verdict(
            Status.UNKNOWN,
            "Integrity has not been verified. Existence is not proof of "
            "restorability." + (f" {detail}" if detail else ""),
            "must verify as ok",
        )
    if not ok:
        return Verdict(
            Status.CRITICAL,
            f"Integrity check FAILED: {detail}",
            "must verify as ok",
        )
    return Verdict(Status.HEALTHY, f"Integrity verified: {detail or 'ok'}.")


def classify_backup_size(
    status, thresholds: Thresholds | None = None
) -> Verdict:
    """Flag a backup that is implausibly small or shrank sharply."""
    t = (thresholds or get_thresholds()).backup
    if status is None or status.latest is None:
        return _unknown("No backup to size-check.")

    if not status.latest.size_known:
        return Verdict(
            Status.INFO,
            "Size not measured — this job writes a directory tree per run, and "
            "walking it is too slow for a page render. Measure it on demand "
            "from the Backups page.",
        )

    if status.size_suspicious:
        return Verdict(
            Status.WARNING,
            f"Latest backup is only {human_bytes(status.latest.size_bytes)}, well "
            f"below the {human_bytes(status.min_plausible_bytes)} expected — the "
            f"run may have been truncated.",
            f"≥{human_bytes(status.min_plausible_bytes)}",
        )

    growth = status.growth_bytes
    if growth is not None and status.previous and status.previous.size_bytes > 0:
        shrink_percent = -100.0 * growth / status.previous.size_bytes
        if shrink_percent > t.shrink_warning_percent:
            return Verdict(
                Status.WARNING,
                f"Latest backup is {shrink_percent:.0f}% smaller than the previous "
                f"one ({human_bytes(status.latest.size_bytes)} vs "
                f"{human_bytes(status.previous.size_bytes)}).",
                f"warn on >{t.shrink_warning_percent:.0f}% shrink",
            )
    return Verdict(
        Status.HEALTHY, f"Latest backup is {human_bytes(status.latest.size_bytes)}."
    )


# ---------------------------------------------------------------------------
# Freshness
# ---------------------------------------------------------------------------


def classify_freshness(age_seconds: float | None, budget_seconds: float) -> Verdict:
    """Is a measurement current enough to trust?"""
    if age_seconds is None:
        return _unknown("No collection timestamp available.")
    if age_seconds > budget_seconds:
        return Verdict(
            Status.UNKNOWN,
            f"DATA STALE — last updated {human_duration(age_seconds)} ago, budget "
            f"is {human_duration(budget_seconds)}.",
            f"≤{human_duration(budget_seconds)}",
        )
    return Verdict(
        Status.HEALTHY,
        f"CURRENT — updated {human_duration(age_seconds)} ago.",
        f"≤{human_duration(budget_seconds)}",
    )


# ---------------------------------------------------------------------------
# Alert construction
# ---------------------------------------------------------------------------


def alert_from_verdict(
    key: str,
    verdict: Verdict,
    component: str,
    title: str,
    current_value: str = "",
    probable_cause: str = "",
    recommended_action: str = "",
    since: float | None = None,
) -> Alert | None:
    """Build an Alert from a Verdict, or None when nothing is wrong.

    HEALTHY and INFO verdicts produce no alert; UNKNOWN does, because an
    unmeasurable component still needs someone to look at it.
    """
    if verdict.status in {Status.HEALTHY, Status.INFO}:
        return None
    return Alert(
        key=key,
        status=verdict.status,
        title=title,
        component=component,
        detail=verdict.detail,
        current_value=current_value,
        threshold=verdict.threshold,
        probable_cause=probable_cause,
        recommended_action=recommended_action,
        since=since,
    )


def reading_from_verdict(
    key: str,
    label: str,
    value,
    verdict: Verdict,
    unit: str = "",
    source: str = "",
    extra: dict | None = None,
) -> Reading:
    """Bundle a measured value with its verdict into a Reading."""
    return Reading(
        key=key,
        label=label,
        value=value,
        unit=unit,
        status=verdict.status,
        detail=verdict.detail,
        threshold=verdict.threshold,
        source=source,
        extra=extra or {},
    )
