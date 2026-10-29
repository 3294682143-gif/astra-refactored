"""Deterministic operation advice; not a second agent or dispatch authority."""

import re
from dataclasses import dataclass

OPERATION_FIELDS = (
    "TASK_MODE",
    "OPERATION",
    "EXPECTED_ARTIFACT",
    "BOUNDS",
    "CHECK_SCOPE",
)
OPERATIONS = {
    "polynomial_expand_coefficients",
    "coefficient_candidates",
    "substitution_residual",
    "linear_system_solution_set",
    "finite_graph",
    "bounded_enumeration",
    "dynamic_programming",
    "numeric_expression",
    "combined_operations",
}


@dataclass(frozen=True)
class ComputationIntent:
    mode: str = "UNKNOWN"
    operation: str = ""
    expected_artifact: str = ""
    bounds: str = ""
    check_scope: str = ""
    gap: str = ""
    schema: str = "computation-intent-v1"


def intent(goal, suggestion=None):
    suggestion = suggestion or {}
    proof = re.search(
        r"prove.*(?:must be.*polynomial|all (?:integers|natural|n\b)|infinite|all functions)|证明.*(?:必.*多项式|所有.*递推|无限)|enumerate.*(?:all real|infinite)|无限域.*枚举",
        goal,
        re.IGNORECASE,
    )
    if proof:
        return ComputationIntent(
            "REASON", gap="infinite scope or necessary reduction requires proof"
        )
    if suggestion:
        mode = suggestion.get("TASK_MODE", "UNKNOWN")
        op = suggestion.get("OPERATION", "")
        if mode not in {"REASON", "COMPUTE", "MIXED", "UNKNOWN"} or (
            op and op not in OPERATIONS
        ):
            return ComputationIntent(gap="invalid task mode or operation")
        values = [suggestion.get(k, "") for k in OPERATION_FIELDS[2:]]
        if mode in {"COMPUTE", "MIXED"} and (
            not op
            or not all(values)
            or any(x.upper() in {"UNKNOWN", "NONE", "UNBOUNDED"} for x in values)
        ):
            return ComputationIntent(
                gap="provide finite inputs/bounds, expected artifact and independent check scope"
            )
        return ComputationIntent(mode, op, *values)
    patterns = (
        (
            "polynomial_expand_coefficients",
            r"\bexpand\b.*(?:\^|\*\*|polynomial|\()|\b(?:extract|match|collect)\b.*coefficients|展开.*(?:多项式|\(|\^)|(?:提取|比较|匹配).*系数",
        ),
        (
            "linear_system_solution_set",
            r"(?:solve|compute).*\blinear (?:system|equations)|(?:求解|计算).*线性方程组",
        ),
        (
            "substitution_residual",
            r"(?:compute|evaluate|check).*substitution residual|(?:计算|检查).*代入残差",
        ),
        (
            "numeric_expression",
            r"(?:evaluate|compute).*\b(?:sqrt|sin|cos|log|exp)\s*\(|求值.*(?:sqrt|sin|cos|log|exp)\(",
        ),
    )
    for operation, pattern in patterns:
        if re.search(pattern, goal, re.IGNORECASE):
            return ComputationIntent(
                "COMPUTE",
                operation,
                "bounded operation output",
                gap="proposal still must bind exact inputs, domain and original mapping",
            )
    return ComputationIntent()


def choose_backend(spec, *, python_available=False):
    """Only a full matched input/output/check contract justifies a preset choice."""
    required = {
        "operation",
        "inputs",
        "domain",
        "expected_artifact",
        "bounds",
        "check_scope",
        "mapping",
    }
    if not required <= spec.keys() or any(not spec[k] for k in required):
        return {
            "backend": "BLOCKED",
            "gap": "missing mathematical input/mapping/bounds/output contract",
        }
    if spec.get("prior_failure") in {
        "invalid_input",
        "security_rejected",
        "mapping_unresolved",
        "out_of_scope",
    }:
        return {
            "backend": "BLOCKED",
            "gap": "repair the failed contract; Python is not a bypass",
        }
    libraries = set(spec.get("libraries", ()))
    if libraries - {"stdlib", "sympy", "mpmath"}:
        return {
            "backend": "BLOCKED",
            "gap": "required library unavailable in pinned WASI",
        }
    tool = spec["operation"]
    if tool in {"polynomial_expand_coefficients", "linear_system_solution_set"}:
        from .input_contracts import validate_inputs

        try:
            validate_inputs(tool, spec["inputs"])
        except ValueError as exc:
            return {"backend": "BLOCKED", "gap": str(exc)}
        outputs = {
            "polynomial_expand_coefficients": "coefficient_table",
            "linear_system_solution_set": "solution_set",
        }
        if (
            spec["expected_artifact"] == outputs[tool]
            and spec["check_scope"] == "exact_for_input"
        ):
            return {
                "backend": "REGISTERED",
                "tool": tool,
                "gap": "original mapping remains unverified",
            }
    # A solution-count interface cannot stand in for a solution set.
    if python_available:
        return {
            "backend": "WASI",
            "tool": "generated_python",
            "gap": "bounded exploration; independent checks required",
        }
    return {
        "backend": "BLOCKED",
        "gap": "no complete preset match and no accepted Python backend",
    }


def capability_metadata():
    return (
        "Bounded computations: rational polynomial expansion/coefficient tables; rational linear solution sets; "
        "substitution residuals; finite graph/DP/enumeration; explicit numerical evaluation. "
        "Prefer a registered tool only if input, output and audit scope all match. "
        "solve_system_guarded_expr gives a count/certificate, not a general parametric solution set. "
        "If generated_python is explicitly enabled, combine stdlib, SymPy 1.12 and mpmath 1.3.0 in WASI; "
        "no NumPy/SciPy, installation or host access. Missing reduction/mapping => reasoning, not execution."
    )
