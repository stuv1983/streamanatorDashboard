"""Accounts: passwords, authenticator enrolment, break-glass codes.

TOTP enrolment here is two-phase on purpose. The secret is generated, shown,
and only stored once a code produced from it verifies. Storing it first is how
people lock themselves out: the account starts demanding a code from an
authenticator that was never actually set up.
"""

from __future__ import annotations

import time

import streamlit as st

from auth import crypto
from auth import session as auth_session
from auth.accounts import LOCKOUT_THRESHOLD, LOW_CODE_WARNING
from components.admin_ui import require_admin, session_bar
from components.layout import page_header
from config import get_settings
from core.runtime import account_store, audit_log

current = require_admin("Accounts")
settings = get_settings()
store = account_store()
audit = audit_log()

page_header("Accounts", "Passwords, two-factor and emergency access")
session_bar(current)
st.divider()

from auth.accounts import StoreCorruptError  # noqa: E402

try:
    accounts = store.list_accounts()
    me = store.get(current.username)
except StoreCorruptError as exc:
    st.error(
        f"**The account store cannot be read.** {exc} No account changes are "
        "possible until it is repaired over SSH.",
        icon=":material/report:",
    )
    st.stop()

# ---------------------------------------------------------------------------
# Your own account
# ---------------------------------------------------------------------------

st.markdown("### Your account")

if me is None:
    st.error("Your account no longer exists in the store.", icon=":material/error:")
elif me.role == "breakglass":
    st.info(
        "You are signed in through break-glass. It has no password and no "
        "authenticator by design — the credential is the single-use code. "
        "Use this session to fix the admin account, then sign out.",
        icon=":material/e911_emergency:",
    )
else:
    columns = st.columns(3)
    with columns[0]:
        st.metric(
            "Two-factor",
            "enabled" if me.totp_enrolled else "not set up",
            border=True,
        )
    with columns[1]:
        changed = (
            time.strftime("%d %b %Y", time.localtime(me.password_changed_at))
            if me.password_changed_at
            else "unknown"
        )
        st.metric("Password set", changed, border=True)
    with columns[2]:
        seen = (
            time.strftime("%d %b %H:%M", time.localtime(me.last_login_at))
            if me.last_login_at
            else "—"
        )
        st.metric("Last sign-in", seen, border=True)

    password_tab, totp_tab = st.tabs(["Change password", "Authenticator app"])

    with password_tab:
        with st.form("change_password", clear_on_submit=True):
            existing = st.text_input(
                "Current password", type="password", autocomplete="current-password"
            )
            new = st.text_input(
                "New password", type="password", autocomplete="new-password"
            )
            again = st.text_input(
                "New password again", type="password", autocomplete="new-password"
            )
            st.caption(
                f"At least {crypto.MIN_PASSWORD_LENGTH} characters. Length is "
                "what resists guessing — a long passphrase beats a short one "
                "with punctuation in it."
            )
            change = st.form_submit_button("Change password", icon=":material/key:")

        if change:
            auth_session.touch()
            # verify_password_factor, not authenticate(): the full path would
            # demand a TOTP code here, and a wrong current password still
            # counts toward lockout as it should.
            verified = store.verify_password_factor(current.username, existing)
            if not verified.ok:
                st.error("Current password is incorrect.", icon=":material/error:")
            elif new != again:
                st.error("The new passwords do not match.", icon=":material/error:")
            else:
                try:
                    store.set_password(current.username, new)
                except ValueError as exc:
                    st.error(str(exc), icon=":material/error:")
                else:
                    audit.record(
                        "account.password_changed", current.username, current.role,
                        "success", severity="warning", target=current.username,
                        breakglass=current.breakglass,
                    )
                    st.success(
                        "Password changed. Every session — including this one "
                        "— is now signed out; sign in with the new password.",
                        icon=":material/check_circle:",
                    )

    with totp_tab:
        if me.totp_enrolled:
            st.success(
                "An authenticator is enrolled. Codes are required at sign-in.",
                icon=":material/check_circle:",
            )
            st.caption(
                "A used code cannot be replayed within its 30-second window — "
                "the last accepted step is recorded and refused on reuse."
            )
            if st.button("Remove authenticator", icon=":material/lock_open:"):
                store.disable_totp(current.username)
                audit.record(
                    "account.totp_disabled", current.username, current.role,
                    "success", severity="warning", target=current.username,
                    breakglass=current.breakglass,
                )
                st.rerun()
            st.caption(
                "Lost the device and cannot sign in? Recover over SSH with "
                "`scripts/admin_bootstrap.py disable-totp <name>`, or use a "
                "break-glass code."
            )
        else:
            secret = st.session_state.get("_totp_candidate")
            if secret is None:
                st.markdown(
                    "Adds a six-digit code to your sign-in, so a stolen "
                    "password alone is not enough."
                )
                if st.button("Set up authenticator", icon=":material/qr_code:"):
                    st.session_state["_totp_candidate"] = store.begin_totp_enrolment(
                        current.username
                    )
                    st.rerun()
            else:
                st.markdown("**1. Add this to your authenticator app**")
                st.caption(
                    "Choose 'enter a setup key' rather than scanning. Rendering "
                    "a QR code would mean another dependency for something "
                    "every app supports typing."
                )
                st.code(crypto.format_secret_for_entry(secret), language="text")
                with st.expander("Or paste this URI"):
                    st.code(
                        crypto.totp_provisioning_uri(
                            secret, current.username, settings.auth.totp_issuer
                        ),
                        language="text",
                    )

                st.markdown("**2. Confirm a code from the app**")
                st.caption(
                    "Nothing is saved until this works — an authenticator that "
                    "was set up wrong would otherwise lock you out."
                )
                with st.form("confirm_totp", clear_on_submit=True):
                    code = st.text_input(
                        "Six-digit code", max_chars=6, placeholder="000000"
                    )
                    confirm = st.form_submit_button(
                        "Confirm and enable", icon=":material/check:", type="primary"
                    )
                if confirm:
                    auth_session.touch()
                    if store.confirm_totp_enrolment(current.username, secret, code):
                        st.session_state.pop("_totp_candidate", None)
                        audit.record(
                            "account.totp_enrolled", current.username, current.role,
                            "success", severity="warning", target=current.username,
                            breakglass=current.breakglass,
                        )
                        st.success(
                            "Authenticator enabled.", icon=":material/check_circle:"
                        )
                        st.rerun()
                    else:
                        st.error(
                            "That code did not verify. Check the app's clock is "
                            "correct and try the next code.",
                            icon=":material/error:",
                        )
                if st.button("Cancel setup"):
                    st.session_state.pop("_totp_candidate", None)
                    st.rerun()

st.divider()

# ---------------------------------------------------------------------------
# Break-glass
# ---------------------------------------------------------------------------

st.markdown("### Break-glass account")

breakglass = store.breakglass_account()

if breakglass is None:
    st.warning(
        "No break-glass account exists. If you lose your password or "
        "authenticator, recovery will need shell access to this server.",
        icon=":material/warning:",
    )
else:
    columns = st.columns(3)
    with columns[0]:
        st.metric("Codes remaining", breakglass.codes_remaining, border=True)
    with columns[1]:
        st.metric("Times used", breakglass.recovery_codes_used_total, border=True)
    with columns[2]:
        used = (
            time.strftime("%d %b %H:%M", time.localtime(breakglass.last_login_at))
            if breakglass.last_login_at
            else "never"
        )
        st.metric("Last used", used, border=True)

    if breakglass.codes_remaining == 0:
        st.error(
            "No codes left. Reissue a set now — the emergency path is "
            "currently unavailable.",
            icon=":material/block:",
        )
    elif breakglass.codes_remaining < LOW_CODE_WARNING:
        st.warning(
            f"Only {breakglass.codes_remaining} left.", icon=":material/warning:"
        )

fresh = st.session_state.get("_fresh_codes")
if fresh:
    st.success(
        "**New recovery codes — shown once.** They are stored only as hashes, "
        "so this screen is the only place they will ever appear.",
        icon=":material/vpn_key:",
    )
    st.code("\n".join(f"{i:>2}. {code}" for i, code in enumerate(fresh, 1)), language="text")
    st.markdown(
        "Store these somewhere that does not depend on this server being up — "
        "a password manager on another device, or printed and kept with the "
        "router. Codes saved only on `streamanator` are useless in the "
        "emergency they exist for."
    )
    if st.button("I have saved them", type="primary", icon=":material/check:"):
        st.session_state.pop("_fresh_codes", None)
        st.rerun()
else:
    with st.expander("Issue a new set of recovery codes"):
        st.markdown(
            f"Generates {crypto.RECOVERY_CODE_COUNT} fresh single-use codes "
            "and **invalidates every existing one**, used or not."
        )
        typed = st.text_input(
            "Type `REISSUE` to confirm", key="reissue_phrase", placeholder="REISSUE"
        )
        if st.button(
            "Generate new codes",
            disabled=typed.strip() != "REISSUE",
            icon=":material/autorenew:",
            type="primary",
        ):
            # Server-side recheck: `disabled=` is client-side courtesy, and a
            # forged click event arrives without the phrase. Same rule as
            # confirm_and_run.
            if typed.strip() != "REISSUE":
                audit.record(
                    "action.refused", current.username, current.role, "blocked",
                    severity="warning", target="breakglass.reissue",
                    detail="REISSUE phrase failed server-side validation.",
                    breakglass=current.breakglass,
                )
                st.error("Type REISSUE before generating new codes.")
                st.stop()
            auth_session.touch()
            codes = store.create_breakglass()
            st.session_state["_fresh_codes"] = codes
            audit.record(
                "account.breakglass_issued", current.username, current.role,
                "success", severity="critical", target="breakglass",
                detail=f"{len(codes)} codes issued from the admin console",
                breakglass=current.breakglass,
            )
            st.rerun()

st.divider()

# ---------------------------------------------------------------------------
# All accounts
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Creating another admin
#
# Available to break-glass sessions as well as normal admins. Break-glass has
# no password of its own, so "recover the console after losing the admin
# password" has to end in creating a working admin account — refusing that here
# would leave SSH as the only way back in, which is the situation break-glass
# exists to avoid.
# ---------------------------------------------------------------------------

st.markdown("### Create an admin account")

with st.expander("New admin account"):
    if current.breakglass:
        st.warning(
            "You are signed in through break-glass. Creating an admin here is "
            "the intended way back to normal access — sign in as the new "
            "account afterwards and regenerate the break-glass codes, because "
            "the set you used is now spent.",
            icon=":material/vpn_key:",
        )
    st.caption(
        "The new account is a full admin: same privileged actions, same access "
        "to this page. It starts without an authenticator app — enrolling one "
        "is the new owner's first job, from their own session."
    )
    with st.form("create_admin", clear_on_submit=True):
        new_username = st.text_input(
            "Username",
            autocomplete="off",
            help="3–32 characters: letters, digits, dot, dash or underscore.",
        )
        new_password = st.text_input(
            "Password", type="password", autocomplete="new-password"
        )
        new_password_again = st.text_input(
            "Password again", type="password", autocomplete="new-password"
        )
        new_note = st.text_input(
            "Note (optional)",
            autocomplete="off",
            help="Who this account is for. Shown in the account list.",
        )
        st.caption(
            f":gray[At least {crypto.MIN_PASSWORD_LENGTH} characters, and not "
            "one of the well-known weak passwords.]"
        )
        create = st.form_submit_button(
            "Create admin", type="primary", icon=":material/person_add:"
        )

    if create:
        if new_password != new_password_again:
            st.error("The passwords do not match.", icon=":material/error:")
        else:
            try:
                created = store.create_admin(
                    new_username, new_password, note=new_note.strip()
                )
            except ValueError as exc:
                # create_admin raises for a weak password, a bad username and a
                # name that is already taken. All three are the operator's to
                # fix, so the message is shown as-is rather than generalised.
                st.error(str(exc), icon=":material/error:")
                audit.record(
                    "account.create_admin", current.username, current.role,
                    "failure", severity="warning", target=new_username.strip(),
                    detail=str(exc), breakglass=current.breakglass,
                )
            else:
                audit.record(
                    "account.create_admin", current.username, current.role,
                    "success", severity="warning", target=created.username,
                    breakglass=current.breakglass,
                )
                st.success(
                    f"Admin account **{created.username}** created. They can "
                    "sign in now, and should enrol an authenticator app "
                    "immediately.",
                    icon=":material/check:",
                )
                st.rerun()

st.markdown("### All accounts")

for account in accounts:
    with st.container(border=True):
        left, right = st.columns([3, 1], vertical_alignment="center")
        with left:
            badges = []
            if account.role == "breakglass":
                badges.append(":red-badge[break-glass]")
            else:
                badges.append(":blue-badge[admin]")
            if account.totp_enrolled:
                badges.append(":green-badge[:material/verified_user: 2FA]")
            if account.disabled:
                badges.append(":gray-badge[disabled]")
            if account.locked():
                minutes = account.lock_seconds_remaining() // 60
                badges.append(f":orange-badge[locked {minutes}m]")
            st.markdown(f"**{account.username}** {' '.join(badges)}")
            details = []
            if account.failed_attempts:
                details.append(
                    f"{account.failed_attempts}/{LOCKOUT_THRESHOLD} failed attempts"
                )
            if account.note:
                details.append(account.note)
            if details:
                st.caption(" · ".join(details))
        with right:
            if account.locked():
                if st.button(
                    "Unlock", key=f"unlock_{account.username}", width="stretch"
                ):
                    store.unlock(account.username)
                    audit.record(
                        "account.unlock", current.username, current.role, "success",
                        severity="warning", target=account.username,
                        breakglass=current.breakglass,
                    )
                    st.rerun()

st.caption(
    "Admin accounts can also be created over SSH with "
    "`scripts/admin_bootstrap.py add-admin <name>` — the route to use when "
    "nobody can sign in at all. Passwords are never accepted as command "
    "arguments there: they would land in shell history and the process list."
)
