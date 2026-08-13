"""The UniFi client must never issue a mutating request.

This is enforced by test rather than by review because the risk is invisible at
the call site. The Network Integration API reaches its destructive operations
by *HTTP method*, not by path: the same `/firewall/policies` that lists rules
deletes one under DELETE, `/networks/{id}` is a PUT away from being rewritten,
and `/devices/{id}/actions` accepts a POST that restarts hardware.

UniFi issues a single API key scope, and it includes all of that. There is no
read-only key to request instead. So the read-only property cannot live on the
credential — it has to live in this client, and a future edit adding
`requests.post` here would silently hand write access to a monitoring tool.

The source-level assertions are deliberate. A behavioural test would only cover
the code paths it happens to exercise; scanning the module covers the ones
nobody thought to test.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from services import unifi

MODULE_PATH = Path(inspect.getfile(unifi))
MUTATING = {"post", "put", "patch", "delete", "head", "options"}


def _tree() -> ast.Module:
    return ast.parse(MODULE_PATH.read_text(encoding="utf-8"))


def test_module_never_calls_a_mutating_requests_method():
    offenders = []
    for node in ast.walk(_tree()):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in MUTATING:
            base = func.value
            if isinstance(base, ast.Name) and base.id in {"requests", "session"}:
                offenders.append(f"{base.id}.{func.attr} at line {node.lineno}")
    assert not offenders, (
        "the UniFi client must only ever GET — found: " + ", ".join(offenders)
    )


def test_module_never_calls_requests_request_with_a_variable_method():
    """`requests.request(method, ...)` would route around the check above."""
    for node in ast.walk(_tree()):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "request"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id in {"requests", "session"}
        ):
            pytest.fail(
                f"requests.request() at line {node.lineno} takes the verb as a "
                "parameter, which defeats the read-only guarantee"
            )


def test_the_only_http_call_is_a_get():
    calls = [
        node
        for node in ast.walk(_tree())
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "requests"
    ]
    assert calls, "expected at least one requests call"
    assert all(c.func.attr == "get" for c in calls)


def test_request_helper_does_not_follow_redirects():
    """A redirect would carry the X-API-KEY header to whatever host it names."""
    source = inspect.getsource(unifi._request)
    assert "allow_redirects=False" in source


def test_read_paths_are_declared_and_contain_no_mutating_shapes():
    assert unifi._READ_PATHS
    for path in unifi._READ_PATHS:
        assert path.startswith("/"), path
        assert "actions" not in path, (
            f"{path} is an action endpoint — POST-only, and not a read"
        )


def test_no_action_endpoints_are_referenced_anywhere_in_the_module():
    """`/actions` paths exist only to change device or client state."""
    text = MODULE_PATH.read_text(encoding="utf-8")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith('"'):
            continue
        assert "/actions" not in stripped, f"action endpoint referenced: {stripped}"


# ---------------------------------------------------------------------------
# Behaviour with no credentials — the state the dashboard ships in
# ---------------------------------------------------------------------------


class _Unconfigured:
    controller_url = ""
    api_key = None
    verify_tls = False
    exporter_url = ""
    site = "default"


def test_request_refuses_without_credentials():
    payload, error = unifi._request(_Unconfigured(), "/info")
    assert payload is None
    assert "No controller URL or API key" in error


def test_availability_reports_unconfigured_without_a_key():
    assert not unifi.availability(_Unconfigured()).configured


def test_ids_remains_unavailable():
    """Alarm history is legacy-API only, and MFA blocks that login. An empty
    table would read as 'no intrusions' rather than 'cannot see'."""
    assert unifi.ids_available(_Unconfigured()) is False
    assert unifi.get_ids_events(_Unconfigured()) == []


def test_version_extraction_handles_both_payload_shapes():
    assert unifi._extract_version({"applicationVersion": "10.4.57"}) == "10.4.57"
    assert unifi._extract_version({"data": {"version": "9.0.108"}}) == "9.0.108"
    assert unifi._extract_version({"version": "8.1.113"}) == "8.1.113"
    assert unifi._extract_version({}) == ""
    assert unifi._extract_version(None) == ""


def test_firewall_policies_500_is_reported_as_upstream(monkeypatch):
    """The live firmware 500s on this endpoint; the message must name it as a
    UniFi-side error, not present it as our failure."""
    monkeypatch.setattr(unifi, "_resolve_site_id", lambda *a, **k: "site1")
    monkeypatch.setattr(unifi, "_request", lambda *a, **k: (None, "HTTP 500"))
    policies, error = unifi.get_firewall_policies("https://x", "k", False, "default")
    assert policies == []
    assert "500" in error and "UniFi" in error


def test_read_paths_include_the_working_firewall_and_wan_endpoints():
    joined = " ".join(unifi._READ_PATHS)
    for fragment in ("firewall/zones", "wans", "vpn/servers", "acl-rules"):
        assert fragment in joined


def test_firewall_endpoint_label_collapses_objects():
    assert unifi._endpoint_label({"zoneId": "abc"}) == "abc"
    assert unifi._endpoint_label({"ips": ["10.0.10.0/24", "10.0.20.0/24"]}) == (
        "10.0.10.0/24, 10.0.20.0/24"
    )
    assert unifi._endpoint_label(None) == ""
    assert unifi._endpoint_label({}) == ""


def test_documented_capabilities_do_not_overlap():
    """A capability listed as both available and unavailable is a doc bug that
    would show up in the UI as two contradicting panels."""
    provided = " ".join(unifi.PROVIDED_BY_INTEGRATION_API).lower()
    assert "ids" not in provided
    assert "alarm" not in provided
    unavailable = " ".join(unifi.NOT_PROVIDED_BY_INTEGRATION_API).lower()
    assert "counter" in unavailable
