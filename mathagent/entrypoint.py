from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import asdict
from importlib.resources import files
from pathlib import Path

from .controller import Controller
from .domain import ProblemContract
from .experiments import ExperimentConfig
from .finalization import UNSOLVED, finalize
from .runtime.adapter import S2Adapter
from .runtime.config import ClientCapabilities, Limits, fingerprint
from .runtime.coordinator import GlobalCoordinator
from .store import ArtifactStore

LOCAL_OPTIONS = frozenset(
    {
        "run_id",
        "state_dir",
        "capabilities",
        "limits",
        "soft_seconds",
        "resume",
        "total_items",
        "version",
    }
)
LOCAL_ENVIRONMENT = frozenset(
    {
        "ASTRA_RUN_ID",
        "ASTRA_STATE_DIR",
        "ASTRA_CAPABILITIES_FILE",
        "ASTRA_TOTAL_ITEMS",
        "ASTRA_USER_CLIENT_CONFIG",
        "ASTRA_WASI_PROFILE",
    }
)


def runtime_mode(client, requested, options):
    local_intent = (
        bool(LOCAL_OPTIONS.intersection(options))
        or any(key in os.environ for key in LOCAL_ENVIRONMENT)
        or getattr(type(client), "astra_local_coordination_required", False) is True
    )
    if requested not in {None, "platform", "local"}:
        raise ValueError("runtime mode must be platform or local")
    if requested == "platform" and local_intent:
        raise ValueError(
            "mixed platform/local configuration; local history is not bypassed"
        )
    return requested or ("local" if local_intent else "platform")


def code_version():
    import importlib.metadata

    root = Path(__file__).resolve().parent.parent
    paths = [
        p
        for package in ("mathagent", "math_families")
        for p in (root / package).rglob("*")
        if p.is_file() and p.suffix in {".py", ".json", ".md"}
    ]
    paths += [
        p
        for name in ("user_agent.py", "pyproject.toml", "requirements.txt")
        if (p := root / name).exists()
    ]
    dependencies = {
        name: importlib.metadata.version(name)
        for name in ("sympy", "numpy", "scipy", "requests")
    }
    return fingerprint(
        {
            "files": [
                (str(p.relative_to(root)), fingerprint(p.read_text(encoding="utf-8")))
                for p in sorted(paths)
            ],
            "dependencies": dependencies,
        }
    )


class ReasoningAgent:
    def __init__(self, client, *args, **kwargs):
        requested_mode = kwargs.pop("mode", None)
        load_started = kwargs.pop("_entry_load_started", None)
        run_context = kwargs.pop("run_context", None)
        experiment = kwargs.pop("experiment", None)
        if experiment is not None and not isinstance(experiment, ExperimentConfig):
            raise TypeError("trusted ExperimentConfig required")
        ablation = kwargs.pop("ablation", os.environ.get("ASTRA_ABLATION"))
        if ablation is not None:
            if experiment is not None:
                raise ValueError("provide one experiment configuration, not two")
            experiment = ExperimentConfig(ablation)
        if run_context is not None or requested_mode == "shared_public":
            from .platform_resources import platform_python
            from .runtime.run_context import RunContext

            if (
                getattr(type(client), "astra_local_coordination_required", False)
                is True
            ):
                raise ValueError(
                    "legacy local connector cannot be reinterpreted as a public shared client"
                )

            if not isinstance(run_context, RunContext):
                raise TypeError(
                    "shared public mode requires an explicit trusted RunContext"
                )
            if requested_mode not in {None, "shared_public"}:
                raise ValueError(
                    "run context cannot silently change an explicit runtime mode"
                )
            profile = kwargs.pop("python_sandbox_profile", None)
            if args or kwargs:
                raise TypeError("unsupported shared public configuration")
            self.mode, self.client, self.run_context = (
                "shared_public",
                client,
                run_context,
            )
            self._shared_started = (
                min(time.monotonic(), load_started)
                if load_started is not None
                else time.monotonic()
            )
            self._shared_first = True
            self._shared_lock = threading.Lock()
            self.experiment = experiment or ExperimentConfig()
            self.python_sandbox = (
                platform_python(profile) if self.experiment.enabled("python") else None
            )
            self.shared_coordinator = run_context.coordinator(
                current_version=code_version(),
                experiment=self.experiment,
                python_identity=self.python_sandbox.identity
                if self.python_sandbox
                else None,
            )
            return
        self.mode = runtime_mode(client, requested_mode, kwargs)
        if self.mode == "platform":
            from .platform_entry import PlatformRuntime

            policy = kwargs.pop("platform_policy", None)
            python_profile = kwargs.pop("python_sandbox_profile", None)
            if args or kwargs:
                raise TypeError("unsupported official entry configuration")
            self.client = client
            self.configuration_error = ""
            self._platform_runtime = PlatformRuntime(
                client,
                policy=policy,
                load_started=load_started,
                python_sandbox_profile=python_profile,
                experiment=experiment,
            )
            return
        if "platform_policy" in kwargs:
            raise ValueError("platform protection policy cannot alter a local run")
        self.client = client
        self.parent_item_started = kwargs.pop("_item_started", None)
        self.parent_run_started = kwargs.pop("_run_started", None)
        self.parent_run_wall = kwargs.pop("_run_wall_started", None)
        self.runtime_contract_identity = kwargs.pop("_runtime_contract_identity", None)
        self.generation_margin = kwargs.pop("_generation_margin", 0)
        self.provider_rate_policy = kwargs.pop("_provider_rate_policy", None)
        from .request_policy import PROFILES

        self.request_profile = kwargs.pop("request_profile", "fixed_8192")
        if self.request_profile not in PROFILES:
            raise ValueError("unsupported local request profile")
        self.diagnostic_sink = kwargs.pop("_diagnostic_sink", None)
        self.run_id = kwargs.pop("run_id", os.environ.get("ASTRA_RUN_ID"))
        self.state_dir = kwargs.pop("state_dir", os.environ.get("ASTRA_STATE_DIR"))
        self.capabilities = kwargs.pop("capabilities", None)
        self.limits = kwargs.pop("limits", Limits())
        self.soft_seconds = kwargs.pop("soft_seconds", None)
        self.resume = kwargs.pop("resume", False)
        self.total_items = kwargs.pop(
            "total_items", os.environ.get("ASTRA_TOTAL_ITEMS")
        )
        if isinstance(self.total_items, str) and self.total_items.isdecimal():
            self.total_items = int(self.total_items)
        if self.total_items is not None and (
            type(self.total_items) is not int or self.total_items < 1
        ):
            raise ValueError("public frozen total must be a positive integer")
        self.experiment = experiment or ExperimentConfig()
        self.version = kwargs.pop("version", None) or code_version()
        sandbox_profile = kwargs.pop("python_sandbox_profile", None)
        self.python_sandbox = None
        if sandbox_profile is not None:
            from .tools import PythonSandbox

            self.python_sandbox = PythonSandbox(profile=sandbox_profile)
        self.configuration_error = ""
        if self.capabilities is None:
            try:
                path = os.environ.get("ASTRA_CAPABILITIES_FILE")
                raw = (
                    Path(path).read_text(encoding="utf-8")
                    if path
                    else files("mathagent")
                    .joinpath("resources/client-capabilities.json")
                    .read_text(encoding="utf-8")
                )
                self.capabilities = ClientCapabilities(**json.loads(raw))
                self.capabilities.validate()
            except (OSError, ValueError, TypeError):
                self.capabilities = None
        # Construction remains official-compatible even when integration is not supplied.
        if not self.run_id or not self.state_dir:
            self.configuration_error = (
                "explicit same-run identity/shared storage not provided"
            )
        if self.capabilities is None:
            self.configuration_error = (
                "official client capabilities/lifecycle contract not provided"
            )
        if self.python_sandbox is not None and not self.python_sandbox.available:
            self.configuration_error = (
                "explicit Python sandbox profile not accepted or unavailable"
            )

    def solve(self, problem: str, metadata: dict | None = None) -> dict:
        if self.mode == "shared_public":
            from .shared_entry import solve_shared_public

            if not isinstance(problem, str) or not problem.strip():
                raise ValueError("nonempty problem required")
            idx = metadata.get("idx") if isinstance(metadata, dict) else None
            if type(idx) not in (str, int):
                raise ValueError(
                    "trusted public item identity required for shared recovery"
                )
            coord, context = self.shared_coordinator, self.run_context
            digest = ProblemContract(problem).digest
            from .runtime.coordinator import AdmissionError

            try:
                if context.resume:
                    item, existing, recovered = coord.recover_item(str(idx), digest)
                else:
                    with self._shared_lock:
                        began = (
                            self._shared_started
                            if self._shared_first
                            else time.monotonic()
                        )
                        self._shared_first = False
                    item, existing = coord.register_item(
                        str(idx), digest, started=began
                    )
                    recovered = None
            except AdmissionError as exc:
                # A second worker cannot close or overwrite the actual owner.
                return {
                    "final_response": UNSOLVED,
                    "trace": [
                        {
                            "step": "shared_admission_rejected",
                            "content": {"reason": type(exc).__name__},
                        }
                    ],
                }
            if existing is not None:
                return existing
            return solve_shared_public(
                problem,
                client=self.client,
                authority=coord,
                item=item,
                recovered=recovered,
                known_total=context.known_total,
                experiment=self.experiment,
                python_sandbox=self.python_sandbox,
                public_return_settles=context.public_return_authority
                == "official_public_return",
            )
        if self.mode == "platform":
            return self._platform_runtime.solve(problem, metadata)
        solve_started = (
            self.parent_item_started
            if self.parent_item_started is not None
            else time.monotonic()
        )
        store = ArtifactStore(ProblemContract(str(problem)))
        if self.configuration_error:
            return {
                "final_response": UNSOLVED,
                "status": "blocked_external",
                "trace": [
                    {
                        "kind": "integration_missing",
                        "details": {"reason": self.configuration_error},
                    }
                ],
            }
        coordinator, item = None, None
        try:
            version_parts = (
                self.version,
                asdict(self.capabilities),
                self.soft_seconds,
                self.total_items,
            )
            if self.experiment.ablation != "none":
                version_parts += (self.experiment.ablation,)
            if self.python_sandbox is not None:
                version_parts += (("python_sandbox", self.python_sandbox.identity),)
            if self.runtime_contract_identity is not None:
                version_parts += (
                    (
                        "local_runtime",
                        self.runtime_contract_identity,
                        self.generation_margin,
                    ),
                )
            if self.request_profile != "fixed_8192":
                version_parts += (("request_profile", self.request_profile),)
            coordinator = GlobalCoordinator(
                Path(self.state_dir) / "coordinator.sqlite3",
                self.run_id,
                limits=self.limits,
                version=fingerprint(version_parts),
                started=self.parent_run_started,
                wall_started=self.parent_run_wall,
                generation_margin=self.generation_margin,
                known_total=self.total_items,
                provider_rate_policy=self.provider_rate_policy,
            )
            adapter = S2Adapter(
                self.client,
                coordinator,
                self.capabilities,
                request_profile=self.request_profile,
            )
            # Only documented public idx is used. No answer, oracle, family, or gold fields.
            idx = metadata.get("idx") if isinstance(metadata, dict) else None
            key = (
                str(idx)
                if type(idx) in (str, int)
                else "problem:" + store.problem.digest
            )
            recovered = None
            if self.resume:
                item, existing, recovered = coordinator.recover_item(
                    key, store.problem.digest
                )
            else:
                item, existing = coordinator.register_item(
                    key, store.problem.digest, started=solve_started
                )
            if existing is not None:
                return existing
            if recovered is not None:
                store = ArtifactStore.restore(store.problem, recovered)
                store.event(
                    "recovery_task_graph"
                    if store.control.get("planning")
                    else "recovery_closeout",
                    reason="resume committed graph under original deadlines; spent generations are never replayed",
                )
            coordinator.admit_item(item)
            recording, registered = None, None
            python_sandbox = self.python_sandbox
            if self.diagnostic_sink is not None:
                from .runtime.diagnostics import RecordingPython, RecordingRegistered
                from .tools import RegisteredExecutor

                recording = self.diagnostic_sink.begin_item(
                    store=store,
                    item=item,
                    coordinator=coordinator,
                    adapter=adapter,
                    experiment=self.experiment,
                    known_total=self.total_items,
                    python_sandbox=python_sandbox,
                    initial_snapshot=recovered,
                    entry="closeout"
                    if recovered is not None and not store.control.get("planning")
                    else "solve",
                )
                adapter.diagnostic_sink = recording.call
                adapter.lifecycle_sink = self.diagnostic_sink.journal
                store.event_sink = lambda row: self.diagnostic_sink.journal(
                    {
                        "event": "mathematical_state_event",
                        "item_id": item.id,
                        "at": coordinator.clock(),
                        "row": row,
                    }
                )
                registered = RecordingRegistered(RegisteredExecutor(), recording)
                if python_sandbox is not None:
                    python_sandbox = RecordingPython(python_sandbox, recording)
            controller = Controller(
                adapter,
                item,
                store,
                soft_seconds=self.soft_seconds,
                total_items=self.total_items,
                experiment=self.experiment,
                python_sandbox=python_sandbox,
                clock=recording.math_clock if recording else None,
                registered_executor=registered,
            )
            result = (
                controller.closeout()
                if recovered is not None and not store.control.get("planning")
                else controller.solve()
            )
        except Exception as exc:  # noqa: BLE001 - official seam must return a nonempty JSON-safe result
            store.event("runtime_error", error_type=type(exc).__name__)
            result = finalize(store)
            result["error_type"] = type(exc).__name__
            result.update(
                termination_reason="RUNTIME_ERROR",
                failed_phase="controller",
                budget_remaining={
                    "soft_seconds": max(
                        0.0,
                        item.started
                        + store.control.get("soft_seconds", 0)
                        - coordinator.clock(),
                    )
                }
                if coordinator is not None and item is not None
                else {},
                blocked_by=["runtime_error:" + type(exc).__name__],
            )
        try:
            if coordinator is not None and item is not None:
                if self.diagnostic_sink is not None:
                    self.diagnostic_sink.record_state(store, item_id=item.id)
                    from .platform_entry import public_trace

                    events = store.events
                    deliveries = [
                        e["details"]
                        for e in events
                        if e["kind"] in {"delivery", "review"}
                    ]
                    with coordinator.transaction() as db:
                        requests = [
                            dict(row)
                            for row in db.execute(
                                "SELECT kind,status,outcome FROM requests WHERE item=?",
                                (item.id,),
                            )
                        ]
                    result["execution"] = {
                        "attempted": bool(requests),
                        "bootstrap_succeeded": any(
                            e.get("finish_reason") in {"stop", "end_turn"}
                            and not e.get("error")
                            and not e.get("violations")
                            and e.get("gap", "NONE") == "NONE"
                            for e in deliveries
                        ),
                        "solver_entered": any(
                            e["kind"] == "work_unit"
                            and e["details"]["unit"]["kind"]
                            not in {"PLAN", "REVIEW_CONFLICT"}
                            for e in events
                        ),
                        "remote_usage_unknown": any(
                            r["status"] == "IN_FLIGHT" for r in requests
                        ),
                        "concrete_work_unit_delivered": any(
                            a.closed
                            and store.control.get("artifact_units", {})
                            .get(a.id, {})
                            .get("kind")
                            in {"DERIVE", "COMPUTE", "CANDIDATE", "CHECK", "REPAIR"}
                            for a in store.artifacts.values()
                        ),
                        "configuration_error": any(
                            str(r.get("outcome", "")).startswith(
                                "provider_rejected_http_"
                            )
                            for r in requests
                        ),
                        "logical_calls": len(requests),
                        "tool_executions": sum(
                            e["kind"] == "tool_executed" for e in events
                        ),
                    }
                    from .observability import module_usage

                    result["execution"]["module_usage"] = module_usage(store.snapshot())
                    result["trace"] = public_trace(
                        events,
                        coordinator.metrics(),
                        64,
                        capabilities={
                            "mode": "local",
                            "global_resource_authority": "trusted_same_host_coordinator",
                            "stream_requested": True,
                            "persistent_agent_recovery": any(
                                e["kind"] == "task_graph_recovery" for e in events
                            ),
                            "generated_python_available": self.python_sandbox
                            is not None,
                        },
                    )
                if coordinator.clock() >= item.deadline:
                    result["termination_reason"] = "HARD_DEADLINE"
                result = coordinator.close_item(item, result, snapshot=store.snapshot())
            json.dumps(result, ensure_ascii=False, allow_nan=False)
        except Exception as exc:  # noqa: BLE001 - storage failure cannot violate the official return contract
            result = {
                "final_response": str(result.get("final_response") or UNSOLVED),
                "status": "error",
                "error_type": type(exc).__name__,
                "trace": [
                    {"kind": "persistence_or_serialization_failure", "details": {}}
                ],
            }
        return result
