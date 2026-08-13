"""Authentication for the dashboard's administrative surface.

The read-only monitoring pages stay open by default — gating them would change
what the dashboard is for without being asked. Everything that *writes*
(credentials, actions, accounts) sits behind this package.

Set `REQUIRE_AUTH_FOR_ALL=true` to require a sign-in for the monitoring pages
too. That is the right setting if the dashboard is ever reachable from an
untrusted VLAN — though the standing advice remains not to expose it.
"""

from __future__ import annotations

from auth.accounts import Account, AccountStore, AuthResult
from auth.audit import AuditEntry, AuditLog
from auth.session import AdminSession

__all__ = [
    "Account",
    "AccountStore",
    "AuthResult",
    "AuditEntry",
    "AuditLog",
    "AdminSession",
]
