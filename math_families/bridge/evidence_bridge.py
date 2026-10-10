"""Bridge: math_families Evidence -> state_engine ToolEvidence-shaped dicts.

The shape mirrors state_engine's tools/registry.py ToolEvidence:
    status: ok | partial | unsupported | invalid_input | resource_limited | error
    result: candidate-free payload
    assumptions / warnings: tuple[str]
    method: str
    certificate: free-form
    completeness: complete | partial | unknown

Local adaptation: self_check is diagnostic text only. Successful execution
always has unknown mathematical completeness; the host's explicit contract and
independent checker decide evidence scope, never string markers.
- feasibility "infeasible: .." -> status=resource_limited, result=None
- status passthrough for invalid inputs is the caller's responsibility
  (validate args before calling the family tool).

The bridge never writes Evidence.value into a candidate-shaped field and
never emits final_answer/candidate/solved keys.
"""
from __future__ import annotations

from typing import Any

from math_families.core.evidence import Evidence

_FORBIDDEN_RESULT_KEYS = frozenset({"final_answer", "candidate", "solved"})


def to_tool_evidence_dict(
    ev: Evidence,
    *,
    method: str,
    assumptions: tuple[str, ...] = (),
    warnings: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Convert a math_families Evidence into a state_engine ToolEvidence
    shaped dict, applying the conservative status/completeness mapping."""
    if not isinstance(ev, Evidence):
        raise TypeError(f"expected Evidence, got {type(ev).__name__}")

    result = ev.value
    if isinstance(result, dict):
        bad = _FORBIDDEN_RESULT_KEYS & set(result)
        if bad:
            raise ValueError(f"family result carries forbidden keys: {sorted(bad)}")

    if ev.feasibility.startswith("infeasible"):
        status, result_out, completeness = "resource_limited", None, "unknown"
        warnings = warnings + (ev.feasibility,)
    else:
        status, result_out, completeness = "ok", result, "unknown"

    return {
        "status": status,
        "result": result_out,
        "assumptions": list(assumptions),
        "method": method,
        "certificate": {
            "certificate": ev.certificate,
            "self_check": ev.self_check,
            "complexity_bound": ev.complexity_bound,
        },
        "completeness": completeness,
        "warnings": list(warnings),
    }


def family_error(exc: Exception, *, method: str) -> dict[str, Any]:
    """Structured error record for a failed family call."""
    return {
        "status": "error",
        "result": None,
        "assumptions": [],
        "method": method,
        "certificate": None,
        "completeness": "unknown",
        "warnings": [f"{type(exc).__name__}: {exc}"],
    }
