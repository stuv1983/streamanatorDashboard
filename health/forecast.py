"""Capacity forecasting.

Deliberately conservative. A forecast that confidently predicts a full disk
from four noisy samples is worse than no forecast, because it trains the
operator to ignore the panel. So every projection must clear three gates:

1. enough calendar history (`min_history_days`);
2. enough distinct samples;
3. a linear fit that actually explains the data (R² above a floor).

When any gate fails the result carries `available=False` and a reason, and the
UI prints "Forecast unavailable — insufficient history" instead of a date.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class LinearFit:
    """Least-squares fit of value against time."""

    #: Units per second.
    slope: float
    intercept: float
    r_squared: float
    sample_count: int
    span_seconds: float


def linear_fit(samples: Sequence[tuple[float, float]]) -> LinearFit | None:
    """Ordinary least squares over (timestamp, value) pairs.

    Returns None when the samples cannot support a fit — fewer than three
    points, or every point at the same instant.
    """
    if len(samples) < 3:
        return None

    times = [float(t) for t, _ in samples]
    values = [float(v) for _, v in samples]
    n = len(samples)

    # Re-base time on the first sample: raw Unix timestamps are ~1.8e9, and
    # squaring them loses precision in the normal equations.
    origin = times[0]
    xs = [t - origin for t in times]

    mean_x = sum(xs) / n
    mean_y = sum(values) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    if sxx <= 0:
        return None
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, values))
    slope = sxy / sxx
    intercept = mean_y - slope * mean_x

    syy = sum((y - mean_y) ** 2 for y in values)
    if syy <= 0:
        # A perfectly flat series is a valid fit with zero growth.
        r_squared = 1.0
    else:
        residual = sum(
            (y - (intercept + slope * x)) ** 2 for x, y in zip(xs, values)
        )
        r_squared = max(0.0, 1.0 - residual / syy)

    return LinearFit(
        slope=slope,
        intercept=intercept,
        r_squared=r_squared,
        sample_count=n,
        span_seconds=times[-1] - times[0],
    )


@dataclass
class CapacityForecast:
    """Growth analysis and threshold-crossing predictions for a filesystem."""

    available: bool
    reason: str = ""
    #: Bytes per day. Negative means the filesystem is shrinking.
    growth_bytes_per_day: float | None = None
    growth_bytes_7d: float | None = None
    growth_bytes_30d: float | None = None
    growth_bytes_90d: float | None = None
    r_squared: float | None = None
    history_days: float | None = None
    sample_count: int = 0
    #: Predicted Unix timestamps for each threshold crossing.
    date_80_percent: float | None = None
    date_90_percent: float | None = None
    date_full: float | None = None

    @property
    def growth_tb_per_month(self) -> float | None:
        if self.growth_bytes_per_day is None:
            return None
        return self.growth_bytes_per_day * 30.0 / (1024.0**4)

    @property
    def shrinking(self) -> bool:
        return self.growth_bytes_per_day is not None and self.growth_bytes_per_day < 0

    def days_until(self, timestamp: float | None) -> float | None:
        if timestamp is None:
            return None
        return (timestamp - time.time()) / 86400.0

    @property
    def days_until_90(self) -> float | None:
        return self.days_until(self.date_90_percent)

    @property
    def days_until_full(self) -> float | None:
        return self.days_until(self.date_full)


def forecast_capacity(
    samples: Sequence[tuple[float, float]],
    total_bytes: float,
    min_history_days: float = 3.0,
    min_r_squared: float = 0.5,
    min_samples: int = 10,
) -> CapacityForecast:
    """Project when a filesystem reaches 80%, 90% and 100% used.

    `samples` are (timestamp, used_bytes) pairs. `total_bytes` is capacity.
    """
    if total_bytes <= 0:
        return CapacityForecast(False, "Filesystem capacity is unknown")

    if len(samples) < min_samples:
        return CapacityForecast(
            False,
            f"Insufficient history — {len(samples)} samples, need {min_samples}",
            sample_count=len(samples),
        )

    ordered = sorted(samples, key=lambda pair: pair[0])
    span_days = (ordered[-1][0] - ordered[0][0]) / 86400.0
    if span_days < min_history_days:
        return CapacityForecast(
            False,
            f"Insufficient history — {span_days:.1f} days, need {min_history_days:.0f}",
            history_days=span_days,
            sample_count=len(ordered),
        )

    fit = linear_fit(ordered)
    if fit is None:
        return CapacityForecast(
            False, "Could not fit a trend to the samples", sample_count=len(ordered)
        )

    growth_per_day = fit.slope * 86400.0
    forecast = CapacityForecast(
        available=True,
        growth_bytes_per_day=growth_per_day,
        growth_bytes_7d=_growth_over(ordered, 7 * 86400),
        growth_bytes_30d=_growth_over(ordered, 30 * 86400),
        growth_bytes_90d=_growth_over(ordered, 90 * 86400),
        r_squared=fit.r_squared,
        history_days=span_days,
        sample_count=fit.sample_count,
    )

    if fit.r_squared < min_r_squared:
        forecast.available = False
        forecast.reason = (
            f"Growth is too irregular to project (R²={fit.r_squared:.2f}, "
            f"need {min_r_squared:.2f}). Current growth rate is still shown."
        )
        return forecast

    if growth_per_day <= 0:
        forecast.reason = "Usage is flat or falling — no fill date projected."
        return forecast

    current_used = ordered[-1][1]
    now = ordered[-1][0]

    def crossing(target_fraction: float) -> float | None:
        target_bytes = total_bytes * target_fraction
        if current_used >= target_bytes:
            return None  # already past this threshold
        seconds = (target_bytes - current_used) / fit.slope
        if seconds <= 0 or seconds > 20 * 365 * 86400:
            return None  # beyond any useful planning horizon
        return now + seconds

    forecast.date_80_percent = crossing(0.80)
    forecast.date_90_percent = crossing(0.90)
    forecast.date_full = crossing(1.0)
    return forecast


def _growth_over(
    samples: Sequence[tuple[float, float]], window_seconds: float
) -> float | None:
    """Actual observed change across a window, or None when unavailable.

    This is a measured difference rather than a projection, so it is reported
    even when the regression is rejected as unreliable.
    """
    if not samples:
        return None
    latest_ts, latest_value = samples[-1]
    target = latest_ts - window_seconds
    baseline = None
    for timestamp, value in samples:
        if timestamp <= target:
            baseline = (timestamp, value)
        else:
            break
    if baseline is None:
        # Not enough history for the full window; only report if the available
        # span covers most of it, otherwise the number understates growth.
        oldest_ts, oldest_value = samples[0]
        if (latest_ts - oldest_ts) < window_seconds * 0.75:
            return None
        return latest_value - oldest_value
    return latest_value - baseline[1]


def project_threshold_date(
    current_value: float,
    growth_per_day: float,
    target_value: float,
) -> float | None:
    """When a linearly growing value reaches a target. None if it never does."""
    if growth_per_day <= 0 or current_value >= target_value:
        return None
    days = (target_value - current_value) / growth_per_day
    if not math.isfinite(days) or days > 20 * 365:
        return None
    return time.time() + days * 86400.0
