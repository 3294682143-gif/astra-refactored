"""numerical_methods family.

Structural criterion: direct numerical differentiation / discretization
computations. Every estimate ships with an empirical error bound obtained
from step-halving (Runge estimate) and an observed convergence-order check
against theory (O(h^2) for central differences, O(h) for one-sided ones).

Tools:
- finite_difference_derivative: central / forward / backward first
  derivative at a point. Certificate: the step-halving sample table
  (nodes x±h, x±h/2, x±h/4) with an independent re-checker.
- richardson_extrapolate: one Richardson step on the same estimates;
  the certificate additionally carries both extrapolants so the claimed
  improvement is itself re-checkable.
- verify_fd_certificate: independent checker re-deriving every certified
  number from the sampled function values.
"""
from __future__ import annotations

import ast
import math
from typing import Callable

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible

#: Leading truncation order of each difference method.
_METHOD_ORDER = {"central": 2, "forward": 1, "backward": 1}

#: Node offsets (in units of h) sampled per method, ascending.
_OFFSETS = {
    "central": (-1.0, -0.5, -0.25, 0.25, 0.5, 1.0),
    "forward": (0.0, 0.25, 0.5, 1.0),
    "backward": (-1.0, -0.5, -0.25, 0.0),
}

#: Steps at/below this relative size let subtractive cancellation dominate;
#: the O(h^p) truncation model then no longer describes the error.
_MIN_REL_STEP = 1e-12

#: Estimates agreeing within this relative slack are treated as converged at
#: machine level (the convergence-ratio check has no signal there).
_CONV_TOL = 1e-11


# --------------------------------------------------------------------- #
# 1. Finite-difference derivative with step-halving certificate
# --------------------------------------------------------------------- #
def finite_difference_derivative(
    f: Callable[[float], float], x: float, h: float, method: str = "central"
) -> Evidence:
    """Approximate f'(x) by a central / forward / backward difference.

    The returned value is the estimate at the requested step h. For the
    certificate the same formula is re-applied at h/2 and h/4 on one shared
    sample table; the Runge error bound and the observed convergence ratio
    (theory: ~4 for central, ~2 for one-sided) form the self-check. The
    self-check is an asymptotic-regime heuristic: MISMATCH means the O(h^p)
    model is not confirmed for this (f, x, h), not that the value is wrong.
    """
    _validate(f, x, h, method)
    x, h = float(x), float(h)
    guard = _roundoff_guard(x, h)
    if guard is not None:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=guard,
            complexity_bound="O(1) evaluations of f",
        )
    samples = _sample(f, x, h, method)
    if not all(math.isfinite(v) for v in samples):
        return Evidence(
            value=None,
            certificate="",
            self_check="sampled a non-finite f value",
            feasibility=infeasible(
                "non-finite function sample", "O(1) evaluations of f"
            ),
            complexity_bound="O(1) evaluations of f",
        )

    d_h, d_h2, d_h4 = _estimates(samples, h, method)
    p = _METHOD_ORDER[method]
    err_est = abs(d_h - d_h2) * 2.0**p / (2.0**p - 1.0)
    note, ok = _convergence_note(d_h, d_h2, d_h4, p)
    return Evidence(
        value=d_h,
        certificate=_build_certificate(method, x, h, p, samples, (d_h, d_h2, d_h4)),
        self_check=(
            f"{note}; runge error bound for D(h) ~ {err_est:.3g}: "
            f"{'ok' if ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=f"O(1) evaluations of f ({len(_OFFSETS[method])} samples)",
    )


# --------------------------------------------------------------------- #
# 2. Richardson extrapolation
# --------------------------------------------------------------------- #
def richardson_extrapolate(
    f: Callable[[float], float],
    x: float,
    h: float,
    method: str = "central",
    order: int | None = None,
) -> Evidence:
    """One Richardson extrapolation step on the difference estimate of f'(x).

    Combines D(h), D(h/2) into R_coarse and D(h/2), D(h/4) into R_fine,
    cancelling the leading O(h^order) term; the value is R_fine and
    |R_fine - R_coarse| is the empirical error bound. ``order=None`` uses
    the method's canonical truncation order. Self-check: the two
    extrapolants must agree at least as well as the raw fine pair
    (factor-2 slack), or the estimates are machine-level converged.
    """
    _validate(f, x, h, method)
    if order is None:
        order = _METHOD_ORDER[method]
    if not isinstance(order, int) or order < 1:
        raise ValueError("order must be a positive integer")
    x, h = float(x), float(h)
    guard = _roundoff_guard(x, h)
    if guard is not None:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=guard,
            complexity_bound="O(1) evaluations of f",
        )
    samples = _sample(f, x, h, method)
    if not all(math.isfinite(v) for v in samples):
        return Evidence(
            value=None,
            certificate="",
            self_check="sampled a non-finite f value",
            feasibility=infeasible(
                "non-finite function sample", "O(1) evaluations of f"
            ),
            complexity_bound="O(1) evaluations of f",
        )

    d_h, d_h2, d_h4 = _estimates(samples, h, method)
    factor = 1.0 / (2.0**order - 1.0)
    r_coarse = d_h2 + (d_h2 - d_h) * factor
    r_fine = d_h4 + (d_h4 - d_h2) * factor
    gap = abs(r_fine - r_coarse)
    raw_gap = abs(d_h2 - d_h4)
    scale = max(1.0, abs(d_h), abs(d_h2), abs(d_h4))
    if abs(d_h - d_h2) <= _CONV_TOL * scale and raw_gap <= _CONV_TOL * scale:
        note = f"estimates agree within {_CONV_TOL}*scale (machine-level convergence)"
        ok = True
    else:
        ok = gap <= 2.0 * raw_gap
        note = (
            f"extrapolant gap |R_fine-R_coarse|={gap:.3g} vs raw fine gap "
            f"|D_h2-D_h4|={raw_gap:.3g} (factor-2 slack)"
        )
    return Evidence(
        value=r_fine,
        certificate=_build_certificate(
            method,
            x,
            h,
            order,
            samples,
            (d_h, d_h2, d_h4),
            extra=(f"R_coarse={r_coarse!r}", f"R_fine={r_fine!r}"),
        ),
        self_check=(
            f"{note}; empirical error bound ~ {gap:.3g}: "
            f"{'ok' if ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=f"O(1) evaluations of f ({len(_OFFSETS[method])} samples)",
    )


# --------------------------------------------------------------------- #
# 3. Independent certificate checker
# --------------------------------------------------------------------- #
def verify_fd_certificate(
    f: Callable[[float], float], x: float, h: float, method: str, certificate: str
) -> bool:
    """Re-check a certificate produced by the tools above.

    Re-samples f on the certified nodes, re-derives the three difference
    estimates by pure arithmetic on the certified samples, and — when
    present — re-derives both Richardson extrapolants from the certified
    order. Any disagreement, field mismatch, or malformed input returns
    False.
    """
    if method not in _METHOD_ORDER:
        return False
    try:
        fields = _parse_certificate(certificate)
        if fields["method"] != method:
            return False
        cx, ch = float(fields["x"]), float(fields["h"])
        if cx != float(x) or ch != float(h):
            return False
        order = int(fields["order"])
        samples = [float(v) for v in ast.literal_eval(fields["samples"])]
        d_h, d_h2, d_h4 = (float(fields[k]) for k in ("D_h", "D_h2", "D_h4"))
    except (KeyError, ValueError, TypeError, SyntaxError):
        return False
    if not 1 <= order <= 64 or len(samples) != len(_OFFSETS[method]):
        return False

    fresh = _sample(f, cx, ch, method)
    scale = max(
        1.0, *(abs(v) for v in samples), abs(d_h), abs(d_h2), abs(d_h4)
    )
    tol = 1e-9 * scale

    def close(a: float, b: float) -> bool:
        return math.isclose(a, b, rel_tol=0.0, abs_tol=tol)

    if not all(close(a, b) for a, b in zip(fresh, samples)):
        return False
    if not all(
        close(a, b) for a, b in zip(_estimates(samples, ch, method), (d_h, d_h2, d_h4))
    ):
        return False
    if "R_fine" in fields or "R_coarse" in fields:
        try:
            r_coarse = float(fields["R_coarse"])
            r_fine = float(fields["R_fine"])
        except (KeyError, ValueError):
            return False
        factor = 1.0 / (2.0**order - 1.0)
        if not close(d_h2 + (d_h2 - d_h) * factor, r_coarse):
            return False
        if not close(d_h4 + (d_h4 - d_h2) * factor, r_fine):
            return False
    return True


# --------------------------------------------------------------------- #
# Evidence wrapper (W5): the raw checker above stays the subroutine.
# --------------------------------------------------------------------- #
def verify_fd_certificate_evidence(
    f: Callable[[float], float], x: float, h: float, method: str, certificate: str
) -> Evidence:
    """Independent finite-difference certificate check, as Evidence.

    Thin Evidence packaging over :func:`verify_fd_certificate`: re-sampling
    plus pure re-arithmetic decide acceptance; the wrapper adds only the
    deterministic-checker self-check note. A malformed certificate or a
    method outside the whitelist is a ``False`` verdict, not an error.
    """
    ok = verify_fd_certificate(f, x, h, method, certificate)
    samples = len(_OFFSETS[method]) if method in _METHOD_ORDER else 0
    return Evidence(
        value=ok,
        certificate=f"re-derived estimates from re-sampled nodes: accepted={ok}",
        self_check="independent certificate re-derivation executed deterministically",
        feasibility="ok",
        complexity_bound=f"O(1) evaluations of f ({samples} samples)",
    )


# --------------------------------------------------------------------- #
# Internals
# --------------------------------------------------------------------- #
def _validate(f, x, h, method) -> None:
    if not callable(f):
        raise TypeError("f must be callable")
    if method not in _METHOD_ORDER:
        raise ValueError(f"method must be one of {sorted(_METHOD_ORDER)}")
    if not isinstance(x, (int, float)) or not math.isfinite(x):
        raise ValueError("x must be a finite real number")
    if not isinstance(h, (int, float)) or not math.isfinite(h) or h <= 0:
        raise ValueError("h must be a positive finite step")


def _roundoff_guard(x: float, h: float) -> str | None:
    """Infeasible marker when the finest node step (h/4) sits at/below the
    roundoff guard; None otherwise."""
    guard = _MIN_REL_STEP * max(1.0, abs(x))
    if 0.25 * h <= guard:
        return infeasible(
            f"finest step h/4={0.25 * h:.3g} at/below roundoff guard {guard:.3g}",
            "cancellation error ~ eps*|f|/h",
        )
    return None


def _sample(f, x: float, h: float, method: str) -> list[float]:
    return [float(f(x + k * h)) for k in _OFFSETS[method]]


def _estimates(samples, h: float, method: str) -> tuple[float, float, float]:
    """D(h), D(h/2), D(h/4) by pure arithmetic on the sample table."""
    s = dict(zip(_OFFSETS[method], samples))
    if method == "central":
        return (
            (s[1.0] - s[-1.0]) / (2.0 * h),
            (s[0.5] - s[-0.5]) / h,
            (s[0.25] - s[-0.25]) / (0.5 * h),
        )
    if method == "forward":
        return (
            (s[1.0] - s[0.0]) / h,
            (s[0.5] - s[0.0]) / (0.5 * h),
            (s[0.25] - s[0.0]) / (0.25 * h),
        )
    return (  # backward
        (s[0.0] - s[-1.0]) / h,
        (s[0.0] - s[-0.5]) / (0.5 * h),
        (s[0.0] - s[-0.25]) / (0.25 * h),
    )


def _convergence_note(
    d_h: float, d_h2: float, d_h4: float, order: int
) -> tuple[str, bool]:
    """Self-check text + flag from the step-halving estimate triple."""
    scale = max(1.0, abs(d_h), abs(d_h2), abs(d_h4))
    e1, e2 = d_h - d_h2, d_h2 - d_h4
    if abs(e1) <= _CONV_TOL * scale and abs(e2) <= _CONV_TOL * scale:
        return (
            f"estimates agree within {_CONV_TOL}*scale "
            f"(machine-level convergence, order {order} assumed)"
        ), True
    ratio = abs(e1 / e2) if e2 != 0.0 else float("inf")
    expected = float(2**order)
    lo, hi = expected / 2.0, expected * 2.0
    return (
        f"halving ratio |D_h-D_h2|/|D_h2-D_h4|={ratio:.4g}, "
        f"theory {expected:g} (band [{lo:g},{hi:g}])"
    ), lo <= ratio <= hi


def _build_certificate(
    method, x, h, order, samples, estimates, extra=()
) -> str:
    fields = [
        f"method={method}",
        f"x={x!r}",
        f"h={h!r}",
        f"order={order}",
        f"samples={samples!r}",
        f"D_h={estimates[0]!r}",
        f"D_h2={estimates[1]!r}",
        f"D_h4={estimates[2]!r}",
        *extra,
    ]
    return ";".join(fields)


def _parse_certificate(certificate: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    allowed = {"method", "x", "h", "order", "samples", "D_h", "D_h2", "D_h4", "R_coarse", "R_fine"}
    for part in certificate.split(";"):
        key, separator, val = part.partition("=")
        key = key.strip()
        if not separator or key not in allowed or key in fields or not val.strip():
            raise ValueError("malformed, duplicated or unknown certificate field")
        fields[key] = val.strip()
    return fields
