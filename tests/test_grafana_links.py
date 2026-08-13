"""Grafana deep links must resolve to a dashboard that exists.

Three of these links pointed at dashboards (`/d/raid/raid-health`,
`/d/node/node-exporter-full`, `/d/storage/storage-io`) that the monitoring
stack never provisioned. Nothing failed — Grafana served a 404 page, which
looks like a broken dashboard rather than a broken link, so it went unnoticed.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import components.layout as layout
from config import GrafanaConfig
from streamlit.testing.v1 import AppTest
from components.layout import (
    GRAFANA_DASHBOARD_UID,
    GRAFANA_PANELS,
)

DASHBOARD = (
    Path(__file__).resolve().parents[1]
    / "deploy"
    / "monitoring-stack"
    / "grafana"
    / "dashboards"
    / "streamanator.json"
)


def _dashboard() -> dict:
    return json.loads(DASHBOARD.read_text(encoding="utf-8"))


def test_dashboard_uid_matches_the_provisioned_dashboard():
    assert _dashboard()["uid"] == GRAFANA_DASHBOARD_UID


def test_every_panel_key_maps_to_a_real_panel():
    panel_ids = {panel["id"] for panel in _dashboard()["panels"]}
    unknown = {
        key: panel_id
        for key, panel_id in GRAFANA_PANELS.items()
        if panel_id not in panel_ids
    }
    assert not unknown, f"panel ids not present in the dashboard: {unknown}"


def test_panel_keys_describe_their_panel():
    """Guards against an id shifting to a different panel on a dashboard edit."""
    titles = {panel["id"]: panel["title"].lower() for panel in _dashboard()["panels"]}
    expectations = {
        "cpu": "cpu",
        "memory": "memory",
        "raid": "raid",
        "filesystem": "filesystem",
        "smart_temperature": "temperature",
        "probe_latency": "latency",
        "container_cpu": "container cpu",
    }
    for key, expected in expectations.items():
        assert expected in titles[GRAFANA_PANELS[key]], key


def test_pages_only_use_known_panel_keys():
    """Every `grafana_link(...)` call site names a key this module defines."""
    import re

    pages = (Path(__file__).resolve().parents[1] / "app_pages").glob("*.py")
    calls = []
    for page in pages:
        calls += re.findall(
            r'grafana_link\(\s*"([^"]*)"', page.read_text(encoding="utf-8")
        )
    assert calls, "no grafana_link call sites found"
    unknown = [key for key in calls if key and key not in GRAFANA_PANELS]
    assert not unknown, f"pages link to unknown panel keys: {unknown}"


def test_no_page_hand_writes_a_dashboard_path():
    """The old failure mode: a literal `/d/...` path in a page."""
    root = Path(__file__).resolve().parents[1]
    pages = [root / "app.py", *sorted((root / "app_pages").glob("*.py"))]
    offenders = [
        page.name
        for page in pages
        if '"/d/' in page.read_text(encoding="utf-8")
    ]
    assert not offenders, f"hand-written Grafana paths in: {offenders}"


def test_entry_point_uses_the_validated_browser_link_builder():
    source = (Path(__file__).resolve().parents[1] / "app.py").read_text(
        encoding="utf-8"
    )
    assert "config.grafana.url" not in source
    assert "sidebar_grafana_url = grafana_url()" in source


def test_browser_url_alone_counts_as_configured():
    grafana = GrafanaConfig(url="", browser_url="https://grafana.example.test")

    assert grafana.configured


def _settings(
    server_url: str = "http://127.0.0.1:3000",
    browser_url: str = "",
):
    grafana = SimpleNamespace(
        url=server_url,
        browser_url=browser_url,
        link_url=browser_url or server_url,
        configured=bool(server_url),
    )
    host = SimpleNamespace(primary_user="arm", address="10.0.40.100")
    return SimpleNamespace(grafana=grafana, host=host)


def test_browser_url_is_separate_from_server_health_address(monkeypatch):
    monkeypatch.setattr(
        layout,
        "get_settings",
        lambda: _settings(browser_url="https://grafana.example.test"),
    )

    url = layout.grafana_url("raid")

    assert url.startswith("https://grafana.example.test/d/")
    assert "viewPanel=4" in url
    assert "127.0.0.1" not in url


def test_loopback_grafana_link_requires_a_tunnel():
    assert layout._grafana_link_needs_tunnel("http://127.0.0.1:3000")
    assert layout._grafana_link_needs_tunnel("http://localhost:3000")
    assert layout._grafana_link_needs_tunnel("http://[::1]:3000")
    assert not layout._grafana_link_needs_tunnel("https://grafana.example.test")
    assert not layout._grafana_link_needs_tunnel("http://10.0.40.100:3000")


def test_grafana_url_rejects_credentials_and_non_http_schemes(monkeypatch):
    for unsafe in (
        "javascript:alert(1)",
        "ftp://grafana.example.test",
        "http://admin:secret@grafana.example.test",
        "http://grafana.example.test:not-a-port",
        "https://grafana.example.test?redirect=elsewhere",
    ):
        monkeypatch.setattr(layout, "get_settings", lambda value=unsafe: _settings(browser_url=value))
        assert layout.grafana_url() == ""


def test_loopback_link_renders_the_windows_tunnel_command(monkeypatch):
    monkeypatch.setattr(layout, "get_settings", _settings)
    app = AppTest.from_string(
        "from components.layout import grafana_link\n"
        "grafana_link('raid', 'Open RAID dashboard in Grafana')\n"
    ).run()

    assert not app.exception
    assert any("localhost-only" in caption.value for caption in app.caption)
    assert any(
        "ssh -NT -o ExitOnForwardFailure=yes "
        "-L 3000:127.0.0.1:3000 arm@10.0.40.100" in block.value
        for block in app.code
    )


def test_tunnel_uses_scheme_default_ports(monkeypatch):
    monkeypatch.setattr(
        layout,
        "get_settings",
        lambda: _settings(server_url="http://localhost"),
    )
    app = AppTest.from_string(
        "from components.layout import grafana_link\n"
        "grafana_link('raid', 'Open RAID dashboard in Grafana')\n"
    ).run()

    assert not app.exception
    assert any(
        "-L 80:127.0.0.1:80 arm@10.0.40.100" in block.value
        for block in app.code
    )
