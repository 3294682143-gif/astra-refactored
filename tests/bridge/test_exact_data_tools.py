"""Focused execution tests for the two exact data-check tools.

Every call goes through the real ``RegisteredExecutor`` boundary, including its
input contract, isolated worker, producer and independent output audit.  Numeric
claims in the payload must remain exact rational strings; a float is a failure.
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
        scope="exact data check probe",
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


def test_interpolation_reports_exact_zero_residuals_on_three_point_quadratic():
    result = _execute(
        "interpolation_fit_check",
        {
            "points": [
                {"x": "0", "y": "1"},
                {"x": "1", "y": "4"},
                {"x": "2", "y": "9"},
            ],
            "expression": "x^2+2*x+1",
            "variable": "x",
        },
    )
    assert result.status == "ok", (result.status, result.detail)
    assert result.evidence_kind == "EXACT_FOR_INPUT"
    payload = result.result
    assert payload == {
        "schema": "interpolation-fit-check-v1",
        "operation": "INTERPOLATION_FIT",
        "variable": "x",
        "point_count": 3,
        "residuals": ["0", "0", "0"],
        "all_zero": True,
        "degree": 2,
        "interpolating_polynomial": "x**2 + 2*x + 1",
    }
    _assert_no_float(payload)


def test_interpolation_reports_exact_nonzero_residuals_and_interpolant():
    result = _execute(
        "interpolation_fit_check",
        {
            "points": [
                {"x": "0", "y": "1"},
                {"x": "1", "y": "4"},
                {"x": "2", "y": "9"},
            ],
            "expression": "2*x+1",
            "variable": "x",
        },
    )
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload["residuals"] == ["0", "-1", "-4"]
    assert payload["all_zero"] is False
    assert payload["degree"] == 1
    assert payload["interpolating_polynomial"] == "x**2 + 2*x + 1"
    _assert_no_float(payload)


def test_interpolation_fractional_data_never_produces_a_float():
    result = _execute(
        "interpolation_fit_check",
        {
            "points": [
                {"x": "0", "y": "0"},
                {"x": "1", "y": "1/2"},
                {"x": "2", "y": "1"},
            ],
            "expression": "x/2",
            "variable": "x",
        },
    )
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload["residuals"] == ["0", "0", "0"]
    assert payload["interpolating_polynomial"] == "1/2*x"
    # parse_float is invoked only if the serialized payload contains a JSON float.
    decoded = json.loads(
        json.dumps(payload, allow_nan=False),
        parse_float=lambda text: pytest.fail(f"float in payload: {text}"),
    )
    _assert_no_float(decoded)


def test_ols_exact_coefficients_and_zero_residuals_without_a_claim():
    result = _execute(
        "stats_ols_check",
        {
            "data": [
                {"x": "1", "y": "2"},
                {"x": "2", "y": "4"},
                {"x": "3", "y": "6"},
            ]
        },
    )
    assert result.status == "ok", (result.status, result.detail)
    payload = result.result
    assert payload == {
        "schema": "stats-ols-check-v1",
        "operation": "OLS_CHECK",
        "n": 3,
        "slope": "2",
        "intercept": "0",
        "sse": "0",
        "sst": "8",
        "r_squared": "1",
        "claim_matches": None,
        "residuals": ["0", "0", "0"],
    }
    _assert_no_float(payload)


def test_ols_wrong_claim_matches_false_and_exact_claim_matches_true():
    data = [
        {"x": "0", "y": "1"},
        {"x": "1", "y": "3"},
        {"x": "2", "y": "5"},
        {"x": "3", "y": "7"},
    ]
    wrong = _execute(
        "stats_ols_check",
        {"data": data, "claimed": {"slope": "3", "intercept": "1"}},
    )
    assert wrong.status == "ok", (wrong.status, wrong.detail)
    assert wrong.result["claim_matches"] is False
    assert wrong.result["residuals"] == ["0", "0", "0", "0"]
    _assert_no_float(wrong.result)

    exact = _execute(
        "stats_ols_check",
        {"data": data, "claimed": {"slope": "2", "intercept": "1"}},
    )
    assert exact.status == "ok", (exact.status, exact.detail)
    assert exact.result["claim_matches"] is True
    assert exact.result["slope"] == "2"
    assert exact.result["intercept"] == "1"


def test_ols_degenerate_all_x_equal_is_refused_not_divided():
    result = _execute(
        "stats_ols_check",
        {
            "data": [
                {"x": "1", "y": "2"},
                {"x": "1", "y": "3"},
                {"x": "1", "y": "4"},
            ]
        },
    )
    assert result.status == "invalid_input"
    assert result.result is None
    assert "degenerate OLS" in result.detail


def test_interpolation_and_ols_bounds_are_refused_before_execution():
    too_many_points = _execute(
        "interpolation_fit_check",
        {
            "points": [
                {"x": str(index), "y": str(index)} for index in range(9)
            ],
            "expression": "x",
            "variable": "x",
        },
    )
    assert too_many_points.status == "out_of_scope"
    assert too_many_points.result is None

    too_many_pairs = _execute(
        "stats_ols_check",
        {
            "data": [
                {"x": str(index), "y": str(index)} for index in range(13)
            ]
        },
    )
    assert too_many_pairs.status == "out_of_scope"
    assert too_many_pairs.result is None

    too_high_degree = _execute(
        "interpolation_fit_check",
        {
            "points": [{"x": "0", "y": "0"}, {"x": "1", "y": "1"}],
            "expression": "x**3",
            "variable": "x",
        },
    )
    assert too_high_degree.status == "out_of_scope"
    assert too_high_degree.result is None


def test_non_exact_and_malformed_inputs_are_refused_without_a_partial_answer():
    non_exact = _execute(
        "interpolation_fit_check",
        {
            "points": [{"x": 0, "y": 1}, {"x": "1", "y": "2"}],
            "expression": "x",
            "variable": "x",
        },
    )
    assert non_exact.status == "invalid_input"
    assert non_exact.result is None

    unparsable = _execute(
        "interpolation_fit_check",
        {
            "points": [{"x": "0", "y": "0"}, {"x": "1", "y": "1"}],
            "expression": "x**",
            "variable": "x",
        },
    )
    assert unparsable.status == "invalid_input"
    assert unparsable.result is None

    two_variables = _execute(
        "interpolation_fit_check",
        {
            "points": [{"x": "0", "y": "0"}, {"x": "1", "y": "1"}],
            "expression": "x+y",
            "variable": "x",
        },
    )
    assert two_variables.status == "invalid_input"
    assert two_variables.result is None

    duplicate_x = _execute(
        "interpolation_fit_check",
        {
            "points": [{"x": "0", "y": "0"}, {"x": "0", "y": "1"}],
            "expression": "x",
            "variable": "x",
        },
    )
    assert duplicate_x.status == "invalid_input"
    assert duplicate_x.result is None
