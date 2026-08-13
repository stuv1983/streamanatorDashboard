"""Smoke tests that every page renders without raising.

Uses Streamlit's `AppTest` harness to execute each page headlessly. This is the
test that catches the class of bug unit tests miss entirely: a bad f-string, a
wrong attribute name on a dataclass, or a `None` reaching a formatter — all of
which would surface as a red traceback on a real page.

These run against whatever host the tests execute on. On a non-Linux dev
machine most collectors return None and every page should degrade to UNKNOWN
cards rather than raising, which is itself the behaviour worth asserting: the
dashboard must survive missing data everywhere at once.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from streamlit.testing.v1 import AppTest

PAGES = [
    "overview.py",
    "network.py",
    "server.py",
    "storage.py",
    "raid.py",
    "docker.py",
    "vpn.py",
    "media.py",
    "applications.py",
    "backups.py",
    "security.py",
    "diagnostics.py",
]

PACKAGE_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module", autouse=True)
def _isolate_history(tmp_path_factory):
    """Point the history store at a temp file so tests never touch real data."""
    import os

    store = tmp_path_factory.mktemp("history") / "history.sqlite3"
    os.environ["HISTORY_DB_PATH"] = str(store)
    # Keep the sampler from doing slow network work during tests.
    os.environ["HISTORY_SAMPLE_INTERVAL"] = "3600"
    yield


@pytest.mark.parametrize("page", PAGES)
def test_page_renders_without_exception(page: str):
    """Every page must render, whatever the collectors return."""
    app = AppTest.from_file(str(PACKAGE_ROOT / "app_pages" / page), default_timeout=120)
    app.run()

    if app.exception:
        messages = "\n".join(
            f"{e.type}: {e.message}\n{e.stack_trace}" for e in app.exception
        )
        pytest.fail(f"{page} raised during render:\n{messages}")


@pytest.mark.parametrize("page", PAGES)
def test_page_produces_output(page: str):
    """A page that renders nothing is broken even if it does not raise."""
    app = AppTest.from_file(str(PACKAGE_ROOT / "app_pages" / page), default_timeout=120)
    app.run()
    produced = (
        len(app.markdown) + len(app.caption) + len(app.dataframe)
        + len(app.metric) + len(app.error) + len(app.warning) + len(app.info)
    )
    assert produced > 0, f"{page} rendered no visible elements"


def test_entry_point_builds_navigation():
    """app.py must construct its navigation and start the sampler cleanly."""
    app = AppTest.from_file(str(PACKAGE_ROOT / "app.py"), default_timeout=120)
    app.run()
    if app.exception:
        messages = "\n".join(f"{e.type}: {e.message}" for e in app.exception)
        pytest.fail(f"app.py raised during render:\n{messages}")


def test_snapshot_cache_returns_the_same_object_not_a_copy():
    """The snapshot must be cached by reference, not serialised.

    `st.cache_data` pickles every entry and hands back a fresh copy. On a live
    object graph that is wasteful, and it breaks outright when Streamlit's file
    watcher hot-reloads a module — which happens whenever the project is
    redeployed under a running server. The reloaded class no longer matches
    what pickle recorded, and every read then fails with
    UnserializableReturnValueError until the process restarts.

    `st.cache_resource` returns the identical object, so identity across two
    calls is the behavioural signature of the correct wiring. AppTest could not
    catch the original bug because it runs an in-memory cache backend that
    skips serialisation, so this checks the property directly.
    """
    from core.runtime import _cached_snapshot

    first = _cached_snapshot(0)
    second = _cached_snapshot(0)
    assert first is second, (
        "The snapshot cache returned a copy, which means it is pickling. "
        "Use st.cache_resource — see the docstring on _cached_snapshot."
    )
