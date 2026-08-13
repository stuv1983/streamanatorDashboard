"""Read and rewrite the dashboard's `.env` file safely.

Credentials entered in the admin UI land here rather than in a parallel secret
store. One source of truth: `config.py` reads `.env`, the file is gitignored,
and a second store would mean two places to look when a key stops working.

Guarantees:

* **Parsed identically to the runtime loader.** Reading delegates to
  `config.parse_env_file` — the same function `reload_settings()` uses — so a
  value can never round-trip differently between "what the admin page shows"
  and "what the running process uses". (The first version had two parsers
  that disagreed about backslash escapes; a password with a quote in it
  silently became a different credential at runtime.)

* **Values are validated before writing.** A newline inside a value would be
  written literally inside the quotes, and the line-based parser would then
  read the tail as a *new variable* — meaning any unrestricted credential
  field (a qBittorrent password, say) could smuggle in
  ``ADMIN_ACTIONS_ENABLED=true`` and flip the action master switch. Keys must
  match the environment-variable grammar; values must be free of CR, LF and
  NUL. `update_env_file` raises rather than writing anything.

* **Duplicates are canonicalised.** Only the *last* occurrence of a key is
  authoritative (matching the parser), so an update rewrites that one and
  comments out any earlier shadowed duplicates instead of editing the first
  and leaving a later line silently winning.

* **Atomic, 0600 from creation, comment-preserving, with rolling backups.**
"""

from __future__ import annotations

import os
import re
import shutil
import time
from pathlib import Path

from config import parse_env_file
from utils.fileio import atomic_write_text
from utils.logging_setup import get_logger

log = get_logger("admin.env")

#: New keys are appended here so hand-written and UI-written settings stay
#: visually separated in the file.
MANAGED_HEADER = "# --- Managed by the dashboard admin console ---"

_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
_ENV_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_FORBIDDEN_CHARS = ("\r", "\n", "\x00")


def read_env_file(path: str | Path) -> dict[str, str]:
    """Parse a `.env` into a dict — the runtime's own parser, last key wins."""
    return parse_env_file(path)


def validate_update(key: str, value: str | None) -> None:
    """Raise ValueError if this key/value pair must not reach the file."""
    if not _ENV_KEY.fullmatch(key or ""):
        raise ValueError(f"Invalid environment key: {key!r}")
    if value is not None and any(ch in value for ch in _FORBIDDEN_CHARS):
        raise ValueError(
            f"{key} contains a control character (newline, CR or NUL). "
            "These cannot be represented in a .env file and would be parsed "
            "as additional variables."
        )


def update_env_file(
    path: str | Path, updates: dict[str, str | None], backup: bool = True
) -> list[str]:
    """Apply updates to a `.env`, returning the keys that actually changed.

    A value of `None` removes the key. Values are never logged — only key
    names appear in the return value and in any log line. Raises ValueError
    before touching the file if any update fails validation.
    """
    for key, value in updates.items():
        validate_update(key, value)

    file = Path(path)
    existing = read_env_file(file)
    changed = [
        key
        for key, value in updates.items()
        if existing.get(key) != (value if value is not None else None)
        and not (value is None and key not in existing)
    ]
    if not changed:
        return []

    lines = (
        file.read_text(encoding="utf-8").splitlines() if file.is_file() else []
    )

    # Duplicate keys: only the LAST occurrence is authoritative (that is what
    # the parser returns), so that is the line an update must rewrite. Earlier
    # occurrences of an updated key are commented out, not silently kept.
    last_index: dict[str, int] = {}
    for index, raw in enumerate(lines):
        match = _LINE.match(raw.strip())
        if match:
            last_index[match.group(1)] = index

    remaining = dict(updates)
    output: list[str] = []
    for index, raw in enumerate(lines):
        match = _LINE.match(raw.strip())
        if not match or match.group(1) not in remaining:
            output.append(raw)
            continue
        key = match.group(1)
        if index != last_index[key]:
            output.append(f"# {key}= (shadowed duplicate disabled {_stamp()})")
            continue
        value = remaining.pop(key)
        if value is None:
            # A tombstone rather than silent deletion, so a human reading the
            # file later can see the key was removed on purpose.
            output.append(f"# {key}= (removed {_stamp()})")
        else:
            output.append(f"{key}={_quote(value)}")

    additions = {k: v for k, v in remaining.items() if v is not None}
    if additions:
        if output and output[-1].strip():
            output.append("")
        if MANAGED_HEADER not in output:
            output.append(MANAGED_HEADER)
        for key, value in additions.items():
            output.append(f"{key}={_quote(value)}")

    if backup and file.is_file():
        _write_backup(file)

    atomic_write_text(file, "\n".join(output).rstrip("\n") + "\n", mode=0o600)
    log.info("Updated %d key(s) in %s: %s", len(changed), file, ", ".join(changed))
    return changed


def _write_backup(file: Path) -> None:
    """Keep the previous three versions, so a bad edit is recoverable."""
    backup = file.with_name(f"{file.name}.bak")
    try:
        for index in (2, 1):
            older = file.with_name(f"{file.name}.bak.{index}")
            newer = (
                backup
                if index == 1
                else file.with_name(f"{file.name}.bak.{index - 1}")
            )
            if newer.exists():
                shutil.copy2(newer, older)
        shutil.copy2(file, backup)
        os.chmod(backup, 0o600)
    except OSError as exc:  # pragma: no cover - best effort
        log.warning("Could not back up %s: %s", file, exc)


def file_mode(path: str | Path) -> int | None:
    """The file's permission bits, or None if it does not exist."""
    try:
        return os.stat(path).st_mode & 0o777
    except OSError:
        return None


def secure_permissions(path: str | Path) -> bool:
    """Tighten a `.env` to 0600. Returns True if a change was made."""
    current = file_mode(path)
    if current is None or current == 0o600:
        return False
    try:
        os.chmod(path, 0o600)
        log.warning("Tightened %s from %o to 0600", path, current)
        return True
    except OSError as exc:
        log.error("Could not chmod %s: %s", path, exc)
        return False


def _quote(value: str) -> str:
    """Quote only when needed, so the file stays readable.

    The escape scheme (backslash before ``\\`` and ``"``) is exactly what
    `config.parse_env_value` reverses.
    """
    if value == "":
        return '""'
    if re.search(r"[\s#\"'$`\\]", value):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def _stamp() -> str:
    return time.strftime("%Y-%m-%d")
