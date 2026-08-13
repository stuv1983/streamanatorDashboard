#!/usr/bin/env python3
"""Create and repair dashboard admin accounts from a shell.

This is the only way to create the *first* admin account, and that is a
deliberate design choice rather than an omission. The usual alternative — a
first-run setup wizard in the web UI — leaves a window in which anyone who can
reach the port can claim the admin account. On a service bound to 0.0.0.0 that
window opens the moment the process starts. Requiring shell access to
bootstrap means the first account can only be created by someone who already
has the server.

It is also the recovery path. If every credential is lost, this script running
as the service user can reset the password or reissue break-glass codes,
because it has the one thing the web UI cannot require: local access.

Usage:
    python scripts/admin_bootstrap.py init            # first admin + break-glass
    python scripts/admin_bootstrap.py add-admin NAME
    python scripts/admin_bootstrap.py passwd NAME
    python scripts/admin_bootstrap.py breakglass      # reissue recovery codes
    python scripts/admin_bootstrap.py unlock NAME
    python scripts/admin_bootstrap.py disable-totp NAME
    python scripts/admin_bootstrap.py list
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from auth.accounts import AccountStore  # noqa: E402
from auth.audit import AuditLog  # noqa: E402
from auth.crypto import MIN_PASSWORD_LENGTH, password_problems  # noqa: E402
from config import get_settings  # noqa: E402


def _prompt_password(label: str = "Password") -> str:
    """Read a password twice, without echoing, refusing weak values."""
    if not sys.stdin.isatty():
        raise SystemExit(
            "Refusing to read a password from a pipe — run this in a terminal "
            "so it is not captured in shell history or logs."
        )
    while True:
        first = getpass.getpass(f"{label} (min {MIN_PASSWORD_LENGTH} chars): ")
        problems = password_problems(first)
        if problems:
            print("  " + "\n  ".join(problems), file=sys.stderr)
            continue
        second = getpass.getpass(f"{label} again: ")
        if first != second:
            print("  Passwords did not match. Try again.", file=sys.stderr)
            continue
        return first


def _print_codes(codes: list[str]) -> None:
    width = max(len(c) for c in codes) + 4
    print()
    print("=" * (width + 8))
    print("BREAK-GLASS RECOVERY CODES — SHOWN ONCE, NEVER AGAIN")
    print("=" * (width + 8))
    for index, code in enumerate(codes, start=1):
        print(f"  {index:>2}. {code}")
    print("=" * (width + 8))
    print(
        "Each code works exactly once. Store them somewhere that does not\n"
        "depend on this server being up — a password manager on another\n"
        "device, or printed and kept with the router. Codes kept only on\n"
        "streamanator are useless in the emergency they exist for.\n"
    )


def _refuse_root_writes(directory: Path) -> None:
    """Refuse to write state as a user the dashboard cannot read back.

    `sudo .venv/bin/python scripts/admin_bootstrap.py init` writes a
    root-owned, 0600 accounts.json. The service then runs as `arm`, gets
    EACCES on every sign-in, and the accounts are intact but unreachable —
    with the old error text advising deletion as the fix.

    The test is "am I root writing into somebody else's directory", not "am I
    root", so a deployment that genuinely runs as root is left alone.
    """
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return
    if os.environ.get("STREAMANATOR_ALLOW_ROOT") == "1":
        return
    try:
        owner_uid = directory.stat().st_uid
    except OSError:
        return
    if owner_uid == 0:
        return
    try:
        import pwd

        owner = pwd.getpwuid(owner_uid).pw_name
    except (ImportError, KeyError):  # pragma: no cover - unusual passwd setup
        owner = str(owner_uid)
    raise SystemExit(
        f"Refusing to run as root: {directory} belongs to '{owner}', and files "
        f"written here would be root-owned and unreadable by the dashboard.\n"
        f"Run it as the service user instead:\n"
        f"  sudo -u {owner} .venv/bin/python scripts/admin_bootstrap.py ...\n"
        f"(set STREAMANATOR_ALLOW_ROOT=1 if the service really does run as root)"
    )


def _store() -> tuple[AccountStore, AuditLog]:
    settings = get_settings()
    directory = Path(settings.auth.accounts_path).parent
    directory.mkdir(parents=True, exist_ok=True)
    _refuse_root_writes(directory)
    return AccountStore(settings.auth.accounts_path), AuditLog(settings.auth.audit_path)


def cmd_init(args: argparse.Namespace) -> int:
    store, audit = _store()
    if store.has_admin() and not args.force:
        print(
            "An admin account already exists. Use `add-admin` or `passwd`, or "
            "pass --force to add another admin anyway.",
            file=sys.stderr,
        )
        return 1
    username = args.username or input("Admin username [admin]: ").strip() or "admin"
    password = _prompt_password()
    try:
        store.create_admin(username, password, note="Created by admin_bootstrap init")
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    audit.record(
        "account.create", os.environ.get("USER", "shell"), "shell", "success",
        severity="warning", target=username, detail="admin account created via CLI",
    )
    print(f"\nCreated admin account: {username}")

    codes = store.create_breakglass()
    audit.record(
        "account.breakglass_issued", os.environ.get("USER", "shell"), "shell",
        "success", severity="critical", target="breakglass",
        detail=f"{len(codes)} recovery codes issued via CLI",
    )
    _print_codes(codes)
    print("Next: sign in at the dashboard, then enrol TOTP under Admin → Accounts.")
    return 0


def cmd_add_admin(args: argparse.Namespace) -> int:
    store, audit = _store()
    password = _prompt_password()
    try:
        store.create_admin(args.username, password, note=args.note or "")
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    audit.record(
        "account.create", os.environ.get("USER", "shell"), "shell", "success",
        severity="warning", target=args.username, detail="admin account created via CLI",
    )
    print(f"Created admin account: {args.username}")
    return 0


def cmd_passwd(args: argparse.Namespace) -> int:
    store, audit = _store()
    if store.get(args.username) is None:
        print(f"No account named {args.username!r}.", file=sys.stderr)
        return 1
    password = _prompt_password("New password")
    try:
        store.set_password(args.username, password)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    audit.record(
        "account.password_reset", os.environ.get("USER", "shell"), "shell",
        "success", severity="warning", target=args.username, detail="reset via CLI",
    )
    print(f"Password updated for {args.username}. Any lockout has been cleared.")
    return 0


def cmd_breakglass(args: argparse.Namespace) -> int:
    store, audit = _store()
    existing = store.breakglass_account()
    if existing and existing.codes_remaining and not args.force:
        print(
            f"The break-glass account still has {existing.codes_remaining} unused "
            "code(s). Reissuing invalidates all of them.\n"
            "Pass --force to reissue anyway.",
            file=sys.stderr,
        )
        return 1
    codes = store.create_breakglass()
    audit.record(
        "account.breakglass_issued", os.environ.get("USER", "shell"), "shell",
        "success", severity="critical", target="breakglass",
        detail=f"{len(codes)} recovery codes reissued via CLI",
    )
    _print_codes(codes)
    return 0


def cmd_unlock(args: argparse.Namespace) -> int:
    store, audit = _store()
    if store.get(args.username) is None:
        print(f"No account named {args.username!r}.", file=sys.stderr)
        return 1
    store.unlock(args.username)
    audit.record(
        "account.unlock", os.environ.get("USER", "shell"), "shell", "success",
        severity="warning", target=args.username, detail="unlocked via CLI",
    )
    print(f"Unlocked {args.username}.")
    return 0


def cmd_disable_totp(args: argparse.Namespace) -> int:
    store, audit = _store()
    try:
        store.disable_totp(args.username)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    audit.record(
        "account.totp_disabled", os.environ.get("USER", "shell"), "shell",
        "success", severity="warning", target=args.username,
        detail="TOTP removed via CLI (lost authenticator recovery)",
    )
    print(
        f"TOTP removed for {args.username}. Sign in with the password alone, "
        "then re-enrol a new authenticator."
    )
    return 0


def cmd_list(_: argparse.Namespace) -> int:
    store, _audit = _store()
    accounts = store.list_accounts()
    if not accounts:
        print("No accounts yet. Run: python scripts/admin_bootstrap.py init")
        return 0
    print(f"{'USERNAME':<20} {'ROLE':<12} {'TOTP':<6} {'STATE':<12} CODES")
    for account in accounts:
        state = (
            "disabled"
            if account.disabled
            else ("locked" if account.locked() else "active")
        )
        codes = (
            str(account.codes_remaining) if account.role == "breakglass" else "-"
        )
        print(
            f"{account.username:<20} {account.role:<12} "
            f"{'yes' if account.totp_enrolled else 'no':<6} {state:<12} {codes}"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Manage Streamanator Dashboard admin accounts.",
        epilog="Passwords are never taken as arguments — they would land in "
        "shell history and the process list.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="Create the first admin and break-glass account")
    init.add_argument("--username", help="Admin username (prompted if omitted)")
    init.add_argument("--force", action="store_true", help="Add another admin")
    init.set_defaults(func=cmd_init)

    add = sub.add_parser("add-admin", help="Create an additional admin account")
    add.add_argument("username")
    add.add_argument("--note", default="")
    add.set_defaults(func=cmd_add_admin)

    passwd = sub.add_parser("passwd", help="Set an account password")
    passwd.add_argument("username")
    passwd.set_defaults(func=cmd_passwd)

    bg = sub.add_parser("breakglass", help="Issue a fresh set of recovery codes")
    bg.add_argument("--force", action="store_true", help="Invalidate unused codes")
    bg.set_defaults(func=cmd_breakglass)

    unlock = sub.add_parser("unlock", help="Clear a lockout")
    unlock.add_argument("username")
    unlock.set_defaults(func=cmd_unlock)

    totp = sub.add_parser("disable-totp", help="Remove TOTP from an account")
    totp.add_argument("username")
    totp.set_defaults(func=cmd_disable_totp)

    listing = sub.add_parser("list", help="Show accounts")
    listing.set_defaults(func=cmd_list)

    args = parser.parse_args(argv)
    from auth.accounts import StoreCorruptError, StoreUnreadableError

    try:
        return int(args.func(args))
    except StoreUnreadableError as exc:
        # Access, not content — deleting would discard intact accounts.
        print(f"ERROR: {exc}", file=sys.stderr)
        print(
            "This is a permission fault, not corruption. Do NOT delete the "
            "file: fix its ownership instead, e.g.\n"
            "  sudo chown $(whoami): var var/accounts.json\n"
            "  chmod 700 var && chmod 600 var/accounts.json\n"
            "Running this script under sudo is what usually causes it.",
            file=sys.stderr,
        )
        return 2
    except StoreCorruptError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print(
            "The account store is corrupt. Restore var/accounts.json from a "
            "backup, or delete it and run `init` again.",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
