"""Independent checks; no producer family or bridge imports are permitted."""

from . import (
    algebraic,
    computation,
    diophantine,
    discrete,
    geometry,
    numerical,
    symbolic,
    tiling,
)

MODULES = (
    discrete,
    tiling,
    numerical,
    geometry,
    symbolic,
    diophantine,
    algebraic,
    computation,
)
CONTRACTS = {
    name: spec for module in MODULES for name, spec in module.CONTRACTS.items()
}


def normalize(name, args):
    from ..input_contracts import validate_inputs

    validate_inputs(name, args)
    return next(module for module in MODULES if name in module.CONTRACTS).normalize(
        name, args
    )


def check(name, inputs, result, *, certificate=None):
    module = next(module for module in MODULES if name in module.CONTRACTS)
    from ..tool_contracts import InvalidToolInput, OutsideAuditScope

    try:
        valid = (
            module.check(name, inputs, result, certificate=certificate)
            if getattr(module, "USES_CERTIFICATE", False)
            else module.check(name, inputs, result)
        )
    except (
        InvalidToolInput,
        OutsideAuditScope,
        TypeError,
        ValueError,
        KeyError,
        IndexError,
        SyntaxError,
        OverflowError,
        ZeroDivisionError,
    ):
        valid = False
    mode = getattr(module, "MODES", {}).get(name, "EXACT")
    return valid, mode
