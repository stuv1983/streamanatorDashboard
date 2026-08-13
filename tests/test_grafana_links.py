"""Grafana deep links must resolve to a dashboard that exists.

Three of these links pointed at dashboards (`/d/raid/raid-health`,
`/d/node/node-exporter-full`, `/d/storage/storage-io`) that the monitoring
stack never provisioned. Nothing failed — Grafana served a 404 page, which
looks like a broken dashboard rather than a broken link, so it went unnoticed.
"""

from __future__ import annotations

import json
from pathlib import Path

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
    pages = (Path(__file__).resolve().parents[1] / "app_pages").glob("*.py")
    offenders = [
        page.name
        for page in pages
        if '"/d/' in page.read_text(encoding="utf-8")
    ]
    assert not offenders, f"hand-written Grafana paths in: {offenders}"
