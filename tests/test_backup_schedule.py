"""Tests for backup discovery and schedule-aware missed-run detection.

Motivated by a real failure on the live host: the Wednesday 12 Aug 2026 run of
the twice-weekly sports backup produced no output, but the most recent archive
was still only ~3.9 days old — inside the 4-day age warning. Age alone would
not have flagged it for another day. Detecting the *missed run* catches it
immediately.
"""

from __future__ import annotations

import time
from datetime import datetime

import pytest

from core.status import Status
from health import rules
from services.backups import (
    BackupFile,
    BackupStatus,
    check_missed_run,
    next_expected_run,
    scan_backup_directory,
)

DAY = 86400.0


def _at(year, month, day, hour=12, minute=0) -> float:
    return datetime(year, month, day, hour, minute).timestamp()


class TestNextExpectedRun:
    def test_twice_weekly_schedule(self):
        """Sun+Wed 23:00. On Thursday morning, the last run was Wednesday."""
        now = _at(2026, 8, 13, 11, 0)  # Thursday
        expected = next_expected_run((0, 3), hour=23, now=now)
        assert expected is not None
        assert datetime.fromtimestamp(expected).strftime("%a %d %H:%M") == "Wed 12 23:00"

    def test_before_todays_run_falls_back_to_previous(self):
        """At 10:00 Wednesday, the 23:00 run has not happened yet."""
        now = _at(2026, 8, 12, 10, 0)  # Wednesday morning
        expected = next_expected_run((0, 3), hour=23, now=now)
        assert datetime.fromtimestamp(expected).strftime("%a %d %H:%M") == "Sun 09 23:00"

    def test_after_todays_run(self):
        now = _at(2026, 8, 12, 23, 30)
        expected = next_expected_run((0, 3), hour=23, now=now)
        assert datetime.fromtimestamp(expected).strftime("%a %d %H:%M") == "Wed 12 23:00"

    def test_daily_schedule(self):
        now = _at(2026, 8, 13, 11, 0)
        expected = next_expected_run(tuple(range(7)), hour=2, now=now)
        assert datetime.fromtimestamp(expected).strftime("%a %d %H:%M") == "Thu 13 02:00"

    def test_no_weekdays_returns_none(self):
        assert next_expected_run((), hour=2) is None


class TestMissedRun:
    def _status(self, latest_at: float | None) -> BackupStatus:
        status = BackupStatus(
            key="sports", display="Sports", directory="/tmp", schedule="Sun+Wed 23:00"
        )
        if latest_at is not None:
            status.latest = BackupFile("/tmp/b.tar.gz", 2_000_000_000, latest_at)
        return status

    def test_missed_wednesday_run_is_detected(self):
        """The live 13 Aug 2026 case: last backup Sunday, Wednesday skipped."""
        now = _at(2026, 8, 13, 11, 0)
        status = self._status(_at(2026, 8, 9, 14, 23))
        missed = check_missed_run(status, (0, 3), 23, now=now)
        assert missed is not None
        assert datetime.fromtimestamp(missed).strftime("%a") == "Wed"

    def test_run_that_produced_output_is_not_missed(self):
        now = _at(2026, 8, 13, 11, 0)
        status = self._status(_at(2026, 8, 12, 23, 8))
        assert check_missed_run(status, (0, 3), 23, now=now) is None

    def test_grace_window_tolerates_a_long_running_job(self):
        """At 00:30, a job that started at 23:00 may still be writing."""
        now = _at(2026, 8, 13, 0, 30)
        status = self._status(_at(2026, 8, 9, 14, 23))
        assert check_missed_run(status, (0, 3), 23, grace_hours=3.0, now=now) is None

    def test_no_backup_at_all_counts_as_missed(self):
        now = _at(2026, 8, 13, 11, 0)
        assert check_missed_run(self._status(None), (0, 3), 23, now=now) is not None

    def test_daily_job_missing_this_mornings_run(self):
        now = _at(2026, 8, 13, 11, 0)
        status = self._status(_at(2026, 8, 12, 2, 5))
        missed = check_missed_run(status, tuple(range(7)), 2, now=now)
        assert missed is not None


class TestMissedRunRule:
    def test_missed_run_is_a_warning(self):
        verdict = rules.classify_missed_run(
            _at(2026, 8, 12, 23, 0), "Sun+Wed 23:00", age_days=3.9
        )
        assert verdict.status is Status.WARNING
        assert "missed" in verdict.detail.lower()

    def test_no_missed_run_is_healthy(self):
        verdict = rules.classify_missed_run(None, "Sun+Wed 23:00", age_days=0.5)
        assert verdict.status is Status.HEALTHY

    def test_detail_names_the_missed_occurrence(self):
        verdict = rules.classify_missed_run(
            _at(2026, 8, 12, 23, 0), "Sun+Wed 23:00", age_days=3.9
        )
        assert "Wed 12 Aug" in verdict.detail

    def test_missing_backup_is_described_distinctly(self):
        verdict = rules.classify_missed_run(
            _at(2026, 8, 12, 23, 0), "Sun+Wed 23:00", age_days=None
        )
        assert "No backup exists" in verdict.detail


class TestBackupDiscovery:
    def test_finds_archive_files(self, tmp_path):
        archive = tmp_path / "sports_data_2026-08-09.tar.gz"
        archive.write_bytes(b"x" * 2048)
        status = scan_backup_directory(
            "k", "Job", str(tmp_path), pattern="*.tar.gz", min_plausible_bytes=1024
        )
        assert status.latest is not None
        assert status.retained_count == 1
        assert status.entry_kind == "file"

    def test_finds_directory_per_run_backups(self, tmp_path):
        """The nightly job writes dated directories, not archives.

        Treating only files as backups reported a working job as 'no backup
        found at all' on the live host.
        """
        for day in ("2026-08-11_02-00-01", "2026-08-12_02-00-01"):
            run = tmp_path / day
            run.mkdir()
            (run / "etc.tar.gz").write_bytes(b"y" * 4096)
        status = scan_backup_directory("k", "Nightly", str(tmp_path), pattern="*")
        assert status.latest is not None
        assert status.retained_count == 2
        assert status.entry_kind == "directory"

    def test_directory_sizes_are_not_walked_during_the_scan(self, tmp_path):
        """Walking the trees cost 2+ minutes on the live host — far too slow."""
        run = tmp_path / "2026-08-12_02-00-01"
        run.mkdir()
        (run / "big.tar.gz").write_bytes(b"y" * 8192)
        status = scan_backup_directory("k", "Nightly", str(tmp_path), pattern="*")
        assert status.latest.size_known is False
        # Unknown size must never be judged as an implausibly small backup.
        assert status.size_suspicious is False

    def test_unknown_size_is_not_reported_as_a_shrink(self, tmp_path):
        for day in ("2026-08-11_02-00-01", "2026-08-12_02-00-01"):
            (tmp_path / day).mkdir()
        status = scan_backup_directory("k", "Nightly", str(tmp_path), pattern="*")
        assert status.growth_bytes is None
        verdict = rules.classify_backup_size(status)
        assert verdict.status is Status.INFO

    def test_measure_directory_size_on_demand(self, tmp_path):
        from services.backups import measure_directory_size

        run = tmp_path / "run"
        run.mkdir()
        (run / "a.bin").write_bytes(b"x" * 1000)
        (run / "b.bin").write_bytes(b"x" * 2000)
        measured, complete = measure_directory_size(str(run))
        assert measured == 3000
        assert complete is True

    def test_measure_directory_size_reports_incomplete_when_capped(self, tmp_path):
        from services.backups import measure_directory_size

        run = tmp_path / "run"
        run.mkdir()
        for index in range(10):
            (run / f"f{index}.bin").write_bytes(b"x" * 100)
        measured, complete = measure_directory_size(str(run), max_entries=3)
        assert complete is False
        assert measured < 1000

    def test_archives_take_precedence_over_directories(self, tmp_path):
        (tmp_path / "run-dir").mkdir()
        archive = tmp_path / "backup.tar.gz"
        archive.write_bytes(b"z" * 1024)
        status = scan_backup_directory("k", "Job", str(tmp_path), pattern="*.tar.gz")
        assert status.entry_kind == "file"
        assert status.latest.path.endswith("backup.tar.gz")

    def test_log_files_are_not_treated_as_backups(self, tmp_path):
        (tmp_path / "backup.log").write_text("done")
        status = scan_backup_directory("k", "Job", str(tmp_path), pattern="*")
        assert status.latest is None
        assert "No files matching" in status.error

    def test_missing_directory_is_reported(self, tmp_path):
        status = scan_backup_directory("k", "Job", str(tmp_path / "nope"))
        assert status.latest is None
        assert "does not exist" in status.error

    def test_size_shrink_is_detected(self, tmp_path):
        import os

        big = tmp_path / "a.tar.gz"
        big.write_bytes(b"x" * 10000)
        os.utime(big, (time.time() - DAY, time.time() - DAY))
        small = tmp_path / "b.tar.gz"
        small.write_bytes(b"x" * 1000)
        status = scan_backup_directory("k", "Job", str(tmp_path), pattern="*.tar.gz")
        assert status.growth_bytes == -9000
        verdict = rules.classify_backup_size(status)
        assert verdict.status is Status.WARNING


class TestOptionalReadingsDoNotDragTheScore:
    def test_optional_not_configured_is_excluded(self):
        """An undeployed optional exporter must not peg a component at UNKNOWN.

        Otherwise the score can never reach 100 and stops carrying information.
        """
        from core.status import Reading
        from health.scoring import score_component

        readings = [
            Reading(key="a", label="a", value=1, status=Status.HEALTHY),
            Reading.not_configured("unifi", "UniFi", "not deployed", optional=True),
        ]
        component = score_component("network", "Network", readings, weight=15)
        assert component.status is Status.HEALTHY
        assert component.score == pytest.approx(1.0)

    def test_non_optional_not_configured_still_counts(self):
        """Missing SMART data hides real risk, so it must still register."""
        from core.status import Reading
        from health.scoring import score_component

        readings = [
            Reading(key="a", label="a", value=1, status=Status.HEALTHY),
            Reading.not_configured("disk.smart", "SMART", "needs root"),
        ]
        component = score_component("raid_disks", "RAID", readings, weight=25)
        assert component.status is Status.UNKNOWN

    def test_optional_readings_are_still_displayed(self):
        from core.status import Reading

        reading = Reading.not_configured("unifi", "UniFi", "x", optional=True)
        assert reading.display_value == "NOT CONFIGURED"
