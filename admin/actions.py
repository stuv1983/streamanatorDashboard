"""The allowlist of privileged actions.

The original spec forbade control actions entirely. That has been deliberately
reversed for the admin surface — but the *reason* behind the rule survives in
the shape of this module. §40 still holds: the dashboard is monitoring
software, not a remote shell.

So every action is a **fixed argv tuple declared in source**. Nothing here is
assembled from a text box. The one place a value varies — which container to
restart — takes it from a closed list derived from configuration, validated
before the command is built, and it is still never passed through a shell.
`shell=True` appears nowhere in this package.

Three rules that shaped the registry, each learned the hard way:

**No sudo entry may point at a file the service user can write.** Granting
``arm`` passwordless sudo on a script inside ``/home/arm/projects`` is a
one-line path from the dashboard account to root: rewrite the script, run it.
Actions that would need that are marked ``never_grant`` — they are always
shown as a command to run over SSH and never appear in the sudoers drop-in.

**No wildcards in sudo commands.** ``systemctl restart *`` permits restarting
units that execute arbitrary root code. Every unit is named.

**Destructive actions get a delay and an undo.** The reboot is scheduled a
minute out rather than fired instantly, so the cancel button is a real option
and not a race.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable

from config import EXPECTED_CONTAINERS, PROJECT_ROOT, get_settings

COMPOSE_DIR = PROJECT_ROOT / "deploy" / "monitoring-stack"

#: The oneshot unit that runs `apt-get update && apt-get upgrade`. Fixed in
#: source, never read from configuration: `.env` is writable by the dashboard
#: account, so a unit name that came from there would turn "can edit .env" into
#: "can start any unit as root" the moment the sudoers rule is installed.
#:
#: Why a unit at all, rather than granting sudo on apt-get directly:
#:
#: * A NOPASSWD grant on `apt-get upgrade` runs maintainer scripts as root, and
#:   is the broadest thing this registry could possibly hand out. The grant
#:   below is for one named unit whose ExecStart lives in /usr and whose unit
#:   file lives in /etc — neither writable by the dashboard account.
#: * An upgrade routinely outruns any timeout it would be sane to hold a web
#:   request open for, and `execute()` reports a timeout as "outcome UNKNOWN".
#:   For a package upgrade that is the worst possible answer. Started with
#:   `--no-block`, the unit outlives the dashboard, survives a restart of it,
#:   and reports progress through systemd rather than through a held pipe.
#: * dpkg conffile prompts hang forever without DEBIAN_FRONTEND=noninteractive,
#:   which the runner's minimal environment would strip. The unit file sets it.
APT_UPGRADE_UNIT = "streamanator-apt-upgrade.service"

#: The oneshot unit that runs the Sports Data Lab backup script on demand.
#: Fixed in source for the same reason as APT_UPGRADE_UNIT above: the script
#: it wraps (/usr/local/sbin/sports-data-backup.sh) already runs unattended
#: from the root crontab, and a `systemctl start --no-block` on one named
#: unit outlives the web request that started it — the backup routinely
#: takes minutes to read and compress a multi-gigabyte archive.
SPORTS_BACKUP_UNIT = "streamanator-sports-backup.service"


class Risk(str, Enum):
    """How much a mistake costs."""

    SAFE = "safe"
    #: Interrupts a service. Recoverable in seconds to minutes.
    DISRUPTIVE = "disruptive"
    #: Interrupts everything, or cannot be undone by clicking again.
    DESTRUCTIVE = "destructive"

    @property
    def label(self) -> str:
        return {
            Risk.SAFE: "Safe",
            Risk.DISRUPTIVE: "Disruptive",
            Risk.DESTRUCTIVE: "Destructive",
        }[self]

    @property
    def icon(self) -> str:
        return {
            Risk.SAFE: ":material/check_circle:",
            Risk.DISRUPTIVE: ":material/warning:",
            Risk.DESTRUCTIVE: ":material/dangerous:",
        }[self]


#: Grammar for any substituted value: starts alphanumeric (so it can never be
#: mistaken for an option), then Docker-name characters. The allowlist below
#: is the real control; this is the belt to its braces, and it means a future
#: allowlist source that accidentally yields "-rm" still cannot pass.
_PARAM_GRAMMAR = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


@dataclass(frozen=True)
class Parameter:
    """A closed set of substitutable values. Never free text."""

    label: str
    #: Index in `argv` to replace. Must point at the literal "{param}" slot.
    index: int
    choices: Callable[[], list[str]]
    help: str = ""

    def validate(self, value: str) -> str:
        if not _PARAM_GRAMMAR.fullmatch(value or ""):
            raise ValueError(
                f"{value!r} is not a valid {self.label} name."
            )
        allowed = self.choices()
        if value not in allowed:
            raise ValueError(
                f"{value!r} is not in the allowed list for {self.label}. "
                "Actions only accept values declared in configuration."
            )
        return value


@dataclass(frozen=True)
class Action:
    key: str
    label: str
    group: str
    summary: str
    #: Exactly what will happen, in plain language. Shown before confirming —
    #: a button labelled "Restart" that also drops six other containers is a
    #: trap, and this field is where that gets said.
    explain: str
    argv: tuple[str, ...]
    risk: Risk
    needs_sudo: bool = False
    #: Require password re-entry immediately before running, regardless of how
    #: fresh the session is. The sudo timestamp model.
    needs_step_up: bool = False
    #: Typed confirmation for the actions that cannot be taken back.
    confirm_phrase: str | None = None
    timeout: float = 30.0
    parameter: Parameter | None = None
    #: Key of the action that reverses this one, surfaced right after running.
    undo_key: str | None = None
    #: Alternative binary locations, tried in order when argv[0] is missing.
    binary_candidates: tuple[str, ...] = ()
    #: Working directory. Only ever a path from configuration.
    cwd: str | None = None
    #: True for actions that must never be granted passwordless sudo, because
    #: doing so would create a privilege-escalation path. Always SSH-only.
    never_grant: bool = False
    #: Why this action exists, for the page and for whoever reads it later.
    rationale: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)

    def resolved_argv(self, parameter_value: str | None = None) -> list[str]:
        """The final argv, with the binary resolved and any parameter checked."""
        args = list(self.argv)
        if self.parameter is not None:
            if parameter_value is None:
                raise ValueError(f"{self.key} requires a {self.parameter.label}.")
            args[self.parameter.index] = self.parameter.validate(parameter_value)
        elif parameter_value is not None:
            raise ValueError(f"{self.key} does not take a parameter.")
        args[0] = self._resolve_binary(args[0])
        return args

    def _resolve_binary(self, name: str) -> str:
        """Resolve among declared absolute paths only.

        Deliberately no `shutil.which()` fallback: PATH resolution would let a
        user-writable PATH entry shadow the intended binary, quietly undoing
        the registry's absolute-path guarantee. If none of the declared
        locations exist, the unresolved name is returned and the capability
        check reports the action as unavailable — the honest answer.
        """
        if Path(name).exists():
            return name
        for candidate in self.binary_candidates:
            if Path(candidate).exists():
                return candidate
        return name

    def display_command(self, parameter_value: str | None = None) -> str:
        """The command as a human would type it over SSH."""
        try:
            args = self.resolved_argv(parameter_value)
        except ValueError:
            args = list(self.argv)
        prefix = ["sudo"] if self.needs_sudo else []
        return " ".join(_shell_quote(a) for a in prefix + args)

    @property
    def sudo_rule(self) -> str | None:
        """The sudoers `Cmnd` form for this action, or None if not grantable."""
        if not self.needs_sudo or self.never_grant or self.parameter is not None:
            return None
        return " ".join(self.argv)


def _shell_quote(value: str) -> str:
    """Quote for display only — nothing here is ever handed to a shell."""
    import re

    return value if re.fullmatch(r"[\w@%+=:,./-]+", value) else f"'{value}'"


# ---------------------------------------------------------------------------
# Parameter sources
# ---------------------------------------------------------------------------


def _restartable_containers() -> list[str]:
    """Containers declared in configuration, so no arbitrary name can be passed.

    Reading from `docker ps` instead would let anything currently running be
    restarted — including containers this dashboard knows nothing about.
    """
    return sorted(c.name for c in EXPECTED_CONTAINERS)


# ---------------------------------------------------------------------------
# Units this dashboard is permitted to control
# ---------------------------------------------------------------------------

#: Each unit is named explicitly. A `systemctl restart *` sudo rule would allow
#: restarting units whose ExecStart is arbitrary root code.
MANAGED_UNITS: tuple[tuple[str, str, str], ...] = (
    (
        "streamanator-dashboard",
        "Dashboard",
        "Restarts this dashboard. Your browser will lose its connection for "
        "a few seconds and you will be signed out of the admin session.",
    ),
    (
        "backup-nightly.service",
        "Nightly backup",
        "Re-runs the nightly backup job now. Safe to run at any time; it does "
        "not delete previous backups.",
    ),
    (
        "sports-data-lab.service",
        "Sports Data Lab",
        "Restarts Sports Data Lab on port 6969. Any open session in that app "
        "reloads. Databases are untouched.",
    ),
    (
        "aqualog.service",
        "AquaLog",
        "Restarts AquaLog on port 8501. Any open session in that app reloads; "
        "its data is untouched.",
    ),
    (
        "plexmediaserver.service",
        "Plex",
        "Restarts Plex. Active playback stops and clients reconnect.",
    ),
)

_SYSTEMCTL = "/usr/bin/systemctl"
_SYSTEMCTL_ALTS = ("/bin/systemctl", "/usr/sbin/systemctl")
_SHUTDOWN = "/usr/sbin/shutdown"
_SHUTDOWN_ALTS = ("/sbin/shutdown", "/usr/bin/shutdown")
_DOCKER = "/usr/bin/docker"
_DOCKER_ALTS = ("/usr/local/bin/docker", "/bin/docker")

#: Minutes of warning before a scheduled reboot. Non-zero on purpose: it turns
#: "cancel the reboot" from a race into a decision.
REBOOT_DELAY_MINUTES = 1


def _unit_actions() -> list[Action]:
    actions: list[Action] = []
    for unit, label, explain in MANAGED_UNITS:
        base = unit.removesuffix(".service")
        actions.append(
            Action(
                key=f"service.restart.{base}",
                label=f"Restart {label}",
                group="Services",
                summary=f"systemctl restart {unit}",
                explain=explain,
                argv=(_SYSTEMCTL, "restart", unit),
                binary_candidates=_SYSTEMCTL_ALTS,
                risk=Risk.DISRUPTIVE,
                needs_sudo=True,
                needs_step_up=base != "backup-nightly",
                timeout=90.0,
                rationale=(
                    "Named explicitly rather than accepting a unit name, so no "
                    "other unit can be reached through this control."
                ),
                tags=("systemd",),
            )
        )
    return actions


ACTIONS: tuple[Action, ...] = (
    # -- Server ------------------------------------------------------------
    Action(
        key="server.reboot",
        label="Reboot the server",
        group="Server",
        summary=f"shutdown -r +{REBOOT_DELAY_MINUTES}",
        explain=(
            f"Schedules a reboot in {REBOOT_DELAY_MINUTES} minute. Everything "
            "stops: Plex, the media stack, the VPN, Immich, Sports Data Lab, "
            "AquaLog and this dashboard. The RAID array reassembles on boot — "
            "if a member is already marked non-fresh, a reboot is when that "
            "becomes visible as a degraded array. Cancel with the button that "
            "appears next, any time before the minute is up."
        ),
        argv=(_SHUTDOWN, "-r", f"+{REBOOT_DELAY_MINUTES}"),
        binary_candidates=_SHUTDOWN_ALTS,
        risk=Risk.DESTRUCTIVE,
        needs_sudo=True,
        needs_step_up=True,
        confirm_phrase="REBOOT streamanator",
        timeout=20.0,
        undo_key="server.cancel_shutdown",
        rationale=(
            "Delayed rather than immediate so the cancel path is usable, and "
            "so an accidental click is recoverable."
        ),
        tags=("reboot",),
    ),
    Action(
        key="server.cancel_shutdown",
        label="Cancel pending reboot",
        group="Server",
        summary="shutdown -c",
        explain="Cancels a scheduled reboot or shutdown. Does nothing if none is pending.",
        argv=(_SHUTDOWN, "-c"),
        binary_candidates=_SHUTDOWN_ALTS,
        risk=Risk.SAFE,
        needs_sudo=True,
        timeout=20.0,
        tags=("reboot",),
    ),
    Action(
        key="server.reset_failed",
        label="Clear failed-unit state",
        group="Server",
        summary="systemctl reset-failed",
        explain=(
            "Clears systemd's record of failed units. Does not fix the "
            "underlying failure and does not restart anything — it resets the "
            "flag so a genuinely new failure stands out. Useful after fixing "
            "the cause of a stale failure such as the nightly backup lock."
        ),
        argv=(_SYSTEMCTL, "reset-failed"),
        binary_candidates=_SYSTEMCTL_ALTS,
        risk=Risk.SAFE,
        needs_sudo=True,
        timeout=20.0,
        tags=("systemd",),
    ),
    *_unit_actions(),
    Action(
        key="backup.run_sports_data_lab",
        label="Run Sports Data Lab backup now",
        group="Services",
        summary=f"systemctl start --no-block {SPORTS_BACKUP_UNIT}",
        explain=(
            "Runs the Sports Data Lab backup script now, outside its Wed/Sun "
            "23:00 schedule. It reads the live database and writes a new "
            "archive under the backup directory; existing archives are not "
            "touched or deleted, and the running Sports Data Lab app is not "
            "restarted or interrupted.\n\n"
            "The unit is started, not waited for: it keeps running if you "
            "close this tab or restart the dashboard. Check the Backups page "
            "for the new archive once it completes, or follow progress with "
            "`journalctl -fu " + SPORTS_BACKUP_UNIT + "`."
        ),
        argv=(_SYSTEMCTL, "start", "--no-block", SPORTS_BACKUP_UNIT),
        binary_candidates=_SYSTEMCTL_ALTS,
        risk=Risk.SAFE,
        needs_sudo=True,
        timeout=30.0,
        rationale=(
            "One named unit rather than a sudo grant on the backup script "
            "itself, for the same reason as server.apt_upgrade: the unit "
            "file is root-owned in /etc/systemd/system, so the dashboard "
            "account cannot rewrite what it starts."
        ),
        tags=("backups", "systemd"),
    ),
    # -- Docker ------------------------------------------------------------
    Action(
        key="docker.restart_container",
        label="Restart a container",
        group="Docker",
        summary="docker restart <container>",
        explain=(
            "Restarts one container from the expected-container list. If you "
            "pick the Gluetun container, every service sharing its network "
            "namespace — SABnzbd, Sonarr, Radarr, Prowlarr, qBittorrent — "
            "loses connectivity until the tunnel is back up."
        ),
        # `--` terminates option parsing, so even a hypothetical name starting
        # with "-" would be read as a container, never as a docker flag. The
        # grammar check in Parameter.validate forbids such names anyway;
        # defence in depth costs two characters here.
        argv=(_DOCKER, "restart", "--", "{param}"),
        binary_candidates=_DOCKER_ALTS,
        risk=Risk.DISRUPTIVE,
        needs_step_up=True,
        timeout=120.0,
        parameter=Parameter(
            label="container",
            index=3,
            choices=_restartable_containers,
            help="Only containers declared in the dashboard's configuration.",
        ),
        rationale=(
            "The `arm` account is already in the docker group, so this needs "
            "no sudo. The name is validated against configuration rather than "
            "against `docker ps`, so unknown containers stay out of reach."
        ),
        tags=("docker",),
    ),
    # -- SMART -------------------------------------------------------------
    Action(
        key="smart.deploy_exporter",
        label="Deploy smartctl exporter",
        group="Disk health",
        summary="docker compose up -d smartctl-exporter",
        explain=(
            "Starts the smartctl_exporter container, which reads SMART data "
            "with privilege confined to that container. This is the preferred "
            "way to unblock disk health: it needs no sudo grant for the "
            "dashboard account, and it gives Prometheus a CRC history for "
            "WPV2E6LL rather than a single instantaneous reading."
        ),
        argv=(_DOCKER, "compose", "up", "-d", "smartctl-exporter"),
        binary_candidates=_DOCKER_ALTS,
        risk=Risk.SAFE,
        timeout=180.0,
        cwd=str(COMPOSE_DIR),
        rationale="Container-confined privilege beats a sudo grant.",
        tags=("smart", "monitoring"),
    ),
    Action(
        key="smart.install_sudoers",
        label="Install the SMART sudoers rule",
        group="Disk health",
        summary="install -m 0440 deploy/sudoers-smartctl /etc/sudoers.d/…",
        explain=(
            "Grants the dashboard account passwordless sudo for exactly two "
            "read-only smartctl invocations. Use this only if you are not "
            "deploying the exporter."
        ),
        argv=(
            "/usr/bin/install",
            "-m",
            "0440",
            "-o",
            "root",
            "-g",
            "root",
            str(PROJECT_ROOT / "deploy" / "sudoers-smartctl"),
            "/etc/sudoers.d/streamanator-dashboard-smartctl",
        ),
        risk=Risk.DISRUPTIVE,
        needs_sudo=True,
        never_grant=True,
        timeout=20.0,
        rationale=(
            "SSH-only, permanently. The source file lives in a directory the "
            "dashboard account can write, so a sudo grant to install it would "
            "be a direct path from this account to root — rewrite the file, "
            "then ask the dashboard to install it. Run it yourself, and run "
            "`sudo visudo -c` afterwards before closing the session."
        ),
        tags=("smart", "ssh-only"),
    ),
    # -- Monitoring stack --------------------------------------------------
    Action(
        key="monitoring.up",
        label="Start the monitoring stack",
        group="Monitoring",
        summary="docker compose up -d",
        explain=(
            "Starts Prometheus, node-exporter, cAdvisor, smartctl-exporter, "
            "blackbox-exporter and Grafana. All bind to 127.0.0.1 only. "
            "Requires GRAFANA_ADMIN_PASSWORD to be set in "
            "deploy/monitoring-stack/.env first — compose refuses to start "
            "without it, by design."
        ),
        argv=(_DOCKER, "compose", "up", "-d"),
        binary_candidates=_DOCKER_ALTS,
        risk=Risk.DISRUPTIVE,
        timeout=300.0,
        cwd=str(COMPOSE_DIR),
        undo_key="monitoring.down",
        tags=("monitoring",),
    ),
    Action(
        key="monitoring.down",
        label="Stop the monitoring stack",
        group="Monitoring",
        summary="docker compose down",
        explain=(
            "Stops the monitoring containers. Named volumes survive, so "
            "Prometheus history and Grafana dashboards are not lost. The "
            "dashboard falls back to its local SQLite history."
        ),
        argv=(_DOCKER, "compose", "down"),
        binary_candidates=_DOCKER_ALTS,
        risk=Risk.DISRUPTIVE,
        timeout=180.0,
        cwd=str(COMPOSE_DIR),
        tags=("monitoring",),
    ),
    # -- Updates -----------------------------------------------------------
    Action(
        key="server.apt_upgrade",
        label="Install Ubuntu updates",
        group="Updates",
        summary=f"systemctl start --no-block {APT_UPGRADE_UNIT}",
        explain=(
            "Starts a systemd unit that runs `apt-get update` followed by "
            "`apt-get upgrade`. Packages are upgraded in place; nothing is "
            "removed and nothing new is installed, so a held-back package "
            "stays held back rather than dragging in a transition. Services "
            "whose packages change are restarted by their own maintainer "
            "scripts — Plex among them, which stops playback. A kernel update "
            "will not take effect until you reboot, and the page will say so.\n\n"
            "The unit is started, not waited for: it keeps running if you "
            "close this tab or restart the dashboard. Watch its progress "
            "below, or with `journalctl -fu " + APT_UPGRADE_UNIT + "`."
        ),
        argv=(_SYSTEMCTL, "start", "--no-block", APT_UPGRADE_UNIT),
        binary_candidates=_SYSTEMCTL_ALTS,
        risk=Risk.DISRUPTIVE,
        needs_sudo=True,
        needs_step_up=True,
        timeout=30.0,
        rationale=(
            "One named unit rather than a sudo grant on apt-get. The unit file "
            "is root-owned in /etc/systemd/system, so the dashboard account "
            "cannot rewrite what it starts."
        ),
        tags=("updates", "apt", "systemd"),
    ),
    Action(
        key="docker.prune_images",
        label="Remove unused container images",
        group="Updates",
        summary="docker image prune -f",
        explain=(
            "Deletes images no container references and no tag points at — the "
            "layers left behind after an image update. This is how the disk "
            "gets its space back after a stack update.\n\n"
            "It also deletes the version you just upgraded away from, so "
            "rolling back afterwards means pulling that tag again from the "
            "registry. Run it once the new images have proved themselves, not "
            "immediately after updating."
        ),
        argv=(_DOCKER, "image", "prune", "-f"),
        binary_candidates=_DOCKER_ALTS,
        risk=Risk.DISRUPTIVE,
        needs_step_up=True,
        timeout=180.0,
        rationale=(
            "Dangling images only — no `-a`, which would also remove images "
            "that are tagged but not currently running."
        ),
        tags=("updates", "docker"),
    ),
    Action(
        key="probes.restart_blackbox",
        label="Restart the probe exporter",
        group="Monitoring",
        summary="docker compose up -d --force-recreate blackbox-exporter",
        explain=(
            "Recreates the blackbox exporter so an edited blackbox.yml takes "
            "effect. Probe results gap for a few seconds."
        ),
        argv=(
            _DOCKER,
            "compose",
            "up",
            "-d",
            "--force-recreate",
            "blackbox-exporter",
        ),
        binary_candidates=_DOCKER_ALTS,
        risk=Risk.SAFE,
        timeout=120.0,
        cwd=str(COMPOSE_DIR),
        tags=("monitoring", "probes"),
    ),
)


def stack_actions() -> list[Action]:
    """One "pull and recreate" action per *configured* Compose stack.

    Built per call rather than frozen into `ACTIONS`, because a stack
    directory set in the admin console must take effect on the next
    `reload_settings()` and not at the next process restart.

    Unconfigured stacks yield no action at all. An action whose `cwd` is the
    empty string would run `docker compose` in whatever directory the
    dashboard happened to be started from, which on this host is the project
    root — where a `deploy/monitoring-stack` sibling makes that mistake look
    like it worked.

    `--pull always` is what makes this an update rather than a restart, and it
    keeps the whole thing a single argv: `pull && up -d` would need a shell,
    and `shell=True` appears nowhere in this package.
    """
    built: list[Action] = []
    for stack in get_settings().stacks:
        if not stack.configured:
            continue
        built.append(
            Action(
                key=f"docker.update_stack.{stack.key}",
                label=f"Update {stack.display}",
                group="Updates",
                summary="docker compose up -d --pull always",
                explain=stack.explain,
                argv=(_DOCKER, "compose", "up", "-d", "--pull", "always"),
                binary_candidates=_DOCKER_ALTS,
                risk=Risk.DISRUPTIVE,
                needs_step_up=True,
                # Pulling several hundred megabytes over a domestic connection
                # is routinely slower than the 300s the monitoring stack gets.
                timeout=900.0,
                cwd=stack.directory,
                rationale=(
                    "Runs in the directory named by "
                    f"`{stack.env_var}`, never in a path discovered from "
                    "container labels. A compose file is an "
                    "arbitrary-code-execution format, so where it is read from "
                    "is a configuration decision, not a discovery one."
                ),
                tags=("updates", "docker", "compose"),
            )
        )
    return built


def all_actions() -> tuple[Action, ...]:
    """The static registry plus the actions derived from current settings.

    Every consumer goes through here. `ACTIONS` remains the source-declared
    core, and `tests/test_admin_actions.py` applies its invariants to this
    combined list so a dynamically built action cannot dodge them.
    """
    return ACTIONS + tuple(stack_actions())


def find(key: str) -> Action | None:
    return next((a for a in all_actions() if a.key == key), None)


def by_group() -> dict[str, list[Action]]:
    groups: dict[str, list[Action]] = {}
    for action in all_actions():
        groups.setdefault(action.group, []).append(action)
    order = ["Server", "Services", "Docker", "Updates", "Disk health", "Monitoring"]
    return {name: groups[name] for name in order if name in groups} | {
        name: items for name, items in groups.items() if name not in order
    }


def grantable_sudo_rules() -> list[str]:
    """Every sudoers command string the registry expects to be granted.

    `tests/test_admin_actions.py` asserts the shipped sudoers drop-in matches
    this list exactly, so the file and the code cannot drift apart — a stale
    sudoers file is either a broken button or an over-broad grant, and both
    are silent.

    Reads `ACTIONS` alone, deliberately. The stack actions need no sudo, and a
    sudoers file that varied with a host's `.env` could not be checked against
    the source at all.
    """
    rules = {a.sudo_rule for a in ACTIONS if a.sudo_rule}
    return sorted(rules)
