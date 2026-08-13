"""Docker container inventory.

Uses the `docker` CLI rather than the socket API: the dashboard's service user
(`arm`) is already in the `docker` group on this host, the CLI is read-only for
the subcommands used here, and it avoids adding a dependency purely to reach a
socket. Every container is inspected in a *single* batched call so a page
render costs two subprocess invocations, not two per container.

Note the naming inconsistency this host actually has: the media stack mixes
Compose v1 and v2 names (`media-vpn_sonarr_1` vs `media-vpn-sabnzbd-1`) because
SABnzbd was recreated under Compose v2 during the 11 Aug 2026 update. The
matcher below tolerates both rather than assuming one convention.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Iterable

from services.system import run_command
from utils.logging_setup import get_logger

log = get_logger("docker")


@dataclass(frozen=True)
class ContainerInfo:
    name: str
    image: str
    #: The image's declared version label, when the image publishes one.
    version: str
    state: str
    status: str
    health: str | None
    started_at: float | None
    restart_count: int
    exit_code: int | None
    #: Host port -> container port publications.
    ports: dict[str, str] = field(default_factory=dict)
    compose_project: str = ""
    labels: dict[str, str] = field(default_factory=dict)
    #: Set when the container joins another container's network namespace,
    #: e.g. everything routed through Gluetun.
    network_mode: str = ""
    image_id: str = ""

    @property
    def running(self) -> bool:
        return self.state == "running"

    @property
    def healthy(self) -> bool | None:
        """True/False when a healthcheck exists, None when it does not."""
        if self.health is None:
            return None
        return self.health == "healthy"

    @property
    def uptime_seconds(self) -> float | None:
        if self.started_at is None or not self.running:
            return None
        return max(0.0, time.time() - self.started_at)

    @property
    def behind_container(self) -> str | None:
        """The container whose network namespace this one shares, if any."""
        if self.network_mode.startswith("container:"):
            return self.network_mode.split(":", 1)[1]
        return None


class DockerUnavailable(RuntimeError):
    """Docker could not be queried at all (not installed, no permission)."""


def _parse_docker_time(value: str | None) -> float | None:
    """Parse Docker's RFC3339 nanosecond timestamps."""
    if not value or value.startswith("0001-01-01"):
        return None
    from datetime import datetime

    text = value.replace("Z", "+00:00")
    if "." in text:
        head, _, tail = text.partition(".")
        digits = "".join(ch for ch in tail if ch.isdigit())[:6]
        remainder = tail[len("".join(ch for ch in tail if ch.isdigit())) :]
        text = f"{head}.{digits}{remainder}"
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def _parse_ports(port_bindings: dict | None) -> dict[str, str]:
    """Turn Docker's NetworkSettings.Ports into host->container mappings."""
    result: dict[str, str] = {}
    if not port_bindings:
        return result
    for container_port, bindings in port_bindings.items():
        if not bindings:
            continue
        for binding in bindings:
            host_port = binding.get("HostPort")
            host_ip = binding.get("HostIp", "")
            if not host_port:
                continue
            # Collapse the duplicate IPv4/IPv6 publications Docker emits.
            if host_ip in ("::", ""):
                host_ip = "0.0.0.0"
            result[f"{host_ip}:{host_port}"] = container_port
    return result


def list_containers(timeout: float = 8.0) -> list[ContainerInfo]:
    """All containers (running and not) with their inspect detail.

    Raises DockerUnavailable when the daemon cannot be reached, so callers can
    show NOT CONFIGURED / UNKNOWN rather than an empty "0 containers" list that
    would look like a healthy but empty host.
    """
    code, out, err = run_command(
        ["docker", "ps", "-a", "--no-trunc", "--format", "{{.Names}}"], timeout
    )
    if code != 0:
        raise DockerUnavailable(err.strip() or "docker ps failed")

    names = [line.strip() for line in out.splitlines() if line.strip()]
    if not names:
        return []

    # One inspect call for every container.
    code, out, err = run_command(["docker", "inspect", *names], timeout + 4.0)
    if code != 0:
        raise DockerUnavailable(err.strip() or "docker inspect failed")
    try:
        payload = json.loads(out)
    except json.JSONDecodeError as exc:
        raise DockerUnavailable(f"could not parse docker inspect output: {exc}") from exc

    containers: list[ContainerInfo] = []
    for item in payload:
        state = item.get("State", {}) or {}
        config = item.get("Config", {}) or {}
        labels = config.get("Labels") or {}
        network = item.get("NetworkSettings", {}) or {}
        host_config = item.get("HostConfig", {}) or {}
        health_block = state.get("Health") or {}

        containers.append(
            ContainerInfo(
                name=(item.get("Name") or "").lstrip("/"),
                image=config.get("Image", "") or item.get("Image", ""),
                version=labels.get("org.opencontainers.image.version", ""),
                state=state.get("Status", "unknown"),
                status=_status_text(state),
                health=health_block.get("Status") if health_block else None,
                started_at=_parse_docker_time(state.get("StartedAt")),
                restart_count=int(item.get("RestartCount", 0) or 0),
                exit_code=state.get("ExitCode"),
                ports=_parse_ports(network.get("Ports")),
                compose_project=labels.get("com.docker.compose.project", ""),
                labels=labels,
                network_mode=host_config.get("NetworkMode", ""),
                image_id=item.get("Image", ""),
            )
        )
    return containers


def _status_text(state: dict) -> str:
    status = state.get("Status", "unknown")
    if status == "running":
        started = _parse_docker_time(state.get("StartedAt"))
        if started:
            return f"Up since {time.strftime('%d %b %H:%M', time.localtime(started))}"
    if status == "exited":
        return f"Exited ({state.get('ExitCode')})"
    return status


def find_container(
    containers: Iterable[ContainerInfo], expected_name: str
) -> ContainerInfo | None:
    """Match an expected container name tolerantly.

    Exact match first, then a normalised comparison that ignores the
    underscore/hyphen difference between Compose v1 and v2 naming, then a
    service-name match. This is why a Compose upgrade that renames
    `media-vpn_sabnzbd_1` to `media-vpn-sabnzbd-1` does not make the dashboard
    claim the container vanished.
    """
    container_list = list(containers)
    for container in container_list:
        if container.name == expected_name:
            return container

    def normalise(name: str) -> str:
        return re.sub(r"[-_]", "", name).lower()

    target = normalise(expected_name)
    for container in container_list:
        if normalise(container.name) == target:
            return container

    # Fall back to the compose service label, which survives any renaming.
    service = expected_name
    for prefix in ("media-vpn_", "media-vpn-"):
        if service.startswith(prefix):
            service = service[len(prefix) :]
    service = re.sub(r"[-_]\d+$", "", service)
    for container in container_list:
        if container.labels.get("com.docker.compose.service") == service:
            return container
    return None


def get_container_logs(
    name: str, lines: int = 50, timeout: float = 8.0
) -> list[str]:
    """Recent container logs, used for cause analysis (e.g. Gluetun AUTH_FAILED).

    Read-only. Only called on demand or when a container is already unhealthy —
    never on every refresh of a healthy dashboard.
    """
    code, out, err = run_command(
        ["docker", "logs", "--tail", str(lines), name], timeout
    )
    if code != 0:
        return []
    # Docker splits logs across stdout/stderr; both matter for diagnostics.
    combined = f"{out}\n{err}".strip()
    return [line for line in combined.splitlines() if line.strip()]


def exec_readonly(
    container: str, args: list[str], timeout: float = 10.0
) -> tuple[int, str]:
    """Run a read-only command inside a container.

    Used only for the VPN exit-IP check, which has no equivalent from outside
    the Gluetun network namespace. The argv is fixed by the caller; nothing
    user-supplied reaches it, and no mutating command is ever passed.
    """
    code, out, err = run_command(["docker", "exec", container, *args], timeout)
    return code, out.strip() or err.strip()


def docker_version(timeout: float = 5.0) -> dict[str, str]:
    """Docker engine and Compose versions, for the diagnostics page.

    The README flagged a legacy docker-compose 1.29.2 that failed with
    `KeyError: 'ContainerConfig'`; surfacing both versions makes that visible.
    """
    info: dict[str, str] = {}
    code, out, _ = run_command(
        ["docker", "version", "--format", "{{.Server.Version}}"], timeout
    )
    if code == 0 and out.strip():
        info["engine"] = out.strip()
    code, out, _ = run_command(["docker", "compose", "version", "--short"], timeout)
    if code == 0 and out.strip():
        info["compose_v2"] = out.strip()
    code, out, _ = run_command(["docker-compose", "--version"], timeout)
    if code == 0 and out.strip():
        info["compose_v1"] = out.strip()
    return info
