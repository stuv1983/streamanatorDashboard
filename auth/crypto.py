"""Password stretching, one-time codes and TOTP — standard library only.

No external crypto dependency. `hashlib.scrypt`, `hmac` and `secrets` ship with
CPython, and RFC 6238 TOTP is a dozen lines on top of HMAC-SHA1 — the algorithm
every authenticator app implements. Pulling in a package for either would add
supply-chain surface to a service whose entire job is watching this host.

Nothing here invents a primitive. scrypt does the password stretching, HMAC
does the TOTP, and `secrets` provides the entropy. The only original code is
the encoding of the stored hash, which is a plain PHC-style string.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import struct
import time

# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------

#: scrypt cost parameters. n=2**14 with r=8 needs ~16 MB and lands around
#: 50-100 ms on this host — slow enough to make offline guessing expensive,
#: fast enough that a login does not feel broken. `maxmem` must be set
#: explicitly: OpenSSL's default ceiling is 32 MB and raising `n` later would
#: otherwise fail at runtime rather than at review time.
SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_MAXMEM = 64 * 1024 * 1024
SALT_BYTES = 16
KEY_BYTES = 32

#: Minimum password length. Deliberately a length floor rather than a
#: composition rule ("must contain a symbol") — length is what actually
#: resists guessing, and composition rules mostly produce Passw0rd!.
MIN_PASSWORD_LENGTH = 12


def hash_password(password: str) -> str:
    """Return a self-describing scrypt hash string.

    Format: ``scrypt$n=<n>,r=<r>,p=<p>$<salt-b64>$<key-b64>``. The parameters
    travel with the hash so they can be raised later without invalidating
    every existing account.
    """
    salt = secrets.token_bytes(SALT_BYTES)
    key = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return "scrypt$n={},r={},p={}${}${}".format(
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(key).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    """Constant-time verification against a stored hash.

    A malformed or unrecognised hash returns False rather than raising: a
    corrupted account file must fail closed, not crash the login page.
    """
    try:
        scheme, params, salt_b64, key_b64 = encoded.split("$", 3)
        if scheme != "scrypt":
            return False
        parsed = dict(
            part.split("=", 1) for part in params.split(",") if "=" in part
        )
        n = int(parsed["n"])
        r = int(parsed["r"])
        p = int(parsed["p"])
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(key_b64)
    except (ValueError, KeyError, TypeError):
        return False
    try:
        candidate = _scrypt(password, salt, n, r, p, length=len(expected))
    except ValueError:
        return False
    return hmac.compare_digest(candidate, expected)


def _scrypt(
    password: str, salt: bytes, n: int, r: int, p: int, length: int = KEY_BYTES
) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=n,
        r=r,
        p=p,
        maxmem=SCRYPT_MAXMEM,
        dklen=length,
    )


#: A pre-computed hash used to burn the same CPU time when the username does
#: not exist. Without it, "unknown user" returns in microseconds while "wrong
#: password" takes 80 ms, which enumerates valid usernames from a stopwatch.
_DUMMY_HASH = hash_password("streamanator-timing-equaliser-not-a-real-password")


def burn_equivalent_time() -> None:
    """Spend a verification's worth of CPU on a throwaway hash."""
    verify_password("wrong", _DUMMY_HASH)


def password_problems(password: str) -> list[str]:
    """Return human-readable reasons a password is unacceptable, if any."""
    problems: list[str] = []
    if len(password) < MIN_PASSWORD_LENGTH:
        problems.append(
            f"Must be at least {MIN_PASSWORD_LENGTH} characters "
            f"(this one is {len(password)})."
        )
    if password.strip() != password:
        problems.append("Leading or trailing whitespace is almost always a typo.")
    if password.lower() in _WEAK_PASSWORDS:
        problems.append("This is one of the most-guessed passwords in existence.")
    return problems


_WEAK_PASSWORDS = {
    "password", "password123", "passw0rd123", "administrator",
    "streamanator", "streamanator1", "changeme", "changeme123",
    "letmein12345", "qwertyuiop12", "123456789012", "adminadmin12",
}


# ---------------------------------------------------------------------------
# Recovery codes (break-glass)
# ---------------------------------------------------------------------------

#: Crockford-ish base32 minus the characters people misread when copying a code
#: off a printed card: I/1, O/0, U (which also avoids accidental words).
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTVWXYZ23456789"
CODE_GROUPS = 3
CODE_GROUP_LENGTH = 4

#: Number of break-glass codes issued per generation.
RECOVERY_CODE_COUNT = 10


def generate_recovery_code() -> str:
    """One human-transcribable single-use code, e.g. ``K7QM-3XPD-9RTV``."""
    groups = [
        "".join(secrets.choice(_CODE_ALPHABET) for _ in range(CODE_GROUP_LENGTH))
        for _ in range(CODE_GROUPS)
    ]
    return "-".join(groups)


def normalise_recovery_code(code: str) -> str:
    """Strip formatting so a code pasted with spaces or lowercase still works."""
    return re.sub(r"[^A-Z0-9]", "", code.strip().upper())


def hash_recovery_code(code: str) -> str:
    return hash_password(normalise_recovery_code(code))


def verify_recovery_code(code: str, encoded: str) -> bool:
    return verify_password(normalise_recovery_code(code), encoded)


# ---------------------------------------------------------------------------
# TOTP (RFC 6238)
# ---------------------------------------------------------------------------

TOTP_DIGITS = 6
TOTP_PERIOD = 30
#: Accept one step either side of now. Covers clock skew and the user who
#: starts typing at second 29. Wider windows meaningfully weaken the code.
TOTP_DRIFT_STEPS = 1


def generate_totp_secret(length: int = 20) -> str:
    """A fresh base32 TOTP secret. 20 bytes is the RFC 4226 recommendation."""
    return base64.b32encode(secrets.token_bytes(length)).decode("ascii").rstrip("=")


def totp_at(secret: str, counter: int) -> str:
    """The RFC 6238 code for a given time step.

    Raises on a malformed secret — callers that face stored (and therefore
    possibly corrupted) secrets go through `verify_totp`, which does not.
    """
    padding = "=" * (-len(secret) % 8)
    key = base64.b32decode(secret.upper() + padding, casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    truncated = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(truncated % (10**TOTP_DIGITS)).zfill(TOTP_DIGITS)


def verify_totp(
    secret: str, code: str, at: float | None = None, last_counter: int | None = None
) -> tuple[bool, int | None]:
    """Verify a TOTP code, returning ``(ok, counter_used)``.

    `last_counter` gives replay protection: a code already accepted is
    refused even though it is still inside its 30-second window. Without it a
    code read over someone's shoulder stays usable until the period rolls,
    which is exactly the window an attacker standing behind you needs.

    A malformed stored secret (corrupted account file, hand-edited JSON) fails
    the verification rather than raising — `base64.b32decode` raises
    `binascii.Error`, and an exception here would crash the login thread on
    every attempt against that account, which is a denial of service with a
    one-byte cause.
    """
    import binascii

    digits = re.sub(r"\D", "", code or "")
    if len(digits) != TOTP_DIGITS or not secret:
        return False, None
    now = time.time() if at is None else at
    current = int(now // TOTP_PERIOD)
    for offset in range(-TOTP_DRIFT_STEPS, TOTP_DRIFT_STEPS + 1):
        counter = current + offset
        if last_counter is not None and counter <= last_counter:
            continue
        try:
            expected = totp_at(secret, counter)
        except (binascii.Error, ValueError, OverflowError, struct.error):
            return False, None
        if hmac.compare_digest(expected, digits):
            return True, counter
    return False, None


def totp_provisioning_uri(secret: str, account: str, issuer: str) -> str:
    """The ``otpauth://`` URI an authenticator app imports.

    Rendered as text rather than a QR code — drawing a QR needs a Reed-Solomon
    implementation or another dependency, and every authenticator supports
    manual entry of the secret.
    """
    from urllib.parse import quote

    label = quote(f"{issuer}:{account}", safe="")
    return (
        f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer, safe='')}"
        f"&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_PERIOD}"
    )


def format_secret_for_entry(secret: str) -> str:
    """Group a base32 secret in fours so it can be typed without losing place."""
    return " ".join(secret[i : i + 4] for i in range(0, len(secret), 4))


# ---------------------------------------------------------------------------
# Fingerprints
# ---------------------------------------------------------------------------


def fingerprint(value: str) -> str:
    """A short, non-reversible tag for a secret.

    Lets the audit log and UI answer "is this the same key I set last week?"
    without ever storing or displaying the key itself.
    """
    if not value:
        return "—"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
