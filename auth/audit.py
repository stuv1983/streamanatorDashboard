"""Append-only audit log for every privileged action.

One JSON object per line at 0600, plus a mirror to the application logger so
privileged events also land in journald. Two independent copies matter: a file
inside the project directory is the one thing an attacker with the service
account can trim.

**The log fails closed.** `record()` raises `AuditWriteError` when the entry
cannot be persisted, and the action runner refuses to execute a privileged
command whose start-record did not land. The first version swallowed the
OSError and returned normally — meaning a full disk produced reboots with no
audit trail, silently. An audit log that only works when writing is easy is a
decoration.

**Secret values never enter this log.** Calls record what changed and a
non-reversible fingerprint of the new value. `record()` actively scrubs
credential-shaped text from detail strings rather than trusting callers.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal

from utils.fileio import atomic_write_text
from utils.logging_setup import get_logger

log = get_logger("audit")

Severity = Literal["info", "notice", "warning", "critical"]

#: Entries above this age are pruned. A year of privileged actions on a home
#: server is a few hundred lines — retention bounds the file, it does not
#: forget anything relevant.
RETENTION_DAYS = 400

_SECRET_SHAPES = (
    re.compile(r"(?i)\b(api[_-]?key|token|password|passwd|secret)\b\s*[=:]\s*\S+"),
    # Bare high-entropy strings: 24+ chars of base64/hex with no spaces.
    re.compile(r"\b[A-Za-z0-9+/_-]{24,}={0,2}\b"),
)


class AuditWriteError(RuntimeError):
    """The audit entry could not be persisted. Callers gate on this."""


@dataclass(frozen=True)
class AuditEntry:
    at: float
    actor: str
    role: str
    action: str
    outcome: str
    severity: Severity
    target: str = ""
    detail: str = ""
    #: True when the actor authenticated through the break-glass path. A
    #: field of its own so a break-glass session's *subsequent* actions are
    #: marked, not just its login.
    breakglass: bool = False

    @property
    def when(self) -> str:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.at))


class AuditLog:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()
        self._pruned_this_process = False

    def record(
        self,
        action: str,
        actor: str,
        role: str,
        outcome: str,
        *,
        severity: Severity = "info",
        target: str = "",
        detail: str = "",
        breakglass: bool = False,
    ) -> AuditEntry:
        """Persist one entry, or raise `AuditWriteError`.

        The journald mirror is written *before* the file append is attempted,
        so even a failed persist leaves one copy somewhere.
        """
        entry = AuditEntry(
            at=time.time(),
            actor=actor or "anonymous",
            role=role or "none",
            action=action,
            outcome=outcome,
            severity=severity,
            target=target,
            detail=_scrub(detail),
            breakglass=breakglass,
        )
        level = {
            "info": log.info,
            "notice": log.info,
            "warning": log.warning,
            "critical": log.critical,
        }[severity]
        level(
            "AUDIT %s actor=%s role=%s outcome=%s target=%s%s",
            action,
            entry.actor,
            entry.role,
            outcome,
            target or "-",
            " [BREAK-GLASS]" if breakglass else "",
        )
        with self._lock:
            if not self._pruned_this_process:
                # Opportunistic, once per process — the documented retention
                # was previously never invoked at all, so the file grew
                # without bound.
                self._pruned_this_process = True
                try:
                    self._prune_unlocked(RETENTION_DAYS)
                except OSError as exc:  # pragma: no cover - best effort
                    log.warning("Audit prune failed: %s", exc)
            self._append_unlocked(entry)
        return entry

    def _append_unlocked(self, entry: AuditEntry) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            existed = self.path.exists()
            descriptor = os.open(
                self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
            )
            with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry.__dict__, default=str) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            if not existed:
                try:
                    os.chmod(self.path, 0o600)
                except OSError:  # pragma: no cover
                    pass
        except OSError as exc:
            log.critical("AUDIT WRITE FAILED for %s: %s", entry.action, exc)
            raise AuditWriteError(
                f"Could not write the audit log at {self.path}: {exc}"
            ) from exc

    def read(
        self,
        limit: int = 500,
        actions: Iterable[str] | None = None,
        min_severity: Severity | None = None,
    ) -> list[AuditEntry]:
        with self._lock:
            try:
                lines = self.path.read_text(encoding="utf-8").splitlines()
            except FileNotFoundError:
                return []
            except OSError as exc:
                log.error("Audit log unreadable: %s", exc)
                return []
        wanted = set(actions) if actions else None
        order = {"info": 0, "notice": 1, "warning": 2, "critical": 3}
        floor = order.get(min_severity or "info", 0)
        entries: list[AuditEntry] = []
        for line in reversed(lines):
            if len(entries) >= limit:
                break
            entry = _parse_line(line)
            if entry is None:
                continue
            if wanted and entry.action not in wanted:
                continue
            if order.get(entry.severity, 0) < floor:
                continue
            entries.append(entry)
        return entries

    def latest(
        self,
        action: str,
        breakglass: bool | None = None,
        outcome: str | None = None,
    ) -> AuditEntry | None:
        """The most recent entry matching the criteria, scanning newest-first."""
        with self._lock:
            try:
                lines = self.path.read_text(encoding="utf-8").splitlines()
            except (FileNotFoundError, OSError):
                return None
        for line in reversed(lines):
            entry = _parse_line(line)
            if entry is None or entry.action != action:
                continue
            if breakglass is not None and entry.breakglass != breakglass:
                continue
            if outcome is not None and entry.outcome != outcome:
                continue
            return entry
        return None

    def prune(self, retention_days: int = RETENTION_DAYS) -> int:
        with self._lock:
            return self._prune_unlocked(retention_days)

    def _prune_unlocked(self, retention_days: int) -> int:
        if not self.path.is_file():
            return 0
        cutoff = time.time() - retention_days * 86400
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return 0
        keep: list[str] = []
        for line in lines:
            try:
                if float(json.loads(line).get("at", 0)) >= cutoff:
                    keep.append(line)
            except (json.JSONDecodeError, TypeError, ValueError):
                keep.append(line)
        removed = len(lines) - len(keep)
        if removed <= 0:
            return 0
        atomic_write_text(
            self.path, "\n".join(keep) + ("\n" if keep else ""), mode=0o600
        )
        return removed

    def breakglass_events(self, limit: int = 20) -> list[AuditEntry]:
        return [e for e in self.read(limit=1000) if e.breakglass][:limit]


def _parse_line(line: str) -> AuditEntry | None:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    known = set(AuditEntry.__dataclass_fields__)
    try:
        return AuditEntry(**{k: v for k, v in payload.items() if k in known})
    except TypeError:
        return None


def _scrub(text: str) -> str:
    """Replace anything credential-shaped before it reaches disk."""
    if not text:
        return ""
    cleaned = text
    for pattern in _SECRET_SHAPES:
        cleaned = pattern.sub("<redacted>", cleaned)
    if cleaned != text:
        log.warning(
            "Audit detail contained credential-shaped text and was redacted "
            "before writing. This is a bug in the calling code."
        )
    return cleaned
