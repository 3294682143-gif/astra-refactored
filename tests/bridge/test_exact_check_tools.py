"""Generic exact-check and bounded-enumeration tools."""

from __future__ import annotations

from math_families.bridge.dispatch import call_tool
from mathagent.input_contracts import validate_inputs


def _result(name, args):
    receipt = call_tool(name, args)
    assert receipt["status"] == "ok", receipt
    return receipt["result"]


def test_trig_reduce_returns_fourier_coefficients():
    result = _result(
        "exact_check_expr",
        {
            "operation": "TRIG_REDUCE",
            "expression": "6*(cos(x)+1)**3",
            "variable": "x",
        },
    )
    assert result["difference"] == "0"
    assert "45*cos(x)/2" in result["trig_reduced"]
    assert "9*cos(2*x)" in result["trig_reduced"]
    assert "3*cos(3*x)/2" in result["trig_reduced"]


def test_maximal_minors_reports_complete_polynomial():
    matrix = [
        ["-t**2+2*t-1", "-t", "t", "t**2-2*t+1"],
        ["t**2-2*t+1", "-t**2+2*t-1", "-t", "t"],
        ["t", "t**2-2*t+1", "-t**2+2*t-1", "-t"],
        ["-t", "t", "t**2-2*t+1", "-t**2+2*t-1"],
    ]
    result = _result(
        "exact_check_expr",
        {"operation": "MAXIMAL_MINORS", "matrix": matrix, "variable": "t"},
    )
    assert result["minor_size"] == 3
    assert result["zero_minors"] is False
    assert result["normalized_minors"] == [
        {
            "polynomial": "t**6 - 5*t**5 + 10*t**4 - 13*t**3 + 10*t**2 - 5*t + 1",
            "multiplicity": 16,
        }
    ]


def test_factor_over_extension_distinguishes_too_small_field():
    too_small = _result(
        "exact_check_expr",
        {
            "operation": "FACTOR_OVER_EXTENSION",
            "expression": "x**4+5",
            "variable": "x",
            "minimal_polynomials": ["x**4-5", "x**2+1"],
        },
    )
    assert too_small["splits_completely"] is False
    assert too_small["residual_degree"] > 0

    complete = _result(
        "exact_check_expr",
        {
            "operation": "FACTOR_OVER_EXTENSION",
            "expression": "x**4+5",
            "variable": "x",
            "minimal_polynomials": ["x**4+5", "x**2+1"],
        },
    )
    assert complete["splits_completely"] is True
    assert complete["residual_degree"] == 0


def test_density_check_rejects_unnormalized_candidate():
    bad = _result(
        "exact_check_expr",
        {
            "operation": "DENSITY_CHECK",
            "density": "4*exp(-x**2/2)/sqrt(2*pi)*(1+erf(x/2))/2",
            "variable": "x",
            "lower": "0",
            "upper": "oo",
        },
    )
    assert bad["normalized"] is False

    good = _result(
        "exact_check_expr",
        {
            "operation": "DENSITY_CHECK",
            "density": "2*exp(-x**2/5)/sqrt(5*pi)",
            "variable": "x",
            "lower": "0",
            "upper": "oo",
        },
    )
    assert good["normalized"] is True


def test_bounded_enumeration_counts_explicit_subsets():
    result = _result(
        "bounded_enumeration",
        {
            "objects": [[0, 0], [0, 1], [1, 0], [1, 1]],
            "choose": 2,
            "predicate": "distinct(0) > distinct(1)",
        },
    )
    assert result["favorable"] == 2
    assert result["total"] == 6
    assert result["fraction"] == "1/3"
    assert result["complete_for_input"] is True


def test_new_tools_have_registered_input_contracts():
    validate_inputs(
        "exact_check_expr",
        {"operation": "TRIG_REDUCE", "expression": "cos(x)", "variable": "x"},
    )
    validate_inputs(
        "bounded_enumeration",
        {"objects": [[0], [1]], "choose": 1, "predicate": "distinct(0) > 0"},
    )


def test_host_certificate_marker_matches_node_rule():
    from python.astra_bridge.agent_history import _is_certified_packet

    assert _is_certified_packet(
        {
            "suggestedChecks": [
                "CERT1|CHECK|C1|RECOMPUTE|x => PASS",
                "CERT1|FINAL|A、C",
            ]
        }
    )
    assert not _is_certified_packet({"suggestedChecks": ["CERT1|FINAL|A、C"]})
    assert not _is_certified_packet(
        {"suggestedChecks": ["CERT1|CHECK|C1|RECOMPUTE|x => PASS"]}
    )
