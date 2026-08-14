"""Tests for update reporting: apt parsing, image references, registry digests.

The parsers are the part worth pinning down. Each one is fed real output shapes
rather than idealised ones, because every bug these tests exist to prevent is a
bug that renders as a confident wrong answer — "0 packages pending" on a host
with fifty, or "up to date" on a container whose registry could not be reached.
"""

from __future__ import annotations

import time

import pytest

from admin import runner
from services.updates import (
    ImageRef,
    image_status,
    parse_apt_check,
    parse_apt_history,
    parse_image_ref,
    parse_reboot_packages,
    parse_simulate_upgrade,
)

# ---------------------------------------------------------------------------
# apt-check
# ---------------------------------------------------------------------------


def test_apt_check_counts_are_parsed():
    assert parse_apt_check("12;3\n") == (12, 3)


def test_apt_check_output_is_found_on_stderr():
    """apt-check writes its counts to stderr. Reading stdout alone reports a
    host with fifty pending updates as fully patched."""
    assert parse_apt_check("\n47;9\n") == (47, 9)


def test_apt_check_returns_none_when_it_says_nothing_useful():
    assert parse_apt_check("command not found") is None


# ---------------------------------------------------------------------------
# apt-get -s upgrade
# ---------------------------------------------------------------------------

SIMULATION = """\
NOTE: This is only a simulation!
Reading package lists...
Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.15 Ubuntu:22.04/jammy-security [amd64])
Inst tzdata [2024a-0ubuntu0.22.04] (2024b-0ubuntu0.22.04 Ubuntu:22.04/jammy-updates [all])
Conf libssl3 (3.0.2-0ubuntu1.15 Ubuntu:22.04/jammy-security [amd64])
"""


def test_simulated_upgrade_lists_package_names():
    names, security = parse_simulate_upgrade(SIMULATION)
    assert names == ("libssl3", "tzdata")


def test_simulated_upgrade_separates_security_updates():
    """The archive suffix in the parentheses is the only place this appears
    without a second apt invocation."""
    _, security = parse_simulate_upgrade(SIMULATION)
    assert security == ("libssl3",)


def test_conf_lines_are_not_counted_as_pending():
    """`Conf` is the configure step of a package already counted by `Inst`."""
    names, _ = parse_simulate_upgrade("Conf libssl3 (3.0.2 Ubuntu:22.04 [amd64])\n")
    assert names == ()


def test_nothing_pending_parses_as_empty_not_as_failure():
    names, security = parse_simulate_upgrade("Reading package lists...\n")
    assert names == () and security == ()


# ---------------------------------------------------------------------------
# apt history.log
# ---------------------------------------------------------------------------

HISTORY = """\
Start-Date: 2026-08-04  06:12:01
Commandline: /usr/bin/unattended-upgrade
Upgrade: libc6:amd64 (2.35-0ubuntu3.6, 2.35-0ubuntu3.8)
End-Date: 2026-08-04  06:12:44

Start-Date: 2026-08-11  09:14:32
Commandline: apt-get -y upgrade
Requested-By: arm (1000)
Upgrade: libssl3:amd64 (3.0.2-0ubuntu1.10, 3.0.2-0ubuntu1.15), tzdata:all
 (2024a-0ubuntu0.22.04, 2024b-0ubuntu0.22.04)
End-Date: 2026-08-11  09:16:02
"""


def test_history_is_returned_oldest_first():
    events = parse_apt_history(HISTORY)
    assert len(events) == 2
    assert events[0]["start"] < events[1]["start"]


def test_history_records_the_command_that_ran():
    events = parse_apt_history(HISTORY)
    assert events[0]["command"] == "/usr/bin/unattended-upgrade"
    assert events[1]["command"] == "apt-get -y upgrade"


def test_history_counts_packages_across_wrapped_lines():
    """Long Upgrade: lists wrap onto continuation lines. Counting only the
    first line under-reports every large upgrade."""
    events = parse_apt_history(HISTORY)
    assert events[1]["changed"] == 2


def test_interrupted_transactions_are_skipped():
    """A stanza with no End-Date was interrupted. Reporting it as the last
    successful upgrade hides a half-configured dpkg state."""
    text = "Start-Date: 2026-08-12  01:00:00\nUpgrade: foo:amd64 (1, 2)\n"
    assert parse_apt_history(text) == []


def test_unparsable_date_does_not_break_the_log():
    text = "Start-Date: not-a-date\nUpgrade: foo:amd64 (1, 2)\nEnd-Date: also-not\n"
    assert parse_apt_history(text) == []


def test_history_dates_are_local_time():
    events = parse_apt_history(HISTORY)
    assert time.localtime(events[1]["start"]).tm_hour == 9


# ---------------------------------------------------------------------------
# reboot-required
# ---------------------------------------------------------------------------


def test_reboot_packages_are_listed():
    assert parse_reboot_packages("linux-image-5.15.0-113\nlibc6\n\n") == (
        "linux-image-5.15.0-113",
        "libc6",
    )


# ---------------------------------------------------------------------------
# Image references
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "reference, registry, repository, tag",
    [
        ("postgres:15", "registry-1.docker.io", "library/postgres", "15"),
        ("postgres", "registry-1.docker.io", "library/postgres", "latest"),
        (
            "linuxserver/sonarr:latest",
            "registry-1.docker.io",
            "linuxserver/sonarr",
            "latest",
        ),
        ("lscr.io/linuxserver/radarr", "lscr.io", "linuxserver/radarr", "latest"),
        (
            "ghcr.io/immich-app/immich-server:v1.106.4",
            "ghcr.io",
            "immich-app/immich-server",
            "v1.106.4",
        ),
        ("qmcgaw/gluetun:v3", "registry-1.docker.io", "qmcgaw/gluetun", "v3"),
    ],
)
def test_image_reference_is_split_like_docker_does(
    reference, registry, repository, tag
):
    """A first component is a registry host only if it has a dot or colon —
    which is why `linuxserver/sonarr` is a Hub repo and `lscr.io/...` is not."""
    ref = parse_image_ref(reference)
    assert (ref.registry, ref.repository, ref.tag) == (registry, repository, tag)


def test_registry_with_a_port_is_not_mistaken_for_a_tag():
    ref = parse_image_ref("registry.lan:5000/media/sonarr:1.2")
    assert ref.registry == "registry.lan:5000"
    assert ref.repository == "media/sonarr"
    assert ref.tag == "1.2"


def test_digest_pinned_reference_is_recognised():
    ref = parse_image_ref("postgres@sha256:" + "a" * 64)
    assert ref.pinned


def test_empty_reference_is_none_not_a_guess():
    assert parse_image_ref("") is None
    assert parse_image_ref("   ") is None


# ---------------------------------------------------------------------------
# Image status classification
# ---------------------------------------------------------------------------


def _status(**kwargs):
    base = dict(
        container_name="media-vpn_sonarr_1",
        display="Sonarr",
        reference="lscr.io/linuxserver/sonarr:latest",
        repo_digests=("lscr.io/linuxserver/sonarr@sha256:" + "a" * 64,),
        image_created=1.0,
        container_created=2.0,
    )
    base.update(kwargs)
    return image_status(**base)


def test_unreachable_registry_reports_unknown_not_current(monkeypatch):
    """The one wrong answer that stops someone looking. A registry that cannot
    be reached must never render as 'up to date'."""
    monkeypatch.setattr(
        "services.updates.remote_digest", lambda ref, timeout=8.0: ("", "no route to host")
    )
    result = _status()
    assert result.state == "unknown"
    assert not result.outdated
    assert "no route to host" in result.detail


def test_matching_digest_is_current(monkeypatch):
    monkeypatch.setattr(
        "services.updates.remote_digest",
        lambda ref, timeout=8.0: ("sha256:" + "a" * 64, ""),
    )
    assert _status().state == "current"


def test_differing_digest_is_outdated(monkeypatch):
    monkeypatch.setattr(
        "services.updates.remote_digest",
        lambda ref, timeout=8.0: ("sha256:" + "b" * 64, ""),
    )
    result = _status()
    assert result.state == "outdated"
    assert result.outdated


def test_locally_built_image_has_nothing_to_compare_against():
    result = _status(repo_digests=())
    assert result.state == "unknown"
    assert "built locally" in result.detail


def test_digest_pinned_image_never_reports_outdated():
    result = _status(reference="postgres@sha256:" + "c" * 64)
    assert result.state == "pinned"
    assert not result.outdated


def test_registry_checks_can_be_switched_off():
    result = _status(check_registry=False)
    assert result.state == "unknown"
    assert "disabled" in result.detail


def test_unparsable_reference_is_unknown():
    assert _status(reference="").state == "unknown"


def test_digest_from_a_different_repository_is_not_used(monkeypatch):
    """An image tagged into two repositories carries two RepoDigests. Matching
    on a suffix would accept `otherorg/sonarr` for `linuxserver/sonarr` and
    report a current container as outdated."""
    monkeypatch.setattr(
        "services.updates.remote_digest",
        lambda ref, timeout=8.0: ("sha256:" + "a" * 64, ""),
    )
    result = _status(repo_digests=("otherorg/sonarr@sha256:" + "b" * 64,))
    assert result.state == "unknown"
    assert not result.outdated


def test_hub_short_form_digest_matches_the_implicit_library_repo(monkeypatch):
    """Docker records `postgres@sha256:…`, but the parsed reference is
    `library/postgres`. Comparing the two raw strings never matches."""
    monkeypatch.setattr(
        "services.updates.remote_digest",
        lambda ref, timeout=8.0: ("sha256:" + "a" * 64, ""),
    )
    result = _status(
        reference="postgres:15",
        repo_digests=("postgres@sha256:" + "a" * 64,),
    )
    assert result.state == "current"


# ---------------------------------------------------------------------------
# Registry digest lookup
# ---------------------------------------------------------------------------


def test_rate_limit_is_reported_as_a_reason_not_as_a_digest(monkeypatch):
    """Docker Hub's anonymous allowance is 100 manifest requests per six hours.
    Hitting it must read as UNKNOWN, not as up to date."""
    from utils.http import BoundedResponse

    monkeypatch.setattr(
        "utils.http.get_bounded",
        lambda *a, **k: BoundedResponse(status_code=429),
    )
    ref = ImageRef("registry-1.docker.io", "library/postgres", "15")
    digest, reason = _uncached_remote_digest(ref)
    assert digest == ""
    assert "rate limit" in reason


def test_manifest_accept_header_requests_the_index_type(monkeypatch):
    """Without the index media types the registry answers with a
    per-architecture digest, which never equals the digest docker recorded —
    so every multi-arch container would read as outdated forever."""
    from utils.http import BoundedResponse

    seen: dict = {}

    def fake_get(url, *, headers=None, **kwargs):
        seen["accept"] = (headers or {}).get("Accept", "")
        return BoundedResponse(
            status_code=200, headers={"Docker-Content-Digest": "sha256:" + "d" * 64}
        )

    monkeypatch.setattr("utils.http.get_bounded", fake_get)
    ref = ImageRef("registry-1.docker.io", "library/postgres", "15")
    digest, reason = _uncached_remote_digest(ref)
    assert digest.endswith("d" * 64) and reason == ""
    assert "index" in seen["accept"] and "manifest.list" in seen["accept"]


def test_digest_header_is_matched_whatever_its_casing(monkeypatch):
    """`get_bounded` returns a plain dict, losing requests' case-insensitive
    headers. Registries disagree about casing, and an exact-case miss turns a
    perfectly good answer into a permanent UNKNOWN."""
    from utils.http import BoundedResponse

    monkeypatch.setattr(
        "utils.http.get_bounded",
        lambda *a, **k: BoundedResponse(
            status_code=200, headers={"docker-content-digest": "sha256:" + "e" * 64}
        ),
    )
    ref = ImageRef("ghcr.io", "immich-app/immich-server", "v1.106.4")
    digest, reason = _uncached_remote_digest(ref)
    assert digest.endswith("e" * 64) and reason == ""


def test_missing_content_digest_header_is_not_silently_empty(monkeypatch):
    from utils.http import BoundedResponse

    monkeypatch.setattr(
        "utils.http.get_bounded", lambda *a, **k: BoundedResponse(status_code=200)
    )
    ref = ImageRef("registry-1.docker.io", "library/postgres", "15")
    digest, reason = _uncached_remote_digest(ref)
    assert digest == "" and "content digest" in reason


def _uncached_remote_digest(ref):
    """Call the digest lookup past its six-hour cache.

    The cache is what keeps the registry allowance intact in production, but it
    would make each of these tests depend on the order of the ones before it.
    """
    from services import updates

    updates.remote_digest.cache_clear()
    try:
        return updates.remote_digest(ref)
    finally:
        updates.remote_digest.cache_clear()


# ---------------------------------------------------------------------------
# systemctl argv parsing (the unit-exists probe)
# ---------------------------------------------------------------------------


def test_unit_is_found_after_an_option_flag():
    """`systemctl start --no-block foo.service` puts the unit at index 3.
    Reading index 2 checked systemd for a unit named `--no-block` and reported
    the action as uninstallable on every host."""
    assert (
        runner._systemctl_unit(
            ["/usr/bin/systemctl", "start", "--no-block", "foo.service"]
        )
        == "foo.service"
    )


def test_unit_is_found_in_the_ordinary_form():
    assert (
        runner._systemctl_unit(["/usr/bin/systemctl", "restart", "aqualog.service"])
        == "aqualog.service"
    )


def test_verbs_that_take_no_unit_yield_nothing():
    assert runner._systemctl_unit(["/usr/bin/systemctl", "reset-failed"]) == ""
    assert runner._systemctl_unit(["/usr/bin/systemctl", "daemon-reload"]) == ""


def test_systemd_timestamp_handles_never():
    assert runner._systemd_timestamp("n/a") is None
    assert runner._systemd_timestamp("") is None


def test_systemd_timestamp_is_parsed():
    parsed = runner._systemd_timestamp("Tue 2026-08-11 09:16:02 AEST")
    assert parsed is not None
    assert time.localtime(parsed).tm_year == 2026
