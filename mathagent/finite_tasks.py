"""Bounded new-core integration tasks, not a full evaluation or a score runner.

All items share one coordinator; expired prior ledgers are read-only reservations.
A stable same-host session directory serializes cooperating batches and records
every new ledger before dispatch so a later invocation cannot omit its unknowns.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path

from .entrypoint import ReasoningAgent, code_version
from .evaluation import public_problems
from .runtime.config import ClientCapabilities, Limits, fingerprint
from .runtime.coordinator import GlobalCoordinator
from .runtime.prior_usage import PriorUsage


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=".pending-", delete=False
    ) as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
        pending = stream.name
    os.replace(pending, path)


@contextmanager
def session(directory):
    try:
        import fcntl
    except ImportError:
        raise ValueError(
            "local shared-session execution requires POSIX flock support"
        ) from None
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "session.lock").open("a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("another finite batch holds the shared session") from None
        registry = directory / "ledgers.json"
        paths = (
            json.loads(registry.read_text(encoding="utf-8"))
            if registry.exists()
            else []
        )
        if not isinstance(paths, list) or any(
            not isinstance(path, str) for path in paths
        ):
            raise ValueError("invalid session ledger registry")
        yield paths, registry


def finite_limits(reserved, calls, seconds):
    if type(calls) is not int or not 1 <= calls <= 30:
        raise ValueError("finite task batch permits at most 30 logical requests")
    if type(seconds) is not int or not 1 <= seconds <= 300:
        raise ValueError("finite task batch permits at most 300 seconds")
    return Limits(
        in_flight=8 - reserved,
        normal_per_problem=min(2, 8 - reserved),
        logical_requests=calls,
        problem_seconds=min(120, seconds),
        run_seconds=seconds,
    )


def run_batch(
    *,
    items,
    capabilities,
    client_factory,
    model_id,
    output,
    run_id,
    session_dir,
    prior_paths,
    calls=30,
    seconds=300,
    execute=False,
):
    items = public_problems(items)
    if not 1 <= len(items) <= 3 or len({str(row["idx"]) for row in items}) != len(
        items
    ):
        raise ValueError("finite tasks require one to three distinct public problems")
    capabilities.validate()
    if not capabilities.offline_simulation and not model_id:
        raise ValueError("explicit real model identity required")
    output = Path(output).resolve()
    with session(Path(session_dir)) as (registered, registry):
        paths = list(prior_paths) + registered
        if not paths and not capabilities.offline_simulation:
            raise ValueError(
                "real finite tasks require the explicit prior-ledger inventory"
            )
        prior = PriorUsage(paths)
        limits = finite_limits(prior.reserved, calls, seconds)
        version = code_version()
        manifest = {
            "kind": "FINITE_NEW_CORE_INTEGRATION_NOT_FULL_EVALUATION",
            "mode": "OFFLINE_SIMULATION"
            if capabilities.offline_simulation
            else "REAL_CLIENT",
            "run_id": run_id,
            "code_version": version,
            "model_id": model_id,
            "input_hash": fingerprint(items),
            "total": len(items),
            "capabilities": asdict(capabilities),
            "limits": asdict(limits),
            "prior_ledgers": [asdict(row) for row in prior.ledgers],
            "prior_unknown_reserved": prior.reserved,
            "session_directory": str(Path(session_dir).resolve()),
            "generated_python_enabled": False,
            "official_platform_accepted": False,
            "judging": "NOT_RUN",
        }
        if not execute:
            return {"preflight_only": True, "manifest": manifest}
        output.mkdir(parents=True, exist_ok=False)
        atomic_json(output / "manifest.json", manifest)
        module, name = client_factory.split(":", 1)
        client = getattr(importlib.import_module(module), name)()
        if (
            not capabilities.offline_simulation
            and getattr(client, "model", None) != model_id
        ):
            raise ValueError("injected model identity differs from the manifest")
        client = prior.wrap(client)
        ledger = output / "state" / "coordinator.sqlite3"
        # Match ReasoningAgent's version binding exactly; every solver uses this run.
        coord = GlobalCoordinator(
            ledger,
            run_id,
            limits=limits,
            version=fingerprint((version, asdict(capabilities), None, len(items))),
        )
        atomic_json(
            registry, sorted({row.path for row in prior.ledgers} | {str(ledger)})
        )
        prior.validate()  # Fail before any model call if the source accounting changed.

        def solve(item):
            agent = ReasoningAgent(
                client,
                run_id=run_id,
                state_dir=output / "state",
                capabilities=capabilities,
                limits=limits,
                total_items=len(items),
                version=version,
            )
            return {
                "idx": item["idx"],
                **agent.solve(item["problem"], {"idx": item["idx"]}),
            }

        results = []
        with (
            ThreadPoolExecutor(max_workers=3) as pool,
            (output / "outputs.jsonl").open("x", encoding="utf-8") as stream,
        ):
            for future in as_completed([pool.submit(solve, item) for item in items]):
                result = future.result()
                results.append(result)
                stream.write(json.dumps(result, ensure_ascii=False) + "\n")
                stream.flush()
        with coord.transaction() as db:
            rows = [
                dict(row)
                for row in db.execute("SELECT * FROM requests ORDER BY dispatched,id")
            ]
        events = [(row["dispatched"], 1) for row in rows]
        events += [(row["settled"], -1) for row in rows if row["settled"] is not None]
        active, peak = prior.reserved, prior.reserved
        for _, change in sorted(events):
            active += change
            peak = max(active, peak)
        report = {
            "manifest": manifest,
            "metrics": coord.metrics(),
            "requests": rows,
            "outputs": [
                {
                    "idx": row["idx"],
                    "status": row.get("status"),
                    "final_response": row["final_response"],
                }
                for row in results
            ],
            "peak_in_flight_including_prior_reservations": peak,
            "retained_in_flight_including_prior": prior.reserved
            + coord.metrics()["in_flight"],
            "correctness_score": "NOT_GRADED_INTEGRATION_ONLY",
        }
        prior.validate()
        atomic_json(output / "report.json", report)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--capabilities", type=Path, required=True)
    parser.add_argument("--client-factory", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--session-dir", type=Path, required=True)
    parser.add_argument("--prior-ledger", type=Path, action="append", default=[])
    parser.add_argument("--max-calls", type=int, default=30)
    parser.add_argument("--seconds", type=int, default=300)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    report = run_batch(
        items=[
            json.loads(line)
            for line in args.input.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ],
        capabilities=ClientCapabilities(
            **json.loads(args.capabilities.read_text(encoding="utf-8"))
        ),
        client_factory=args.client_factory,
        model_id=args.model_id,
        output=args.output,
        run_id=args.run_id,
        session_dir=args.session_dir,
        prior_paths=args.prior_ledger,
        calls=args.max_calls,
        seconds=args.seconds,
        execute=args.execute,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
