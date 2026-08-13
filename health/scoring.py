"""Global health score.

The score is a *summary*, never a way to average away a serious fault. Two
rules enforce that:

1. **Severity clamping.** Any CRITICAL component caps the overall score below
   the healthy band and forces the overall status to CRITICAL, no matter how
   good everything else looks. A degraded RAID with everything else perfect
   still reads CRITICAL — the spec's worked example of "82 / CRITICAL /
   RAID degraded" is exactly this behaviour.

2. **Status is derived from the worst component, not the number.** The number
   tells you how much is affected; the label tells you how bad the worst thing
   is. They are computed separately and shown together.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from core.status import Alert, ComponentHealth, Status, worst
from health.thresholds import COMPONENT_WEIGHTS

#: Score contribution of a component, by its status. UNKNOWN scores poorly but
#: not zero: unmeasured is worse than healthy, better than confirmed broken.
STATUS_SCORE: dict[Status, float] = {
    Status.HEALTHY: 1.0,
    Status.INFO: 0.97,
    Status.UNKNOWN: 0.55,
    Status.WARNING: 0.55,
    Status.CRITICAL: 0.0,
}

#: Ceilings applied to the final score when any component is in this state.
SEVERITY_CEILING: dict[Status, float] = {
    Status.CRITICAL: 84.0,
    Status.WARNING: 94.0,
    Status.UNKNOWN: 96.0,
}

#: Score bands used for the headline label when nothing is clamping.
HEALTHY_FLOOR = 90.0
DEGRADED_FLOOR = 70.0


@dataclass
class HealthScore:
    """The overall verdict for the whole environment."""

    score: float
    status: Status
    components: list[ComponentHealth] = field(default_factory=list)
    #: Plain-language explanation of why the status is what it is.
    reason: str = ""
    critical_count: int = 0
    warning_count: int = 0
    unknown_count: int = 0

    @property
    def label(self) -> str:
        return {
            Status.HEALTHY: "HEALTHY",
            Status.INFO: "HEALTHY",
            Status.WARNING: "DEGRADED",
            Status.CRITICAL: "CRITICAL",
            Status.UNKNOWN: "UNKNOWN",
        }[self.status]

    @property
    def worst_components(self) -> list[ComponentHealth]:
        """Components sorted worst-first, for the summary panel."""
        return sorted(
            self.components,
            key=lambda c: (c.status.rank, c.weight),
            reverse=True,
        )


def score_component(
    key: str,
    label: str,
    readings: list,
    alerts: list[Alert] | None = None,
    weight: float | None = None,
    detail: str = "",
) -> ComponentHealth:
    """Roll a set of readings up into one weighted component.

    The component's status is the worst of its readings — averaging statuses
    would let one critical disk disappear behind three healthy ones.
    """
    # Optional, not-deployed integrations are displayed but do not score.
    # Counting them would peg every component at UNKNOWN indefinitely, and a
    # score that can never reach 100 stops meaning anything.
    scoring_readings = [r for r in readings if r is not None and not r.optional]
    statuses = [r.status for r in scoring_readings]
    component_status = worst(statuses) if statuses else Status.UNKNOWN

    if scoring_readings:
        # The numeric score is the mean of the individual reading scores, so a
        # component with one bad disk out of four scores better than one where
        # all four are bad, while both still *report* as CRITICAL.
        score = sum(STATUS_SCORE[s] for s in statuses) / len(statuses)
    else:
        score = STATUS_SCORE[Status.UNKNOWN]

    return ComponentHealth(
        key=key,
        label=label,
        status=component_status,
        weight=weight if weight is not None else COMPONENT_WEIGHTS.get(key, 0.0),
        score=score,
        detail=detail,
        readings=list(readings),
        alerts=list(alerts or []),
    )


def calculate_health_score(components: list[ComponentHealth]) -> HealthScore:
    """Combine weighted components into the headline score and status."""
    if not components:
        return HealthScore(
            score=0.0,
            status=Status.UNKNOWN,
            reason="No health components were evaluated.",
        )

    total_weight = sum(c.weight for c in components)
    if total_weight <= 0:
        raw_score = 0.0
    else:
        raw_score = 100.0 * sum(c.score * c.weight for c in components) / total_weight

    worst_status = worst(c.status for c in components)

    # Clamp so a critical fault can never present as a comfortable number.
    ceiling = SEVERITY_CEILING.get(worst_status)
    score = min(raw_score, ceiling) if ceiling is not None else raw_score

    critical = [c for c in components if c.status is Status.CRITICAL]
    warning = [c for c in components if c.status is Status.WARNING]
    unknown = [c for c in components if c.status is Status.UNKNOWN]

    if critical:
        status = Status.CRITICAL
        reason = _summarise("Critical", critical)
    elif warning:
        status = Status.WARNING
        reason = _summarise("Degraded", warning)
    elif unknown:
        # Unmeasured components hold the overall status back from HEALTHY,
        # because a green dashboard should mean "checked and fine".
        status = Status.UNKNOWN
        reason = _summarise("Not measurable", unknown)
    elif score >= HEALTHY_FLOOR:
        status = Status.HEALTHY
        reason = "All monitored components are healthy."
    elif score >= DEGRADED_FLOOR:
        status = Status.WARNING
        reason = "Multiple components are below their normal operating range."
    else:
        status = Status.CRITICAL
        reason = "Overall health is well below normal."

    return HealthScore(
        score=round(score, 1),
        status=status,
        components=components,
        reason=reason,
        critical_count=len(critical),
        warning_count=len(warning),
        unknown_count=len(unknown),
    )


def _summarise(prefix: str, components: list[ComponentHealth]) -> str:
    names = ", ".join(c.label for c in components[:4])
    extra = "" if len(components) <= 4 else f" (+{len(components) - 4} more)"
    return f"{prefix}: {names}{extra}"


def collect_alerts(components: list[ComponentHealth]) -> list[Alert]:
    """All alerts across components, most severe first."""
    alerts: list[Alert] = []
    for component in components:
        alerts.extend(component.alerts)
    return sort_alerts(alerts)


def sort_alerts(alerts: list[Alert]) -> list[Alert]:
    """CRITICAL, then WARNING, then UNKNOWN, then INFO — newest first within."""
    return sorted(
        alerts,
        key=lambda a: (a.status.rank, a.since or 0.0),
        reverse=True,
    )
