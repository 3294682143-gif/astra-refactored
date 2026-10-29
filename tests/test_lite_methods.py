"""Offline tests for on-demand method reading and duplicate-step control."""

import copy
import hashlib
import json
import shutil
from pathlib import Path

import pytest

from mathagent.lite import methods as methods_module
from mathagent.lite.methods import MethodCatalog
from mathagent.lite.protocol import (
    LiteProtocolError,
    MethodAction,
    parse_action,
)
from mathagent.lite.runtime import (
    LiteRuntime,
    _SYSTEM_PROMPT,
    _closeout_note,
    _method_catalog_block,
    _method_feedback,
    _turn_note,
)
from mathagent.tools import ToolResult

REAL_ROOT = (
    Path(methods_module.__file__).resolve().parents[1]
    / "resources"
    / "general_v11"
)


def final(answer="42", complete=True, unresolved=None):
    return json.dumps(
        {
            "action": "final",
            "answer": answer,
            "complete": complete,
            "unresolved": unresolved or [],
        }
    )


def method(method_id):
    return json.dumps({"action": "method", "id": method_id})


def tool(name, args, scope="s"):
    return json.dumps({"action": "tool", "name": name, "args": args, "scope": scope})


class ScriptedClient:
    """Scripted public client; stores deep copies of every request."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def chat(self, messages, temperature, max_tokens):
        self.calls.append(copy.deepcopy(list(messages)))
        if not self.replies:
            return '{"action":"unsolved","reason":"exhausted"}'
        return self.replies.pop(0)


class CountingCatalog(MethodCatalog):
    def __init__(self, *args, **kwargs):
        self.load_calls = []
        super().__init__(*args, **kwargs)

    def load(self, method_id):
        self.load_calls.append(method_id)
        return super().load(method_id)


class SpyExecutor:
    def __init__(self, result=None):
        self.calls = []
        self.result = result

    def execute(self, name, args, *, deadline, scope):
        self.calls.append((name, copy.deepcopy(args), scope))
        if self.result is not None:
            return self.result
        return ToolResult("ok", name, {"value": 1}, "BOUNDED_OBSERVATION", scope)


def _copy_root(tmp_path):
    root = tmp_path / "general_v11"
    shutil.copytree(REAL_ROOT, root)
    return root


def _rewrite(path, mutate):
    data = json.loads(path.read_text(encoding="utf-8"))
    mutate(data)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _all_text(messages):
    return "\n".join(row["content"] for row in messages)


# -- catalog ---------------------------------------------------------------


def test_real_catalog_has_twenty_ids_and_no_body_read(monkeypatch):
    reads = []
    original = methods_module._read_bytes

    def spy(root, rel):
        reads.append(rel)
        return original(root, rel)

    monkeypatch.setattr(methods_module, "_read_bytes", spy)
    catalog = MethodCatalog()
    entries, diagnostic = catalog.catalog()
    assert diagnostic is None
    assert len(entries) == 20
    assert all(set(row) == {"id", "title"} for row in entries)
    assert not any(rel.startswith("references/") for rel in reads)


def test_real_load_matches_source_sha_and_unknown_id():
    catalog = MethodCatalog()
    load = catalog.load("linearization-spectral")
    assert load.status == "loaded"
    assert load.body_chars == len(load.body)
    assert hashlib.sha256(load.body.encode("utf-8")).hexdigest() == load.body_sha256
    source = json.loads((REAL_ROOT / "SOURCE.json").read_text(encoding="utf-8"))
    assert source["files"]["references/linearization-spectral.md"] == load.body_sha256
    assert catalog.load("no-such-method").status == "not_found"


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda data: data["files"].__setitem__("data/methods.json", "0" * 64),
         "registry_hash_mismatch"),
        (lambda data: data.__setitem__("version", "9.9.9"),
         "source_version_mismatch"),
    ],
)
def test_source_tamper_disables_catalog(tmp_path, mutate, expected):
    root = _copy_root(tmp_path)
    _rewrite(root / "SOURCE.json", mutate)
    catalog = MethodCatalog(root)
    assert catalog.available is False
    assert catalog.diagnostic == expected
    assert catalog.load("linearization-spectral").status == "disabled"


def test_registry_tamper_disables_catalog(tmp_path):
    root = _copy_root(tmp_path)
    _rewrite(root / "data" / "methods.json",
             lambda data: data["methods"][0].__setitem__("path", "references/x.md"))
    catalog = MethodCatalog(root)
    assert catalog.available is False
    assert catalog.diagnostic == "registry_hash_mismatch"


def test_body_tamper_refuses_load(tmp_path):
    root = _copy_root(tmp_path)
    target = root / "references" / "linearization-spectral.md"
    target.write_text(target.read_text(encoding="utf-8") + "\nTAMPER\n", encoding="utf-8")
    catalog = MethodCatalog(root)
    assert catalog.available is True
    load = catalog.load("linearization-spectral")
    assert load.status == "integrity_failed"
    assert load.body == ""


def test_missing_resource_disables_catalog(tmp_path):
    root = _copy_root(tmp_path)
    (root / "data" / "methods.json").unlink()
    catalog = MethodCatalog(root)
    assert catalog.available is False
    assert catalog.diagnostic == "resource_missing"


def test_body_symlink_escape_refused(tmp_path):
    root = _copy_root(tmp_path)
    target = root / "references" / "linearization-spectral.md"
    original = target.read_bytes()
    # The escape target carries the *same* bytes as the registered body, so a
    # content-only hash check would match. Only the path boundary can refuse it.
    outside = tmp_path / "outside.md"
    outside.write_bytes(original)
    assert hashlib.sha256(outside.read_bytes()).hexdigest() == hashlib.sha256(
        original
    ).hexdigest()
    target.unlink()
    target.symlink_to(outside)
    catalog = MethodCatalog(root)
    load = catalog.load("linearization-spectral")
    assert load.status == "integrity_failed"
    assert load.body == ""


# -- protocol --------------------------------------------------------------


def test_method_action_parsed():
    action = parse_action(method("linearization-spectral"))
    assert isinstance(action, MethodAction)
    assert action.method_id == "linearization-spectral"


@pytest.mark.parametrize(
    "text",
    [
        '{"action":"method","id":"../etc/passwd"}',
        '{"action":"method","id":"a/b"}',
        '{"action":"method","id":"a\\\\b"}',
        '{"action":"method","id":"a b"}',
        '{"action":"method","id":"a\\nb"}',
        '{"action":"method","id":"' + "a" * 65 + '"}',
        '{"action":"method","id":7}',
        '{"action":"method","id":"ok","extra":1}',
        '{"action":"method"}',
    ],
)
def test_invalid_method_id_rejected(text):
    with pytest.raises(LiteProtocolError) as exc:
        parse_action(text)
    assert exc.value.code in {"invalid_method_id", "unexpected_fields"}


# -- runtime ---------------------------------------------------------------


def test_method_then_final_loads_once():
    catalog = CountingCatalog()
    client = ScriptedClient([method("linearization-spectral"), final("done")])
    result = LiteRuntime(client, method_catalog=catalog).solve("q")
    assert result["status"] == "candidate"
    assert result["candidate_verified"] is False
    assert catalog.load_calls == ["linearization-spectral"]


def test_direct_final_reads_no_body():
    catalog = CountingCatalog()
    client = ScriptedClient([final("7")])
    result = LiteRuntime(client, method_catalog=catalog).solve("q")
    assert result["status"] == "candidate"
    assert catalog.load_calls == []


def test_max_methods_zero_disables_catalog():
    catalog = CountingCatalog()
    client = ScriptedClient([method("linearization-spectral"), final("done")])
    result = LiteRuntime(client, method_catalog=catalog, max_methods=0).solve("q")
    assert catalog.load_calls == []
    assert result["status"] == "candidate"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"max_methods": -1},
        {"max_methods": 4},
        {"max_methods": True},
        {"max_method_chars": 0},
        {"max_method_chars": 24001},
        {"max_method_chars": True},
    ],
)
def test_invalid_method_parameters_rejected(kwargs):
    with pytest.raises(ValueError):
        LiteRuntime(ScriptedClient([]), **kwargs)


def test_third_unique_method_not_loaded():
    catalog = CountingCatalog()
    client = ScriptedClient(
        [
            method("linearization-spectral"),
            method("modular-crt"),
            method("counting-bijections"),
            final("done"),
        ]
    )
    result = LiteRuntime(client, method_catalog=catalog, max_steps=4).solve("q")
    assert catalog.load_calls == ["linearization-spectral", "modular-crt"]
    assert result["status"] == "candidate"


def test_small_char_budget_refuses_body():
    catalog = CountingCatalog()
    client = ScriptedClient([method("linearization-spectral"), final("done")])
    result = LiteRuntime(
        client, method_catalog=catalog, max_method_chars=10
    ).solve("q")
    assert catalog.load_calls == ["linearization-spectral"]
    assert result["status"] == "candidate"
    body = catalog.load("linearization-spectral").body
    # The id/title catalog is expected to be present; only the full body must
    # never be injected when the char budget cannot hold it.
    assert body not in _all_text(client.calls[1])
    loads = [r for r in result["trace"] if r["step"] == "method_load"]
    assert loads and loads[0]["content"]["status"] == "over_budget"


def test_final_turn_method_not_loaded():
    catalog = CountingCatalog()
    client = ScriptedClient([method("linearization-spectral")])
    result = LiteRuntime(client, method_catalog=catalog, max_steps=1).solve("q")
    assert catalog.load_calls == []
    assert result["status"] == "unsolved"


def test_repeated_method_loads_once_and_forces_closeout():
    catalog = CountingCatalog()
    client = ScriptedClient(
        [
            method("linearization-spectral"),
            method("linearization-spectral"),
            final("done"),
        ]
    )
    result = LiteRuntime(client, method_catalog=catalog, max_steps=3).solve("q")
    assert catalog.load_calls == ["linearization-spectral"]
    assert result["status"] == "candidate"
    body = catalog.load("linearization-spectral").body
    # The earlier card stays in context, but exactly once: the repeat must not
    # re-inject the full body.
    assert _all_text(client.calls[2]).count(body) == 1
    # Trace carries only the fixed metadata fields, never the body text.
    loads = [r for r in result["trace"] if r["step"] == "method_load"]
    assert loads
    for row in loads:
        assert set(row["content"]) <= {
            "method_id",
            "status",
            "body_sha256",
            "body_chars",
        }
    assert body not in json.dumps(result["trace"])


def test_method_budget_independent_across_solves():
    catalog = CountingCatalog()
    client = ScriptedClient(
        [
            method("linearization-spectral"),
            final("a"),
            method("linearization-spectral"),
            final("b"),
        ]
    )
    runtime = LiteRuntime(client, method_catalog=catalog, max_steps=2)
    first = runtime.solve("q1")
    second = runtime.solve("q2")
    assert first["status"] == "candidate"
    assert second["status"] == "candidate"
    assert catalog.load_calls == ["linearization-spectral", "linearization-spectral"]


def test_same_tool_args_different_order_and_scope_execute_once():
    executor = SpyExecutor()
    args_a = {"expression": "(x+1)**2", "variables": ["x"], "parameters": []}
    args_b = {"parameters": [], "variables": ["x"], "expression": "(x+1)**2"}
    client = ScriptedClient(
        [
            tool("polynomial_expand_coefficients", args_a, scope="first"),
            tool("polynomial_expand_coefficients", args_b, scope="second"),
            final("done"),
        ]
    )
    result = LiteRuntime(client, executor=executor, max_steps=3).solve("q")
    assert len(executor.calls) == 1
    assert result["status"] == "candidate"


def test_changed_tool_args_repair_executes_twice():
    executor = SpyExecutor()
    client = ScriptedClient(
        [
            tool("polynomial_expand_coefficients",
                 {"expression": "(x+", "variables": ["x"], "parameters": []}),
            tool("polynomial_expand_coefficients",
                 {"expression": "(x+1)**2", "variables": ["x"], "parameters": []}),
            final("done"),
        ]
    )
    result = LiteRuntime(client, executor=executor, max_steps=3).solve("q")
    assert len(executor.calls) == 2
    assert result["status"] == "candidate"


def test_oversized_observation_not_replayed():
    huge = ToolResult("ok", "polynomial_expand_coefficients",
                      {"blob": "z" * 20000}, "BOUNDED_OBSERVATION", "s")
    executor = SpyExecutor(result=huge)
    args = {"expression": "(x+1)**2", "variables": ["x"], "parameters": []}
    client = ScriptedClient(
        [
            tool("polynomial_expand_coefficients", args),
            tool("polynomial_expand_coefficients", args),
            final("done"),
        ]
    )
    result = LiteRuntime(client, executor=executor, max_steps=3).solve("q")
    assert len(executor.calls) == 1
    assert "z" * 100 not in _all_text(client.calls[2])
    assert result["candidate_verified"] is False


def test_catalog_block_omitted_when_context_tight():
    catalog = MethodCatalog()
    block = _method_catalog_block(catalog)
    turns = 5
    base = len(_SYSTEM_PROMPT) + len("q") + len(_turn_note(turns))
    limit = base + len(block) - 1
    client = ScriptedClient([final("direct")])
    runtime = LiteRuntime(client, method_catalog=catalog, max_steps=turns)
    runtime._policy = lambda: _policy_with_input_limit(limit)
    result = runtime.solve("q")
    assert result["status"] == "candidate"
    assert result["final_response"] == "direct"
    assert block not in _all_text(client.calls[0])


def test_method_body_refused_when_context_tight():
    catalog = CountingCatalog()
    # Fixture body comes from an independent catalog so the CountingCatalog
    # runtime counter stays at exactly one real load.
    load = MethodCatalog().load("linearization-spectral")
    turns = 3
    block = _method_catalog_block(catalog)
    # The catalog block must fit, so the failure is genuinely about body space.
    # Budget: system + problem + catalog block + first turn note + the method
    # action JSON + the full method feedback + the following closeout note,
    # minus one character so the complete body cannot fit.
    limit = (
        len(_SYSTEM_PROMPT)
        + len("q")
        + len(block)
        + len(_turn_note(turns))
        + len(method("linearization-spectral"))
        + len(_method_feedback(load))
        + len(_closeout_note(turns - 1))
        - 1
    )
    client = ScriptedClient([method("linearization-spectral"), final("done")])
    runtime = LiteRuntime(client, method_catalog=catalog, max_steps=turns)
    runtime._policy = lambda: _policy_with_input_limit(limit)
    result = runtime.solve("q")
    assert result["status"] == "candidate"
    assert catalog.load_calls == ["linearization-spectral"]
    loads = [r for r in result["trace"] if r["step"] == "method_load"]
    assert loads and loads[0]["content"]["status"] == "over_budget"
    assert load.body not in _all_text(client.calls[1])


def test_forced_closeout_after_repeat_blocks_changed_args():
    # Two identical tool requests, then a *different* argument set: the forced
    # closeout must refuse the third request, proving the stop is not merely the
    # natural third-turn boundary.
    executor = SpyExecutor()
    args = {"expression": "(x+1)**2", "variables": ["x"], "parameters": []}
    changed = {"expression": "(x+2)**2", "variables": ["x"], "parameters": []}
    client = ScriptedClient(
        [
            tool("polynomial_expand_coefficients", args),
            tool("polynomial_expand_coefficients", args),
            tool("polynomial_expand_coefficients", changed),
        ]
    )
    result = LiteRuntime(client, executor=executor, max_steps=5).solve("q")
    assert len(client.calls) == 3
    assert len(executor.calls) == 1
    assert result["status"] == "unsolved"


def _policy_with_input_limit(limit):
    from mathagent.runtime.config import Limits
    from mathagent.runtime.platform_coordinator import PlatformPolicy

    return PlatformPolicy(
        limits=Limits(problems=1, in_flight=1, logical_requests=5, problem_seconds=60),
        exit_reserve_seconds=5.0,
        max_input_chars=limit,
    )
