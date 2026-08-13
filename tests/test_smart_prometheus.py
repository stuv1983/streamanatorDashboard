"""The Prometheus SMART collector's device->serial join.

This path shipped broken: it read a `serial_number` label off the attribute
and temperature metrics, but smartctl_exporter only puts the serial on the
`smartctl_device` info metric — everything else is labelled by `device`. So it
found disks but every reading came back blank, and it did so silently because
nothing tested it against the exporter's real label shape.

The fake client below reproduces that shape exactly (captured from the live
exporter): serial only on `smartctl_device`, CRC named `CRC_Error_Count` with
id 199, and temperature keyed by device. If the join regresses, the WPV2E6LL
CRC reads as None again — which is the failure these assertions catch.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from services import smart


@dataclass
class _Item:
    labels: dict
    value: float


class _FakeClient:
    """Mimics PrometheusClient.query() for the smartctl metric families."""

    def __init__(self, available=True):
        self._available = available

    def available(self):
        return self._available

    def query(self, promql: str):
        if promql == "smartctl_device":
            return [
                _Item({"device": "sda", "serial_number": "WPV2E65M",
                       "model_name": "ST8000VN002-2ZM188"}, 1.0),
                _Item({"device": "sde", "serial_number": "WPV2E6LL",
                       "model_name": "ST8000VN002-2ZM188"}, 1.0),
                _Item({"device": "sdf", "serial_number": "2518106901831",
                       "model_name": "BIWIN M100 1TB"}, 1.0),
            ]
        if "attribute_id='199'" in promql:  # CRC — note: NO serial label here
            return [
                _Item({"device": "sda", "attribute_id": "199"}, 0.0),
                _Item({"device": "sde", "attribute_id": "199"}, 5670.0),
                _Item({"device": "sdf", "attribute_id": "199"}, 0.0),
            ]
        if "temperature" in promql:
            return [
                _Item({"device": "sda"}, 31.0),
                _Item({"device": "sde"}, 36.0),
            ]
        if "smart_status" in promql:
            return [
                _Item({"device": "sda"}, 1.0),
                _Item({"device": "sde"}, 1.0),
                _Item({"device": "sdf"}, 1.0),
            ]
        if "power_on_seconds" in promql:
            return [_Item({"device": "sde"}, 3600.0 * 100)]
        return []


def test_collector_joins_device_to_serial():
    disks = smart.collect_smart_from_prometheus(_FakeClient())
    assert set(disks) == {"WPV2E65M", "WPV2E6LL", "2518106901831"}


def test_watched_disk_crc_is_read_not_blank():
    """The exact regression: WPV2E6LL's CRC must come through as 5670, not None.
    A None here is the silent failure the untested collector produced."""
    disks = smart.collect_smart_from_prometheus(_FakeClient())
    assert disks["WPV2E6LL"].udma_crc_errors == 5670.0
    assert disks["WPV2E65M"].udma_crc_errors == 0.0


def test_readings_are_populated_from_device_labelled_metrics():
    disks = smart.collect_smart_from_prometheus(_FakeClient())
    watched = disks["WPV2E6LL"]
    assert watched.temperature_celsius == 36.0
    assert watched.passed is True
    assert watched.power_on_hours == 100.0
    assert watched.model == "ST8000VN002-2ZM188"
    assert watched.device == "sde"


def test_crc_matched_by_id_survives_the_name_difference():
    """The Seagates name this attribute CRC_Error_Count, not
    UDMA_CRC_Error_Count. Matching by name (the old code) read blanks; matching
    by id 199 (the fix) reads the value regardless of the name."""
    disks = smart.collect_smart_from_prometheus(_FakeClient())
    assert disks["WPV2E6LL"].udma_crc_errors == 5670.0


def test_unavailable_client_returns_empty():
    assert smart.collect_smart_from_prometheus(_FakeClient(available=False)) == {}
    assert smart.collect_smart_from_prometheus(None) == {}
