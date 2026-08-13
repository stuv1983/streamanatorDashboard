"""PromQL for the dashboard's charts.

`services/prometheus.py` knows how to talk to the HTTP API; this package knows
what to ask it. Keeping the two apart means a query can be corrected without
touching transport code, and every expression the dashboard issues is readable
in one place.
"""

from __future__ import annotations

from queries.trends import TrendQuery, promql_for

__all__ = ["TrendQuery", "promql_for"]
