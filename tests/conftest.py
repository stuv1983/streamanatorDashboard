"""Test configuration.

Puts the package root on sys.path so tests import the same way the app does
(`from health import rules`), without needing an installed package.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))


def _usable_temp_root() -> None:
    """Fall back to a project-local temp root when the system one is unreadable.

    pytest keeps its per-user scratch in ``$TMPDIR/pytest-of-<user>`` and, at
    the start of every run, *scans* that directory to find the highest numbered
    subdirectory. If the directory exists but cannot be listed, every single
    test that touches `tmp_path` errors in setup with a bare
    ``PermissionError: [WinError 5]``, pointing at pytest's own `pathlib.py`
    and naming no test of ours. It reads exactly like a mass test failure and
    is nothing of the kind — the suite never ran.

    That state is reachable on Windows without doing anything wrong: an
    interrupted run, an antivirus quarantine, or one `pytest` invoked from an
    elevated shell can leave the directory with an ACL its own owner cannot
    read or delete without taking ownership first.

    So: probe it. If it is fine — every Linux host, CI, and a healthy Windows
    box — change nothing and let pytest use the platform temp directory as
    usual. Only when the probe fails does this redirect the temp root into
    `var/`, which is gitignored, already the home for runtime state, and
    excluded from deploys.

    Setting `PYTEST_DEBUG_TEMPROOT` rather than `--basetemp` is deliberate:
    `--basetemp` wipes its target wholesale on every run and disables the
    numbered-directory retention that makes a failed run's files inspectable
    afterwards.
    """
    if os.environ.get("PYTEST_DEBUG_TEMPROOT"):
        return  # An explicit choice by whoever is running the suite.

    probe = Path(tempfile.gettempdir()) / f"pytest-of-{os.environ.get('USER') or os.environ.get('USERNAME') or 'unknown'}"
    if not probe.exists():
        return  # pytest will create it with sane permissions.
    try:
        next(os.scandir(probe), None)
    except OSError:
        fallback = PACKAGE_ROOT / "var" / "pytest-temp"
        fallback.mkdir(parents=True, exist_ok=True)
        os.environ["PYTEST_DEBUG_TEMPROOT"] = str(fallback)
        print(
            f"\nconftest: {probe} is not readable; using {fallback} for "
            "temporary files instead.",
            file=sys.stderr,
        )


_usable_temp_root()
