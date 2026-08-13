"""Email notifications and weekly health reports.

SMTP credentials are supplied by :class:`config.EmailConfig`; this module
never persists them.  The JSON store contains only subscriptions and the
minimum delivery state needed to suppress repeated mail for one incident.
"""

from __future__ import annotations

import html
import json
import re
import smtplib
import ssl
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from email.message import EmailMessage
from email.utils import parseaddr
from pathlib import Path
from typing import Callable, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from config import EmailConfig, Settings
from core.collector import Snapshot
from core.status import Alert, ComponentHealth, Status
from utils.fileio import atomic_write_text
from utils.logging_setup import get_logger

log = get_logger("notifications")

MAX_RECIPIENTS = 10
MAX_DETAIL_CHARS = 800

_BRAND = "#2AA3C0"
_INK = "#EAF2F7"
_MUTED = "#9AA8B5"
_SURFACE = "#111922"
_SURFACE_RAISED = "#17232E"
_BORDER = "#273746"
_STATUS_COLOURS: dict[Status, str] = {
    Status.HEALTHY: "#37AC7B",
    Status.INFO: _BRAND,
    Status.WARNING: "#E8B339",
    Status.CRITICAL: "#E5484D",
    Status.UNKNOWN: "#7A8794",
}

# Stable keys are stored in preferences; labels may evolve without invalidating
# an existing subscription.
CATEGORY_LABELS: dict[str, str] = {
    "host": "Server health",
    "storage": "Storage and RAID",
    "network": "Network and Internet",
    "applications": "Docker and applications",
    "vpn": "VPN and leak checks",
    "backups": "Backups",
    "security": "Security",
}

SEVERITY_LABELS: dict[str, str] = {
    Status.CRITICAL.value: "Critical",
    Status.WARNING.value: "Warning",
    Status.UNKNOWN.value: "Unknown / monitoring gap",
}

WEEKDAY_LABELS: tuple[str, ...] = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)

_EMAIL_SHAPE = re.compile(r"^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$")


class NotificationStoreError(RuntimeError):
    """Preferences or delivery state could not be read or persisted."""


@dataclass(frozen=True)
class NotificationPreferences:
    enabled: bool = False
    recipients: tuple[str, ...] = ()
    categories: tuple[str, ...] = field(
        default_factory=lambda: tuple(CATEGORY_LABELS)
    )
    severities: tuple[str, ...] = (
        Status.CRITICAL.value,
        Status.WARNING.value,
    )
    immediate_enabled: bool = True
    recovery_enabled: bool = True
    weekly_enabled: bool = True
    weekly_weekday: int = 0
    weekly_hour: int = 8


@dataclass
class NotificationState:
    # Alert key -> last severity successfully delivered. Details are not stored:
    # they may contain addresses or filenames and are not required for dedupe.
    notified: dict[str, str] = field(default_factory=dict)
    last_weekly_period: str = ""


@dataclass(frozen=True)
class DeliveryResult:
    ok: bool
    message: str
    recipients: int = 0


def validate_email_address(value: str) -> str:
    """Return a canonical address or raise, rejecting header injection."""
    address = value.strip()
    if any(char in address for char in ("\r", "\n", "\x00")):
        raise ValueError("Email addresses cannot contain control characters.")
    display, parsed = parseaddr(address)
    if display or parsed != address or not _EMAIL_SHAPE.fullmatch(address):
        raise ValueError(f"Invalid email address: {value!r}")
    return address


def parse_recipients(value: str | Iterable[str]) -> tuple[str, ...]:
    """Parse comma/newline-separated recipients, preserving first-seen order."""
    if isinstance(value, str):
        raw = re.split(r"[,\n]", value)
    else:
        raw = list(value)
    recipients: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not str(item).strip():
            continue
        address = validate_email_address(str(item))
        key = address.casefold()
        if key not in seen:
            recipients.append(address)
            seen.add(key)
    if len(recipients) > MAX_RECIPIENTS:
        raise ValueError(f"At most {MAX_RECIPIENTS} recipients are allowed.")
    return tuple(recipients)


def alert_category(key: str) -> str:
    if key.startswith(("storage.", "raid.", "disk.")):
        return "storage"
    if key.startswith("network."):
        return "network"
    if key.startswith(("container.", "probe.", "app.")):
        return "applications"
    if key.startswith("vpn."):
        return "vpn"
    if key.startswith("backup."):
        return "backups"
    if key.startswith("security."):
        return "security"
    return "host"


class NotificationStore:
    """Thread-safe, fail-closed preferences and delivery-state store."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()

    def load(self) -> tuple[NotificationPreferences, NotificationState]:
        with self._lock:
            return self._load_unlocked()

    def save_preferences(
        self, preferences: NotificationPreferences
    ) -> NotificationPreferences:
        validated = _validate_preferences(preferences)
        with self._lock:
            _, state = self._load_unlocked()
            self._write_unlocked(validated, state)
        return validated

    def record_delivery(
        self,
        *,
        notified: dict[str, str] | None = None,
        cleared: Iterable[str] = (),
        weekly_period: str | None = None,
    ) -> None:
        """Merge delivery state without overwriting a concurrent UI save."""
        with self._lock:
            preferences, state = self._load_unlocked()
            for key in cleared:
                state.notified.pop(key, None)
            if notified:
                state.notified.update(notified)
            if weekly_period is not None:
                state.last_weekly_period = weekly_period
            self._write_unlocked(preferences, state)

    def _load_unlocked(self) -> tuple[NotificationPreferences, NotificationState]:
        if not self.path.exists():
            return NotificationPreferences(), NotificationState()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise NotificationStoreError(
                f"Could not read notification settings at {self.path}: {exc}"
            ) from exc
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise NotificationStoreError("Unsupported notification settings format.")
        try:
            raw_preferences = payload["preferences"]
            raw_state = payload.get("state", {})
            if not isinstance(raw_preferences, dict) or not isinstance(raw_state, dict):
                raise ValueError("preferences and state must be objects")
            preferences = NotificationPreferences(
                enabled=_strict_bool(raw_preferences, "enabled", False),
                recipients=tuple(raw_preferences.get("recipients", ())),
                categories=tuple(raw_preferences.get("categories", CATEGORY_LABELS)),
                severities=tuple(
                    raw_preferences.get(
                        "severities",
                        (Status.CRITICAL.value, Status.WARNING.value),
                    )
                ),
                immediate_enabled=_strict_bool(
                    raw_preferences, "immediate_enabled", True
                ),
                recovery_enabled=_strict_bool(
                    raw_preferences, "recovery_enabled", True
                ),
                weekly_enabled=_strict_bool(raw_preferences, "weekly_enabled", True),
                weekly_weekday=int(raw_preferences.get("weekly_weekday", 0)),
                weekly_hour=int(raw_preferences.get("weekly_hour", 8)),
            )
            notified = raw_state.get("notified", {})
            last_weekly = raw_state.get("last_weekly_period", "")
            if not isinstance(notified, dict) or not all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in notified.items()
            ):
                raise ValueError("invalid notified state")
            if not isinstance(last_weekly, str):
                raise ValueError("invalid weekly state")
            return _validate_preferences(preferences), NotificationState(
                notified=dict(notified), last_weekly_period=last_weekly
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise NotificationStoreError(
                f"Invalid notification settings at {self.path}: {exc}"
            ) from exc

    def _write_unlocked(
        self, preferences: NotificationPreferences, state: NotificationState
    ) -> None:
        payload = {
            "version": 1,
            "preferences": {
                **asdict(preferences),
                "recipients": list(preferences.recipients),
                "categories": list(preferences.categories),
                "severities": list(preferences.severities),
            },
            "state": asdict(state),
        }
        try:
            atomic_write_text(
                self.path,
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
                mode=0o600,
            )
        except OSError as exc:
            raise NotificationStoreError(
                f"Could not save notification settings at {self.path}: {exc}"
            ) from exc


def _strict_bool(payload: dict, key: str, default: bool) -> bool:
    value = payload.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"{key} must be true or false")
    return value


def _validate_preferences(
    preferences: NotificationPreferences,
) -> NotificationPreferences:
    recipients = parse_recipients(preferences.recipients)
    categories = tuple(dict.fromkeys(preferences.categories))
    severities = tuple(dict.fromkeys(preferences.severities))
    if any(category not in CATEGORY_LABELS for category in categories):
        raise ValueError("Notification preferences contain an unknown category.")
    if any(severity not in SEVERITY_LABELS for severity in severities):
        raise ValueError("Notification preferences contain an unknown severity.")
    if not 0 <= preferences.weekly_weekday <= 6:
        raise ValueError("Weekly report day must be between Monday and Sunday.")
    if not 0 <= preferences.weekly_hour <= 23:
        raise ValueError("Weekly report hour must be between 00 and 23.")
    if preferences.enabled and not recipients:
        raise ValueError("At least one recipient is required when email is enabled.")
    if preferences.enabled and not (
        preferences.immediate_enabled or preferences.weekly_enabled
    ):
        raise ValueError("Enable immediate alerts, weekly reports, or both.")
    if preferences.immediate_enabled and not categories:
        raise ValueError("Choose at least one alert category.")
    if preferences.immediate_enabled and not severities:
        raise ValueError("Choose at least one alert severity.")
    return NotificationPreferences(
        enabled=preferences.enabled,
        recipients=recipients,
        categories=categories,
        severities=severities,
        immediate_enabled=preferences.immediate_enabled,
        recovery_enabled=preferences.recovery_enabled,
        weekly_enabled=preferences.weekly_enabled,
        weekly_weekday=preferences.weekly_weekday,
        weekly_hour=preferences.weekly_hour,
    )


def send_email(
    config: EmailConfig,
    recipients: Iterable[str],
    subject: str,
    text_body: str,
    html_body: str | None = None,
) -> DeliveryResult:
    """Send one message over authenticated SMTP-over-TLS, never raising."""
    try:
        targets = parse_recipients(recipients)
        sender = validate_email_address(config.from_address)
        if not config.configured:
            return DeliveryResult(False, "Gmail SMTP credentials are not configured.")
        if not targets:
            return DeliveryResult(False, "No email recipients are configured.")
        if any(char in subject for char in ("\r", "\n", "\x00")):
            return DeliveryResult(False, "The email subject is invalid.")

        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = sender
        message["To"] = ", ".join(targets)
        message["Auto-Submitted"] = "auto-generated"
        message["X-Auto-Response-Suppress"] = "All"
        message.set_content(text_body)
        if html_body:
            message.add_alternative(html_body, subtype="html")

        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(
            config.smtp_host,
            config.smtp_port,
            timeout=config.timeout_seconds,
            context=context,
        ) as client:
            client.login(config.username or "", config.app_password or "")
            client.send_message(message)
        return DeliveryResult(True, "Email sent.", len(targets))
    except (ValueError, OSError, TimeoutError, smtplib.SMTPException) as exc:
        # Error types and server messages are safe to surface; credentials are
        # never interpolated into this path.
        log.warning("Email delivery failed: %s: %s", type(exc).__name__, exc)
        return DeliveryResult(
            False, f"Email delivery failed: {type(exc).__name__}: {exc}"
        )


Sender = Callable[[EmailConfig, Iterable[str], str, str, str | None], DeliveryResult]


class NotificationManager:
    """Select, deduplicate and deliver notifications for collected snapshots."""

    def __init__(self, store: NotificationStore, sender: Sender = send_email) -> None:
        self.store = store
        self.sender = sender

    def run_cycle(
        self,
        snapshot_factory: Callable[[], Snapshot],
        settings: Settings,
        now: datetime | None = None,
    ) -> list[DeliveryResult]:
        preferences, _ = self.store.load()
        if not preferences.enabled or not settings.email.configured:
            return []
        if not (preferences.immediate_enabled or preferences.weekly_enabled):
            return []
        return self.process_snapshot(snapshot_factory(), settings, now=now)

    def process_snapshot(
        self,
        snapshot: Snapshot,
        settings: Settings,
        now: datetime | None = None,
    ) -> list[DeliveryResult]:
        preferences, state = self.store.load()
        if not preferences.enabled or not settings.email.configured:
            return []

        results: list[DeliveryResult] = []
        active = {
            alert.key: alert
            for alert in snapshot.alerts
            if alert.status in {Status.CRITICAL, Status.WARNING, Status.UNKNOWN}
        }
        eligible = {
            key: alert
            for key, alert in active.items()
            if alert_category(key) in preferences.categories
            and alert.status.value in preferences.severities
        }
        new_alerts = [
            alert
            for key, alert in eligible.items()
            if state.notified.get(key) != alert.status.value
        ]
        resolved_keys = set(state.notified) - set(active)
        recovery_keys = {
            key
            for key in resolved_keys
            if alert_category(key) in preferences.categories
        }
        silent_clears = resolved_keys - recovery_keys

        if preferences.immediate_enabled:
            recoveries = sorted(recovery_keys) if preferences.recovery_enabled else []
            if new_alerts or recoveries:
                subject, text_body, html_body = _alert_message(
                    settings.host.hostname, new_alerts, recoveries
                )
                result = self.sender(
                    settings.email,
                    preferences.recipients,
                    subject,
                    text_body,
                    html_body,
                )
                results.append(result)
                if result.ok:
                    self.store.record_delivery(
                        notified={a.key: a.status.value for a in new_alerts},
                        cleared=resolved_keys,
                    )
                elif silent_clears:
                    self.store.record_delivery(cleared=silent_clears)
            elif resolved_keys:
                # Recovery mail is disabled (or the category was deselected),
                # so clear the old incident without manufacturing a message.
                self.store.record_delivery(cleared=resolved_keys)
        elif resolved_keys:
            self.store.record_delivery(cleared=resolved_keys)

        current = _local_now(settings.host.timezone, now)
        period = _weekly_period_if_due(preferences, state, current)
        if preferences.weekly_enabled and period:
            subject, text_body, html_body = _weekly_message(
                settings.host.hostname, snapshot, current
            )
            result = self.sender(
                settings.email,
                preferences.recipients,
                subject,
                text_body,
                html_body,
            )
            results.append(result)
            if result.ok:
                self.store.record_delivery(weekly_period=period)
        return results


def _local_now(timezone_name: str, supplied: datetime | None) -> datetime:
    try:
        zone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        zone = datetime.now().astimezone().tzinfo
    if supplied is None:
        return datetime.now(zone)
    if supplied.tzinfo is None:
        return supplied.replace(tzinfo=zone)
    return supplied.astimezone(zone)


def _weekly_period_if_due(
    preferences: NotificationPreferences,
    state: NotificationState,
    now: datetime,
) -> str | None:
    iso = now.isocalendar()
    period = f"{iso.year}-W{iso.week:02d}"
    scheduled_has_passed = now.weekday() > preferences.weekly_weekday or (
        now.weekday() == preferences.weekly_weekday
        and now.hour >= preferences.weekly_hour
    )
    if not scheduled_has_passed or state.last_weekly_period == period:
        return None
    return period


def _alert_message(
    hostname: str, alerts: list[Alert], recovered_keys: list[str]
) -> tuple[str, str, str]:
    """Build a branded alert/recovery message plus its plain-text fallback."""
    worst = max((alert.status for alert in alerts), key=lambda s: s.rank, default=None)
    if alerts and recovered_keys:
        heading = "Health changes"
    elif alerts:
        heading = f"{worst.value.title()} alert" if worst else "Health alert"
    else:
        heading = "Recovered"
    subject = f"[{hostname}] {heading}"

    text_lines = [f"Streamanator health update for {hostname}", ""]
    content: list[str] = []
    if alerts:
        text_lines.append("New or escalated problems:")
        content.append(_section_heading("New or escalated problems"))
        for alert in sorted(alerts, key=lambda item: item.status.rank, reverse=True):
            detail = _limited(alert.detail)
            text_lines.extend(
                [
                    f"- {alert.status.value}: {alert.title} ({alert.component})",
                    f"  {detail}",
                    f"  Action: {_limited(alert.recommended_action)}"
                    if alert.recommended_action
                    else "",
                ]
            )
            content.append(_alert_card(alert))
    if recovered_keys:
        text_lines.extend(["", "Recovered:"])
        text_lines.extend(f"- {key}" for key in recovered_keys)
        recovery_items = "".join(
            f'<div style="padding:5px 0;color:{_INK};font-size:14px;">'
            f"&#10003;&nbsp; {html.escape(key)}</div>"
            for key in recovered_keys
        )
        content.extend(
            [
                _section_heading("Recovered"),
                _callout(recovery_items, _STATUS_COLOURS[Status.HEALTHY]),
            ]
        )
    text_lines.append("\nThis message was generated by the Streamanator Dashboard.")
    accent = _STATUS_COLOURS.get(worst or Status.HEALTHY, _BRAND)
    html_body = _email_document(
        hostname=hostname,
        eyebrow="SYSTEM NOTIFICATION",
        title=heading,
        summary=(
            f"{len(alerts)} new or escalated finding(s)"
            if alerts
            else f"{len(recovered_keys)} finding(s) cleared"
        ),
        content="".join(content),
        accent=accent,
        preheader=f"{heading} on {hostname}",
    )
    return subject, "\n".join(text_lines), html_body


def _weekly_message(
    hostname: str, snapshot: Snapshot, now: datetime
) -> tuple[str, str, str]:
    """Build the visual weekly digest and an equivalent text-only report."""
    health = snapshot.health
    score = max(0, min(100, int(round(health.score))))
    subject = f"[{hostname}] Weekly health report - {health.label} {score}/100"
    component_rows = sorted(
        snapshot.components.values(), key=lambda item: item.status.rank, reverse=True
    )
    active = [
        alert
        for alert in snapshot.alerts
        if alert.status in {Status.CRITICAL, Status.WARNING, Status.UNKNOWN}
    ]
    text_lines = [
        f"Weekly Streamanator report for {hostname}",
        f"Generated: {now:%Y-%m-%d %H:%M %Z}",
        f"Overall: {health.label} - {score}/100",
        f"Reason: {health.reason}",
        "",
        "Components:",
    ]
    text_lines.extend(
        f"- {component.label}: {component.status.value} ({component.score * 100:.0f}%)"
        for component in component_rows
    )
    text_lines.extend(["", f"Active findings: {len(active)}"])
    text_lines.extend(
        f"- {alert.status.value}: {alert.title} - {_limited(alert.detail)}"
        for alert in active[:20]
    )
    if snapshot.changes:
        text_lines.extend(["", "Recent changes:"])
        text_lines.extend(f"- {change.summary}" for change in snapshot.changes[:10])

    score_value = (
        f'{score}<span style="color:{_MUTED};font-size:16px;">/100</span>'
    )
    hero = (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:{_SURFACE_RAISED};border:1px solid {_BORDER};'
        'border-radius:12px;margin:0 0 18px 0;"><tr>'
        f'{_hero_cell("HEALTH SCORE", score_value, True)}'
        f'{_hero_cell("STATUS", _status_pill(health.status), True)}'
        f'{_hero_cell("FINDINGS", str(len(active)), False)}'
        '</tr></table>'
    )
    findings = (
        "".join(_alert_card(alert) for alert in active[:20])
        if active
        else _callout(
            f'<strong style="color:{_INK};">No active findings</strong><br>'
            f'<span style="color:{_MUTED};font-size:13px;">All collected '
            "measurements are within their configured thresholds.</span>",
            _STATUS_COLOURS[Status.HEALTHY],
        )
    )
    changes = (
        "".join(
            f'<div style="padding:10px 0;border-bottom:1px solid {_BORDER};'
            f'color:{_INK};font-size:14px;line-height:1.45;">'
            f'<span style="color:{_BRAND};">&#8226;</span>&nbsp; '
            f"{html.escape(change.summary)}</div>"
            for change in snapshot.changes[:10]
        )
        if snapshot.changes
        else f'<p style="margin:0;color:{_MUTED};font-size:14px;">No recent changes.</p>'
    )
    content = (
        hero
        + _callout(html.escape(health.reason), _STATUS_COLOURS[health.status])
        + _section_heading("Component health")
        + "".join(_component_row(component) for component in component_rows)
        + _section_heading(f"Active findings ({len(active)})")
        + findings
        + _section_heading("Recent changes")
        + changes
    )
    html_body = _email_document(
        hostname=hostname,
        eyebrow="WEEKLY HEALTH REPORT",
        title=f"{health.label} - {score}/100",
        summary=f"Your infrastructure summary for {now:%d %B %Y}",
        content=content,
        accent=_STATUS_COLOURS[health.status],
        preheader=f"{hostname} is {health.label} with a health score of {score}/100",
        generated=now.strftime("%Y-%m-%d %H:%M %Z"),
    )
    return subject, "\n".join(text_lines), html_body


def build_test_message(hostname: str) -> tuple[str, str, str]:
    """Build the same branded multipart message used by real deliveries."""
    subject = f"[{hostname}] Test email"
    text_body = (
        f"Email delivery from the Streamanator Dashboard on {hostname} is working."
    )
    content = _callout(
        f'<div style="font-size:17px;font-weight:700;color:{_INK};margin-bottom:6px;">'
        "Email delivery is working</div>"
        f'<div style="font-size:14px;color:{_MUTED};line-height:1.55;">'
        "This inbox can receive Streamanator fault alerts, recovery notices, "
        "and weekly health reports.</div>",
        _STATUS_COLOURS[Status.HEALTHY],
    )
    html_body = _email_document(
        hostname=hostname,
        eyebrow="DELIVERY TEST",
        title="Connection confirmed",
        summary="Your notification channel is ready.",
        content=content,
        accent=_STATUS_COLOURS[Status.HEALTHY],
        preheader=f"Email delivery from {hostname} is working",
    )
    return subject, text_body, html_body


def _email_document(
    *,
    hostname: str,
    eyebrow: str,
    title: str,
    summary: str,
    content: str,
    accent: str,
    preheader: str,
    generated: str = "",
) -> str:
    """Email-client-safe shell: inline CSS, tables and no remote resources."""
    safe_host = html.escape(hostname)
    generated_line = (
        f"<br>Generated {html.escape(generated)}" if generated else ""
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="color-scheme" content="light only">'
        '<title>Streamanator Dashboard</title></head>'
        '<body style="margin:0;padding:0;background:#0B0F14;'
        'font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">'
        '<div style="display:none;max-height:0;overflow:hidden;opacity:0;'
        f'color:transparent;">{html.escape(preheader)}&nbsp;&#847;&zwnj;</div>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="width:100%;background:#0B0F14;"><tr><td align="center" '
        'style="padding:28px 12px;">'
        '<table role="presentation" width="640" cellpadding="0" cellspacing="0" '
        'style="width:100%;max-width:640px;">'
        f'<tr><td style="height:5px;background:{accent};font-size:0;line-height:0;'
        'border-radius:14px 14px 0 0;">&nbsp;</td></tr>'
        f'<tr><td style="background:{_SURFACE};border:1px solid {_BORDER};'
        'border-top:0;padding:32px 34px 28px 34px;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
        '<tr><td width="52" valign="top">'
        f'<div style="width:42px;height:42px;line-height:42px;text-align:center;'
        f'background:{_BRAND};border-radius:10px;color:#071014;font-size:22px;'
        'font-weight:900;">S</div></td><td valign="top" style="padding-left:12px;">'
        f'<div style="color:{accent};font-size:11px;font-weight:800;letter-spacing:1.6px;'
        f'line-height:1.4;">{html.escape(eyebrow)}</div>'
        f'<div style="color:{_INK};font-size:25px;font-weight:800;line-height:1.25;'
        f'margin-top:4px;">{html.escape(title)}</div>'
        f'<div style="color:{_MUTED};font-size:14px;line-height:1.5;margin-top:5px;">'
        f'{html.escape(summary)}</div></td></tr></table>'
        f'<div style="height:1px;background:{_BORDER};margin:26px 0;"></div>'
        f'{content}</td></tr>'
        f'<tr><td style="background:#0E151D;border:1px solid {_BORDER};border-top:0;'
        'border-radius:0 0 14px 14px;padding:18px 34px;color:#71808D;'
        f'font-size:11px;line-height:1.6;">Sent by <strong style="color:{_MUTED};">'
        f'Streamanator Dashboard</strong> on {safe_host}.{generated_line}<br>'
        'Automated monitoring message · no tracking pixels · no remote images'
        '</td></tr></table></td></tr></table></body></html>'
    )


def _section_heading(label: str) -> str:
    return (
        f'<div style="margin:25px 0 11px;color:{_MUTED};font-size:11px;'
        f'font-weight:800;letter-spacing:1.4px;">{html.escape(label.upper())}</div>'
    )


def _status_pill(status: Status) -> str:
    colour = _STATUS_COLOURS[status]
    return (
        f'<span style="display:inline-block;padding:5px 9px;border-radius:999px;'
        f'border:1px solid {colour};color:{colour};font-size:11px;font-weight:800;'
        f'letter-spacing:.5px;">{html.escape(status.value)}</span>'
    )


def _callout(content: str, accent: str) -> str:
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:{_SURFACE_RAISED};border:1px solid {_BORDER};'
        f'border-left:4px solid {accent};border-radius:9px;margin:0 0 12px 0;">'
        f'<tr><td style="padding:15px 17px;color:{_INK};font-size:14px;'
        f'line-height:1.55;">{content}</td></tr></table>'
    )


def _alert_card(alert: Alert) -> str:
    action = (
        f'<div style="margin-top:10px;color:{_MUTED};font-size:13px;line-height:1.5;">'
        f'<strong style="color:{_INK};">Next step:</strong> '
        f'{html.escape(_limited(alert.recommended_action))}</div>'
        if alert.recommended_action
        else ""
    )
    body = (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
        f'<tr><td style="padding-right:12px;"><div style="color:{_INK};font-size:16px;'
        f'font-weight:700;line-height:1.35;">{html.escape(alert.title)}</div>'
        f'<div style="color:{_MUTED};font-size:12px;margin-top:3px;">'
        f'{html.escape(alert.component)}</div></td><td align="right" valign="top">'
        f'{_status_pill(alert.status)}</td></tr></table>'
        f'<div style="color:{_INK};font-size:14px;line-height:1.55;margin-top:12px;">'
        f'{html.escape(_limited(alert.detail))}</div>{action}'
    )
    return _callout(body, _STATUS_COLOURS[alert.status])


def _component_row(component: ComponentHealth) -> str:
    score = max(0, min(100, int(round(component.score * 100))))
    colour = _STATUS_COLOURS[component.status]
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="border-bottom:1px solid {_BORDER};"><tr>'
        f'<td style="padding:11px 8px 11px 0;color:{_INK};font-size:14px;">'
        f'{html.escape(component.label)}</td><td width="145" style="padding:11px 8px;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
        '<tr><td style="height:6px;background:#263441;border-radius:99px;">'
        f'<div style="width:{score}%;height:6px;background:{colour};border-radius:99px;'
        'font-size:0;line-height:0;">&nbsp;</div></td></tr></table></td>'
        f'<td width="48" align="right" style="padding:11px 0;color:{_MUTED};'
        f'font-size:12px;">{score}%</td><td width="90" align="right" '
        f'style="padding:11px 0 11px 10px;">{_status_pill(component.status)}</td>'
        '</tr></table>'
    )


def _hero_cell(label: str, value: str, border: bool) -> str:
    border_style = f"border-right:1px solid {_BORDER};" if border else ""
    return (
        f'<td style="padding:20px 12px;text-align:center;{border_style}">'
        f'<div style="color:{_MUTED};font-size:10px;font-weight:700;'
        f'letter-spacing:1px;">{html.escape(label)}</div>'
        f'<div style="color:{_INK};font-size:30px;font-weight:800;line-height:1.25;'
        f'margin-top:5px;">{value}</div></td>'
    )


def _limited(value: str) -> str:
    text = " ".join((value or "No additional detail.").split())
    return text if len(text) <= MAX_DETAIL_CHARS else text[: MAX_DETAIL_CHARS - 1] + "…"


class NotificationWorker:
    """One daemon thread that evaluates enabled subscriptions on a timer."""

    def __init__(
        self,
        manager: NotificationManager,
        snapshot_factory: Callable[[], Snapshot],
        settings_factory: Callable[[], Settings],
        interval_seconds: int,
    ) -> None:
        self.manager = manager
        self.snapshot_factory = snapshot_factory
        self.settings_factory = settings_factory
        self.interval = max(60, interval_seconds)
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._start_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.last_run: float | None = None
        self.last_error: str | None = None
        self.last_delivery: float | None = None
        self.runs = 0

    def start(self) -> "NotificationWorker":
        with self._start_lock:
            if self._thread and self._thread.is_alive():
                return self
            self._thread = threading.Thread(
                target=self._loop,
                name="streamanator-notifications",
                daemon=True,
            )
            self._thread.start()
        log.info("Notification worker started (interval=%ss)", self.interval)
        return self

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def wake(self) -> None:
        """Request an immediate pass after the admin saves preferences."""
        self._wake.set()

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def _loop(self) -> None:
        while not self._stop.is_set():
            started = time.time()
            try:
                results = self.manager.run_cycle(
                    self.snapshot_factory, self.settings_factory()
                )
                self.last_run = started
                self.last_error = next(
                    (result.message for result in results if not result.ok), None
                )
                if any(result.ok for result in results):
                    self.last_delivery = time.time()
                self.runs += 1
            except Exception as exc:  # noqa: BLE001 - worker must stay alive
                self.last_run = started
                self.last_error = f"{type(exc).__name__}: {exc}"
                log.exception("Notification cycle failed")
            elapsed = time.time() - started
            self._wake.wait(max(1.0, self.interval - elapsed))
            self._wake.clear()
