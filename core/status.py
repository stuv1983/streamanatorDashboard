"""Status vocabulary and the value types every service returns.

Two ideas carry most of the design weight:

1. **Missing data is not zero.** A `Reading` distinguishes "the counter is 0"
   from "we could not read the counter" from "this integration is not set up".
   `Status.UNKNOWN` is the honest answer for the latter two, and it must never
   be laundered into a healthy-looking green.

2. **A status carries its reasoning.** Every non-healthy `Reading` should be
   able to explain what was measured, what threshold it crossed, and what to
   look at next — that is the difference between a dashboard and a wall of
   numbers.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Generic, Iterable, TypeVar


class Status(str, Enum):
    """The four core states, plus INFO for notable-but-benign facts."""

    HEALTHY = "HEALTHY"
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"
    UNKNOWN = "UNKNOWN"

    @property
    def rank(self) -> int:
        """Sort/aggregate order. Higher means more attention required.

        UNKNOWN outranks HEALTHY deliberately: not knowing whether the RAID is
        fine is worse than knowing it is.
        """
        return _RANK[self]

    @property
    def icon(self) -> str:
        """Material Symbols name, so state is never conveyed by colour alone."""
        return _ICON[self]

    @property
    def label(self) -> str:
        return _LABEL[self]

    @property
    def tooltip(self) -> str:
        return _TOOLTIP[self]

    def worst_with(self, *others: "Status") -> "Status":
        return worst([self, *others])


_RANK: dict[Status, int] = {
    Status.HEALTHY: 0,
    Status.INFO: 1,
    Status.UNKNOWN: 2,
    Status.WARNING: 3,
    Status.CRITICAL: 4,
}

_ICON: dict[Status, str] = {
    Status.HEALTHY: "check_circle",
    Status.INFO: "info",
    Status.WARNING: "warning",
    Status.CRITICAL: "e911_emergency",
    Status.UNKNOWN: "help",
}

_LABEL: dict[Status, str] = {
    Status.HEALTHY: "Healthy",
    Status.INFO: "Info",
    Status.WARNING: "Warning",
    Status.CRITICAL: "Critical",
    Status.UNKNOWN: "Unknown",
}

_TOOLTIP: dict[Status, str] = {
    Status.HEALTHY: "Measured and within thresholds.",
    Status.INFO: "Notable change, no action required.",
    Status.WARNING: "Outside normal range — investigate when convenient.",
    Status.CRITICAL: "Service-affecting or data-at-risk — investigate now.",
    Status.UNKNOWN: "Could not be measured. Not the same as healthy.",
}


def worst(statuses: Iterable[Status]) -> Status:
    """Return the most severe status, or HEALTHY over an empty iterable."""
    ranked = sorted(statuses, key=lambda s: s.rank, reverse=True)
    return ranked[0] if ranked else Status.HEALTHY


class DataState(str, Enum):
    """Why a reading holds (or does not hold) a value."""

    OK = "OK"
    #: The integration exists but returned nothing for this series.
    NO_DATA = "NO_DATA"
    #: The integration is not deployed/credentialed at all.
    NOT_CONFIGURED = "NOT_CONFIGURED"
    #: We have a value, but it is older than the freshness budget.
    STALE = "STALE"
    #: The collector raised.
    ERROR = "ERROR"


T = TypeVar("T")


@dataclass
class Reading(Generic[T]):
    """A single measured value plus everything needed to render it honestly."""

    key: str
    label: str
    value: T | None = None
    unit: str = ""
    status: Status = Status.UNKNOWN
    state: DataState = DataState.OK
    #: Human explanation of the status — shown in cards and alerts.
    detail: str = ""
    #: Where the number came from ("prometheus", "local:/proc/mdstat", ...).
    source: str = ""
    #: Unix timestamp the underlying measurement was taken.
    collected_at: float = field(default_factory=time.time)
    #: Threshold that was applied, for display alongside the value.
    threshold: str = ""
    #: Arbitrary extras (deltas, forecasts, member lists).
    extra: dict[str, Any] = field(default_factory=dict)
    #: When True this reading is displayed but excluded from its component's
    #: status and score. Reserved for *optional* integrations that are simply
    #: not deployed (UniFi, Grafana) — without this, an unconfigured optional
    #: exporter would hold the whole dashboard below HEALTHY forever, which
    #: trains people to ignore the score. It is never set on a reading whose
    #: absence hides a real risk: missing SMART data still counts as UNKNOWN,
    #: because not knowing whether the disks are failing is a genuine gap.
    optional: bool = False

    @property
    def age_seconds(self) -> float:
        return max(0.0, time.time() - self.collected_at)

    @property
    def has_value(self) -> bool:
        return self.value is not None and self.state in {DataState.OK, DataState.STALE}

    @property
    def display_value(self) -> str:
        """Never render a placeholder that could be mistaken for a measurement."""
        if self.state is DataState.NOT_CONFIGURED:
            return "NOT CONFIGURED"
        if self.state is DataState.NO_DATA:
            return "NO DATA"
        if self.state is DataState.ERROR:
            return "ERROR"
        if self.value is None:
            return "—"
        if isinstance(self.value, float):
            text = f"{self.value:,.2f}".rstrip("0").rstrip(".")
        else:
            text = f"{self.value}"
        return f"{text}{self.unit}" if self.unit else text

    def stale_after(self, seconds: float) -> "Reading[T]":
        """Downgrade to UNKNOWN/STALE when the measurement is too old.

        Applied at the edge of every source so an exporter that quietly stopped
        scraping cannot keep showing its last healthy value forever.
        """
        if self.state is DataState.OK and self.age_seconds > seconds:
            self.state = DataState.STALE
            self.status = Status.UNKNOWN
            self.detail = (
                f"Data is {self.age_seconds:,.0f}s old "
                f"(freshness budget {seconds:,.0f}s). {self.detail}".strip()
            )
        return self

    @classmethod
    def not_configured(
        cls, key: str, label: str, detail: str, source: str = "", optional: bool = False
    ) -> "Reading[Any]":
        return cls(
            key=key,
            label=label,
            value=None,
            status=Status.UNKNOWN,
            state=DataState.NOT_CONFIGURED,
            detail=detail,
            source=source,
            optional=optional,
        )

    @classmethod
    def no_data(
        cls, key: str, label: str, detail: str = "", source: str = ""
    ) -> "Reading[Any]":
        return cls(
            key=key,
            label=label,
            value=None,
            status=Status.UNKNOWN,
            state=DataState.NO_DATA,
            detail=detail or "No data returned for this series.",
            source=source,
        )

    @classmethod
    def error(
        cls, key: str, label: str, detail: str, source: str = ""
    ) -> "Reading[Any]":
        return cls(
            key=key,
            label=label,
            value=None,
            status=Status.UNKNOWN,
            state=DataState.ERROR,
            detail=detail,
            source=source,
        )


@dataclass
class Alert:
    """An actionable finding for the alerts panel.

    The fields mirror what a person actually needs at 2am: what broke, how bad,
    what the number is, what it should be, why it probably happened, and what
    to check first.
    """

    key: str
    status: Status
    title: str
    component: str
    detail: str = ""
    current_value: str = ""
    threshold: str = ""
    probable_cause: str = ""
    recommended_action: str = ""
    since: float | None = None
    #: Set when this alert is a downstream effect of another alert's key.
    caused_by: str | None = None
    #: Keys of alerts this one explains, populated by the correlator.
    effects: list[str] = field(default_factory=list)

    @property
    def is_actionable(self) -> bool:
        return self.status in {Status.WARNING, Status.CRITICAL}


@dataclass
class ChangeEvent:
    """An entry in the Recent Changes feed.

    Deliberately coarse: this is a record of things that *changed*, not a log
    tail. Noise here destroys the feed's value.
    """

    timestamp: float
    category: str
    summary: str
    detail: str = ""
    status: Status = Status.INFO


@dataclass
class ComponentHealth:
    """One weighted contributor to the global health score."""

    key: str
    label: str
    status: Status
    weight: float
    #: 0.0-1.0 quality within the component, before weighting.
    score: float
    detail: str = ""
    readings: list[Reading[Any]] = field(default_factory=list)
    alerts: list[Alert] = field(default_factory=list)
