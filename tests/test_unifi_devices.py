"""Switches and access points: classification, and not fetching them twice.

The inventory was already being fetched for the gateway panel and discarded,
so the switch and both APs were polled on every collection and never shown.
Two things had to be true to surface them: the role has to be derivable from
what the controller reports, and the second consumer must not double the
request count to get it.
"""

from __future__ import annotations

from services import unifi
from services.unifi import UnifiDevice


def device(**overrides) -> UnifiDevice:
    fields = {
        "device_id": "1",
        "name": "device",
        "model": "",
        "mac": "aa:bb:cc:dd:ee:ff",
        "ip_address": "10.0.40.2",
        "state": "ONLINE",
        "device_type": "",
    }
    fields.update(overrides)
    return UnifiDevice(**fields)


def test_role_from_reported_type():
    assert device(device_type="UDM").role == "gateway"
    assert device(device_type="USW").role == "switch"
    assert device(device_type="UAP").role == "access point"


def test_role_falls_back_to_the_model():
    """Some firmware leaves `type` empty; the model still identifies it."""
    assert device(model="UDM-Pro").role == "gateway"
    assert device(model="USW-24-PoE").role == "switch"
    assert device(model="UAP-AC-Pro").role == "access point"


def test_modern_access_points_are_recognised():
    """U6/U7 model names contain no "AP" at all.

    A substring match on "AP" — the obvious implementation — classifies a
    U6-Pro as an unknown device, which is how two access points end up missing
    from a page that claims to list them.
    """
    for model in ("U6-Pro", "U6-LR", "U7-Pro", "U6-Mesh"):
        assert device(model=model).role == "access point", model


def test_gateway_wins_over_the_switch_prefix():
    """USG starts with US, which is also the switch prefix.

    Order of the checks is the only thing separating them, so it is asserted
    rather than left to the reading.
    """
    assert device(model="USG-3P").role == "gateway"


def test_unknown_hardware_is_not_guessed():
    assert device(model="Some-New-Thing").role == "device"


def test_online_is_case_insensitive_on_state():
    assert device(state="ONLINE").online is True
    assert device(state="online").online is True
    assert device(state="OFFLINE").online is False


def test_pick_gateway_prefers_a_real_gateway():
    devices = [
        device(name="switch", model="USW-24-PoE"),
        device(name="ap", model="U6-Pro"),
        device(name="gw", model="UDM-Pro"),
    ]
    assert unifi._pick_gateway(devices).name == "gw"


def test_gateway_status_reuses_a_supplied_inventory(monkeypatch):
    """Passing devices in must not trigger a second inventory fetch.

    Statistics are one request per device, so re-fetching here would double the
    controller traffic every collection for an answer the caller already has.
    """
    calls: list[str] = []

    def _should_not_run(config):
        calls.append("fetched")
        return [], ""

    monkeypatch.setattr(unifi, "get_devices", _should_not_run)
    monkeypatch.setattr(
        unifi,
        "availability",
        lambda config: unifi.UnifiAvailability(True, "integration", ""),
    )

    class _Config:
        controller_url = "https://10.0.40.1"
        api_key = "key"
        verify_tls = False
        site = "default"

    status = unifi.get_gateway_status(
        _Config(), devices=[device(name="gw", model="UDM-Pro", cpu_percent=12.0)]
    )

    assert not calls, "the inventory was fetched despite being supplied"
    assert status.name == "gw"
    assert status.cpu_percent == 12.0


def test_radios_are_parsed_from_the_interfaces_payload():
    """Radio retry rates are the one wifi-quality number the API exposes."""
    radios = unifi._radios(
        {"interfaces": {"radios": [
            {"frequencyGHz": 2.4, "txRetriesPct": 8.5},
            {"frequencyGHz": 5, "txRetriesPct": 7.8},
        ]}}
    )
    assert [r.band for r in radios] == ["2.4 GHz", "5 GHz"]
    assert [r.tx_retries_percent for r in radios] == [8.5, 7.8]


def test_radios_absent_on_switches_and_gateways():
    """No radios is normal, not an error — the caller renders none."""
    assert unifi._radios({}) == ()
    assert unifi._radios({"interfaces": {}}) == ()
    assert unifi._radios({"interfaces": {"radios": []}}) == ()
    assert unifi._radios({"interfaces": "not a dict"}) == ()


def test_radio_entries_without_a_frequency_are_skipped():
    """A radio that cannot be labelled by band is not charted as one."""
    assert unifi._radios({"interfaces": {"radios": [{"txRetriesPct": 4.0}]}}) == ()


def test_six_gigahertz_radios_are_labelled_correctly():
    assert unifi.RadioStats(frequency_ghz=6.0).band == "6 GHz"
    assert unifi.RadioStats(frequency_ghz=5.0).band == "5 GHz"
    assert unifi.RadioStats(frequency_ghz=2.4).band == "2.4 GHz"


def test_uplink_rates_are_bits_and_stay_bits_in_the_model():
    """The model carries what the API reports; conversion happens at the edge.

    The API reports bits per second and the dashboard displays bytes. Keeping
    the raw unit in the dataclass means only the display sites convert, so a
    second consumer cannot double-convert.
    """
    ap = device(uplink_rx_bps=800.0, uplink_tx_bps=400.0)
    assert ap.uplink_rx_bps == 800.0
    assert ap.uplink_tx_bps == 400.0
