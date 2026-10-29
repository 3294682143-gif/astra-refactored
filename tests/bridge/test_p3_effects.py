"""Offline tests for the P3 controlled effect adapter (synthetic inputs only)."""

from __future__ import annotations

import json
import hashlib
import multiprocessing as mp
import os
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from python.astra_bridge.p0_protocol import ProtocolError
from python.astra_bridge.p3_effect_contract import parse_request
from python.astra_bridge.p3_effects import main, perform_effect

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
POLY = "polynomial_expand_coefficients"
LINEAR = "linear_system_solution_set"
POLY_ARGS = {"expression": "(x+1)**2", "variables": ["x"], "parameters": []}
LINEAR_ARGS = {"matrix": [["1", "1"], ["1", "-1"]], "rhs": ["3", "1"], "variables": ["x", "y"], "domain": "RATIONAL"}


def request(action=None, effect_id="effect-1", request_id="model-1", remaining_ms=5000):
    return {
        "effectId": effect_id,
        "binding": {
            "sessionId": "sess-p3",
            "problemHash": "a" * 64,
            "contractVersion": 1,
            "taskId": "task-1",
            "scopeId": "b" * 64,
            "sourceRequestId": request_id,
        },
        "action": action if action is not None else {"action": "tool", "name": POLY, "args": POLY_ARGS, "scope": "s"},
        "remainingMs": remaining_ms,
    }


class FakeExecutor:
    def __init__(self, result=None, error=None):
        self.calls = 0
        self.result = result
        self.error = error

    def execute(self, name, args, deadline=None, scope=None):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.result


def ok(result):
    return SimpleNamespace(status="ok", result=result)


def test_parse_request_accepts_both_tool_shapes():
    assert parse_request(json.dumps(request()).encode())["action"]["name"] == POLY
    linear = request({"action": "tool", "name": LINEAR, "args": LINEAR_ARGS, "scope": "s"})
    assert parse_request(json.dumps(linear).encode())["action"]["name"] == LINEAR


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r["action"].update(name="unknown_tool"),
        lambda r: r.update(action={"action": "method", "id": "../etc/passwd"}),
        lambda r: r.update(remainingMs=1.5),
        lambda r: r.update(remainingMs=9007199254740993),
        lambda r: r["binding"].update(problemHash="z" * 64),
        lambda r: r.update(extra=1),
    ],
)
def test_parse_request_rejects_bad_input(mutate):
    value = request()
    mutate(value)
    with pytest.raises(ProtocolError):
        parse_request(json.dumps(value).encode())


@pytest.mark.parametrize(
    "text",
    [
        '{"effectId":"effect-1","effectId":"effect-2"}',
        '{"effectId":"effect-1","x":NaN}',
        '{"effectId":"effect-1","x":"\\ud800"}',
        '{"effectId":"effect-1","x":' + "[" * 40 + "1" + "]" * 40 + "}",
    ],
)
def test_parse_request_rejects_unsafe_text(text):
    with pytest.raises(ProtocolError):
        parse_request(text.encode())


def test_perform_effect_runs_real_registered_tools():
    before = {p.pid for p in mp.active_children()}
    for action, check in [
        (
            {"action": "tool", "name": POLY, "args": POLY_ARGS, "scope": "s"},
            lambda r: [c["coefficient"] for t in r["result"]["terms"] for c in t["coefficient"]] == ["1", "2", "1"],
        ),
        (
            {"action": "tool", "name": LINEAR, "args": LINEAR_ARGS, "scope": "s"},
            lambda r: r["result"]["particular"] == ["2", "1"],
        ),
    ]:
        result = perform_effect(request(action))
        assert result["status"] == "COMPLETE"
        assert result["level"] == "PROVISIONAL" and result["checkResult"] == "UNKNOWN"
        observation = json.loads(result["observation"])
        assert check(observation)
    assert {p.pid for p in mp.active_children()} == before


def test_perform_effect_method_uses_real_catalog():
    result = perform_effect(request({"action": "method", "id": "linearization-spectral"}))
    assert result["status"] == "COMPLETE"
    asset = json.loads(result["observation"])["asset"]
    assert asset["body"]
    assert asset["bodySha256"] == hashlib.sha256(asset["body"].encode("utf-8")).hexdigest()


def test_perform_effect_rejects_bad_catalog_without_body():
    class BadCatalog:
        def load(self, method_id):
            return SimpleNamespace(
                status="loaded",
                method_id=method_id,
                title="t",
                body="PRIVATE",
                body_sha256="0" * 64,
                body_chars=7,
            )

        def title(self, method_id):
            return "t"

    result = perform_effect(request({"action": "method", "id": "linearization-spectral"}), catalog=BadCatalog())
    assert result["status"] == "ERROR"
    assert "PRIVATE" not in result["observation"]


def test_perform_effect_pre_clock_failures_do_not_execute():
    executor = FakeExecutor(ok({}))
    for clock in [lambda: True, lambda: float("nan")]:
        result = perform_effect(request(), executor=executor, clock=clock)
        assert result["status"] == "ERROR"
    for ticks in [iter([0.0, 5.0]), iter([1.0, 0.0])]:
        result = perform_effect(request(), executor=executor, clock=lambda: next(ticks))
        assert result["status"] == "ERROR"
    assert executor.calls == 0


@pytest.mark.parametrize("ticks", [[0.0, 0.0, 0.0, 9.0], [0.0, 1.0, 2.0, 1.0]])
def test_perform_effect_post_clock_regression_is_not_complete(ticks):
    executor = FakeExecutor(ok({"terms": []}))
    values = iter(ticks)
    result = perform_effect(request(), executor=executor, clock=lambda: next(values))
    assert result["status"] == "ERROR"
    assert executor.calls == 1


def test_perform_effect_exception_with_late_clock_is_unknown():
    executor = FakeExecutor(error=RuntimeError("PRIVATE"))
    values = iter([0.0, 0.0, 0.0, 9.0])
    result = perform_effect(request(), executor=executor, clock=lambda: next(values))
    assert result["status"] == "UNKNOWN"
    assert executor.calls == 1
    assert "PRIVATE" not in result["observation"]


def test_perform_effect_executor_exception_is_unknown():
    executor = FakeExecutor(error=RuntimeError("PRIVATE"))
    result = perform_effect(request(), executor=executor)
    assert result["status"] == "UNKNOWN"
    assert "PRIVATE" not in result["observation"]


def test_perform_effect_non_json_and_oversize_output_are_error():
    for result_value in [object(), {"blob": "x" * 20000}]:
        executor = FakeExecutor(ok(result_value))
        result = perform_effect(request(), executor=executor)
        assert result["status"] == "ERROR"
        assert "PRIVATE" not in result["observation"]


def test_cli_rejects_invalid_input_and_accepts_valid_request():
    env = {**os.environ, "PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    bad = subprocess.run(
        [sys.executable, "-m", "python.astra_bridge.p3_effects"],
        input=b"{not json",
        cwd=ROOT,
        env=env,
        capture_output=True,
        timeout=7,
    )
    assert bad.returncode == 2 and b"INVALID_REQUEST" in bad.stderr
    good = subprocess.run(
        [sys.executable, "-m", "python.astra_bridge.p3_effects"],
        input=json.dumps(request()).encode(),
        cwd=ROOT,
        env=env,
        capture_output=True,
        timeout=7,
    )
    assert good.returncode == 0
    assert json.loads(good.stdout.decode())["status"] == "COMPLETE"


def test_main_rejects_arguments():
    argv = sys.argv
    sys.argv = ["p3_effects", "extra"]
    try:
        assert main() == 2
    finally:
        sys.argv = argv


def test_registered_executor_rejects_bad_args_before_dispatch(monkeypatch):
    from mathagent.tools import mp as mp_module

    def forbidden(*args, **kwargs):
        raise AssertionError("DISPATCH_FORBIDDEN")

    monkeypatch.setattr(mp_module, "get_context", forbidden)
    for action in [
        {"action": "tool", "name": POLY, "args": {"expression": "(x+1)**2", "variables": ["x"]}, "scope": "s"},
        {"action": "tool", "name": POLY, "args": {"expression": 1, "variables": ["x"], "parameters": []}, "scope": "s"},
    ]:
        result = perform_effect(request(action))
        assert result["status"] == "ERROR"
    with pytest.raises(ProtocolError):
        perform_effect(request({"action": "tool", "name": "unknown_tool", "args": {}, "scope": "s"}))
