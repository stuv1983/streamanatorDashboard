"""Tests for the health classification rules.

These cover the decisions that matter operationally: degraded RAID, disk
counters that are rising versus merely large, filesystem thresholds, VPN leak
detection, backup age, and the invariant that missing data never classifies as
healthy.
"""

from __future__ import annotations

import time

import pytest

from core.status import Status
from health import rules
from health.thresholds import get_thresholds
from services.vpn import LeakCheck, check_leak

T = get_thresholds()


# ---------------------------------------------------------------------------
# RAID
# ---------------------------------------------------------------------------


class TestRaid:
    def test_healthy_array(self):
        verdict = rules.classify_raid(active=4, required=4)
        assert verdict.status is Status.HEALTHY
        assert "4/4" in verdict.detail

    def test_degraded_array_is_critical(self):
        """The spec's acceptance criterion: 3 of 4 members must be CRITICAL."""
        verdict = rules.classify_raid(active=3, required=4)
        assert verdict.status is Status.CRITICAL
        assert "DEGRADED" in verdict.detail

    def test_degraded_explains_loss_of_redundancy(self):
        verdict = rules.classify_raid(active=3, required=4)
        assert "no remaining redundancy" in verdict.detail.lower()

    def test_two_members_lost_is_still_critical(self):
        verdict = rules.classify_raid(active=2, required=4)
        assert verdict.status is Status.CRITICAL

    def test_inactive_array_is_critical(self):
        verdict = rules.classify_raid(active=4, required=4, array_active=False)
        assert verdict.status is Status.CRITICAL
        assert "not active" in verdict.detail

    def test_resync_with_full_membership_is_warning(self):
        verdict = rules.classify_raid(
            active=4, required=4, sync_action="recovery", sync_percent=42.0
        )
        assert verdict.status is Status.WARNING
        assert "recovery" in verdict.detail

    def test_idle_sync_action_is_healthy(self):
        verdict = rules.classify_raid(active=4, required=4, sync_action="idle")
        assert verdict.status is Status.HEALTHY

    def test_missing_counts_are_unknown_not_healthy(self):
        assert rules.classify_raid(None, 4).status is Status.UNKNOWN
        assert rules.classify_raid(4, None).status is Status.UNKNOWN

    def test_degraded_during_rebuild_mentions_rebuild(self):
        verdict = rules.classify_raid(
            active=3, required=4, sync_action="recovery", sync_percent=12.5
        )
        assert verdict.status is Status.CRITICAL
        assert "recovery" in verdict.detail


# ---------------------------------------------------------------------------
# Disks
# ---------------------------------------------------------------------------


class TestCrcDelta:
    """The CRC rule is the heart of the disk page — trend over absolute value."""

    def test_large_but_static_count_is_healthy(self):
        """WPV2E6LL sits near 5670 from a past fault. Static means healthy."""
        verdict = rules.classify_crc_delta(
            current=5670, delta_24h=0, delta_7d=0, delta_1h=0
        )
        assert verdict.status is Status.HEALTHY
        assert "STABLE" in verdict.detail

    def test_static_count_explains_why_it_is_not_a_fault(self):
        verdict = rules.classify_crc_delta(current=5670, delta_24h=0, delta_7d=0)
        assert "past fault" in verdict.detail.lower()

    def test_small_increase_is_warning(self):
        verdict = rules.classify_crc_delta(current=5684, delta_24h=14, delta_7d=14)
        assert verdict.status is Status.WARNING
        assert "INCREASING" in verdict.detail

    def test_warning_blames_the_data_path_not_the_disk(self):
        verdict = rules.classify_crc_delta(current=5684, delta_24h=14)
        assert "cable" in verdict.detail.lower()
        assert "not the disk media" in verdict.detail.lower()

    def test_large_increase_is_critical(self):
        verdict = rules.classify_crc_delta(current=6200, delta_24h=530, delta_7d=530)
        assert verdict.status is Status.CRITICAL

    def test_no_history_is_unknown_not_healthy(self):
        """Without a baseline the counter cannot be called stable."""
        verdict = rules.classify_crc_delta(current=5670, delta_24h=None, delta_7d=None)
        assert verdict.status is Status.UNKNOWN
        assert "no historical sample" in verdict.detail.lower()

    def test_missing_current_value_is_unknown(self):
        verdict = rules.classify_crc_delta(current=None, delta_24h=0)
        assert verdict.status is Status.UNKNOWN

    def test_worst_window_drives_the_verdict(self):
        """A quiet 24h does not excuse a rise over 7 days."""
        verdict = rules.classify_crc_delta(current=5700, delta_24h=0, delta_7d=30)
        assert verdict.status is Status.WARNING

    def test_zero_count_with_zero_delta_is_healthy(self):
        verdict = rules.classify_crc_delta(current=0, delta_24h=0, delta_7d=0)
        assert verdict.status is Status.HEALTHY


class TestDiskAttributes:
    def test_smart_failed_is_critical(self):
        assert rules.classify_smart_health(False).status is Status.CRITICAL

    def test_smart_passed_is_healthy(self):
        assert rules.classify_smart_health(True).status is Status.HEALTHY

    def test_smart_unknown_is_unknown(self):
        assert rules.classify_smart_health(None).status is Status.UNKNOWN

    def test_any_pending_sector_is_critical(self):
        assert rules.classify_pending_sectors(1).status is Status.CRITICAL
        assert rules.classify_pending_sectors(0).status is Status.HEALTHY

    def test_pending_sectors_none_is_unknown(self):
        assert rules.classify_pending_sectors(None).status is Status.UNKNOWN

    def test_offline_uncorrectable_is_critical(self):
        assert rules.classify_offline_uncorrectable(3).status is Status.CRITICAL

    @pytest.mark.parametrize(
        "celsius,expected",
        [
            (38.0, Status.HEALTHY),
            (47.0, Status.INFO),
            (52.0, Status.WARNING),
            (58.0, Status.CRITICAL),
        ],
    )
    def test_temperature_bands(self, celsius, expected):
        assert rules.classify_disk_temperature(celsius).status is expected

    def test_temperature_missing_is_unknown(self):
        assert rules.classify_disk_temperature(None).status is Status.UNKNOWN

    def test_reallocated_increasing_is_warning(self):
        verdict = rules.classify_reallocated_delta(current=8, delta=8)
        assert verdict.status is Status.WARNING

    def test_reallocated_static_nonzero_is_info(self):
        verdict = rules.classify_reallocated_delta(current=8, delta=0)
        assert verdict.status is Status.INFO

    def test_reallocated_zero_is_healthy(self):
        verdict = rules.classify_reallocated_delta(current=0, delta=0)
        assert verdict.status is Status.HEALTHY


# ---------------------------------------------------------------------------
# Filesystems
# ---------------------------------------------------------------------------


class TestFilesystem:
    @pytest.mark.parametrize(
        "percent,expected",
        [
            (45.0, Status.HEALTHY),
            (78.0, Status.HEALTHY),
            (82.0, Status.WARNING),
            (91.0, Status.WARNING),
            (96.0, Status.CRITICAL),
        ],
    )
    def test_thresholds(self, percent, expected):
        assert rules.classify_filesystem(percent).status is expected

    def test_missing_usage_is_unknown(self):
        assert rules.classify_filesystem(None).status is Status.UNKNOWN

    def test_free_space_appears_in_detail(self):
        verdict = rules.classify_filesystem(78.0, free_bytes=5_400_000_000_000)
        assert "free" in verdict.detail

    def test_inode_pressure_warns(self):
        assert rules.classify_inodes(85.0).status is Status.WARNING
        assert rules.classify_inodes(12.0).status is Status.HEALTHY


# ---------------------------------------------------------------------------
# Host
# ---------------------------------------------------------------------------


class TestHost:
    def test_cpu_bands(self):
        assert rules.classify_cpu(12.0).status is Status.HEALTHY
        assert rules.classify_cpu(93.0).status is Status.WARNING
        assert rules.classify_cpu(99.0).status is Status.CRITICAL

    def test_cpu_not_yet_sampled_is_unknown(self):
        """The first render has no rate to report; that is not 0%."""
        assert rules.classify_cpu(None).status is Status.UNKNOWN

    def test_memory_judged_on_available(self):
        assert rules.classify_memory_available(88.0).status is Status.HEALTHY
        assert rules.classify_memory_available(8.0).status is Status.WARNING
        assert rules.classify_memory_available(3.0).status is Status.CRITICAL

    def test_load_is_relative_to_core_count(self):
        """Load 20 is fine on 24 cores and alarming on 4."""
        assert rules.classify_load(20.0, cpu_cores=24).status is Status.HEALTHY
        assert rules.classify_load(20.0, cpu_cores=4).status is Status.CRITICAL

    def test_iowait_bands(self):
        assert rules.classify_iowait(2.0).status is Status.HEALTHY
        assert rules.classify_iowait(25.0).status is Status.WARNING
        assert rules.classify_iowait(55.0).status is Status.CRITICAL

    def test_failed_units_named_in_detail(self):
        class Unit:
            def __init__(self, name):
                self.name = name

        verdict = rules.classify_failed_units([Unit("backup-nightly.service")])
        assert verdict.status is Status.WARNING
        assert "backup-nightly.service" in verdict.detail

    def test_no_failed_units_is_healthy(self):
        assert rules.classify_failed_units([]).status is Status.HEALTHY

    def test_systemd_unreachable_is_unknown(self):
        assert rules.classify_failed_units(None).status is Status.UNKNOWN


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------


class TestInternet:
    def test_healthy_connection(self):
        verdict = rules.classify_internet(True, 18.0, 0.0)
        assert verdict.status is Status.HEALTHY

    def test_packet_loss_bands(self):
        assert rules.classify_internet(True, 20.0, 8.0).status is Status.WARNING
        assert rules.classify_internet(True, 20.0, 30.0).status is Status.CRITICAL

    def test_latency_bands(self):
        assert rules.classify_internet(True, 150.0, 0.0).status is Status.WARNING
        assert rules.classify_internet(True, 400.0, 0.0).status is Status.CRITICAL

    def test_brief_outage_is_warning_not_critical(self):
        """A single failed probe should not read as a full outage."""
        verdict = rules.classify_internet(False, None, None, down_since=time.time() - 30)
        assert verdict.status is Status.WARNING

    def test_sustained_outage_is_critical(self):
        verdict = rules.classify_internet(
            False, None, None, down_since=time.time() - 600
        )
        assert verdict.status is Status.CRITICAL

    def test_untestable_is_unknown(self):
        assert rules.classify_internet(None, None, None).status is Status.UNKNOWN


# ---------------------------------------------------------------------------
# VPN and leak detection
# ---------------------------------------------------------------------------


class TestVpnLeak:
    def test_different_ips_pass(self):
        leak = check_leak("187.13.209.146", "111.118.194.91")
        assert leak.passed is True
        assert rules.classify_leak(leak).status is Status.HEALTHY

    def test_matching_ips_are_critical(self):
        """The core safety check: identical IPs mean traffic bypassed the VPN."""
        leak = check_leak("111.118.194.91", "111.118.194.91")
        assert leak.passed is False
        verdict = rules.classify_leak(leak)
        assert verdict.status is Status.CRITICAL
        assert "LEAK" in verdict.detail

    def test_missing_vpn_ip_is_inconclusive_not_pass(self):
        """An unverifiable safety claim must never render as PASS."""
        leak = check_leak(None, "111.118.194.91")
        assert leak.passed is None
        assert rules.classify_leak(leak).status is Status.UNKNOWN

    def test_missing_wan_ip_is_inconclusive(self):
        leak = check_leak("187.13.209.146", None)
        assert leak.passed is None
        assert rules.classify_leak(leak).status is Status.UNKNOWN

    def test_both_missing_is_inconclusive(self):
        leak = check_leak(None, None)
        assert leak.passed is None

    def test_no_leak_check_at_all_is_unknown(self):
        assert rules.classify_leak(None).status is Status.UNKNOWN


class TestVpnStatus:
    def _status(self, **overrides):
        from services.vpn import VpnStatus

        defaults = dict(
            container_present=True,
            container_running=True,
            container_healthy=True,
            tunnel_up=True,
            public_ip="187.13.209.146",
            dns_ok=True,
            https_ok=True,
            provider="nordvpn",
        )
        defaults.update(overrides)
        return VpnStatus(**defaults)

    def test_healthy_tunnel(self):
        assert rules.classify_vpn(self._status()).status is Status.HEALTHY

    def test_missing_container_is_critical(self):
        verdict = rules.classify_vpn(self._status(container_present=False))
        assert verdict.status is Status.CRITICAL

    def test_stopped_container_is_critical(self):
        verdict = rules.classify_vpn(self._status(container_running=False))
        assert verdict.status is Status.CRITICAL

    def test_dns_failure_is_critical_and_named(self):
        """The 9 Aug 2026 failure mode: container up, DNS dead."""
        verdict = rules.classify_vpn(
            self._status(dns_ok=False, tunnel_up=False, error="VPN authentication failure")
        )
        assert verdict.status is Status.CRITICAL
        assert "DNS" in verdict.detail
        assert "authentication" in verdict.detail

    def test_auth_failure_count_surfaces(self):
        verdict = rules.classify_vpn(
            self._status(tunnel_up=False, auth_failures=7, error="VPN authentication failure")
        )
        assert "7 AUTH_FAILED" in verdict.detail


class TestVpnLogAnalysis:
    def test_auth_failed_identified(self):
        from services.vpn import analyse_logs

        logs = [
            "2026-08-09 10:00:00 AUTH: Received control message: AUTH_FAILED",
            "2026-08-09 10:00:01 SIGUSR1[soft,auth-failure] received, restarting",
        ]
        cause, recommendation, auth_failures, reconnects, errors = analyse_logs(logs)
        assert "authentication" in cause.lower()
        assert auth_failures == 1
        assert reconnects >= 1
        assert recommendation

    def test_clean_logs_yield_no_cause(self):
        from services.vpn import analyse_logs

        cause, _, auth_failures, _, _ = analyse_logs(
            ["2026-08-13 10:00:00 Initialization Sequence Completed"]
        )
        assert cause == ""
        assert auth_failures == 0


# ---------------------------------------------------------------------------
# Containers
# ---------------------------------------------------------------------------


class TestContainers:
    class FakeContainer:
        def __init__(self, running=True, health="healthy", uptime=100000, state="running"):
            self.running = running
            self.health = health
            self.state = state
            self.uptime_seconds = uptime

        @property
        def healthy(self):
            if self.health is None:
                return None
            return self.health == "healthy"

    def test_missing_critical_container(self):
        verdict = rules.classify_container(None, expected_critical=True)
        assert verdict.status is Status.CRITICAL

    def test_missing_optional_container_is_warning(self):
        verdict = rules.classify_container(None, expected_critical=False)
        assert verdict.status is Status.WARNING

    def test_running_and_healthy(self):
        verdict = rules.classify_container(self.FakeContainer())
        assert verdict.status is Status.HEALTHY

    def test_unhealthy_healthcheck_is_critical(self):
        verdict = rules.classify_container(self.FakeContainer(health="unhealthy"))
        assert verdict.status is Status.CRITICAL

    def test_stopped_container(self):
        verdict = rules.classify_container(
            self.FakeContainer(running=False, state="exited")
        )
        assert verdict.status is Status.CRITICAL

    def test_restart_loop_is_critical(self):
        verdict = rules.classify_container(self.FakeContainer(), restart_delta=5)
        assert verdict.status is Status.CRITICAL

    def test_single_restart_is_warning(self):
        verdict = rules.classify_container(self.FakeContainer(), restart_delta=1)
        assert verdict.status is Status.WARNING

    def test_recently_started_is_info(self):
        verdict = rules.classify_container(self.FakeContainer(uptime=60))
        assert verdict.status is Status.INFO

    def test_container_without_healthcheck_still_healthy(self):
        verdict = rules.classify_container(self.FakeContainer(health=None))
        assert verdict.status is Status.HEALTHY


# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------


class TestBackups:
    def test_fresh_backup_is_healthy(self):
        verdict = rules.classify_backup_age(1.0, expected_interval_days=3.5)
        assert verdict.status is Status.HEALTHY

    def test_overdue_backup_is_warning(self):
        """The live host's sports backup was 4 days old with a missed Wed run."""
        verdict = rules.classify_backup_age(4.5, expected_interval_days=3.5)
        assert verdict.status is Status.WARNING

    def test_very_old_backup_is_critical(self):
        verdict = rules.classify_backup_age(9.0, expected_interval_days=3.5)
        assert verdict.status is Status.CRITICAL

    def test_daily_job_two_days_late_warns_despite_absolute_window(self):
        """A daily job at 2.5 days is late even though 4 days is the hard limit."""
        verdict = rules.classify_backup_age(2.5, expected_interval_days=1.0)
        assert verdict.status is Status.WARNING

    def test_no_backup_at_all_is_critical(self):
        verdict = rules.classify_backup_age(None, expected_interval_days=3.5)
        assert verdict.status is Status.CRITICAL
        assert "never" in verdict.detail.lower() or "No backup" in verdict.detail

    def test_unverified_integrity_is_unknown_not_healthy(self):
        verdict = rules.classify_backup_integrity(None)
        assert verdict.status is Status.UNKNOWN
        assert "not proof" in verdict.detail.lower()

    def test_failed_integrity_is_critical(self):
        verdict = rules.classify_backup_integrity(False, "unexpected end of file")
        assert verdict.status is Status.CRITICAL

    def test_verified_integrity_is_healthy(self):
        verdict = rules.classify_backup_integrity(True, "ok")
        assert verdict.status is Status.HEALTHY


# ---------------------------------------------------------------------------
# Probes and freshness
# ---------------------------------------------------------------------------


class TestProbes:
    def _result(self, **overrides):
        from services.probes import ProbeResult

        defaults = dict(
            key="plex",
            display="Plex",
            url="http://10.0.40.100:32400/identity",
            success=True,
            latency_ms=25.0,
            status_code=200,
        )
        defaults.update(overrides)
        return ProbeResult(**defaults)

    def test_successful_probe(self):
        assert rules.classify_probe(self._result()).status is Status.HEALTHY

    def test_failed_critical_probe(self):
        verdict = rules.classify_probe(
            self._result(success=False, failed_stage="tcp", error="refused"),
            critical=True,
        )
        assert verdict.status is Status.CRITICAL

    def test_failed_non_critical_probe_is_warning(self):
        verdict = rules.classify_probe(
            self._result(success=False, failed_stage="tcp", error="refused"),
            critical=False,
        )
        assert verdict.status is Status.WARNING

    def test_dns_failure_is_named_distinctly(self):
        verdict = rules.classify_probe(
            self._result(success=False, failed_stage="dns", error="NXDOMAIN")
        )
        assert "DNS" in verdict.detail

    def test_slow_response_warns(self):
        verdict = rules.classify_probe(self._result(latency_ms=3000.0))
        assert verdict.status is Status.WARNING

    def test_unprobed_service_is_unknown(self):
        assert rules.classify_probe(None).status is Status.UNKNOWN


class TestFreshness:
    def test_current_data(self):
        assert rules.classify_freshness(30, 180).status is Status.HEALTHY

    def test_stale_data_is_unknown_not_healthy(self):
        """Stale telemetry must never keep showing its last healthy value."""
        verdict = rules.classify_freshness(600, 180)
        assert verdict.status is Status.UNKNOWN
        assert "STALE" in verdict.detail

    def test_no_timestamp_is_unknown(self):
        assert rules.classify_freshness(None, 180).status is Status.UNKNOWN


class TestTls:
    def test_healthy_certificate(self):
        assert rules.classify_tls_expiry(120).status is Status.HEALTHY

    def test_expiring_soon_is_critical(self):
        assert rules.classify_tls_expiry(3).status is Status.CRITICAL

    def test_expired_is_critical(self):
        assert rules.classify_tls_expiry(-1).status is Status.CRITICAL

    def test_no_certificate_is_unknown(self):
        assert rules.classify_tls_expiry(None).status is Status.UNKNOWN
