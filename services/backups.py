"""Backup discovery, age tracking and integrity verification.

A backup that exists is not a backup that works, so this module separates two
questions the dashboard must answer differently:

* **Is a recent backup present?** — cheap, safe to run on every refresh.
* **Is it intact?** — expensive (a gzip test on a 3.8 GB archive reads the
  whole file), so verification is explicit, cached, and never runs on a page
  render. Results persist in the history store so the last verdict and the time
  it was reached stay visible.
"""

from __future__ import annotations

import fnmatch
import os
import sqlite3
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from utils.logging_setup import get_logger

log = get_logger("backups")


@dataclass
class BackupFile:
    path: str
    size_bytes: int
    modified_at: float
    #: False for directory-per-run backups, whose size is not measured during
    #: the scan. Walking sixteen full system-backup trees on the live host cost
    #: over two minutes — far past the page budget — so directory sizes are
    #: measured only on explicit request. Unknown size is reported as unknown,
    #: never as 0, so it cannot be mistaken for an empty backup.
    size_known: bool = True

    @property
    def name(self) -> str:
        return Path(self.path).name

    @property
    def age_seconds(self) -> float:
        return max(0.0, time.time() - self.modified_at)


@dataclass
class BackupStatus:
    """State of one backup job."""

    key: str
    display: str
    directory: str
    schedule: str
    #: None when the directory is missing or empty — not the same as "old".
    latest: BackupFile | None = None
    previous: BackupFile | None = None
    retained_count: int = 0
    total_bytes: int = 0
    destination_free_bytes: int | None = None
    destination_total_bytes: int | None = None
    #: True/False after verification, None when never verified.
    integrity_ok: bool | None = None
    integrity_detail: str = ""
    integrity_checked_at: float | None = None
    error: str = ""
    expected_interval_days: float = 1.0
    min_plausible_bytes: int = 0
    #: "file" for archive-per-run jobs, "directory" for jobs that write a
    #: dated directory tree per run.
    entry_kind: str = "file"
    #: Set when the schedule says a run should have produced output by now.
    missed_run_at: float | None = None

    @property
    def age_seconds(self) -> float | None:
        return self.latest.age_seconds if self.latest else None

    @property
    def age_days(self) -> float | None:
        age = self.age_seconds
        return age / 86400.0 if age is not None else None

    @property
    def size_suspicious(self) -> bool:
        """A backup far smaller than expected usually means a truncated run."""
        if self.latest is None or self.min_plausible_bytes <= 0:
            return False
        if not self.latest.size_known:
            return False  # unmeasured size cannot be judged
        return self.latest.size_bytes < self.min_plausible_bytes

    @property
    def growth_bytes(self) -> int | None:
        """Size change against the previous backup — a sudden shrink is a flag."""
        if self.latest is None or self.previous is None:
            return None
        if not (self.latest.size_known and self.previous.size_known):
            return None
        return self.latest.size_bytes - self.previous.size_bytes

    @property
    def destination_used_percent(self) -> float | None:
        if not self.destination_total_bytes:
            return None
        used = self.destination_total_bytes - (self.destination_free_bytes or 0)
        return 100.0 * used / self.destination_total_bytes


def scan_backup_directory(
    key: str,
    display: str,
    directory: str,
    pattern: str = "*",
    schedule: str = "",
    expected_interval_days: float = 1.0,
    min_plausible_bytes: int = 0,
    max_files: int = 500,
) -> BackupStatus:
    """Inventory a backup destination without reading any file contents."""
    status = BackupStatus(
        key=key,
        display=display,
        directory=directory,
        schedule=schedule,
        expected_interval_days=expected_interval_days,
        min_plausible_bytes=min_plausible_bytes,
    )

    root = Path(directory)
    if not root.is_dir():
        status.error = f"Backup directory {directory} does not exist or is unreadable"
        return status

    try:
        stat = os.statvfs(directory)
        block = stat.f_frsize or stat.f_bsize
        status.destination_free_bytes = stat.f_bavail * block
        status.destination_total_bytes = stat.f_blocks * block
    except (OSError, AttributeError):
        pass

    files: list[BackupFile] = []
    directories: list[BackupFile] = []
    try:
        for entry in root.iterdir():
            if len(files) + len(directories) >= max_files:
                break

            # Directory-per-run backups. The nightly job on this host writes
            # `/mnt/backup/nightly/2026-08-13_02-00-01/` rather than a single
            # archive, so treating only files as backups would report a
            # working job as "no backup found".
            if entry.is_dir():
                try:
                    info = entry.stat()
                except OSError:
                    continue
                # Size is deliberately NOT computed here — see BackupFile.
                directories.append(
                    BackupFile(
                        path=str(entry),
                        size_bytes=0,
                        modified_at=info.st_mtime,
                        size_known=False,
                    )
                )
                continue

            if not entry.is_file():
                continue
            if pattern != "*" and not fnmatch.fnmatch(entry.name, pattern):
                continue
            # Skip the job's own log so it is not mistaken for a backup.
            if entry.suffix in {".log", ".tmp", ".part"}:
                continue
            try:
                info = entry.stat()
            except OSError:
                continue
            files.append(
                BackupFile(
                    path=str(entry),
                    size_bytes=info.st_size,
                    modified_at=info.st_mtime,
                )
            )
    except PermissionError as exc:
        status.error = f"Cannot read {directory}: {exc}"
        return status
    except OSError as exc:
        status.error = f"Error reading {directory}: {exc}"
        return status

    # Prefer archive files when both are present; fall back to run directories.
    if not files and directories:
        files = directories
        status.entry_kind = "directory"

    if not files:
        status.error = f"No files matching {pattern} in {directory}"
        return status

    files.sort(key=lambda f: f.modified_at, reverse=True)
    status.latest = files[0]
    status.previous = files[1] if len(files) > 1 else None
    status.retained_count = len(files)
    status.total_bytes = sum(f.size_bytes for f in files if f.size_known)
    return status


def measure_directory_size(
    path: str, max_entries: int = 200_000, deadline_seconds: float = 20.0
) -> tuple[int, bool]:
    """Measure a directory tree's size. Returns (bytes, complete).

    Bounded by both an entry count and a wall-clock deadline so it can never
    stall a page. `complete` is False when either bound was hit, so a partial
    figure is never presented as a total.
    """
    total = 0
    seen = 0
    started = time.monotonic()
    complete = True
    try:
        for entry in Path(path).rglob("*"):
            seen += 1
            if seen > max_entries or (time.monotonic() - started) > deadline_seconds:
                complete = False
                break
            try:
                if entry.is_file() and not entry.is_symlink():
                    total += entry.stat().st_size
            except OSError:
                continue
    except OSError:
        complete = False
    return total, complete


def next_expected_run(
    weekdays: tuple[int, ...], hour: int, minute: int = 0, now: float | None = None
) -> float | None:
    """The most recent time a scheduled job should have produced output.

    `weekdays` uses cron numbering (0 = Sunday). Returns the timestamp of the
    latest scheduled occurrence at or before `now`, so a backup older than that
    means a run was missed — which is a much sharper signal than raw age.
    The 12 Aug 2026 Wednesday run on this host failed silently, and simple age
    thresholds would not have caught it until days later.
    """
    if not weekdays:
        return None
    now = now if now is not None else time.time()
    current = datetime.fromtimestamp(now)

    # Walk back up to a week to find the most recent scheduled occurrence.
    for days_back in range(8):
        candidate_day = current - timedelta(days=days_back)
        # datetime.weekday() is Mon=0; cron is Sun=0.
        cron_weekday = (candidate_day.weekday() + 1) % 7
        if cron_weekday not in weekdays:
            continue
        occurrence = candidate_day.replace(
            hour=hour, minute=minute, second=0, microsecond=0
        )
        if occurrence.timestamp() <= now:
            return occurrence.timestamp()
    return None


def check_missed_run(
    status: BackupStatus,
    weekdays: tuple[int, ...],
    hour: int,
    minute: int = 0,
    grace_hours: float = 3.0,
    now: float | None = None,
) -> float | None:
    """Return the timestamp of a missed scheduled run, or None.

    `grace_hours` allows for a long-running job: a backup that started at 23:00
    and is still writing at 23:30 has not been missed.
    """
    expected = next_expected_run(weekdays, hour, minute, now)
    if expected is None:
        return None
    now = now if now is not None else time.time()
    if now < expected + grace_hours * 3600:
        return None  # still inside the grace window
    if status.latest is None:
        return expected
    if status.latest.modified_at < expected:
        return expected
    return None


# ---------------------------------------------------------------------------
# Integrity verification
# ---------------------------------------------------------------------------


@dataclass
class IntegrityResult:
    ok: bool
    detail: str
    method: str
    duration_seconds: float
    checked_at: float = field(default_factory=time.time)


def verify_sqlite(path: str, timeout: float = 120.0) -> IntegrityResult:
    """Run `PRAGMA integrity_check` against a SQLite database.

    Opened read-only via URI so verification can never modify the file it is
    checking. Expected result is the single string 'ok'.
    """
    started = time.perf_counter()
    try:
        connection = sqlite3.connect(
            f"file:{path}?mode=ro", uri=True, timeout=min(timeout, 30.0)
        )
    except sqlite3.Error as exc:
        return IntegrityResult(
            ok=False,
            detail=f"Could not open database: {exc}",
            method="PRAGMA integrity_check",
            duration_seconds=time.perf_counter() - started,
        )
    try:
        rows = connection.execute("PRAGMA integrity_check").fetchall()
        result = [row[0] for row in rows]
        ok = result == ["ok"]
        return IntegrityResult(
            ok=ok,
            detail="ok" if ok else "; ".join(result[:5]),
            method="PRAGMA integrity_check",
            duration_seconds=time.perf_counter() - started,
        )
    except sqlite3.Error as exc:
        return IntegrityResult(
            ok=False,
            detail=f"integrity_check failed: {exc}",
            method="PRAGMA integrity_check",
            duration_seconds=time.perf_counter() - started,
        )
    finally:
        connection.close()


def verify_gzip(path: str, timeout: float = 900.0) -> IntegrityResult:
    """Verify a gzip archive with `gzip -t`.

    Reads the entire file, so this is minutes of I/O on the multi-gigabyte
    Sports Data Lab archives. Only ever called on demand.
    """
    started = time.perf_counter()
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["gzip", "-t", path],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return IntegrityResult(
            ok=False,
            detail=f"gzip -t exceeded {timeout}s",
            method="gzip -t",
            duration_seconds=time.perf_counter() - started,
        )
    except OSError as exc:
        return IntegrityResult(
            ok=False,
            detail=f"Could not run gzip: {exc}",
            method="gzip -t",
            duration_seconds=time.perf_counter() - started,
        )
    ok = completed.returncode == 0
    return IntegrityResult(
        ok=ok,
        detail="ok" if ok else completed.stderr.strip()[:200],
        method="gzip -t",
        duration_seconds=time.perf_counter() - started,
    )


def verify_tar_listing(path: str, timeout: float = 900.0) -> IntegrityResult:
    """Confirm a tar.gz can be fully listed — catches truncation gzip may miss."""
    started = time.perf_counter()
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["tar", "-tzf", path],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return IntegrityResult(
            ok=False,
            detail=f"tar listing failed: {exc}",
            method="tar -tzf",
            duration_seconds=time.perf_counter() - started,
        )
    ok = completed.returncode == 0
    entries = len(completed.stdout.splitlines()) if ok else 0
    return IntegrityResult(
        ok=ok,
        detail=f"{entries:,} entries" if ok else completed.stderr.strip()[:200],
        method="tar -tzf",
        duration_seconds=time.perf_counter() - started,
    )


def verify_backup(path: str, deep: bool = False) -> IntegrityResult:
    """Verify a backup using the right method for its type."""
    lower = path.lower()
    if lower.endswith((".db", ".sqlite", ".sqlite3")):
        return verify_sqlite(path)
    if lower.endswith((".tar.gz", ".tgz")):
        if deep:
            return verify_tar_listing(path)
        return verify_gzip(path)
    if lower.endswith(".gz"):
        return verify_gzip(path)
    # Nothing we know how to verify — say so rather than claiming success.
    return IntegrityResult(
        ok=False,
        detail=f"No verification method for {Path(path).suffix or 'this file type'}",
        method="none",
        duration_seconds=0.0,
    )


def verify_sqlite_in_archive(
    archive_path: str, member_suffix: str = ".db", timeout: float = 900.0
) -> IntegrityResult:
    """Extract one database from an archive to temp space and integrity check it.

    This is the strongest available check — it proves the archive contains a
    restorable, structurally valid database, not merely that its compression
    stream decodes. Extraction goes to a temporary directory that is always
    cleaned up, and nothing in the source tree is touched.
    """
    started = time.perf_counter()
    try:
        listing = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["tar", "-tzf", archive_path],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return IntegrityResult(
            ok=False,
            detail=f"Could not list archive: {exc}",
            method="restore test",
            duration_seconds=time.perf_counter() - started,
        )
    if listing.returncode != 0:
        return IntegrityResult(
            ok=False,
            detail=listing.stderr.strip()[:200] or "tar listing failed",
            method="restore test",
            duration_seconds=time.perf_counter() - started,
        )

    members = [
        line.strip()
        for line in listing.stdout.splitlines()
        if line.strip().endswith(member_suffix)
    ]
    if not members:
        return IntegrityResult(
            ok=False,
            detail=f"Archive contains no {member_suffix} member to verify",
            method="restore test",
            duration_seconds=time.perf_counter() - started,
        )

    member = min(members, key=len)
    with tempfile.TemporaryDirectory(prefix="streamanator-verify-") as workdir:
        try:
            extract = subprocess.run(  # noqa: S603 - fixed argv, no shell
                ["tar", "-xzf", archive_path, "-C", workdir, member],
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            return IntegrityResult(
                ok=False,
                detail=f"Extraction failed: {exc}",
                method="restore test",
                duration_seconds=time.perf_counter() - started,
            )
        if extract.returncode != 0:
            return IntegrityResult(
                ok=False,
                detail=extract.stderr.strip()[:200] or "extraction failed",
                method="restore test",
                duration_seconds=time.perf_counter() - started,
            )
        extracted = Path(workdir) / member
        if not extracted.is_file():
            return IntegrityResult(
                ok=False,
                detail="Extracted member missing",
                method="restore test",
                duration_seconds=time.perf_counter() - started,
            )
        result = verify_sqlite(str(extracted))

    return IntegrityResult(
        ok=result.ok,
        detail=f"{member}: {result.detail}",
        method="restore test (extract + PRAGMA integrity_check)",
        duration_seconds=time.perf_counter() - started,
    )
