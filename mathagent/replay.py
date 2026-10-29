"""Explicit offline mathematical replay with strict configuration/consumption checks.

No SDK, network client, historical ledger or remote cancellation is used. Full
and resume replay currently require a recorded single-active-route Controller.
Python can replay bound *observations* only; registered tools are independently
re-executed under a fresh bounded LOCAL tool deadline, never trusted from logs.
"""

import copy
import hashlib
import json
import threading
import time
from collections import defaultdict, deque
from dataclasses import asdict
from pathlib import Path

from .answer_contracts import output_payload
from .controller import Controller
from .domain import ProblemContract
from .experiments import ExperimentConfig
from .finalization import UNSOLVED
from .run_contract import json_policy, resource_identities
from .runtime.adapter import Generation
from .runtime.config import Limits, fingerprint
from .runtime.coordinator import AdmissionError, DeadlineExceeded, Item
from .runtime.diagnostics import clock_lane
from .runtime.platform_adapter import PlatformAdapter
from .runtime.protocol import parse_response
from .runtime.public_coordination import PublicCallPolicy
from .store import ArtifactStore
from .tools import RegisteredExecutor, ToolResult


class ReplayMismatch(ValueError):
    pass


class UnsupportedReplay(ValueError):
    pass


class VisibleReplayClient:
    def __init__(self, directory=None, *, item_id=None, records=None):
        if records is None:
            records = [
                json.loads(p.read_text(encoding="utf-8"))
                for p in Path(directory).glob("call-*.json")
            ]
        self.rows, self.lock = defaultdict(deque), threading.RLock()
        self.used = self.saved_failed_calls = self.admitted_calls = (
            self.refused_calls
        ) = 0
        self.mismatches = []
        self.total = 0
        for row in sorted(records, key=lambda r: r["started_monotonic"]):
            if item_id is not None and row.get("item_id") != item_id:
                continue
            if row.get("schema") not in {
                "visible-public-math-delivery-v1",
                "visible-public-math-delivery-v2",
            }:
                raise UnsupportedReplay("unknown delivery record schema")
            self.rows[fingerprint(row["messages"])].append(row)
            self.total += 1

    def take(self, messages, parameters, *, intent=None):
        key = fingerprint(messages)
        with self.lock:
            rows = self.rows.get(key)
            if not rows:
                self.mismatches.append("unmatched_message:" + key)
                raise ReplayMismatch("no exact saved request")
            row = rows[0]
            if row.get("request_parameters", parameters) != parameters or (
                intent is not None and row.get("intent") != intent
            ):
                self.mismatches.append("request_configuration_or_intent:" + key)
                raise ReplayMismatch(
                    "request parameters/once/deadline differ from recording"
                )
            row = rows.popleft()
            self.used += 1
            if row.get("decision") == "refused":
                self.refused_calls += 1
            else:
                self.admitted_calls += 1
            if row.get("decision") != "refused" and (
                row.get("error")
                or row.get("late")
                or row.get("finish_reason") in {"length", "content_filter"}
            ):
                self.saved_failed_calls += 1
            return row

    def chat(self, messages, temperature=0.2, max_tokens=8192, *, thinking_mode=False):
        # Compatibility for delivery-only fixtures. Only replay_run below can
        # establish whole-workflow consistency and meaningful CLI success.
        row = self.take(
            messages,
            {
                "temperature": temperature,
                "max_tokens": max_tokens,
                "thinking_mode": thinking_mode,
            },
        )
        if row.get("error") or row.get("late") or row.get("decision") == "refused":
            raise RuntimeError("saved_call_failed_or_late")
        if row["public_return"]:
            return row["visible_response"]
        return {
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": row["visible_response"],
                    },
                    "finish_reason": row["finish_reason"],
                }
            ],
            "usage": row["usage"],
        }

    def metrics(self):
        return {
            "matched_calls": self.used,
            "expected_calls": self.total,
            "remaining_calls": sum(len(q) for q in self.rows.values()),
            "mismatched_calls": len(self.mismatches),
            "mismatch_reasons": self.mismatches,
            "saved_failed_calls_consumed": self.saved_failed_calls,
            "admitted_generations_matched": self.admitted_calls,
            "recorded_admission_refusals_matched": self.refused_calls,
        }


class ReplayCoordinator:
    def __init__(self, descriptor, state):
        self.item = Item(**descriptor["item"])
        self.limits = Limits(**descriptor["limits"])
        self.policy = PublicCallPolicy(**descriptor["public_call_policy"])
        self.hard_deadline = self.item.deadline
        self.now = descriptor["started_monotonic"]
        self.budgets = deque(state["budget_decisions"])
        self.clocks = {k: deque(v) for k, v in state["math_clock_reads"].items()}
        self.errors = []

    def clock(self):
        return self.now

    def math_clock(self):
        lane = clock_lane()
        values = self.clocks.get(lane)
        if not values:
            self.errors.append("unrecorded_math_clock_read:" + lane)
            raise ReplayMismatch(self.errors[-1])
        value = values.popleft()
        self.now = max(self.now, value)
        return value

    def suggested_soft_seconds(self, item, *, known_total=None):
        if item != self.item or not self.budgets:
            self.errors.append("unrecorded_budget_decision")
            raise ReplayMismatch(self.errors[-1])
        row = self.budgets.popleft()
        if row["known_total"] != known_total:
            self.errors.append("known_total_differs")
            raise ReplayMismatch(self.errors[-1])
        self.now = max(self.now, row["at"])
        return row["soft_seconds"]

    def checkpoint(self, item, snapshot):
        if item != self.item:
            raise ReplayMismatch("checkpoint item identity mismatch")
        return self.now < item.deadline

    def metrics(self):
        return {
            "remaining_budget_decisions": len(self.budgets),
            "remaining_math_clock_reads": sum(len(q) for q in self.clocks.values()),
            "budget_or_clock_mismatches": self.errors,
        }


class ReplayAdapter(PlatformAdapter):
    def __init__(self, client, coordinator, descriptor):
        super().__init__(client, coordinator)
        self.request_options = copy.deepcopy(descriptor["request_options"])
        self.public_contract = copy.deepcopy(descriptor["public_contract"])

    def invoke_packet(
        self,
        item,
        *,
        packet,
        kind,
        deadline=None,
        once=None,
        final=False,
        priority=10,
        protocol="l3",
    ):
        intent = {
            "kind": kind,
            "deadline": deadline,
            "once": once,
            "final": final,
            "priority": priority,
            "protocol": protocol,
        }
        parameters = {
            "temperature": 0.2,
            "max_tokens": self.coordinator.limits.max_tokens,
            **self.request_options,
        }
        row = self.client.take(packet, parameters, intent=intent)
        if row["item_id"] != item.id:
            raise ReplayMismatch("record belongs to a different item")
        self.coordinator.now = max(
            self.coordinator.now,
            row.get("returned_monotonic", row["started_monotonic"]),
        )
        if row["decision"] == "refused":
            error = {
                "AdmissionError": AdmissionError,
                "DeadlineExceeded": DeadlineExceeded,
            }.get(row["refusal"])
            if error is None:
                raise UnsupportedReplay("unrecognized recorded admission failure")
            raise error("recorded admission refusal; no real dispatch")
        saved = row["generation"]
        parsed = parse_response(
            row["visible_response"],
            finish_reason=row["finish_reason"],
            prefill=False,
            transport_complete=saved["transport"]["local_method_returned"]
            and not row["error"]
            and not row["late"],
            complete_public_return=row["public_return"],
        )
        if fingerprint(asdict(parsed)) != fingerprint(saved["parsed"]):
            self.client.mismatches.append(
                "parsed_delivery_differs:" + row["request_id"]
            )
            raise ReplayMismatch("current parser differs from saved delivery")
        return Generation(
            row["request_id"],
            parsed,
            row["finish_reason"],
            row["error"],
            row["late"],
            row["usage"],
            saved["transport"],
        )


class ReplayTools:
    def __init__(self, records):
        self.records = deque(records)
        self.errors, self.python_observations, self.registered_rechecks = [], 0, 0

    def take(self, kind, request):
        if not self.records:
            self.errors.append("missing_bound_tool_record")
            raise ReplayMismatch(self.errors[-1])
        row = self.records[0]
        if row["kind"] != kind or fingerprint(row["request"]) != fingerprint(request):
            self.errors.append("tool_input_obligation_scope_or_binding_differs")
            raise ReplayMismatch(self.errors[-1])
        return self.records.popleft()


class ObservationReplaySandbox:
    available = True

    def __init__(self, identity, tools):
        self.identity, self.tools = identity, tools

    def execute_bound(self, code, *, binding, **limits):
        row = self.tools.take(
            "python_observation", {"code": code, "binding": binding, **limits}
        )
        value = row["result"]
        if (
            value["evidence_kind"] not in {"BOUNDED_OBSERVATION", "NONE"}
            or value.get("verification") is not None
            or value.get("certificate") is not None
        ):
            raise UnsupportedReplay(
                "Python observation cannot supply mathematical verification authority"
            )
        self.tools.python_observations += 1
        return ToolResult(**value)


class CheckedReplayExecutor:
    def __init__(self, tools):
        self.base, self.tools = RegisteredExecutor(), tools
        self.registry = self.base.registry

    def execute_bound(self, name, args, *, binding, **limits):
        row = self.tools.take(
            "registered_recheck",
            {"name": name, "args": args, "binding": binding, **limits},
        )
        # A new local deadline is only for this independent bounded checker, NOT
        # a reset of the historical model/run budget or a replayed remote permit.
        window = min(30, max(0, limits["deadline"] - row["started"]))
        result = self.base.execute(
            name, args, scope=limits["scope"], deadline=time.monotonic() + window
        )
        if fingerprint(asdict(result)) != fingerprint(row["result"]):
            self.tools.errors.append("independent_registered_result_differs")
            raise ReplayMismatch(self.tools.errors[-1])
        self.tools.registered_rechecks += 1
        return result


def load_record(root, reference):
    relative = Path(reference["path"])
    if relative.is_absolute() or ".." in relative.parts or len(relative.parts) != 1:
        raise UnsupportedReplay(
            "diagnostic references must stay inside the selected archive"
        )
    path = root / relative
    if path.is_symlink():
        raise UnsupportedReplay("diagnostic symlink is not a frozen record")
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != reference["sha256"]:
        raise ReplayMismatch("diagnostic content changed: " + relative.name)
    return json.loads(payload)


def replay_run(directory, state_path, *, mode, request_ids=()):
    report = {
        "offline_replay": True,
        "real_model_requests": 0,
        "replay_consistent": False,
        "mode": mode,
        "status": "REPLAY_DIVERGED",
        "differences": [],
    }
    client = coord = tools = None
    try:
        if mode not in {"full", "resume", "segment", "integrity"}:
            raise UnsupportedReplay(
                "choose full, resume, segment or integrity explicitly"
            )
        root = Path(directory).resolve(strict=True)
        state_file = Path(state_path).resolve(strict=True)
        if state_file.parent != root:
            raise UnsupportedReplay(
                "state and descriptor must belong to the same selected archive"
            )
        state = json.loads(state_file.read_text(encoding="utf-8"))
        if not state.get("descriptor"):
            raise UnsupportedReplay(
                "legacy diagnostics lack runtime/budget description; no default configuration inferred"
            )
        descriptor = load_record(root, state["descriptor"])
        if (
            descriptor.get("schema") != "math-replay-descriptor-v1"
            or descriptor["item"]["id"] != state["item_id"]
        ):
            raise UnsupportedReplay("descriptor/item identity mismatch")
        records = [load_record(root, ref) for ref in state["recorded_calls"]]
        if len({r["request_id"] for r in records}) != len(records) or any(
            r["item_id"] != state["item_id"]
            or r.get("recording_id") != descriptor["recording_id"]
            for r in records
        ):
            raise ReplayMismatch("duplicate or cross-item call inventory")
        actual_names = set()
        for path in root.glob("call-*.json"):
            if path.is_symlink():
                raise UnsupportedReplay("diagnostic symlinks are not frozen records")
            row = json.loads(path.read_text(encoding="utf-8"))
            if (
                row.get("item_id") == state["item_id"]
                and row.get("recording_id") == descriptor["recording_id"]
            ):
                actual_names.add(path.name)
        expected_names = {r["path"] for r in state["recorded_calls"]}
        if actual_names != expected_names:
            raise ReplayMismatch("missing or extra item calls in archive")
        if mode == "segment":
            if (
                not request_ids
                or len(set(request_ids)) != len(request_ids)
                or not set(request_ids) <= {r["request_id"] for r in records}
            ):
                raise UnsupportedReplay(
                    "segment requires explicit unique saved request IDs"
                )
            records = [r for r in records if r["request_id"] in request_ids]
        elif request_ids:
            raise UnsupportedReplay("request selection requires segment mode")
        from .entrypoint import code_version

        if (
            descriptor["source_version"] != code_version()
            or descriptor["mathematical_policy"] != json_policy()
        ):
            raise UnsupportedReplay(
                "source or mathematical policy differs; install the frozen snapshot for consistency replay"
            )
        if (
            descriptor["runtime_mode"] != "shared_public"
            or descriptor["solver"] != "mathagent"
            or descriptor["protocol"] != "l3-public-v1"
        ):
            raise UnsupportedReplay(
                "this mathematical replay does not reconstruct legacy/R4/platform process contracts"
            )
        if (
            descriptor["resources"]["skills_and_registry_sha256"]
            != resource_identities()["skills_and_registry_sha256"]
        ):
            raise UnsupportedReplay("Skill/registry resources differ")
        problem = ProblemContract(state["source_problem"])
        if problem.digest != descriptor["source_problem_hash"]:
            raise ReplayMismatch("source problem differs from description")
        if mode in {"full", "resume"} and state["snapshot"].get("control", {}).get(
            "tool_jobs"
        ):
            raise UnsupportedReplay(
                "asynchronous tool-job-v1 needs integrity/segment replay; the serial math-clock recorder cannot reconstruct local thread interleavings"
            )
        if mode in {"full", "resume"} and any(
            e["kind"] == "route_policy" and e["details"]["active_limit"] > 1
            for e in state["snapshot"]["events"]
        ):
            raise UnsupportedReplay(
                "parallel-route scheduling is not reconstructable by the single-lane math-clock recorder"
            )
        if mode in {"full", "resume"} and (
            (mode == "full") != (descriptor["initial_snapshot"] is None)
        ):
            raise UnsupportedReplay(
                "full/resume selection differs from recorded initial state"
            )
        client, coord, tools = (
            VisibleReplayClient(records=records),
            ReplayCoordinator(descriptor, state),
            ReplayTools(state["tool_executions"]),
        )
        adapter = ReplayAdapter(client, coord, descriptor)
        if mode in {"segment", "integrity"}:
            for row in records:
                try:
                    adapter.invoke_packet(
                        coord.item, packet=row["messages"], **row["intent"]
                    )
                except AdmissionError:
                    if row["decision"] != "refused":
                        raise
            report.update(
                final_candidate_checked=False,
                scope="saved packet/state/tool integrity, not temporal scheduling replay"
                if mode == "integrity"
                else "selected saved deliveries only, not whole math workflow",
            )
            if mode == "integrity":
                restored = ArtifactStore.restore(problem, state["snapshot"])
                if fingerprint(restored.snapshot()) != fingerprint(state["snapshot"]):
                    raise ReplayMismatch("restored mathematical state differs")
                for row in list(tools.records):
                    params = dict(row["request"])
                    if row["kind"] == "python_observation":
                        ObservationReplaySandbox(
                            descriptor["python_identity"], tools
                        ).execute_bound(**params)
                    elif row["kind"] == "registered_recheck":
                        CheckedReplayExecutor(tools).execute_bound(**params)
                    else:
                        raise ReplayMismatch("unknown tool receipt kind")
                from .contract_diagnostics import tool_chain_usage

                report["tool_flow"] = tool_chain_usage(state["snapshot"])
                report["full_scheduling_replay"] = "UNSUPPORTED_REPLAY_CONFIG"
        else:
            store = (
                ArtifactStore.restore(problem, descriptor["initial_snapshot"])
                if descriptor["initial_snapshot"] is not None
                else ArtifactStore(problem)
            )
            sandbox = (
                ObservationReplaySandbox(descriptor["python_identity"], tools)
                if descriptor["python_identity"]
                else None
            )
            ctl = Controller(
                adapter,
                coord.item,
                store,
                soft_seconds=descriptor["soft_seconds"],
                total_items=descriptor["known_total"],
                experiment=ExperimentConfig(**descriptor["experiment"]),
                python_sandbox=sandbox,
                clock=coord.math_clock,
                registered_executor=CheckedReplayExecutor(tools),
            )
            result = ctl.solve() if descriptor["entry"] == "solve" else ctl.closeout()
            original = state["snapshot"]
            replayed = store.snapshot()
            for key in (
                "problem_hash",
                "verified",
                "refuted",
                "invalid_proofs",
                "artifacts",
                "candidates",
                "evidence",
                "challenges",
                "tasks",
                "control",
                "failures",
            ):
                if fingerprint(original[key]) != fingerprint(replayed[key]):
                    report["differences"].append("mathematical_state:" + key)
            selected = state.get("expected_final")
            expected_answer = next(
                (
                    output_payload(problem.raw, c["answer"])
                    for c in original["candidates"]
                    if c["id"] == selected
                ),
                UNSOLVED,
            )
            if (
                result["final_response"] != expected_answer
                or result.get("candidate_revision") != selected
            ):
                report["differences"].append("selected_candidate_or_final_answer")
            original_events = [
                (e["kind"], e["details"])
                for e in original["events"]
                if e["kind"] in {"progress", "review", "tool_result", "selection"}
            ]
            new_events = [
                (e["kind"], e["details"])
                for e in replayed["events"]
                if e["kind"] in {"progress", "review", "tool_result", "selection"}
            ]

            def independent_r0_order(events):
                # Only independent initial reviews may complete in either order.
                # Keep every field, count, request binding and all later ordering;
                # moving R0 across the phase boundary is still a mismatch.
                initial, rest = [], []
                for kind, details in events:
                    if kind == "review" and details.get("position") == "R0":
                        if rest:
                            raise ReplayMismatch(
                                "R0 event outside initial review phase"
                            )
                        initial.append((kind, details))
                    else:
                        rest.append((kind, details))
                return (
                    sorted(initial, key=lambda row: (row[1]["role"], row[1]["request"]))
                    + rest
                )

            if fingerprint(independent_r0_order(original_events)) != fingerprint(
                independent_r0_order(new_events)
            ):
                report["differences"].append("review_tool_progress_or_selection_events")
            report.update(
                result={
                    k: result.get(k)
                    for k in ("final_response", "candidate_revision", "status")
                },
                final_candidate_checked=True,
                original_failure=expected_answer == UNSOLVED
                or any(
                    r.get("error")
                    or r.get("late")
                    or r.get("finish_reason") in {"length", "content_filter"}
                    for r in records
                ),
            )
    except UnsupportedReplay as exc:
        report.update(status="UNSUPPORTED_REPLAY_CONFIG", differences=[str(exc)])
    except (OSError, ValueError, TypeError, KeyError, RuntimeError) as exc:
        report["differences"].append(type(exc).__name__ + ":" + str(exc))
    if client is not None:
        report.update(client.metrics())
        if report["remaining_calls"] or report["mismatched_calls"]:
            report["differences"].append("model_call_consumption")
    if coord is not None and mode in {"full", "resume"}:
        report.update(coord.metrics())
        if any(coord.metrics().values()):
            report["differences"].append("budget_or_math_clock_consumption")
    if tools is not None and mode != "segment":
        report.update(
            replayed_python_observations=tools.python_observations,
            independent_registered_rechecks=tools.registered_rechecks,
            remaining_tools=len(tools.records),
            tool_mismatches=tools.errors,
            logged_python_has_no_new_verification_authority=True,
        )
        if tools.records or tools.errors:
            report["differences"].append("tool_consumption")
    if not report["differences"]:
        report.update(
            replay_consistent=True,
            status="CONSISTENT_REPRODUCTION",
            original_failure_reproduced=bool(report.get("original_failure")),
        )
    return report
