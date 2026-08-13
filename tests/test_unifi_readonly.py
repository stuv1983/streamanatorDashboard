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


def test_only_the_transport_calls_requests_get():
    parents: dict[ast.AST, ast.AST] = {}
    tree = _tree()
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent

    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "requests"
        ):
            continue
        ancestor = parents.get(node)
        while ancestor is not None and not isinstance(
            ancestor, (ast.FunctionDef, ast.AsyncFunctionDef)
        ):
            ancestor = parents.get(ancestor)
        assert isinstance(ancestor, ast.FunctionDef)
        assert ancestor.name == "_request", (
            f"requests.get at line {node.lineno} bypasses the enforced transport"
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


def test_read_allowlist_is_enforced_for_every_declared_resource():
    for template in unifi._COLLECTION_PATHS.values():
        path = template.replace("{site}", "site1")
        assert unifi._path_is_allowlisted(path), path


def test_official_read_only_resource_groups_are_all_wired():
    assert {
        "sites",
        "pending_devices",
        "adopted_devices",
        "clients",
        "networks",
        "wifi_broadcasts",
        "wans",
        "firewall_policies",
        "firewall_zones",
        "acl_rules",
        "lags",
        "mc_lag_domains",
        "switch_stacks",
        "dns_policies",
        "traffic_matching_lists",
        "vpn_servers",
        "site_to_site_vpn_tunnels",
        "radius_profiles",
        "device_tags",
        "dpi_categories",
        "dpi_applications",
    } <= set(unifi._COLLECTION_PATHS)
    assert {
        "device",
        "client",
        "network",
        "network_references",
        "wifi_broadcast",
        "firewall_policy",
        "firewall_zone",
        "acl_rule",
        "lag",
        "mc_lag_domain",
        "switch_stack",
        "dns_policy",
        "traffic_matching_list",
    } <= set(unifi._DETAIL_PATHS)
    for template in unifi._DETAIL_PATHS.values():
        path = template.replace("{site}", "site1").replace("{resource}", "item1")
        assert unifi._path_is_allowlisted(path), path


@pytest.mark.parametrize(
    "path",
    (
        "/sites/site1/devices/device1/actions",
        "/sites/site1/devices/device1/../../networks",
        "/sites/site1/clients/client1?filter=x",
        "/sites/site1/clients/client1#fragment",
        "/sites/site1//clients",
        "/unknown",
    ),
)
def test_read_allowlist_rejects_actions_and_path_injection(path: str):
    assert not unifi._path_is_allowlisted(path)


def test_request_rejects_unlisted_paths_before_network_io(monkeypatch):
    called = False

    def should_not_run(*args, **kwargs):
        nonlocal called
        called = True
        raise AssertionError("network request should not run")

    monkeypatch.setattr(unifi.requests, "get", should_not_run)
    payload, error = unifi._request(_Configured(), "/sites/site1/actions")
    assert payload is None
    assert "allowlisted" in error
    assert called is False


@pytest.mark.parametrize(
    "params",
    (
        {"filter": 1},
        {"offset": -1},
        {"limit": 5001},
        {"offset": True},
    ),
)
def test_request_rejects_unlisted_or_unbounded_query_params(monkeypatch, params):
    monkeypatch.setattr(
        unifi.requests,
        "get",
        lambda *args, **kwargs: pytest.fail("network request should not run"),
    )
    payload, error = unifi._request(_Configured(), "/sites", params=params)
    assert payload is None
    assert "Query parameters" in error


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


class _Configured:
    controller_url = "https://controller.example"
    api_key = "test-key"
    verify_tls = True
    tls_verify = True
    exporter_url = ""
    site = "default"


def test_request_refuses_without_credentials():
    payload, error = unifi._request(_Unconfigured(), "/info")
    assert payload is None
    assert "No controller URL or API key" in error


def test_request_uses_get_only_closes_response_and_honours_ca_bundle(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        closed = False

        def iter_content(self, chunk_size):
            yield b'{"applicationVersion":"10.5.67"}'

        def close(self):
            self.closed = True

    response = Response()

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return response

    monkeypatch.setattr(unifi.requests, "get", fake_get)
    config = unifi._Config("https://controller.example", "key", "console-ca.pem")
    payload, error = unifi._request(config, "/info")

    assert error == ""
    assert payload == {"applicationVersion": "10.5.67"}
    assert captured["verify"] == "console-ca.pem"
    assert captured["allow_redirects"] is False
    assert captured["params"] is None
    assert response.closed is True


@pytest.mark.parametrize("status", (401, 404, 500))
def test_request_closes_error_responses(monkeypatch, status: int):
    class Response:
        status_code = status
        closed = False

        def close(self):
            self.closed = True

    response = Response()
    monkeypatch.setattr(unifi.requests, "get", lambda *args, **kwargs: response)
    payload, error = unifi._request(_Configured(), "/info")
    assert payload is None
    assert str(status) in error
    assert response.closed is True


def test_collection_reads_every_page(monkeypatch):
    calls = []

    def fake_request(config, path, timeout=8.0, params=None):
        calls.append(dict(params or {}))
        offset = params["offset"]
        data = {
            0: [{"id": "a"}, {"id": "b"}],
            2: [{"id": "c"}],
        }[offset]
        return {"data": data, "totalCount": 3}, ""

    monkeypatch.setattr(unifi, "_request", fake_request)
    items, error = unifi._request_collection(_Configured(), "/sites/site1/clients")
    assert error == ""
    assert [item["id"] for item in items] == ["a", "b", "c"]
    assert [call["offset"] for call in calls] == [0, 2]
    assert all(call["limit"] == unifi._PAGE_SIZE for call in calls)


def test_collection_discards_partial_data_when_a_later_page_fails(monkeypatch):
    def fake_request(config, path, timeout=8.0, params=None):
        if params["offset"] == 0:
            return {"data": [{"id": "a"}], "totalCount": 2}, ""
        return None, "HTTP 500"

    monkeypatch.setattr(unifi, "_request", fake_request)
    items, error = unifi._request_collection(_Configured(), "/sites/site1/clients")
    assert items == ()
    assert error == "HTTP 500"


def test_collection_does_not_accept_a_short_response_as_complete(monkeypatch):
    monkeypatch.setattr(
        unifi,
        "_request",
        lambda config, path, timeout=8.0, params=None: (
            {"data": [{"id": "a"}], "totalCount": 2}
            if params["offset"] == 0
            else {"data": [], "totalCount": 2},
            "",
        ),
    )
    items, error = unifi._request_collection(_Configured(), "/sites/site1/clients")
    assert items == ()
    assert "1 of 2" in error


def test_collection_refuses_an_unbounded_result(monkeypatch):
    monkeypatch.setattr(
        unifi,
        "_request",
        lambda *args, **kwargs: (
            {"data": [{"id": "a"}], "totalCount": 5001},
            "",
        ),
    )
    items, error = unifi._request_collection(_Configured(), "/sites/site1/clients")
    assert items == ()
    assert "safe limit" in error


def test_display_sanitizer_redacts_credentials_recursively():
    safe = unifi.safe_for_display(
        {
            "name": "IoT",
            "password": "one",
            "security": {
                "preSharedKey": "two",
                "radiusSecret": "three",
                "privateKey": "four",
                "mode": "WPA3",
            },
        }
    )
    assert safe["name"] == "IoT"
    assert safe["password"] == "[redacted]"
    assert safe["security"]["preSharedKey"] == "[redacted]"
    assert safe["security"]["radiusSecret"] == "[redacted]"
    assert safe["security"]["privateKey"] == "[redacted]"
    assert safe["security"]["mode"] == "WPA3"


def test_unknown_named_resources_fail_without_resolving_a_site(monkeypatch):
    monkeypatch.setattr(
        unifi,
        "_resolve_site_id",
        lambda *args, **kwargs: pytest.fail("site lookup should not run"),
    )
    items, error = unifi.get_api_collection("https://x", "k", False, "default", "bad")
    assert items == []
    assert "Unknown" in error
    detail, error = unifi.get_api_detail(
        "https://x", "k", False, "default", "bad", "id"
    )
    assert detail == {}
    assert "Unknown" in error


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
