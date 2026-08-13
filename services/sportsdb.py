"""Sports Data Lab database monitoring.

Tracks the AFL/NBA/NFL/MLB SQLite databases: size, last modification, staleness
and — on demand — integrity. Size and mtime are cheap stat() calls safe to run
on every refresh; `PRAGMA integrity_check` reads the whole file and is only run
when asked.

The databases are live and being written by the application, so integrity
checks open them read-only and a `database is locked` result is reported as
"could not verify", never as corruption.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

from services.backups import IntegrityResult, verify_sqlite
from utils.logging_setup import get_logger

log = get_logger("sportsdb")


@dataclass
class SportsDbStatus:
    key: str
    display: str
    path: str
    exists: bool = False
    size_bytes: int | None = None
    modified_at: float | None = None
    #: Change in size against the previous sample, filled by the caller from
    #: the history store — a database that stops growing is the real signal.
    growth_bytes: float | None = None
    integrity_ok: bool | None = None
    integrity_detail: str = ""
    integrity_checked_at: float | None = None
    backup_count: int = 0
    latest_backup_at: float | None = None
    error: str = ""
    max_age_hours: float = 48.0
    collected_at: float = field(default_factory=time.time)

    @property
    def age_seconds(self) -> float | None:
        if self.modified_at is None:
            return None
        return max(0.0, time.time() - self.modified_at)

    @property
    def age_hours(self) -> float | None:
        age = self.age_seconds
        return age / 3600.0 if age is not None else None

    @property
    def stale(self) -> bool | None:
        age = self.age_hours
        return None if age is None else age > self.max_age_hours

    @property
    def backup_age_seconds(self) -> float | None:
        if self.latest_backup_at is None:
            return None
        return max(0.0, time.time() - self.latest_backup_at)


def get_database_status(
    key: str, display: str, path: str, max_age_hours: float = 48.0
) -> SportsDbStatus:
    """Stat one database and its sibling `backups/` directory."""
    status = SportsDbStatus(
        key=key, display=display, path=path, max_age_hours=max_age_hours
    )
    db_path = Path(path)
    try:
        if not db_path.is_file():
            status.error = "Database file not found"
            return status
        info = db_path.stat()
        status.exists = True
        status.size_bytes = info.st_size
        status.modified_at = info.st_mtime
    except OSError as exc:
        status.error = f"Cannot stat database: {exc}"
        return status

    # The application keeps rolling copies in a sibling backups/ directory.
    backups_dir = db_path.parent / "backups"
    if backups_dir.is_dir():
        try:
            snapshots = [
                entry.stat().st_mtime
                for entry in backups_dir.iterdir()
                if entry.is_file() and entry.suffix in {".db", ".sqlite", ".sqlite3"}
            ]
            status.backup_count = len(snapshots)
            status.latest_backup_at = max(snapshots) if snapshots else None
        except OSError:
            pass
    return status


def verify_database(path: str) -> IntegrityResult:
    """Integrity check a live database, tolerating write locks."""
    result = verify_sqlite(path)
    if not result.ok and "locked" in result.detail.lower():
        return IntegrityResult(
            ok=False,
            detail=(
                "Database is locked by the running application — integrity could "
                "not be verified. This is not evidence of corruption."
            ),
            method=result.method,
            duration_seconds=result.duration_seconds,
        )
    return result


def get_all_databases(configs) -> list[SportsDbStatus]:
    """Status for every configured sports database."""
    return [
        get_database_status(cfg.key, cfg.display, cfg.path, cfg.max_age_hours)
        for cfg in configs
    ]
