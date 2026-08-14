"""Update status for the host and for the container images it runs.

Read-only, in the same spirit as `services/system.py`: nothing here installs,
pulls, restarts or writes. It answers four questions and stops.

    * How many packages are waiting, and how many of those are security fixes?
    * When did apt last refresh its lists, and when did it last actually
      upgrade something?
    * Does the host want a reboot, and which packages asked for it?
    * For each container: when was this image built, when was the container
      last recreated, and is the tag it tracks now pointing at a newer digest?

**Everything degrades to UNKNOWN rather than to a reassuring answer.** A
registry that cannot be reached must not render as "up to date" — that is the
one wrong answer that stops someone looking. Each dataclass carries the reason
alongside the verdict for exactly that purpose.

Two notes on the apt side. The package counts come from `apt-get -s upgrade`,
which needs no privilege at all; `apt-check` is preferred when
update-notifier-common is installed because it already knows which archive
counts as security. Neither refreshes the package lists — that needs root, and
Ubuntu's own `apt-daily.timer` already does it. `last_list_refresh` is
reported so a stale count is visible as stale instead of being quietly wrong.

On the registry side: a manifest request counts against Docker Hub's anonymous
pull allowance (100 per six hours, per IP). Eleven containers checked on every
page render would exhaust that within the hour and start returning 429s, which
is why `remote_digest()` is cached hard and why a failed lookup is cached too.
"""

from __future__ import annotations

import gzip
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from core.errors import ParseError
from services.system import run_command
from utils.cache import ttl_cache
from utils.logging_setup import get_logger

log = get_logger("updates")

APT_HISTORY = Path("/var/log/apt/history.log")
APT_HISTORY_ROTATED = Path("/var/log/apt/history.log.1.gz")
#: Written by APT::Periodic::Update-Package-Lists. Absent when periodic updates
#: are switched off, hence the pkgcache fallback below.
APT_UPDATE_STAMP = Path("/var/lib/apt/periodic/update-success-stamp")
APT_PKGCACHE = Path("/var/cache/apt/pkgcache.bin")
REBOOT_REQUIRED = Path("/run/reboot-required")
REBOOT_REQUIRED_PKGS = Path("/run/reboot-required.pkgs")
APT_CHECK = Path("/usr/lib/update-notifier/apt-check")


# ---------------------------------------------------------------------------
# Host packages
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AptStatus:
    """What apt has waiting, and what it last did."""

    #: False when nothing could be read at all — a non-Ubuntu host, or apt
    #: missing. Distinct from "zero packages pending".
    available: bool = False
    reason: str = ""
    upgradable: int | None = None
    security: int | None = None
    #: Names only, for the detail expander. Never the full version strings —
    #: the list is for recognising "oh, the kernel", not for auditing.
    packages: tuple[str, ...] = ()
    security_packages: tuple[str, ...] = ()
    last_list_refresh: float | None = None
    last_upgrade: float | None = None
    last_upgrade_packages: int = 0
    last_upgrade_command: str = ""
    reboot_required: bool = False
    reboot_packages: tuple[str, ...] = ()
    #: None when it could not be determined.
    unattended_enabled: bool | None = None

    @property
    def list_age_seconds(self) -> float | None:
        if self.last_list_refresh is None:
            return None
        return max(0.0, time.time() - self.last_list_refresh)

    @property
    def lists_are_stale(self) -> bool:
        """True when the pending count is old enough to be misleading.

        Ubuntu's apt-daily.timer runs roughly daily; two days without a
        successful refresh means the count below is not the current answer.
        """
        age = self.list_age_seconds
        return age is not None and age > 2 * 86400


def _apt_check_counts() -> tuple[int, int] | None:
    """(upgradable, security) from update-notifier's apt-check, or None.

    apt-check writes `total;security` to **stderr**, not stdout — a detail that
    makes a naive `capture stdout` read as "0 packages" on a host with fifty
    waiting.
    """
    if not APT_CHECK.exists():
        return None
    code, out, err = run_command([str(APT_CHECK)], timeout=20.0)
    if code != 0:
        return None
    return parse_apt_check(f"{out}\n{err}")


def parse_apt_check(text: str) -> tuple[int, int] | None:
    """Parse apt-check's `total;security` output. Pure, for testing."""
    for line in text.splitlines():
        match = re.fullmatch(r"\s*(\d+);(\d+)\s*", line)
        if match:
            return int(match.group(1)), int(match.group(2))
    return None


def parse_simulate_upgrade(text: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Package names from `apt-get -s upgrade`, and which are security fixes.

    Simulation lines look like::

        Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.15 Ubuntu:22.04/jammy-security [amd64])

    The archive suffix inside the parentheses is what distinguishes a security
    update from an ordinary one, and it is the only place that information
    appears without a second apt invocation.
    """
    names: list[str] = []
    security: list[str] = []
    for line in text.splitlines():
        match = re.match(r"^Inst\s+(\S+)\s", line)
        if not match:
            continue
        name = match.group(1)
        names.append(name)
        origin = line[match.end() :]
        if re.search(r"-security\b", origin):
            security.append(name)
    return tuple(names), tuple(security)


def _simulated_upgrade() -> tuple[tuple[str, ...], tuple[str, ...]] | None:
    # `-s` simulates: it resolves dependencies and prints what *would* happen
    # without touching dpkg, and it needs no privilege. `-q` drops the
    # progress noise; `-o APT::Get::Show-User-Simulation-Note=false` suppresses
    # the "NOTE: this is only a simulation" preamble that otherwise lands in
    # the middle of the output on some releases.
    code, out, err = run_command(
        [
            "apt-get",
            "-s",
            "-q",
            "-o",
            "APT::Get::Show-User-Simulation-Note=false",
            "upgrade",
        ],
        timeout=30.0,
    )
    if code != 0:
        log.debug("apt-get -s upgrade failed (rc=%s): %s", code, err.strip()[:200])
        return None
    return parse_simulate_upgrade(out)


def parse_apt_history(text: str) -> list[dict]:
    """Every completed transaction in an apt history.log, oldest first.

    The format is stanzas separated by blank lines::

        Start-Date: 2026-08-11  09:14:32
        Commandline: apt-get -y upgrade
        Upgrade: libssl3:amd64 (3.0.2-0ubuntu1.10, 3.0.2-0ubuntu1.15), ...
        End-Date: 2026-08-11  09:16:02

    Stanzas without an End-Date are in-flight or were interrupted, and are
    skipped: reporting an interrupted upgrade as the last successful one is
    how a half-configured dpkg state stays invisible.
    """
    events: list[dict] = []
    for stanza in re.split(r"\n\s*\n", text):
        if not stanza.strip():
            continue
        fields: dict[str, str] = {}
        key = ""
        for line in stanza.splitlines():
            match = re.match(r"^([A-Za-z-]+):\s?(.*)$", line)
            if match:
                key = match.group(1)
                fields[key] = match.group(2).strip()
            elif key:
                # Long package lists wrap onto continuation lines.
                fields[key] += " " + line.strip()
        if "Start-Date" not in fields or "End-Date" not in fields:
            continue
        when = _parse_apt_date(fields["Start-Date"])
        if when is None:
            continue
        changed = 0
        for action in ("Upgrade", "Install", "Remove", "Purge"):
            if fields.get(action):
                changed += fields[action].count("),") + 1
        events.append(
            {
                "start": when,
                "command": fields.get("Commandline", ""),
                "changed": changed,
                "upgraded": bool(fields.get("Upgrade")),
                "requested_by": fields.get("Requested-By", ""),
            }
        )
    events.sort(key=lambda e: e["start"])
    return events


def _parse_apt_date(value: str) -> float | None:
    """apt writes local time as `YYYY-MM-DD  HH:MM:SS` (two spaces)."""
    text = " ".join(value.split())
    try:
        parsed = time.strptime(text, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    try:
        return time.mktime(parsed)
    except (OverflowError, ValueError) as exc:
        raise ParseError(f"apt history date out of range: {value!r}") from exc


def _read_apt_history() -> list[dict]:
    """Recent history, falling back to the rotated log when the live one is fresh.

    A host that upgraded a week ago and has since had its log rotated would
    otherwise report "never", which reads as neglect rather than as rotation.
    """
    events: list[dict] = []
    for path in (APT_HISTORY_ROTATED, APT_HISTORY):
        try:
            if path.suffix == ".gz":
                text = gzip.decompress(path.read_bytes()).decode(
                    "utf-8", errors="replace"
                )
            else:
                text = path.read_text(encoding="utf-8", errors="replace")
        except (OSError, gzip.BadGzipFile, EOFError):
            continue
        events.extend(parse_apt_history(text))
    events.sort(key=lambda e: e["start"])
    return events


def _last_list_refresh() -> float | None:
    for path in (APT_UPDATE_STAMP, APT_PKGCACHE):
        try:
            return path.stat().st_mtime
        except OSError:
            continue
    return None


def parse_reboot_packages(text: str) -> tuple[str, ...]:
    return tuple(line.strip() for line in text.splitlines() if line.strip())


def _reboot_state() -> tuple[bool, tuple[str, ...]]:
    if not REBOOT_REQUIRED.exists():
        return False, ()
    try:
        return True, parse_reboot_packages(
            REBOOT_REQUIRED_PKGS.read_text(encoding="utf-8", errors="replace")
        )
    except OSError:
        return True, ()


def _unattended_enabled() -> bool | None:
    code, out, _ = run_command(
        ["systemctl", "is-enabled", "unattended-upgrades.service"], timeout=8.0
    )
    if code == 127:
        return None
    return out.strip() == "enabled"


@ttl_cache(seconds=300)
def apt_status() -> AptStatus:
    """Everything the host can say about its own packages. Never raises."""
    if not APT_HISTORY.parent.is_dir() and not Path("/etc/apt").is_dir():
        return AptStatus(
            available=False,
            reason="This host does not use apt, so package status is unavailable.",
        )

    counts = _apt_check_counts()
    packages: tuple[str, ...] = ()
    security_packages: tuple[str, ...] = ()
    simulated = _simulated_upgrade()
    if simulated is not None:
        packages, security_packages = simulated

    if counts is not None:
        upgradable, security = counts
    elif simulated is not None:
        upgradable, security = len(packages), len(security_packages)
    else:
        return AptStatus(
            available=False,
            reason=(
                "Neither apt-check nor `apt-get -s upgrade` could be run, so "
                "the pending-update count is unknown."
            ),
            last_list_refresh=_last_list_refresh(),
        )

    history = _read_apt_history()
    last = next((e for e in reversed(history) if e["changed"]), None)
    reboot_required, reboot_packages = _reboot_state()

    return AptStatus(
        available=True,
        upgradable=upgradable,
        security=security,
        packages=packages,
        security_packages=security_packages,
        last_list_refresh=_last_list_refresh(),
        last_upgrade=last["start"] if last else None,
        last_upgrade_packages=last["changed"] if last else 0,
        last_upgrade_command=last["command"] if last else "",
        reboot_required=reboot_required,
        reboot_packages=reboot_packages,
        unattended_enabled=_unattended_enabled(),
    )


# ---------------------------------------------------------------------------
# Container images
# ---------------------------------------------------------------------------

#: The manifest media types a modern multi-arch image can present. Sending all
#: four means the registry returns the *index* digest for a multi-arch tag,
#: which is what `docker pull` records in RepoDigests — omitting the index
#: types would return a per-architecture digest that never matches, and every
#: container would render as outdated forever.
_MANIFEST_ACCEPT = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)

_DEFAULT_REGISTRY = "registry-1.docker.io"


@dataclass(frozen=True)
class ImageRef:
    registry: str
    repository: str
    tag: str
    #: Set when the reference pins a digest directly (`image@sha256:…`).
    digest: str = ""

    @property
    def pinned(self) -> bool:
        return bool(self.digest)

    @property
    def display(self) -> str:
        if self.digest:
            return f"{self.repository}@{self.digest[:19]}…"
        return f"{self.repository}:{self.tag}"


def parse_image_ref(reference: str) -> ImageRef | None:
    """Split an image reference into registry, repository and tag.

    Docker's own rules, which are not guessable: a first component counts as a
    registry host only if it contains a dot or a colon, or is exactly
    `localhost`. Otherwise it is part of the repository path — which is why
    `linuxserver/sonarr` is a Docker Hub repo and `lscr.io/linuxserver/sonarr`
    is not. Single-component names get the implicit `library/` prefix.
    """
    text = (reference or "").strip()
    if not text:
        return None

    digest = ""
    if "@" in text:
        text, _, digest = text.partition("@")
        if not digest.startswith("sha256:"):
            return None

    registry = _DEFAULT_REGISTRY
    head, slash, tail = text.partition("/")
    if slash and ("." in head or ":" in head or head == "localhost"):
        registry, text = head, tail

    tag = "latest"
    # Only a colon *after* the last slash is a tag; `host:5000/repo` is not.
    if ":" in text.rsplit("/", 1)[-1]:
        text, _, tag = text.rpartition(":")

    if not text:
        return None
    if registry == _DEFAULT_REGISTRY and "/" not in text:
        text = f"library/{text}"
    return ImageRef(registry=registry, repository=text, tag=tag, digest=digest)


def _header(response, name: str) -> str:
    """Case-insensitive header lookup.

    `get_bounded` returns `dict(response.headers)`, which loses requests'
    case-insensitive mapping. Registries disagree about casing —
    `Www-Authenticate` and `WWW-Authenticate` are both in the wild — and an
    exact-case lookup that misses reads as "no challenge", which turns an
    ordinary 401-then-token exchange into a permanent UNKNOWN.
    """
    target = name.lower()
    for key, value in (response.headers or {}).items():
        if key.lower() == target:
            return value
    return ""


def _parse_www_authenticate(header: str) -> dict[str, str]:
    """Pull realm/service/scope out of a Bearer challenge."""
    if not header.lower().startswith("bearer "):
        return {}
    return {
        key.lower(): value
        for key, value in re.findall(r'(\w+)="([^"]*)"', header[len("bearer ") :])
    }


@ttl_cache(seconds=6 * 3600, max_entries=128)
def remote_digest(ref: ImageRef, timeout: float = 8.0) -> tuple[str, str]:
    """The digest the registry currently serves for this tag.

    Returns `(digest, "")` on success or `("", reason)` on any failure —
    including a rate limit, which is the failure this is most likely to hit
    and the one most likely to be misread as "up to date".

    Cached for six hours because a manifest request counts against Docker
    Hub's anonymous pull allowance.
    """
    from utils.http import get_bounded

    url = (
        f"https://{ref.registry}/v2/{ref.repository}/manifests/"
        f"{ref.digest or ref.tag}"
    )
    headers = {"Accept": _MANIFEST_ACCEPT}
    try:
        response = get_bounded(url, headers=headers, timeout=timeout, max_bytes=1 << 20)
        if response.status_code == 401:
            challenge = _parse_www_authenticate(_header(response, "www-authenticate"))
            realm = challenge.get("realm", "")
            if not realm.startswith("https://"):
                return "", "the registry asked for an authentication scheme we do not support"
            token_response = get_bounded(
                realm,
                params={
                    "service": challenge.get("service", ""),
                    "scope": challenge.get(
                        "scope", f"repository:{ref.repository}:pull"
                    ),
                },
                timeout=timeout,
                max_bytes=1 << 18,
            )
            if token_response.status_code != 200:
                return "", f"could not obtain a registry token (HTTP {token_response.status_code})"
            token = (token_response.json() or {}).get("token") or (
                token_response.json() or {}
            ).get("access_token")
            if not token:
                return "", "the registry returned no token"
            headers["Authorization"] = f"Bearer {token}"
            response = get_bounded(
                url, headers=headers, timeout=timeout, max_bytes=1 << 20
            )
    except Exception as exc:  # noqa: BLE001 - any transport failure is UNKNOWN
        return "", f"could not reach {ref.registry}: {type(exc).__name__}"

    if response.status_code == 429:
        return "", "registry rate limit reached — try again later"
    if response.status_code == 404:
        return "", "the registry has no such tag any more"
    if response.status_code != 200:
        return "", f"registry returned HTTP {response.status_code}"

    digest = _header(response, "docker-content-digest")
    if not digest:
        return "", "the registry did not return a content digest"
    return digest, ""


@dataclass(frozen=True)
class ImageStatus:
    """Whether one container's image is behind the tag it tracks."""

    container: str
    display: str
    reference: str
    #: "current" | "outdated" | "pinned" | "unknown"
    state: str
    detail: str = ""
    local_digest: str = ""
    latest_digest: str = ""
    #: When the local image was built by its publisher.
    image_created: float | None = None
    #: When this container was last created — i.e. last actually updated.
    container_created: float | None = None
    stack: str = ""

    @property
    def outdated(self) -> bool:
        return self.state == "outdated"

    @property
    def known(self) -> bool:
        return self.state in ("current", "outdated", "pinned")


def _local_digest(repo_digests: tuple[str, ...], ref: ImageRef) -> str:
    """The digest recorded for *this* repository, ignoring any others.

    An image can carry several RepoDigests when it has been tagged into more
    than one repository, and Docker writes them in whatever short form the
    pull used (`postgres@…`, not `registry-1.docker.io/library/postgres@…`).
    Both sides are therefore put through the same reference parser and
    compared exactly. A suffix match would be shorter and would happily
    accept `otherorg/sonarr` as a match for `linuxserver/sonarr`, reporting a
    perfectly current container as outdated.

    No fallback to "the only digest present": comparing against a digest from
    a different repository produces a confident wrong answer, where returning
    nothing produces an honest UNKNOWN.
    """
    for entry in repo_digests:
        repository, _, digest = entry.partition("@")
        if not digest:
            continue
        candidate = parse_image_ref(repository)
        if (
            candidate is not None
            and candidate.registry == ref.registry
            and candidate.repository == ref.repository
        ):
            return digest
    return ""


def image_status(
    container_name: str,
    display: str,
    reference: str,
    repo_digests: tuple[str, ...],
    image_created: float | None,
    container_created: float | None,
    stack: str = "",
    check_registry: bool = True,
) -> ImageStatus:
    """Classify one container's image. Pure apart from the registry lookup."""
    base = {
        "container": container_name,
        "display": display,
        "reference": reference,
        "image_created": image_created,
        "container_created": container_created,
        "stack": stack,
    }
    ref = parse_image_ref(reference)
    if ref is None:
        return ImageStatus(
            state="unknown", detail=f"could not parse the image reference {reference!r}", **base
        )
    if ref.pinned:
        return ImageStatus(
            state="pinned",
            detail="pinned to a digest, so the tag cannot move underneath it",
            local_digest=ref.digest,
            **base,
        )

    local = _local_digest(repo_digests, ref)
    if not local:
        return ImageStatus(
            state="unknown",
            detail=(
                "this image has no repository digest — it was built locally or "
                "loaded from an archive, so there is nothing to compare against"
            ),
            **base,
        )
    if not check_registry:
        return ImageStatus(
            state="unknown",
            detail="registry checks are disabled (UPDATES_CHECK_REGISTRY=false)",
            local_digest=local,
            **base,
        )

    latest, reason = remote_digest(ref)
    if not latest:
        return ImageStatus(
            state="unknown", detail=reason, local_digest=local, **base
        )
    return ImageStatus(
        state="current" if latest == local else "outdated",
        detail="",
        local_digest=local,
        latest_digest=latest,
        **base,
    )


@dataclass(frozen=True)
class ContainerUpdateReport:
    images: tuple[ImageStatus, ...] = ()
    #: Set when Docker itself could not be queried, so the table is absent
    #: rather than empty. An empty table and a broken daemon look identical.
    error: str = ""
    #: Compose project -> working directory, from container labels. Offered as
    #: a suggestion for an unconfigured stack, never used as a working
    #: directory (see `config.ComposeStack`).
    discovered_stack_dirs: dict[str, str] = field(default_factory=dict)
    checked_at: float = 0.0

    @property
    def outdated(self) -> tuple[ImageStatus, ...]:
        return tuple(i for i in self.images if i.outdated)

    @property
    def unknown(self) -> tuple[ImageStatus, ...]:
        return tuple(i for i in self.images if i.state == "unknown")


@ttl_cache(seconds=900)
def container_update_report() -> ContainerUpdateReport:
    """Every expected container's image, and whether its tag has moved on.

    Cached for fifteen minutes. The registry lookups behind it are cached far
    longer, so a refresh here re-reads Docker without spending the registry
    allowance again.
    """
    from config import get_settings
    from services.docker_service import (
        DockerUnavailable,
        compose_project_dirs,
        find_container,
        image_details,
        list_containers,
    )

    settings = get_settings()
    try:
        containers = list_containers()
    except DockerUnavailable as exc:
        return ContainerUpdateReport(error=str(exc), checked_at=time.time())

    details = image_details(c.image_id for c in containers)
    statuses: list[ImageStatus] = []
    for expected in settings.containers:
        container = find_container(containers, expected.name)
        if container is None:
            continue
        image = details.get(container.image_id)
        statuses.append(
            image_status(
                container_name=container.name,
                display=expected.display,
                reference=container.image,
                repo_digests=image.repo_digests if image else (),
                image_created=image.created if image else None,
                container_created=container.created_at,
                stack=expected.stack,
                check_registry=settings.updates.check_registry,
            )
        )
    return ContainerUpdateReport(
        images=tuple(statuses),
        discovered_stack_dirs=compose_project_dirs(containers),
        checked_at=time.time(),
    )
