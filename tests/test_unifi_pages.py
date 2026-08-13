"""The widened UniFi API remains lazy and does not slow collapsed pages."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

import config
from core import collector
from core.collector import Snapshot
from core.status import ComponentHealth, Status
from health.scoring import HealthScore
from services.system import Listener
from services import unifi

PACKAGE_ROOT = Path(__file__).resolve().parent.parent


def _snapshot() -> Snapshot:
    network = ComponentHealth(
        key="network",
        label="Network",
        status=Status.HEALTHY,
        weight=1.0,
        score=1.0,
    )
    security = ComponentHealth(
        key="security",
        label="Security",
        status=Status.HEALTHY,
        weight=1.0,
        score=1.0,
    )
    available = unifi.UnifiAvailability(True, "unifi", "connected")
    return Snapshot(
        health=HealthScore(
            score=100,
            status=Status.HEALTHY,
            reason="All monitored components are healthy.",
            components=[network, security],
        ),
        components={"network": network, "security": security},
        raw={
            "network": {
                "unifi": available,
                "vlans": [],
                "unifi_devices": [],
                "unifi_devices_error": "",
                "interface_rates": {},
            },
            "security": {
                "unifi": available,
                "listeners": [
                    Listener(
                        protocol="tcp",
                        address="0.0.0.0",
                        port=8000,
                        process="gluetun",
                    )
                ],
                "unexpected_listeners": [],
            },
        },
    )


@pytest.fixture
def configured_pages(monkeypatch):
    settings = config.Settings()
    configured_unifi = replace(
        settings.unifi,
        controller_url="https://controller.example",
        api_key="test-key",
        verify_tls=True,
    )
    settings = replace(settings, unifi=configured_unifi)

    monkeypatch.setattr(config, "get_settings", lambda: settings)
    monkeypatch.setattr(collector, "get_settings", lambda: settings, raising=False)
    monkeypatch.setattr("core.runtime.get_snapshot", lambda force=False: _snapshot())
    monkeypatch.setattr(unifi, "get_controller_info", lambda *args: unifi.ControllerInfo())
    monkeypatch.setattr(unifi, "get_networks", lambda *args: ([], ""))
    monkeypatch.setattr(unifi, "get_wans", lambda *args: ([], ""))
    monkeypatch.setattr(unifi, "get_firewall_zones", lambda *args: ([], ""))
    monkeypatch.setattr(unifi, "get_firewall_policies", lambda *args: ([], ""))
    return settings


@pytest.mark.parametrize("page", ("network.py", "security.py"))
def test_collapsed_advanced_panels_do_not_call_additional_endpoints(
    page: str, configured_pages, monkeypatch
):
    calls: list[str] = []
    monkeypatch.setattr(
        unifi,
        "get_api_collection",
        lambda *args: (calls.append(str(args[-1])) or [], ""),
    )
    monkeypatch.setattr(
        unifi,
        "get_api_detail",
        lambda *args: (calls.append(str(args[-2])) or {}, ""),
    )

    app = AppTest.from_file(
        str(PACKAGE_ROOT / "app_pages" / page), default_timeout=120
    ).run()

    assert not app.exception
    assert calls == []


def test_network_exposes_each_new_read_only_resource_group(configured_pages):
    app = AppTest.from_file(
        str(PACKAGE_ROOT / "app_pages" / "network.py"), default_timeout=120
    ).run()
    labels = {expander.label for expander in app.expander}
    for phrase in (
        "Devices pending adoption",
        "Connected clients",
        "WiFi broadcasts",
        "Switching topology",
        "UniFi VPN configuration",
        "Controller resources",
    ):
        assert any(phrase in label for label in labels), phrase


def test_security_exposes_acl_and_policy_resource_groups(configured_pages):
    app = AppTest.from_file(
        str(PACKAGE_ROOT / "app_pages" / "security.py"), default_timeout=120
    ).run()
    labels = {expander.label for expander in app.expander}
    assert any("Access control rules" in label for label in labels)
    assert any("DNS and traffic policies" in label for label in labels)


def test_security_identifies_gluetun_control_api_as_expected(configured_pages):
    app = AppTest.from_file(
        str(PACKAGE_ROOT / "app_pages" / "security.py"), default_timeout=120
    ).run()

    assert not app.exception
    assert config.EXPECTED_LISTENERS[8000] == "Gluetun HTTP control API"
    assert any("0 unexpected" in expander.label for expander in app.expander)
    assert any(
        "Gluetun's HTTP control API" in message.value for message in app.info
    )
