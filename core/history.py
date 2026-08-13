"""Local time-series store for deltas, trends and forecasts.

Why this exists: the dashboard's most valuable outputs — "CRC +0 over 7 days",
"/mnt/media grows 29 GB/day, hits 90% in March" — are *differences over time*,
and they need a time-series database. Prometheus is the intended one, but the
13 Aug 2026 survey found no Prometheus server running on streamanator, so the
dashboard would have had nothing to difference against on day one.

This module is the fallback: a small append-only SQLite series keyed by
(metric, labels), written by a background sampler at a fixed interval and
retained for a bounded window. When `PROMETHEUS_URL` is configured, the query
layer prefers Prometheus for range data and this store simply keeps running as
a backstop.

It is deliberately dumb: no downsampling, no aggregation functions beyond what
the health rules need. A counter that has only ever been sampled once yields
`None` from `delta()` — not zero — because "unchanged" and "never compared"
are different answers.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from utils.logging_setup import get_logger

log = get_logger("history")


class HistoryStoreError(RuntimeError):
    """A write could not be committed (typically: database locked by another
    process past the busy timeout). Raised instead of leaking a bare
    sqlite3.OperationalError into whatever thread happened to be writing."""


_SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    metric TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '',
    ts     REAL NOT NULL,
    value  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_lookup ON samples (metric, labels, ts);

CREATE TABLE IF NOT EXISTS events (
    ts       REAL NOT NULL,
    category TEXT NOT NULL,
    summary  TEXT NOT NULL,
    detail   TEXT NOT NULL DEFAULT '',
    status   TEXT NOT NULL DEFAULT 'INFO'
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

-- Single-row-per-key store for change detection (last seen image tag, WAN IP,
-- restart count...). Keeping the previous value alongside the current one is
-- what lets the Recent Changes feed say what a value changed *from*.
CREATE TABLE IF NOT EXISTS state (
    key            TEXT PRIMARY KEY,
    value          TEXT NOT NULL,
    previous_value TEXT,
    updated_at     REAL NOT NULL,
    changed_at     REAL NOT NULL
);
"""


_TABLES = ("samples", "events", "state")


def _tables_present(conn: sqlite3.Connection) -> bool:
    """Cheap read-only check that the schema is actually there.

    Used instead of unconditionally running `_SCHEMA`: `CREATE TABLE IF NOT
    EXISTS` still opens a write transaction, and paying that on every thread's
    first connect is contention the sampler does not need.
    """
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN "
        "(?, ?, ?)",
        _TABLES,
    ).fetchone()
    return bool(row) and row[0] == len(_TABLES)


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    conn.commit()


def _encode_labels(labels: dict[str, str] | None) -> str:
    if not labels:
        return ""
    return json.dumps(dict(sorted(labels.items())), separators=(",", ":"))


@dataclass(frozen=True)
class StateChange:
    """Result of `put_state` — tells the caller whether the value moved."""

    key: str
    value: str
    previous: str | None
    changed: bool
    changed_at: float
    #: True the very first time a key is seen, so callers can avoid announcing
    #: "SABnzbd image changed" on the dashboard's first ever run.
    first_seen: bool


class HistoryStore:
    """Thread-safe SQLite series store.

    One connection per thread (SQLite objects are not shareable across
    threads), guarded by a lock for writes so the background sampler and the
    Streamlit request threads cannot interleave transactions.
    """

    def __init__(
        self,
        path: str | Path,
        retention_days: int = 400,
        busy_timeout_ms: int = 10_000,
    ) -> None:
        self.path = Path(path)
        self.retention_days = retention_days
        self.busy_timeout_ms = busy_timeout_ms
        self._local = threading.local()
        self._write_lock = threading.Lock()
        #: Last write failure, for the diagnostics page. Writes on the
        #: collection path are best-effort (see `_write_best_effort`), so this
        #: is the only place a persistent store problem becomes visible.
        self.last_write_error: str | None = None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # WAL is a property of the database *file*, so it is set once here on
        # a throwaway connection instead of racing on every thread's first
        # connect — `PRAGMA journal_mode=WAL` itself takes a write lock, and
        # N threads issuing it simultaneously was its own contention source.
        setup = sqlite3.connect(self.path, timeout=busy_timeout_ms / 1000)
        try:
            setup.execute("PRAGMA journal_mode=WAL")
            _ensure_schema(setup)
        finally:
            setup.close()

    # -- connection ------------------------------------------------------

    def _connection(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            # isolation_level=None: explicit BEGIN IMMEDIATE in _write, no
            # implicit transaction state left half-open between calls.
            conn = sqlite3.connect(
                self.path, timeout=self.busy_timeout_ms / 1000, isolation_level=None
            )
            conn.execute(f"PRAGMA busy_timeout={self.busy_timeout_ms}")
            conn.execute("PRAGMA synchronous=NORMAL")
            # The schema is created in __init__, but that ran once, possibly
            # days ago. If the database file was deleted or replaced since
            # (a cleaned `var/`, a redeploy that swapped the checkout),
            # sqlite3.connect happily creates an empty replacement and every
            # write from this thread would fail with "no such table".
            if not _tables_present(conn):
                _ensure_schema(conn)
            self._local.conn = conn
        return conn

    @staticmethod
    def _rollback(conn: sqlite3.Connection) -> None:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass

    def _write(self, operation) -> None:
        """Run one write transaction: BEGIN IMMEDIATE, rollback on failure,
        bounded retries on lock contention, `HistoryStoreError` past them.

        BEGIN IMMEDIATE takes the write lock up front, so a lock conflict
        surfaces here — retryable — rather than at COMMIT after the work.
        """
        with self._write_lock:
            conn = self._connection()
            lock_attempts = 0
            healed = False
            while True:
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    operation(conn)
                    conn.execute("COMMIT")
                    return
                except sqlite3.OperationalError as exc:
                    self._rollback(conn)
                    message = str(exc).lower()
                    # A connection opened before the file went away keeps
                    # working against the old inode; one opened after it was
                    # replaced sees an empty database. Rebuild the schema once
                    # and retry rather than failing for the life of the
                    # process — this store is a cached resource, so nothing
                    # else would ever reconnect.
                    if "no such table" in message and not healed:
                        healed = True
                        log.warning("History schema missing at %s; recreating", self.path)
                        try:
                            _ensure_schema(conn)
                        except sqlite3.OperationalError as schema_exc:
                            raise HistoryStoreError(str(schema_exc)) from schema_exc
                        continue
                    if "locked" not in message or lock_attempts >= 2:
                        raise HistoryStoreError(str(exc)) from exc
                    time.sleep(0.05 * (2**lock_attempts))
                    lock_attempts += 1
                except BaseException:
                    self._rollback(conn)
                    raise

    def _write_best_effort(self, operation) -> bool:
        """`_write`, but a store failure degrades the dashboard instead of
        blanking it.

        Everything on the collection path goes through here. A page render
        that cannot append one CRC sample should still show temperature, RAID
        and containers; before this, a single failed write propagated out of
        the collector and took the whole page down with a traceback. The
        sampler keeps the raising variant, because reporting exactly this is
        what the sampler's `last_error` is for.
        """
        try:
            self._write(operation)
        except HistoryStoreError as exc:
            self.last_write_error = str(exc)
            log.warning("History write failed (%s); continuing without it", exc)
            return False
        self.last_write_error = None
        return True

    # -- writes ----------------------------------------------------------

    def record(
        self,
        metric: str,
        value: float | None,
        labels: dict[str, str] | None = None,
        ts: float | None = None,
    ) -> None:
        """Append one sample. `None` values are dropped, never stored as 0."""
        if value is None:
            return
        self._write_best_effort(
            lambda conn: conn.execute(
                "INSERT INTO samples (metric, labels, ts, value) VALUES (?, ?, ?, ?)",
                (metric, _encode_labels(labels), ts or time.time(), float(value)),
            )
        )

    def record_many(
        self, rows: Iterable[tuple[str, dict[str, str] | None, float | None]]
    ) -> None:
        """Batch variant of `record`, one transaction for the whole sample run."""
        now = time.time()
        payload = [
            (metric, _encode_labels(labels), now, float(value))
            for metric, labels, value in rows
            if value is not None
        ]
        if not payload:
            return
        self._write(
            lambda conn: conn.executemany(
                "INSERT INTO samples (metric, labels, ts, value) VALUES (?, ?, ?, ?)",
                payload,
            )
        )

    def _read_one(self, query: str, params: tuple):
        try:
            return self._connection().execute(query, params).fetchone()
        except sqlite3.OperationalError as exc:
            log.warning("History read failed (%s); reporting no data", exc)
            return None

    def _read_all(self, query: str, params: tuple) -> list:
        try:
            return self._connection().execute(query, params).fetchall()
        except sqlite3.OperationalError as exc:
            log.warning("History read failed (%s); reporting no data", exc)
            return []

    # -- reads -----------------------------------------------------------

    def latest(
        self, metric: str, labels: dict[str, str] | None = None
    ) -> tuple[float, float] | None:
        """Most recent (timestamp, value), or None when never sampled."""
        row = self._read_one(
            "SELECT ts, value FROM samples WHERE metric = ? AND labels = ? "
            "ORDER BY ts DESC LIMIT 1",
            (metric, _encode_labels(labels)),
        )
        return (row[0], row[1]) if row else None

    def series(
        self,
        metric: str,
        labels: dict[str, str] | None = None,
        since: float | None = None,
        limit: int = 5000,
    ) -> list[tuple[float, float]]:
        """Ascending (timestamp, value) pairs within the window."""
        rows = self._read_all(
            "SELECT ts, value FROM samples WHERE metric = ? AND labels = ? AND ts >= ? "
            "ORDER BY ts ASC LIMIT ?",
            (metric, _encode_labels(labels), since or 0.0, limit),
        )
        return [(row[0], row[1]) for row in rows]

    def value_at_or_before(
        self, metric: str, ts: float, labels: dict[str, str] | None = None
    ) -> tuple[float, float] | None:
        """The last sample taken at or before `ts`."""
        row = self._read_one(
            "SELECT ts, value FROM samples WHERE metric = ? AND labels = ? AND ts <= ? "
            "ORDER BY ts DESC LIMIT 1",
            (metric, _encode_labels(labels), ts),
        )
        return (row[0], row[1]) if row else None

    def delta(
        self,
        metric: str,
        window_seconds: float,
        labels: dict[str, str] | None = None,
        tolerance: float = 0.25,
    ) -> float | None:
        """Change in a value across `window_seconds`.

        Returns None — meaning "cannot say" — unless there is a baseline sample
        genuinely old enough. `tolerance` allows the baseline to be up to 25%
        younger than the requested window, so a 7-day delta still reports after
        5.25 days of history rather than staying blank for a week.
        """
        current = self.latest(metric, labels)
        if current is None:
            return None
        now_ts, now_value = current
        target = now_ts - window_seconds
        baseline = self.value_at_or_before(metric, target, labels)
        if baseline is None:
            # No sample that old; fall back to the oldest we have, but only if
            # it spans enough of the requested window to be meaningful.
            oldest = self.series(metric, labels, since=0.0, limit=1)
            if not oldest:
                return None
            base_ts, base_value = oldest[0]
            if (now_ts - base_ts) < window_seconds * (1.0 - tolerance):
                return None
            return now_value - base_value
        return now_value - baseline[1]

    def coverage_seconds(
        self, metric: str, labels: dict[str, str] | None = None
    ) -> float:
        """How much history exists for a series — gates forecasting."""
        row = self._read_one(
            "SELECT MIN(ts), MAX(ts) FROM samples WHERE metric = ? AND labels = ?",
            (metric, _encode_labels(labels)),
        )
        if not row or row[0] is None:
            return 0.0
        return float(row[1] - row[0])

    # -- state / change detection ---------------------------------------

    def put_state(self, key: str, value: str) -> StateChange:
        """Upsert a tracked value and report whether it changed."""
        now = time.time()
        result: list[StateChange] = []

        def transaction(conn: sqlite3.Connection) -> None:
            row = conn.execute(
                "SELECT value, changed_at FROM state WHERE key = ?", (key,)
            ).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO state (key, value, previous_value, updated_at, "
                    "changed_at) VALUES (?, ?, NULL, ?, ?)",
                    (key, value, now, now),
                )
                result.append(StateChange(key, value, None, False, now, first_seen=True))
                return
            previous, changed_at = row[0], row[1]
            if previous == value:
                conn.execute(
                    "UPDATE state SET updated_at = ? WHERE key = ?", (now, key)
                )
                result.append(
                    StateChange(key, value, previous, False, changed_at, False)
                )
                return
            conn.execute(
                "UPDATE state SET value = ?, previous_value = ?, updated_at = ?, "
                "changed_at = ? WHERE key = ?",
                (value, previous, now, now, key),
            )
            result.append(StateChange(key, value, previous, True, now, first_seen=False))

        if not self._write_best_effort(transaction) or not result:
            # Cannot say whether the value moved, so say it did not: callers
            # gate their "X changed" events on `changed and not first_seen`,
            # and a store hiccup must not invent a WAN IP change.
            return StateChange(key, value, None, False, now, first_seen=True)
        return result[0]

    def get_state(self, key: str) -> StateChange | None:
        row = self._read_one(
            "SELECT value, previous_value, changed_at FROM state WHERE key = ?", (key,)
        )
        if row is None:
            return None
        return StateChange(key, row[0], row[1], False, row[2], first_seen=False)

    # -- events ----------------------------------------------------------

    def add_event(
        self, category: str, summary: str, detail: str = "", status: str = "INFO"
    ) -> None:
        self._write_best_effort(
            lambda conn: conn.execute(
                "INSERT INTO events (ts, category, summary, detail, status) "
                "VALUES (?, ?, ?, ?, ?)",
                (time.time(), category, summary, detail, status),
            )
        )

    def recent_events(self, limit: int = 50, since: float | None = None) -> list[dict]:
        rows = self._read_all(
            "SELECT ts, category, summary, detail, status FROM events WHERE ts >= ? "
            "ORDER BY ts DESC LIMIT ?",
            (since or 0.0, limit),
        )
        return [
            {
                "timestamp": row[0],
                "category": row[1],
                "summary": row[2],
                "detail": row[3],
                "status": row[4],
            }
            for row in rows
        ]

    # -- maintenance -----------------------------------------------------

    def prune(self) -> int:
        """Drop samples and events beyond the retention window."""
        cutoff = time.time() - self.retention_days * 86400
        removed: list[int] = []

        def transaction(conn: sqlite3.Connection) -> None:
            cursor = conn.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
            conn.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
            removed.append(cursor.rowcount)

        self._write(transaction)
        return removed[0]

    def stats(self) -> dict[str, float | int]:
        samples_row = self._read_one("SELECT COUNT(*) FROM samples", ())
        metrics_row = self._read_one("SELECT COUNT(DISTINCT metric) FROM samples", ())
        span = self._read_one("SELECT MIN(ts), MAX(ts) FROM samples", ()) or (None, None)
        samples = samples_row[0] if samples_row else 0
        metrics = metrics_row[0] if metrics_row else 0
        size = self.path.stat().st_size if self.path.exists() else 0
        return {
            "samples": samples,
            "metrics": metrics,
            "oldest": span[0] or 0.0,
            "newest": span[1] or 0.0,
            "bytes": size,
        }


class Sampler:
    """Background thread that keeps the history store filling.

    Sampling is decoupled from the UI on purpose. If history only accrued while
    a browser tab was open, the 7-day and 30-day deltas the whole design rests
    on would be full of holes.
    """

    def __init__(
        self,
        store: HistoryStore,
        collect: "callable[[], Sequence[tuple[str, dict[str, str] | None, float | None]]]",
        interval_seconds: int = 60,
    ) -> None:
        self.store = store
        self.collect = collect
        self.interval = max(15, interval_seconds)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_run: float | None = None
        self.last_error: str | None = None
        self.runs = 0

    def start(self) -> "Sampler":
        if self._thread and self._thread.is_alive():
            return self
        self._thread = threading.Thread(
            target=self._loop, name="streamanator-sampler", daemon=True
        )
        self._thread.start()
        log.info("History sampler started (interval=%ss)", self.interval)
        return self

    def stop(self) -> None:
        self._stop.set()

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def _loop(self) -> None:
        prune_counter = 0
        while not self._stop.is_set():
            started = time.time()
            try:
                rows = self.collect()
                self.store.record_many(rows)
                self.last_run = started
                self.last_error = None
                self.runs += 1
            except Exception as exc:  # noqa: BLE001 - the sampler must never die
                self.last_error = f"{type(exc).__name__}: {exc}"
                log.exception("History sample run failed")

            prune_counter += 1
            if prune_counter >= 1440:  # roughly daily at a 60s interval
                prune_counter = 0
                try:
                    self.store.prune()
                except Exception:  # noqa: BLE001
                    log.exception("History prune failed")

            elapsed = time.time() - started
            self._stop.wait(max(1.0, self.interval - elapsed))
