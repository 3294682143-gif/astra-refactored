"""G8/PR8 — runbook smoke checks for the entry/install documentation.

These verify the *executable* claims documented in `README.md`, `RC-INTEGRATION.md`
and `INSTALL.md`: the public entry contract, and the presence of the documented
install/WASI runbook scripts. They do not assert the non-executable ops prose of
the remaining DOC rows (those stay REVIEW_REQUIRED).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class _Client:
    def chat(self, messages, temperature=0.2, max_tokens=4096, **kwargs):  # noqa: D401
        return {"choices": [{"message": {"content": "2"}, "finish_reason": "stop"}]}


def test_readme_entry_contract():
    from user_agent import ReasoningAgent

    # README: the formal default entry is engine="ts"; lite is explicit-only.
    assert ReasoningAgent(client=_Client()).engine == "ts"
    agent = ReasoningAgent(client=_Client(), engine="lite")
    assert agent.engine == "lite"
    result = agent.solve("Compute 1+1.", {"idx": 0})
    assert isinstance(result, dict)
    # README: solve returns a non-empty final_response, a status, candidate_verified.
    assert isinstance(result["final_response"], str) and result["final_response"] != ""
    assert "status" in result and "candidate_verified" in result
    # README: unknown engines are rejected, not silently ignored.
    try:
        ReasoningAgent(client=_Client(), engine="does-not-exist")
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("unknown engine was not rejected")


def test_rc_integration_public_interface():
    import inspect
    import user_agent

    solve = inspect.signature(user_agent.ReasoningAgent.solve)
    params = list(solve.parameters)
    assert params[0] == "self" and "problem" in params and "metadata" in params


def test_install_runbook_scripts_and_package_present():
    import mathagent

    assert Path(mathagent.__file__).is_file()
    for name in (
        "prepare_target_runtime.py",
        "run_wasi_acceptance.py",
        "accept_wasi_profile.py",
        "activate_wasi_profile.py",
    ):
        assert (ROOT / "scripts" / name).is_file(), name
    # The documented runbook scripts are runnable (help works) with the package importable.
    help_run = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "run_wasi_acceptance.py"), "--help"],
        capture_output=True, text=True, timeout=60,
        env={**__import__("os").environ, "PYTHONPATH": str(ROOT)},
    )
    assert help_run.returncode == 0, help_run.stderr[-500:]
    assert "--profile" in help_run.stdout
