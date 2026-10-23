"""Focused data-only tests: P3 tool whitelist (11 names) and effect-id capacity.

Nothing here executes a model, spawns a process or opens a socket. The checks
are:

* the TS whitelist (`packages/protocol/src/p3.ts`), the compiled copy, the live
  JSON schema copies and the Python contract all name the same eleven tools;
* every schema `effectId` enum carries exactly six ids;
* every whitelisted name passes the real Host-side validators (effect contract,
  Host context action parser, P3 host manifest payload, 1.3 and 1.2 manifests);
* `effect-6` is admitted and `effect-7` is refused, while `effect-1`/`effect-2`
  keep their identity and ordering;
* the TS capacity constants say six ids with the public `maxEffects` option
  still bounded at two and the method-load quota bounded at four.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from python.astra_bridge import agent_protocol, p3_host_context, p3_host_protocol
from python.astra_bridge.p0_probe import ProbeError
from python.astra_bridge.p0_protocol import ProtocolError
from python.astra_bridge.p3_effect_contract import (
    EFFECT_IDS,
    TOOL_NAMES,
    parse_request,
    receipt,
)

ROOT = Path(__file__).resolve().parents[2]

EXPECTED_TOOLS = (
    "polynomial_expand_coefficients",
    "linear_system_solution_set",
    "exact_check_expr",
    "bounded_enumeration",
    "real_root_count_expr",
    "splitting_field_degree_expr",
    "circle_laplacian_expr",
    "planar_laplacian_expr",
    "interpolation_fit_check",
    "stats_ols_check",
    "finite_group_structure",
)
NEW_TOOLS = EXPECTED_TOOLS[4:8]
EXACT_DATA_TOOLS = EXPECTED_TOOLS[8:10]
GROUP_TOOLS = EXPECTED_TOOLS[10:]
EXPECTED_EFFECTS = tuple("effect-" + str(n) for n in range(1, 7))

SCHEMA_DIR = ROOT / "packages" / "protocol" / "schema"
# Live contracts only. The 1.2 manifest (`agent-host.schema.json`) is a frozen
# historical contract: it keeps its own `effect-1/2` vocabulary and its own
# two-tool, one-method capacity, so the widened six-id table must NOT leak into
# it. `test_legacy_manifest_keeps_its_narrow_effect_table` pins that boundary.
SCHEMAS = (
    SCHEMA_DIR / "p3-host.schema.json",
    SCHEMA_DIR / "agent-host-v13.schema.json",
    ROOT / "release" / "schema" / "agent-host-v13.schema.json",
)
LEGACY_SCHEMA = SCHEMA_DIR / "agent-host.schema.json"
TOOL_SOURCE = ROOT / "packages" / "protocol" / "src" / "p3.ts"
TOOL_BUILD = ROOT / "packages" / "protocol" / "dist" / "src" / "p3.js"
AGENT_SESSION = ROOT / "packages" / "runtime-core" / "src" / "agent-session.ts"
P3_GATE = ROOT / "packages" / "math-gateway" / "src" / "p3-gate.ts"
P3_EFFECT_DATA = ROOT / "packages" / "math-gateway" / "src" / "p3-effect-data.ts"

BINDING = {
    "sessionId": "sess-p3",
    "problemHash": "a" * 64,
    "contractVersion": 1,
    "taskId": "task-1",
    "scopeId": "b" * 64,
    "sourceRequestId": "model-1",
}
TOOL_ARGS = {"expression": "(x+1)**2", "variables": ["x"]}


def tool_action(name, args=None, scope="expand"):
    return {
        "action": "tool",
        "name": name,
        "args": TOOL_ARGS if args is None else args,
        "scope": scope,
    }


def effect_request(action=None, effect_id="effect-1"):
    return {
        "effectId": effect_id,
        "binding": dict(BINDING),
        "action": tool_action(EXPECTED_TOOLS[0]) if action is None else action,
        "remainingMs": 1000,
    }


def tool_frame(name, effect_id="effect-1", version=p3_host_protocol.P3_HOST_VERSION):
    """One `tool.execute` params payload for the given manifest version."""
    return {
        "protocolVersion": version,
        "sessionId": BINDING["sessionId"],
        "request": effect_request(tool_action(name), effect_id),
    }


def _list_after(text, marker):
    """Quoted entries of the first bracketed list that follows ``marker``."""
    start = text.index(marker)
    open_at = text.index("[", start)
    close_at = text.index("]", open_at)
    return tuple(re.findall(r'"([^"]+)"', text[open_at:close_at]))


def _load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _collect_enum_values(node, key):
    """Every `enum` list stored under ``key`` anywhere in the manifest."""
    found = []

    def walk(value):
        if isinstance(value, dict):
            for name, child in value.items():
                if name == key and isinstance(child, dict) and isinstance(child.get("enum"), list):
                    found.append(tuple(child["enum"]))
                walk(child)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(node)
    return found


# --------------------------------------------------------------------- #
# 1. One whitelist on every side
# --------------------------------------------------------------------- #
def test_python_contract_names_exactly_eleven_tools():
    assert isinstance(TOOL_NAMES, tuple)
    assert len(TOOL_NAMES) == 11
    assert TOOL_NAMES == EXPECTED_TOOLS
    assert len(set(TOOL_NAMES)) == 11


def test_typescript_whitelist_equals_the_python_one():
    source = TOOL_SOURCE.read_text(encoding="utf-8")
    assert _list_after(source, "P3_TOOL_NAMES") == EXPECTED_TOOLS
    # The compiled copy is only present after `tsc -b`; when it is, it must
    # agree too so a stale build cannot silently disagree with the source.
    if TOOL_BUILD.is_file():
        assert _list_after(TOOL_BUILD.read_text(encoding="utf-8"), "P3_TOOL_NAMES") == EXPECTED_TOOLS


@pytest.mark.parametrize("path", SCHEMAS, ids=lambda p: p.name)
def test_schema_tool_enums_equal_the_whitelist(path):
    enums = _collect_enum_values(_load(path), "name")
    assert enums, f"{path} has no tool-name enum"
    for enum in enums:
        assert enum == EXPECTED_TOOLS


def test_both_v13_schema_copies_stay_byte_identical():
    packaged = (SCHEMA_DIR / "agent-host-v13.schema.json").read_bytes()
    released = (ROOT / "release" / "schema" / "agent-host-v13.schema.json").read_bytes()
    assert packaged == released


# --------------------------------------------------------------------- #
# 2. Effect-id capacity
# --------------------------------------------------------------------- #
@pytest.mark.parametrize("path", SCHEMAS, ids=lambda p: p.name)
def test_schema_effect_enums_carry_six_ids(path):
    enums = _collect_enum_values(_load(path), "effectId")
    assert enums, f"{path} has no effectId enum"
    for enum in enums:
        assert enum == EXPECTED_EFFECTS


def test_python_effect_id_tables_agree():
    from python.astra_bridge import p3_effect_contract, p3_host_context

    assert p3_effect_contract.EFFECT_IDS == EXPECTED_EFFECTS
    assert p3_host_context._EFFECT_IDS == EXPECTED_EFFECTS
    assert EFFECT_IDS == EXPECTED_EFFECTS


def test_typescript_capacity_constants_are_six_ids_with_public_bound_two():
    session = AGENT_SESSION.read_text(encoding="utf-8")
    assert re.search(r"AGENT_MAX_EFFECTS = 6 as const", session)
    assert re.search(r"AGENT_MAX_EFFECT_OPTION = 2 as const", session)
    assert re.search(r"AGENT_MAX_METHOD_LOADS = 4 as const", session)
    # The root session must admit the internal method+tool capacity of six.
    # The public `maxEffects` option stays bounded at two in the option
    # capture/runtime layer; the extra ids are never grantable through it.
    assert "boundedInt(options.maxEffects, 0, AGENT_MAX_EFFECTS)" in session
    assert _list_after(session, "const EFFECT_IDS") == EXPECTED_EFFECTS

    gate = P3_GATE.read_text(encoding="utf-8")
    assert re.search(r"P3_MAX_EFFECTS = 6 as const", gate)

    data = P3_EFFECT_DATA.read_text(encoding="utf-8")
    assert _list_after(data, "const EFFECT_IDS") == EXPECTED_EFFECTS


def test_caller_facing_effect_budget_stays_bounded_at_two():
    """The extra ids are capacity, not a widened user-visible tool budget.

    `python/astra_bridge/agent_runtime.py` must keep rejecting ``max_effects``
    above two, so the Host never grants a third tool effect through the public
    option; only the bounded method-load quota may add ids.
    """
    runtime = (ROOT / "python" / "astra_bridge" / "agent_runtime.py").read_text(encoding="utf-8")
    assert "not 0 <= max_effects <= 2" in runtime
    assert "not 0 <= max_method_loads <= 4" in runtime


# --------------------------------------------------------------------- #
# 3. The Host boundary accepts every whitelisted name
# --------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def manifests():
    return {
        "p3": p3_host_protocol.load_manifest(),
        "v13": agent_protocol.load_manifest(),
        "legacy": agent_protocol.load_legacy_manifest(),
    }


@pytest.mark.parametrize("name", EXPECTED_TOOLS)
def test_each_whitelisted_tool_name_validates_at_host_boundary(name, manifests):
    parsed = parse_request(json.dumps(effect_request(tool_action(name))).encode("utf-8"))
    assert parsed["action"]["name"] == name

    action = p3_host_context.parse_action(json.dumps(tool_action(name)), dict(BINDING))
    assert action["name"] == name

    p3_host_protocol.payload(manifests["p3"], "tool.execute", "params", tool_frame(name))
    agent_protocol.payload(
        manifests["v13"],
        "tool.execute",
        "params",
        tool_frame(name, version=agent_protocol.AGENT_HOST_VERSION),
    )
    if name in EXPECTED_TOOLS[:8]:
        agent_protocol.payload(
            manifests["legacy"],
            "tool.execute",
            "params",
            tool_frame(name, version=agent_protocol.AGENT_HOST_LEGACY_VERSION),
        )


@pytest.mark.parametrize(
    "name",
    ["shell_exec", "solve_system_guarded_expr", "real_root_count", "polynomial_expand_coefficients "],
)
def test_unlisted_tool_name_is_refused_at_host_boundary(name, manifests):
    with pytest.raises(ProtocolError):
        parse_request(json.dumps(effect_request(tool_action(name))).encode("utf-8"))
    with pytest.raises(ProbeError):
        p3_host_context.parse_action(json.dumps(tool_action(name)), dict(BINDING))
    with pytest.raises(ProtocolError):
        p3_host_protocol.payload(manifests["p3"], "tool.execute", "params", tool_frame(name))


# --------------------------------------------------------------------- #
# 4. effect-6 admitted, effect-7 refused, effect-1/2 unchanged
# --------------------------------------------------------------------- #
def test_effect_six_is_admitted_everywhere(manifests):
    parsed = parse_request(json.dumps(effect_request(effect_id="effect-6")).encode("utf-8"))
    assert parsed["effectId"] == "effect-6"
    built = receipt(parsed, "COMPLETE", '{"ok":true}')
    assert built["effectId"] == "effect-6"
    assert built["level"] == "PROVISIONAL"
    assert built["checkResult"] == "UNKNOWN"

    p3_host_protocol.payload(
        manifests["p3"], "tool.execute", "params", tool_frame(EXPECTED_TOOLS[0], "effect-6")
    )
    agent_protocol.payload(
        manifests["v13"],
        "tool.execute",
        "params",
        tool_frame(EXPECTED_TOOLS[0], "effect-6", agent_protocol.AGENT_HOST_VERSION),
    )


def test_effect_seven_is_refused(manifests):
    with pytest.raises(ProtocolError):
        parse_request(json.dumps(effect_request(effect_id="effect-7")).encode("utf-8"))
    with pytest.raises(ProtocolError):
        p3_host_protocol.payload(
            manifests["p3"], "tool.execute", "params", tool_frame(EXPECTED_TOOLS[0], "effect-7")
        )
    with pytest.raises(ProtocolError):
        agent_protocol.payload(
            manifests["v13"],
            "tool.execute",
            "params",
            tool_frame(EXPECTED_TOOLS[0], "effect-7", agent_protocol.AGENT_HOST_VERSION),
        )


def test_effect_one_and_two_identity_is_unchanged():
    for index, effect_id in enumerate(("effect-1", "effect-2")):
        assert EFFECT_IDS[index] == effect_id
        parsed = parse_request(json.dumps(effect_request(effect_id=effect_id)).encode("utf-8"))
        assert parsed["effectId"] == effect_id
        built = receipt(parsed, "COMPLETE", '{"ok":true}')
        assert built["effectId"] == effect_id
        assert built["source"] == "PROGRAM_OBSERVATION"
        key = p3_host_context.effect_key(tool_action(EXPECTED_TOOLS[0]))
        assert len(key) == 64


def test_method_action_still_validates_and_stays_method_sourced():
    request = effect_request({"action": "method", "id": "gauss-elimination"})
    parsed = parse_request(json.dumps(request).encode("utf-8"))
    built = receipt(parsed, "COMPLETE", '{"method":"loaded"}')
    assert built["source"] == "METHOD_REFERENCE"
    assert built["effectId"] == "effect-1"


# --------------------------------------------------------------------- #
# 5. The four added names are really dispatched with an input contract
# --------------------------------------------------------------------- #
def test_added_tools_have_dispatch_entry_and_input_contract():
    from math_families.bridge.dispatch import tool_names
    from mathagent.input_contracts import validate_inputs

    registered = set(tool_names())
    cases = {
        "real_root_count_expr": {"expression": "x**2-1", "variable": "x"},
        "splitting_field_degree_expr": {"expression": "x**2-2", "variable": "x"},
        "circle_laplacian_expr": {"expression": "cos(2*theta)"},
        "planar_laplacian_expr": {"expression": "x**2*y", "variables": ["x", "y"]},
    }
    assert set(cases) == set(NEW_TOOLS)
    for name, args in cases.items():
        assert name in registered
        validate_inputs(name, args)


def test_exact_data_tools_have_dispatch_entry_and_input_contract():
    from mathagent.exact_data_checks import TOOL_FUNCTIONS
    from mathagent.input_contracts import validate_inputs

    cases = {
        "interpolation_fit_check": {
            "points": [{"x": "0", "y": "0"}, {"x": "1", "y": "1"}],
            "expression": "x",
            "variable": "x",
        },
        "stats_ols_check": {
            "data": [
                {"x": "0", "y": "0"},
                {"x": "1", "y": "1"},
                {"x": "2", "y": "2"},
            ]
        },
    }
    assert set(cases) == set(EXACT_DATA_TOOLS)
    for name, args in cases.items():
        assert name in TOOL_FUNCTIONS
        validate_inputs(name, args)


def test_finite_group_tool_has_dispatch_entry_and_input_contract():
    from mathagent.exact_data_checks import TOOL_FUNCTIONS
    from mathagent.finite_group_tools import TOOL_FUNCTIONS as GROUP_FUNCTIONS
    from mathagent.input_contracts import validate_inputs

    assert set(GROUP_TOOLS) == {"finite_group_structure"}
    for name in GROUP_TOOLS:
        assert name in TOOL_FUNCTIONS
        assert name in GROUP_FUNCTIONS
        validate_inputs(name, {"generators": ["(12)", "(123)"], "degree": 3})


def test_new_expression_tools_accept_python_power_syntax_directly():
    from math_families.bridge.dispatch import call_tool

    cases = [
        ("real_root_count_expr", {"expression": "x**3-3*x+1", "variable": "x"}, 3),
        ("splitting_field_degree_expr", {"expression": "x**4+5", "variable": "x"}, 8),
        ("circle_laplacian_expr", {"expression": "theta**2"}, 2),
        ("planar_laplacian_expr", {"expression": "x**2+y**2", "variables": ["x", "y"]}, 4),
    ]
    for name, args, expected in cases:
        receipt = call_tool(name, args)
        assert receipt["status"] == "ok", (name, receipt)
        assert receipt["result"] == expected, (name, receipt["result"])


def test_registered_executor_accepts_caret_power_syntax_for_new_tools():
    import time

    from mathagent.tools import RegisteredExecutor

    executor = RegisteredExecutor()
    cases = [
        ("real_root_count_expr", {"expression": "x^3-3*x+1", "variable": "x"}, 3),
        ("splitting_field_degree_expr", {"expression": "x^4+5", "variable": "x"}, 8),
        ("circle_laplacian_expr", {"expression": "theta^2"}, 2),
        ("planar_laplacian_expr", {"expression": "x^2+y^2", "variables": ["x", "y"]}, 4),
    ]
    for name, args, expected in cases:
        result = executor.execute(
            name, args, deadline=time.monotonic() + 30, scope="caret syntax probe"
        )
        assert result.status == "ok", (name, result)
        assert str(result.result) == str(expected), (name, result.result)


def _collect_named(node, name):
    out = []
    if isinstance(node, dict):
        if name in node:
            out.append(node[name])
        for value in node.values():
            out.extend(_collect_named(value, name))
    elif isinstance(node, list):
        for value in node:
            out.extend(_collect_named(value, name))
    return out


def test_legacy_manifest_keeps_its_eight_tool_enum():
    """The frozen 1.2 contract keeps its historical eight-name tool vocabulary."""
    enums = _collect_enum_values(_load(LEGACY_SCHEMA), "name")
    assert enums, "legacy manifest has no tool-name enum"
    for enum in enums:
        assert enum == EXPECTED_TOOLS[:8], enum


def test_legacy_manifest_keeps_its_narrow_effect_table():
    """The frozen 1.2 contract must not inherit the live six-id capacity."""
    data = _load(LEGACY_SCHEMA)
    enums = _collect_enum_values(data, "effectId")
    assert enums, "legacy manifest has no effectId enum"
    for enum in enums:
        assert enum == ("effect-1", "effect-2"), enum
    bounds = _collect_named(data, "effectCalls")
    assert bounds, "legacy manifest has no effectCalls schema"
    for value in bounds:
        assert isinstance(value, dict)
        assert value.get("maximum") == 3, value


@pytest.mark.parametrize("path", SCHEMAS, ids=lambda p: p.name)
def test_summary_effect_call_bound_admits_four_methods_plus_two_tools(path):
    values = _collect_named(_load(path), "effectCalls")
    assert values, f"{path} has no effectCalls schema"
    for value in values:
        assert isinstance(value, dict)
        assert value.get("maximum") == 6, (path, value)


def _agent_init_params(max_method_loads):
    return {
        "protocolVersion": agent_protocol.AGENT_HOST_VERSION,
        "sessionId": BINDING["sessionId"],
        "profileId": "math-agent-preview-v2",
        "capabilities": {
            "modelGenerate": "AVAILABLE",
            "toolExecute": "AVAILABLE",
            "methodLoad": "AVAILABLE",
            "generatedPython": "UNAVAILABLE",
            "maxTokens": 8192,
            "maxTokensVerified": False,
            "journal": "IN_MEMORY_ONLY",
            "requireExplicitFinishForTools": True,
        },
        "remainingMs": 5000,
        "maxModelCalls": 8,
        "maxWorkUnits": 2,
        "maxEffects": 2,
        "maxReviews": 0,
        "maxMethodLoads": max_method_loads,
        "policy": "BEST_EFFORT",
    }


def _p3_init_params(max_method_loads):
    return {
        "protocolVersion": p3_host_protocol.P3_HOST_VERSION,
        "sessionId": BINDING["sessionId"],
        "remainingMs": 4000,
        "maxModelCalls": 3,
        "maxEffects": 2,
        "maxMethodLoads": max_method_loads,
        "maxTokens": 8192,
        "mode": "MOCK_ONLY",
    }


def test_runtime_initialize_admits_four_method_loads(manifests):
    agent_protocol.payload(
        manifests["v13"], "runtime.initialize", "params", _agent_init_params(4)
    )
    p3_host_protocol.payload(
        manifests["p3"], "runtime.initialize", "params", _p3_init_params(4)
    )


def test_runtime_initialize_rejects_five_method_loads(manifests):
    with pytest.raises(ProtocolError):
        agent_protocol.payload(
            manifests["v13"], "runtime.initialize", "params", _agent_init_params(5)
        )
    with pytest.raises(ProtocolError):
        p3_host_protocol.payload(
            manifests["p3"], "runtime.initialize", "params", _p3_init_params(5)
        )
