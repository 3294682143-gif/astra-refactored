"""Full-S2 local runner: one original clock/ledger, supervised children, bound scores.

Diagnostic calls and the following suite share the SAME 10000-call/21600-second
authority. Input answers remain parent-side/offline; worker input is allowlisted.
"""

import argparse
import importlib
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

from .diagnostic_selection import select_diagnostic_items, tool_activation_failed
from .domain import ProblemContract
from .entrypoint import ReasoningAgent, code_version
from .eval_dispatch import not_attempted
from .finalization import UNSOLVED, finalize
from .finite_tasks import atomic_json, session
from .local_configuration import (
    check_external_history,
    inspect_target,
    read_configuration,
)
from .process_supervision import Child, drain_request_observers, supervise
from .runtime.config import ClientCapabilities, Limits, fingerprint
from .runtime.coordinator import GlobalCoordinator, Item
from .runtime.diagnostics import LocalDiagnostics
from .runtime.prior_usage import PriorUsage
from .runtime.wasi_acceptance import sha
from .store import ArtifactStore


def local_version(manifest, caps, profile_identity):
    parts = (manifest["code_version"], asdict(caps), None, manifest["total"])
    if profile_identity is not None:
        parts += (("python_sandbox", profile_identity),)
    parts += (("local_runtime", manifest["run_contract_fingerprint"], 10),)
    request_profile = manifest.get("request_contract", {}).get(
        "request_profile", "fixed_8192"
    )
    if request_profile != "fixed_8192":
        parts += (("request_profile", request_profile),)
    return fingerprint(parts)


def read_saved(coord, row, reason):
    with coord.transaction() as db:
        saved = db.execute(
            "SELECT * FROM items WHERE run=? AND item_key=?",
            (coord.run_id, str(row["idx"])),
        ).fetchone()
        receipt = (
            db.execute(
                "SELECT saved_at FROM item_final_receipts WHERE item=?", (saved["id"],)
            ).fetchone()
            if saved
            else None
        )
    if (
        saved is not None
        and saved["final"] is not None
        and receipt
        and receipt[0] <= saved["deadline"]
    ):
        result = json.loads(saved["final"])
    elif saved is not None and saved["snapshot"]:
        # Only previously committed mathematical state; no generation during grace.
        store = ArtifactStore.restore(
            ProblemContract(row["problem"]), json.loads(saved["snapshot"])
        )
        result = finalize(store)
    else:
        result = {"final_response": UNSOLVED, "status": "error", "trace": []}
    result.update(idx=row["idx"], termination_reason=reason)
    result.setdefault("execution", {}).update(
        attempted=saved is not None,
        remote_cancellation_confirmed=False,
        run_stop_reason=reason,
    )
    if saved is not None:
        item = Item(saved["id"], saved["started"], saved["deadline"])
        coord.stop_dispatch(reason, item=item)
        if saved["final"] is None:
            result = {"idx": row["idx"], **coord.close_item(item, result)}
    return result


def observed_stream_contract(output, manifest):
    """Only actual sender observations qualify a real diagnostic for the suite."""
    if manifest["mode"] == "OFFLINE_SIMULATION":
        return True
    dispatches, terminals = 0, 0
    for path in (output / "diagnostics").glob("diagnostic-*/events.jsonl"):
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row.get("event") == "http_dispatch":
                payload = row["payload"]
                profile = manifest.get("request_contract", {}).get(
                    "request_profile", "fixed_8192"
                )
                expected_cap = (
                    8192
                    if profile == "fixed_8192"
                    else row.get("intent", {}).get("effective_max_tokens")
                )
                if (
                    payload.get("model") != manifest["model_id"]
                    or payload.get("thinking_mode") is not False
                    or payload.get("stream") is not True
                    or payload.get("max_tokens") != expected_cap
                    or type(expected_cap) is not int
                    or expected_cap not in {2048, 4096, 8192}
                    or payload.get("temperature") != 0.2
                    or payload.get("messages", [])[-1:]
                    != [{"role": "assistant", "content": "STATUS: "}]
                    or row.get("payload_sha256") != fingerprint(payload)
                ):
                    return False
                dispatches += 1
            if row.get("event") == "terminal_receipt" and row.get("finish_reason") in {
                "stop",
                "end_turn",
            }:
                terminals += 1
    return dispatches > 0 and terminals > 0


def worker(payload_path):
    data = json.loads(Path(payload_path).read_text(encoding="utf-8"))
    manifest = data["manifest"]  # Hashes only, never references/answers.
    if code_version() != manifest["code_version"]:
        raise ValueError("worker code changed after freeze")
    if sha(__file__) != manifest["runner_hash"]:
        raise ValueError("worker runner changed after freeze")
    if manifest.get("source_snapshot"):
        from .source_snapshot import validate as validate_snapshot

        validate_snapshot(
            Path(__file__).resolve().parent.parent,
            manifest["source_snapshot"],
            code_version(),
        )
    module, name = data["factory"].split(":", 1)
    imported = importlib.import_module(module)
    if sha(imported.__file__) != manifest["sdk_sha256"]:
        raise ValueError("worker client changed after freeze")
    client = getattr(imported, name)()
    if client.model != manifest["model_id"]:
        raise ValueError("actual client model differs from frozen request")
    # The supplied connector exposes these public configured transport values.
    if (
        getattr(client, "connect_seconds", None),
        getattr(client, "read_seconds", None),
    ) != (10, 60):
        raise ValueError("actual connector timeout contract differs")
    caps = ClientCapabilities(**manifest["capabilities"])
    prior = PriorUsage(data["prior_paths"])
    current = [asdict(row) for row in prior.ledgers]
    frozen = {row["path"]: row for row in data["prior_frozen"]}
    for value in current:
        previous = frozen[value["path"]]
        if value["run_fingerprint"] != previous["run_fingerprint"] or not set(
            value["unknown"]
        ) <= set(previous["unknown"]):
            raise ValueError("prior responsibility changed before worker dispatch")
    sink = LocalDiagnostics(data["diagnostics"], run_manifest=manifest)
    agent = ReasoningAgent(
        prior.wrap(client),
        mode="local",
        run_id=manifest["run_id"],
        state_dir=data["state_dir"],
        capabilities=caps,
        total_items=manifest["total"],
        limits=Limits(**manifest["limits"]),
        version=manifest["code_version"],
        python_sandbox_profile=data["profile"],
        ablation="none",
        resume=data["resume"],
        _item_started=data["started"],
        _run_started=manifest["run_started"],
        _run_wall_started=manifest["run_wall_started"],
        _generation_margin=10,
        _provider_rate_policy=manifest.get("provider_rate_policy"),
        _runtime_contract_identity=manifest["run_contract_fingerprint"],
        _diagnostic_sink=sink,
        request_profile=manifest.get("request_contract", {}).get(
            "request_profile", "fixed_8192"
        ),
    )
    result = agent.solve(data["item"]["problem"], {"idx": data["item"]["idx"]})
    result.update(idx=data["item"]["idx"], completed_at=time.monotonic())
    atomic_json(Path(data["result_path"]), result)
    # solve() may return at a soft deadline while its daemon transport threads
    # still observe real generations. Exiting here would destroy those observers.
    # The saved answer stays immutable, even when a late terminal settles a lease.
    drain_request_observers(
        Path(data["state_dir"]) / "coordinator.sqlite3",
        run_id=manifest["run_id"],
        owner_pid=os.getpid(),
        deadline=min(
            data["started"] + agent.limits.problem_seconds,
            manifest["run_started"] + agent.limits.run_seconds,
        ),
    )


def phase(items, *, name, config, manifest, coord, prior, output):
    directory = output / name
    directory.mkdir(exist_ok=True)
    final_path = directory / "outputs.jsonl"
    existing = {}
    if final_path.exists():
        for line in final_path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if (
                row.get("manifest_fingerprint") != fingerprint(manifest)
                or row.get("run_id") != coord.run_id
            ):
                raise ValueError("phase outputs belong to a different run")
            existing[str(row["idx"])] = row
    todo = [row for row in items if str(row["idx"]) not in existing]

    def start_block_reason():
        prior.validate()
        metrics = coord.metrics()
        with coord.transaction() as db:
            stop = db.execute(
                "SELECT 1 FROM dispatch_stops WHERE run=? AND item=''", (coord.run_id,)
            ).fetchone()
        if stop:
            return "DISPATCH_STOPPED"
        if time.monotonic() >= metrics["deadline"]:
            return "RUN_HARD_DEADLINE"
        if metrics["calls"] >= coord.limits.logical_requests:
            return "LOGICAL_BUDGET_EXHAUSTED"
        if metrics["in_flight"] >= coord.limits.in_flight:
            return (
                "WAITING_CAPACITY"
                if metrics["active_local_observers"]
                else "UNSETTLED_REMOTE_CAPACITY"
            )
        return None

    def can_start():
        return start_block_reason() is None

    def stop_requested():
        with coord.transaction() as db:
            stopped = db.execute(
                "SELECT reason FROM dispatch_stops WHERE run=? AND item=''",
                (coord.run_id,),
            ).fetchone()
            if stopped:
                return (
                    "USER_STOP"
                    if stopped[0] == "USER_REQUESTED_STOP"
                    else "RUNTIME_STOP"
                )
        path = output / "stop-request.json"
        if not path.exists():
            return False
        value = json.loads(path.read_text(encoding="utf-8"))
        if value != {
            "run_id": coord.run_id,
            "manifest_fingerprint": fingerprint(manifest),
        }:
            raise ValueError("stop request does not bind this run")
        coord.stop_dispatch("USER_REQUESTED_STOP")
        return "USER_STOP"

    def launch(row, started):
        key = fingerprint(row["idx"])[:16]
        with coord.transaction() as db:
            old = db.execute(
                "SELECT * FROM items WHERE run=? AND item_key=?",
                (coord.run_id, str(row["idx"])),
            ).fetchone()
        if old is not None:
            started = old["started"]
        serial = str(time.monotonic_ns())
        result_path = directory / ("result-" + key + "-" + serial + ".json")
        payload_path = directory / ("worker-" + key + "-" + serial + ".json")
        # The worker never receives the input path, gold answers, or judge implementation.
        worker_manifest = dict(manifest)
        payload = {
            "item": {"idx": row["idx"], "problem": row["problem"]},
            "manifest": worker_manifest,
            "factory": config["client"]["factory"],
            "state_dir": str(coord.path.parent),
            "profile": config["assets"]["accepted_wasi_profile"],
            "diagnostics": str(
                output / "diagnostics" / (name + "-" + key + "-" + serial)
            ),
            "prior_paths": [r.path for r in prior.ledgers],
            "prior_frozen": [asdict(r) for r in prior.ledgers],
            "started": started,
            "resume": old is not None,
            "result_path": str(result_path),
        }
        atomic_json(payload_path, payload)
        log = directory / ("worker-" + key + "-" + serial + ".log")
        env = os.environ.copy()
        env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        with log.open("xb") as stream:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "mathagent.local_runner",
                    "--worker",
                    str(payload_path),
                ],
                stdout=stream,
                stderr=stream,
                env=env,
                start_new_session=True,
            )
        return Child(
            process,
            row,
            started,
            min(
                started + coord.limits.problem_seconds, manifest["run_started"] + 21600
            ),
            result_path,
        )

    def accept(row):
        row.update(
            run_id=coord.run_id, manifest_fingerprint=fingerprint(manifest), phase=name
        )
        with final_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        existing[str(row["idx"])] = row
        print(
            json.dumps(
                {
                    "phase": name,
                    "idx": row["idx"],
                    "status": row.get("status"),
                    "termination_reason": row.get("termination_reason"),
                    "logical_calls": row.get("execution", {}).get("logical_calls"),
                }
            ),
            flush=True,
        )

    _rows, unstarted, reason = supervise(
        todo,
        launch=launch,
        on_result=accept,
        recover=lambda child, why: read_saved(coord, child.item, why),
        can_start=can_start,
        run_deadline=manifest["run_started"] + 21600,
        parallelism=3,
        grace=10,
        stop_requested=stop_requested,
        on_reaped=lambda child: coord.note_local_owner_exit(child.process.pid),
        start_block_reason=start_block_reason,
    )
    for row in unstarted:
        result = not_attempted(row)
        result["termination_reason"] = reason or "RUN_ADMISSION_UNAVAILABLE"
        accept(result)
    return list(existing.values()), reason


def run(config, *, execute=False, resume=False, stop=False, diagnostic_only=None):
    output = Path(config["runtime"]["shared_state_dir"]).resolve().parent
    if stop:
        original = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
        if original["run_id"] != config["runtime"]["run_id"] or original[
            "configuration_fingerprint"
        ] != fingerprint(config):
            raise ValueError("stop must identify the existing configured run")
        atomic_json(
            output / "stop-request.json",
            {
                "run_id": original["run_id"],
                "manifest_fingerprint": fingerprint(original),
            },
        )
        return {"stop_requested": True, "remote_cancellation_confirmed": False}
    scope = config.get("execution_scope", "full_suite")
    if diagnostic_only is not None and (scope == "diagnostic_only") != diagnostic_only:
        raise ValueError("command dispatch scope differs from frozen configuration")
    items, caps, sandbox, proposed = inspect_target(config)
    session_dir = Path(config["runtime"]["session_registry_dir"]).resolve()
    with session(session_dir) as (registered, registry):
        current_ledger = (output / "state/coordinator.sqlite3").resolve()
        if not registered and not caps.offline_simulation:
            raise ValueError(
                "explicit historical inventory required; new empty registry is not zero usage"
            )
        prior = PriorUsage(
            [p for p in registered if Path(p).resolve() != current_ledger]
        )
        check_external_history(config)
        limits = Limits(
            in_flight=8 - prior.reserved, normal_per_problem=min(2, 8 - prior.reserved)
        )
        proposed.update(
            limits=asdict(limits),
            prior_frozen=[asdict(r) for r in prior.ledgers],
            prior_unknown_reserved=prior.reserved,
        )
        if not execute and not stop:
            from .resource_accounting import static_preview

            return {
                "preflight_only": True,
                "manifest": proposed,
                "no_model_calls": True,
                "capacity_report": static_preview(items, proposed, limits.in_flight),
            }
        manifest_path = output / "manifest.json"
        if resume or stop:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            old_history = {r["path"]: r for r in manifest["prior_frozen"]}
            if set(old_history) != {r.path for r in prior.ledgers}:
                raise ValueError("resume history inventory changed")
            for row in prior.ledgers:
                old = old_history[row.path]
                if row.run_fingerprint != old["run_fingerprint"] or not set(
                    row.unknown
                ) <= set(old["unknown"]):
                    raise ValueError("resume gained unaccounted history")
            # Later trusted settlements do not enlarge this run's frozen capacity.
            proposed.update(
                limits=manifest["limits"],
                prior_frozen=manifest["prior_frozen"],
                prior_unknown_reserved=manifest["prior_unknown_reserved"],
            )
            limits = Limits(**manifest["limits"])
            expected = {
                k: v
                for k, v in manifest.items()
                if k not in {"run_started", "run_wall_started"}
            }
            if expected != proposed:
                raise ValueError(
                    "resume/stop identity differs from original immutable run"
                )
        else:
            output.mkdir(mode=0o700, parents=True, exist_ok=False)
            manifest = {
                **proposed,
                "run_started": time.monotonic(),
                "run_wall_started": time.time(),
            }
            atomic_json(manifest_path, manifest)
        coord = GlobalCoordinator(
            current_ledger,
            manifest["run_id"],
            limits=limits,
            version=local_version(manifest, caps, sandbox.identity),
            started=manifest["run_started"],
            wall_started=manifest["run_wall_started"],
            generation_margin=10,
            known_total=manifest["total"],
            provider_rate_policy=manifest.get("provider_rate_policy"),
        )
        if stop:
            coord.stop_dispatch("USER_REQUESTED_STOP")
            return {"dispatch_stopped": True, "remote_cancellation_confirmed": False}
        atomic_json(registry, sorted(set(registered) | {str(current_ledger)}))
        state_path = output / "phase.json"
        state = (
            json.loads(state_path.read_text(encoding="utf-8"))
            if state_path.exists()
            else {"phase": "diagnostic"}
        )
        if state.get("phase") == "diagnostic_complete" and scope == "diagnostic_only":
            return {
                "diagnostic_passed": state["passed"],
                "suite_started": False,
                "execution_scope": scope,
                "output": str(output),
            }
        if state["phase"] == "diagnostic":
            coord.set_call_ceiling(30)
            diagnostic_items = select_diagnostic_items(
                items,
                config["evaluation"].get("diagnostic_item_ids"),
                require_goal_closure=config.get("goal_closure_policy", {}).get(
                    "diagnostic_require_goal_closure", False
                ),
            )
            diag, reason = phase(
                diagnostic_items,
                name="diagnostic",
                config=config,
                manifest=manifest,
                coord=coord,
                prior=prior,
                output=output,
            )
            sufficient = any(
                row.get("execution", {}).get("bootstrap_succeeded")
                and row.get("execution", {}).get("concrete_work_unit_delivered")
                for row in diag
            )
            usage = [row.get("execution", {}).get("module_usage", {}) for row in diag]
            compute_attempted = any(row.get("computational_tasks", 0) for row in usage)
            tool_chain_observed = any(row.get("tool_successful", 0) for row in usage)
            activation_failed = tool_activation_failed(
                usage,
                required=config["evaluation"].get(
                    "diagnostic_require_tool_execution", False
                ),
            )
            from .contract_diagnostics import goal_diagnostic_gate

            goal_gate = goal_diagnostic_gate(usage)
            from .contract_diagnostics import tool_diagnostic_gate

            tool_gate = tool_diagnostic_gate(
                usage,
                require_python=config["evaluation"].get(
                    "diagnostic_require_python", False
                ),
            )
            adoption_failed = (
                config["evaluation"].get("diagnostic_require_tool_adoption", False)
                and not tool_gate["passed"]
            )
            goal_failed = (
                config.get("goal_closure_policy", {}).get(
                    "diagnostic_require_goal_closure", False
                )
                and not goal_gate["passed"]
            )
            if (
                reason
                or not sufficient
                or coord.metrics()["in_flight"] >= limits.in_flight
                or not observed_stream_contract(output, manifest)
                or activation_failed
                or goal_failed
                or adoption_failed
            ):
                coord.stop_dispatch("DIAGNOSTIC_FAILED")
                atomic_json(
                    output / "diagnostic-report.json",
                    {
                        "passed": False,
                        "reason": reason
                        or (
                            tool_gate["reason"]
                            if adoption_failed
                            else goal_gate["reason"]
                            if goal_failed
                            else "diagnostic_computation_never_executed"
                            if activation_failed
                            else "diagnostic_not_integrated"
                        ),
                        "computation_attempted": compute_attempted,
                        "tool_chain_observed": tool_chain_observed,
                        "goal_closure_gate": goal_gate,
                        "tool_adoption_gate": tool_gate,
                        "metrics": coord.metrics(),
                        "real_model_accuracy": "NOT_ESTABLISHED",
                        "suite_started": False,
                    },
                )
                return {
                    "diagnostic_passed": False,
                    "suite_started": False,
                    "output": str(output),
                }
            from .resource_accounting import (
                capacity_blocks_dispatch,
                diagnostic_capacity,
            )

            atomic_json(
                output / "diagnostic-goal-report.json",
                {
                    **goal_gate,
                    "max_diagnostic_calls": 30,
                    "model_accuracy_established": False,
                },
            )

            capacity = diagnostic_capacity(output, manifest, coord)
            atomic_json(output / "capacity-report.json", capacity)
            if scope == "diagnostic_only":
                # This authorization can never fall through to the scored suite.
                coord.stop_dispatch("DIAGNOSTIC_COMPLETE")
                state = {
                    "phase": "diagnostic_complete",
                    "passed": True,
                    "execution_scope": scope,
                    "run_id": manifest["run_id"],
                    "manifest_fingerprint": fingerprint(manifest),
                }
                atomic_json(state_path, state)
                report = {
                    "diagnostic_passed": True,
                    "suite_started": False,
                    "execution_scope": scope,
                    "tool_adoption_gate": tool_gate,
                    "goal_closure_gate": goal_gate,
                    "metrics": coord.metrics(),
                    "output": str(output),
                    "real_model_accuracy": "NOT_ESTABLISHED",
                }
                atomic_json(output / "diagnostic-report.json", report)
                return report
            if (
                not caps.offline_simulation
                and manifest.get("goal_closure_policy")
                and capacity_blocks_dispatch(capacity)
            ):
                coord.stop_dispatch("CAPACITY_BLOCKED")
                return {
                    "diagnostic_passed": True,
                    "suite_started": False,
                    "stop_reason": "CAPACITY_BLOCKED",
                    "output": str(output),
                    "call_target_met": False,
                    "capacity_report": capacity,
                }
            state = {
                "phase": "suite",
                "diagnostic_calls": coord.metrics()["calls"],
                "original_model_testing_started": manifest["run_started"],
                "run_id": manifest["run_id"],
                "manifest_fingerprint": fingerprint(manifest),
                "diagnostic_outputs_sha256": sha(output / "diagnostic/outputs.jsonl"),
            }
            atomic_json(state_path, state)
        if (
            state.get("phase") != "suite"
            or state.get("run_id") != manifest["run_id"]
            or state.get("manifest_fingerprint") != fingerprint(manifest)
            or state.get("original_model_testing_started") != manifest["run_started"]
            or state.get("diagnostic_outputs_sha256")
            != sha(output / "diagnostic/outputs.jsonl")
            or not 0 < state.get("diagnostic_calls", 0) <= 30
            or not observed_stream_contract(output, manifest)
        ):
            raise ValueError(
                "suite requires its original bound diagnostic, not a manual phase flag"
            )
        coord.set_call_ceiling(10000)
        rows, reason = phase(
            items,
            name="suite",
            config=config,
            manifest=manifest,
            coord=coord,
            prior=prior,
            output=output,
        )
        coord.stop_dispatch("RUN_FINISHED" if reason is None else "EVALUATION_FAILED")
        # Canonical bound output is distinct from diagnostic output; never concatenate.
        canonical = output / "outputs.jsonl"
        encoded = "".join(
            json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n" for row in rows
        )
        if canonical.exists() and canonical.read_text(encoding="utf-8") != encoded:
            raise ValueError("existing canonical output cannot be overwritten")
        if not canonical.exists():
            with canonical.open("x", encoding="utf-8") as stream:
                stream.write(encoded)
        summary = {
            "total": len(items),
            "outputs": len(rows),
            "metrics": coord.metrics(),
            "diagnostic_calls": state["diagnostic_calls"],
            "stop_reason": reason,
            "original_started": manifest["run_started"],
            "local_not_official": True,
            "scoring": "READY_FOR_INDEPENDENT_FROZEN_JUDGE",
            "call_accounting": coord.call_accounting(),
        }
        from .observability import run_usage

        with coord.transaction() as db:
            snapshots = [
                json.loads(r[0])
                for r in db.execute(
                    "SELECT snapshot FROM items WHERE run=? AND item_key NOT LIKE 'diagnostic:%' AND snapshot IS NOT NULL",
                    (coord.run_id,),
                )
            ]
            requests = [
                dict(r)
                for r in db.execute(
                    "SELECT r.* FROM requests r JOIN items i ON r.item=i.id WHERE r.run=? AND i.item_key NOT LIKE 'diagnostic:%'",
                    (coord.run_id,),
                )
            ]
        observed = run_usage(
            snapshots, requests, normal_per_problem=limits.normal_per_problem
        )
        summary["features_observed"] = observed["observed"]
        atomic_json(
            output / "observed_features.json",
            {
                "run_id": coord.run_id,
                "manifest_fingerprint": fingerprint(manifest),
                "outputs_sha256": sha(canonical),
                "available": manifest.get("features", {}).get("available", {}),
                "enabled": manifest.get("features", {}).get("enabled", {}),
                **observed,
            },
        )
        atomic_json(output / "run_summary.json", summary)
        # Independent process: the original Judge sees references, never the workers.
        score_path = output / "judgements.json"
        if not score_path.exists():
            root = Path(__file__).resolve().parent.parent
            command = [
                sys.executable,
                str(root / "scripts/score_reference_judge.py"),
                "--input",
                config["evaluation"]["input_file"],
                "--references",
                config["evaluation"]["input_file"],
                "--outputs",
                str(canonical),
                "--manifest",
                str(manifest_path),
                "--contract",
                config["evaluation"]["frozen_judge_contract"],
            ]
            with (
                score_path.open("x", encoding="utf-8") as scored,
                (output / "judge.log").open("x", encoding="utf-8") as errors,
            ):
                completed = subprocess.run(
                    command, stdout=scored, stderr=errors, timeout=120, check=False
                )
            if completed.returncode:
                raise ValueError(
                    "independent frozen Judge failed; original outputs preserved"
                )
        from .scoring_binding import verify_report

        scored = json.loads(score_path.read_text(encoding="utf-8"))
        verify_report(scored, manifest, canonical.read_bytes())
        summary.update(
            scoring="BOUND_LOCAL_REFERENCE_JUDGE",
            correct=scored["correct"],
            accuracy=scored["accuracy"],
        )
        atomic_json(output / "run_summary.json", summary)
        return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument(
        "--diagnostic-only",
        action="store_true",
        help="must match frozen diagnostic_only scope; never runs the 112-item suite",
    )
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.worker:
        worker(args.worker)
        return 0
    if not args.config:
        parser.error("--config is required; the unfilled example is not executable")
    if args.resume and not args.execute:
        parser.error("resume requires --execute")
    result = run(
        json.loads(args.config.read_text(encoding="utf-8"))
        if args.stop
        else read_configuration(args.config),
        execute=args.execute,
        resume=args.resume,
        stop=args.stop,
        diagnostic_only=args.diagnostic_only,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("preflight_only") or result.get("stop_requested"):
        return 0
    if result.get("diagnostic_passed") is False:
        return 2
    return 1 if result.get("stop_reason") else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - CLI redaction boundary; never print SDK exception text
        # Never emit SDK exception text or a credential-bearing object repr.
        print(
            json.dumps({"status": "failed", "error_type": type(exc).__name__}),
            file=sys.stderr,
        )
        raise SystemExit(2) from None
