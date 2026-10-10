"""Official entry orchestration; the mathematical Controller is unchanged."""

from __future__ import annotations

import threading
import time

from .controller import Controller
from .domain import ProblemContract
from .experiments import ExperimentConfig
from .finalization import UNSOLVED, finalize
from .platform_resources import platform_python
from .runtime.platform_adapter import PlatformAdapter
from .runtime.platform_coordinator import PlatformItemCoordinator, PlatformPolicy
from .runtime.adaptive_platform import BudgetAwareCoordinator
from .method_layer import GeneralMethodCatalog
from .store import ArtifactStore


def public_trace(events, metrics, limit, *, capabilities=None):
    rows = [
        {
            "step": "runtime_contract",
            "content": {
                "mode": "platform",
                "global_resource_authority": "injected_client_and_runner",
                "persistent_agent_recovery": False,
                "sdk_metadata_may_be_unavailable": True,
                "stream_requested": False,
                **(capabilities or {}),
            },
        }
    ]
    selected = []
    for event in events:
        kind, d = event["kind"], event["details"]
        if kind == "delivery":
            selected.append(
                {
                    "step": "model_call",
                    "content": {
                        "status": d.get("status")
                        if d.get("status") in {"COMPLETED", "INCOMPLETE", "BLOCKED"}
                        else "INVALID",
                        "protocol_closed": d.get("status") == "COMPLETED"
                        and d.get("gap") == "NONE"
                        and not d.get("violations")
                        and not d.get("error")
                        and not d.get("late"),
                        "violation_count": len(d.get("violations", ())),
                        "transport_error": bool(d.get("error")),
                        "late": bool(d.get("late")),
                        "finish_reason": d.get("finish_reason"),
                        "task_delivery_status": d.get(
                            "task_delivery_status", "UNASSESSED"
                        ),
                    },
                }
            )
        elif kind == "review":
            selected.append(
                {
                    "step": "review",
                    "content": {
                        "role": d["role"],
                        "position": d["position"],
                        "complete": bool(d.get("complete")),
                        "interpretation": d.get("interpretation"),
                        "finish_reason": d.get("finish_reason"),
                    },
                }
            )
        elif kind == "selection":
            selected.append(
                {
                    "step": "selection",
                    "content": {"candidate_verified": bool(d.get("verified"))},
                }
            )
        elif kind == "runtime_error":
            selected.append({"step": "runtime_error", "content": {"failed": True}})
    if limit > 2:
        rows.extend(selected[-(limit - 2) :])
    rows.append({"step": "local_invocation_summary", "content": metrics})
    return rows


class PlatformRuntime:
    def __init__(
        self,
        client,
        *,
        policy=None,
        load_started=None,
        python_sandbox_profile=None,
        experiment=None,
    ):
        self.client = client
        self.policy = policy or PlatformPolicy()
        if not isinstance(self.policy, PlatformPolicy):
            raise TypeError("explicit PlatformPolicy required")
        self.started = (
            min(time.monotonic(), load_started)
            if load_started is not None
            else time.monotonic()
        )
        self.start_lock = threading.Lock()
        self.first = True
        self.experiment = experiment or ExperimentConfig()
        self.python_sandbox = (
            platform_python(python_sandbox_profile)
            if self.experiment.enabled("python")
            else None
        )

    def solve(self, problem, metadata=None):
        if not isinstance(problem, str) or not problem.strip():
            return {
                "final_response": UNSOLVED,
                "trace": [
                    {"step": "invalid_input", "content": {"valid_problem_text": False}}
                ],
            }
        with self.start_lock:
            started = self.started if self.first else time.monotonic()
            self.first = False
        # No state is keyed by idx, shared with another question or loaded from
        # disk. Reuse in the public *local* baseline remains independently safe.
        store = ArtifactStore(ProblemContract(problem))
        public_budget = getattr(self.client, 'public_budget_snapshot', None)
        coord = BudgetAwareCoordinator(started=started, policy=self.policy,
                                       budget_snapshot=public_budget if callable(public_budget) else None)
        adapter = PlatformAdapter(self.client, coord)
        methods = GeneralMethodCatalog(store) if self.experiment.enabled('skills') else None
        store.control['integrated_architecture'] = {
            'schema': 'general-controller-rc100-v1', 'generated_python': self.python_sandbox is not None,
            'method_provider': 'general-v1.1+registered-contracts' if methods else 'disabled',
            'budget_source': 'public_port' if callable(public_budget) else 'local_only',
            'classified_execution_feedback': True, 'candidate_evidence_closeout': True,
            'review_reuse': 'native content-bound ReviewTask registry',
            'targeted_cards': False,
        }
        try:
            result = Controller(
                adapter,
                coord.item,
                store,
                python_sandbox=self.python_sandbox,
                experiment=self.experiment,
                method_catalog=methods,
            ).solve()
        except Exception:  # noqa: BLE001 - official boundary returns a nonempty result
            store.event("runtime_error", category="platform_invocation_failed")
            result = finalize(store)
        finally:
            coord.close()
        answer = result.get("final_response")
        if not isinstance(answer, str) or not answer.strip():
            answer = UNSOLVED
        # The runner owns success/error and output files. Do not return raw model
        # traffic, candidate bodies, source problems, private paths or stack traces.
        return {
            "final_response": answer,
            'status': result.get('status', 'unsolved'),
            'candidate_verified': bool(result.get('candidate_verified', False)),
            'unresolved_obligations': result.get('unresolved_obligations', []),
            'architecture': store.control['integrated_architecture'],
            "trace": public_trace(
                store.events,
                coord.metrics(),
                self.policy.max_trace_events,
                capabilities=adapter.public_contract
                | {
                    "generated_python_available": self.python_sandbox is not None,
                    "generated_python_target_acceptance": "not_established_by_agent",
                    "cross_question_borrowing": False,
                    "cross_question_dynamic_budget": callable(public_budget),
                },
            ),
        }
