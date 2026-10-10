"""Offline protocol tests for the lightweight typed-action path."""

import json

import pytest

from mathagent.lite.protocol import (
    FinalAction,
    LiteProtocolError,
    ToolAction,
    UnsolvedAction,
    parse_action,
    parse_lite_delivery,
)


def test_tool_action_parsed():
    action = parse_action(
        json.dumps(
            {
                "action": "tool",
                "name": "polynomial_expand_coefficients",
                "args": {"expression": ["+", "x", 1]},
                "scope": "expand",
            }
        )
    )
    assert isinstance(action, ToolAction)
    assert action.name == "polynomial_expand_coefficients"
    assert action.args == {"expression": ["+", "x", 1]}
    assert action.scope == "expand"


def test_final_action_parsed():
    action = parse_action(
        json.dumps(
            {"action": "final", "answer": "42", "complete": True, "unresolved": []}
        )
    )
    assert isinstance(action, FinalAction)
    assert action.answer == "42"
    assert action.complete is True
    assert action.unresolved == ()


def test_unsolved_action_parsed():
    action = parse_action(json.dumps({"action": "unsolved", "reason": "no idea"}))
    assert isinstance(action, UnsolvedAction)
    assert action.reason == "no idea"


@pytest.mark.parametrize(
    "text,code",
    [
        ("not json", "malformed_json"),
        ("[1,2,3]", "action_not_object"),
        ('{"answer":"x"}', "missing_action"),
        ('{"action":"nope"}', "unknown_action"),
        ('{"action":"tool","name":"os_system","args":{},"scope":"s"}', "tool_not_allowed"),
        ('{"action":"tool","name":"polynomial_expand_coefficients","args":[],"scope":"s"}', "tool_args_not_object"),
        ('{"action":"tool","name":"polynomial_expand_coefficients","args":{},"scope":"  "}', "invalid_scope"),
        ('{"action":"tool","name":"polynomial_expand_coefficients","args":{},"scope":"s","extra":1}', "unexpected_fields"),
        ('{"action":"final","answer":"","complete":true,"unresolved":[]}', "empty_answer"),
        ('{"action":"final","answer":"x","complete":"yes","unresolved":[]}', "complete_not_bool"),
        ('{"action":"final","answer":"x","complete":true,"unresolved":"none"}', "unresolved_not_list"),
        ('{"action":"final","answer":"x","complete":true,"unresolved":[1]}', "invalid_unresolved"),
        ('{"action":"unsolved","reason":""}', "invalid_reason"),
        ('{"action":"unsolved","reason":"r","extra":1}', "unexpected_fields"),
    ],
)
def test_invalid_actions_rejected(text, code):
    with pytest.raises(LiteProtocolError) as exc:
        parse_action(text)
    assert exc.value.code == code


def test_duplicate_top_level_field_rejected():
    with pytest.raises(LiteProtocolError) as exc:
        parse_action('{"action":"unsolved","reason":"a","reason":"b"}')
    assert exc.value.code == "duplicate_field"


def test_duplicate_nested_field_rejected():
    with pytest.raises(LiteProtocolError) as exc:
        parse_action(
            '{"action":"tool","name":"polynomial_expand_coefficients",'
            '"args":{"expression":1,"expression":2},"scope":"s"}'
        )
    assert exc.value.code == "duplicate_field"


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity", "1e999", "-1e999"])
def test_non_finite_numbers_rejected(token):
    with pytest.raises(LiteProtocolError) as exc:
        parse_action(
            '{"action":"tool","name":"polynomial_expand_coefficients",'
            '"args":{"expression":' + token + '},"scope":"s"}'
        )
    assert exc.value.code == "non_finite_number"


def test_deep_nesting_rejected():
    payload = "1"
    for _ in range(60):
        payload = "[" + payload + "]"
    with pytest.raises(LiteProtocolError) as exc:
        parse_action(
            '{"action":"tool","name":"polynomial_expand_coefficients",'
            '"args":{"expression":' + payload + '},"scope":"s"}'
        )
    assert exc.value.code == "nesting_too_deep"


def test_oversized_action_rejected():
    with pytest.raises(LiteProtocolError) as exc:
        parse_action('{"action":"unsolved","reason":"' + "a" * 30000 + '"}')
    assert exc.value.code == "action_too_large"


def test_delivery_requires_complete_transport():
    ok = parse_lite_delivery(
        '{"action":"unsolved","reason":"r"}',
        finish_reason=None,
        transport_complete=True,
        complete_public_return=True,
    )
    assert ok.delivered and ok.valid
    truncated = parse_lite_delivery(
        '{"action":"unsolved","reason":"r"}',
        finish_reason="length",
        transport_complete=True,
        complete_public_return=True,
    )
    assert not truncated.delivered and not truncated.valid
    late = parse_lite_delivery(
        '{"action":"unsolved","reason":"r"}',
        finish_reason="stop",
        transport_complete=False,
        complete_public_return=False,
    )
    assert not late.delivered and not late.valid
    empty = parse_lite_delivery(
        "   ",
        finish_reason="stop",
        transport_complete=True,
        complete_public_return=True,
    )
    assert not empty.valid
