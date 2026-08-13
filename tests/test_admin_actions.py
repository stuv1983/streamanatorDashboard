"""Tests for the privileged-action registry, the sudoers file and the .env writer.

The registry tests are the ones that matter most here. They assert structural
properties that no amount of careful review would reliably keep true as actions
are added later: no shell execution, no argv assembled from input, no sudo
grant on a path the service account can write, and no drift between the code
and the sudoers file that is installed on the strength of it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from admin import actions as registry
from admin.actions import ACTIONS, Risk
from admin.env_file import read_env_file, update_env_file
from config import PROJECT_ROOT

SUDOERS_FILE = PROJECT_ROOT / "deploy" / "sudoers-streamanator-admin"


# ---------------------------------------------------------------------------
# Registry invariants
# ---------------------------------------------------------------------------


def test_every_action_key_is_unique():
    keys = [a.key for a in ACTIONS]
    assert len(keys) == len(set(keys))


def test_no_action_uses_a_shell_metacharacter():
    """argv goes straight to execve. A pipe here would be a literal argument,
    which means someone wrote it expecting a shell that does not exist."""
    for action in ACTIONS:
        for argument in action.argv:
            assert not re.search(r"[;&|><`$]", argument), (
                f"{action.key} has a shell metacharacter in {argument!r}"
            )


def test_no_action_argv_is_empty():
    for action in ACTIONS:
        assert action.argv and action.argv[0]


def test_every_binary_is_an_absolute_path():
    """A bare name would resolve through PATH, which is attacker-influenceable
    in ways an absolute path is not."""
    for action in ACTIONS:
        assert action.argv[0].startswith("/"), f"{action.key} uses a relative binary"


def test_no_sudo_action_points_at_a_user_writable_path():
    """A NOPASSWD grant on a file the service account can write is a root shell
    with extra steps: rewrite the file, then run it."""
    writable_roots = ("/home/", "/tmp/", "/var/tmp/", str(PROJECT_ROOT))
    for action in ACTIONS:
        if not action.needs_sudo or action.never_grant:
            continue
        for argument in action.argv:
            assert not any(argument.startswith(root) for root in writable_roots), (
                f"{action.key} would grant sudo on a writable path: {argument}"
            )


def test_actions_reading_from_the_project_directory_are_never_granted():
    """The inverse check: anything referencing the project tree must be SSH-only."""
    for action in ACTIONS:
        touches_project = any(str(PROJECT_ROOT) in a for a in action.argv)
        if touches_project and action.needs_sudo:
            assert action.never_grant, (
                f"{action.key} reads from the project directory and needs sudo, "
                "so it must be marked never_grant"
            )


def test_destructive_actions_require_step_up_and_a_typed_phrase():
    for action in ACTIONS:
        if action.risk is Risk.DESTRUCTIVE:
            assert action.needs_step_up, f"{action.key} is destructive without step-up"
            assert action.confirm_phrase, f"{action.key} has no confirmation phrase"


def test_destructive_actions_declare_an_undo():
    for action in ACTIONS:
        if action.risk is Risk.DESTRUCTIVE:
            assert action.undo_key, f"{action.key} has no undo path"
            assert registry.find(action.undo_key) is not None


def test_every_action_explains_itself():
    """A button whose consequences are not stated is a trap."""
    for action in ACTIONS:
        assert len(action.explain) > 40, f"{action.key} needs a real explanation"


def test_no_wildcards_in_grantable_sudo_rules():
    for rule in registry.grantable_sudo_rules():
        assert "*" not in rule and "?" not in rule, f"wildcard in sudo rule: {rule}"


def test_reboot_is_delayed_not_immediate():
    """The delay is what makes the cancel button a real option."""
    reboot = registry.find("server.reboot")
    assert reboot is not None
    assert any(a.startswith("+") for a in reboot.argv), "reboot is not delayed"
    assert registry.find("server.cancel_shutdown") is not None


# ---------------------------------------------------------------------------
# Parameter validation
# ---------------------------------------------------------------------------


def test_parameterised_action_rejects_a_value_outside_its_list():
    action = registry.find("docker.restart_container")
    assert action is not None
    with pytest.raises(ValueError):
        action.resolved_argv("../../etc/passwd")
    with pytest.raises(ValueError):
        action.resolved_argv("some-other-container")


def test_parameterised_action_accepts_a_configured_value():
    action = registry.find("docker.restart_container")
    allowed = action.parameter.choices()
    argv = action.resolved_argv(allowed[0])
    assert argv[-1] == allowed[0]


def test_parameterised_action_requires_a_value():
    action = registry.find("docker.restart_container")
    with pytest.raises(ValueError):
        action.resolved_argv(None)


def test_unparameterised_action_rejects_a_value():
    """Otherwise a caller could smuggle an argument into a fixed command."""
    action = registry.find("server.reboot")
    with pytest.raises(ValueError):
        action.resolved_argv("something")


def test_parameterised_actions_are_never_granted_sudo():
    """A sudoers rule cannot express 'this list of values' without a wildcard."""
    for action in ACTIONS:
        if action.parameter is not None:
            assert action.sudo_rule is None


# ---------------------------------------------------------------------------
# NOPASSWD matching
# ---------------------------------------------------------------------------


def test_plain_all_grant_is_not_treated_as_passwordless(monkeypatch):
    """The Ubuntu default for anyone in the `sudo` group is `(ALL : ALL) ALL`,
    which permits every command *after typing a password* — something a
    background web process cannot do. Reading that as passwordless made the
    console advertise a Reboot button that could only ever fail."""
    from admin import runner

    monkeypatch.setattr(runner, "_nopasswd_patterns", lambda: ())
    assert not runner.matches_nopasswd(("/usr/sbin/shutdown", "-r", "+1"))


def test_explicit_nopasswd_entry_matches(monkeypatch):
    from admin import runner

    monkeypatch.setattr(
        runner,
        "_nopasswd_patterns",
        lambda: ("/usr/bin/systemctl restart aqualog.service",),
    )
    assert runner.matches_nopasswd(
        ("/usr/bin/systemctl", "restart", "aqualog.service")
    )


def test_nopasswd_match_is_not_a_prefix_match(monkeypatch):
    """Otherwise a rule for one unit would appear to cover every unit."""
    from admin import runner

    monkeypatch.setattr(
        runner,
        "_nopasswd_patterns",
        lambda: ("/usr/bin/systemctl restart aqualog.service",),
    )
    assert not runner.matches_nopasswd(
        ("/usr/bin/systemctl", "restart", "plexmediaserver.service")
    )
    assert not runner.matches_nopasswd(("/usr/bin/systemctl",))


def test_nopasswd_all_matches_everything(monkeypatch):
    from admin import runner

    monkeypatch.setattr(runner, "_nopasswd_patterns", lambda: ("ALL",))
    assert runner.matches_nopasswd(("/usr/sbin/shutdown", "-r", "+1"))


def test_nopasswd_honours_sudoers_wildcards(monkeypatch):
    from admin import runner

    monkeypatch.setattr(
        runner, "_nopasswd_patterns", lambda: ("/usr/sbin/smartctl -j -a /dev/sd[a-z]",)
    )
    assert runner.matches_nopasswd(("/usr/sbin/smartctl", "-j", "-a", "/dev/sda"))
    assert not runner.matches_nopasswd(("/usr/sbin/smartctl", "-t", "long", "/dev/sda"))


def test_unparsable_sudo_listing_reads_as_needing_a_password(monkeypatch):
    """Fail closed: showing an unnecessary SSH command is cheap, a button that
    lies is not."""
    from admin import runner

    monkeypatch.setattr(runner, "_nopasswd_patterns", lambda: ())
    assert not runner.matches_nopasswd(("/usr/bin/systemctl", "reset-failed"))


# ---------------------------------------------------------------------------
# Sudoers file agreement
# ---------------------------------------------------------------------------


def test_sudoers_file_exists():
    assert SUDOERS_FILE.is_file()


def test_sudoers_file_grants_exactly_what_the_registry_expects():
    """A stale sudoers file is either a broken button or an over-broad grant,
    and both fail silently."""
    text = SUDOERS_FILE.read_text(encoding="utf-8")
    commands = set()
    for line in text.splitlines():
        # Alias entries wrap with a trailing backslash and separate with commas.
        stripped = line.strip().rstrip("\\").strip().rstrip(",").strip()
        if stripped.startswith("/usr/"):
            commands.add(stripped)
    expected = set(registry.grantable_sudo_rules())
    assert expected <= commands, f"missing from sudoers: {expected - commands}"
    assert commands <= expected, f"sudoers grants extra commands: {commands - expected}"


def test_sudoers_file_has_no_wildcard_grants():
    for line in SUDOERS_FILE.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("!"):
            continue
        if stripped.startswith("/usr/") and "*" in stripped:
            pytest.fail(f"wildcard in a granted command: {stripped}")


def test_sudoers_file_never_references_the_project_directory():
    text = SUDOERS_FILE.read_text(encoding="utf-8")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        assert "/home/" not in stripped, (
            "a sudo grant on a path under /home is a privilege-escalation path"
        )


# ---------------------------------------------------------------------------
# .env writer
# ---------------------------------------------------------------------------


def test_env_writer_creates_and_reads_back(tmp_path):
    path = tmp_path / ".env"
    update_env_file(path, {"SONARR_API_KEY": "abc123"}, backup=False)
    assert read_env_file(path)["SONARR_API_KEY"] == "abc123"


def test_env_writer_preserves_comments_and_order(tmp_path):
    path = tmp_path / ".env"
    path.write_text(
        "# leading comment\nFIRST=one\n\n# about second\nSECOND=two\n",
        encoding="utf-8",
    )
    update_env_file(path, {"SECOND": "changed"}, backup=False)
    text = path.read_text(encoding="utf-8")
    assert "# leading comment" in text
    assert "# about second" in text
    assert text.index("FIRST=one") < text.index("SECOND=changed")


def test_env_writer_updates_in_place_without_duplicating(tmp_path):
    path = tmp_path / ".env"
    update_env_file(path, {"KEY": "first"}, backup=False)
    update_env_file(path, {"KEY": "second"}, backup=False)
    lines = [l for l in path.read_text(encoding="utf-8").splitlines() if l.startswith("KEY=")]
    assert lines == ["KEY=second"]


def test_env_writer_quotes_values_that_need_it(tmp_path):
    path = tmp_path / ".env"
    update_env_file(path, {"NOTE": "has spaces and #hash"}, backup=False)
    assert read_env_file(path)["NOTE"] == "has spaces and #hash"


def test_env_writer_handles_quotes_inside_values(tmp_path):
    path = tmp_path / ".env"
    update_env_file(path, {"ODD": 'a "quoted" thing'}, backup=False)
    assert read_env_file(path)["ODD"] == 'a "quoted" thing'


def test_env_writer_removes_a_key_with_a_tombstone(tmp_path):
    path = tmp_path / ".env"
    update_env_file(path, {"GONE": "value"}, backup=False)
    update_env_file(path, {"GONE": None}, backup=False)
    assert "GONE" not in read_env_file(path)
    assert "# GONE=" in path.read_text(encoding="utf-8")


def test_env_writer_reports_only_actual_changes(tmp_path):
    path = tmp_path / ".env"
    update_env_file(path, {"KEY": "same"}, backup=False)
    assert update_env_file(path, {"KEY": "same"}, backup=False) == []


def test_env_reader_ignores_inline_comments(tmp_path):
    path = tmp_path / ".env"
    path.write_text("KEY=value   # trailing note\n", encoding="utf-8")
    assert read_env_file(path)["KEY"] == "value"


def test_env_reader_keeps_hashes_inside_quotes(tmp_path):
    path = tmp_path / ".env"
    path.write_text('KEY="value#notacomment"\n', encoding="utf-8")
    assert read_env_file(path)["KEY"] == "value#notacomment"


def test_env_file_is_written_with_restrictive_permissions(tmp_path):
    import os
    import sys

    if sys.platform.startswith("win"):
        pytest.skip("POSIX permission bits do not apply on Windows")
    path = tmp_path / ".env"
    update_env_file(path, {"SECRET": "value"}, backup=False)
    assert os.stat(path).st_mode & 0o777 == 0o600


def test_env_writer_keeps_a_backup(tmp_path):
    path = tmp_path / ".env"
    update_env_file(path, {"KEY": "original"}, backup=False)
    update_env_file(path, {"KEY": "replacement"}, backup=True)
    assert (tmp_path / ".env.bak").is_file()
    assert "original" in (tmp_path / ".env.bak").read_text(encoding="utf-8")
