"""Display formatting. Pure functions, no Streamlit imports, easily testable."""

from __future__ import annotations

import math
from datetime import datetime, timezone

_BINARY_UNITS = ("B", "KiB", "MiB", "GiB", "TiB", "PiB")
_DECIMAL_UNITS = ("B", "KB", "MB", "GB", "TB", "PB")


def human_bytes(value: float | int | None, binary: bool = True, digits: int = 1) -> str:
    """Format a byte count. Returns an em dash for missing data, never '0 B'."""
    if value is None:
        return "—"
    if value < 0:
        return f"-{human_bytes(-value, binary, digits)}"
    step = 1024.0 if binary else 1000.0
    units = _BINARY_UNITS if binary else _DECIMAL_UNITS
    size = float(value)
    index = 0
    while size >= step and index < len(units) - 1:
        size /= step
        index += 1
    if index == 0:
        return f"{int(size)} {units[0]}"
    return f"{size:,.{digits}f} {units[index]}"


def human_bits_per_second(value: float | None, digits: int = 1) -> str:
    """Format a bit rate. Network throughput is conventionally decimal."""
    if value is None:
        return "—"
    units = ("bps", "Kbps", "Mbps", "Gbps", "Tbps")
    rate = float(value)
    index = 0
    while rate >= 1000.0 and index < len(units) - 1:
        rate /= 1000.0
        index += 1
    return f"{rate:,.{digits}f} {units[index]}"


def human_bytes_per_second(value: float | None, digits: int = 1) -> str:
    if value is None:
        return "—"
    return f"{human_bytes(value, binary=True, digits=digits)}/s"


def human_duration(seconds: float | None, parts: int = 2) -> str:
    """Render a duration as a compact '2d 10h' style string."""
    if seconds is None:
        return "—"
    seconds = int(max(0, seconds))
    if seconds < 60:
        return f"{seconds}s"
    units = (("d", 86400), ("h", 3600), ("m", 60), ("s", 1))
    chunks: list[str] = []
    remaining = seconds
    for suffix, size in units:
        if remaining >= size:
            amount, remaining = divmod(remaining, size)
            chunks.append(f"{amount}{suffix}")
        if len(chunks) == parts:
            break
    return " ".join(chunks) if chunks else "0s"


def human_age(timestamp: float | None, now: float | None = None) -> str:
    """Age of a timestamp, e.g. '4m ago'. Handles future stamps sanely."""
    if timestamp is None:
        return "—"
    now = now if now is not None else datetime.now(timezone.utc).timestamp()
    delta = now - timestamp
    if delta < 0:
        return "in the future"
    if delta < 45:
        return "just now"
    return f"{human_duration(delta, parts=2)} ago"


def format_percent(value: float | None, digits: int = 1) -> str:
    if value is None:
        return "—"
    return f"{value:,.{digits}f}%"


def format_delta(value: float | int | None, unit: str = "", digits: int = 0) -> str:
    """Signed delta with an explicit +0 for 'measured and unchanged'.

    The distinction matters for the CRC counters: '+0' means we compared two
    samples and they matched; '—' means we had nothing to compare.
    """
    if value is None:
        return "—"
    if isinstance(value, float) and not float(value).is_integer():
        text = f"{value:+,.{max(digits, 1)}f}"
    else:
        text = f"{int(value):+,d}"
    return f"{text}{unit}" if unit else text


def format_timestamp(timestamp: float | None, fmt: str = "%d %b %Y %H:%M") -> str:
    """Render a Unix timestamp in the server's local time."""
    if timestamp is None:
        return "—"
    try:
        return datetime.fromtimestamp(timestamp).strftime(fmt)
    except (OverflowError, OSError, ValueError):
        return "—"


def format_clock(timestamp: float | None) -> str:
    return format_timestamp(timestamp, "%H:%M:%S")


def format_date(timestamp: float | None) -> str:
    return format_timestamp(timestamp, "%d %b %Y")


def format_temperature(celsius: float | None) -> str:
    if celsius is None:
        return "—"
    return f"{celsius:,.0f} °C"


def truncate(text: str, limit: int = 60) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def pluralise(count: int, singular: str, plural: str | None = None) -> str:
    if count == 1:
        return f"{count} {singular}"
    return f"{count} {plural or singular + 's'}"


def safe_ratio(numerator: float | None, denominator: float | None) -> float | None:
    """Divide, returning None rather than 0.0 or NaN when it is meaningless."""
    if numerator is None or denominator is None:
        return None
    if denominator == 0 or math.isnan(denominator) or math.isnan(numerator):
        return None
    return numerator / denominator
