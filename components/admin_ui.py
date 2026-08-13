"""Shared chrome for the admin pages: the guard, confirmations, command blocks.

The confirmation flow here is the important part. Every dangerous action goes
through `confirm_and_run`, which enforces the same sequence regardless of which
page called it: read what will happen, satisfy the step-up, type the phrase,
then act. Leaving each page to build its own confirmation is how one of them
ends up with a bare button.
"""

from __future__ import annotations

import time

import streamlit as st

from admin.actions import Action, Risk
from admin.runner import ActionResult, Capability, check_action, execute
from auth import session as auth_session
from core.runtime import account_store, audit_log


def require_admin(page_title: str = "Admin") -> auth_session.AdminSession:
    """Stop the page unless a live admin session exists.

    `st.stop()` rather than a redirect: it halts the script before any
    privileged widget is created. A page that renders its controls and merely
    disables them still ships their contents to the browser.
    """
    current = auth_session.current_session()
    if current is None:
        st.markdown(f"## {page_title}")
        message = auth_session.pop_auth_message()
        if message:
            st.warning(message, icon=":material/timer_off:")
        st.info(
            "Sign in from **Admin → Sign in** to reach this page.",
            icon=":material/lock:",
        )
        st.stop()
    return current


def session_bar(current: auth_session.AdminSession) -> None:
    """A compact identity + expiry strip, shown at the top of every admin page."""
    left, middle, right = st.columns([2, 2, 1], vertical_alignment="center")
    with left:
        icon = ":material/e911_emergency:" if current.breakglass else ":material/badge:"
        role = "break-glass" if current.breakglass else "admin"
        st.markdown(f"{icon} **{current.username}** · {role}")
    with middle:
        remaining = current.seconds_remaining()
        minutes, seconds = divmod(remaining, 60)
        tone = "red" if remaining < 300 else "gray"
        st.markdown(
            f":{tone}[Session expires in {minutes}m {seconds:02d}s]",
        )
    with right:
        if st.button("Sign out", width="stretch", icon=":material/logout:"):
            username = auth_session.end_session()
            if username:
                audit_log().record(
                    "auth.signout", username, current.role, "success",
                    breakglass=current.breakglass,
                )
            st.rerun()


def risk_badge(risk: Risk) -> None:
    colour = {
        Risk.SAFE: "green",
        Risk.DISRUPTIVE: "orange",
        Risk.DESTRUCTIVE: "red",
    }[risk]
    st.markdown(f":{colour}-badge[{risk.icon} {risk.label}]")


def capability_note(capability: Capability) -> None:
    """Explain why an action cannot run, and what to do instead."""
    if capability.ready:
        return
    if capability.needs_ssh:
        st.warning(capability.reason, icon=":material/terminal:")
        st.caption("Run this over SSH instead:")
        st.code(capability.manual_command, language="bash")
    else:
        st.error(capability.reason, icon=":material/block:")
        if capability.manual_command:
            st.caption("The command this would have run:")
            st.code(capability.manual_command, language="bash")


def show_result(result: ActionResult) -> None:
    if result.ok:
        st.success(
            f"{result.message} ({result.duration:.1f}s)", icon=":material/check_circle:"
        )
    else:
        st.error(result.message, icon=":material/error:")
    if result.output:
        with st.expander("Command output", expanded=not result.ok):
            st.code(result.output, language="text")
    st.caption(f"Ran: `{result.command}`")


def confirm_and_run(
    action: Action,
    current: auth_session.AdminSession,
    parameter_value: str | None = None,
    key_suffix: str = "",
) -> ActionResult | None:
    """Render the full confirmation sequence for one action.

    Returns the result when the action ran, otherwise None. Every gate is
    evaluated fresh on each rerun — none of them are cached in session state,
    so a confirmation cannot be "left ticked" from an earlier visit.
    """
    key = f"{action.key}{key_suffix}"
    capability = check_action(action, parameter_value)

    st.markdown(action.explain)
    if action.rationale:
        st.caption(f":gray[{action.rationale}]")

    if not capability.ready:
        capability_note(capability)
        return None

    with st.expander("Exactly what will run", expanded=False):
        st.code(capability.manual_command, language="bash")

    # -- Step-up ----------------------------------------------------------
    if action.needs_step_up and not current.stepped_up():
        st.caption(
            "This action needs your password again, even though you are "
            "signed in — the same reason `sudo` asks a second time."
        )
        with st.form(f"stepup_{key}", clear_on_submit=True):
            password = st.text_input(
                "Confirm your password",
                type="password",
                key=f"stepup_pw_{key}",
                autocomplete="current-password",
            )
            if st.form_submit_button("Confirm", icon=":material/lock_open:"):
                ok, message = auth_session.verify_step_up(account_store(), password)
                audit_log().record(
                    "auth.step_up",
                    current.username,
                    current.role,
                    "success" if ok else "failure",
                    severity="notice" if ok else "warning",
                    target=action.key,
                    breakglass=current.breakglass,
                )
                if ok:
                    st.rerun()
                else:
                    st.error(message, icon=":material/error:")
        return None

    # -- Typed phrase -----------------------------------------------------
    typed = ""
    phrase_ok = True
    if action.confirm_phrase:
        typed = st.text_input(
            f"Type `{action.confirm_phrase}` to enable the button",
            key=f"phrase_{key}",
            placeholder=action.confirm_phrase,
        )
        phrase_ok = typed.strip() == action.confirm_phrase
        if typed and not phrase_ok:
            st.caption(":red[Does not match yet.]")

    # -- Run --------------------------------------------------------------
    label = action.label if action.risk is Risk.SAFE else f"{action.label} now"
    clicked = st.button(
        label,
        key=f"run_{key}",
        type="primary" if action.risk is not Risk.SAFE else "secondary",
        disabled=not phrase_ok,
        icon=action.risk.icon,
    )
    if clicked:
        # Every gate is re-verified HERE, inside the click branch, against
        # live state. `disabled=` on the button is a courtesy to honest
        # browsers, not a control: Streamlit widget state arrives from the
        # client, and a modified client can deliver the click event without
        # ever satisfying the phrase field. The server is the only place a
        # security decision can live.
        live = auth_session.current_session()
        if live is None or live.username != current.username:
            st.error(
                "Your session is no longer valid. Sign in again.",
                icon=":material/lock:",
            )
            st.stop()
        if action.confirm_phrase and typed.strip() != action.confirm_phrase:
            audit_log().record(
                "action.refused",
                live.username,
                live.role,
                "blocked",
                severity="warning",
                target=action.key,
                detail="Confirmation phrase failed server-side validation "
                "(client-side gate was bypassed).",
                breakglass=live.breakglass,
            )
            st.error(
                "The confirmation phrase does not match.", icon=":material/block:"
            )
            return None
        if action.needs_step_up and not live.stepped_up():
            st.error(
                "Step-up confirmation has expired — confirm your password "
                "again.",
                icon=":material/lock_clock:",
            )
            st.rerun()
        auth_session.touch()
        with st.spinner(f"Running {action.label.lower()}…"):
            result = execute(
                action,
                actor=live.username,
                role=live.role,
                audit=audit_log(),
                parameter_value=parameter_value,
                breakglass=live.breakglass,
            )
        st.session_state[f"result_{key}"] = (time.time(), result)
        st.rerun()

    stored = st.session_state.get(f"result_{key}")
    if stored:
        at, result = stored
        # Results age out so a success banner from ten minutes ago is not
        # mistaken for the outcome of something just clicked.
        if time.time() - at < 300:
            show_result(result)
            return result
        st.session_state.pop(f"result_{key}", None)
    return None


def secret_display(value: str | None, fingerprint: str) -> str:
    """How a stored secret is shown: never the value, always identifiable."""
    if not value:
        return "not set"
    return f"set · {len(value)} chars · fingerprint `{fingerprint}`"
