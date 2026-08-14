"""Render tests for the admin pages, and for the access guard itself.

The unauthenticated cases are the security tests. `require_admin()` calls
`st.stop()`, which halts the script *before* any privileged widget is created —
a page that renders its controls and merely disables them has still sent their
contents to the browser. Asserting "no widgets were produced" keeps that true.

Sessions are now validated against the account store on every check, so a fake
in-memory session is no longer enough: these tests create a real backing
account and stamp the session with the account's `session_version`. That is
itself the regression test for finding 4 — a session whose account has been
changed underneath it is refused.
"""

from __future__ import annotations

import os
import time
from dataclasses import replace
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent

GUARDED_PAGES = [
    "admin_actions.py",
    "admin_updates.py",
    "admin_keys.py",
    "admin_notifications.py",
    "admin_smart.py",
    "admin_probes.py",
    "admin_accounts.py",
    "admin_audit.py",
]

ALL_ADMIN_PAGES = GUARDED_PAGES + ["admin_signin.py"]

ADMIN_PASSWORD = "a sufficiently long password"


@pytest.fixture(scope="module", autouse=True)
def _isolated_admin_state(tmp_path_factory):
    """Point every admin store at a temp directory before anything imports it."""
    directory = tmp_path_factory.mktemp("adminstate")
    os.environ["ADMIN_ACCOUNTS_PATH"] = str(directory / "accounts.json")
    os.environ["ADMIN_AUDIT_PATH"] = str(directory / "audit.log")
    os.environ["STREAMANATOR_ENV_FILE"] = str(directory / ".env")
    os.environ["HISTORY_DB_PATH"] = str(directory / "history.sqlite3")
    os.environ["NOTIFICATION_CONFIG_PATH"] = str(directory / "notifications.json")
    os.environ["HISTORY_SAMPLE_INTERVAL"] = "3600"

    import config

    config.reload_settings()

    from admin import probes_config

    probes_config.OVERLAY_PATH = directory / "probes.json"

    # cache_resource survives between AppTest instances in one process; the
    # cached stores must be dropped or they keep their old paths.
    from core import runtime

    runtime.settings.clear()
    runtime.account_store.clear()
    runtime.audit_log.clear()
    runtime.notification_store.clear()

    _ensure_accounts()
    yield directory


def _ensure_accounts() -> None:
    """Create the admin and break-glass accounts the signed-in tests assume."""
    from core.runtime import account_store

    store = account_store()
    if store.get("tester") is None:
        store.create_admin("tester", ADMIN_PASSWORD, note="render tests")
    if store.breakglass_account() is None:
        store.create_breakglass()


def _run(page: str, session=None) -> AppTest:
    app = AppTest.from_file(
        str(PACKAGE_ROOT / "app_pages" / page), default_timeout=120
    )
    if session is not None:
        from auth.session import SESSION_KEY

        app.session_state[SESSION_KEY] = session
    app.run()
    return app


def _assert_clean(app: AppTest, page: str) -> None:
    if app.exception:
        messages = "\n".join(
            f"{e.type}: {e.message}\n{e.stack_trace}" for e in app.exception
        )
        pytest.fail(f"{page} raised:\n{messages}")


def _admin_session(breakglass: bool = False):
    """A session backed by a real account, so store validation accepts it."""
    from auth.session import AdminSession
    from core.runtime import account_store

    store = account_store()
    if breakglass:
        account = store.breakglass_account()
    else:
        account = store.get("tester")
    now = time.time()
    return AdminSession(
        username=account.username,
        role=account.role,
        authenticated_at=now,
        last_seen_at=now,
        breakglass=breakglass,
        codes_remaining=account.codes_remaining if breakglass else None,
        session_version=account.session_version,
    )


# ---------------------------------------------------------------------------
# The guard
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("page", GUARDED_PAGES)
def test_admin_page_stops_when_not_signed_in(page: str):
    app = _run(page)
    _assert_clean(app, page)
    text = " ".join(block.value for block in app.markdown) + " ".join(
        block.value for block in app.info
    )
    assert "Sign in" in text or "sign in" in text


@pytest.mark.parametrize("page", GUARDED_PAGES)
def test_admin_page_creates_no_controls_when_not_signed_in(page: str):
    """The guard must halt the script, not merely disable the widgets."""
    app = _run(page)
    _assert_clean(app, page)
    assert len(app.button) == 0, f"{page} created buttons before authenticating"
    assert len(app.text_input) == 0, f"{page} created inputs before authenticating"
    assert len(app.selectbox) == 0


@pytest.mark.parametrize("page", GUARDED_PAGES)
def test_admin_page_renders_when_signed_in(page: str):
    app = _run(page, session=_admin_session())
    _assert_clean(app, page)
    assert app.markdown or app.dataframe or app.metric


def test_smart_setup_reports_verified_exporter_as_active(monkeypatch):
    """The setup page must test the data path, not just local smartctl.

    A working exporter used to sit beside a red "SMART is not readable" card
    because that card unconditionally tried the local sudo route.
    """
    import config
    from core import runtime
    from services import prometheus as prometheus_service, smart

    configured = config.Settings()
    configured = replace(
        configured,
        prometheus=replace(
            configured.prometheus, url="http://127.0.0.1:9090"
        ),
    )

    class AvailablePrometheus:
        url = "http://127.0.0.1:9090"

        def available(self, recheck_after=30.0):
            return True

    disk = smart.SmartDisk(
        serial=config.CRC_WATCH_SERIAL,
        model="ST8000VN002-2ZM188",
        device="sde",
        passed=True,
        temperature_celsius=36.0,
        udma_crc_errors=5670.0,
        source="prometheus:smartctl_exporter",
    )
    local_calls: list[bool] = []

    monkeypatch.setattr(config, "get_settings", lambda: configured)
    monkeypatch.setattr(runtime, "prometheus_client", AvailablePrometheus)
    monkeypatch.setattr(
        prometheus_service,
        "detect_features",
        lambda client: {"smartctl_exporter": True},
    )
    monkeypatch.setattr(
        smart,
        "collect_smart_from_prometheus",
        lambda client: {disk.serial: disk},
    )
    monkeypatch.setattr(
        smart,
        "collect_smart_local",
        lambda *args: local_calls.append(True) or {},
    )

    app = _run("admin_smart.py", session=_admin_session())
    _assert_clean(app, "admin_smart.py")

    assert local_calls == []
    assert any(
        "SMART is readable from Prometheus / smartctl_exporter" in block.value
        for block in app.success
    )
    assert any("No dashboard sudo access is required" in block.value for block in app.success)
    assert any("SMARTCTL_SUDO=true` is not needed" in block.value for block in app.info)


def test_expired_session_is_refused():
    """An old session must not survive just because session_state holds it."""
    from auth.session import ADMIN_ABSOLUTE_TIMEOUT, AdminSession
    from core.runtime import account_store

    account = account_store().get("tester")
    stale = time.time() - ADMIN_ABSOLUTE_TIMEOUT - 60
    session = AdminSession(
        username="tester",
        role="admin",
        authenticated_at=stale,
        last_seen_at=stale,
        session_version=account.session_version,
    )
    app = _run("admin_keys.py", session=session)
    _assert_clean(app, "admin_keys.py")
    assert len(app.button) == 0


def test_idle_session_is_refused():
    from auth.session import ADMIN_IDLE_TIMEOUT, AdminSession
    from core.runtime import account_store

    account = account_store().get("tester")
    now = time.time()
    session = AdminSession(
        username="tester",
        role="admin",
        authenticated_at=now,
        last_seen_at=now - ADMIN_IDLE_TIMEOUT - 60,
        session_version=account.session_version,
    )
    app = _run("admin_accounts.py", session=session)
    _assert_clean(app, "admin_accounts.py")
    assert len(app.button) == 0


def test_session_with_stale_version_is_refused():
    """Finding 4: bumping the account's session_version kills live sessions."""
    from auth.session import AdminSession
    from core.runtime import account_store

    account = account_store().get("tester")
    now = time.time()
    session = AdminSession(
        username="tester",
        role="admin",
        authenticated_at=now,
        last_seen_at=now,
        # One behind the account — as if the password had been reset elsewhere.
        session_version=account.session_version - 1,
    )
    app = _run("admin_actions.py", session=session)
    _assert_clean(app, "admin_actions.py")
    assert len(app.button) == 0


def test_session_for_deleted_account_is_refused():
    from auth.session import AdminSession

    now = time.time()
    session = AdminSession(
        username="ghost",
        role="admin",
        authenticated_at=now,
        last_seen_at=now,
    )
    app = _run("admin_keys.py", session=session)
    _assert_clean(app, "admin_keys.py")
    assert len(app.button) == 0


def test_breakglass_session_reaches_the_admin_pages():
    """Break-glass carries the same authority — the controls are time and
    visibility, not capability."""
    app = _run("admin_actions.py", session=_admin_session(breakglass=True))
    _assert_clean(app, "admin_actions.py")
    assert app.markdown


# ---------------------------------------------------------------------------
# Sign-in page
# ---------------------------------------------------------------------------


def test_signin_page_renders_without_a_session():
    app = _run("admin_signin.py")
    _assert_clean(app, "admin_signin.py")


def test_signin_page_shows_the_session_when_signed_in():
    app = _run("admin_signin.py", session=_admin_session())
    _assert_clean(app, "admin_signin.py")
    assert any("tester" in block.value for block in app.success)


# ---------------------------------------------------------------------------
# Navigation wiring
# ---------------------------------------------------------------------------


def test_entry_point_builds_navigation_without_a_session():
    app = AppTest.from_file(str(PACKAGE_ROOT / "app.py"), default_timeout=120)
    app.run()
    if app.exception:
        messages = "\n".join(f"{e.type}: {e.message}" for e in app.exception)
        pytest.fail(f"app.py raised:\n{messages}")


def test_require_auth_for_all_hides_the_monitoring_pages():
    """When the whole dashboard is gated, the monitoring pages must not be
    registered at all — hiding them in the sidebar is not a control, because a
    registered page is reachable by URL regardless of what is drawn."""
    import config
    from core import runtime

    os.environ["REQUIRE_AUTH_FOR_ALL"] = "true"
    config.reload_settings()
    runtime.settings.clear()
    try:
        app = AppTest.from_file(str(PACKAGE_ROOT / "app.py"), default_timeout=120)
        app.run()
        if app.exception:
            messages = "\n".join(f"{e.type}: {e.message}" for e in app.exception)
            pytest.fail(f"app.py raised:\n{messages}")
        # An account exists, so the gated entry point lands on the sign-in
        # form (a password field), never on a monitoring page. The absence of
        # any monitoring content is the property under test.
        headers = " ".join(block.value for block in app.markdown)
        assert "Admin sign-in" in headers, "did not land on the sign-in page"
        assert not any(
            "Overview" in block.value or "health score" in block.value.lower()
            for block in app.markdown
        ), "a monitoring page rendered while REQUIRE_AUTH_FOR_ALL was set"
    finally:
        os.environ["REQUIRE_AUTH_FOR_ALL"] = "false"
        config.reload_settings()
        runtime.settings.clear()


def test_breakglass_banner_appears_on_every_page():
    """A break-glass login must be impossible to miss — the banner reads from
    the audit log, so it shows for every viewer, not just the tab that used
    the emergency access."""
    from core.runtime import audit_log

    audit_log().record(
        "auth.signin",
        "breakglass",
        "breakglass",
        "success",
        severity="critical",
        detail="BREAK-GLASS access granted; 9 codes remaining",
        breakglass=True,
    )
    app = AppTest.from_file(str(PACKAGE_ROOT / "app.py"), default_timeout=120)
    app.run()
    assert any("Break-glass" in block.value for block in app.error)


# ---------------------------------------------------------------------------
# Creating a second admin from the console
#
# Until now the only route was `scripts/admin_bootstrap.py add-admin` over SSH.
# The store already supported it; nothing surfaced it.
# ---------------------------------------------------------------------------


def test_accounts_page_offers_admin_creation():
    app = _run("admin_accounts.py", session=_admin_session())
    _assert_clean(app, "admin_accounts.py")
    labels = [field.label for field in app.text_input]
    assert "Username" in labels
    assert "Password" in labels
    assert "Password again" in labels


def test_break_glass_session_can_also_create_an_admin():
    """The recovery path: break-glass in, working admin out.

    Break-glass has no password of its own, so refusing this would leave SSH
    as the only way back to normal access — the situation break-glass exists
    to avoid.
    """
    app = _run("admin_accounts.py", session=_admin_session(breakglass=True))
    _assert_clean(app, "admin_accounts.py")
    assert "Username" in [field.label for field in app.text_input]


def test_created_admin_can_sign_in():
    """The capability the page is claiming, asserted at the store."""
    from core.runtime import account_store

    store = account_store()
    store.create_admin("colleague", "a sufficiently long password")

    result = store.verify_password_factor("colleague", "a sufficiently long password")

    assert result.ok, getattr(result, "reason", result)
    assert store.get("colleague").role == "admin"


def test_duplicate_admin_name_is_refused():
    from core.runtime import account_store

    store = account_store()
    store.create_admin("taken", "a sufficiently long password")
    with pytest.raises(ValueError, match="already exists"):
        store.create_admin("taken", "another sufficiently long password")


def test_weak_password_is_refused_for_a_new_admin():
    from core.runtime import account_store

    with pytest.raises(ValueError):
        account_store().create_admin("weakling", "short")
