"""The action runner's fail-closed and timeout semantics.

Findings 16 and 19: a privileged command must not run if its start-record
cannot be written, and a client-side timeout must be reported as an *unknown*
outcome rather than a failure — because systemctl and docker frequently accept
the request before the client gives up, and "failed" would invite a dangerous
retry of something that already happened.
"""

from __future__ import annotations

import time

import pytest

from admin import actions as registry
from admin.actions import Action, Risk
from admin.runner import execute
from auth.audit import AuditLog, AuditWriteError


class _FailingAudit(AuditLog):
    """An audit log whose file append always fails."""

    def _append_unlocked(self, entry):  # type: ignore[override]
        raise AuditWriteError("simulated: disk full")


def _safe_echo_action(tmp_path) -> Action:
    """A harmless, always-runnable action for exercising the runner."""
    import sys

    return Action(
        key="test.echo",
        label="Echo",
        group="Server",
        summary="python -c pass",
        explain="A harmless test action that exits zero immediately.",
        argv=(sys.executable, "-c", "print('ok')"),
        risk=Risk.SAFE,
        timeout=30.0,
    )


def test_execution_is_refused_when_the_start_record_cannot_be_written(tmp_path):
    action = _safe_echo_action(tmp_path)
    audit = _FailingAudit(tmp_path / "audit.log")
    result = execute(action, actor="tester", role="admin", audit=audit)
    assert not result.ok
    assert result.returncode == 125
    assert "audit trail" in result.message.lower()


def test_successful_action_runs_and_is_recorded(tmp_path):
    action = _safe_echo_action(tmp_path)
    audit = AuditLog(tmp_path / "audit.log")
    result = execute(action, actor="tester", role="admin", audit=audit)
    assert result.ok
    assert "ok" in result.stdout
    starts = audit.read(actions=["action.start"])
    finishes = audit.read(actions=["action.finish"])
    assert len(starts) == 1 and len(finishes) == 1
    assert finishes[0].outcome == "success"


def test_timeout_is_reported_as_unknown_not_failure(tmp_path):
    import sys

    action = Action(
        key="test.sleep",
        label="Sleep",
        group="Server",
        summary="python -c sleep",
        explain="A test action that sleeps past its timeout so the runner "
        "must kill it and report the outcome honestly.",
        argv=(sys.executable, "-c", "import time; time.sleep(30)"),
        risk=Risk.SAFE,
        timeout=1.0,
    )
    audit = AuditLog(tmp_path / "audit.log")
    started = time.perf_counter()
    result = execute(action, actor="tester", role="admin", audit=audit)
    elapsed = time.perf_counter() - started
    assert not result.ok
    assert result.returncode == 124
    assert "unknown" in result.message.lower()
    # It was actually killed near the timeout, not left to run for 30s.
    assert elapsed < 15
    finishes = audit.read(actions=["action.finish"])
    assert finishes[0].outcome == "unknown"


def test_disabled_actions_are_refused(tmp_path, monkeypatch):
    from admin import runner
    from admin.runner import ActionsDisabled

    monkeypatch.setattr(runner, "actions_enabled", lambda: False)
    action = _safe_echo_action(tmp_path)
    audit = AuditLog(tmp_path / "audit.log")
    with pytest.raises(ActionsDisabled):
        execute(action, actor="tester", role="admin", audit=audit)


def test_registry_docker_restart_uses_option_terminator():
    """The `--` guards against a container name being read as a docker flag."""
    action = registry.find("docker.restart_container")
    assert "--" in action.argv
    assert action.argv.index("--") < action.parameter.index
