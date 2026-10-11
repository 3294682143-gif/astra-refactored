"""P3 local Host integration tests: real Node channel, real registered tools."""

from __future__ import annotations

import hashlib
import json
import socket
import subprocess
import sys
from pathlib import Path

import pytest

import user_agent
from mathagent.lite.runtime import LiteRuntime

from python.astra_bridge import p3_effects
from python.astra_bridge import p3_host_callback as callback
from python.astra_bridge import p3_host_offline as runner
from python.astra_bridge.p0_probe import ProbeError

PRIVATE = "PRIVATE problem: expand (x+1)**2 and solve 2x=4"
POLY = {"expression": "(x+1)**2", "variables": ["x"], "parameters": []}
LINEAR = {
    "matrix": [["2", "0"], ["0", "1"]],
    "rhs": ["4", "1"],
    "variables": ["x", "y"],
    "domain": "RATIONAL",
}


def effect(name, args, scope="registered tool"):
    return json.dumps({"action": "tool", "name": name, "args": args, "scope": scope})


def final(answer="x=1"):
    return json.dumps({"action": "final", "answer": answer, "complete": True, "unresolved": []})


def receipt(text, status="COMPLETE"):
    return {"deliveryStatus": status, "text": text}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("network access is forbidden")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(user_agent.ReasoningAgent, "solve", refuse)
    monkeypatch.setattr(LiteRuntime, "solve", refuse)


@pytest.fixture
def capture(monkeypatch):
    hosts = []
    procs = []
    real_init = callback.P3HostCallback.__init__
    real_popen = subprocess.Popen

    def spy_init(self, *args, **kwargs):
        real_init(self, *args, **kwargs)
        hosts.append(self)

    def spy_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        procs.append(proc)
        return proc

    monkeypatch.setattr(callback.P3HostCallback, "__init__", spy_init)
    monkeypatch.setattr(runner.subprocess, "Popen", spy_popen)
    yield hosts, procs
    for proc in procs:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream is None or stream.closed
    for host in hosts:
        assert host.selector.get_map() is None


def run(problem, receipts, **kwargs):
    return runner.run_p3_host(problem, receipts=receipts, **kwargs)


def test_poly_tool_then_final(capture):
    result = run(PRIVATE, [receipt(effect("polynomial_expand_coefficients", POLY)), receipt(final())])
    assert result["status"] == "candidate"
    assert result["stopReason"] == "FINAL"
    assert result["modelCalls"] == 2
    assert result["effectCalls"] == 1
    assert result["cachedEffects"] == 0
    assert result["candidateVerified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["frames"] == 12
    assert result["childReaped"] is True
    host = capture[0][-1]
    assert len(host.effects) == 1
    observation = json.loads(host.effects[0]["observation"])
    terms = observation["result"]["terms"]
    assert [term["powers"] for term in terms] == [[0], [1], [2]]
    assert [term["coefficient"][0]["coefficient"] for term in terms] == ["1", "2", "1"]
    assert "coefficients" not in observation["result"]
    assert "powers" not in observation["result"]
    assert host.effects[0]["level"] == "PROVISIONAL"
    assert host.effects[0]["checkResult"] == "UNKNOWN"
    assert host.effects[0]["binding"]["sourceRequestId"] == "model-1"
    assert PRIVATE not in json.dumps(result)
    assert "coefficients" not in json.dumps(result)


def test_linear_tool_then_final(capture):
    result = run(PRIVATE, [receipt(effect("linear_system_solution_set", LINEAR)), receipt(final("x=2,y=1"))])
    assert result["status"] == "candidate"
    assert result["effectCalls"] == 1
    host = capture[0][-1]
    observation = json.loads(host.effects[0]["observation"])
    assert observation["result"]["particular"] == ["2", "1"]


def test_duplicate_cache_then_final(capture):
    reversed_args = {"parameters": [], "variables": ["x"], "expression": "(x+1)**2"}
    result = run(
        PRIVATE,
        [
            receipt(effect("polynomial_expand_coefficients", POLY, "expand")),
            receipt(effect("polynomial_expand_coefficients", reversed_args, "different wording")),
            receipt(final()),
        ],
    )
    assert result["status"] == "candidate"
    assert result["effectCalls"] == 1
    assert result["cachedEffects"] == 1
    assert result["modelCalls"] == 3
    assert result["frames"] == 14
    host = capture[0][-1]
    assert len(host.effects) == 1
    assert len(host.history) == 3
    assert host.history[1]["receipt"]["deliveryStatus"] == "COMPLETE"
    assert host.history[2]["receipt"]["deliveryStatus"] == "COMPLETE"


def test_two_distinct_tools_then_final(capture):
    result = run(
        PRIVATE,
        [
            receipt(effect("polynomial_expand_coefficients", POLY)),
            receipt(effect("linear_system_solution_set", LINEAR)),
            receipt(final()),
        ],
    )
    assert result["status"] == "candidate"
    assert result["effectCalls"] == 2
    assert result["cachedEffects"] == 0
    assert result["frames"] == 16
    host = capture[0][-1]
    assert [entry["effectId"] for entry in host.effects] == ["effect-1", "effect-2"]
    assert host.effects[1]["binding"]["sourceRequestId"] == "model-2"


def test_context_hash_and_effects_are_host_recorded(capture):
    result = run(
        PRIVATE,
        [
            receipt(effect("polynomial_expand_coefficients", POLY)),
            receipt(final()),
        ],
    )
    host = capture[0][-1]
    second = host.history[1]["params"]
    messages = second["messages"]
    serialized = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    assert second["contextHash"] == hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    inner = json.loads(messages[1]["content"])
    assert inner["effects"] == host.effects
    assert inner["history"][0]["requestId"] == "model-1"
    assert inner["history"][0]["transportStatus"] == "COMPLETE"
    assert result["contextHash"] == second["contextHash"]


def test_method_action_is_unavailable(capture):
    result = run(PRIVATE, [receipt(json.dumps({"action": "method", "id": "linearization-spectral"}))])
    assert result["stopReason"] == "EFFECT_UNAVAILABLE"
    assert result["candidateRequestId"] is None
    assert result["effectCalls"] == 0
    assert result["frames"] == 8


def test_direct_final_and_zero_calls(capture):
    direct = run(PRIVATE, [receipt(final())])
    assert direct["status"] == "candidate"
    assert direct["modelCalls"] == 1
    assert direct["effectCalls"] == 0
    assert direct["frames"] == 8
    zero = run(PRIVATE, [receipt(final())], max_model_calls=0, max_effects=0)
    assert zero["status"] == "unsolved"
    assert zero["modelCalls"] == 0
    assert zero["frames"] == 6


@pytest.mark.parametrize("status", ["TRUNCATED", "ERROR", "UNKNOWN"])
def test_non_complete_transport(capture, status):
    result = run(PRIVATE, [receipt(final(), status)])
    assert result["status"] == "unsolved"
    assert result["candidateRequestId"] is None
    assert result["effectCalls"] == 0


@pytest.mark.parametrize(
    "text",
    [
        json.dumps({"action": "final", "answer": "x=1", "complete": False, "unresolved": []}),
        "{",
        json.dumps({"action": "unsolved", "reason": "no"}),
    ],
)
def test_non_candidate_actions(capture, text):
    result = run(PRIVATE, [receipt(text)])
    assert result["candidateRequestId"] is None
    assert result["status"] == "unsolved"
    assert result["effectCalls"] == 0


def test_tool_on_last_turn_and_zero_effects(capture):
    last_turn = run(PRIVATE, [receipt(effect("polynomial_expand_coefficients", POLY))], max_model_calls=1)
    assert last_turn["stopReason"] == "BUDGET_EXHAUSTED"
    assert last_turn["effectCalls"] == 0
    no_effects = run(PRIVATE, [receipt(effect("polynomial_expand_coefficients", POLY))], max_effects=0)
    assert no_effects["stopReason"] == "BUDGET_EXHAUSTED"
    assert no_effects["effectCalls"] == 0


def test_error_effect_still_reaches_final(capture):
    bad = effect("polynomial_expand_coefficients", {})
    result = run(PRIVATE, [receipt(bad), receipt(bad), receipt(final())])
    assert result["status"] == "candidate"
    assert result["effectCalls"] == 1
    assert result["cachedEffects"] == 1
    host = capture[0][-1]
    assert host.effects[0]["status"] == "ERROR"
    assert host.effects[0]["level"] == "PROVISIONAL"


def test_missing_fixture_stops_transport(capture):
    result = run(PRIVATE, [])
    assert result["status"] == "unsolved"
    assert result["stopReason"] == "TRANSPORT_STOP"
    assert result["effectCalls"] == 0


@pytest.mark.parametrize(
    "kwargs",
    [
        {"timeout": 0},
        {"timeout": 6},
        {"timeout": True},
        {"timeout": float("nan")},
        {"max_model_calls": -1},
        {"max_model_calls": 4},
        {"max_model_calls": True},
        {"max_effects": -1},
        {"max_effects": 3},
        {"max_effects": True},
    ],
)
def test_bad_parameters_rejected_before_spawn(capture, kwargs):
    with pytest.raises(ProbeError) as excinfo:
        run(PRIVATE, [receipt(final())], **kwargs)
    assert excinfo.value.code == "FIELD_VALUE"
    assert capture[1] == []


@pytest.mark.parametrize(
    "problem",
    ["", "   ", "x" * 8193, "bad\ud800"],
)
def test_bad_problem_rejected_before_spawn(capture, problem):
    with pytest.raises(ProbeError) as excinfo:
        run(problem, [receipt(final())])
    assert excinfo.value.code == "FIELD_VALUE"
    assert capture[1] == []


@pytest.mark.parametrize(
    "receipts",
    [
        [{"deliveryStatus": "COMPLETE", "text": final(), "extra": 1}],
        [{"deliveryStatus": "BAD", "text": final()}],
        [{"deliveryStatus": "COMPLETE", "text": "x" * 20001}],
    ],
)
def test_bad_receipts_rejected_before_spawn(capture, receipts):
    with pytest.raises(ProbeError) as excinfo:
        run(PRIVATE, receipts)
    assert excinfo.value.code == "FIELD_VALUE"
    assert capture[1] == []


def test_missing_node_and_script(capture):
    with pytest.raises(ProbeError) as excinfo:
        run(PRIVATE, [receipt(final())], node="definitely-not-a-node-binary")
    assert excinfo.value.code in ("SPAWN_FAILED", "CHILD_FAILED")
    with pytest.raises(ProbeError) as excinfo:
        run(PRIVATE, [receipt(final())], script=Path("/nonexistent/p3-host-main.js"))
    assert excinfo.value.code == "CHILD_FAILED"


def test_immediate_exit_and_silent_timeout(capture, tmp_path):
    exiting = tmp_path / "exit.js"
    exiting.write_text("process.exit(3);\n", encoding="utf-8")
    with pytest.raises(ProbeError) as excinfo:
        run(PRIVATE, [receipt(final())], script=exiting, timeout=0.25)
    assert excinfo.value.code in ("CHILD_FAILED", "EOF", "TIMEOUT")
    silent = tmp_path / "silent.js"
    silent.write_text("setTimeout(() => {}, 60000);\n", encoding="utf-8")
    with pytest.raises(ProbeError) as excinfo:
        run(PRIVATE, [receipt(final())], script=silent, timeout=0.25)
    assert excinfo.value.code == "TIMEOUT"


def test_noisy_stdout_is_rejected(capture, tmp_path):
    noisy = tmp_path / "noisy.js"
    noisy.write_text('process.stdout.write("not json\\n");\n', encoding="utf-8")
    with pytest.raises(ProbeError) as excinfo:
        run(PRIVATE, [receipt(final())], script=noisy, timeout=0.25)
    assert excinfo.value.code in ("INVALID_JSON", "FIELD_VALUE", "CHILD_FAILED", "EOF")


def test_cli_direct_final_and_unknown_flag(capsys):
    code = runner.main(["--problem", PRIVATE, "--action", final()])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "candidate"
    assert payload["candidateVerified"] is False
    assert runner.main(["--bogus"]) == 2
    assert capsys.readouterr().err.strip() == "FIELD_VALUE"


class _FakeExecutor:
    """Records the deadline it was handed; never runs a real operator."""

    def __init__(self):
        self.calls = 0
        self.deadlines = []

    def execute(self, name, args, *, deadline, scope):
        self.calls += 1
        self.deadlines.append(deadline)
        return type("R", (), {"status": "ok", "result": {"fake": True}})()


def _tool_request(remaining_ms=1000):
    return {
        "effectId": "effect-1",
        "binding": {
            "sessionId": "s",
            "problemHash": "a" * 64,
            "contractVersion": 1,
            "taskId": "t",
            "scopeId": "b" * 64,
            "sourceRequestId": "model-1",
        },
        "action": {"action": "tool", "name": "polynomial_expand_coefficients", "args": POLY, "scope": "expand"},
        "remainingMs": remaining_ms,
    }


def test_root_deadline_tightens_effect_window():
    clock = [100.0]
    executor = _FakeExecutor()
    request = _tool_request(1000)
    expired = p3_effects.perform_effect(
        request, executor=executor, clock=lambda: clock[0], root_deadline=99.0
    )
    assert expired["status"] == "ERROR"
    assert executor.calls == 0
    clock[0] = 100.0
    tight = p3_effects.perform_effect(
        request, executor=executor, clock=lambda: clock[0], root_deadline=100.5
    )
    assert tight["status"] == "COMPLETE"
    assert executor.calls == 1
    assert executor.deadlines[0] == pytest.approx(100.5 - 0.025)
    for bad in (float("nan"), float("inf"), True, "x"):
        clock[0] = 100.0
        result = p3_effects.perform_effect(
            request, executor=executor, clock=lambda: clock[0], root_deadline=bad
        )
        assert result["status"] == "ERROR"
    assert executor.calls == 1
