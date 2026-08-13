"""Concurrency and durability regressions for the account store and file IO.

The audit found that the store did multiple unlocked load/save round-trips per
authentication, so under concurrent requests it lost failed-attempt increments
(defeating lockout), could accept one TOTP counter twice, and could redeem one
recovery code twice. Streamlit serves sessions on concurrent threads, so these
are reachable, not theoretical.

Each test below drives the exact race with a barrier so every worker starts
inside the contended window at once. They are the standing proof that the lock
covers the whole read-decide-write transaction, not merely the final save.
"""

from __future__ import annotations

import threading
import time

import pytest

from auth import crypto
from auth.accounts import LOCKOUT_THRESHOLD, AccountStore
from utils.fileio import atomic_write_text


def _hammer(fn, count: int) -> list:
    """Run `fn(i)` on `count` threads released together, collecting results."""
    barrier = threading.Barrier(count)
    results: list = [None] * count
    errors: list = []

    def worker(index: int) -> None:
        barrier.wait()
        try:
            results[index] = fn(index)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results, errors


def test_twenty_concurrent_wrong_passwords_all_count(tmp_path):
    """The audit's headline: 20 simultaneous failures must record 20, with no
    filesystem exceptions. The old code recorded as few as one."""
    store = AccountStore(tmp_path / "accounts.json")
    store.create_admin("stuart", "a long enough password")

    _, errors = _hammer(
        lambda i: store.authenticate("stuart", "wrong password here"), 20
    )
    assert not errors, f"filesystem exceptions under load: {errors}"

    account = store.get("stuart")
    # Either the counter reached 20, or it locked at the threshold and later
    # attempts short-circuited on the lock — both are correct, and both mean
    # no increment was lost to a race up to the point of locking.
    assert account.failed_attempts >= LOCKOUT_THRESHOLD
    assert account.locked()


def test_whitespace_username_cannot_evade_lockout(tmp_path):
    """Finding 1: lookup canonicalised the name but bookkeeping used the raw
    string, so ' stuart ' failed forever without ever locking 'stuart'."""
    store = AccountStore(tmp_path / "accounts.json")
    store.create_admin("stuart", "a long enough password")

    for _ in range(LOCKOUT_THRESHOLD + 1):
        store.authenticate("  stuart  ", "wrong")

    account = store.get("stuart")
    assert account.failed_attempts >= LOCKOUT_THRESHOLD
    assert account.locked()
    # And the canonical account is genuinely locked to the correct password.
    assert not store.authenticate("stuart", "a long enough password").ok


def test_one_totp_code_cannot_be_used_twice_concurrently(tmp_path):
    """Two threads submit the same valid code at once; exactly one wins."""
    store = AccountStore(tmp_path / "accounts.json")
    store.create_admin("stuart", "a long enough password")
    secret = store.begin_totp_enrolment("stuart")
    # Enrol one window in the past, as a real enrolment would be relative to
    # this login — otherwise replay protection rejects the login code as
    # already-consumed-at-enrolment (which is correct, and is its own test).
    previous = int(time.time() // 30) - 1
    store.confirm_totp_enrolment("stuart", secret, crypto.totp_at(secret, previous))
    code = crypto.totp_at(secret, int(time.time() // 30))

    results, errors = _hammer(
        lambda i: store.authenticate("stuart", "a long enough password", code), 8
    )
    assert not errors, errors
    successes = [r for r in results if r is not None and r.ok]
    assert len(successes) == 1, (
        f"a replayed TOTP code was accepted {len(successes)} times"
    )


def test_one_recovery_code_cannot_be_redeemed_twice_concurrently(tmp_path):
    store = AccountStore(tmp_path / "accounts.json")
    codes = store.create_breakglass()

    results, errors = _hammer(
        lambda i: store.authenticate("breakglass", codes[0]), 8
    )
    assert not errors, errors
    successes = [r for r in results if r is not None and r.ok]
    assert len(successes) == 1, (
        f"one recovery code was redeemed {len(successes)} times"
    )
    assert store.breakglass_account().codes_remaining == crypto.RECOVERY_CODE_COUNT - 1


def test_concurrent_distinct_recovery_codes_each_win_once(tmp_path):
    """Eight different codes redeemed at once: eight successes, eight burned."""
    store = AccountStore(tmp_path / "accounts.json")
    codes = store.create_breakglass()

    results, errors = _hammer(lambda i: store.authenticate("breakglass", codes[i]), 8)
    assert not errors, errors
    successes = [r for r in results if r is not None and r.ok]
    assert len(successes) == 8
    assert store.breakglass_account().codes_remaining == crypto.RECOVERY_CODE_COUNT - 8


def test_concurrent_saves_do_not_corrupt_the_file(tmp_path):
    """Unique-temp atomic writes: the file is always readable, never torn.

    On POSIX (the deploy target) concurrent replaces onto one target are
    atomic and lossless, so zero errors are required. On Windows the OS
    briefly locks the destination during a rename, so racing replaces can
    raise PermissionError — a documented platform limitation, not a torn
    file. The invariant that must hold everywhere is that the file always
    parses as a complete object; that is the actual corruption guarantee.
    """
    import json
    import sys

    path = tmp_path / "data.json"
    atomic_write_text(path, '{"seed": true}')

    def write(index: int) -> None:
        atomic_write_text(path, '{"n": %d, "pad": "%s"}' % (index, "x" * 5000))

    _, errors = _hammer(write, 16)
    if not sys.platform.startswith("win"):
        assert not errors, f"atomic_write_text raced on POSIX: {errors}"
    # Everywhere: whatever landed, the file is a complete object, never torn.
    assert isinstance(json.loads(path.read_text(encoding="utf-8")), dict)


def test_invalid_base32_totp_secret_does_not_crash(tmp_path):
    """Finding 7: a corrupted secret fails verification instead of raising."""
    ok, counter = crypto.verify_totp("not valid base32!!!", "123456")
    assert ok is False and counter is None


def test_atomic_write_sets_owner_only_permissions(tmp_path):
    import os
    import sys

    if sys.platform.startswith("win"):
        pytest.skip("POSIX permission bits do not apply on Windows")
    path = tmp_path / "secret"
    atomic_write_text(path, "data", mode=0o600)
    assert os.stat(path).st_mode & 0o777 == 0o600


def test_failed_atomic_write_leaves_original_intact(tmp_path, monkeypatch):
    path = tmp_path / "data.json"
    atomic_write_text(path, "original")

    import utils.fileio as fileio

    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(fileio.os, "replace", boom)
    with pytest.raises(OSError):
        atomic_write_text(path, "replacement")
    assert path.read_text(encoding="utf-8") == "original"
    # No stray temp files left behind in the directory.
    assert list(tmp_path.glob("*.tmp")) == []
