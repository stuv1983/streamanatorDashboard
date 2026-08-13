"""Sign in to the administrative surface.

Two doors, and the page is explicit about which one is which. The everyday
door takes a password (and an authenticator code once enrolled). The emergency
door takes a single-use recovery code and is presented as what it is — a thing
you use when the first door is broken, that depletes, and that announces
itself everywhere afterwards.
"""

from __future__ import annotations

import streamlit as st

from auth import session as auth_session
from auth.accounts import LOW_CODE_WARNING, StoreCorruptError, StoreUnreadableError
from components.layout import page_header
from config import PROJECT_ROOT
from core.runtime import account_store, audit_log

store = account_store()
audit = audit_log()

#: Repair instructions are run over SSH on the host, so they must name the
#: directory this process is actually running from, not a path baked in here.
PROJECT_DIR = PROJECT_ROOT

page_header("Admin sign-in", "Privileged access to configuration and actions")

# A corrupt store fails closed — no sign-in, no mutation, and an instruction
# instead of a stack trace. Authenticating against a file we cannot fully
# parse would mean guessing which accounts exist.
try:
    store.load()
except StoreUnreadableError as exc:
    # Access, not content. The accounts are almost certainly intact, so the
    # advice must not be "delete it": that would throw away every password
    # hash, TOTP enrolment and break-glass code to work around a chmod.
    st.error(
        f"**The account store cannot be opened.** {exc}",
        icon=":material/lock:",
    )
    st.markdown(
        "This is a file-permission fault, not corruption — the accounts "
        "themselves are intact. It usually means the file was created or "
        "restored by a different user (a `sudo` run of the bootstrap script "
        "or a state restore). **Do not delete it.** Over SSH, hand it back to "
        "the account the dashboard runs as:"
    )
    st.code(
        f"cd {PROJECT_DIR}\n"
        "ls -l var/                       # confirm the owner\n"
        "sudo chown $(whoami): var var/accounts.json\n"
        "chmod 700 var && chmod 600 var/accounts.json\n"
        "sudo systemctl restart streamanator-dashboard",
        language="bash",
    )
    st.caption(
        ":gray[Check the rest of `var/` at the same time — audit.log, "
        "history.sqlite3, notifications.json and probes.json are written by "
        "the same process and go wrong together.]"
    )
    st.stop()
except StoreCorruptError as exc:
    st.error(
        f"**The account store cannot be read.** {exc}",
        icon=":material/report:",
    )
    st.markdown(
        "No sign-in is possible until this is repaired, and nothing will "
        "write to the file in this state. Over SSH, either restore "
        "`var/accounts.json` from a backup, or delete it and re-run:"
    )
    st.code(
        f"cd {PROJECT_DIR}\n.venv/bin/python scripts/admin_bootstrap.py init",
        language="bash",
    )
    st.stop()

existing = auth_session.current_session()
if existing is not None:
    st.success(
        f"Signed in as **{existing.username}**"
        + (" via break-glass" if existing.breakglass else ""),
        icon=":material/check_circle:",
    )
    minutes, seconds = divmod(existing.seconds_remaining(), 60)
    st.caption(f"Session expires in {minutes}m {seconds:02d}s.")
    if st.button("Sign out", icon=":material/logout:"):
        username = auth_session.end_session()
        if username:
            audit.record(
                "auth.signout", username, existing.role, "success",
                breakglass=existing.breakglass,
            )
        st.rerun()
    st.stop()

message = auth_session.pop_auth_message()
if message:
    st.warning(message, icon=":material/timer_off:")

# ---------------------------------------------------------------------------
# Not bootstrapped yet
# ---------------------------------------------------------------------------

if not store.initialised():
    st.info(
        "No admin account exists yet.",
        icon=":material/person_add:",
    )
    st.markdown(
        "The first account is created from a shell, not from this page. A "
        "web-based setup wizard would leave a window where anyone who can "
        "reach this port could claim the admin account — and this service "
        "binds to the whole subnet."
    )
    st.markdown("**Run this over SSH:**")
    st.code(
        "cd /home/arm/projects/streamanator_dashboard\n"
        ".venv/bin/python scripts/admin_bootstrap.py init",
        language="bash",
    )
    st.caption(
        "It prompts for a username and password, then prints ten break-glass "
        "recovery codes once. Save those somewhere that does not depend on "
        "this server being reachable."
    )
    st.stop()

# ---------------------------------------------------------------------------
# Sign-in forms
# ---------------------------------------------------------------------------

normal, emergency = st.tabs(["Sign in", "Break-glass access"])

with normal:
    pending_user = st.session_state.get("_signin_user", "")
    needs_totp = bool(st.session_state.get("_signin_needs_totp"))

    with st.form("signin", clear_on_submit=False):
        username = st.text_input(
            "Username", value=pending_user, autocomplete="username"
        )
        password = st.text_input(
            "Password", type="password", autocomplete="current-password"
        )
        totp_code = ""
        if needs_totp:
            totp_code = st.text_input(
                "Authenticator code",
                max_chars=6,
                placeholder="000000",
                help="The six-digit code from your authenticator app.",
            )
        submitted = st.form_submit_button("Sign in", icon=":material/login:", type="primary")

    if submitted:
        result = store.authenticate(username, password, totp_code)
        if result.ok and result.account is not None:
            auth_session.begin_session(result.account)
            st.session_state.pop("_signin_needs_totp", None)
            st.session_state.pop("_signin_user", None)
            audit.record(
                "auth.signin", result.account.username, result.account.role,
                "success", severity="notice",
                detail="password" + (" + totp" if result.account.totp_enrolled else ""),
            )
            st.rerun()
        elif result.totp_required:
            # Not a failure: the password was accepted and the form now needs
            # a second field. Remembering the username avoids retyping it.
            st.session_state["_signin_needs_totp"] = True
            st.session_state["_signin_user"] = username
            if totp_code:
                st.error(result.reason, icon=":material/error:")
                audit.record(
                    "auth.signin", username, "admin", "failure",
                    severity="warning", detail="invalid totp code",
                )
            st.rerun()
        else:
            if result.locked_seconds:
                minutes, seconds = divmod(result.locked_seconds, 60)
                st.error(
                    f"{result.reason} Locked for another {minutes}m {seconds:02d}s.",
                    icon=":material/lock_clock:",
                )
            else:
                st.error(result.reason, icon=":material/error:")
            audit.record(
                "auth.signin", username or "(blank)", "unknown", "failure",
                severity="warning", detail=result.reason,
            )

    st.caption(
        "Five failed attempts lock the account, with the lockout lengthening "
        "on repeated failures. Locked out for real? Clear it over SSH with "
        "`scripts/admin_bootstrap.py unlock <name>`."
    )

with emergency:
    st.warning(
        "**This is the emergency path.** Use it only when the normal account "
        "will not let you in — a lost authenticator, a forgotten password, a "
        "lockout you cannot wait out.",
        icon=":material/e911_emergency:",
    )

    breakglass = store.breakglass_account()
    if breakglass is None:
        st.info(
            "No break-glass account is configured.", icon=":material/info:"
        )
        st.code(
            ".venv/bin/python scripts/admin_bootstrap.py breakglass",
            language="bash",
        )
    else:
        remaining = breakglass.codes_remaining
        if remaining == 0:
            st.error(
                "Every recovery code has been used. Reissue a set over SSH "
                "before you need one.",
                icon=":material/block:",
            )
        elif remaining < LOW_CODE_WARNING:
            st.warning(
                f"Only {remaining} recovery code(s) left. Reissue a set soon.",
                icon=":material/warning:",
            )

        with st.form("breakglass_signin", clear_on_submit=True):
            code = st.text_input(
                "Recovery code",
                placeholder="XXXX-XXXX-XXXX",
                help="Case and dashes do not matter. Each code works once.",
            )
            go = st.form_submit_button(
                "Use recovery code", icon=":material/vpn_key:"
            )

        if go:
            result = store.authenticate(breakglass.username, code)
            if result.ok and result.account is not None:
                auth_session.begin_session(
                    result.account, codes_remaining=result.codes_remaining
                )
                audit.record(
                    "auth.signin",
                    result.account.username,
                    "breakglass",
                    "success",
                    severity="critical",
                    detail=(
                        f"BREAK-GLASS access granted; "
                        f"{result.codes_remaining} codes remaining"
                    ),
                    breakglass=True,
                )
                st.rerun()
            else:
                st.error(result.reason, icon=":material/error:")
                audit.record(
                    "auth.signin", breakglass.username, "breakglass", "failure",
                    severity="critical", detail="invalid recovery code",
                    breakglass=True,
                )

        st.markdown(
            f"""
**What happens when you use one:**

- The code is consumed permanently — {remaining} would become {max(0, remaining - 1)}.
- A red banner appears on **every page** of the dashboard until dismissed.
- The event is written to the audit log at critical severity, and to journald.
- The session lasts 30 minutes maximum, and 10 minutes idle — much shorter
  than a normal admin session.

Break-glass carries the same authority as an admin account. Restricting what
it can do would defeat its purpose: an emergency credential that cannot fix
the emergency is decoration. The controls on it are visibility and time, not
capability.
"""
    )
