"""Central mapping from Status to its visual vocabulary.

Colour is never the only signal. Every status carries an icon, a text label and
a tooltip, so the dashboard stays readable for colour-blind users and in
grayscale. The hex values mirror `.streamlit/config.toml` so charts, badges and
markdown all agree.
"""

from __future__ import annotations

from dataclasses import dataclass

from core.status import Status


@dataclass(frozen=True)
class StatusStyle:
    """Everything needed to render one status consistently."""

    label: str
    icon: str
    #: Streamlit markdown colour token, used with :color[text] syntax.
    color_token: str
    #: Streamlit badge colour name.
    badge_color: str
    hex_dark: str
    hex_light: str
    tooltip: str


STATUS_STYLES: dict[Status, StatusStyle] = {
    Status.HEALTHY: StatusStyle(
        label="Healthy",
        icon=":material/check_circle:",
        color_token="green",
        badge_color="green",
        hex_dark="#2FB344",
        hex_light="#1A7F37",
        tooltip="Measured and within thresholds.",
    ),
    Status.INFO: StatusStyle(
        label="Info",
        icon=":material/info:",
        color_token="blue",
        badge_color="blue",
        hex_dark="#3BC9DB",
        hex_light="#0E7C91",
        tooltip="Notable change, no action required.",
    ),
    Status.WARNING: StatusStyle(
        label="Warning",
        icon=":material/warning:",
        color_token="orange",
        badge_color="orange",
        hex_dark="#E8B339",
        hex_light="#9A6700",
        tooltip="Outside the normal range — investigate when convenient.",
    ),
    Status.CRITICAL: StatusStyle(
        label="Critical",
        icon=":material/error:",
        color_token="red",
        badge_color="red",
        hex_dark="#E5484D",
        hex_light="#CF222E",
        tooltip="Service-affecting or data at risk — investigate now.",
    ),
    Status.UNKNOWN: StatusStyle(
        label="Unknown",
        icon=":material/help:",
        color_token="gray",
        badge_color="gray",
        hex_dark="#7A8794",
        hex_light="#57606A",
        tooltip="Could not be measured. This is not the same as healthy.",
    ),
}


def style(status: Status) -> StatusStyle:
    return STATUS_STYLES[status]


def status_color(status: Status, dark: bool = True) -> str:
    """Hex colour for charts, where a Streamlit token cannot be used."""
    entry = STATUS_STYLES[status]
    return entry.hex_dark if dark else entry.hex_light


def status_markdown(status: Status, text: str) -> str:
    """Icon + coloured text — the standard inline status rendering."""
    entry = STATUS_STYLES[status]
    return f"{entry.icon} :{entry.color_token}[{text}]"


def status_label(status: Status) -> str:
    """Icon + the status's own name, for compact table cells."""
    entry = STATUS_STYLES[status]
    return f"{entry.icon} {entry.label}"


#: Chart colours. `ACCENT` is slot 1 of the validated categorical ramp and is
#: the single-series default — most charts here plot one measure, which needs
#: one colour and a title, not a palette.
ACCENT = "#2AA3C0"
ACCENT_LIGHT = "#0086A3"
NEUTRAL = "#7A8794"
GRID = "#1E2731"
AXIS = "#5A6672"

#: Full categorical ramp, in fixed order. Assign by entity, never by rank, and
#: never cycle past the end — fold extra series into "Other" or facet instead.
CATEGORICAL_DARK: tuple[str, ...] = (
    "#2AA3C0",
    "#C27F2E",
    "#37AC7B",
    "#A87FCF",
    "#D9636E",
)
CATEGORICAL_LIGHT: tuple[str, ...] = (
    "#0086A3",
    "#8A5410",
    "#0F7A52",
    "#6B45A6",
    "#B02A3A",
)


def categorical(dark: bool = True) -> tuple[str, ...]:
    return CATEGORICAL_DARK if dark else CATEGORICAL_LIGHT

#: Ordered severity list for sorting UI elements.
SEVERITY_ORDER: tuple[Status, ...] = (
    Status.CRITICAL,
    Status.WARNING,
    Status.UNKNOWN,
    Status.INFO,
    Status.HEALTHY,
)
