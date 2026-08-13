"""Streamlit-side session handling for authenticated admin access.

Sessions live in `st.session_state`, which is *server-side* state keyed to a
websocket connection — the browser holds a connection identifier, not a token
it could forge or replay elsewhere.

A session is **re-validated against the account store on every check**, not
just against its own clocks. The first version trusted the dataclass alone,
which meant disabling an account, resetting its password, or reissuing the
break-glass codes left existing sessions fully alive for up to four hours —
the exact sessions those actions exist to shut out. Each account carries a
`session_version`; security-sensitive changes bump it, and any session created
before the bump is refused on its next request.

Two clocks bound every session:

* **Idle timeout** — reset only by deliberate interaction via `touch()`, never
  by a rerun. Auto-refresh reruns the script every few seconds; if reruns
  counted as activity, an idle timeout could never fire on a dashboard whose
  whole purpose is refreshing itself.
* **Absolute timeout** — a hard ceiling regardless of activity.

Break-glass sessions get much shorter values for both.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, replace

import streamlit as st

from auth.accounts import Account, AccountStore, StoreCorruptError

SESSION_KEY = "_admin_session"

#: Admin: comfortable for a maintenance window, bounded for an abandoned tab.
ADMIN_IDLE_TIMEOUT = 30 * 60
ADMIN_ABSOLUTE_TIMEOUT = 4 * 60 * 60

#: Break-glass: long enough to fix the thing that broke, short enough that a
#: forgotten session is not a standing back door.
BREAKGLASS_IDLE_TIMEOUT = 10 * 60
BREAKGLASS_ABSOLUTE_TIMEOUT = 30 * 60

#: How long a step-up (password re-entry) stays valid for further dangerous
#: actions. Short on purpose: this is the sudo timestamp, not a second login.
STEP_UP_WINDOW = 120


@dataclass(frozen=True)
class AdminSession:
    username: str
    role: str
    authenticated_at: float
    last_seen_at: float
    breakglass: bool = False
    stepped_up_at: float | None = None
    #: Codes left at login time. Shown in the sidebar for break-glass.
    codes_remaining: int | None = None
    #: The account's session_version at sign-in. Compared against the store
    #: on every validation; a mismatch means the account changed underneath
    #: this session and the session must die.
    session_version: int = 0

    @property
    def idle_timeout(self) -> int:
        return BREAKGLASS_IDLE_TIMEOUT if self.breakglass else ADMIN_IDLE_TIMEOUT

    @property
    def absolute_timeout(self) -> int:
        return (
            BREAKGLASS_ABSOLUTE_TIMEOUT
            if self.breakglass
            else ADMIN_ABSOLUTE_TIMEOUT
        )

    def expiry_reason(self, now: float | None = None) -> str | None:
        moment = time.time() if now is None else now
        if moment - self.authenticated_at > self.absolute_timeout:
            return "Session expired (maximum session length reached)."
        if moment - self.last_seen_at > self.idle_timeout:
            return "Session expired after a period of inactivity."
        return None

    def seconds_remaining(self, now: float | None = None) -> int:
        moment = time.time() if now is None else now
        return max(
            0,
            int(
                min(
                    self.absolute_timeout - (moment - self.authenticated_at),
                    self.idle_timeout - (moment - self.last_seen_at),
                )
            ),
        )

    def stepped_up(self, now: float | None = None) -> bool:
        if self.stepped_up_at is None:
            return False
        moment = time.time() if now is None else now
        return (moment - self.stepped_up_at) <= STEP_UP_WINDOW


def session_invalid_reason(
    session: AdminSession, account: Account | None, now: float | None = None
) -> str | None:
    """Why this session must be refused, or None if it is still good.

    Pure, so every branch is unit-testable without Streamlit. The account
    lookup happens at the caller.
    """
    if account is None:
        return "This account no longer exists."
    if account.disabled:
        return "This account has been disabled."
    if account.role not in ("admin", "breakglass") or account.role != session.role:
        return "This account's role has changed."
    if account.session_version != session.session_version:
        return (
            "Your session was invalidated by a security change to the "
            "account (password reset, two-factor change, or code reissue)."
        )
    return session.expiry_reason(now)


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


def begin_session(account: Account, codes_remaining: int | None = None) -> AdminSession:
    now = time.time()
    session = AdminSession(
        username=account.username,
        role=account.role,
        authenticated_at=now,
        last_seen_at=now,
        breakglass=account.role == "breakglass",
        codes_remaining=codes_remaining,
        session_version=account.session_version,
    )
    st.session_state[SESSION_KEY] = session
    return session


def _store() -> AccountStore:
    # Function-level import: auth.session -> core.runtime -> auth.accounts is
    # acyclic, but only if runtime is not imported at module load.
    from core.runtime import account_store

    return account_store()


def current_session() -> AdminSession | None:
    """The live, store-validated session, or None.

    Fails closed on every uncertainty: an unreadable or corrupt account store
    means no session is valid, because "cannot check" and "checked out fine"
    must never look the same to the privileged surface.
    """
    session = st.session_state.get(SESSION_KEY)
    if not isinstance(session, AdminSession):
        if session is not None:
            st.session_state.pop(SESSION_KEY, None)
        return None
    try:
        account = _store().get(session.username)
    except (StoreCorruptError, OSError) as exc:
        st.session_state.pop(SESSION_KEY, None)
        st.session_state["_auth_message"] = (
            f"Signed out: the account store could not be verified ({exc})."
        )
        return None
    reason = session_invalid_reason(session, account)
    if reason:
        st.session_state.pop(SESSION_KEY, None)
        st.session_state["_auth_message"] = reason
        return None
    return session


def touch() -> None:
    """Record deliberate interaction, resetting the idle clock.

    Call this from form submissions and privileged actions — never from page
    render, or auto-refresh would keep every session alive indefinitely.
    """
    session = st.session_state.get(SESSION_KEY)
    if isinstance(session, AdminSession):
        st.session_state[SESSION_KEY] = replace(session, last_seen_at=time.time())


def end_session() -> str | None:
    session = st.session_state.pop(SESSION_KEY, None)
    if isinstance(session, AdminSession):
        return session.username
    return None


def is_authenticated() -> bool:
    return current_session() is not None


def is_admin() -> bool:
    """True for both roles.

    Break-glass exists precisely to do admin work when the admin path is
    broken, so it carries the same authority — the difference is in how loudly
    it is recorded and how quickly it expires, not in what it can do.
    """
    return current_session() is not None


# ---------------------------------------------------------------------------
# Step-up authentication
# ---------------------------------------------------------------------------


def grant_step_up() -> None:
    session = current_session()
    if session is not None:
        st.session_state[SESSION_KEY] = replace(
            session, stepped_up_at=time.time(), last_seen_at=time.time()
        )


def verify_step_up(store: AccountStore, password: str) -> tuple[bool, str]:
    """Re-verify the signed-in identity before a dangerous action.

    Uses `verify_password_factor`, not full `authenticate()` — the full path
    demands a TOTP code once one is enrolled, which made step-up permanently
    impossible for TOTP-enrolled admins (the audit's finding 15: every
    dangerous action was unreachable for exactly the accounts that had
    enabled two-factor). The session proved the second factor at sign-in;
    step-up re-proves *presence* with the password.

    Break-glass sessions cannot step up with a code — burning a second
    single-use code to reboot a server would exhaust the emergency supply
    during the emergency. Holding a live break-glass session is sufficient:
    it is already short-lived and loud.
    """
    session = current_session()
    if session is None:
        return False, "Not signed in."
    if session.breakglass:
        grant_step_up()
        return True, "Break-glass session — confirmation accepted."
    result = store.verify_password_factor(session.username, password)
    if result.ok:
        grant_step_up()
        return True, "Confirmed."
    if result.locked_seconds:
        return False, f"{result.reason} Locked for {result.locked_seconds}s."
    return False, result.reason or "Incorrect password."


# ---------------------------------------------------------------------------
# Break-glass surfacing — audit-log backed, visible to every viewer
# ---------------------------------------------------------------------------


def render_breakglass_banner(audit, session: AdminSession | None) -> None:
    """Show an unacknowledged break-glass login on every page, in every tab.

    Backed by the audit log, not `st.session_state` — session state is scoped
    to one browser tab, so the first version's banner was visible only to the
    person who used the emergency access and to nobody it was meant to warn.
    The acknowledgement is an audit event too, writable only from a live
    admin session, so the record of who dismissed the warning survives.
    """
    try:
        latest = audit.latest(action="auth.signin", breakglass=True, outcome="success")
    except Exception:  # noqa: BLE001 - a broken audit store must not hide pages
        return
    if latest is None:
        return
    try:
        acknowledged = audit.latest(action="auth.breakglass_ack")
    except Exception:  # noqa: BLE001
        acknowledged = None
    if acknowledged is not None and acknowledged.at >= latest.at:
        return

    st.error(
        f"**Break-glass access used {latest.when}** by `{latest.actor}`. "
        f"{latest.detail} "
        "This path is for emergencies only — if the normal admin account "
        "works, sign in with that instead and regenerate the codes.",
        icon=":material/e911_emergency:",
    )
    if session is not None:
        if st.button(
            "Acknowledge break-glass use",
            key="_ack_breakglass",
            icon=":material/check:",
        ):
            audit.record(
                "auth.breakglass_ack",
                session.username,
                session.role,
                "success",
                severity="warning",
                detail=f"Acknowledged the break-glass login of {latest.when}.",
                breakglass=session.breakglass,
            )
            st.rerun()
    else:
        st.caption(
            ":gray[Sign in under Admin to acknowledge and clear this banner.]"
        )


def pop_auth_message() -> str | None:
    return st.session_state.pop("_auth_message", None)
