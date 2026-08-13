"""Tests for the probe target policy and the overlay store.

The policy exists so a monitoring dashboard with a URL field and a timer does
not quietly become a scanner. These tests are what stop that guardrail being
removed by accident later — without them it is one `if` statement that looks
like it could be simplified away.
"""

from __future__ import annotations

import json

import pytest

from admin import probes_config as probes
from admin.probes_config import ProbeDefinition


@pytest.fixture(autouse=True)
def isolated_overlay(tmp_path, monkeypatch):
    monkeypatch.setattr(probes, "OVERLAY_PATH", tmp_path / "probes.json")
    yield


def _definition(**overrides) -> ProbeDefinition:
    base = {
        "key": "test",
        "label": "Test",
        "url": "http://10.0.40.100:9000/health",
        "expect_status": (200,),
    }
    base.update(overrides)
    return ProbeDefinition(**base)


# ---------------------------------------------------------------------------
# Target classification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.40.100:8080/",
        "http://192.168.1.1/",
        "http://172.16.0.5:9090/health",
        "http://127.0.0.1:9090/-/healthy",
        "http://169.254.1.1/",
    ],
)
def test_private_targets_are_allowed_without_ceremony(url):
    verdict = probes.classify_target(url)
    assert verdict.allowed
    assert not verdict.is_public


def test_public_target_is_flagged():
    verdict = probes.classify_target("http://1.1.1.1/")
    assert verdict.allowed
    assert verdict.is_public


@pytest.mark.parametrize(
    "url",
    ["ftp://10.0.40.100/", "file:///etc/passwd", "gopher://10.0.40.1/", "not a url"],
)
def test_non_http_schemes_are_refused(url):
    assert not probes.classify_target(url).allowed


def test_unresolvable_hostname_is_refused():
    verdict = probes.classify_target("http://this-host-does-not-exist.invalid/")
    assert not verdict.allowed
    assert "does not resolve" in verdict.reason


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_private_probe_validates_cleanly():
    assert probes.validate_definition(_definition(), []) == []


def test_public_probe_needs_acknowledgement():
    problems = probes.validate_definition(_definition(url="http://1.1.1.1/"), [])
    assert problems
    assert "public address" in problems[0]


def test_acknowledged_public_probe_is_accepted():
    definition = _definition(url="http://1.1.1.1/", external_acknowledged=True)
    assert probes.validate_definition(definition, []) == []


def test_public_probes_are_capped():
    existing = [
        _definition(
            key=f"public{i}", url="http://1.1.1.1/", external_acknowledged=True
        )
        for i in range(probes.MAX_PUBLIC_TARGETS)
    ]
    candidate = _definition(
        key="one_more", url="http://8.8.8.8/", external_acknowledged=True
    )
    problems = probes.validate_definition(candidate, existing)
    assert problems and "limit" in problems[0]


def test_disabled_public_probes_do_not_count_towards_the_cap():
    existing = [
        _definition(
            key=f"public{i}",
            url="http://1.1.1.1/",
            external_acknowledged=True,
            enabled=False,
        )
        for i in range(probes.MAX_PUBLIC_TARGETS)
    ]
    candidate = _definition(
        key="one_more", url="http://8.8.8.8/", external_acknowledged=True
    )
    assert probes.validate_definition(candidate, existing) == []


def test_bad_key_is_rejected():
    assert probes.validate_definition(_definition(key="../etc"), [])


def test_unsupported_method_is_rejected():
    assert probes.validate_definition(_definition(method="DELETE"), [])


def test_run_probe_refuses_an_unacknowledged_public_target():
    """The check is repeated at request time, not only at save time."""
    result = probes.run_probe(_definition(url="http://1.1.1.1/"))
    assert not result.ok
    assert "Refused" in result.detail


# ---------------------------------------------------------------------------
# Overlay behaviour
# ---------------------------------------------------------------------------


def test_builtin_probes_are_present_by_default():
    keys = {p.key for p in probes.effective_probes()}
    assert "plex" in keys
    assert "sports_data_lab" in keys


def test_builtin_probes_are_marked_as_builtin():
    plex = next(p for p in probes.effective_probes() if p.key == "plex")
    assert plex.builtin


def test_overlay_can_retarget_a_builtin():
    probes.upsert(_definition(key="plex", url="http://10.0.40.100:32401/identity"))
    plex = next(p for p in probes.effective_probes() if p.key == "plex")
    assert plex.url.endswith(":32401/identity")
    assert plex.builtin, "provenance must come from config, not the overlay"


def test_removing_a_builtin_disables_it_rather_than_deleting_it():
    """A disabled probe is visible; a missing one is silent lost coverage."""
    probes.remove("plex")
    plex = next((p for p in probes.effective_probes() if p.key == "plex"), None)
    assert plex is not None
    assert not plex.enabled


def test_custom_probe_can_be_added_and_deleted():
    probes.upsert(_definition(key="custom"))
    assert any(p.key == "custom" for p in probes.effective_probes())
    assert probes.remove("custom")
    assert not any(p.key == "custom" for p in probes.effective_probes())


def test_overlay_cannot_claim_a_probe_is_builtin():
    probes.upsert(_definition(key="custom", builtin=True))
    stored = json.loads(probes.OVERLAY_PATH.read_text(encoding="utf-8"))
    assert "builtin" not in stored["probes"][0]
    custom = next(p for p in probes.effective_probes() if p.key == "custom")
    assert not custom.builtin


def test_corrupt_overlay_fails_closed():
    """Finding 9, probe edition: a corrupt overlay raises rather than reading
    as empty. An empty read would be saved back on the next edit, quietly
    erasing every customisation. The admin page catches this and refuses to
    mutate."""
    probes.OVERLAY_PATH.parent.mkdir(parents=True, exist_ok=True)
    probes.OVERLAY_PATH.write_text("{broken", encoding="utf-8")
    with pytest.raises(probes.OverlayCorruptError):
        probes.effective_probes()
