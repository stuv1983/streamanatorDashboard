"""Alert correlation.

Three alerts saying "Prowlarr DNS failed", "Prowlarr API unavailable" and
"Gluetun unhealthy" describe one incident, not three. Since the entire download
and indexer stack joins Gluetun's network namespace, a Gluetun failure
*mechanically* causes all of them — that dependency is known ahead of time, so
the dashboard can collapse the noise instead of making someone rediscover the
relationship at 2am.

Correlation only ever regroups alerts. It never suppresses one: an effect alert
stays available under its cause, so nothing is hidden.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from core.status import Alert, Status


@dataclass(frozen=True)
class CausalRule:
    """A known cause -> effect relationship between alert keys."""

    cause_key: str
    #: Effect keys, matched by prefix so per-service alerts group cleanly.
    effect_prefixes: tuple[str, ...]
    #: Replacement headline for the merged incident.
    incident_title: str
    explanation: str


#: The dependency graph this environment actually has.
CAUSAL_RULES: tuple[CausalRule, ...] = (
    CausalRule(
        cause_key="vpn.gluetun",
        effect_prefixes=(
            "probe.sabnzbd",
            "probe.sonarr",
            "probe.radarr",
            "probe.prowlarr",
            "probe.qbittorrent",
            "container.media-vpn",
            "app.sabnzbd",
            "app.sonarr",
            "app.radarr",
            "app.prowlarr",
            "app.qbittorrent",
            "vpn.leak",
        ),
        incident_title="Media VPN stack connectivity failure",
        explanation=(
            "Every container in the media stack shares Gluetun's network "
            "namespace, so when Gluetun loses its tunnel they all lose DNS and "
            "outbound connectivity simultaneously."
        ),
    ),
    CausalRule(
        cause_key="network.internet",
        effect_prefixes=("vpn.", "probe.", "app.", "backup.destination"),
        incident_title="Internet connectivity failure",
        explanation=(
            "With the WAN down, the VPN tunnel and every outbound probe fail as "
            "a consequence rather than independently."
        ),
    ),
    CausalRule(
        cause_key="raid.md127",
        effect_prefixes=("storage./mnt/media", "disk.io.md127", "app.plex", "app.immich"),
        incident_title="RAID array fault affecting media storage",
        explanation=(
            "/mnt/media lives on md127, so an array fault propagates to the "
            "filesystem and to every service reading from it."
        ),
    ),
    CausalRule(
        cause_key="server.docker",
        effect_prefixes=("container.", "vpn.", "app."),
        incident_title="Docker daemon unavailable",
        explanation=(
            "No container state can be read while the daemon is down, so all "
            "container-derived alerts are consequences of this one."
        ),
    ),
)


@dataclass
class Incident:
    """A cause alert with the effects it explains."""

    cause: Alert
    effects: list[Alert] = field(default_factory=list)
    title: str = ""
    explanation: str = ""

    @property
    def status(self) -> Status:
        return self.cause.status

    @property
    def is_correlated(self) -> bool:
        return bool(self.effects)


def correlate(alerts: list[Alert]) -> tuple[list[Incident], list[Alert]]:
    """Group alerts into incidents.

    Returns (incidents, uncorrelated_alerts). An alert is only claimed as an
    effect when its cause is *actually alerting* — a healthy Gluetun never
    absorbs an unrelated Sonarr failure.
    """
    by_key = {alert.key: alert for alert in alerts}
    claimed: set[str] = set()
    incidents: list[Incident] = []

    for rule in CAUSAL_RULES:
        cause = by_key.get(rule.cause_key)
        if cause is None or cause.status not in {Status.CRITICAL, Status.WARNING}:
            continue
        if cause.key in claimed:
            continue

        effects = [
            alert
            for alert in alerts
            if alert.key != cause.key
            and alert.key not in claimed
            and alert.status in {Status.CRITICAL, Status.WARNING, Status.UNKNOWN}
            and any(alert.key.startswith(prefix) for prefix in rule.effect_prefixes)
        ]
        if not effects:
            continue

        for effect in effects:
            effect.caused_by = cause.key
            claimed.add(effect.key)
        cause.effects = [e.key for e in effects]
        claimed.add(cause.key)

        incidents.append(
            Incident(
                cause=cause,
                effects=effects,
                title=rule.incident_title,
                explanation=rule.explanation,
            )
        )

    uncorrelated = [alert for alert in alerts if alert.key not in claimed]
    return incidents, uncorrelated


def probable_cause_for_disk_crc() -> tuple[str, str]:
    """Standard cause/action text for a rising CRC counter.

    Kept here rather than inline so the guidance stays consistent everywhere it
    appears. The point is to stop someone replacing a healthy disk: CRC errors
    are transmission errors on the SATA link, not media errors.
    """
    cause = (
        "UDMA CRC errors are checksum failures on the SATA link itself, not bad "
        "sectors. Usual culprits, in order of likelihood: SATA data cable, "
        "connector seating, backplane, controller port, power stability."
    )
    action = (
        "Inspect and reseat the physical data path before replacing the disk. "
        "Note which cable and port the serial is on, swap the cable, then watch "
        "whether the delta returns to zero."
    )
    return cause, action


def summarise_incident(incident: Incident) -> str:
    """One-paragraph incident description for the alert panel."""
    effect_list = ", ".join(e.title for e in incident.effects[:5])
    extra = "" if len(incident.effects) <= 5 else f" (+{len(incident.effects) - 5} more)"
    return (
        f"{incident.explanation} Primary cause: {incident.cause.title}. "
        f"Effects: {effect_list}{extra}."
    )
