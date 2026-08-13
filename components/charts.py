"""Altair charts.

Deliberately few chart types. Most panels on this dashboard are answering
"what is the state right now", which a stat tile answers better than a plot —
charts are reserved for the places where the *trend* is the information:
latency, iowait, storage growth, CRC deltas, disk temperature.

House rules applied throughout:

* Single-series charts use one accent colour and no legend — the title names
  the series. Multi-series charts always carry a legend, because identity must
  never be colour-alone.
* One y-axis, always. Two measures of different scale get two charts.
* Hairline, solid grid one shade off the surface; no dashed gridlines.
* An interactive tooltip on every chart, plus a `st.dataframe` table view
  available from the caller, so no value is reachable only by hovering.
"""

from __future__ import annotations

from datetime import datetime

import altair as alt
import pandas as pd

from components.theme import ACCENT, AXIS, GRID, NEUTRAL, categorical, status_color
from core.status import Status

#: Baseline chart height. Sized to include the x-axis band so the card never
#: gets a nested scrollbar.
DEFAULT_HEIGHT = 190


def _frame(samples: list[tuple[float, float]], value_name: str) -> pd.DataFrame:
    """(timestamp, value) pairs to a tidy DataFrame."""
    if not samples:
        return pd.DataFrame({"time": [], value_name: []})
    return pd.DataFrame(
        {
            "time": [datetime.fromtimestamp(ts) for ts, _ in samples],
            value_name: [value for _, value in samples],
        }
    )


def _base_axis(title: str, fmt: str | None = None) -> alt.Axis:
    """Recessive hairline axis. Solid grid, one shade off the surface.

    `format` is only passed when set — Altair rejects an explicit None, and
    omitting the key lets Vega choose a sensible default per field type.
    """
    options: dict[str, object] = {
        "title": title,
        "gridColor": GRID,
        "gridWidth": 1,
        "domain": False,
        "tickColor": GRID,
        "labelColor": AXIS,
        "titleColor": AXIS,
        "labelFontSize": 11,
        "titleFontSize": 11,
    }
    if fmt is not None:
        options["format"] = fmt
    return alt.Axis(**options)


def time_series(
    samples: list[tuple[float, float]],
    value_label: str,
    unit: str = "",
    height: int = DEFAULT_HEIGHT,
    color: str = ACCENT,
    area: bool = False,
    zero: bool = False,
) -> alt.Chart | None:
    """Single-measure trend line with a crosshair tooltip.

    Returns None when there is nothing to plot, so callers can render an
    honest "no history yet" message instead of an empty axis frame.
    """
    frame = _frame(samples, value_label)
    if frame.empty:
        return None

    encoding_y = alt.Y(
        f"{value_label}:Q",
        axis=_base_axis(f"{value_label}{unit}"),
        scale=alt.Scale(zero=zero, nice=True),
    )
    encoding_x = alt.X("time:T", axis=_base_axis(""))

    tooltip = [
        alt.Tooltip("time:T", title="Time", format="%d %b %H:%M:%S"),
        alt.Tooltip(f"{value_label}:Q", title=value_label, format=",.2f"),
    ]

    # A nearest-point selection gives the whole plot width as a hit target
    # rather than requiring the pointer to land on a 2px line.
    hover = alt.selection_point(
        nearest=True, on="pointerover", fields=["time"], empty=False
    )

    mark = (
        alt.Chart(frame).mark_area(
            line={"color": color, "strokeWidth": 2},
            color=alt.Gradient(
                gradient="linear",
                stops=[
                    alt.GradientStop(color=color, offset=0),
                    alt.GradientStop(color="#0B0F14", offset=1),
                ],
                x1=1, x2=1, y1=1, y2=0,
            ),
            opacity=0.35,
        )
        if area
        else alt.Chart(frame).mark_line(color=color, strokeWidth=2)
    )
    line = mark.encode(x=encoding_x, y=encoding_y)

    points = (
        alt.Chart(frame)
        .mark_point(size=90, opacity=0, color=color)
        .encode(x=encoding_x, y=encoding_y, tooltip=tooltip)
        .add_params(hover)
    )
    highlight = (
        alt.Chart(frame)
        .mark_point(size=70, filled=True, color=color, stroke="#0B0F14", strokeWidth=2)
        .encode(x=encoding_x, y=encoding_y, opacity=alt.condition(hover, alt.value(1), alt.value(0)))
    )
    rule = (
        alt.Chart(frame)
        .mark_rule(color=NEUTRAL, strokeWidth=1)
        .encode(x=encoding_x, opacity=alt.condition(hover, alt.value(0.5), alt.value(0)))
    )

    return (
        (line + rule + points + highlight)
        .properties(height=height)
        .configure_view(strokeWidth=0)
    )


def threshold_series(
    samples: list[tuple[float, float]],
    value_label: str,
    warning: float | None = None,
    critical: float | None = None,
    unit: str = "",
    height: int = DEFAULT_HEIGHT,
) -> alt.Chart | None:
    """Trend line with warning/critical reference rules.

    The threshold rules use the reserved status colours because they *mean*
    warning and critical — they are not additional data series.
    """
    chart = time_series(samples, value_label, unit, height)
    if chart is None:
        return None

    frame = _frame(samples, value_label)
    layers: list[alt.Chart] = []
    for level, status in ((warning, Status.WARNING), (critical, Status.CRITICAL)):
        if level is None:
            continue
        rule_frame = pd.DataFrame({"threshold": [level]})
        layers.append(
            alt.Chart(rule_frame)
            .mark_rule(color=status_color(status), strokeWidth=1, opacity=0.8)
            .encode(y=alt.Y("threshold:Q"))
        )
    if not layers:
        return chart

    base = time_series(samples, value_label, unit, height)
    combined = base
    for layer in layers:
        combined = combined + layer
    return combined.properties(height=height).configure_view(strokeWidth=0)


def multi_series(
    frame: pd.DataFrame,
    x: str,
    y: str,
    series: str,
    unit: str = "",
    height: int = DEFAULT_HEIGHT,
    dark: bool = True,
) -> alt.Chart | None:
    """Several measures on one axis, with a legend.

    Only ever called with measures that share a scale and a unit — a dual-axis
    chart invents correlations that are not in the data, so it is never built.
    """
    if frame.empty:
        return None
    palette = list(categorical(dark))
    names = list(dict.fromkeys(frame[series].tolist()))
    if len(names) > len(palette):
        # Never generate or cycle a hue; collapse the tail instead.
        keep = set(names[: len(palette) - 1])
        frame = frame.copy()
        frame[series] = frame[series].where(frame[series].isin(keep), "Other")
        names = list(dict.fromkeys(frame[series].tolist()))

    return (
        alt.Chart(frame)
        .mark_line(strokeWidth=2)
        .encode(
            x=alt.X(f"{x}:T", axis=_base_axis("")),
            y=alt.Y(f"{y}:Q", axis=_base_axis(f"{y}{unit}"), scale=alt.Scale(zero=False)),
            color=alt.Color(
                f"{series}:N",
                scale=alt.Scale(domain=names, range=palette[: len(names)]),
                legend=alt.Legend(
                    title=None, labelColor=AXIS, symbolStrokeWidth=2, orient="top"
                ),
            ),
            tooltip=[
                alt.Tooltip(f"{x}:T", title="Time", format="%d %b %H:%M"),
                alt.Tooltip(f"{series}:N", title="Series"),
                alt.Tooltip(f"{y}:Q", title=y, format=",.2f"),
            ],
        )
        .properties(height=height)
        .configure_view(strokeWidth=0)
    )


def status_bar(
    labels: list[str], statuses: list[Status], height: int = 120
) -> alt.Chart | None:
    """Horizontal state bar — one row per entity, coloured by status.

    Uses the reserved status palette because the colour *is* the state. Every
    row is also labelled, so the encoding is never colour-alone.
    """
    if not labels:
        return None
    frame = pd.DataFrame(
        {
            "entity": labels,
            "status": [s.value for s in statuses],
            "value": [1] * len(labels),
        }
    )
    domain = [s.value for s in Status]
    return (
        alt.Chart(frame)
        .mark_bar(height=14, cornerRadius=4, stroke="#0B0F14", strokeWidth=2)
        .encode(
            x=alt.X("value:Q", axis=None, scale=alt.Scale(domain=[0, 1])),
            y=alt.Y("entity:N", axis=_base_axis(""), sort=labels),
            color=alt.Color(
                "status:N",
                scale=alt.Scale(
                    domain=domain, range=[status_color(Status(s)) for s in domain]
                ),
                legend=alt.Legend(title=None, orient="bottom", labelColor=AXIS),
            ),
            tooltip=[
                alt.Tooltip("entity:N", title="Component"),
                alt.Tooltip("status:N", title="Status"),
            ],
        )
        .properties(height=height)
        .configure_view(strokeWidth=0)
    )


def capacity_projection(
    samples: list[tuple[float, float]],
    total_bytes: float,
    forecast,
    height: int = 220,
) -> alt.Chart | None:
    """Observed usage with the projected trajectory to 90% and full.

    The projection is drawn only when the forecast cleared its confidence
    gates; an unavailable forecast renders the history alone rather than a
    speculative line.
    """
    if not samples:
        return None

    observed = pd.DataFrame(
        {
            "time": [datetime.fromtimestamp(ts) for ts, _ in samples],
            "used": [value / (1024**4) for _, value in samples],
            "kind": ["Observed"] * len(samples),
        }
    )

    layers = [
        alt.Chart(observed)
        .mark_line(color=ACCENT, strokeWidth=2)
        .encode(
            x=alt.X("time:T", axis=_base_axis("")),
            y=alt.Y("used:Q", axis=_base_axis("Used (TiB)"), scale=alt.Scale(zero=False)),
            tooltip=[
                alt.Tooltip("time:T", title="Time", format="%d %b %H:%M"),
                alt.Tooltip("used:Q", title="Used (TiB)", format=",.2f"),
            ],
        )
    ]

    for fraction, status in ((0.9, Status.WARNING), (1.0, Status.CRITICAL)):
        level = pd.DataFrame({"level": [total_bytes * fraction / (1024**4)]})
        layers.append(
            alt.Chart(level)
            .mark_rule(color=status_color(status), strokeWidth=1, opacity=0.8)
            .encode(y="level:Q")
        )

    if forecast is not None and forecast.available and forecast.date_90_percent:
        last_ts, last_value = samples[-1]
        projected = pd.DataFrame(
            {
                "time": [
                    datetime.fromtimestamp(last_ts),
                    datetime.fromtimestamp(forecast.date_90_percent),
                ],
                "used": [last_value / (1024**4), total_bytes * 0.9 / (1024**4)],
            }
        )
        layers.append(
            alt.Chart(projected)
            .mark_line(color=NEUTRAL, strokeWidth=2, strokeDash=[6, 4], opacity=0.9)
            .encode(x="time:T", y="used:Q")
        )

    combined = layers[0]
    for layer in layers[1:]:
        combined = combined + layer
    return combined.properties(height=height).configure_view(strokeWidth=0)


def to_table(samples: list[tuple[float, float]], value_label: str) -> pd.DataFrame:
    """Table-view twin of a chart, so values are never hover-only."""
    frame = _frame(samples, value_label)
    if frame.empty:
        return frame
    frame = frame.copy()
    frame["time"] = frame["time"].dt.strftime("%d %b %Y %H:%M:%S")
    return frame.rename(columns={"time": "Time"})
