"""Regressions for .env round-tripping, injection, and configuration reload.

Findings 5, 12, 13, 14: the writer and the runtime loader disagreed about
escaping (a quote in a password became a different credential at runtime); a
newline in a value was written literally and re-parsed as a *new variable*
(letting a credential field flip ADMIN_ACTIONS_ENABLED); duplicate keys were
half-updated; and the reload mutated os.environ key-by-key while other threads
read it.

The fix routed both sides through one parser (`config.parse_env_value`) and
made reload swap an immutable snapshot under a lock. These tests pin all of it.
"""

from __future__ import annotations

import pytest

from admin.env_file import read_env_file, update_env_file, validate_update
from config import parse_env_value


# ---------------------------------------------------------------------------
# One parser, both directions
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        "plain",
        "has spaces",
        "has#hash",
        'has "quotes" inside',
        r"back\slash",
        r'both \ and "',
        "trailing space ",
        "$dollar and `tick`",
        "",
    ],
)
def test_writer_and_reader_round_trip_every_awkward_value(tmp_path, value):
    """The property finding 12 violated: what the writer stores is exactly
    what the reader — and therefore the running process — sees."""
    path = tmp_path / ".env"
    update_env_file(path, {"SECRET": value}, backup=False)
    assert read_env_file(path)["SECRET"] == value


def test_reader_matches_the_runtime_parser(tmp_path):
    """read_env_file must decode identically to config.parse_env_value, since
    the running process uses the latter on reload."""
    path = tmp_path / ".env"
    update_env_file(path, {"K": r'a \ b " c'}, backup=False)
    raw_line = next(
        line for line in path.read_text().splitlines() if line.startswith("K=")
    )
    _, _, encoded = raw_line.partition("=")
    assert parse_env_value(encoded) == r'a \ b " c'
    assert read_env_file(path)["K"] == r'a \ b " c'


# ---------------------------------------------------------------------------
# Injection (finding 5)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("payload", ["a\nADMIN_ACTIONS_ENABLED=true", "x\rY=1", "n\x00ull"])
def test_control_characters_in_values_are_refused(tmp_path, payload):
    path = tmp_path / ".env"
    with pytest.raises(ValueError):
        update_env_file(path, {"QBITTORRENT_PASSWORD": payload}, backup=False)
    # Nothing was written — the injected key never reaches the file.
    assert not path.exists() or "ADMIN_ACTIONS_ENABLED" not in path.read_text()


def test_validate_update_rejects_bad_keys():
    with pytest.raises(ValueError):
        validate_update("1BAD", "value")
    with pytest.raises(ValueError):
        validate_update("has space", "value")
    with pytest.raises(ValueError):
        validate_update("inject\nKEY", "value")
    validate_update("GOOD_KEY_1", "value")  # no raise


def test_a_newline_injection_cannot_smuggle_a_second_variable(tmp_path):
    """The concrete attack from the finding, end to end."""
    path = tmp_path / ".env"
    update_env_file(path, {"SONARR_URL": "http://10.0.40.100:8081"}, backup=False)
    with pytest.raises(ValueError):
        update_env_file(
            path,
            {"QBITTORRENT_PASSWORD": "safe\nADMIN_ACTIONS_ENABLED=true"},
            backup=False,
        )
    assert "ADMIN_ACTIONS_ENABLED" not in read_env_file(path)


# ---------------------------------------------------------------------------
# Duplicate keys (finding 13)
# ---------------------------------------------------------------------------


def test_duplicate_keys_last_wins_on_read(tmp_path):
    path = tmp_path / ".env"
    path.write_text("KEY=old1\nKEY=old2\n", encoding="utf-8")
    assert read_env_file(path)["KEY"] == "old2"


def test_update_rewrites_the_last_duplicate_and_disables_the_earlier(tmp_path):
    path = tmp_path / ".env"
    path.write_text("KEY=old1\nKEY=old2\n", encoding="utf-8")
    update_env_file(path, {"KEY": "new"}, backup=False)
    # Exactly one live KEY line, and it is the new value.
    live = [
        line
        for line in path.read_text().splitlines()
        if line.startswith("KEY=") and not line.startswith("#")
    ]
    assert live == ["KEY=new"]
    assert read_env_file(path)["KEY"] == "new"


# ---------------------------------------------------------------------------
# Reload (finding 14)
# ---------------------------------------------------------------------------


def test_reload_applies_file_changes(tmp_path, monkeypatch):
    import config

    env = tmp_path / ".env"
    env.write_text("UNIFI_API_KEY=first\n", encoding="utf-8")
    monkeypatch.setenv("STREAMANATOR_ENV_FILE", str(env))
    settings = config.reload_settings(env)
    assert settings.unifi.api_key == "first"

    env.write_text("UNIFI_API_KEY=second\n", encoding="utf-8")
    settings = config.reload_settings(env)
    assert settings.unifi.api_key == "second"


def test_reload_removes_a_deleted_key(tmp_path, monkeypatch):
    """A key deleted from the file must actually disappear, not linger from
    the import-time os.environ copy."""
    import config

    env = tmp_path / ".env"
    env.write_text("PLEX_TOKEN=present\n", encoding="utf-8")
    monkeypatch.setenv("STREAMANATOR_ENV_FILE", str(env))
    assert config.reload_settings(env).api.plex_token == "present"

    env.write_text("# nothing here\n", encoding="utf-8")
    assert config.reload_settings(env).api.plex_token is None


def test_reload_does_not_mutate_os_environ(tmp_path, monkeypatch):
    """The snapshot is what changes, not the process environment — that is
    what makes the reload safe against concurrent readers."""
    import os

    import config

    env = tmp_path / ".env"
    env.write_text("SOME_NEW_UNIQUE_KEY=value123\n", encoding="utf-8")
    monkeypatch.setenv("STREAMANATOR_ENV_FILE", str(env))
    config.reload_settings(env)
    assert config.env_str("SOME_NEW_UNIQUE_KEY") == "value123"
    # The effective view has it; os.environ was not touched by the reload.
    assert "SOME_NEW_UNIQUE_KEY" not in os.environ


def test_failed_settings_build_keeps_previous_snapshot(tmp_path, monkeypatch):
    import config

    env = tmp_path / ".env"
    env.write_text("UNIFI_API_KEY=good\n", encoding="utf-8")
    monkeypatch.setenv("STREAMANATOR_ENV_FILE", str(env))
    config.reload_settings(env)

    original = config.Settings

    def boom(*a, **k):
        raise RuntimeError("build failed")

    monkeypatch.setattr(config, "Settings", boom)
    with pytest.raises(RuntimeError):
        config.reload_settings(env)
    monkeypatch.setattr(config, "Settings", original)
    # The good value is still readable — the failed build did not corrupt state.
    assert config.env_str("UNIFI_API_KEY") == "good"
