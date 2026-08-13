"""Physical disk (SMART) health.

Two possible sources, in preference order:

1. **smartctl_exporter via Prometheus** — the right long-term answer, and the
   only one that gives history without this dashboard sampling it itself.
2. **`smartctl` directly** — needs root. On streamanator the dashboard user
   `arm` has no passwordless sudo, so this path is *disabled by default* and
   reports NOT CONFIGURED with the exact remediation, rather than silently
   returning nothing. Install `deploy/sudoers-smartctl` to enable it.

Disks are keyed by **serial number**, never `/dev/sdX`. On this host the device
letters demonstrably moved between boots — the 11 Aug 2026 incident had
`WPV2E6LL` appear on a different path and get kicked from the array — so a
serial is the only stable identity.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field

from services.system import get_block_devices, run_command
from utils.cache import ttl_cache
from utils.logging_setup import get_logger

log = get_logger("smart")

#: SMART attribute IDs the dashboard cares about, with their canonical names.
ATTRIBUTE_IDS: dict[int, str] = {
    5: "reallocated_sector_count",
    9: "power_on_hours",
    12: "power_cycle_count",
    187: "reported_uncorrectable_errors",
    188: "command_timeout",
    193: "load_cycle_count",
    194: "temperature_celsius",
    197: "current_pending_sector",
    198: "offline_uncorrectable",
    199: "udma_crc_error_count",
}


@dataclass
class SmartDisk:
    """SMART state for one physical disk, identified by serial."""

    serial: str
    model: str
    device: str
    #: smartctl's overall self-assessment. None when it could not be read.
    passed: bool | None = None
    temperature_celsius: float | None = None
    power_on_hours: float | None = None
    power_cycle_count: float | None = None
    reallocated_sectors: float | None = None
    current_pending_sectors: float | None = None
    offline_uncorrectable: float | None = None
    reported_uncorrectable: float | None = None
    udma_crc_errors: float | None = None
    command_timeouts: float | None = None
    #: Raw attribute table, for the disk detail view.
    attributes: dict[str, float] = field(default_factory=dict)
    collected_at: float = field(default_factory=time.time)
    source: str = "smartctl"

    @property
    def rotational(self) -> bool:
        return self.power_on_hours is not None and "SSD" not in self.model.upper()


class SmartUnavailable(RuntimeError):
    """SMART data cannot be collected in the current configuration."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


def smartctl_available(path: str = "/usr/sbin/smartctl") -> bool:
    code, _, _ = run_command([path, "--version"], timeout=4.0)
    return code == 0


def _extract_attributes(payload: dict) -> dict[str, float]:
    """Pull the ATA attribute table out of `smartctl -j` output."""
    attributes: dict[str, float] = {}
    table = (payload.get("ata_smart_attributes") or {}).get("table") or []
    for entry in table:
        attr_id = entry.get("id")
        name = ATTRIBUTE_IDS.get(attr_id)
        if name is None:
            continue
        raw = (entry.get("raw") or {}).get("value")
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        # Attribute 194's raw value packs min/max into the high bits on some
        # firmware; the low 16 bits hold the current temperature.
        if attr_id == 194 and value > 1000:
            value = float(int(value) & 0xFFFF)
        attributes[name] = value
    return attributes


def read_smart_device(
    device: str, smartctl_path: str = "/usr/sbin/smartctl", use_sudo: bool = False,
    timeout: float = 12.0,
) -> SmartDisk | None:
    """Read SMART for one /dev node. Returns None when it cannot be read."""
    args = [smartctl_path, "-j", "-a", device]
    if use_sudo:
        args = ["sudo", "-n", *args]
    code, out, err = run_command(args, timeout)
    # smartctl uses a bitmask exit code; bits 0-2 mean the command itself
    # failed, higher bits are disk conditions we still want to report on.
    if not out.strip():
        log.debug("smartctl produced no output for %s: %s", device, err.strip())
        return None
    try:
        payload = json.loads(out)
    except json.JSONDecodeError:
        return None
    if code & 0b11:
        messages = payload.get("smartctl", {}).get("messages", [])
        text = "; ".join(m.get("string", "") for m in messages)
        log.debug("smartctl could not open %s: %s", device, text)
        return None

    attributes = _extract_attributes(payload)
    temperature = payload.get("temperature", {}).get("current")
    if temperature is None:
        temperature = attributes.get("temperature_celsius")

    power_on = (payload.get("power_on_time") or {}).get("hours")
    if power_on is None:
        power_on = attributes.get("power_on_hours")

    status = payload.get("smart_status") or {}
    return SmartDisk(
        serial=str(payload.get("serial_number", "")).strip(),
        model=str(payload.get("model_name", "")).strip(),
        device=device,
        passed=status.get("passed"),
        temperature_celsius=float(temperature) if temperature is not None else None,
        power_on_hours=float(power_on) if power_on is not None else None,
        power_cycle_count=attributes.get("power_cycle_count")
        or payload.get("power_cycle_count"),
        reallocated_sectors=attributes.get("reallocated_sector_count"),
        current_pending_sectors=attributes.get("current_pending_sector"),
        offline_uncorrectable=attributes.get("offline_uncorrectable"),
        reported_uncorrectable=attributes.get("reported_uncorrectable_errors"),
        udma_crc_errors=attributes.get("udma_crc_error_count"),
        command_timeouts=attributes.get("command_timeout"),
        attributes=attributes,
        source="smartctl",
    )


@ttl_cache(seconds=180)
def collect_smart_local(
    smartctl_path: str = "/usr/sbin/smartctl",
    use_sudo: bool = False,
    timeout: float = 12.0,
) -> dict[str, SmartDisk]:
    """SMART for every block device, keyed by serial.

    Raises SmartUnavailable when smartctl exists but every device was refused,
    which is what happens when it is run without privileges — an important
    distinction from "the disks are fine and reported nothing".

    Cached for three minutes, failures included. Seven smartctl subprocesses
    cost the same whether they succeed or are refused, and SMART attributes
    move on the order of hours, not seconds.
    """
    if not smartctl_available(smartctl_path):
        raise SmartUnavailable(
            "smartctl is not installed",
            hint="apt-get install smartmontools, or deploy the smartctl exporter.",
        )

    devices = get_block_devices()
    if not devices:
        raise SmartUnavailable(
            "No block devices could be enumerated",
            hint="Check that lsblk is available to the dashboard user.",
        )

    disks: dict[str, SmartDisk] = {}
    refused = 0
    for device in devices:
        disk = read_smart_device(
            f"/dev/{device.name}", smartctl_path, use_sudo, timeout
        )
        if disk is None:
            refused += 1
            continue
        serial = disk.serial or device.serial
        if serial:
            disks[serial] = disk

    if not disks and refused:
        raise SmartUnavailable(
            f"smartctl could not read any of {refused} devices (permission denied)",
            hint=(
                "SMART needs root. Install deploy/sudoers-smartctl and set "
                "SMARTCTL_SUDO=true, or run the smartctl_exporter container."
            ),
        )
    return disks


#: SMART attribute IDs, keyed on rather than names. The exporter reports the
#: same counter under different *names* across firmwares — the CRC error count
#: is `UDMA_CRC_Error_Count` on some drives and `CRC_Error_Count` on the
#: Seagate IronWolfs in this array — but the numeric ID is stable. Keying on
#: the name is exactly why the first version found the disks but read a blank
#: CRC.
_ATTR_CRC = "199"
_ATTR_PENDING = "197"
_ATTR_REALLOCATED = "5"
_ATTR_OFFLINE = "198"
_ATTR_TIMEOUT = "188"


def collect_smart_from_prometheus(client, timeout: float = 4.0) -> dict[str, SmartDisk]:
    """SMART via smartctl_exporter metrics.

    Preferred when available: it gives the dashboard history for free, which is
    what the CRC delta actually needs.

    The exporter puts the serial number only on the `smartctl_device` info
    metric; every other series (attributes, temperature, health) is labelled
    by `device` (sda, sde, …), which is reboot-unstable. So this builds a
    device→serial map from `smartctl_device` first and joins everything to it,
    keying the result by serial — the identifier the rest of the dashboard,
    and the WPV2E6LL CRC watch, actually use.
    """
    disks: dict[str, SmartDisk] = {}
    if not client or not client.available():
        return disks

    # device -> (serial, model). The join key for everything below.
    device_serial: dict[str, str] = {}
    models: dict[str, str] = {}
    try:
        for item in client.query("smartctl_device"):
            device = item.labels.get("device", "")
            serial = item.labels.get("serial_number", "")
            if device and serial:
                device_serial[device] = serial
                models[serial] = item.labels.get("model_name", "")
    except Exception as exc:  # noqa: BLE001
        log.debug("smartctl_device query failed: %s", exc)
        return disks

    def by_serial(promql: str) -> dict[str, float]:
        """Query a device-labelled metric and re-key it by serial."""
        try:
            results = client.query(promql)
        except Exception as exc:  # noqa: BLE001
            log.debug("SMART query failed (%s): %s", promql, exc)
            return {}
        values: dict[str, float] = {}
        for item in results:
            device = item.labels.get("device", "")
            serial = device_serial.get(device)
            if serial:
                values[serial] = item.value
        return values

    temperatures = by_serial("smartctl_device_temperature{temperature_type='current'}")
    status = by_serial("smartctl_device_smart_status")
    power_on = by_serial("smartctl_device_power_on_seconds")

    def attribute(attr_id: str) -> dict[str, float]:
        # Matched by numeric id, not name — stable across firmwares.
        return by_serial(
            f"smartctl_device_attribute{{attribute_id='{attr_id}',"
            f"attribute_value_type='raw'}}"
        )

    crc = attribute(_ATTR_CRC)
    pending = attribute(_ATTR_PENDING)
    reallocated = attribute(_ATTR_REALLOCATED)
    offline = attribute(_ATTR_OFFLINE)
    timeouts = attribute(_ATTR_TIMEOUT)

    for serial in device_serial.values():
        disks[serial] = SmartDisk(
            serial=serial,
            model=models.get(serial, ""),
            device=next(
                (d for d, s in device_serial.items() if s == serial), ""
            ),
            passed=bool(status[serial]) if serial in status else None,
            temperature_celsius=temperatures.get(serial),
            power_on_hours=(power_on[serial] / 3600.0) if serial in power_on else None,
            reallocated_sectors=reallocated.get(serial),
            current_pending_sectors=pending.get(serial),
            offline_uncorrectable=offline.get(serial),
            udma_crc_errors=crc.get(serial),
            command_timeouts=timeouts.get(serial),
            source="prometheus:smartctl_exporter",
        )
    return disks
