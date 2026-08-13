"""Structured application logging.

Logs go to stdout (captured by journald under systemd) and optionally to a
file. Secrets never reach a log record: `_Redactor` scrubs anything that looks
like an API key or token from the formatted message.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

_CONFIGURED = False

#: Patterns matched against formatted log lines before they are emitted.
_SECRET_PATTERNS = (
    re.compile(r"(?i)\b(api[_-]?key|apikey|token|password|passwd|secret)\b\s*[=:]\s*\S+"),
    re.compile(r"(?i)X-Api-Key:\s*\S+"),
    re.compile(r"(?i)([?&])(apikey|api_key|token|X-Plex-Token)=[^&\s]+"),
)


class _Redactor(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - defensive
            return True
        redacted = message
        for pattern in _SECRET_PATTERNS:
            redacted = pattern.sub(_replace_secret, redacted)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


def _replace_secret(match: re.Match[str]) -> str:
    text = match.group(0)
    if match.re.groups >= 2 and match.lastindex and match.lastindex >= 2:
        return f"{match.group(1)}{match.group(2)}=<redacted>"
    separator = "=" if "=" in text else ":"
    head = text.split(separator, 1)[0]
    return f"{head}{separator} <redacted>"


class JsonFormatter(logging.Formatter):
    """One JSON object per line — greppable in `journalctl -o cat`."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key in ("component", "source", "duration_ms", "target"):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO", log_file: str = "") -> None:
    """Idempotently configure the root logger for the dashboard."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    root = logging.getLogger("streamanator")
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.propagate = False

    redactor = _Redactor()

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    )
    stream.addFilter(redactor)
    root.addHandler(stream)

    if log_file:
        try:
            path = Path(log_file)
            path.parent.mkdir(parents=True, exist_ok=True)
            file_handler = logging.handlers.RotatingFileHandler(
                path, maxBytes=5_000_000, backupCount=3, encoding="utf-8"
            )
            file_handler.setFormatter(JsonFormatter())
            file_handler.addFilter(redactor)
            root.addHandler(file_handler)
        except OSError as exc:
            root.warning("Could not open log file %s: %s", log_file, exc)

    _CONFIGURED = True
    root.info(
        "Streamanator Dashboard logging initialised (level=%s, pid=%s)",
        level,
        os.getpid(),
    )


def get_logger(name: str) -> logging.Logger:
    """Return a namespaced child logger."""
    return logging.getLogger(f"streamanator.{name}")
