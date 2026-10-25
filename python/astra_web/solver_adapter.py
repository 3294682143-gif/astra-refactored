"""BFF -> official ReasoningAgent adapter.

The adapter maps validated Web budgets to the official public entry point. It
does not route mathematics, read legacy registries, execute tools itself or
invent answers. Tests may inject a scripted public client, but the Node bundle,
Python Host and unified ``use_math_asset`` executor remain the real ones.
"""
from __future__ import annotations

import os
from typing import Any, Callable, Mapping, Optional

from .config import DEFAULT_BUDGET

_BUDGET_KEYS = (
    "max_model_calls",
    "max_work_units",
    "max_effects",
    "max_reviews",
    "max_method_loads",
    "max_repairs",
    "max_consensus",
    "max_r0",
    "problem_seconds",
    "policy",
)


class SolverAdapter:
    """Callable solver port used by ``ExecutionManager``."""

    def __init__(
        self,
        *,
        client_factory: Callable[[], Any],
        agent_factory: Callable[..., Any] | None = None,
    ) -> None:
        self._client_factory = client_factory
        self._agent_factory = agent_factory

    def _agent_class(self) -> Callable[..., Any]:
        if self._agent_factory is not None:
            return self._agent_factory
        from user_agent import ReasoningAgent

        return ReasoningAgent

    def __call__(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        problem = request.get("problem")
        if not isinstance(problem, str) or not problem.strip():
            raise ValueError("invalid problem")
        budgets = {
            key: request.get(key, DEFAULT_BUDGET[key])
            for key in _BUDGET_KEYS
        }
        client = self._client_factory()
        observer = request.get("_event_sink")
        agent_kwargs = dict(budgets)
        if callable(observer):
            agent_kwargs["observer"] = observer
        agent = self._agent_class()(client=client, **agent_kwargs)
        metadata = request.get("metadata")
        result = agent.solve(problem, dict(metadata) if isinstance(metadata, Mapping) else {})
        if not isinstance(result, Mapping):
            raise TypeError("ReasoningAgent.solve must return a mapping")
        payload = dict(result)
        # A Web run can never turn a candidate into a verified answer.
        if payload.get("candidate_verified") is not False:
            payload["candidate_verified"] = False
            payload["reason"] = (
                str(payload.get("reason") or "")
                + "; web adapter downgraded candidate_verified to false"
            ).strip("; ")
        payload.setdefault("executed", True)
        payload.setdefault("runId", request.get("run_id"))
        return payload


def build_solver_from_env() -> Optional[SolverAdapter]:
    """Build a production solver only when explicit server credentials exist.

    Credentials are read from the service process environment, never from a
    browser request. With no configuration the BFF keeps the explicit
    ``SOLVER_NOT_CONFIGURED`` path rather than silently using a fixture.
    """
    api_key = os.environ.get("ASTRA_S2_API_KEY") or os.environ.get("INTERN_API_KEY")
    endpoint = os.environ.get("ASTRA_S2_ENDPOINT") or os.environ.get("INTERN_ENDPOINT")
    model = os.environ.get("ASTRA_S2_MODEL", "Intern-S2-Preview-397B")
    if not api_key or not endpoint:
        return None

    def _factory() -> Any:
        from mathagent.user_client import UserSuppliedS2Client

        return UserSuppliedS2Client(
            api_key=api_key,
            endpoint=endpoint,
            model=model,
        )

    return SolverAdapter(client_factory=_factory)


__all__ = ["SolverAdapter", "build_solver_from_env"]
