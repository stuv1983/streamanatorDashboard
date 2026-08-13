"""The administrative surface: credentials, allowlisted actions, probe config.

This package is where the dashboard stops being read-only. Everything in it
sits behind `auth`, writes to the audit log, and works from declared
allowlists rather than free-form input.
"""

from __future__ import annotations

from admin.actions import ACTIONS, Action, Risk
from admin.runner import ActionResult, Capability, check_action, execute

__all__ = [
    "ACTIONS",
    "Action",
    "Risk",
    "ActionResult",
    "Capability",
    "check_action",
    "execute",
]
