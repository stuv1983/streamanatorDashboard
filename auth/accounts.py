"""The account store: two roles, a JSON file, and a lockout policy.

Two account types exist and they are deliberately different in kind:

**admin** — the everyday privileged account. Password plus optional TOTP. Used
for adding API keys, running admin jobs, restarting services.

**breakglass** — the emergency account, for when the admin path itself is
broken: TOTP device lost, admin password forgotten, admin account locked out.
It has *no password*. It authenticates with single-use recovery codes that are
generated once, displayed once, stored only as hashes, and burned on use.

That asymmetry is the whole point. A break-glass account with a memorable
reusable password is just a second admin account with weaker auth — it becomes
the easiest way in rather than the last way in.

Concurrency model — the part a security review actually has to trust:

* Every operation that reads, decides and writes does all three **inside one
  RLock-held critical section**. The first version locked nothing and did
  multiple load/save round-trips per authentication; under concurrent
  requests that lost failed-attempt increments (defeating lockout), could
  accept the same TOTP counter twice, and could redeem one recovery code
  twice. Streamlit serves sessions on concurrent threads, so "it's a single
  process" was never a defence.
* Usernames are canonicalised (`.strip()`) exactly once, at the top of each
  entry point. The first version stripped for the lookup but used the raw
  string for the failure bookkeeping, so ``" stuart "`` could fail forever
  without ever locking ``stuart``.
* The file is written atomically via a unique temporary (`utils.fileio`), at
  0600 from creation.
* A corrupt store **fails closed**: `load()` raises `StoreCorruptError`
  instead of returning ``{}``, because an empty dict here silently becomes a
  *saved* empty store on the next mutation — turning one bad byte into the
  deletion of every account.

Cross-process writers (the bootstrap CLI while the server runs) remain a
last-writer-wins race on the whole file; both sides write atomically so the
file is never torn, and the CLI is an operator action, not a request path.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Literal

from auth import crypto
from utils.fileio import atomic_write_text
from utils.logging_setup import get_logger

log = get_logger("auth.accounts")

Role = Literal["admin", "breakglass"]

#: Consecutive failures before an account locks.
LOCKOUT_THRESHOLD = 5

#: Lock durations, in seconds, indexed by how far past the threshold we are.
#: Escalating rather than fixed: a fat-fingered password should cost a minute,
#: a sustained guessing run should cost an hour. The last value repeats.
LOCKOUT_SCHEDULE = (60, 300, 900, 3600)

#: Warn when the break-glass account has fewer than this many codes left.
LOW_CODE_WARNING = 3

STORE_VERSION = 3

_GENERIC_FAILURE = "Incorrect username or password."

_USERNAME = re.compile(r"[A-Za-z0-9._-]{3,32}\Z")


class StoreCorruptError(RuntimeError):
    """The account file exists but cannot be trusted.

    Deliberately distinct from "missing": a missing store means "not set up
    yet", a corrupt one means "stop — do not authenticate anyone and do not
    write, or the corruption becomes permanent". Recovery is a human with a
    shell: restore the file or re-run `scripts/admin_bootstrap.py init`.
    """


@dataclass
class Account:
    username: str
    role: Role
    password_hash: str | None = None
    totp_secret: str | None = None
    totp_last_counter: int | None = None
    #: Hashes of unused recovery codes. Break-glass only.
    recovery_code_hashes: list[str] = field(default_factory=list)
    #: How many codes have ever been consumed — survives regeneration, so the
    #: total number of emergency entries is never silently reset.
    recovery_codes_used_total: int = 0
    failed_attempts: int = 0
    locked_until: float = 0.0
    disabled: bool = False
    created_at: float = 0.0
    last_login_at: float | None = None
    password_changed_at: float | None = None
    #: Bumped on every security-sensitive change (password reset, TOTP
    #: removal, disable, break-glass reissue). Live sessions carry the value
    #: they were created with and are refused once it moves — without this, a
    #: disabled account's existing session kept full authority for up to four
    #: hours.
    session_version: int = 0
    note: str = ""

    @property
    def totp_enrolled(self) -> bool:
        return bool(self.totp_secret)

    @property
    def codes_remaining(self) -> int:
        return len(self.recovery_code_hashes)

    def locked(self, now: float | None = None) -> bool:
        return self.locked_until > (time.time() if now is None else now)

    def lock_seconds_remaining(self, now: float | None = None) -> int:
        remaining = self.locked_until - (time.time() if now is None else now)
        return max(0, int(remaining))


@dataclass(frozen=True)
class AuthResult:
    ok: bool
    account: Account | None = None
    #: Message safe to show on the login form. Never distinguishes "no such
    #: user" from "wrong password" — that difference is an enumeration oracle.
    reason: str = ""
    #: Set when the failure was a lockout, so the UI can show a countdown.
    locked_seconds: int = 0
    #: True when the caller must now supply a TOTP code.
    totp_required: bool = False
    #: Break-glass only: how many codes are left after this login.
    codes_remaining: int | None = None


class AccountStore:
    """JSON-backed account store. Thread-safe within the process."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()

    # -- persistence -------------------------------------------------------

    def load(self) -> dict[str, Account]:
        with self._lock:
            return self._load_unlocked()

    def _load_unlocked(self) -> dict[str, Account]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise StoreCorruptError(f"Account store unreadable: {exc}") from exc
        if not isinstance(raw, dict) or not isinstance(raw.get("accounts"), list):
            raise StoreCorruptError("Account store has an invalid top-level schema.")
        accounts: dict[str, Account] = {}
        known = set(Account.__dataclass_fields__)
        for entry in raw["accounts"]:
            # Any malformed entry poisons the whole load. Skipping it instead
            # would drop that account on the next save — a silent deletion.
            if not isinstance(entry, dict) or not entry.get("username"):
                raise StoreCorruptError("Account entry is not a valid object.")
            try:
                accounts[entry["username"]] = Account(
                    **{k: v for k, v in entry.items() if k in known}
                )
            except (TypeError, ValueError) as exc:
                raise StoreCorruptError(f"Malformed account entry: {exc}") from exc
        return accounts

    def _save_unlocked(self, accounts: dict[str, Account]) -> None:
        payload = {
            "version": STORE_VERSION,
            "updated_at": time.time(),
            "accounts": [asdict(a) for a in accounts.values()],
        }
        atomic_write_text(
            self.path, json.dumps(payload, indent=2, sort_keys=True), mode=0o600
        )

    def save(self, accounts: dict[str, Account]) -> None:
        with self._lock:
            self._save_unlocked(accounts)

    # -- queries -----------------------------------------------------------

    def get(self, username: str) -> Account | None:
        return self.load().get((username or "").strip())

    def list_accounts(self) -> list[Account]:
        return sorted(self.load().values(), key=lambda a: (a.role, a.username))

    def has_admin(self) -> bool:
        return any(
            a.role == "admin" and not a.disabled for a in self.load().values()
        )

    def breakglass_account(self) -> Account | None:
        return next(
            (a for a in self.load().values() if a.role == "breakglass"), None
        )

    def initialised(self) -> bool:
        return self.path.is_file() and bool(self.load())

    # -- mutation ----------------------------------------------------------

    def put(self, account: Account) -> None:
        with self._lock:
            accounts = self._load_unlocked()
            accounts[account.username] = account
            self._save_unlocked(accounts)

    def delete(self, username: str) -> bool:
        canonical = (username or "").strip()
        with self._lock:
            accounts = self._load_unlocked()
            if canonical not in accounts:
                return False
            target = accounts[canonical]
            # Refuse to remove the last usable admin: an account store with no
            # way in is a lockout that needs a text editor and a shell to undo.
            if target.role == "admin":
                others = [
                    a
                    for name, a in accounts.items()
                    if name != canonical and a.role == "admin" and not a.disabled
                ]
                if not others:
                    raise ValueError(
                        "Refusing to delete the only enabled admin account. "
                        "Create a replacement admin first."
                    )
            del accounts[canonical]
            self._save_unlocked(accounts)
            return True

    def create_admin(
        self, username: str, password: str, note: str = ""
    ) -> Account:
        canonical = (username or "").strip()
        problems = crypto.password_problems(password)
        if problems:
            raise ValueError(" ".join(problems))
        if not _USERNAME.fullmatch(canonical):
            raise ValueError(
                "Username must be 3-32 characters of letters, digits, dot, "
                "dash or underscore."
            )
        with self._lock:
            accounts = self._load_unlocked()
            if canonical in accounts:
                raise ValueError(f"An account named {canonical!r} already exists.")
            now = time.time()
            account = Account(
                username=canonical,
                role="admin",
                password_hash=crypto.hash_password(password),
                created_at=now,
                password_changed_at=now,
                note=note,
            )
            accounts[canonical] = account
            self._save_unlocked(accounts)
            return account

    def set_password(self, username: str, password: str) -> None:
        canonical = (username or "").strip()
        problems = crypto.password_problems(password)
        if problems:
            raise ValueError(" ".join(problems))
        with self._lock:
            accounts = self._load_unlocked()
            account = accounts.get(canonical)
            if account is None:
                raise ValueError(f"No account named {canonical!r}.")
            if account.role != "admin":
                raise ValueError(
                    "Break-glass accounts have no password by design — "
                    "regenerate their recovery codes instead."
                )
            accounts[canonical] = replace(
                account,
                password_hash=crypto.hash_password(password),
                password_changed_at=time.time(),
                failed_attempts=0,
                locked_until=0.0,
                # Every session opened before this change dies with it. The
                # scenario that matters: a stolen or abandoned session should
                # not outlive the password reset performed to shut it out.
                session_version=account.session_version + 1,
            )
            self._save_unlocked(accounts)

    def set_disabled(self, username: str, disabled: bool) -> None:
        canonical = (username or "").strip()
        with self._lock:
            accounts = self._load_unlocked()
            account = accounts.get(canonical)
            if account is None:
                raise ValueError(f"No account named {canonical!r}.")
            if disabled and account.role == "admin":
                others = [
                    a
                    for name, a in accounts.items()
                    if name != canonical and a.role == "admin" and not a.disabled
                ]
                if not others:
                    raise ValueError(
                        "Refusing to disable the only enabled admin account."
                    )
            accounts[canonical] = replace(
                account,
                disabled=disabled,
                session_version=account.session_version + (1 if disabled else 0),
            )
            self._save_unlocked(accounts)

    def unlock(self, username: str) -> None:
        canonical = (username or "").strip()
        with self._lock:
            accounts = self._load_unlocked()
            account = accounts.get(canonical)
            if account is None:
                return
            accounts[canonical] = replace(
                account, failed_attempts=0, locked_until=0.0
            )
            self._save_unlocked(accounts)

    # -- TOTP --------------------------------------------------------------

    def begin_totp_enrolment(self, username: str) -> str:
        """Generate a candidate secret. Not stored until a code is confirmed.

        Enrolment that stores the secret before proving the user can produce a
        code is how people lock themselves out: the account demands TOTP and
        the authenticator was never actually set up.
        """
        if self.get(username) is None:
            raise ValueError(f"No account named {username!r}.")
        return crypto.generate_totp_secret()

    def confirm_totp_enrolment(
        self, username: str, secret: str, code: str
    ) -> bool:
        canonical = (username or "").strip()
        ok, counter = crypto.verify_totp(secret, code)
        if not ok:
            return False
        with self._lock:
            accounts = self._load_unlocked()
            account = accounts.get(canonical)
            if account is None:
                return False
            accounts[canonical] = replace(
                account, totp_secret=secret, totp_last_counter=counter
            )
            self._save_unlocked(accounts)
            return True

    def disable_totp(self, username: str) -> None:
        canonical = (username or "").strip()
        with self._lock:
            accounts = self._load_unlocked()
            account = accounts.get(canonical)
            if account is None:
                raise ValueError(f"No account named {canonical!r}.")
            accounts[canonical] = replace(
                account,
                totp_secret=None,
                totp_last_counter=None,
                # Removing a second factor weakens the account; sessions that
                # predate the removal should not coast through it.
                session_version=account.session_version + 1,
            )
            self._save_unlocked(accounts)

    # -- break-glass -------------------------------------------------------

    def create_breakglass(self, username: str = "breakglass") -> list[str]:
        """Create (or reset) the break-glass account and return fresh codes.

        The plaintext codes are returned exactly once — nothing stores them.
        Reissuing invalidates every outstanding code *and* every live
        break-glass session (the session_version moves).
        """
        canonical = (username or "").strip()
        codes = [
            crypto.generate_recovery_code()
            for _ in range(crypto.RECOVERY_CODE_COUNT)
        ]
        with self._lock:
            accounts = self._load_unlocked()
            existing = accounts.get(canonical)
            now = time.time()
            accounts[canonical] = Account(
                username=canonical,
                role="breakglass",
                password_hash=None,
                recovery_code_hashes=[crypto.hash_recovery_code(c) for c in codes],
                recovery_codes_used_total=(
                    existing.recovery_codes_used_total if existing else 0
                ),
                created_at=existing.created_at if existing else now,
                session_version=(existing.session_version + 1) if existing else 0,
                note="Emergency access. Single-use codes only.",
            )
            self._save_unlocked(accounts)
        return codes

    # -- authentication ----------------------------------------------------

    def authenticate(
        self, username: str, password: str, totp_code: str = ""
    ) -> AuthResult:
        """Verify a credential and apply the lockout policy.

        Admin accounts take a password (and a TOTP code once enrolled).
        Break-glass accounts take a single-use recovery code in place of the
        password. Failure messages never reveal which part was wrong.

        The entire check-and-update runs inside the lock: the TOTP replay
        counter and the recovery-code burn are persisted in the same critical
        section that verified them, so two concurrent submissions of the same
        code cannot both succeed.
        """
        canonical = (username or "").strip()
        if not canonical:
            crypto.burn_equivalent_time()
            return AuthResult(False, reason=_GENERIC_FAILURE)

        with self._lock:
            accounts = self._load_unlocked()
            account = accounts.get(canonical)

            if account is None:
                # Equalise timing so a stopwatch cannot enumerate usernames.
                crypto.burn_equivalent_time()
                return AuthResult(False, reason=_GENERIC_FAILURE)

            if account.disabled:
                crypto.burn_equivalent_time()
                return AuthResult(False, reason="This account is disabled.")

            now = time.time()
            if account.locked(now):
                return AuthResult(
                    False,
                    reason="Too many failed attempts.",
                    locked_seconds=account.lock_seconds_remaining(now),
                )

            if account.role == "breakglass":
                return self._redeem_recovery_code_unlocked(
                    accounts, account, password
                )

            if not account.password_hash or not crypto.verify_password(
                password, account.password_hash
            ):
                self._register_failure_unlocked(accounts, canonical)
                self._save_unlocked(accounts)
                return AuthResult(False, reason=_GENERIC_FAILURE)

            if account.totp_enrolled:
                if not totp_code:
                    # Not a failure — the password was right, the form now
                    # needs a second field. Does not count against lockout.
                    return AuthResult(
                        False,
                        reason="Enter your authenticator code.",
                        totp_required=True,
                    )
                ok, counter = crypto.verify_totp(
                    account.totp_secret or "",
                    totp_code,
                    last_counter=account.totp_last_counter,
                )
                if not ok:
                    self._register_failure_unlocked(accounts, canonical)
                    self._save_unlocked(accounts)
                    return AuthResult(
                        False,
                        reason=(
                            "That authenticator code is not valid "
                            "(or was already used)."
                        ),
                        totp_required=True,
                    )
                account = replace(account, totp_last_counter=counter)

            account = replace(
                account,
                failed_attempts=0,
                locked_until=0.0,
                last_login_at=time.time(),
            )
            accounts[canonical] = account
            self._save_unlocked(accounts)
            return AuthResult(True, account=account)

    def verify_password_factor(self, username: str, password: str) -> AuthResult:
        """Verify the password alone, for step-up re-authentication.

        This exists because full `authenticate()` demands the TOTP code once
        one is enrolled — correct at the front door, but it made step-up
        (`sudo`-style password re-entry) permanently impossible for exactly
        the accounts that took security seriously enough to enrol TOTP. The
        session already proved the second factor at sign-in; step-up re-proves
        presence, and the password is the factor a walk-up attacker at an
        unlocked screen does not have.

        Wrong answers count toward lockout, same as the front door.
        """
        canonical = (username or "").strip()
        if not canonical:
            crypto.burn_equivalent_time()
            return AuthResult(False, reason=_GENERIC_FAILURE)
        with self._lock:
            accounts = self._load_unlocked()
            account = accounts.get(canonical)
            if account is None or account.disabled or account.role != "admin":
                crypto.burn_equivalent_time()
                return AuthResult(False, reason=_GENERIC_FAILURE)
            now = time.time()
            if account.locked(now):
                return AuthResult(
                    False,
                    reason="Too many failed attempts.",
                    locked_seconds=account.lock_seconds_remaining(now),
                )
            if not account.password_hash or not crypto.verify_password(
                password, account.password_hash
            ):
                self._register_failure_unlocked(accounts, canonical)
                self._save_unlocked(accounts)
                return AuthResult(False, reason=_GENERIC_FAILURE)
            accounts[canonical] = replace(account, failed_attempts=0)
            self._save_unlocked(accounts)
            return AuthResult(True, account=accounts[canonical])

    # -- internals (call only with the lock held) --------------------------

    def _redeem_recovery_code_unlocked(
        self, accounts: dict[str, Account], account: Account, code: str
    ) -> AuthResult:
        remaining = list(account.recovery_code_hashes)
        for encoded in remaining:
            if crypto.verify_recovery_code(code, encoded):
                remaining.remove(encoded)
                updated = replace(
                    account,
                    recovery_code_hashes=remaining,
                    recovery_codes_used_total=account.recovery_codes_used_total + 1,
                    failed_attempts=0,
                    locked_until=0.0,
                    last_login_at=time.time(),
                )
                accounts[account.username] = updated
                self._save_unlocked(accounts)
                log.warning(
                    "BREAK-GLASS login by %s; %d codes remaining",
                    account.username,
                    len(remaining),
                )
                return AuthResult(
                    True, account=updated, codes_remaining=len(remaining)
                )
        self._register_failure_unlocked(accounts, account.username)
        self._save_unlocked(accounts)
        return AuthResult(False, reason="That recovery code is not valid.")

    def _register_failure_unlocked(
        self, accounts: dict[str, Account], username: str
    ) -> None:
        account = accounts.get(username)
        if account is None:
            return
        attempts = account.failed_attempts + 1
        locked_until = account.locked_until
        if attempts >= LOCKOUT_THRESHOLD:
            index = min(attempts - LOCKOUT_THRESHOLD, len(LOCKOUT_SCHEDULE) - 1)
            locked_until = time.time() + LOCKOUT_SCHEDULE[index]
            log.warning(
                "Account %s locked for %ds after %d failed attempts",
                username,
                LOCKOUT_SCHEDULE[index],
                attempts,
            )
        accounts[username] = replace(
            account, failed_attempts=attempts, locked_until=locked_until
        )
