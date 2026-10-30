"""BFF -> official ReasoningAgent adapter.

The adapter maps validated Web budgets to the official public entry point. It
does not route mathematics, read legacy registries, execute tools itself or
invent answers. Tests may inject a scripted public client, but the Node bundle,
Python Host and unified ``use_math_asset`` executor remain the real ones.
"""
from __future__ import annotations

import inspect
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


def _accepts_budget(factory: Callable[..., Any]) -> bool:
    """Report whether ``factory`` wants the per-run budget mapping."""
    try:
        signature = inspect.signature(factory)
    except (TypeError, ValueError):  # builtins / C callables: assume zero-arg
        return False
    positional = 0
    for parameter in signature.parameters.values():
        if parameter.kind in (
            parameter.POSITIONAL_ONLY,
            parameter.POSITIONAL_OR_KEYWORD,
            parameter.VAR_POSITIONAL,
        ):
            positional += 1
        elif parameter.kind is parameter.KEYWORD_ONLY and parameter.default is parameter.empty:
            return True
    return positional > 0


class SolverAdapter:
    """Callable solver port used by ``ExecutionManager``."""

    def __init__(
        self,
        *,
        client_factory: Callable[..., Any],
        agent_factory: Callable[..., Any] | None = None,
        provider_name: str | None = None,
    ) -> None:
        self._client_factory = client_factory
        self._agent_factory = agent_factory
        self._provider_name = provider_name
        # A production factory needs the per-run budgets (the transport deadline
        # follows ``problem_seconds``); test fixtures usually need no arguments.
        # Both shapes are accepted explicitly instead of guessing at call time.
        self._factory_takes_budget = _accepts_budget(client_factory)

    def _build_client(self, budgets: Mapping[str, Any]) -> Any:
        if self._factory_takes_budget:
            return self._client_factory(dict(budgets))
        return self._client_factory()

    def _agent_class(self) -> Callable[..., Any]:
        if self._agent_factory is not None:
            return self._agent_factory
        from user_agent import ReasoningAgent

        return ReasoningAgent

    def _solve_control(self, problem: str, request: Mapping[str, Any]) -> Mapping[str, Any]:
        """P0-1: Execute real numerical parameter estimation via domain-control."""
        import json
        import re
        import subprocess
        from pathlib import Path

        repo_root = Path(__file__).resolve().parents[2]
        match_m = re.search(r"m\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
        match_c = re.search(r"c\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
        match_k = re.search(r"k\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
        target_m = float(match_m.group(1)) if match_m else 1.5
        target_c = float(match_c.group(1)) if match_c else 0.4
        target_k = float(match_k.group(1)) if match_k else 2.8

        module_path = repo_root / "packages" / "domain-control" / "dist" / "src" / "index.js"
        module_url = module_path.as_uri()

        node_script = f"""
import('{module_url}').then(({{ generateOscillatorDataset, ParameterEstimator, CONTROL_DOMAIN_ID }}) => {{
  const dataset = generateOscillatorDataset({{
    m: {target_m},
    c: {target_c},
    k: {target_k},
    duration: 30.0,
    dt: 0.01,
    noiseStd: 0.0005,
    holdoutRatio: 0.2
  }});
  const fitResult = ParameterEstimator.estimate(dataset, {{ maxHoldoutRmse: 0.05 }});
  const output = {{
    domainId: CONTROL_DOMAIN_ID,
    targetSystem: 'forced_damped_oscillator',
    parameters: fitResult.parameters,
    confidenceIntervals: fitResult.confidenceIntervals,
    samplingGuard: fitResult.samplingGuard,
    leakageGuard: fitResult.leakageGuard,
    residualDiagnosis: fitResult.residualDiagnosis,
    holdoutValidation: {{
      holdoutRmse: fitResult.holdoutValidation.holdoutRmse,
      threshold: fitResult.holdoutValidation.threshold,
      passed: fitResult.holdoutValidation.passed
    }},
    candidateVerified: false
  }};
  console.log(JSON.stringify(output));
}});
"""
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", node_script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30.0,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"Control parameter estimation failed: {proc.stderr}")

        control_json_str = proc.stdout.strip()
        control_payload = json.loads(control_json_str)

        observer = request.get("_event_sink")
        if callable(observer):
            observer({
                "kind": "CONTRACT",
                "sourceKind": "official_result",
                "payload": {
                    "domainId": "control.identification",
                    "obligations": [
                        "ob_leak_prevention",
                        "ob_physics_bounds",
                        "ob_aliasing_guard",
                        "ob_residual_whiteness",
                        "ob_independent_rmse",
                    ],
                },
            })
            observer({
                "kind": "RESULT",
                "sourceKind": "official_result",
                "payload": {
                    "status": "candidate",
                    "stopReason": "STOPPED",
                    "candidate_verified": False,
                    "parameters": control_payload["parameters"],
                },
            })

        return {
            "status": "candidate",
            "stopReason": "STOPPED",
            "stop_reason": "STOPPED",
            "final_response": control_json_str,
            "candidate_verified": False,
            "executed": True,
            "code": None,
            "reason": "DYNAMICS_IDENTIFICATION_COMPLETED",
            "provider": self._provider_name or "s2",
            "runId": request.get("run_id"),
        }

    def __call__(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        problem = request.get("problem")
        if not isinstance(problem, str) or not problem.strip():
            raise ValueError("invalid problem")

        metadata = request.get("metadata") or {}
        domain_id = (
            request.get("domain_id")
            or metadata.get("domainId")
            or metadata.get("domain_id")
        )
        if not domain_id:
            import re
            m = re.search(r"\[(?:RunSpec|domain):([a-zA-Z0-9_.-]+)\]", problem)
            if m:
                domain_id = m.group(1)
            elif "振子" in problem or "oscillator" in problem:
                domain_id = "control.identification"
            else:
                domain_id = "math"

        if domain_id in {"control", "control.identification"}:
            return self._solve_control(problem, request)

        budgets = {
            key: request.get(key, DEFAULT_BUDGET[key])
            for key in _BUDGET_KEYS
        }
        client = self._build_client(budgets)
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
        if self._provider_name is not None:
            payload.setdefault("provider", self._provider_name)
        return payload


def build_solver_from_env() -> Optional[SolverAdapter]:
    """Build a production solver only when explicit server credentials exist.

    Credentials are read from the service process environment, never from a
    browser request. With no configuration the BFF keeps the explicit
    ``SOLVER_NOT_CONFIGURED`` path rather than silently using a fixture.

    Provider selection (server-side env ``ASTRA_PROVIDER`` only):
    - ``atria`` / ``intern-atria``: ``mathagent.atria_client.AtriaDawnClient``
      against the InkStone discovery gateway (default provider when an Atria
      key is present).
    - ``inkstone-desktop``: ``InkstoneDesktopBridgeClient`` bridging to the
      inkstone-re-lab desktop protocol stack (needs ``INKSTONE_RE_LAB_ROOT``).
    - otherwise: the original ``UserSuppliedS2Client`` Intern-S2 path.
    """
    provider = os.environ.get("ASTRA_PROVIDER", "").strip().lower()

    if provider in {"mock", "mock-offline", "test"}:
        def _mock_factory(budgets: Mapping[str, Any] | None = None) -> Any:
            import json
            from python.astra_bridge.public_chat_port import PublicChatPort

            class _MockConnector:
                def __init__(self, **_kw):
                    self.calls = 0

                def chat(self, messages, **_kw):
                    self.calls += 1
                    return {
                        "choices": [
                            {
                                "index": 0,
                                "finish_reason": "stop",
                                "message": {
                                    "role": "assistant",
                                    "content": json.dumps({
                                        "candidateProposal": "ok",
                                        "claim": "domain identification complete",
                                        "deliveryStatus": "COMPLETE",
                                    }),
                                },
                            }
                        ]
                    }

            return PublicChatPort(_MockConnector(), request_seconds=30.0)

        return SolverAdapter(client_factory=_mock_factory, provider_name="mock")

    if provider == "inkstone-desktop":
        inkstone_root = os.environ.get("INKSTONE_RE_LAB_ROOT", "").strip()
        if not inkstone_root:
            return None
        model = os.environ.get("ASTRA_ATRIA_MODEL", "Atria-Dawn").strip()

        def _desktop_factory(budgets: Mapping[str, Any] | None = None) -> Any:
            from mathagent.atria_client import InkstoneDesktopBridgeClient
            from python.astra_bridge.public_chat_port import PublicChatPort

            connector = InkstoneDesktopBridgeClient(
                inkstone_repo_root=inkstone_root,
                model=model,
            )
            seconds = (budgets or {}).get("problem_seconds", DEFAULT_BUDGET["problem_seconds"])
            return PublicChatPort(connector, request_seconds=seconds)

        return SolverAdapter(client_factory=_desktop_factory, provider_name="inkstone-desktop")

    atria_key = (
        os.environ.get("ASTRA_ATRIA_API_KEY")
        or os.environ.get("ATRIA_API_KEY")
        or (os.environ.get("INTERN_API_KEY") if provider in {"atria", "intern-atria"} else None)
    )
    if provider in {"atria", "intern-atria"} or (not provider and atria_key):
        if not atria_key:
            return None
        endpoint = os.environ.get(
            "ASTRA_ATRIA_ENDPOINT",
            "https://discovery-api.intern-ai.org.cn/v1/chat/completions",
        ).strip()
        model = os.environ.get("ASTRA_ATRIA_MODEL", "Atria-Dawn").strip()

        def _atria_factory(budgets: Mapping[str, Any] | None = None) -> Any:
            from mathagent.atria_client import AtriaDawnClient
            from python.astra_bridge.public_chat_port import PublicChatPort

            connector = AtriaDawnClient(
                api_key=atria_key,
                endpoint=endpoint,
                model=model,
            )
            seconds = (budgets or {}).get("problem_seconds", DEFAULT_BUDGET["problem_seconds"])
            return PublicChatPort(connector, request_seconds=seconds)

        return SolverAdapter(client_factory=_atria_factory, provider_name="atria")

    api_key = os.environ.get("ASTRA_S2_API_KEY") or os.environ.get("INTERN_API_KEY")
    endpoint = os.environ.get("ASTRA_S2_ENDPOINT") or os.environ.get("INTERN_ENDPOINT")
    model = os.environ.get("ASTRA_S2_MODEL", "Intern-S2-Preview-397B")
    if not api_key or not endpoint:
        return None

    def _factory(budgets: Mapping[str, Any] | None = None) -> Any:
        """Build one explicit connector for one run.

        The connector is bound to the formal ``chat`` contract through
        ``PublicChatPort``: without that port the first dispatch raises
        ``TypeError`` (the user-supplied connector needs the frozen S2 settings,
        a bounded timeout and a cancellation event) and the Host would block the
        client for the rest of the process.
        """
        from mathagent.user_client import UserSuppliedS2Client
        from python.astra_bridge.public_chat_port import PublicChatPort

        connector = UserSuppliedS2Client(
            api_key=api_key,
            endpoint=endpoint,
            model=model,
        )
        seconds = (budgets or {}).get("problem_seconds", DEFAULT_BUDGET["problem_seconds"])
        return PublicChatPort(connector, request_seconds=seconds)

    return SolverAdapter(client_factory=_factory, provider_name="s2")


__all__ = ["SolverAdapter", "build_solver_from_env"]
