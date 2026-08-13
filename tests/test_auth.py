"""Tests for password hashing, lockout, TOTP, break-glass codes and sessions.

These cover the properties that are easy to get subtly wrong and impossible to
notice from the UI: a lockout that never engages, a TOTP code that can be
replayed, a recovery code that survives use. Each of those looks completely
normal from the outside.
"""

from __future__ import annotations

import json
import time

import pytest

from auth import crypto
from auth.accounts import LOCKOUT_SCHEDULE, LOCKOUT_THRESHOLD, AccountStore
from auth.audit import AuditLog


@pytest.fixture()
def store(tmp_path) -> AccountStore:
    return AccountStore(tmp_path / "accounts.json")


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------


def test_password_round_trip():
    encoded = crypto.hash_password("correct horse battery staple")
    assert crypto.verify_password("correct horse battery staple", encoded)
    assert not crypto.verify_password("Correct horse battery staple", encoded)


def test_hash_is_salted_so_identical_passwords_differ():
    first = crypto.hash_password("the same password")
    second = crypto.hash_password("the same password")
    assert first != second, "identical hashes mean the salt is not being used"


def test_hash_never_contains_the_password():
    encoded = crypto.hash_password("hunter2hunter2hunter2")
    assert "hunter2" not in encoded


def test_malformed_hash_fails_closed():
    """A corrupted account file must refuse the login, not crash the page."""
    for broken in ("", "notahash", "scrypt$$$", "bcrypt$n=1$aaaa$bbbb", "scrypt$n=x,r=8,p=1$aa$bb"):
        assert crypto.verify_password("anything", broken) is False


def test_short_passwords_are_rejected():
    assert crypto.password_problems("short")
    assert not crypto.password_problems("a sufficiently long one")


def test_weak_password_list_is_enforced():
    assert crypto.password_problems("changeme123")


# ---------------------------------------------------------------------------
# Authentication and lockout
# ---------------------------------------------------------------------------


def test_authenticate_accepts_the_right_password(store):
    store.create_admin("stuart", "a long enough password")
    assert store.authenticate("stuart", "a long enough password").ok


def test_authenticate_rejects_the_wrong_password(store):
    store.create_admin("stuart", "a long enough password")
    result = store.authenticate("stuart", "a long enough passwerd")
    assert not result.ok


def test_unknown_user_and_wrong_password_give_the_same_message(store):
    """Different messages would let an attacker enumerate valid usernames."""
    store.create_admin("stuart", "a long enough password")
    missing = store.authenticate("nobody", "whatever at all")
    wrong = store.authenticate("stuart", "wrong password here")
    assert missing.reason == wrong.reason


def test_lockout_engages_after_the_threshold(store):
    store.create_admin("stuart", "a long enough password")
    for _ in range(LOCKOUT_THRESHOLD):
        store.authenticate("stuart", "wrong")
    result = store.authenticate("stuart", "a long enough password")
    assert not result.ok, "the correct password must not work while locked out"
    assert result.locked_seconds > 0
    assert result.locked_seconds <= LOCKOUT_SCHEDULE[0]


def test_lockout_escalates_on_continued_failures(store):
    store.create_admin("stuart", "a long enough password")
    for _ in range(LOCKOUT_THRESHOLD):
        store.authenticate("stuart", "wrong")
    first = store.get("stuart").locked_until
    store.unlock("stuart")
    # Drive it further past the threshold and confirm the next lock is longer.
    for _ in range(LOCKOUT_THRESHOLD + 2):
        store.authenticate("stuart", "wrong")
    second = store.get("stuart").locked_until
    assert second - time.time() > first - time.time()


def test_successful_login_clears_failed_attempts(store):
    store.create_admin("stuart", "a long enough password")
    store.authenticate("stuart", "wrong")
    store.authenticate("stuart", "wrong")
    store.authenticate("stuart", "a long enough password")
    assert store.get("stuart").failed_attempts == 0


def test_unlock_clears_a_lockout(store):
    store.create_admin("stuart", "a long enough password")
    for _ in range(LOCKOUT_THRESHOLD):
        store.authenticate("stuart", "wrong")
    store.unlock("stuart")
    assert store.authenticate("stuart", "a long enough password").ok


def test_disabled_account_cannot_sign_in(store):
    store.create_admin("stuart", "a long enough password")
    store.create_admin("second", "another long password")
    store.set_disabled("stuart", True)
    assert not store.authenticate("stuart", "a long enough password").ok


def test_cannot_disable_or_delete_the_last_admin(store):
    """An account store with no way in needs a text editor and a shell to fix."""
    store.create_admin("stuart", "a long enough password")
    with pytest.raises(ValueError):
        store.set_disabled("stuart", True)
    with pytest.raises(ValueError):
        store.delete("stuart")


# ---------------------------------------------------------------------------
# TOTP
# ---------------------------------------------------------------------------


def test_totp_matches_rfc6238_reference_vector():
    """RFC 6238 Appendix B: SHA1, seed '12345678901234567890', T=59 -> 94287082."""
    import base64

    secret = base64.b32encode(b"12345678901234567890").decode().rstrip("=")
    assert crypto.totp_at(secret, 59 // 30) == "94287082"[-6:]


def test_totp_accepts_a_current_code():
    secret = crypto.generate_totp_secret()
    now = time.time()
    code = crypto.totp_at(secret, int(now // 30))
    ok, counter = crypto.verify_totp(secret, code, at=now)
    assert ok and counter == int(now // 30)


def test_totp_tolerates_one_step_of_drift():
    secret = crypto.generate_totp_secret()
    now = time.time()
    previous = crypto.totp_at(secret, int(now // 30) - 1)
    assert crypto.verify_totp(secret, previous, at=now)[0]


def test_totp_rejects_two_steps_of_drift():
    secret = crypto.generate_totp_secret()
    now = time.time()
    stale = crypto.totp_at(secret, int(now // 30) - 3)
    assert not crypto.verify_totp(secret, stale, at=now)[0]


def test_totp_code_cannot_be_replayed():
    """A shoulder-surfed code stays valid for 30s unless replay is blocked."""
    secret = crypto.generate_totp_secret()
    now = time.time()
    counter = int(now // 30)
    code = crypto.totp_at(secret, counter)
    ok, used = crypto.verify_totp(secret, code, at=now)
    assert ok
    again, _ = crypto.verify_totp(secret, code, at=now, last_counter=used)
    assert not again, "the same code was accepted twice"


def test_totp_enrolment_only_stores_after_a_code_verifies(store):
    """Storing the secret first is how people lock themselves out."""
    store.create_admin("stuart", "a long enough password")
    secret = store.begin_totp_enrolment("stuart")
    assert store.get("stuart").totp_secret is None

    assert not store.confirm_totp_enrolment("stuart", secret, "000000")
    assert store.get("stuart").totp_secret is None

    code = crypto.totp_at(secret, int(time.time() // 30))
    assert store.confirm_totp_enrolment("stuart", secret, code)
    assert store.get("stuart").totp_secret == secret


def test_password_alone_is_refused_once_totp_is_enrolled(store):
    store.create_admin("stuart", "a long enough password")
    secret = store.begin_totp_enrolment("stuart")
    store.confirm_totp_enrolment(
        "stuart", secret, crypto.totp_at(secret, int(time.time() // 30))
    )
    result = store.authenticate("stuart", "a long enough password")
    assert not result.ok
    assert result.totp_required


def test_missing_totp_code_does_not_count_towards_lockout(store):
    """The password was right; the form just needs a second field."""
    store.create_admin("stuart", "a long enough password")
    secret = store.begin_totp_enrolment("stuart")
    store.confirm_totp_enrolment(
        "stuart", secret, crypto.totp_at(secret, int(time.time() // 30))
    )
    for _ in range(LOCKOUT_THRESHOLD + 2):
        store.authenticate("stuart", "a long enough password")
    assert store.get("stuart").failed_attempts == 0


# ---------------------------------------------------------------------------
# Break-glass
# ---------------------------------------------------------------------------


def test_breakglass_issues_the_expected_number_of_codes(store):
    codes = store.create_breakglass()
    assert len(codes) == crypto.RECOVERY_CODE_COUNT
    assert len(set(codes)) == len(codes), "duplicate codes were generated"


def test_breakglass_plaintext_never_touches_the_file(store):
    codes = store.create_breakglass()
    raw = store.path.read_text(encoding="utf-8")
    for code in codes:
        assert code not in raw
        assert crypto.normalise_recovery_code(code) not in raw


def test_breakglass_code_works_once_and_is_then_burned(store):
    codes = store.create_breakglass()
    first = store.authenticate("breakglass", codes[0])
    assert first.ok
    assert first.codes_remaining == crypto.RECOVERY_CODE_COUNT - 1

    second = store.authenticate("breakglass", codes[0])
    assert not second.ok, "a used recovery code was accepted again"


def test_breakglass_codes_tolerate_formatting(store):
    codes = store.create_breakglass()
    messy = f"  {codes[0].lower().replace('-', ' ')}  "
    assert store.authenticate("breakglass", messy).ok


def test_breakglass_usage_total_survives_reissue(store):
    codes = store.create_breakglass()
    store.authenticate("breakglass", codes[0])
    store.create_breakglass()
    assert store.breakglass_account().recovery_codes_used_total == 1


def test_reissuing_invalidates_old_codes(store):
    old = store.create_breakglass()
    store.create_breakglass()
    assert not store.authenticate("breakglass", old[0]).ok


def test_breakglass_has_no_password(store):
    store.create_breakglass()
    assert store.breakglass_account().password_hash is None
    with pytest.raises(ValueError):
        store.set_password("breakglass", "a long enough password")


# ---------------------------------------------------------------------------
# Store durability
# ---------------------------------------------------------------------------


def test_corrupt_store_fails_closed(tmp_path):
    """Finding 9: a corrupt file must raise, not read as empty.

    Returning {} would let the next mutation *save* that empty store, turning
    one bad byte into the deletion of every account. The privileged surface
    must refuse to proceed instead.
    """
    from auth.accounts import StoreCorruptError

    path = tmp_path / "accounts.json"
    path.write_text("{not json at all", encoding="utf-8")
    with pytest.raises(StoreCorruptError):
        AccountStore(path).load()


def test_malformed_entry_poisons_the_whole_load(tmp_path):
    """A single bad entry must raise rather than being silently skipped —
    skipping it would drop that account on the next save."""
    from auth.accounts import StoreCorruptError

    path = tmp_path / "accounts.json"
    path.write_text(
        json.dumps(
            {
                "version": 3,
                "accounts": [
                    {"nope": "no username"},
                    {"username": "ok", "role": "admin"},
                ],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(StoreCorruptError):
        AccountStore(path).load()


def test_missing_store_is_not_corrupt(tmp_path):
    """'Not set up yet' and 'corrupt' must stay distinguishable."""
    assert AccountStore(tmp_path / "absent.json").load() == {}


def test_store_is_written_with_restrictive_permissions(store):
    import os
    import sys

    store.create_admin("stuart", "a long enough password")
    if sys.platform.startswith("win"):
        pytest.skip("POSIX permission bits do not apply on Windows")
    assert os.stat(store.path).st_mode & 0o777 == 0o600


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------


def test_audit_writes_and_reads_back(tmp_path):
    log = AuditLog(tmp_path / "audit.log")
    log.record("action.start", "stuart", "admin", "started", target="server.reboot")
    entries = log.read()
    assert len(entries) == 1
    assert entries[0].action == "action.start"
    assert entries[0].actor == "stuart"


def test_audit_returns_newest_first(tmp_path):
    log = AuditLog(tmp_path / "audit.log")
    log.record("first", "a", "admin", "ok")
    log.record("second", "a", "admin", "ok")
    assert [e.action for e in log.read()] == ["second", "first"]


def test_audit_redacts_credential_shaped_detail(tmp_path):
    """The scrubber is the backstop for a caller that forgets."""
    log = AuditLog(tmp_path / "audit.log")
    log.record(
        "config.credential_set",
        "stuart",
        "admin",
        "success",
        detail="api_key=abcd1234efgh5678ijkl9012mnop",
    )
    raw = (tmp_path / "audit.log").read_text(encoding="utf-8")
    assert "abcd1234efgh5678ijkl9012mnop" not in raw
    assert "<redacted>" in raw


def test_audit_redacts_bare_high_entropy_strings(tmp_path):
    log = AuditLog(tmp_path / "audit.log")
    secret = "0123456789abcdef0123456789abcdef"
    log.record("config.credential_set", "stuart", "admin", "success", detail=secret)
    assert secret not in (tmp_path / "audit.log").read_text(encoding="utf-8")


def test_audit_filters_by_severity(tmp_path):
    log = AuditLog(tmp_path / "audit.log")
    log.record("quiet", "a", "admin", "ok", severity="info")
    log.record("loud", "a", "admin", "ok", severity="critical")
    assert [e.action for e in log.read(min_severity="warning")] == ["loud"]


def test_audit_marks_breakglass_entries(tmp_path):
    log = AuditLog(tmp_path / "audit.log")
    log.record("auth.signin", "breakglass", "breakglass", "success", breakglass=True)
    log.record("auth.signin", "stuart", "admin", "success")
    assert [e.actor for e in log.breakglass_events()] == ["breakglass"]


def test_audit_survives_a_truncated_line(tmp_path):
    path = tmp_path / "audit.log"
    log = AuditLog(path)
    log.record("good", "a", "admin", "ok")
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"at": 123, "actor": "trunc\n')
    assert [e.action for e in log.read()] == ["good"]
