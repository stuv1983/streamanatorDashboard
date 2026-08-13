"""User-managed service probes, layered over the configured defaults.

A probe answers "is this application actually working?", which is a different
question from "is the container running?". The built-in list in `config.py`
covers what was found on the host; this module lets probes be added, disabled
and retargeted from the admin console without editing source.

**The target policy is a real control, not a formality.** §37 of the brief —
no aggressive Internet scanning — survives here as a rule with teeth: probes
at private, loopback or link-local addresses are unrestricted, because that is
this network. A probe aimed at a public address requires an explicit
acknowledgement that the host belongs to you, is capped in number, and is
written to the audit log with the target recorded.

Without that, a monitoring dashboard with a URL field and a 30-second timer is
a scanner that someone else has to explain — and the person operating it would
have no idea, because from the inside it just looks like a green tick.
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import requests

from config import SERVICE_ENDPOINTS, PROJECT_ROOT
from utils.cache import ttl_cache
from utils.fileio import atomic_write_text
from utils.logging_setup import get_logger

log = get_logger("admin.probes")

OVERLAY_PATH = Path(
    os.environ.get("PROBES_CONFIG_PATH", PROJECT_ROOT / "var" / "probes.json")
)

#: How many public-internet targets may be probed at once. A handful of
#: deliberate checks is monitoring; dozens is a scan.
MAX_PUBLIC_TARGETS = 5

#: Probes are user-triggered or run on the sampler's schedule; neither should
#: ever be able to hang a render.
PROBE_TIMEOUT = 8.0

_UA = {"User-Agent": "streamanator-dashboard/1.0 (service probe)"}

ALLOWED_SCHEMES = ("http", "https")
ALLOWED_METHODS = ("GET", "HEAD")


@dataclass
class ProbeDefinition:
    key: str
    label: str
    url: str
    expect_status: tuple[int, ...] = (200,)
    method: str = "GET"
    enabled: bool = True
    critical: bool = False
    #: Set by the operator for a target outside RFC1918. Recorded in the audit
    #: log; the probe is refused without it.
    external_acknowledged: bool = False
    #: True for entries that come from config.py rather than the overlay.
    builtin: bool = False
    hosting: str = ""
    note: str = ""

    @property
    def host(self) -> str:
        return urlparse(self.url).hostname or ""


@dataclass(frozen=True)
class TargetVerdict:
    allowed: bool
    reason: str = ""
    is_public: bool = False
    resolved: str = ""


@dataclass(frozen=True)
class ProbeResult:
    key: str
    ok: bool
    status: int | None
    latency_ms: float | None
    detail: str
    at: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# Target policy
# ---------------------------------------------------------------------------


@ttl_cache(seconds=300)
def _resolve(hostname: str) -> tuple[str, ...]:
    """Resolve a hostname to addresses. Cached — DNS is not free per render."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except (socket.gaierror, UnicodeError):
        return ()
    return tuple({info[4][0] for info in infos})


def classify_target(url: str) -> TargetVerdict:
    """Decide whether a URL may be probed at all, and whether it is public.

    Resolution happens here rather than at request time so a hostname that
    points somewhere unexpected is caught before any traffic is sent.
    """
    parsed = urlparse(url.strip())
    if parsed.scheme not in ALLOWED_SCHEMES:
        return TargetVerdict(False, "Only http:// and https:// URLs can be probed.")
    if not parsed.hostname:
        return TargetVerdict(False, "That URL has no hostname.")

    candidates: list[str] = []
    try:
        candidates.append(str(ipaddress.ip_address(parsed.hostname)))
    except ValueError:
        resolved = _resolve(parsed.hostname)
        if not resolved:
            return TargetVerdict(
                False,
                f"`{parsed.hostname}` does not resolve. Check the name, or use "
                "an IP address.",
            )
        candidates.extend(resolved)

    public: list[str] = []
    for address in candidates:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if not (ip.is_private or ip.is_loopback or ip.is_link_local):
            public.append(address)

    if public:
        return TargetVerdict(
            True,
            "This target is on the public Internet.",
            is_public=True,
            resolved=", ".join(sorted(public)),
        )
    return TargetVerdict(True, "Private address.", resolved=", ".join(candidates))


def validate_definition(
    definition: ProbeDefinition, existing: list[ProbeDefinition]
) -> list[str]:
    """Everything wrong with a probe definition, as messages for the form."""
    problems: list[str] = []
    if not definition.key or not definition.key.replace("_", "").isalnum():
        problems.append("Key must be letters, digits and underscores only.")
    if not definition.label.strip():
        problems.append("Give the probe a display name.")
    if definition.method not in ALLOWED_METHODS:
        problems.append(f"Method must be one of {', '.join(ALLOWED_METHODS)}.")
    if not definition.expect_status:
        problems.append("Specify at least one acceptable status code.")

    verdict = classify_target(definition.url)
    if not verdict.allowed:
        problems.append(verdict.reason)
    elif verdict.is_public:
        if not definition.external_acknowledged:
            problems.append(
                f"`{definition.host}` resolves to a public address "
                f"({verdict.resolved}). Confirm you own this host before "
                "probing it on a timer."
            )
        else:
            others = [
                p
                for p in existing
                if p.key != definition.key
                and p.enabled
                and classify_target(p.url).is_public
            ]
            if len(others) >= MAX_PUBLIC_TARGETS:
                problems.append(
                    f"Already probing {len(others)} public targets, which is "
                    f"the limit of {MAX_PUBLIC_TARGETS}. Disable one first."
                )
    return problems


# ---------------------------------------------------------------------------
# Overlay persistence
# ---------------------------------------------------------------------------


class OverlayCorruptError(RuntimeError):
    """The probe overlay exists but cannot be trusted.

    Fails closed rather than returning {}: an empty dict here would be saved
    back on the next edit, quietly erasing every customisation because of one
    bad byte. The admin page shows the error and refuses to mutate.
    """


def load_overlay() -> dict[str, dict]:
    if not OVERLAY_PATH.is_file():
        return {}
    try:
        payload = json.loads(OVERLAY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OverlayCorruptError(f"Probe overlay unreadable: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("probes"), list):
        raise OverlayCorruptError("Probe overlay has an invalid top-level schema.")
    overlay: dict[str, dict] = {}
    for entry in payload["probes"]:
        if not isinstance(entry, dict) or not entry.get("key"):
            raise OverlayCorruptError("Probe overlay entry is not a valid object.")
        overlay[entry["key"]] = entry
    return overlay


def save_overlay(entries: dict[str, dict]) -> None:
    OVERLAY_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "updated_at": time.time(),
        "probes": list(entries.values()),
    }
    atomic_write_text(
        OVERLAY_PATH, json.dumps(payload, indent=2, sort_keys=True), mode=0o600
    )


def effective_probes() -> list[ProbeDefinition]:
    """Configured defaults with the overlay applied on top.

    Built-in probes can be disabled or retargeted but never deleted, so the
    overlay cannot silently drop coverage of a service the dashboard knows
    should exist. Disabling one is visible; a missing entry would not be.
    """
    overlay = load_overlay()
    probes: list[ProbeDefinition] = []
    seen: set[str] = set()

    for endpoint in SERVICE_ENDPOINTS:
        if not endpoint.url:
            continue
        override = overlay.get(endpoint.key, {})
        probes.append(
            ProbeDefinition(
                key=endpoint.key,
                label=override.get("label", endpoint.display),
                url=override.get("url", endpoint.url),
                expect_status=tuple(
                    override.get("expect_status", list(endpoint.expect_status))
                ),
                method=override.get("method", "GET"),
                enabled=override.get("enabled", True),
                critical=override.get("critical", endpoint.critical),
                external_acknowledged=override.get("external_acknowledged", False),
                builtin=True,
                hosting=endpoint.hosting,
                note=override.get("note", ""),
            )
        )
        seen.add(endpoint.key)

    for key, entry in overlay.items():
        if key in seen:
            continue
        probes.append(
            ProbeDefinition(
                key=key,
                label=entry.get("label", key),
                url=entry.get("url", ""),
                expect_status=tuple(entry.get("expect_status", [200])),
                method=entry.get("method", "GET"),
                enabled=entry.get("enabled", True),
                critical=entry.get("critical", False),
                external_acknowledged=entry.get("external_acknowledged", False),
                builtin=False,
                note=entry.get("note", ""),
            )
        )
    return sorted(probes, key=lambda p: (not p.critical, p.label.lower()))


def upsert(definition: ProbeDefinition) -> None:
    overlay = load_overlay()
    stored = asdict(definition)
    stored["expect_status"] = list(definition.expect_status)
    # Provenance is derived from config each time; storing it would let the
    # overlay lie about whether a probe is built in.
    stored.pop("builtin", None)
    stored.pop("hosting", None)
    overlay[definition.key] = stored
    save_overlay(overlay)


def remove(key: str) -> bool:
    """Delete a custom probe. Built-ins are disabled instead — see effective_probes.

    A built-in is handled first and does not require an existing overlay entry.
    Checking the overlay first would silently do nothing the first time a
    built-in was disabled, since it has no overlay entry until something
    writes one — and the UI would report success either way.
    """
    overlay = load_overlay()
    if any(e.key == key for e in SERVICE_ENDPOINTS):
        entry = overlay.get(key, {"key": key})
        entry["enabled"] = False
        overlay[key] = entry
        save_overlay(overlay)
        return True
    if key not in overlay:
        return False
    del overlay[key]
    save_overlay(overlay)
    return True


# ---------------------------------------------------------------------------
# Running a probe
# ---------------------------------------------------------------------------


def run_probe(definition: ProbeDefinition) -> ProbeResult:
    """Send one request. Never raises."""
    verdict = classify_target(definition.url)
    if not verdict.allowed:
        return ProbeResult(definition.key, False, None, None, verdict.reason)
    if verdict.is_public and not definition.external_acknowledged:
        return ProbeResult(
            definition.key,
            False,
            None,
            None,
            "Refused: public target without acknowledgement.",
        )

    started = time.perf_counter()
    try:
        # stream=True + close(): the probe judges the status line, so the
        # body is never downloaded — a service that answers 200 and then
        # streams forever cannot pin a worker thread or buffer unbounded
        # bytes here.
        response = requests.request(
            definition.method,
            definition.url,
            headers=_UA,
            timeout=PROBE_TIMEOUT,
            allow_redirects=False,
            stream=True,
            verify=False if definition.url.startswith("https://10.") else True,
        )
        response.close()
    except requests.RequestException as exc:
        return ProbeResult(
            definition.key,
            False,
            None,
            (time.perf_counter() - started) * 1000,
            str(exc).split("\n")[0][:160],
        )
    latency = (time.perf_counter() - started) * 1000
    ok = response.status_code in definition.expect_status
    detail = (
        f"HTTP {response.status_code}"
        if ok
        else f"HTTP {response.status_code}, expected "
        + "/".join(str(s) for s in definition.expect_status)
    )
    return ProbeResult(definition.key, ok, response.status_code, latency, detail)
