"""Gmail delivery, alert subscriptions and weekly report scheduling."""

from __future__ import annotations

import streamlit as st

from admin.env_file import read_env_file, update_env_file
from auth.crypto import fingerprint
from components.admin_ui import require_admin, session_bar
from components.layout import page_header
from config import get_settings
from core.runtime import (
    audit_log,
    notification_store,
    notification_worker,
    reload_configuration,
)
from services.heartbeat import send_heartbeat, validate_ping_url
from services.notifications import (
    CATEGORY_LABELS,
    SEVERITY_LABELS,
    WEEKDAY_LABELS,
    NotificationPreferences,
    NotificationStoreError,
    build_test_message,
    parse_recipients,
    send_email,
    validate_email_address,
)
from utils.formatting import format_timestamp

current = require_admin("Email reports")
settings = get_settings()
audit = audit_log()
store = notification_store()

page_header(
    "Email reports",
    "Gmail alerts for faults, recoveries and a scheduled weekly health summary",
)
session_bar(current)
st.divider()

try:
    preferences, delivery_state = store.load()
except NotificationStoreError as exc:
    st.error(
        f"**Notification settings cannot be read.** {exc} Email delivery is "
        "disabled until the file is repaired or removed over SSH.",
        icon=":material/report:",
    )
    st.stop()

stored = read_env_file(settings.auth.env_file)
stored_user = stored.get("EMAIL_SMTP_USER", settings.email.username or "")
stored_password = stored.get("EMAIL_SMTP_APP_PASSWORD", "")

st.markdown("### Gmail account")
st.caption(
    "Use a Google app password, not the mailbox's normal password. The app "
    "password is stored in the protected `.env`, never in notification settings "
    "or the audit log. SMTP uses authenticated TLS on `smtp.gmail.com:465`."
)

with st.form("gmail_credentials", clear_on_submit=False):
    gmail_address = st.text_input(
        "Gmail address",
        value=stored_user,
        placeholder="streamanator.alerts@gmail.com",
        autocomplete="email",
    )
    app_password = st.text_input(
        "Google app password",
        type="password",
        value="",
        placeholder="unchanged — leave blank to keep the saved password"
        if stored_password
        else "16-character app password",
        help="Spaces shown by Google are removed before saving.",
    )
    save_gmail = st.form_submit_button(
        "Save Gmail settings", icon=":material/save:"
    )

if stored_password:
    st.caption(
        f":green-badge[:material/check: app password configured] "
        f"`{len(stored_password)} chars` · fingerprint "
        f"`{fingerprint(stored_password)}`"
    )

if save_gmail:
    try:
        address = validate_email_address(gmail_address)
        cleaned_password = app_password.replace(" ", "")
        if app_password and len(cleaned_password) != 16:
            raise ValueError("Google app passwords contain exactly 16 characters.")
        if not cleaned_password and not stored_password:
            raise ValueError("Enter the Google app password.")
        updates: dict[str, str | None] = {
            "EMAIL_SMTP_USER": address,
            "EMAIL_FROM": address,
        }
        if cleaned_password:
            updates["EMAIL_SMTP_APP_PASSWORD"] = cleaned_password
        changed = update_env_file(settings.auth.env_file, updates)
        if changed:
            reload_configuration()
            audit.record(
                "notifications.gmail_configured",
                current.username,
                current.role,
                "success",
                severity="warning",
                target=address,
                detail="Updated " + ", ".join(changed),
                breakglass=current.breakglass,
            )
            st.success(
                "Gmail settings saved and loaded. Send a test before enabling "
                "notifications.",
                icon=":material/check_circle:",
            )
        else:
            st.info("Nothing changed.", icon=":material/info:")
    except (ValueError, OSError) as exc:
        st.error(f"Gmail settings were not saved: {exc}", icon=":material/error:")

with st.expander("Remove the saved Gmail credentials"):
    remove_phrase = st.text_input(
        "Type REMOVE to confirm",
        key="remove_gmail_phrase",
        autocomplete="off",
    )
    if st.button(
        "Remove Gmail credentials",
        icon=":material/delete:",
        disabled=remove_phrase != "REMOVE" or not (stored_user or stored_password),
    ):
        # Re-check the typed confirmation inside the click branch; disabled is
        # browser affordance, not an authorisation boundary.
        if remove_phrase != "REMOVE":
            st.error("Confirmation did not match.", icon=":material/block:")
        else:
            try:
                changed = update_env_file(
                    settings.auth.env_file,
                    {
                        "EMAIL_SMTP_USER": None,
                        "EMAIL_SMTP_APP_PASSWORD": None,
                        "EMAIL_FROM": None,
                    },
                )
                reload_configuration()
                audit.record(
                    "notifications.gmail_removed",
                    current.username,
                    current.role,
                    "success",
                    severity="warning",
                    target=", ".join(changed),
                    breakglass=current.breakglass,
                )
                st.success("Gmail credentials removed.", icon=":material/check_circle:")
                st.rerun()
            except OSError as exc:
                st.error(f"Credentials were not removed: {exc}", icon=":material/error:")

st.divider()
st.markdown("### What should be emailed")
st.caption(
    "A fault is sent once when it appears or escalates. It is not repeated on "
    "every poll. If recovery mail is enabled, a second message is sent when the "
    "fault clears. Weekly reports and alerts use a branded HTML template with "
    "a plain-text fallback. Saving an enabled subscription starts an immediate check."
)

with st.form("notification_preferences"):
    enabled = st.checkbox("Enable email delivery", value=preferences.enabled)
    recipients_text = st.text_area(
        "Recipients",
        value="\n".join(preferences.recipients),
        placeholder="you@example.com",
        help="One per line or comma separated; maximum 10.",
    )
    delivery_columns = st.columns(3)
    with delivery_columns[0]:
        immediate_enabled = st.checkbox(
            "Fault alerts", value=preferences.immediate_enabled
        )
    with delivery_columns[1]:
        recovery_enabled = st.checkbox(
            "Recovery messages", value=preferences.recovery_enabled
        )
    with delivery_columns[2]:
        weekly_enabled = st.checkbox(
            "Weekly report", value=preferences.weekly_enabled
        )

    categories = st.multiselect(
        "Alert categories",
        options=list(CATEGORY_LABELS),
        default=list(preferences.categories),
        format_func=CATEGORY_LABELS.__getitem__,
    )
    severities = st.multiselect(
        "Alert severities",
        options=list(SEVERITY_LABELS),
        default=list(preferences.severities),
        format_func=SEVERITY_LABELS.__getitem__,
    )
    schedule_columns = st.columns(2)
    with schedule_columns[0]:
        weekly_weekday = st.selectbox(
            "Weekly report day",
            options=list(range(7)),
            index=preferences.weekly_weekday,
            format_func=WEEKDAY_LABELS.__getitem__,
        )
    with schedule_columns[1]:
        weekly_hour = st.selectbox(
            f"Delivery hour ({settings.host.timezone})",
            options=list(range(24)),
            index=preferences.weekly_hour,
            format_func=lambda hour: f"{hour:02d}:00",
        )
    save_preferences = st.form_submit_button(
        "Save email preferences", icon=":material/save:"
    )

if save_preferences:
    try:
        recipients = parse_recipients(recipients_text)
        if enabled and not get_settings().email.configured:
            raise ValueError("Save the Gmail address and app password first.")
        candidate = NotificationPreferences(
            enabled=enabled,
            recipients=recipients,
            categories=tuple(categories),
            severities=tuple(severities),
            immediate_enabled=immediate_enabled,
            recovery_enabled=recovery_enabled,
            weekly_enabled=weekly_enabled,
            weekly_weekday=int(weekly_weekday),
            weekly_hour=int(weekly_hour),
        )
        store.save_preferences(candidate)
        audit.record(
            "notifications.preferences_updated",
            current.username,
            current.role,
            "success",
            severity="notice",
            detail=(
                f"enabled={candidate.enabled}; recipients={len(candidate.recipients)}; "
                f"categories={','.join(candidate.categories)}; "
                f"severities={','.join(candidate.severities)}; "
                f"weekly={candidate.weekly_enabled}"
            ),
            breakglass=current.breakglass,
        )
        notification_worker().wake()
        st.success("Email preferences saved.", icon=":material/check_circle:")
    except (ValueError, NotificationStoreError) as exc:
        st.error(f"Preferences were not saved: {exc}", icon=":material/error:")

test_col, status_col = st.columns([1, 2], vertical_alignment="top")
with test_col:
    if st.button(
        "Send test email",
        icon=":material/outgoing_mail:",
        width="stretch",
    ):
        # Re-read both stores inside the click branch so a stale render cannot
        # test credentials or recipients that have since been removed.
        try:
            live_preferences, _ = store.load()
            live_settings = get_settings()
            if not live_preferences.recipients:
                raise ValueError("Save at least one recipient first.")
            subject, text_body, html_body = build_test_message(
                live_settings.host.hostname
            )
            result = send_email(
                live_settings.email,
                live_preferences.recipients,
                subject,
                text_body,
                html_body,
            )
            audit.record(
                "notifications.test",
                current.username,
                current.role,
                "success" if result.ok else "failure",
                severity="notice" if result.ok else "warning",
                detail=result.message,
                breakglass=current.breakglass,
            )
            if result.ok:
                st.success(
                    f"Test sent to {result.recipients} recipient(s).",
                    icon=":material/check_circle:",
                )
            else:
                st.error(result.message, icon=":material/error:")
        except (ValueError, NotificationStoreError) as exc:
            st.error(str(exc), icon=":material/error:")

with status_col:
    worker = notification_worker()
    with st.container(border=True):
        st.markdown("**Delivery status**")
        st.caption(
            f"Background check every {worker.interval // 60} min · "
            f"worker {'running' if worker.running else 'stopped'}"
        )
        if worker.last_run:
            st.caption(f"Last check: {format_timestamp(worker.last_run)}")
        if worker.last_delivery:
            st.caption(f"Last email: {format_timestamp(worker.last_delivery)}")
        if delivery_state.last_weekly_period:
            st.caption(f"Last weekly report: {delivery_state.last_weekly_period}")
        if worker.last_error:
            st.warning(worker.last_error, icon=":material/warning:")

st.divider()

# ---------------------------------------------------------------------------
# Dead-man's switch
# ---------------------------------------------------------------------------

st.markdown("### Dead-man's switch")
st.caption(
    "Every alert above is sent by a thread inside this dashboard, so it cannot "
    "report its own death. A power cut, kernel panic, OOM kill or crash "
    "produces silence — which looks exactly like health. This inverts that: "
    "the dashboard pings an outside service every cycle, and that service "
    "emails you when the pings stop."
)

stored_ping = stored.get("HEALTHCHECKS_PING_URL", "")

with st.form("heartbeat_settings", clear_on_submit=False):
    ping_url = st.text_input(
        "Healthchecks.io ping URL",
        value=stored_ping,
        placeholder="https://hc-ping.com/your-check-uuid",
        help=(
            "Copy the ping URL from your check's page. Set the check's period "
            "a little longer than this dashboard's own interval so a single "
            "slow cycle does not trip it."
        ),
    )
    save_heartbeat = st.form_submit_button(
        "Save ping URL", icon=":material/save:"
    )

if save_heartbeat:
    try:
        cleaned = ping_url.strip()
        if cleaned:
            validate_ping_url(cleaned)
        changed = update_env_file(
            settings.auth.env_file, {"HEALTHCHECKS_PING_URL": cleaned or None}
        )
        if changed:
            reload_configuration()
            audit.record(
                "notifications.heartbeat_configured",
                current.username,
                current.role,
                "success",
                severity="notice",
                # The URL is a capability, so the audit log records that it
                # changed and never what it changed to.
                detail="Ping URL set" if cleaned else "Ping URL removed",
                breakglass=current.breakglass,
            )
            st.success(
                "Ping URL saved and loaded." if cleaned else "Ping URL removed.",
                icon=":material/check_circle:",
            )
        else:
            st.info("Nothing changed.", icon=":material/info:")
    except (ValueError, OSError) as exc:
        st.error(f"Ping URL was not saved: {exc}", icon=":material/error:")

heartbeat_test, heartbeat_status = st.columns([1, 2], vertical_alignment="top")
with heartbeat_test:
    if st.button(
        "Send test ping",
        icon=":material/favorite:",
        width="stretch",
        disabled=not get_settings().heartbeat.configured,
    ):
        result = send_heartbeat(get_settings().heartbeat)
        audit.record(
            "notifications.heartbeat_test",
            current.username,
            current.role,
            "success" if result.ok else "failure",
            severity="notice" if result.ok else "warning",
            detail=result.message,
            breakglass=current.breakglass,
        )
        if result.ok:
            st.success(
                f"{result.message} The check should now show as up.",
                icon=":material/check_circle:",
            )
        else:
            st.error(result.message, icon=":material/error:")

with heartbeat_status:
    with st.container(border=True):
        st.markdown("**Switch status**")
        if not get_settings().heartbeat.configured:
            st.caption(
                ":gray[Not configured — nothing external is watching this "
                "dashboard. If it stops, no alert is raised.]"
            )
        else:
            st.caption(f"Pinged every {worker.interval // 60} min with each check")
            if worker.last_heartbeat:
                st.caption(f"Last ping: {format_timestamp(worker.last_heartbeat)}")
            elif worker.runs:
                st.caption(":gray[No successful ping yet.]")
            if worker.last_heartbeat_error:
                st.warning(worker.last_heartbeat_error, icon=":material/warning:")

with st.expander("What trips the switch, and what deliberately does not"):
    st.markdown(
        """
The switch reports on **the monitoring pipeline**, not on the server's health.
Those are different questions with different audiences, and merging them would
make the one signal that means "you are flying blind" indistinguishable from
routine noise.

**Pings stop** (Healthchecks.io alerts after its period lapses) when the
dashboard is not running at all: power loss, kernel panic, OOM kill, a crashed
process, or the host losing its internet connection.

**An immediate failure signal** is sent when the dashboard is alive but its
alerting is broken — a collection that raised, or an alert email that could not
be delivered. That second case is the quiet one: with working internet and
broken SMTP credentials, every ping would otherwise succeed while no alert
could reach anyone.

**A degraded RAID array, a full disk or a stopped container do _not_ trip it.**
Those are findings with their own email path. Routing them here as well would
turn the switch into a second copy of your alert stream, and a signal that
fires constantly is one you stop reading.

One consequence worth accepting deliberately: an internet outage stops the
pings, so Healthchecks.io reports the dashboard as down when it is in fact
running fine and unable to reach the world. That is the correct alarm — during
an outage the dashboard genuinely cannot tell you anything — but it does mean
the alert says less than it appears to.
"""
    )
