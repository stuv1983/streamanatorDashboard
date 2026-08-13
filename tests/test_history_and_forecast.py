"""Tests for the history store, deltas, forecasting and change detection.

The delta and forecast logic is what turns raw counters into the "is it moving?"
answer the dashboard is built around, so its edge cases — no history, partial
history, noisy data — are covered explicitly.
"""

from __future__ import annotations

import time

import pytest

from core.history import HistoryStore
from health.forecast import forecast_capacity, linear_fit, project_threshold_date

DAY = 86400.0


@pytest.fixture()
def store(tmp_path):
    return HistoryStore(tmp_path / "history.sqlite3", retention_days=400)


# ---------------------------------------------------------------------------
# History store
# ---------------------------------------------------------------------------


class TestHistoryStore:
    def test_record_and_latest(self, store):
        store.record("test.metric", 42.0)
        latest = store.latest("test.metric")
        assert latest is not None
        assert latest[1] == 42.0

    def test_none_values_are_dropped_not_stored_as_zero(self, store):
        """Missing data must never become a measurement of zero."""
        store.record("test.metric", None)
        assert store.latest("test.metric") is None

    def test_labels_separate_series(self, store):
        store.record("smart.crc", 100.0, {"serial": "A"})
        store.record("smart.crc", 200.0, {"serial": "B"})
        assert store.latest("smart.crc", {"serial": "A"})[1] == 100.0
        assert store.latest("smart.crc", {"serial": "B"})[1] == 200.0

    def test_delta_with_no_history_is_none(self, store):
        """One sample cannot produce a delta — that is 'unknown', not zero."""
        store.record("smart.crc", 5670.0)
        assert store.delta("smart.crc", 86400) is None

    def test_delta_across_window(self, store):
        now = time.time()
        store.record("smart.crc", 5670.0, ts=now - 2 * DAY)
        store.record("smart.crc", 5684.0, ts=now)
        assert store.delta("smart.crc", DAY) == pytest.approx(14.0)

    def test_delta_of_zero_is_distinct_from_none(self, store):
        """'+0' means compared and unchanged; None means never compared."""
        now = time.time()
        store.record("smart.crc", 5670.0, ts=now - 2 * DAY)
        store.record("smart.crc", 5670.0, ts=now)
        assert store.delta("smart.crc", DAY) == 0.0

    def test_delta_refuses_windows_far_beyond_history(self, store):
        """A 30-day delta from 2 days of data would understate the change."""
        now = time.time()
        store.record("smart.crc", 5670.0, ts=now - 2 * DAY)
        store.record("smart.crc", 5684.0, ts=now)
        assert store.delta("smart.crc", 30 * DAY) is None

    def test_delta_tolerance_allows_slightly_short_history(self, store):
        """5.5 days of history still answers a 7-day window within tolerance."""
        now = time.time()
        store.record("smart.crc", 100.0, ts=now - 5.5 * DAY)
        store.record("smart.crc", 130.0, ts=now)
        assert store.delta("smart.crc", 7 * DAY) == pytest.approx(30.0)

    def test_coverage_reports_history_span(self, store):
        now = time.time()
        store.record("m", 1.0, ts=now - 3 * DAY)
        store.record("m", 2.0, ts=now)
        assert store.coverage_seconds("m") == pytest.approx(3 * DAY, rel=0.01)

    def test_series_respects_window(self, store):
        now = time.time()
        store.record("m", 1.0, ts=now - 10 * DAY)
        store.record("m", 2.0, ts=now - 1 * DAY)
        recent = store.series("m", since=now - 2 * DAY)
        assert len(recent) == 1

    def test_prune_removes_old_samples(self, store):
        now = time.time()
        store.record("m", 1.0, ts=now - 500 * DAY)
        store.record("m", 2.0, ts=now)
        store.prune()
        assert len(store.series("m")) == 1

    def test_record_many_batches(self, store):
        store.record_many(
            [("a", None, 1.0), ("b", {"x": "y"}, 2.0), ("c", None, None)]
        )
        assert store.latest("a") is not None
        assert store.latest("b", {"x": "y"}) is not None
        assert store.latest("c") is None


class TestStoreSurvivesFileLoss:
    """The database file can vanish under a running process — a cleaned `var/`,
    a redeploy that swaps the checkout. The store is a cached resource for the
    life of the process, so it has to recover on its own rather than raise
    "no such table: samples" at every page render from then on.
    """

    def test_write_recreates_a_dropped_schema(self, store):
        store.record("m", 1.0)
        store._connection().executescript(
            "DROP TABLE samples; DROP TABLE events; DROP TABLE state;"
        )

        store.record("m", 2.0)

        assert store.latest("m")[1] == 2.0
        assert store.last_write_error is None

    def test_new_thread_connecting_to_an_empty_file_rebuilds_schema(self, store):
        """A thread that first connects *after* the file was replaced would
        otherwise open an empty database and fail on every write."""
        import threading

        store.record("m", 1.0)
        store._connection().executescript(
            "DROP TABLE samples; DROP TABLE events; DROP TABLE state;"
        )
        results: list[tuple[float, float] | None] = []

        def worker() -> None:
            store.record("m", 3.0)
            results.append(store.latest("m"))

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()

        assert results and results[0] is not None and results[0][1] == 3.0

    def test_write_failure_degrades_instead_of_raising(self, store, monkeypatch):
        """A page render must survive a store that cannot be written to."""
        from core.history import HistoryStoreError

        def explode(_operation):
            raise HistoryStoreError("disk I/O error")

        monkeypatch.setattr(store, "_write", explode)

        store.record("m", 1.0)  # must not raise
        change = store.put_state("wan.ip", "203.0.113.7")
        store.add_event("network", "something happened")

        assert change.changed is False
        assert change.first_seen is True
        assert store.last_write_error == "disk I/O error"


class TestStateChangeDetection:
    def test_first_observation_is_not_a_change(self, store):
        """The dashboard must not announce a change on its very first run."""
        change = store.put_state("wan.ip", "111.118.194.91")
        assert change.first_seen is True
        assert change.changed is False

    def test_unchanged_value(self, store):
        store.put_state("wan.ip", "111.118.194.91")
        change = store.put_state("wan.ip", "111.118.194.91")
        assert change.changed is False
        assert change.previous == "111.118.194.91"

    def test_changed_value_records_previous(self, store):
        store.put_state("wan.ip", "111.118.194.91")
        change = store.put_state("wan.ip", "203.0.113.7")
        assert change.changed is True
        assert change.previous == "111.118.194.91"
        assert change.value == "203.0.113.7"

    def test_changed_at_is_stable_while_value_holds(self, store):
        store.put_state("k", "v")
        first = store.put_state("k", "v").changed_at
        second = store.put_state("k", "v").changed_at
        assert first == second

    def test_image_version_change_detection(self, store):
        """The SABnzbd 5.0.4-ls258 -> 5.1.0-ls266 update should be detectable."""
        store.put_state("container.sabnzbd.image", "sabnzbd:latest@5.0.4-ls258")
        change = store.put_state("container.sabnzbd.image", "sabnzbd:latest@5.1.0-ls266")
        assert change.changed is True
        assert "5.0.4-ls258" in change.previous


class TestEvents:
    def test_events_round_trip(self, store):
        store.add_event("docker", "SABnzbd image changed", "5.0.4 -> 5.1.0", "INFO")
        events = store.recent_events()
        assert len(events) == 1
        assert events[0]["summary"] == "SABnzbd image changed"

    def test_events_newest_first(self, store):
        store.add_event("a", "first")
        time.sleep(0.01)
        store.add_event("b", "second")
        events = store.recent_events()
        assert events[0]["summary"] == "second"


# ---------------------------------------------------------------------------
# Forecasting
# ---------------------------------------------------------------------------


class TestLinearFit:
    def test_perfect_line(self):
        samples = [(float(i) * DAY, float(i) * 100.0) for i in range(10)]
        fit = linear_fit(samples)
        assert fit is not None
        assert fit.r_squared == pytest.approx(1.0)
        assert fit.slope * DAY == pytest.approx(100.0)

    def test_flat_series_is_a_valid_fit(self):
        samples = [(float(i) * DAY, 500.0) for i in range(10)]
        fit = linear_fit(samples)
        assert fit is not None
        assert fit.slope == pytest.approx(0.0)

    def test_too_few_points(self):
        assert linear_fit([(0.0, 1.0), (1.0, 2.0)]) is None

    def test_identical_timestamps(self):
        assert linear_fit([(5.0, 1.0), (5.0, 2.0), (5.0, 3.0)]) is None


class TestCapacityForecast:
    def _linear_samples(self, days=30, per_day=29e9, start=17e12):
        now = time.time()
        return [
            (now - (days - i) * DAY, start + i * per_day)
            for i in range(days + 1)
        ]

    def test_insufficient_samples_refuses_to_forecast(self):
        forecast = forecast_capacity([(time.time(), 1e12)], total_bytes=22e12)
        assert forecast.available is False
        assert "Insufficient history" in forecast.reason

    def test_insufficient_calendar_history_refuses(self):
        now = time.time()
        samples = [(now - i * 600, 1e12) for i in range(20)]
        forecast = forecast_capacity(samples, total_bytes=22e12)
        assert forecast.available is False
        assert "Insufficient history" in forecast.reason

    def test_zero_capacity_refuses(self):
        forecast = forecast_capacity(self._linear_samples(), total_bytes=0)
        assert forecast.available is False

    def test_steady_growth_projects_dates(self):
        forecast = forecast_capacity(self._linear_samples(), total_bytes=24e12)
        assert forecast.available is True
        assert forecast.growth_bytes_per_day == pytest.approx(29e9, rel=0.05)
        assert forecast.date_90_percent is not None
        assert forecast.date_90_percent > time.time()

    def test_projected_dates_are_ordered(self):
        forecast = forecast_capacity(
            self._linear_samples(start=15e12), total_bytes=24e12
        )
        assert forecast.date_80_percent < forecast.date_90_percent
        assert forecast.date_90_percent < forecast.date_full

    def test_already_past_threshold_yields_no_date(self):
        """/mnt/media is already past 80%, so no 80% crossing is projected."""
        forecast = forecast_capacity(
            self._linear_samples(start=20e12), total_bytes=22e12
        )
        assert forecast.date_80_percent is None

    def test_flat_usage_projects_no_fill_date(self):
        now = time.time()
        samples = [(now - (30 - i) * DAY, 10e12) for i in range(31)]
        forecast = forecast_capacity(samples, total_bytes=22e12)
        assert forecast.date_90_percent is None
        assert "flat" in forecast.reason.lower()

    def test_shrinking_filesystem_projects_nothing(self):
        now = time.time()
        samples = [(now - (30 - i) * DAY, 10e12 - i * 1e10) for i in range(31)]
        forecast = forecast_capacity(samples, total_bytes=22e12)
        assert forecast.shrinking is True
        assert forecast.date_full is None

    def test_noisy_data_is_rejected_but_growth_still_reported(self):
        """A bad fit must not produce a confident date, but the rate still shows."""
        import random

        random.seed(7)
        now = time.time()
        samples = [
            (now - (30 - i) * DAY, 10e12 + random.uniform(-3e12, 3e12))
            for i in range(31)
        ]
        forecast = forecast_capacity(samples, total_bytes=22e12, min_r_squared=0.9)
        assert forecast.available is False
        assert "irregular" in forecast.reason.lower()
        assert forecast.growth_bytes_per_day is not None

    def test_measured_growth_windows(self):
        forecast = forecast_capacity(self._linear_samples(days=40), total_bytes=24e12)
        assert forecast.growth_bytes_7d == pytest.approx(7 * 29e9, rel=0.1)
        assert forecast.growth_bytes_30d == pytest.approx(30 * 29e9, rel=0.1)
        # 90 days of history do not exist, so that window must stay unknown.
        assert forecast.growth_bytes_90d is None


class TestProjection:
    def test_projects_forward(self):
        target = project_threshold_date(80.0, growth_per_day=1.0, target_value=90.0)
        assert target is not None
        assert target > time.time()

    def test_no_growth_never_reaches_target(self):
        assert project_threshold_date(80.0, 0.0, 90.0) is None

    def test_already_past_target(self):
        assert project_threshold_date(95.0, 1.0, 90.0) is None

    def test_absurdly_distant_projection_is_rejected(self):
        assert project_threshold_date(10.0, 0.000001, 90.0) is None
