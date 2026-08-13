"""Tests for parsers, scoring and alert correlation.

The mdstat and ping parsers are exercised against output captured from the real
host, including the degraded state recorded during the 11 Aug 2026 incident, so
the degraded-array path is tested without needing to break a live array.
"""

from __future__ import annotations

import pytest

from core.status import Alert, Reading, Status, worst
from health.correlation import correlate
from health.scoring import calculate_health_score, score_component
from services.network import parse_ping
from services.system import parse_mdstat

# ---------------------------------------------------------------------------
# /proc/mdstat parsing
# ---------------------------------------------------------------------------

HEALTHY_MDSTAT = """Personalities : [raid6] [raid5] [raid4] [raid0] [raid1] [raid10]
md127 : active raid5 sde[4] sdb[5] sda[0] sdc[2]
      23441682432 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]
      bitmap: 1/59 pages [4KB], 65536KB chunk

unused devices: <none>
"""

DEGRADED_MDSTAT = """Personalities : [raid6] [raid5] [raid4]
md127 : active raid5 sdb[5] sda[0] sdc[2]
      23441682432 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/3] [UU_U]
      bitmap: 1/59 pages [4KB], 65536KB chunk

unused devices: <none>
"""

REBUILDING_MDSTAT = """Personalities : [raid5]
md127 : active raid5 sde[4] sdb[5] sda[0] sdc[2]
      23441682432 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/3] [UU_U]
      [==>..................]  recovery = 12.7% (992256/7813894144) finish=46.8min speed=175129K/sec
      bitmap: 1/59 pages [4KB], 65536KB chunk

unused devices: <none>
"""

FAILED_MEMBER_MDSTAT = """Personalities : [raid5]
md127 : active raid5 sde[4](F) sdb[5] sda[0] sdc[2]
      23441682432 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/3] [UU_U]

unused devices: <none>
"""


class TestMdstatParsing:
    def test_healthy_array(self):
        arrays = parse_mdstat(HEALTHY_MDSTAT)
        assert len(arrays) == 1
        array = arrays[0]
        assert array.device == "md127"
        assert array.active is True
        assert array.level == "raid5"
        assert array.disks_active == 4
        assert array.disks_required == 4
        assert array.state_string == "UUUU"
        assert array.degraded is False
        assert set(array.members) == {"sda", "sdb", "sdc", "sde"}

    def test_degraded_array(self):
        array = parse_mdstat(DEGRADED_MDSTAT)[0]
        assert array.disks_active == 3
        assert array.disks_required == 4
        assert array.degraded is True
        assert array.state_string == "UU_U"

    def test_rebuilding_array(self):
        array = parse_mdstat(REBUILDING_MDSTAT)[0]
        assert array.sync_action == "recovery"
        assert array.sync_percent == pytest.approx(12.7)
        assert array.sync_speed_kbps == pytest.approx(175129.0)
        assert array.sync_finish_minutes == pytest.approx(46.8)
        assert array.resyncing is True

    def test_failed_member_flagged(self):
        array = parse_mdstat(FAILED_MEMBER_MDSTAT)[0]
        assert "sde" in array.failed_members

    def test_no_arrays(self):
        assert parse_mdstat("Personalities : [raid5]\nunused devices: <none>\n") == []

    def test_healthy_state_string_is_all_up(self):
        array = parse_mdstat(HEALTHY_MDSTAT)[0]
        assert set(array.state_string) == {"U"}


# ---------------------------------------------------------------------------
# ping parsing
# ---------------------------------------------------------------------------

PING_OK = """PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.

--- 1.1.1.1 ping statistics ---
5 packets transmitted, 5 received, 0% packet loss, time 1204ms
rtt min/avg/max/mdev = 16.204/18.336/21.045/1.712 ms
"""

PING_LOSS = """--- 1.1.1.1 ping statistics ---
10 packets transmitted, 7 received, 30% packet loss, time 9123ms
rtt min/avg/max/mdev = 22.104/45.336/91.045/18.712 ms
"""

PING_DOWN = """--- 1.1.1.1 ping statistics ---
5 packets transmitted, 0 received, 100% packet loss, time 4098ms
"""


class TestPingParsing:
    def test_healthy(self):
        result = parse_ping(PING_OK, "1.1.1.1")
        assert result.packets_sent == 5
        assert result.packets_received == 5
        assert result.packet_loss_percent == pytest.approx(0.0)
        assert result.latency_ms == pytest.approx(18.336)
        assert result.reachable is True

    def test_partial_loss(self):
        result = parse_ping(PING_LOSS, "1.1.1.1")
        assert result.packet_loss_percent == pytest.approx(30.0)
        assert result.reachable is True

    def test_total_loss_has_no_latency(self):
        """No reply means latency is unknown, not zero."""
        result = parse_ping(PING_DOWN, "1.1.1.1")
        assert result.packet_loss_percent == pytest.approx(100.0)
        assert result.latency_ms is None
        assert result.reachable is False

    def test_unparseable_output(self):
        result = parse_ping("command not found", "1.1.1.1")
        assert result.packets_sent == 0
        assert result.latency_ms is None


# ---------------------------------------------------------------------------
# Status aggregation
# ---------------------------------------------------------------------------


class TestStatusOrdering:
    def test_worst_selects_critical(self):
        assert worst([Status.HEALTHY, Status.WARNING, Status.CRITICAL]) is Status.CRITICAL

    def test_unknown_outranks_healthy(self):
        """Not knowing is worse than knowing it is fine."""
        assert worst([Status.HEALTHY, Status.UNKNOWN]) is Status.UNKNOWN

    def test_warning_outranks_unknown(self):
        assert worst([Status.UNKNOWN, Status.WARNING]) is Status.WARNING

    def test_empty_is_healthy(self):
        assert worst([]) is Status.HEALTHY


class TestReadingDisplay:
    def test_not_configured_never_shows_a_number(self):
        reading = Reading.not_configured("k", "Label", "not set up")
        assert reading.display_value == "NOT CONFIGURED"
        assert reading.status is Status.UNKNOWN

    def test_no_data_is_distinct_from_zero(self):
        reading = Reading.no_data("k", "Label")
        assert reading.display_value == "NO DATA"
        assert reading.has_value is False

    def test_zero_is_a_real_value(self):
        reading = Reading(key="k", label="L", value=0, status=Status.HEALTHY)
        assert reading.display_value == "0"
        assert reading.has_value is True

    def test_stale_downgrades_to_unknown(self):
        import time

        reading = Reading(
            key="k",
            label="L",
            value=5,
            status=Status.HEALTHY,
            collected_at=time.time() - 600,
        )
        reading.stale_after(120)
        assert reading.status is Status.UNKNOWN
        assert "old" in reading.detail


# ---------------------------------------------------------------------------
# Health scoring
# ---------------------------------------------------------------------------


def _component(key, label, status, weight):
    reading = Reading(key=f"{key}.r", label=label, value=1, status=status)
    return score_component(key, label, [reading], weight=weight)


class TestHealthScore:
    def test_all_healthy_scores_100(self):
        components = [
            _component("raid_disks", "RAID", Status.HEALTHY, 25),
            _component("server", "Server", Status.HEALTHY, 15),
            _component("network", "Network", Status.HEALTHY, 15),
        ]
        score = calculate_health_score(components)
        assert score.score == pytest.approx(100.0)
        assert score.status is Status.HEALTHY

    def test_critical_component_forces_critical_status(self):
        """A degraded RAID must never present as a reassuring overall state."""
        components = [
            _component("raid_disks", "RAID", Status.CRITICAL, 25),
            _component("server", "Server", Status.HEALTHY, 15),
            _component("network", "Network", Status.HEALTHY, 15),
            _component("vpn", "VPN", Status.HEALTHY, 10),
            _component("storage", "Storage", Status.HEALTHY, 10),
            _component("applications", "Apps", Status.HEALTHY, 10),
            _component("backups", "Backups", Status.HEALTHY, 10),
            _component("security", "Security", Status.HEALTHY, 5),
        ]
        score = calculate_health_score(components)
        assert score.status is Status.CRITICAL
        assert "RAID" in score.reason

    def test_critical_clamps_the_score_below_the_healthy_band(self):
        """Everything else perfect must still not produce a comfortable number."""
        components = [
            _component("raid_disks", "RAID", Status.CRITICAL, 25),
        ] + [
            _component(key, key, Status.HEALTHY, weight)
            for key, weight in (
                ("server", 15), ("network", 15), ("vpn", 10), ("storage", 10),
                ("applications", 10), ("backups", 10), ("security", 5),
            )
        ]
        score = calculate_health_score(components)
        assert score.score <= 84.0
        assert score.status is Status.CRITICAL

    def test_warning_caps_score(self):
        components = [
            _component("storage", "Storage", Status.WARNING, 10),
            _component("raid_disks", "RAID", Status.HEALTHY, 25),
        ]
        score = calculate_health_score(components)
        assert score.score <= 94.0
        assert score.status is Status.WARNING

    def test_unknown_component_prevents_a_healthy_verdict(self):
        components = [
            _component("raid_disks", "RAID", Status.UNKNOWN, 25),
            _component("server", "Server", Status.HEALTHY, 15),
        ]
        score = calculate_health_score(components)
        assert score.status is Status.UNKNOWN

    def test_no_components_is_unknown(self):
        score = calculate_health_score([])
        assert score.status is Status.UNKNOWN
        assert score.score == 0.0

    def test_component_status_is_worst_of_its_readings(self):
        """One failing disk must not be averaged away by three healthy ones."""
        readings = [
            Reading(key="a", label="a", value=1, status=Status.HEALTHY),
            Reading(key="b", label="b", value=1, status=Status.HEALTHY),
            Reading(key="c", label="c", value=1, status=Status.HEALTHY),
            Reading(key="d", label="d", value=1, status=Status.CRITICAL),
        ]
        component = score_component("raid_disks", "RAID", readings, weight=25)
        assert component.status is Status.CRITICAL
        assert 0.0 < component.score < 1.0

    def test_counts_are_reported(self):
        components = [
            _component("a", "A", Status.CRITICAL, 10),
            _component("b", "B", Status.WARNING, 10),
            _component("c", "C", Status.UNKNOWN, 10),
        ]
        score = calculate_health_score(components)
        assert score.critical_count == 1
        assert score.warning_count == 1
        assert score.unknown_count == 1


# ---------------------------------------------------------------------------
# Alert correlation
# ---------------------------------------------------------------------------


def _alert(key, status=Status.CRITICAL, title=None):
    return Alert(key=key, status=status, title=title or key, component=key)


class TestCorrelation:
    def test_gluetun_failure_absorbs_dependent_services(self):
        """Three symptoms of one Gluetun failure should read as one incident."""
        alerts = [
            _alert("vpn.gluetun", title="Gluetun VPN unhealthy"),
            _alert("probe.prowlarr", title="Prowlarr not responding"),
            _alert("probe.sonarr", title="Sonarr not responding"),
            _alert("probe.sabnzbd", title="SABnzbd not responding"),
        ]
        incidents, uncorrelated = correlate(alerts)
        assert len(incidents) == 1
        assert incidents[0].cause.key == "vpn.gluetun"
        assert len(incidents[0].effects) == 3
        assert uncorrelated == []

    def test_effects_are_marked_with_their_cause(self):
        alerts = [
            _alert("vpn.gluetun"),
            _alert("probe.prowlarr"),
        ]
        correlate(alerts)
        prowlarr = next(a for a in alerts if a.key == "probe.prowlarr")
        assert prowlarr.caused_by == "vpn.gluetun"

    def test_healthy_cause_does_not_absorb_unrelated_alerts(self):
        """A working Gluetun must not swallow an independent Sonarr failure."""
        alerts = [
            _alert("vpn.gluetun", status=Status.HEALTHY),
            _alert("probe.sonarr"),
        ]
        incidents, uncorrelated = correlate(alerts)
        assert incidents == []
        assert len(uncorrelated) == 2

    def test_no_effects_means_no_incident(self):
        alerts = [_alert("vpn.gluetun")]
        incidents, uncorrelated = correlate(alerts)
        assert incidents == []
        assert len(uncorrelated) == 1

    def test_unrelated_alerts_stay_uncorrelated(self):
        alerts = [
            _alert("backup.sports_data_lab", status=Status.WARNING),
            _alert("disk.WPV2E6LL.crc", status=Status.WARNING),
        ]
        incidents, uncorrelated = correlate(alerts)
        assert incidents == []
        assert len(uncorrelated) == 2

    def test_raid_fault_absorbs_media_filesystem(self):
        alerts = [
            _alert("raid.md127", title="RAID degraded"),
            _alert("storage./mnt/media", title="/mnt/media unavailable"),
        ]
        incidents, _ = correlate(alerts)
        assert len(incidents) == 1
        assert incidents[0].cause.key == "raid.md127"

    def test_an_alert_is_only_claimed_once(self):
        alerts = [
            _alert("network.internet", title="Internet down"),
            _alert("vpn.gluetun", title="Gluetun unhealthy"),
            _alert("probe.prowlarr", title="Prowlarr down"),
        ]
        incidents, uncorrelated = correlate(alerts)
        claimed = [e.key for incident in incidents for e in incident.effects]
        assert len(claimed) == len(set(claimed))
