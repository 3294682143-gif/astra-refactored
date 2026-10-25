"""Single source of truth for the Web/BFF run request contract.

The browser only chooses a problem and a bounded, server-supported budget. It
never selects a provider endpoint, model credential, Host binding, bundle path
or executable path. The same defaults are exported by ``/api/capabilities`` and
stored on every accepted run so a refresh or reconnect cannot silently change
the effective budget.
"""
from __future__ import annotations

from types import MappingProxyType
from typing import Final

WEB_ENGINES: Final[tuple[str, ...]] = ("ts",)
DEFAULT_BUDGET: Final[MappingProxyType[str, object]] = MappingProxyType(
    {
        "max_model_calls": 8,
        "max_work_units": 4,
        "max_effects": 1,
        "max_reviews": 1,
        "max_method_loads": 0,
        "max_repairs": 0,
        "max_consensus": 0,
        "max_r0": 0,
        "problem_seconds": 600,
        "policy": "BEST_EFFORT",
    }
)

# Metadata is user data, not a control channel. These keys are refused even
# inside the otherwise free-form metadata object.
FORBIDDEN_METADATA_KEYS: Final[frozenset[str]] = frozenset(
    {
        "provider",
        "provider_url",
        "endpoint",
        "api_key",
        "apikey",
        "token",
        "secret",
        "model_key",
        "bundle",
        "bundle_path",
        "runtime_path",
        "executable",
        "executable_path",
        "node_path",
        "host_binding",
        "session_id",
        "sessionId",
        "problemHash",
        "contractVersion",
        "taskId",
        "goalId",
        "scopeId",
        "sourceRequestId",
    }
)

MAX_METADATA_DEPTH = 16
MAX_METADATA_NODES = 2048


def default_budget() -> dict[str, object]:
    """Return a mutable copy for JSON serialization, never the proxy itself."""
    return dict(DEFAULT_BUDGET)


__all__ = [
    "WEB_ENGINES",
    "DEFAULT_BUDGET",
    "FORBIDDEN_METADATA_KEYS",
    "default_budget",
]
