"""Stage D — the Host-side WASI generated-Python bridge, fail-closed by default.

Three layers are covered:

* the default path: ``AgentRuntime`` / ``AgentHost`` hold ``python_sandbox is
  None`` and open no file at all, and ``GenerativeExecutionGate`` still answers
  ``REFUSED_NO_PROFILE`` for a generated-exploration request;
* the injected path: an admitted gate plus a usable stub sandbox reaches
  ``execute_with_gate`` and yields a ``BOUNDED_OBSERVATION`` tagged
  ``BOUNDED_OBSERVATION_NOT_PROOF`` with ``deadline`` / ``problem_id`` / ``scope``
  passed through unchanged;
* the refusal path: a denying gate never calls ``sandbox.execute``, and a
  raising, timing-out or unavailable sandbox yields a fixed refusal instead of a
  traceback or invented output.

No WASI runtime, no Wasmtime and no provider access is needed: every assertion is
about the bridge's decision and refusal discipline.
"""

from __future__ import annotations

import builtins
import hashlib
import io
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from python.astra_bridge import agent_host as host_module
from python.astra_bridge import agent_runtime
from python.astra_bridge import generated_execution_gate as gate_module
from python.astra_bridge.agent_client import AgentClient
from python.astra_bridge.agent_protocol import load_manifest
from python.astra_bridge.generated_execution_gate import (
    BOUNDED_OBSERVATION_NOTE,
    EXECUTION_REFUSALS,
    ExecutionRequest,
    GenerativeExecutionGate,
    execute_with_gate,
)

PROBLEM = "Find the smallest n > 1 with exactly five divisors."
PROBLEM_HASH = hashlib.sha256(PROBLEM.encode("utf-8")).hexdigest()
CODE = "print(sum(i for i in range(10)))"
CODE_SHA = hashlib.sha256(CODE.encode("utf-8")).hexdigest()
APPROVED = {
    "profile_id": "wasi-accepted-v1",
    "code_sha256": CODE_SHA,
    "max_seconds": 5,
    "max_bytes": 4096,
}


# -- fixtures / helpers ---------------------------------------------------


def _chat_client():
    """A public client that answers without any provider access."""

    def chat(messages, temperature=0.2, max_tokens=8192):
        return {"status": "COMPLETE", "text": "ok"}

    return SimpleNamespace(chat=chat)


def _agent_client():
    return AgentClient(_chat_client())


def _host_options():
    return {
        "maxModelCalls": 4,
        "maxWorkUnits": 1,
        "maxEffects": 1,
        "maxReviews": 0,
        "maxMethodLoads": 0,
        "maxRepairs": 0,
        "maxConsensus": 0,
        "maxR0": 0,
        "policy": "BEST_EFFORT",
        "deriveBudget": True,
        "resumeSessionLog": None,
        "resumeContractVersion": None,
        "resumeHistory": None,
    }


def _host(**kwargs):
    manifest = load_manifest()
    return host_module.AgentHost(
        manifest, "sess-wasi", time.monotonic() + 60.0, PROBLEM, PROBLEM_HASH,
        _host_options(), _agent_client(), **kwargs,
    )


def _execution_request(**over):
    base = {
        "profile_id": "wasi-accepted-v1",
        "code_sha256": CODE_SHA,
        "max_seconds": 5,
        "max_bytes": 4096,
    }
    base.update(over)
    return ExecutionRequest(**base)


class StubSandbox:
    """A deterministic stand-in for ``mathagent.tools.PythonSandbox``."""

    available = True
    identity = "stub-identity"
    reason = "stub"

    def __init__(self, *, status="ok", result=None, error=None, available=True):
        self.available = available
        self.status = status
        self.payload = {"output": "45\n", "truncated": False} if result is None else result
        self.error = error
        self.calls = []

    def execute(self, code, *, deadline, problem_id, scope="bounded generated exploration"):
        self.calls.append(
            {"code": code, "deadline": deadline, "problem_id": problem_id, "scope": scope}
        )
        if self.error is not None:
            raise self.error
        return SimpleNamespace(
            status=self.status,
            tool="generated_python",
            result=self.payload,
            evidence_kind="BOUNDED_OBSERVATION" if self.status == "ok" else "NONE",
            declared_scope=scope,
            detail="WASI execution is not a proof.",
        )


def _no_io_spy(monkeypatch):
    """Fail loudly if the default path opens or reads anything."""
    events = []

    def guard(name, real):
        def spy(*args, **kwargs):
            events.append(name)
            return real(*args, **kwargs)

        return spy

    real_read_bytes = Path.read_bytes
    real_read_text = Path.read_text
    real_open = builtins.open
    real_io_open = io.open
    monkeypatch.setattr(Path, "read_bytes", guard("Path.read_bytes", real_read_bytes))
    monkeypatch.setattr(Path, "read_text", guard("Path.read_text", real_read_text))
    monkeypatch.setattr(builtins, "open", guard("open", real_open))
    monkeypatch.setattr(io, "open", guard("io.open", real_io_open))
    return events


# -- default path ---------------------------------------------------------


def test_default_runtime_and_host_hold_no_sandbox_and_read_no_file(monkeypatch):
    monkeypatch.delenv(host_module.WASI_PROFILE_ENV, raising=False)
    # The manifest is read before the spy is installed: the subject is the
    # runtime/host constructors themselves, not the preexisting loader.
    manifest = load_manifest()
    events = _no_io_spy(monkeypatch)

    runtime = agent_runtime.AgentRuntime(_chat_client())
    host = host_module.AgentHost(
        manifest, "sess-wasi", time.monotonic() + 60.0, PROBLEM, PROBLEM_HASH,
        _host_options(), _agent_client(),
    )

    assert runtime.python_sandbox is None
    assert runtime.python_sandbox_identity is None
    assert runtime.python_sandbox_diagnostic is None
    assert runtime.python_sandbox_profile is None
    assert host.python_sandbox is None
    assert host.python_sandbox_identity is None
    assert host.python_sandbox_diagnostic is None
    assert events == []


def test_empty_profile_environment_variable_is_still_the_default_path(monkeypatch):
    monkeypatch.setenv(host_module.WASI_PROFILE_ENV, "")
    runtime = agent_runtime.AgentRuntime(_chat_client())
    assert runtime.python_sandbox is None
    assert runtime.python_sandbox_profile is None


def test_default_gate_and_default_sandbox_refuse_generated_exploration():
    gate = GenerativeExecutionGate()
    assert gate.decision(_execution_request()) == "REFUSED_NO_PROFILE"

    refused = execute_with_gate(
        gate, None, _execution_request(), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert refused == {"admitted": False, "reason": "REFUSED_NO_PROFILE", "result": None}

    # Even a *usable* sandbox is never asked to execute for a denying gate.
    sandbox = StubSandbox()
    refused = execute_with_gate(
        gate, sandbox, _execution_request(), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert refused["admitted"] is False
    assert refused["reason"] == "REFUSED_NO_PROFILE"
    assert refused["result"] is None
    assert sandbox.calls == []


def test_default_host_seam_refuses_without_a_profile():
    host = _host()
    assert host.python_sandbox is None
    result = host.generated_exploration(
        _execution_request(), CODE, gate=GenerativeExecutionGate(APPROVED)
    )
    assert result == {"admitted": False, "reason": "REFUSED_NO_PROFILE", "result": None}


# -- injected path --------------------------------------------------------


def test_admitted_execution_returns_a_bounded_observation():
    sandbox = StubSandbox()
    deadline = time.monotonic() + 5.0
    outcome = execute_with_gate(
        GenerativeExecutionGate(APPROVED), sandbox, _execution_request(), CODE,
        deadline=deadline, problem_id="sess-wasi", scope="bounded generated exploration",
    )

    assert outcome["admitted"] is True
    assert outcome["reason"] == "ADMITTED"
    payload = outcome["result"]
    assert payload["kind"] == "BOUNDED_OBSERVATION"
    assert payload["interpretation"] == "BOUNDED_OBSERVATION_NOT_PROOF"
    assert payload["interpretation"] == BOUNDED_OBSERVATION_NOTE
    assert payload["tool"] == "generated_python"
    assert payload["status"] == "ok"
    assert payload["output"] == {"output": "45\n", "truncated": False}
    assert payload["problemId"] == "sess-wasi"
    assert payload["scope"] == "bounded generated exploration"

    # deadline / problem_id / scope reach the sandbox verbatim, and exactly once.
    assert sandbox.calls == [
        {
            "code": CODE,
            "deadline": deadline,
            "problem_id": "sess-wasi",
            "scope": "bounded generated exploration",
        }
    ]


def test_host_seam_with_an_injected_stub_sandbox_admits_one_bounded_run():
    host = _host()
    sandbox = StubSandbox()
    # The seam uses the host's own sandbox and its own root deadline.
    host.python_sandbox = sandbox
    host.python_sandbox_identity = sandbox.identity

    outcome = host.generated_exploration(
        _execution_request(), CODE, gate=GenerativeExecutionGate(APPROVED)
    )

    assert outcome["admitted"] is True
    assert outcome["result"]["interpretation"] == "BOUNDED_OBSERVATION_NOT_PROOF"
    assert len(sandbox.calls) == 1
    assert sandbox.calls[0]["deadline"] == host.deadline
    assert sandbox.calls[0]["problem_id"] == host.session_id


def test_a_profile_argument_binds_a_sandbox_and_degrades_without_a_runtime(tmp_path):
    # An existing file that is not an accepted WASI profile: constructing the
    # sandbox must not raise, and both Host and Runtime must degrade to
    # ``python_sandbox is None`` with one fixed diagnostic code.
    profile = tmp_path / "profile.json"
    profile.write_text('{"schema":"not-astra-wasi-v1"}', encoding="utf-8")

    runtime = agent_runtime.AgentRuntime(_chat_client(), python_sandbox_profile=str(profile))
    assert runtime.python_sandbox is None
    assert runtime.python_sandbox_identity is None
    assert runtime.python_sandbox_diagnostic == "WASI_SANDBOX_UNAVAILABLE"
    # A profile always wins over the environment, never the other way round.
    assert runtime.python_sandbox_profile == str(profile)

    host = _host(python_sandbox_profile=str(profile))
    assert host.python_sandbox is None
    assert host.python_sandbox_identity is None
    assert host.python_sandbox_diagnostic == "WASI_SANDBOX_UNAVAILABLE"
    # No usable sandbox means the seam refuses, not even with an admitting gate.
    outcome = host.generated_exploration(
        _execution_request(), CODE, gate=GenerativeExecutionGate(APPROVED)
    )
    assert outcome == {"admitted": False, "reason": "REFUSED_NO_PROFILE", "result": None}


def test_the_environment_profile_is_honoured_when_no_argument_is_given(monkeypatch, tmp_path):
    profile = tmp_path / "profile.json"
    profile.write_text('{"schema":"not-astra-wasi-v1"}', encoding="utf-8")
    monkeypatch.setenv(host_module.WASI_PROFILE_ENV, str(profile))

    runtime = agent_runtime.AgentRuntime(_chat_client())
    assert runtime.python_sandbox_profile == str(profile)
    # The unaccepted profile is read exactly once and then degrades closed.
    assert runtime.python_sandbox is None
    assert runtime.python_sandbox_diagnostic == "WASI_SANDBOX_UNAVAILABLE"


def test_a_missing_profile_file_degrades_to_no_sandbox(tmp_path):
    missing = tmp_path / "absent.json"
    runtime = agent_runtime.AgentRuntime(_chat_client(), python_sandbox_profile=str(missing))
    assert runtime.python_sandbox is None
    assert runtime.python_sandbox_identity is None
    assert runtime.python_sandbox_diagnostic == "WASI_SANDBOX_UNAVAILABLE"


# -- refusal path ---------------------------------------------------------


@pytest.mark.parametrize(
    "approved",
    [
        {"profile_id": "other", "code_sha256": CODE_SHA, "max_seconds": 5, "max_bytes": 4096},
        {"profile_id": "wasi-accepted-v1", "code_sha256": "d" * 64, "max_seconds": 5, "max_bytes": 4096},
        {"profile_id": "wasi-accepted-v1", "code_sha256": CODE_SHA, "max_seconds": 1, "max_bytes": 4096},
    ],
)
def test_a_denying_gate_never_calls_execute(approved):
    sandbox = StubSandbox()
    outcome = execute_with_gate(
        GenerativeExecutionGate(approved), sandbox, _execution_request(), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert outcome["admitted"] is False
    assert outcome["reason"] in gate_module.GATE_REASONS
    assert outcome["reason"] != "ADMITTED"
    assert outcome["result"] is None
    assert sandbox.calls == []


def test_a_raising_sandbox_yields_a_fixed_refusal_not_a_traceback():
    sandbox = StubSandbox(error=RuntimeError("private provider detail"))
    outcome = execute_with_gate(
        GenerativeExecutionGate(APPROVED), sandbox, _execution_request(), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert outcome == {
        "admitted": False,
        "reason": "REFUSED_EXECUTION_FAILED",
        "result": None,
    }
    assert "private" not in repr(outcome)


def test_a_timing_out_sandbox_yields_a_fixed_refusal():
    sandbox = StubSandbox(error=TimeoutError())
    outcome = execute_with_gate(
        GenerativeExecutionGate(APPROVED), sandbox, _execution_request(), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert outcome["admitted"] is False
    assert outcome["reason"] in EXECUTION_REFUSALS
    assert outcome["result"] is None
    assert len(sandbox.calls) == 1


@pytest.mark.parametrize(
    "status,reason",
    [
        ("resource_limited", "REFUSED_UNBOUNDED"),
        ("backend_unavailable", "REFUSED_NO_PROFILE"),
        ("error", "REFUSED_EXECUTION_FAILED"),
    ],
)
def test_a_non_ok_sandbox_status_is_a_fixed_refusal(status, reason):
    sandbox = StubSandbox(status=status, result={"output": ""})
    outcome = execute_with_gate(
        GenerativeExecutionGate(APPROVED), sandbox, _execution_request(), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert outcome == {"admitted": False, "reason": reason, "result": None}


def test_an_unavailable_sandbox_is_refused_before_it_can_execute():
    sandbox = StubSandbox(available=False)
    outcome = execute_with_gate(
        GenerativeExecutionGate(APPROVED), sandbox, _execution_request(), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert outcome == {"admitted": False, "reason": "REFUSED_NO_PROFILE", "result": None}
    assert sandbox.calls == []


def test_an_unbounded_or_missing_identity_is_refused():
    sandbox = StubSandbox()
    gate = GenerativeExecutionGate(APPROVED)
    for deadline, problem_id in (
        (float("inf"), "sess-wasi"),
        (float("nan"), "sess-wasi"),
        (True, "sess-wasi"),
        ("soon", "sess-wasi"),
        (time.monotonic() + 5.0, ""),
        (time.monotonic() + 5.0, None),
    ):
        outcome = execute_with_gate(
            gate, sandbox, _execution_request(), CODE,
            deadline=deadline, problem_id=problem_id,
        )
        assert outcome == {
            "admitted": False, "reason": "REFUSED_UNBOUNDED", "result": None,
        }, (deadline, problem_id)
    assert sandbox.calls == []


def test_an_oversized_observation_is_refused_not_truncated():
    sandbox = StubSandbox(result={"output": "x" * 70000})
    outcome = execute_with_gate(
        GenerativeExecutionGate(APPROVED), sandbox, _execution_request(), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert outcome == {"admitted": False, "reason": "REFUSED_UNBOUNDED", "result": None}
    assert len(sandbox.calls) == 1


def test_a_broken_gate_can_only_refuse():
    class BrokenGate:
        def decision(self, request):
            raise RuntimeError("gate broken")

    sandbox = StubSandbox()
    outcome = execute_with_gate(
        BrokenGate(), sandbox, _execution_request(), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert outcome == {"admitted": False, "reason": "REFUSED_NO_PROFILE", "result": None}
    assert sandbox.calls == []


def test_bounds_are_checked_before_any_execution():
    """The gate's own refusal is a decision, never a post-execution veto."""
    gate = GenerativeExecutionGate(APPROVED)
    assert gate.decision(_execution_request(max_seconds=6)) == "REFUSED_UNBOUNDED"
    sandbox = StubSandbox()
    outcome = execute_with_gate(
        gate, sandbox, _execution_request(max_seconds=6), CODE,
        deadline=time.monotonic() + 5.0, problem_id="sess-wasi",
    )
    assert outcome == {"admitted": False, "reason": "REFUSED_UNBOUNDED", "result": None}
    assert sandbox.calls == []
