"""Capability detection and execution for privileged actions.

Two responsibilities, in this order.

**Find out what is actually possible before offering it.** An admin page that
shows a Reboot button which fails with "sudo: a password is required" is worse
than one that says up front "run this over SSH" and shows the command. So every
action is probed against the live system — does the binary exist, is the unit
installed, is Docker reachable, does sudo permit this exact command — and the
UI renders that verdict instead of guessing.

Permission is answered by asking sudo itself (``sudo -n -l -- cmd args``)
rather than by parsing ``/etc/sudoers``. Sudoers matching involves aliases,
negations, globs and per-host rules; a reimplementation would be wrong in
exactly the cases that matter. sudo already knows the answer.

**Run it, with no shell anywhere.** `subprocess` with a fixed argv, a hard
timeout, and an audit record written whether it succeeds or fails.
"""

from __future__ import annotations

import fnmatch
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from admin.actions import Action
from auth.audit import AuditLog
from utils.cache import ttl_cache
from utils.logging_setup import get_logger

log = get_logger("admin.runner")

#: Where systemd records a scheduled shutdown.
SHUTDOWN_SCHEDULED = Path("/run/systemd/shutdown/scheduled")


@dataclass(frozen=True)
class Capability:
    """Whether an action can run here, right now."""

    ready: bool
    #: Why not, when `ready` is False. Written for someone about to fix it.
    reason: str = ""
    #: True when the only obstacle is a missing sudo grant — the case where
    #: showing the command to run over SSH is the right answer.
    needs_ssh: bool = False
    #: The exact command to paste into an SSH session.
    manual_command: str = ""

    @property
    def state(self) -> str:
        if self.ready:
            return "ready"
        return "ssh" if self.needs_ssh else "blocked"


@dataclass(frozen=True)
class ActionResult:
    ok: bool
    action_key: str
    returncode: int
    stdout: str
    stderr: str
    duration: float
    command: str
    message: str = ""

    @property
    def output(self) -> str:
        parts = [self.stdout.strip(), self.stderr.strip()]
        return "\n".join(p for p in parts if p)


class ActionsDisabled(RuntimeError):
    """Raised when the control surface is switched off by configuration."""


# ---------------------------------------------------------------------------
# Environment probes
# ---------------------------------------------------------------------------


@ttl_cache(seconds=30)
def sudo_available() -> bool:
    return shutil.which("sudo") is not None


@ttl_cache(seconds=30)
def _nopasswd_patterns() -> tuple[str, ...]:
    """Command patterns the current user may run with NOPASSWD.

    Parsed from ``sudo -n -l``, whose listing tags each entry:

        (root) NOPASSWD: /usr/bin/systemctl restart aqualog.service
        (ALL : ALL) ALL

    Only NOPASSWD-tagged entries are collected. The untagged `ALL` above is
    the ordinary "may use sudo with a password" grant, which is exactly the
    case this function exists to exclude.
    """
    if not sudo_available():
        return ()
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["sudo", "-n", "-l"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return ()
    if completed.returncode != 0:
        return ()

    patterns: list[str] = []
    for line in completed.stdout.splitlines():
        _, marker, tail = line.partition("NOPASSWD:")
        if not marker:
            continue
        for entry in tail.split(","):
            command = entry.strip()
            # Strip any further tags on the same entry (SETENV:, LOG_INPUT:).
            while ":" in command.split(" ")[0] and command.split(" ")[0].isupper():
                command = command.split(" ", 1)[1].strip() if " " in command else ""
            if command:
                patterns.append(command)
    return tuple(patterns)


@ttl_cache(seconds=30)
def sudo_allows(argv: tuple[str, ...]) -> tuple[bool, str]:
    """Whether this exact command runs under sudo *without* a password prompt.

    Two independent conditions, both required:

    1. ``sudo -n -l -- cmd`` exits 0 — sudo itself confirms the command is
       permitted. This is the authoritative answer to "is it allowed", and
       asking sudo avoids reimplementing sudoers matching with its aliases,
       negations and per-host rules.

    2. The command matches a NOPASSWD-tagged entry in the listing.

    Condition 1 alone is not enough, and assuming it was is a bug this code
    shipped with. A user holding a plain ``(ALL : ALL) ALL`` grant — the Ubuntu
    default for anyone in the `sudo` group — passes check 1 for *every*
    command, because they genuinely may run it. They just have to type a
    password first, which a background web process cannot do. The console
    would have shown Reboot as ready, and the click would have failed with a
    permission error that looks like a sudoers problem and is not.

    Deliberately conservative: an unparsable listing reads as "needs a
    password". The cost of that error is showing an SSH command that would
    have worked. The cost of the opposite is a button that lies.
    """
    if not sudo_available():
        return False, "sudo is not installed."
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["sudo", "-n", "-l", "--", *argv],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return False, f"Could not query sudo: {exc}"

    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip().splitlines()
        detail = stderr[-1] if stderr else "not permitted by sudoers"
        if "password is required" in detail:
            return False, "sudo would prompt for a password."
        return False, detail[:160]

    if not matches_nopasswd(argv):
        return False, (
            "Permitted by sudoers, but only with a password — which this "
            "service does not have and should not hold."
        )
    return True, "Permitted by sudoers without a password."


def matches_nopasswd(argv: tuple[str, ...]) -> bool:
    """Whether argv matches a NOPASSWD entry. Pure given the parsed patterns."""
    command = " ".join(argv)
    for pattern in _nopasswd_patterns():
        if pattern == "ALL":
            return True
        # sudoers uses shell-style wildcards, which fnmatch implements. The
        # whole command line must match — a prefix match would treat
        # `systemctl restart foo` as covered by a rule for `systemctl`.
        if fnmatch.fnmatchcase(command, pattern):
            return True
    return False


@ttl_cache(seconds=60)
def systemd_unit_exists(unit: str) -> bool:
    """True when systemd knows this unit — loaded, or merely installed."""
    try:
        completed = subprocess.run(  # noqa: S603
            ["systemctl", "list-unit-files", "--no-legend", "--", unit],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    if completed.returncode == 0 and completed.stdout.strip():
        return True
    # A unit can be loaded without a unit *file* (generated, or transient).
    try:
        show = subprocess.run(  # noqa: S603
            ["systemctl", "show", "--property=LoadState", "--value", "--", unit],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    return show.stdout.strip() == "loaded"


@ttl_cache(seconds=60)
def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        completed = subprocess.run(  # noqa: S603
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    return completed.returncode == 0


def pending_shutdown() -> tuple[bool, str]:
    """Whether a reboot or shutdown is scheduled, and when.

    Read straight from systemd's own state file. The dashboard should be able
    to say "a reboot is scheduled for 14:32" on any page, not just the one
    where the button was pressed.
    """
    if not SHUTDOWN_SCHEDULED.is_file():
        return False, ""
    try:
        text = SHUTDOWN_SCHEDULED.read_text(encoding="utf-8")
    except OSError:
        return False, ""
    usec = re.search(r"USEC=(\d+)", text)
    mode = re.search(r"MODE=(\w+)", text)
    if not usec:
        return True, "A shutdown is scheduled."
    when = int(usec.group(1)) / 1_000_000
    label = (mode.group(1) if mode else "shutdown").replace("poweroff", "power off")
    remaining = when - time.time()
    clock = time.strftime("%H:%M:%S", time.localtime(when))
    if remaining > 0:
        return True, f"A {label} is scheduled for {clock} ({int(remaining)}s away)."
    return True, f"A {label} was scheduled for {clock} and is in progress."


def actions_enabled() -> bool:
    """Master switch. Set ADMIN_ACTIONS_ENABLED=false to make the console read-only.

    Read from settings, not `os.environ` — the environment is no longer
    mutated after import (see config.py), so a direct read here would miss an
    admin-console change until restart while the settings object had already
    picked it up. One source of truth.
    """
    from config import get_settings

    return get_settings().auth.actions_enabled


# ---------------------------------------------------------------------------
# Capability checks
# ---------------------------------------------------------------------------


def check_action(action: Action, parameter_value: str | None = None) -> Capability:
    """Can this action run here, now? Never raises."""
    try:
        argv = action.resolved_argv(parameter_value)
    except ValueError as exc:
        return Capability(False, str(exc))

    manual = action.display_command(parameter_value)

    if not actions_enabled():
        return Capability(
            False,
            "Control actions are disabled (ADMIN_ACTIONS_ENABLED=false).",
            needs_ssh=True,
            manual_command=manual,
        )

    binary = argv[0]
    if not Path(binary).exists() and shutil.which(Path(binary).name) is None:
        return Capability(
            False,
            f"{Path(binary).name} is not installed on this host.",
            manual_command=manual,
        )

    if "docker" in Path(binary).name and not docker_available():
        return Capability(
            False,
            "Docker is not reachable. The dashboard account must be in the "
            "`docker` group and the daemon must be running.",
            manual_command=manual,
        )

    if action.cwd and not Path(action.cwd).is_dir():
        return Capability(
            False, f"Directory not found: {action.cwd}", manual_command=manual
        )

    if "systemctl" in Path(binary).name and len(argv) >= 3:
        unit = argv[2]
        if argv[1] in {"restart", "start", "stop", "reload"} and not systemd_unit_exists(
            unit
        ):
            return Capability(
                False,
                f"The unit `{unit}` is not installed on this host.",
                manual_command=manual,
            )

    if action.needs_sudo:
        if action.never_grant:
            return Capability(
                False,
                "This action is SSH-only by design and is never granted to the "
                "dashboard account.",
                needs_ssh=True,
                manual_command=manual,
            )
        allowed, why = sudo_allows(tuple(argv))
        if not allowed:
            return Capability(
                False,
                why,
                needs_ssh=True,
                manual_command=manual,
            )

    return Capability(True, manual_command=manual)


def capability_summary() -> dict[str, int]:
    """Counts of ready / ssh-only / blocked, for the console header."""
    from admin.actions import ACTIONS

    tally = {"ready": 0, "ssh": 0, "blocked": 0}
    for action in ACTIONS:
        # Parameterised actions are checked against their first allowed value,
        # which is representative: the sudo rule and binary are identical.
        value = None
        if action.parameter is not None:
            choices = action.parameter.choices()
            if not choices:
                tally["blocked"] += 1
                continue
            value = choices[0]
        tally[check_action(action, value).state] += 1
    return tally


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


def execute(
    action: Action,
    *,
    actor: str,
    role: str,
    audit: AuditLog,
    parameter_value: str | None = None,
    breakglass: bool = False,
) -> ActionResult:
    """Run an allowlisted action and record it.

    Raises `ActionsDisabled` or `ValueError` before running anything if the
    action is not permitted or the parameter is not in its allowed set. Every
    other outcome — including a non-zero exit — returns a result and is
    audited.

    **The audit trail gates execution.** If the `action.start` record cannot
    be persisted, the command does not run. An audit log that fails open is
    worse than none: it teaches everyone to trust records that stop existing
    exactly when the disk (or an attacker) misbehaves.
    """
    from auth.audit import AuditWriteError

    def _try_record(*args, **kwargs) -> None:
        # For refusal records only: the refusal is already the safe outcome,
        # so a failed audit write must not convert it into a crash.
        try:
            audit.record(*args, **kwargs)
        except AuditWriteError:
            pass

    if not actions_enabled():
        _try_record(
            "action.refused",
            actor,
            role,
            "blocked",
            severity="warning",
            target=action.key,
            detail="Control actions are disabled by configuration.",
            breakglass=breakglass,
        )
        raise ActionsDisabled(
            "Control actions are disabled (ADMIN_ACTIONS_ENABLED=false)."
        )

    # Re-validates the parameter against its closed list. This is the check
    # that matters: it runs immediately before execution, so a value cannot be
    # swapped between the capability probe and the run.
    argv = action.resolved_argv(parameter_value)
    command = action.display_command(parameter_value)

    if action.needs_sudo:
        allowed, why = sudo_allows(tuple(argv))
        if not allowed:
            _try_record(
                "action.refused",
                actor,
                role,
                "blocked",
                severity="warning",
                target=action.key,
                detail=f"sudo refused: {why}",
                breakglass=breakglass,
            )
            return ActionResult(
                ok=False,
                action_key=action.key,
                returncode=126,
                stdout="",
                stderr=why,
                duration=0.0,
                command=command,
                message=(
                    "Not permitted without a password. Run the command over "
                    "SSH instead."
                ),
            )
        argv = ["sudo", "-n", *argv]

    try:
        audit.record(
            "action.start",
            actor,
            role,
            "started",
            severity="warning" if action.risk.value != "safe" else "notice",
            target=action.key,
            detail=command,
            breakglass=breakglass,
        )
    except AuditWriteError as exc:
        return ActionResult(
            ok=False,
            action_key=action.key,
            returncode=125,
            stdout="",
            stderr=str(exc),
            duration=0.0,
            command=command,
            message=(
                "Refused: the audit trail cannot be written, so no privileged "
                "action will run. Check disk space and permissions on the "
                "audit log."
            ),
        )

    started = time.perf_counter()
    outcome_unknown = False
    # No shell, and an explicit minimal environment so nothing from a browser
    # session can influence how the command resolves.
    run_env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": os.environ.get("HOME", "/tmp"),
        "LANG": "C.UTF-8",
    }
    # A new session/process group (POSIX) so a timeout can kill descendants
    # too — `docker compose` and `systemctl` both spawn children, and killing
    # only the direct child would leave them running unobserved.
    popen_extra: dict = {"start_new_session": True} if os.name == "posix" else {}
    try:
        process = subprocess.Popen(  # noqa: S603 - fixed argv from the registry
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=action.cwd,
            env=run_env,
            **popen_extra,
        )
        try:
            stdout, stderr = process.communicate(timeout=action.timeout)
            returncode = process.returncode
            message = ""
        except subprocess.TimeoutExpired as exc:
            if os.name == "posix":
                import signal

                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    process.kill()
            else:  # pragma: no cover - Windows dev boxes
                process.kill()
            try:
                stdout, stderr = process.communicate(timeout=5)
            except Exception:  # noqa: BLE001
                stdout = _to_text(exc.stdout)
                stderr = _to_text(exc.stderr)
            returncode = 124
            outcome_unknown = True
            # The distinction matters operationally: systemctl and docker
            # often *accept* the request before our client gives up, so "it
            # failed" would be a lie that invites a dangerous retry.
            message = (
                f"Timed out after {action.timeout:.0f}s — the outcome is "
                "UNKNOWN, not failed. The service manager may have accepted "
                "the request; re-check the target's state before retrying."
            )
    except OSError as exc:
        returncode, stdout, stderr = 126, "", str(exc)
        message = "Could not start the command."

    duration = time.perf_counter() - started
    ok = returncode == 0

    try:
        audit.record(
            "action.finish",
            actor,
            role,
            "success" if ok else ("unknown" if outcome_unknown else "failure"),
            severity="notice" if ok else "warning",
            target=action.key,
            detail=(
                f"rc={returncode} in {duration:.1f}s"
                + (f" — {_trim(stderr)}" if stderr.strip() and not ok else "")
            ),
            breakglass=breakglass,
        )
    except AuditWriteError:
        # The action already ran; the start record landed. Surface the gap
        # rather than hiding it — journald still has the mirrored line.
        message = (message + " " if message else "") + (
            "(Warning: the finish record could not be written to the audit "
            "file; it exists in journald only.)"
        )

    return ActionResult(
        ok=ok,
        action_key=action.key,
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
        duration=duration,
        command=command,
        message=message or ("Completed." if ok else f"Exited with code {returncode}."),
    )


def _trim(text: str, limit: int = 200) -> str:
    collapsed = " ".join(text.split())
    return collapsed[:limit] + ("…" if len(collapsed) > limit else "")


def _to_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)
