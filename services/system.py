"""Direct, read-only interrogation of the host.

Everything here reads `/proc`, `/sys`, `statvfs` or runs a read-only command.
Nothing writes, restarts, or mutates. Each collector is timeout protected and
returns typed values with `None` for "could not measure", never 0.

This module exists because Prometheus is not deployed on streamanator yet. The
spec's preference for Prometheus still stands — the query layer prefers it when
`PROMETHEUS_URL` is set — but these collectors keep the dashboard useful today
and remain the source for things Prometheus genuinely cannot provide (mdadm
detail, systemd unit state without node_exporter's textfile collector, live
listener inventory).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from core.errors import ParseError
from utils.cache import ttl_cache
from utils.logging_setup import get_logger

log = get_logger("system")

IS_LINUX = os.name == "posix" and Path("/proc").is_dir()


def run_command(
    args: list[str], timeout: float = 5.0
) -> tuple[int, str, str]:
    """Run a read-only command with a hard timeout.

    Returns (returncode, stdout, stderr). A missing binary or a timeout is
    reported as a non-zero return code rather than raising, because a failed
    optional probe must degrade to UNKNOWN, not break the page.
    """
    if not args or shutil.which(args[0]) is None and not Path(args[0]).exists():
        return 127, "", f"{args[0]}: not found"
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return completed.returncode, completed.stdout, completed.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    except OSError as exc:
        return 126, "", str(exc)


def _read_text(path: str) -> str | None:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


# ---------------------------------------------------------------------------
# CPU
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CpuSample:
    """Cumulative jiffy counters from /proc/stat."""

    total: float
    idle: float
    iowait: float
    steal: float
    timestamp: float


@dataclass(frozen=True)
class CpuUsage:
    used_percent: float
    iowait_percent: float
    steal_percent: float
    #: Seconds the two samples were apart, so callers can judge significance.
    interval_seconds: float


#: Previous /proc/stat sample, so usage is a true rate rather than the
#: since-boot average that reading the file once would give.
_last_cpu_sample: CpuSample | None = None


def read_cpu_sample() -> CpuSample | None:
    content = _read_text("/proc/stat")
    if not content:
        return None
    for line in content.splitlines():
        if not line.startswith("cpu "):
            continue
        fields = [float(x) for x in line.split()[1:] if x.replace(".", "").isdigit()]
        if len(fields) < 5:
            return None
        # user nice system idle iowait irq softirq steal guest guest_nice
        idle = fields[3]
        iowait = fields[4]
        steal = fields[7] if len(fields) > 7 else 0.0
        return CpuSample(
            total=sum(fields[:8]) if len(fields) >= 8 else sum(fields),
            idle=idle,
            iowait=iowait,
            steal=steal,
            timestamp=time.time(),
        )
    return None


def get_cpu_usage() -> CpuUsage | None:
    """CPU utilisation since the previous call.

    Returns None on the first call of the process — there is no rate to report
    from a single cumulative sample, and inventing one would be a lie.
    """
    global _last_cpu_sample
    current = read_cpu_sample()
    if current is None:
        return None
    previous = _last_cpu_sample
    _last_cpu_sample = current
    if previous is None:
        return None

    total_delta = current.total - previous.total
    if total_delta <= 0:
        return None
    idle_delta = current.idle - previous.idle
    iowait_delta = current.iowait - previous.iowait
    steal_delta = current.steal - previous.steal
    # /proc/stat's idle column excludes iowait, so busy time is everything
    # that is neither idle nor waiting on I/O.
    used = 100.0 * (total_delta - idle_delta - iowait_delta) / total_delta
    return CpuUsage(
        used_percent=max(0.0, min(100.0, used)),
        iowait_percent=max(0.0, 100.0 * iowait_delta / total_delta),
        steal_percent=max(0.0, 100.0 * steal_delta / total_delta),
        interval_seconds=current.timestamp - previous.timestamp,
    )


@dataclass(frozen=True)
class LoadAverage:
    one: float
    five: float
    fifteen: float
    running_processes: int
    total_processes: int


def get_load_average() -> LoadAverage | None:
    content = _read_text("/proc/loadavg")
    if not content:
        try:
            one, five, fifteen = os.getloadavg()
            return LoadAverage(one, five, fifteen, 0, 0)
        except (OSError, AttributeError):
            return None
    parts = content.split()
    if len(parts) < 4:
        return None
    try:
        running, _, total = parts[3].partition("/")
        return LoadAverage(
            one=float(parts[0]),
            five=float(parts[1]),
            fifteen=float(parts[2]),
            running_processes=int(running),
            total_processes=int(total or 0),
        )
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MemoryInfo:
    total_bytes: int
    available_bytes: int
    used_bytes: int
    cached_bytes: int
    swap_total_bytes: int
    swap_used_bytes: int

    @property
    def available_percent(self) -> float | None:
        if self.total_bytes <= 0:
            return None
        return 100.0 * self.available_bytes / self.total_bytes

    @property
    def used_percent(self) -> float | None:
        if self.total_bytes <= 0:
            return None
        return 100.0 * self.used_bytes / self.total_bytes

    @property
    def swap_used_percent(self) -> float | None:
        if self.swap_total_bytes <= 0:
            return None
        return 100.0 * self.swap_used_bytes / self.swap_total_bytes


def get_memory_info() -> MemoryInfo | None:
    """Memory from /proc/meminfo, reported via MemAvailable.

    MemAvailable is the kernel's own estimate of what a new workload could get
    without swapping; `MemFree` would make a healthy 27 GiB page cache look
    like an emergency.
    """
    content = _read_text("/proc/meminfo")
    if not content:
        return None
    values: dict[str, int] = {}
    for line in content.splitlines():
        key, _, rest = line.partition(":")
        fields = rest.split()
        if not fields:
            continue
        try:
            values[key.strip()] = int(fields[0]) * 1024  # kB -> bytes
        except ValueError:
            continue
    if "MemTotal" not in values:
        return None
    total = values["MemTotal"]
    available = values.get("MemAvailable", values.get("MemFree", 0))
    swap_total = values.get("SwapTotal", 0)
    swap_free = values.get("SwapFree", 0)
    return MemoryInfo(
        total_bytes=total,
        available_bytes=available,
        used_bytes=max(0, total - available),
        cached_bytes=values.get("Cached", 0) + values.get("Buffers", 0),
        swap_total_bytes=swap_total,
        swap_used_bytes=max(0, swap_total - swap_free),
    )


# ---------------------------------------------------------------------------
# Uptime / processes
# ---------------------------------------------------------------------------


def get_uptime_seconds() -> float | None:
    content = _read_text("/proc/uptime")
    if content:
        try:
            return float(content.split()[0])
        except (ValueError, IndexError):
            return None
    return None


def get_boot_time() -> float | None:
    uptime = get_uptime_seconds()
    return time.time() - uptime if uptime is not None else None


def get_process_count() -> int | None:
    if not IS_LINUX:
        return None
    try:
        return sum(1 for entry in os.listdir("/proc") if entry.isdigit())
    except OSError:
        return None


# ---------------------------------------------------------------------------
# Filesystems
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FilesystemUsage:
    mountpoint: str
    total_bytes: int
    used_bytes: int
    free_bytes: int
    inodes_total: int
    inodes_free: int

    @property
    def used_percent(self) -> float | None:
        # Percentages are computed against total-minus-reserved so they match
        # what `df` reports, rather than counting root's reserved blocks as free.
        denominator = self.used_bytes + self.free_bytes
        if denominator <= 0:
            return None
        return 100.0 * self.used_bytes / denominator

    @property
    def inodes_used_percent(self) -> float | None:
        if self.inodes_total <= 0:
            return None
        return 100.0 * (self.inodes_total - self.inodes_free) / self.inodes_total


def get_filesystem_usage(mountpoint: str) -> FilesystemUsage | None:
    """Usage for one mountpoint via statvfs."""
    try:
        stat = os.statvfs(mountpoint)
    except (OSError, AttributeError):
        return None
    block = stat.f_frsize or stat.f_bsize
    total = stat.f_blocks * block
    free_unprivileged = stat.f_bavail * block
    free_total = stat.f_bfree * block
    used = total - free_total
    return FilesystemUsage(
        mountpoint=mountpoint,
        total_bytes=total,
        used_bytes=used,
        free_bytes=free_unprivileged,
        inodes_total=stat.f_files,
        inodes_free=stat.f_favail,
    )


def list_mountpoints() -> list[str]:
    """Real (non-virtual) mountpoints from /proc/mounts."""
    content = _read_text("/proc/mounts")
    if not content:
        return []
    skip_types = {
        "proc", "sysfs", "devtmpfs", "tmpfs", "devpts", "cgroup", "cgroup2",
        "securityfs", "pstore", "bpf", "debugfs", "tracefs", "configfs",
        "fusectl", "efivarfs", "squashfs", "autofs", "hugetlbfs", "mqueue",
        "nsfs", "binfmt_misc", "overlay",
    }
    mounts: list[str] = []
    for line in content.splitlines():
        fields = line.split()
        if len(fields) < 3 or fields[2] in skip_types:
            continue
        mounts.append(fields[1])
    return mounts


# ---------------------------------------------------------------------------
# RAID (/proc/mdstat + mdadm)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MdArray:
    """Parsed state of one MD array."""

    device: str
    active: bool
    level: str
    #: Member device names as the kernel currently sees them. Deliberately not
    #: treated as stable identity — /dev/sdX moved between boots on this host.
    members: list[str]
    failed_members: list[str]
    spare_members: list[str]
    total_blocks: int
    disks_required: int
    disks_active: int
    #: The [UUUU] string; 'U' is up, '_' is a missing member.
    state_string: str
    sync_action: str | None = None
    sync_percent: float | None = None
    sync_speed_kbps: float | None = None
    sync_finish_minutes: float | None = None

    @property
    def degraded(self) -> bool:
        return self.disks_active < self.disks_required

    @property
    def resyncing(self) -> bool:
        return self.sync_action is not None


_MD_HEADER = re.compile(
    r"^(?P<device>md\d+)\s*:\s*(?P<state>\w+)\s+(?P<level>\S+)\s+(?P<members>.*)$"
)
_MD_STATUS = re.compile(
    r"^\s*(?P<blocks>\d+)\s+blocks.*?\[(?P<required>\d+)/(?P<active>\d+)\]\s+"
    r"\[(?P<flags>[U_]+)\]"
)
_MD_SYNC = re.compile(
    r"^\s*\[[=>.]*\]\s+(?P<action>\w+)\s*=\s*(?P<percent>[\d.]+)%.*?"
    r"finish=(?P<finish>[\d.]+)min\s+speed=(?P<speed>\d+)K/sec"
)
_MD_MEMBER = re.compile(r"^(?P<name>\w+)\[(?P<index>\d+)\](?P<flags>\([FS]\))?$")


def parse_mdstat(content: str) -> list[MdArray]:
    """Parse /proc/mdstat into structured arrays.

    Written as a pure function so the degraded-array logic can be unit tested
    against captured real-world output without touching a live host.
    """
    arrays: list[MdArray] = []
    lines = content.splitlines()
    index = 0
    while index < len(lines):
        header = _MD_HEADER.match(lines[index])
        if not header:
            index += 1
            continue

        members: list[str] = []
        failed: list[str] = []
        spare: list[str] = []
        for token in header.group("members").split():
            member = _MD_MEMBER.match(token)
            if not member:
                continue
            name = member.group("name")
            flags = member.group("flags") or ""
            members.append(name)
            if "F" in flags:
                failed.append(name)
            elif "S" in flags:
                spare.append(name)

        blocks = 0
        required = 0
        active_count = 0
        state_string = ""
        sync_action = None
        sync_percent = None
        sync_speed = None
        sync_finish = None

        cursor = index + 1
        while cursor < len(lines) and lines[cursor].strip() and not _MD_HEADER.match(
            lines[cursor]
        ):
            status = _MD_STATUS.match(lines[cursor])
            if status:
                blocks = int(status.group("blocks"))
                required = int(status.group("required"))
                active_count = int(status.group("active"))
                state_string = status.group("flags")
            sync = _MD_SYNC.match(lines[cursor])
            if sync:
                sync_action = sync.group("action")
                sync_percent = float(sync.group("percent"))
                sync_finish = float(sync.group("finish"))
                sync_speed = float(sync.group("speed"))
            cursor += 1

        arrays.append(
            MdArray(
                device=header.group("device"),
                active=header.group("state") == "active",
                level=header.group("level"),
                members=members,
                failed_members=failed,
                spare_members=spare,
                total_blocks=blocks,
                disks_required=required,
                disks_active=active_count,
                state_string=state_string,
                sync_action=sync_action,
                sync_percent=sync_percent,
                sync_speed_kbps=sync_speed,
                sync_finish_minutes=sync_finish,
            )
        )
        index = cursor
    return arrays


def get_md_arrays(mdstat_path: str = "/proc/mdstat") -> list[MdArray] | None:
    content = _read_text(mdstat_path)
    if content is None:
        return None
    try:
        return parse_mdstat(content)
    except (ValueError, IndexError) as exc:
        raise ParseError(
            f"Could not parse {mdstat_path}: {exc}", source="local:mdstat"
        ) from exc


def get_md_detail(device: str, timeout: float = 5.0) -> dict[str, str]:
    """`mdadm --detail` key/values. Empty when mdadm needs privileges.

    Non-fatal by design: the array state that matters is already in
    /proc/mdstat, which is world readable. This only adds UUID, chunk size and
    the per-slot table when permissions allow.
    """
    code, out, _ = run_command(["mdadm", "--detail", f"/dev/{device}"], timeout)
    if code != 0:
        return {}
    detail: dict[str, str] = {}
    for line in out.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        if key and not key.startswith("/dev"):
            detail[key] = value.strip()
    return detail


# ---------------------------------------------------------------------------
# Block devices and disk I/O
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BlockDevice:
    name: str
    serial: str
    model: str
    size_bytes: int
    mountpoints: list[str] = field(default_factory=list)
    fstype: str = ""


@ttl_cache(seconds=300)
def get_block_devices(timeout: float = 5.0) -> list[BlockDevice]:
    """Disk inventory keyed by serial via lsblk.

    Serial is the identity; the /dev/sdX name is recorded only as the current
    kernel label, because it demonstrably changes across reboots here.
    """
    code, out, err = run_command(
        ["lsblk", "-b", "-d", "-n", "-o", "NAME,SIZE,MODEL,SERIAL,TYPE"], timeout
    )
    if code != 0:
        log.debug("lsblk unavailable: %s", err)
        return []
    devices: list[BlockDevice] = []
    for line in out.splitlines():
        fields = line.split(None, 4)
        if len(fields) < 4:
            continue
        name, size_raw = fields[0], fields[1]
        remainder = fields[2] if len(fields) > 2 else ""
        # MODEL can contain spaces; lsblk pads columns, so re-split from the end.
        tokens = line.split()
        if tokens[-1] != "disk":
            continue
        serial = tokens[-2]
        model = " ".join(tokens[2:-2])
        try:
            size = int(size_raw)
        except ValueError:
            size = 0
        devices.append(
            BlockDevice(name=name, serial=serial, model=model or remainder, size_bytes=size)
        )
    return devices


@dataclass(frozen=True)
class DiskIoSample:
    device: str
    read_sectors: int
    write_sectors: int
    read_ios: int
    write_ios: int
    read_ticks: int
    write_ticks: int
    io_ticks: int
    timestamp: float


@dataclass(frozen=True)
class DiskIoRate:
    device: str
    read_bytes_per_sec: float
    write_bytes_per_sec: float
    read_iops: float
    write_iops: float
    read_latency_ms: float | None
    write_latency_ms: float | None
    utilisation_percent: float


_last_diskstats: dict[str, DiskIoSample] = {}
_SECTOR_BYTES = 512


def read_diskstats() -> dict[str, DiskIoSample]:
    content = _read_text("/proc/diskstats")
    if not content:
        return {}
    now = time.time()
    samples: dict[str, DiskIoSample] = {}
    for line in content.splitlines():
        fields = line.split()
        if len(fields) < 14:
            continue
        name = fields[2]
        # Skip partitions and loop/ram devices; we care about whole devices
        # and the md array.
        if name.startswith(("loop", "ram", "dm-")):
            continue
        try:
            samples[name] = DiskIoSample(
                device=name,
                read_ios=int(fields[3]),
                read_sectors=int(fields[5]),
                read_ticks=int(fields[6]),
                write_ios=int(fields[7]),
                write_sectors=int(fields[9]),
                write_ticks=int(fields[10]),
                io_ticks=int(fields[12]),
                timestamp=now,
            )
        except (ValueError, IndexError):
            continue
    return samples


def get_disk_io_rates() -> dict[str, DiskIoRate]:
    """Per-device I/O rates since the previous call. Empty on first call."""
    global _last_diskstats
    current = read_diskstats()
    previous = _last_diskstats
    _last_diskstats = current
    if not previous:
        return {}

    rates: dict[str, DiskIoRate] = {}
    for name, sample in current.items():
        before = previous.get(name)
        if before is None:
            continue
        elapsed = sample.timestamp - before.timestamp
        if elapsed <= 0:
            continue
        read_ios = max(0, sample.read_ios - before.read_ios)
        write_ios = max(0, sample.write_ios - before.write_ios)
        read_ticks = max(0, sample.read_ticks - before.read_ticks)
        write_ticks = max(0, sample.write_ticks - before.write_ticks)
        io_ticks = max(0, sample.io_ticks - before.io_ticks)
        rates[name] = DiskIoRate(
            device=name,
            read_bytes_per_sec=(sample.read_sectors - before.read_sectors)
            * _SECTOR_BYTES
            / elapsed,
            write_bytes_per_sec=(sample.write_sectors - before.write_sectors)
            * _SECTOR_BYTES
            / elapsed,
            read_iops=read_ios / elapsed,
            write_iops=write_ios / elapsed,
            # Average service time per I/O; None when nothing was requested,
            # because "0 ms latency" on an idle disk is misleading.
            read_latency_ms=(read_ticks / read_ios) if read_ios else None,
            write_latency_ms=(write_ticks / write_ios) if write_ios else None,
            utilisation_percent=min(100.0, 100.0 * io_ticks / (elapsed * 1000.0)),
        )
    return rates


# ---------------------------------------------------------------------------
# Temperatures
# ---------------------------------------------------------------------------


def get_cpu_temperatures() -> dict[str, float]:
    """Sensor readings from /sys/class/hwmon, in Celsius."""
    results: dict[str, float] = {}
    hwmon_root = Path("/sys/class/hwmon")
    if not hwmon_root.is_dir():
        return results
    try:
        for hwmon in hwmon_root.iterdir():
            chip = (_read_text(str(hwmon / "name")) or "").strip() or hwmon.name
            for sensor in sorted(hwmon.glob("temp*_input")):
                raw = _read_text(str(sensor))
                if raw is None:
                    continue
                try:
                    celsius = float(raw.strip()) / 1000.0
                except ValueError:
                    continue
                if not (-40.0 < celsius < 150.0):
                    continue  # implausible reading; drop rather than display
                label_file = sensor.parent / sensor.name.replace("_input", "_label")
                label = (_read_text(str(label_file)) or "").strip()
                key = f"{chip}/{label or sensor.stem}"
                results[key] = celsius
    except OSError:
        return results
    return results


# ---------------------------------------------------------------------------
# systemd
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SystemdUnit:
    name: str
    load_state: str
    active_state: str
    sub_state: str
    description: str = ""

    @property
    def failed(self) -> bool:
        return self.active_state == "failed" or self.sub_state == "failed"


def get_failed_units(timeout: float = 5.0) -> list[SystemdUnit] | None:
    """Units in a failed state. None when systemd cannot be queried."""
    code, out, _ = run_command(
        ["systemctl", "--failed", "--no-legend", "--plain", "--no-pager"], timeout
    )
    if code != 0:
        return None
    units: list[SystemdUnit] = []
    for line in out.splitlines():
        fields = line.split(None, 4)
        if len(fields) < 4:
            continue
        # A leading bullet glyph appears on some versions.
        if fields[0] in {"●", "*", "×"}:
            fields = fields[1:]
        if len(fields) < 4:
            continue
        units.append(
            SystemdUnit(
                name=fields[0],
                load_state=fields[1],
                active_state=fields[2],
                sub_state=fields[3],
                description=fields[4] if len(fields) > 4 else "",
            )
        )
    return units


def get_unit_state(unit: str, timeout: float = 5.0) -> SystemdUnit | None:
    """State of one named unit."""
    code, out, _ = run_command(
        [
            "systemctl",
            "show",
            unit,
            "--property=LoadState,ActiveState,SubState,Description",
            "--no-pager",
        ],
        timeout,
    )
    if code != 0:
        return None
    values: dict[str, str] = {}
    for line in out.splitlines():
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    if not values.get("LoadState"):
        return None
    return SystemdUnit(
        name=unit,
        load_state=values.get("LoadState", ""),
        active_state=values.get("ActiveState", ""),
        sub_state=values.get("SubState", ""),
        description=values.get("Description", ""),
    )


def get_unit_logs(unit: str, lines: int = 20, timeout: float = 6.0) -> list[str]:
    """Recent journal lines for a unit — read-only, used for cause analysis."""
    code, out, _ = run_command(
        ["journalctl", "-u", unit, "-n", str(lines), "--no-pager", "-o", "short-iso"],
        timeout,
    )
    if code != 0:
        return []
    return [line for line in out.splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# Listeners
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Listener:
    protocol: str
    address: str
    port: int
    process: str = ""

    @property
    def loopback_only(self) -> bool:
        return self.address.startswith(("127.", "::1", "127.0.0.53"))


_SS_LINE = re.compile(r"^(?P<state>\S+)\s+\d+\s+\d+\s+(?P<local>\S+)\s+\S+(?P<rest>.*)$")


def get_listeners(timeout: float = 5.0) -> list[Listener]:
    """Listening TCP sockets via `ss -lntp`.

    Process names only appear for sockets the running user owns; the dashboard
    runs unprivileged, so most will be blank. The port inventory is the point.
    """
    code, out, _ = run_command(["ss", "-lntp"], timeout)
    if code != 0:
        return []
    listeners: list[Listener] = []
    for line in out.splitlines()[1:]:
        match = _SS_LINE.match(line.strip())
        if not match:
            continue
        local = match.group("local")
        address, _, port_text = local.rpartition(":")
        try:
            port = int(port_text)
        except ValueError:
            continue
        process = ""
        rest = match.group("rest")
        proc_match = re.search(r'users:\(\("([^"]+)"', rest)
        if proc_match:
            process = proc_match.group(1)
        listeners.append(
            Listener(
                protocol="tcp",
                address=address.strip("[]") or "0.0.0.0",
                port=port,
                process=process,
            )
        )
    return listeners


# ---------------------------------------------------------------------------
# Convenience snapshot
# ---------------------------------------------------------------------------


@dataclass
class HostSnapshot:
    """Everything the Server page needs, gathered in one pass."""

    cpu: CpuUsage | None
    load: LoadAverage | None
    memory: MemoryInfo | None
    uptime_seconds: float | None
    process_count: int | None
    temperatures: dict[str, float]
    failed_units: list[SystemdUnit] | None
    collected_at: float = field(default_factory=time.time)


def get_host_snapshot(command_timeout: float = 5.0) -> HostSnapshot:
    return HostSnapshot(
        cpu=get_cpu_usage(),
        load=get_load_average(),
        memory=get_memory_info(),
        uptime_seconds=get_uptime_seconds(),
        process_count=get_process_count(),
        temperatures=get_cpu_temperatures(),
        failed_units=get_failed_units(command_timeout),
    )
