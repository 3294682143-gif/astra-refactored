"""Focused execution tests for the finite permutation-group structure tool.

Every call goes through the real ``RegisteredExecutor`` boundary, including its
input contract, isolated worker, producer and independent output audit.  The
tool reports only exact integer bookkeeping for explicitly supplied
permutations; every payload must be float-free.
"""

from __future__ import annotations

import json
import time

import pytest

from mathagent.tools import RegisteredExecutor


def _execute(name, args):
    executor = RegisteredExecutor()
    return executor.execute(
        name,
        args,
        deadline=time.monotonic() + 30,
        scope="finite group structure probe",
    )


def _assert_no_float(value):
    assert type(value) is not float
    if isinstance(value, dict):
        for key, item in value.items():
            assert type(key) is str
            _assert_no_float(item)
    elif isinstance(value, list):
        for item in value:
            _assert_no_float(item)
    else:
        assert type(value) in {str, int, bool} or value is None


def _order_classes(payload):
    return sorted(
        (row["size"], row["element_order"]) for row in payload["conjugacy_classes"]
    )


def test_s3_order_classes_and_nonabelian_flag():
    result = _execute(
        "finite_group_structure",
        {"generators": ["(12)", "(123)"]},
    )
    assert result.status == "ok", (result.status, result.detail)
    assert result.evidence_kind == "EXACT_FOR_INPUT"
    payload = result.result
    assert payload["schema"] == "finite-group-structure-v1"
    assert payload["operation"] == "GROUP_STRUCTURE"
    assert payload["degree"] == 3
    assert payload["generator_count"] == 2
    assert payload["order"] == 6
    assert payload["is_abelian"] is False
    assert payload["is_cyclic"] is False
    assert payload["exponent"] == 6
    assert payload["center_size"] == 1
    assert payload["element_orders"] == {"1": 1, "2": 3, "3": 2}
    assert len(payload["conjugacy_classes"]) == 3
    assert _order_classes(payload) == [(1, 1), (2, 3), (3, 2)]
    _assert_no_float(payload)


def test_a4_order_and_four_conjugacy_classes():
    result = _execute(
        "finite_group_structure",
        {"generators": ["(123)", "(124)"]},
    )
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload["degree"] == 4
    assert payload["order"] == 12
    assert payload["is_abelian"] is False
    assert payload["is_cyclic"] is False
    assert payload["exponent"] == 6
    assert payload["element_orders"] == {"1": 1, "2": 3, "3": 8}
    assert len(payload["conjugacy_classes"]) == 4
    assert _order_classes(payload) == [(1, 1), (3, 2), (4, 3), (4, 3)]
    assert [row["size"] for row in payload["conjugacy_classes"]] == [1, 3, 4, 4]
    _assert_no_float(payload)


def test_cyclic_c6_is_abelian_with_six_singleton_classes():
    result = _execute(
        "finite_group_structure",
        {"generators": ["(123456)"]},
    )
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload["degree"] == 6
    assert payload["order"] == 6
    assert payload["is_abelian"] is True
    assert payload["is_cyclic"] is True
    assert payload["exponent"] == 6
    assert payload["center_size"] == 6
    assert payload["element_orders"] == {"1": 1, "2": 1, "3": 2, "6": 2}
    assert len(payload["conjugacy_classes"]) == 6
    assert all(row["size"] == 1 for row in payload["conjugacy_classes"])
    _assert_no_float(payload)


def test_identity_only_group_and_canonical_normalization():
    result = _execute(
        "finite_group_structure",
        {"generators": ["()"], "degree": 4},
    )
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload == {
        "schema": "finite-group-structure-v1",
        "operation": "GROUP_STRUCTURE",
        "input_mode": "generators",
        "degree": 4,
        "generator_count": 1,
        "order": 1,
        "is_abelian": True,
        "is_cyclic": True,
        "exponent": 1,
        "center_size": 1,
        "element_orders": {"1": 1},
        "conjugacy_classes": [
            {"size": 1, "representative": "()", "element_order": 1}
        ],
        "derived_size": 1,
        "subgroup_summary": [
            {
                "order": 1,
                "count": 1,
                "normal_count": 1,
                "all_abelian": True,
                "all_cyclic": True,
                "has_cyclic": True,
            }
        ],
    }
    _assert_no_float(payload)

    # Cycle rotation, spaces and fixed points normalize to the same canonical
    # generator notation; the group result must be byte-for-byte identical.
    plain = _execute("finite_group_structure", {"generators": ["(123)", "(12)"]})
    rotated = _execute(
        "finite_group_structure",
        {"generators": ["(3 1 2)", "(2 1)(4)"], "degree": 4},
    )
    assert plain.status == rotated.status == "ok"
    assert plain.result["order"] == rotated.result["order"] == 6
    assert plain.result["element_orders"] == rotated.result["element_orders"]
    assert plain.result["conjugacy_classes"] == rotated.result["conjugacy_classes"]


def test_malformed_cycle_notation_is_refused_without_a_payload():
    for generators in (
        ["(12"],
        ["(12))"],
        ["(1,,2)"],
        ["(1 2) x"],
        ["(12)(1)"],
        ["(0)"],
        ["(1a)"],
    ):
        result = _execute("finite_group_structure", {"generators": generators})
        assert result.status == "invalid_input", (generators, result.status)
        assert result.result is None


def test_degree_mismatch_is_refused_without_a_payload():
    result = _execute(
        "finite_group_structure",
        {"generators": ["(1234)"], "degree": 3},
    )
    assert result.status == "invalid_input"
    assert result.result is None

    bad_degree = _execute(
        "finite_group_structure",
        {"generators": ["(12)"], "degree": 9},
    )
    assert bad_degree.status == "out_of_scope"
    assert bad_degree.result is None


def test_more_than_four_generators_is_out_of_scope():
    result = _execute(
        "finite_group_structure",
        {"generators": ["()", "()", "()", "()", "()"], "degree": 2},
    )
    assert result.status == "out_of_scope"
    assert result.result is None


def test_closure_element_cap_refuses_a_larger_group():
    result = _execute(
        "finite_group_structure",
        {"generators": ["(12345678)", "(12)"]},
    )
    assert result.status == "out_of_scope"
    assert result.result is None


def test_payload_has_no_float_even_after_json_roundtrip():
    result = _execute(
        "finite_group_structure",
        {"generators": ["(123)", "(124)"]},
    )
    assert result.status == "ok", (result.status, result.detail)
    decoded = json.loads(
        json.dumps(result.result, allow_nan=False),
        parse_float=lambda text: pytest.fail(f"float in payload: {text}"),
    )
    _assert_no_float(decoded)


def test_named_a4_has_order_twelve_and_four_conjugacy_classes():
    result = _execute("finite_group_structure", {"named_group": "A4"})
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload["input_mode"] == "named_group"
    assert payload["group_name"] == "A4"
    assert payload["degree"] == 4
    assert payload["generator_count"] == 2
    assert payload["order"] == 12
    assert payload["is_abelian"] is False
    assert payload["is_cyclic"] is False
    assert payload["exponent"] == 6
    assert payload["center_size"] == 1
    assert payload["element_orders"] == {"1": 1, "2": 3, "3": 8}
    assert len(payload["conjugacy_classes"]) == 4
    assert [row["size"] for row in payload["conjugacy_classes"]] == [1, 3, 4, 4]
    _assert_no_float(payload)


def test_named_z6_and_c6_match_apart_from_the_group_name():
    z6 = _execute("finite_group_structure", {"named_group": "Z6"})
    c6 = _execute("finite_group_structure", {"named_group": "C6"})
    assert z6.status == c6.status == "ok", (z6.detail, c6.detail)
    assert z6.result["group_name"] == "Z6"
    assert c6.result["group_name"] == "C6"
    without_name = dict(z6.result)
    without_name.pop("group_name")
    c6_without_name = dict(c6.result)
    c6_without_name.pop("group_name")
    assert without_name == c6_without_name
    assert z6.result["order"] == 6
    assert z6.result["is_cyclic"] is True


def test_named_d8_has_order_eight_and_is_nonabelian():
    result = _execute("finite_group_structure", {"named_group": "D8"})
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload["input_mode"] == "named_group"
    assert payload["group_name"] == "D8"
    assert payload["degree"] == 4
    assert payload["order"] == 8
    assert payload["is_abelian"] is False
    assert payload["is_cyclic"] is False
    assert payload["exponent"] == 4
    assert payload["center_size"] == 2


def test_named_s3_matches_the_explicit_generator_payload():
    named = _execute("finite_group_structure", {"named_group": "S3"})
    explicit = _execute(
        "finite_group_structure",
        {"generators": ["(12)", "(123)"]},
    )
    assert named.status == explicit.status == "ok", (named.detail, explicit.detail)
    assert named.result["input_mode"] == "named_group"
    assert named.result["group_name"] == "S3"
    assert explicit.result["input_mode"] == "generators"
    assert "group_name" not in explicit.result
    comparable = dict(named.result)
    comparable.pop("group_name")
    comparable["input_mode"] = "generators"
    assert comparable == explicit.result


def test_named_klein_aliases_all_expand_to_v4():
    names = ("K_4", "K4", "V_4", "V4", "klein", "Klein", "克莱因四元群")
    results = [
        _execute("finite_group_structure", {"named_group": name})
        for name in names
    ]
    for name, result in zip(names, results):
        assert result.status == "ok", (name, result.status, result.detail)
        payload = result.result
        assert payload["input_mode"] == "named_group"
        assert payload["group_name"] == "V4"
        assert payload["degree"] == 4
        assert payload["order"] == 4
        assert payload["is_abelian"] is True
        assert payload["is_cyclic"] is False
        assert payload["exponent"] == 2
        assert payload["center_size"] == 4
        assert payload["element_orders"] == {"1": 1, "2": 3}
        assert payload["derived_size"] == 1
        assert payload["subgroup_summary"] == [
            {
                "order": 1,
                "count": 1,
                "normal_count": 1,
                "all_abelian": True,
                "all_cyclic": True,
                "has_cyclic": True,
            },
            {
                "order": 2,
                "count": 3,
                "normal_count": 3,
                "all_abelian": True,
                "all_cyclic": True,
                "has_cyclic": True,
            },
            {
                "order": 4,
                "count": 1,
                "normal_count": 1,
                "all_abelian": True,
                "all_cyclic": False,
                "has_cyclic": False,
            },
        ]
        _assert_no_float(payload)

    # Every spelling is canonicalized to exactly the same V4 payload.
    assert all(result.result == results[0].result for result in results)


def test_named_q8_has_order_eight_and_expected_subgroup_census():
    names = ("Q_8", "Q8", "quaternion", "四元数群")
    results = [
        _execute("finite_group_structure", {"named_group": name})
        for name in names
    ]
    for name, result in zip(names, results):
        assert result.status == "ok", (name, result.status, result.detail)
        payload = result.result
        assert payload["input_mode"] == "named_group"
        assert payload["group_name"] == "Q8"
        assert payload["degree"] == 8
        assert payload["order"] == 8
        assert payload["is_abelian"] is False
        assert payload["is_cyclic"] is False
        assert payload["exponent"] == 4
        assert payload["center_size"] == 2
        assert payload["element_orders"] == {"1": 1, "2": 1, "4": 6}
        assert payload["derived_size"] == 2
        assert payload["subgroup_summary"] == [
            {
                "order": 1,
                "count": 1,
                "normal_count": 1,
                "all_abelian": True,
                "all_cyclic": True,
                "has_cyclic": True,
            },
            {
                "order": 2,
                "count": 1,
                "normal_count": 1,
                "all_abelian": True,
                "all_cyclic": True,
                "has_cyclic": True,
            },
            {
                "order": 4,
                "count": 3,
                "normal_count": 3,
                "all_abelian": True,
                # The three order-4 subgroups are <i>, <j>, <k>; all cyclic.
                "all_cyclic": True,
                "has_cyclic": True,
            },
            {
                "order": 8,
                "count": 1,
                "normal_count": 1,
                "all_abelian": False,
                "all_cyclic": False,
                "has_cyclic": False,
            },
        ]
        _assert_no_float(payload)

    assert all(result.result == results[0].result for result in results)


def test_a4_has_no_subgroup_of_order_six():
    result = _execute("finite_group_structure", {"named_group": "A4"})
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload["derived_size"] == 4
    summary = {row["order"]: row for row in payload["subgroup_summary"]}
    assert sorted(summary) == [1, 2, 3, 4, 6, 12]
    assert summary[6] == {
        "order": 6,
        "count": 0,
        "normal_count": 0,
        "all_abelian": False,
        "all_cyclic": False,
        "has_cyclic": False,
    }
    assert summary[4]["all_abelian"] is True
    assert summary[4]["all_cyclic"] is False
    assert summary[4]["count"] == 1
    _assert_no_float(payload)


def test_d8_has_three_order_four_subgroups_and_all_are_abelian():
    result = _execute("finite_group_structure", {"named_group": "D8"})
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload["derived_size"] == 2
    summary = {row["order"]: row for row in payload["subgroup_summary"]}
    assert summary[4] == {
        "order": 4,
        "count": 3,
        "normal_count": 3,
        "all_abelian": True,
        "all_cyclic": False,
        "has_cyclic": True,
    }
    _assert_no_float(payload)


def test_groups_above_sixty_four_keep_the_old_payload_shape():
    # A direct product S4 x C3 on disjoint points has order 72 while remaining
    # well inside the explicit closure cap.
    result = _execute(
        "finite_group_structure",
        {"generators": ["(12)", "(1234)", "(567)"], "degree": 7},
    )
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload["order"] == 72
    assert "derived_size" not in payload
    assert "subgroup_summary" not in payload
    _assert_no_float(payload)


def test_named_group_refuses_unknown_and_out_of_vocabulary_names():
    for name in ("S5", "A6", "D12", "Z13", "C13", "Z1", "Q16", "K5"):
        result = _execute("finite_group_structure", {"named_group": name})
        assert result.status == "invalid_input", (name, result.status)
        assert result.result is None


def test_named_group_refuses_both_or_neither_input_form():
    for args in (
        {"generators": ["(12)", "(123)"], "named_group": "S3"},
        {},
        {"degree": 3},
    ):
        result = _execute("finite_group_structure", args)
        assert result.status == "invalid_input", (args, result.status)
        assert result.result is None
