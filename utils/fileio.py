"""Atomic file writes with unique temporaries.

Every store in this project (accounts, audit prune, .env, probe overlay) used
to write to a *fixed* `<name>.tmp` beside the target. Two concurrent writers
would open the same inode, truncate each other, and one `os.replace` could
remove the path while the other still held it — observed as PermissionError on
Windows and silent corruption risk on Linux. `tempfile.mkstemp` gives each
writer its own file in the same directory (same filesystem, so the final
rename stays atomic).
"""

from __future__ import annotations

import contextlib
import os
import tempfile
from pathlib import Path


def atomic_write_text(path: str | Path, text: str, mode: int = 0o600) -> None:
    """Write `text` to `path` atomically, at `mode`, fsynced.

    The permission bits are applied to the descriptor before any content is
    written, so there is no window where the data exists world-readable. On
    failure the temporary is removed and the original file is untouched — the
    replace happens only after a successful flush+fsync.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    temp_path = Path(temporary)
    closed = False
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            closed = True  # fdopen owns the descriptor from here
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
        if not hasattr(os, "fchmod"):  # pragma: no cover - Windows
            with contextlib.suppress(OSError):
                os.chmod(target, mode)
        _fsync_directory(target.parent)
    except BaseException:
        if not closed:
            with contextlib.suppress(OSError):
                os.close(descriptor)
        with contextlib.suppress(OSError):
            temp_path.unlink()
        raise


def _fsync_directory(directory: Path) -> None:
    """Persist the rename itself. POSIX only; a no-op elsewhere."""
    if not hasattr(os, "O_DIRECTORY"):  # pragma: no cover - Windows
        return
    try:
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    except OSError:  # pragma: no cover
        return
    try:
        os.fsync(descriptor)
    except OSError:  # pragma: no cover
        pass
    finally:
        os.close(descriptor)
