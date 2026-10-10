"""Experimental lightweight typed-action solver path.

This package is deliberately separate from the frozen Controller. It offers a
bounded model/tool loop over two registered operators and never claims
mathematical verification. The default public entry point selects it; the
legacy Controller remains reachable through an explicit engine switch.
"""

from .protocol import (
    LiteProtocolError,
    parse_lite_delivery,
    parse_action,
    FinalAction,
    MethodAction,
    ToolAction,
    UnsolvedAction,
)
from .methods import MethodCatalog, MethodCatalogError, MethodLoad
from .runtime import LiteRuntime

__all__ = [
    "LiteProtocolError",
    "parse_lite_delivery",
    "parse_action",
    "FinalAction",
    "MethodAction",
    "ToolAction",
    "UnsolvedAction",
    "MethodCatalog",
    "MethodCatalogError",
    "MethodLoad",
    "LiteRuntime",
]
