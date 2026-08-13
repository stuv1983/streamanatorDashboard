"""Structured exceptions.

Collectors raise these instead of letting arbitrary library errors escape, so
the UI layer can turn any failure into an honest UNKNOWN card rather than a
traceback. Nothing in the app is allowed to swallow an exception silently: it
is either handled into a `Reading` or logged and re-raised as one of these.
"""

from __future__ import annotations


class DashboardError(Exception):
    """Base class for every error the dashboard raises deliberately."""

    def __init__(self, message: str, *, source: str = "", hint: str = "") -> None:
        super().__init__(message)
        self.message = message
        #: Which integration produced the failure ("prometheus", "docker"...).
        self.source = source
        #: Operator-facing next step, surfaced on the diagnostics page.
        self.hint = hint

    def __str__(self) -> str:
        parts = [self.message]
        if self.source:
            parts.append(f"(source: {self.source})")
        return " ".join(parts)


class ConfigurationError(DashboardError):
    """A required setting is missing or self-contradictory."""


class NotConfiguredError(DashboardError):
    """An optional integration was asked for but has not been set up.

    Distinct from a failure: nothing is broken, the feature simply is not
    deployed yet. Callers turn this into a NOT CONFIGURED card, not an alert.
    """


class SourceUnavailableError(DashboardError):
    """A configured source could not be reached (connection refused, DNS...)."""


class SourceTimeoutError(SourceUnavailableError):
    """A configured source did not answer within its timeout budget."""


class QueryError(DashboardError):
    """A source was reached but rejected or failed the query."""


class ParseError(DashboardError):
    """A source answered with something we could not interpret."""
