"""Offline tests for the lightweight runtime loop and public entry point."""

import json
import time

import pytest

import user_agent
from mathagent.lite.runtime import LiteRuntime
from mathagent.runtime.config import Limits
from mathagent.runtime.platform_coordinator import PlatformPolicy
from mathagent.tools import RegisteredExecutor, ToolResult


class FakeClient:
    """Minimal three-argument public client returning scripted strings."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def chat(self, messages, temperature, max_tokens):
        self.calls.append(list(messages))
        if not self.replies:
            return '{"action":"unsolved","reason":"exhausted"}'
        return self.replies.pop(0)


def final(answer="42", complete=True, unresolved=None):
    return json.dumps(
        {
            "action": "final",
            "answer": answer,
            "complete": complete,
            "unresolved": unresolved or [],
        }
    )


def tool(name, args, scope="s"):
    return json.dumps(
        {"action": "tool", "name": name, "args": args, "scope": scope}
    )


def test_default_entry_point_direct_final():
    client = FakeClient([final("7")])
    result = user_agent.ReasoningAgent(client=client, engine="lite").solve("What is 3+4?")
    assert result["final_response"] == "7"
    assert result["status"] == "candidate"
    assert result["candidate_verified"] is False
    assert len(client.calls) == 1
    assert json.dumps(result["trace"])


def test_minimal_three_argument_client_works():
    client = FakeClient([final("1")])
    result = LiteRuntime(client).solve("q")
    assert result["final_response"] == "1"
    assert result["status"] == "candidate"


def test_legacy_engine_explicit_fallback():
    client = FakeClient([final("1")])
    agent = user_agent.ReasoningAgent(client=client, engine="legacy")
    assert agent.engine == "legacy"
    assert hasattr(agent._impl, "solve")


def test_unknown_engine_rejected():
    with pytest.raises(ValueError):
        user_agent.ReasoningAgent(client=FakeClient([]), engine="turbo")


def test_unsupported_lite_parameter_rejected():
    with pytest.raises(TypeError):
        user_agent.ReasoningAgent(client=FakeClient([]), engine="lite", bogus=1)


def test_tool_then_final():
    client = FakeClient(
        [
            tool(
                "polynomial_expand_coefficients",
                {"expression": "(x+1)**2", "variables": ["x"], "parameters": []},
            ),
            final("x**2+2*x+1"),
        ]
    )
    result = LiteRuntime(client).solve("expand (x+1)**2")
    assert result["status"] == "candidate"
    assert result["final_response"] == "x**2+2*x+1"
    steps = [row["step"] for row in result["trace"]]
    assert "tool_call" in steps
    tool_rows = [r for r in result["trace"] if r["step"] == "tool_call"]
    assert tool_rows[0]["content"]["status"] == "ok"
    assert tool_rows[0]["content"]["evidence_kind"] != "NONE"
    assert len(client.calls) == 2


def test_tool_error_is_feedback_not_answer():
    client = FakeClient(
        [
            tool(
                "polynomial_expand_coefficients",
                {"expression": "(x+", "variables": ["x"], "parameters": []},
            ),
            final("recovered"),
        ]
    )
    result = LiteRuntime(client).solve("q")
    assert result["status"] == "candidate"
    assert result["final_response"] == "recovered"
    tool_rows = [r for r in result["trace"] if r["step"] == "tool_call"]
    assert tool_rows and tool_rows[0]["content"]["status"] != "ok"


def test_illegal_tool_rejected_by_protocol():
    client = FakeClient([tool("os_system", {"cmd": "ls"}), final("done")])
    result = LiteRuntime(client).solve("q")
    codes = [
        r["content"]["code"] for r in result["trace"] if r["step"] == "protocol_error"
    ]
    assert "tool_not_allowed" in codes


def test_tool_observation_is_not_answer():
    client = FakeClient(
        [
            tool(
                "polynomial_expand_coefficients",
                {"expression": "(x+1)**2", "variables": ["x"], "parameters": []},
            ),
            '{"action":"unsolved","reason":"cannot conclude"}',
        ]
    )
    result = LiteRuntime(client).solve("q")
    assert result["status"] == "unsolved"
    assert result["final_response"] != "x**2+2*x+1"


def test_incomplete_final_is_not_candidate():
    client = FakeClient([final("maybe", complete=False, unresolved=["gap"])])
    result = LiteRuntime(client, max_steps=1).solve("q")
    assert result["status"] == "unsolved"
    assert result["candidate_verified"] is False


def test_incomplete_final_can_be_repaired():
    client = FakeClient(
        [
            final("maybe", complete=False, unresolved=["gap"]),
            final("settled"),
        ]
    )
    result = LiteRuntime(client, max_steps=3).solve("q")
    assert result["status"] == "candidate"
    assert result["final_response"] == "settled"


def test_single_call_budget_allows_one_final():
    client = FakeClient([final("only")])
    result = LiteRuntime(client, max_steps=1).solve("q")
    assert result["status"] == "candidate"
    assert len(client.calls) == 1


def test_last_turn_cannot_dispatch_tool():
    client = FakeClient(
        [
            tool(
                "polynomial_expand_coefficients",
                {"expression": "(x+1)**2", "variables": ["x"], "parameters": []},
            ),
            tool(
                "polynomial_expand_coefficients",
                {"expression": "(x+1)**2", "variables": ["x"], "parameters": []},
            ),
        ]
    )
    result = LiteRuntime(client, max_steps=2).solve("q")
    assert result["status"] == "unsolved"
    assert len(client.calls) == 2


def test_truncated_transport_not_accepted():
    class TruncatingClient:
        def chat(self, messages, temperature, max_tokens):
            return {"choices": [{"message": {"role": "assistant", "content": final("x")}, "finish_reason": "length"}]}

    result = LiteRuntime(TruncatingClient()).solve("q")
    assert result["status"] == "unsolved"
    assert result["final_response"] != "x"


def test_context_limit_stops_without_calling_client():
    client = FakeClient([final("x")])
    runtime = LiteRuntime(client, max_steps=3)
    huge = "a" * 70000
    result = runtime.solve(huge)
    assert result["status"] == "unsolved"
    assert len(client.calls) == 0


def test_metadata_answer_and_idx_do_not_leak():
    client = FakeClient([final("computed")])
    result = LiteRuntime(client).solve(
        "q", {"answer": "SECRET", "idx": 7}
    )
    assert result["final_response"] == "computed"
    assert "SECRET" not in json.dumps(result["trace"])
    for call in client.calls:
        assert "SECRET" not in json.dumps(call)


def test_independent_state_across_problems():
    client = FakeClient([final("first"), final("second")])
    runtime = LiteRuntime(client)
    first = runtime.solve("q1")
    second = runtime.solve("q2")
    assert first["final_response"] == "first"
    assert second["final_response"] == "second"
    assert first["trace"] is not second["trace"]


def test_second_problem_gets_fresh_clock():
    client = FakeClient([final("a"), final("b")])
    runtime = LiteRuntime(client, problem_seconds=120.0)
    runtime.solve("q1")
    time.sleep(0.01)
    second = runtime.solve("q2")
    assert second["status"] == "candidate"


def test_explicit_policy_smaller_budget_still_reaches_final():
    client = FakeClient([final("ok")])
    policy = PlatformPolicy(
        limits=Limits(problems=1, in_flight=1, logical_requests=1, problem_seconds=60),
        exit_reserve_seconds=5.0,
    )
    result = LiteRuntime(client, policy=policy, max_steps=1).solve("q")
    assert result["status"] == "candidate"


def test_policy_call_ceiling_bounds_default_max_steps():
    # Default max_steps=5 must not outrun an explicit one-call policy: the single
    # admitted turn is the final turn, so the first request is not refused.
    client = FakeClient([final("ok")])
    policy = PlatformPolicy(
        limits=Limits(problems=1, in_flight=1, logical_requests=1, problem_seconds=60),
        exit_reserve_seconds=5.0,
    )
    result = LiteRuntime(client, policy=policy).solve("q")
    assert result["status"] == "candidate"
    assert len(client.calls) == 1


def test_policy_input_bound_smaller_than_system_prompt():
    # A policy input bound below the system prompt must fail closed as
    # context_limit before any model call, not as a generic runtime error.
    client = FakeClient([final("x")])
    policy = PlatformPolicy(
        limits=Limits(problems=1, in_flight=1, logical_requests=5, problem_seconds=60),
        exit_reserve_seconds=5.0,
        max_input_chars=1000,
    )
    result = LiteRuntime(client, policy=policy).solve("q")
    assert result["status"] == "unsolved"
    assert len(client.calls) == 0
    reasons = [
        r["content"].get("closeout")
        for r in result["trace"]
        if r["step"] == "lite_summary"
    ]
    assert reasons == ["context_limit"]


def test_conflicting_problem_seconds_and_policy_rejected():
    policy = PlatformPolicy(
        limits=Limits(problems=1, in_flight=1, logical_requests=2, problem_seconds=60),
        exit_reserve_seconds=5.0,
    )
    with pytest.raises(ValueError):
        LiteRuntime(FakeClient([]), policy=policy, problem_seconds=30.0)


def test_first_problem_uses_load_started_and_second_gets_fresh_window(monkeypatch):
    # The first solve is charged the (already expired) import/load start, so its
    # window is closed and no request is dispatched. The second solve must still
    # obtain a fresh window and consume the first queued reply; an undispatched
    # turn must never consume a scripted response.
    import mathagent.lite.runtime as runtime_module

    client = FakeClient([final("first"), final("second")])
    runtime = LiteRuntime(
        client, load_started=time.monotonic() - 10000.0, problem_seconds=120.0
    )
    first = runtime.solve("q1")
    assert first["status"] == "unsolved"
    assert len(client.calls) == 0
    second = runtime.solve("q2")
    assert second["status"] == "candidate"
    assert second["final_response"] == "first"
    assert len(client.calls) == 1


def test_new_instance_does_not_inherit_module_load_time():
    # Negative control: a fresh default ReasoningAgent must not be charged the
    # module-level import timestamp. Only an explicit load_started constrains the
    # first solve, so this instance still reaches a candidate.
    import user_agent as entry

    original = entry._LOAD_STARTED
    entry._LOAD_STARTED = time.monotonic() - 1000.0
    try:
        client = FakeClient([final("fresh")])
        result = entry.ReasoningAgent(client=client, engine="lite").solve("q")
    finally:
        entry._LOAD_STARTED = original
    assert result["status"] == "candidate"
    assert result["final_response"] == "fresh"
    assert len(client.calls) == 1


def test_client_exception_text_not_leaked():
    class ExplodingClient:
        def chat(self, messages, temperature, max_tokens):
            raise RuntimeError("SECRET-ENDPOINT-TOKEN")

    result = LiteRuntime(ExplodingClient()).solve("q")
    assert result["status"] == "unsolved"
    assert result["final_response"]
    assert "SECRET-ENDPOINT-TOKEN" not in json.dumps(result["trace"])


def test_oversized_tool_observation_is_complete_output_limited():
    class HugeExecutor:
        def execute(self, name, args, *, deadline, scope):
            return ToolResult(
                "ok", name, {"blob": "z" * 20000}, "BOUNDED_OBSERVATION", scope
            )

    client = FakeClient(
        [
            tool(
                "polynomial_expand_coefficients",
                {"expression": "(x+1)**2", "variables": ["x"], "parameters": []},
            ),
            final("done"),
        ]
    )
    result = LiteRuntime(client, executor=HugeExecutor()).solve("q")
    assert result["status"] == "candidate"
    feedback = [
        row["content"]
        for call in client.calls
        for row in call
        if row["role"] == "user" and "Tool observation" in row["content"]
    ]
    assert feedback
    assert '"status": "output_limited"' in feedback[0]
    assert "z" * 100 not in feedback[0]


def test_tool_failure_does_not_verify_candidate():
    client = FakeClient(
        [
            tool(
                "polynomial_expand_coefficients",
                {"expression": "(x+", "variables": ["x"], "parameters": []},
            ),
            final("claimed"),
        ]
    )
    result = LiteRuntime(client).solve("q")
    assert result["status"] == "candidate"
    assert result["candidate_verified"] is False
    tool_rows = [r for r in result["trace"] if r["step"] == "tool_call"]
    assert tool_rows and tool_rows[0]["content"]["status"] != "ok"


def test_small_problem_seconds_constructs_valid_policy():
    client = FakeClient([final("ok")])
    result = LiteRuntime(client, problem_seconds=1.0).solve("q")
    assert result["status"] == "candidate"


def test_metrics_snapshot_present_after_close():
    client = FakeClient([final("ok")])
    result = LiteRuntime(client).solve("q")
    summary = [
        r for r in result["trace"] if r["step"] == "local_invocation_summary"
    ]
    assert summary
    content = summary[-1]["content"]
    assert content["scope"] == "single_solve_invocation"
    assert content["remote_cancellation_confirmed"] is False
    assert content["sdk_attempts"] is None


def test_injected_executor_is_used_and_not_model_replaceable():
    seen = {}

    class SpyExecutor:
        def execute(self, name, args, *, deadline, scope):
            seen["name"] = name
            return ToolResult("ok", name, {"value": 1}, "BOUNDED_OBSERVATION", scope)

    client = FakeClient(
        [
            tool(
                "polynomial_expand_coefficients",
                {"expression": "(x+1)**2", "variables": ["x"], "parameters": []},
            ),
            final("done"),
        ]
    )
    result = LiteRuntime(client, executor=SpyExecutor()).solve("q")
    assert seen["name"] == "polynomial_expand_coefficients"
    assert result["status"] == "candidate"


def test_registered_executor_subprocess_smoke():
    executor = RegisteredExecutor()
    result = executor.execute(
        "linear_system_solution_set",
        {
            "matrix": [["1", "1"], ["1", "-1"]],
            "rhs": ["3", "1"],
            "variables": ["x", "y"],
            "domain": "RATIONAL",
        },
        deadline=time.monotonic() + 30,
        scope="smoke",
    )
    assert result.status in {"ok", "partial"}
    assert result.evidence_kind != "NONE"


def test_invalid_problem_returns_unsolved():
    result = LiteRuntime(FakeClient([])).solve("   ")
    assert result["status"] == "unsolved"
    assert result["final_response"]


class BudgetClient:
    """Public client exposing an explicit public budget snapshot port."""

    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.calls = 0

    def chat(self, messages, temperature, max_tokens):
        self.calls += 1
        return final("ok")

    def public_budget_snapshot(self):
        return self.snapshot


def _budget(logical, http, effective=None):
    return {
        "schema": "rc-public-budget-v1",
        "logical_remaining": logical,
        "http_remaining": http,
        "effective_remaining": logical if effective is None else effective,
    }


def _closeout(result):
    return [
        r["content"].get("closeout")
        for r in result["trace"]
        if r["step"] == "lite_summary"
    ]


def test_public_budget_zero_zero_refuses_dispatch():
    client = BudgetClient(_budget(0, 0))
    result = LiteRuntime(client, max_steps=1).solve("q")
    assert result["status"] == "unsolved"
    assert client.calls == 0
    assert _closeout(result) == ["budget_exhausted"]


def test_public_budget_logical_positive_http_zero_refuses_dispatch():
    client = BudgetClient(_budget(3, 0))
    result = LiteRuntime(client, max_steps=1).solve("q")
    assert result["status"] == "unsolved"
    assert client.calls == 0
    assert _closeout(result) == ["budget_exhausted"]


def test_public_budget_logical_zero_http_positive_refuses_dispatch():
    client = BudgetClient(_budget(0, 3))
    result = LiteRuntime(client, max_steps=1).solve("q")
    assert result["status"] == "unsolved"
    assert client.calls == 0
    assert _closeout(result) == ["budget_exhausted"]


def test_absent_public_budget_port_is_not_exhaustion():
    client = FakeClient([final("ok")])
    result = LiteRuntime(client, max_steps=1).solve("q")
    assert result["status"] == "candidate"
    assert len(client.calls) == 1


def test_public_budget_dropping_to_zero_stops_further_dispatch():
    # The first turn is admitted while budget is reported as 2; the port then
    # reports 0, so the second turn must not reach the client.
    client = BudgetClient(_budget(2, 2))
    replies = [
        tool(
            "polynomial_expand_coefficients",
            {"expression": "(x+1)**2", "variables": ["x"], "parameters": []},
        ),
        final("late"),
    ]

    def chat(messages, temperature, max_tokens):
        client.calls += 1
        client.snapshot = _budget(0, 0)
        return replies.pop(0)

    client.chat = chat
    result = LiteRuntime(client, max_steps=3).solve("q")
    assert result["status"] == "unsolved"
    assert client.calls == 1
    assert _closeout(result) == ["budget_exhausted"]


def test_malformed_public_budget_refuses_dispatch():
    # A declared rc-public-budget-v1 snapshot that omits a required field is a
    # malformed protocol message, not an unknown value: it must fail closed
    # before any dispatch instead of being read as "budget available".
    client = BudgetClient(
        {"schema": "rc-public-budget-v1", "logical_remaining": 2, "http_remaining": 2}
    )
    result = LiteRuntime(client, max_steps=1).solve("q")
    assert result["status"] == "unsolved"
    assert client.calls == 0


def test_source_version_matches_packaging_metadata():
    import re
    from pathlib import Path

    import mathagent

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match is not None
    assert mathagent.__version__ == match.group(1)
