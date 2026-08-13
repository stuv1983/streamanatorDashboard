"""Notification persistence, SMTP safety, dedupe and schedule regressions."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest

from config import EmailConfig, HostConfig, Settings
from core.collector import Snapshot
from core.status import Alert, ComponentHealth, Status
from health.scoring import HealthScore
from services.notifications import (
    DeliveryResult,
    NotificationManager,
    NotificationPreferences,
    NotificationStore,
    NotificationStoreError,
    _alert_message,
    _weekly_message,
    build_test_message,
    parse_recipients,
    send_email,
)


def _settings() -> Settings:
    return Settings(
        host=HostConfig(hostname="test-host", timezone="UTC"),
        email=EmailConfig(
            smtp_host="smtp.gmail.com",
            smtp_port=465,
            username="sender@example.com",
            app_password="abcdefghijklmnop",
            sender="sender@example.com",
        ),
    )


def _snapshot(alerts: list[Alert] | None = None) -> Snapshot:
    component = ComponentHealth(
        key="server",
        label="Server",
        status=Status.HEALTHY,
        weight=1.0,
        score=1.0,
    )
    health = HealthScore(
        score=100.0,
        status=Status.HEALTHY,
        components=[component],
        reason="All measured components are healthy.",
    )
    return Snapshot(
        health=health,
        components={"server": component},
        alerts=list(alerts or []),
    )


def _critical_alert() -> Alert:
    return Alert(
        key="server.cpu",
        status=Status.CRITICAL,
        title="CPU utilisation high",
        component="Host",
        detail="CPU is at 99%.",
        recommended_action="Inspect the busiest process.",
    )


def test_preferences_round_trip_without_credentials(tmp_path):
    store = NotificationStore(tmp_path / "notifications.json")
    saved = NotificationPreferences(
        enabled=True,
        recipients=("admin@example.com",),
        categories=("host", "backups"),
        severities=(Status.CRITICAL.value,),
        weekly_weekday=4,
        weekly_hour=17,
    )
    store.save_preferences(saved)

    loaded, state = store.load()
    assert loaded == saved
    assert state.notified == {}
    text = store.path.read_text(encoding="utf-8")
    assert "abcdefghijklmnop" not in text
    assert "app_password" not in text


def test_corrupt_store_fails_closed(tmp_path):
    path = tmp_path / "notifications.json"
    path.write_text("not json", encoding="utf-8")
    with pytest.raises(NotificationStoreError):
        NotificationStore(path).load()


def test_preference_save_and_delivery_state_merge_under_contention(tmp_path):
    store = NotificationStore(tmp_path / "notifications.json")
    changed = NotificationPreferences(
        enabled=True,
        recipients=("admin@example.com",),
        categories=("backups",),
        severities=(Status.CRITICAL.value,),
        weekly_enabled=False,
    )

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(store.save_preferences, changed),
            pool.submit(
                store.record_delivery,
                notified={"backup.nightly": Status.CRITICAL.value},
            ),
        ]
        for future in futures:
            future.result()

    preferences, state = store.load()
    assert preferences == changed
    assert state.notified == {"backup.nightly": Status.CRITICAL.value}


@pytest.mark.parametrize(
    "value",
    [
        "admin@example.com\nBcc: attacker@example.com",
        "Admin <admin@example.com>",
        "missing-at.example.com",
    ],
)
def test_recipient_parser_rejects_header_injection_and_ambiguous_forms(value):
    with pytest.raises(ValueError):
        parse_recipients(value)


def test_smtp_connection_is_authenticated_sent_and_closed(monkeypatch):
    events: list[object] = []

    class FakeSmtp:
        def __init__(self, host, port, timeout, context):
            events.append(("open", host, port, timeout, bool(context)))

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            events.append("closed")

        def login(self, username, password):
            events.append(("login", username, password))

        def send_message(self, message):
            events.append(("send", message["To"], message["Subject"]))

    monkeypatch.setattr("services.notifications.smtplib.SMTP_SSL", FakeSmtp)
    result = send_email(
        _settings().email,
        ("admin@example.com",),
        "Test subject",
        "Test body",
    )

    assert result.ok
    assert events[-1] == "closed"
    assert ("login", "sender@example.com", "abcdefghijklmnop") in events
    assert ("send", "admin@example.com", "Test subject") in events


def test_branded_test_message_is_self_contained_and_has_text_fallback():
    subject, text_body, html_body = build_test_message("test-host")

    assert subject == "[test-host] Test email"
    assert "is working" in text_body
    assert html_body.startswith("<!doctype html>")
    assert "Streamanator Dashboard" in html_body
    assert "DELIVERY TEST" in html_body
    assert 'role="presentation"' in html_body
    assert "<img" not in html_body
    assert "http://" not in html_body and "https://" not in html_body


def test_alert_template_escapes_collector_content():
    alert = Alert(
        key="server.test",
        status=Status.CRITICAL,
        title="<script>alert(1)</script>",
        component="Host & server",
        detail='<img src=x onerror="alert(1)">',
        recommended_action="Check A > B",
    )

    _, text_body, html_body = _alert_message("host<1>", [alert], [])

    assert "<script>" in text_body  # Plain text is deliberately not HTML encoded.
    assert "<script>" not in html_body
    assert "<img src=x" not in html_body
    assert "&lt;script&gt;" in html_body
    assert "Host &amp; server" in html_body
    assert "host&lt;1&gt;" in html_body


def test_weekly_template_contains_visual_summary_and_plain_equivalent():
    now = datetime(2026, 8, 17, 9, tzinfo=timezone.utc)
    subject, text_body, html_body = _weekly_message(_settings().host.hostname, _snapshot(), now)

    assert "Weekly health report" in subject
    assert "Overall: HEALTHY - 100/100" in text_body
    assert "HEALTH SCORE" in html_body
    assert "COMPONENT HEALTH" in html_body
    assert "No active findings" in html_body
    assert "No recent changes" in html_body


def test_alert_is_sent_once_then_recovery_allows_a_future_incident(tmp_path):
    store = NotificationStore(tmp_path / "notifications.json")
    store.save_preferences(
        NotificationPreferences(
            enabled=True,
            recipients=("admin@example.com",),
            categories=("host",),
            severities=(Status.CRITICAL.value,),
            immediate_enabled=True,
            recovery_enabled=True,
            weekly_enabled=False,
        )
    )
    subjects: list[str] = []

    def sender(config, recipients, subject, text_body, html_body):
        subjects.append(subject)
        return DeliveryResult(True, "sent", len(tuple(recipients)))

    manager = NotificationManager(store, sender)
    bad = _snapshot([_critical_alert()])
    good = _snapshot()

    assert len(manager.process_snapshot(bad, _settings())) == 1
    assert manager.process_snapshot(bad, _settings()) == []
    assert len(manager.process_snapshot(good, _settings())) == 1
    assert "Recovered" in subjects[-1]
    assert len(manager.process_snapshot(bad, _settings())) == 1
    assert len(subjects) == 3


def test_failed_alert_delivery_is_retried(tmp_path):
    store = NotificationStore(tmp_path / "notifications.json")
    store.save_preferences(
        NotificationPreferences(
            enabled=True,
            recipients=("admin@example.com",),
            categories=("host",),
            severities=(Status.CRITICAL.value,),
            immediate_enabled=True,
            weekly_enabled=False,
        )
    )
    calls = 0

    def sender(config, recipients, subject, text_body, html_body):
        nonlocal calls
        calls += 1
        return DeliveryResult(False, "temporary SMTP failure")

    manager = NotificationManager(store, sender)
    manager.process_snapshot(_snapshot([_critical_alert()]), _settings())
    manager.process_snapshot(_snapshot([_critical_alert()]), _settings())
    assert calls == 2
    _, state = store.load()
    assert state.notified == {}


def test_weekly_report_is_once_per_iso_week_after_scheduled_hour(tmp_path):
    store = NotificationStore(tmp_path / "notifications.json")
    store.save_preferences(
        NotificationPreferences(
            enabled=True,
            recipients=("admin@example.com",),
            immediate_enabled=False,
            weekly_enabled=True,
            weekly_weekday=0,
            weekly_hour=8,
        )
    )
    subjects: list[str] = []

    def sender(config, recipients, subject, text_body, html_body):
        subjects.append(subject)
        return DeliveryResult(True, "sent", 1)

    manager = NotificationManager(store, sender)
    monday = datetime(2026, 8, 17, 9, tzinfo=timezone.utc)

    assert len(manager.process_snapshot(_snapshot(), _settings(), monday)) == 1
    assert manager.process_snapshot(_snapshot(), _settings(), monday) == []
    assert len(
        manager.process_snapshot(_snapshot(), _settings(), monday + timedelta(days=7))
    ) == 1
    assert len(subjects) == 2


def test_disabled_subscription_does_not_collect(tmp_path):
    store = NotificationStore(tmp_path / "notifications.json")
    manager = NotificationManager(store)
    collected = False

    def collect():
        nonlocal collected
        collected = True
        return _snapshot()

    assert manager.run_cycle(collect, _settings()) == []
    assert not collected
