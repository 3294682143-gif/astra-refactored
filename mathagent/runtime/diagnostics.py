"""Explicit opt-in local mathematical replay data; never part of public trace."""

import hashlib
import json
import os
import threading
import uuid
from dataclasses import asdict
from os import open as open_descriptor
from pathlib import Path

from .config import fingerprint


class LocalDiagnostics:
    def __init__(self, directory, *, run_manifest=None):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.lock = threading.Lock()
        self.run_manifest = run_manifest
        self.sessions = {}

    def _save(self, name, value):
        # Only data delivered by our own adapter/store; no credentials, SDK
        # attributes or independent hidden-reasoning fields are inspected.
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        with self.lock:
            descriptor = open_descriptor(
                self.directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
        return {"path": name, "sha256": hashlib.sha256(encoded).hexdigest()}

    def call(self, value):
        return self._save(
            "call-" + fingerprint(value["request_id"]) + ".json",
            {
                "schema": "visible-public-math-delivery-v2"
                if "generation" in value or value.get("decision") == "refused"
                else "visible-public-math-delivery-v1",
                **value,
            },
        )

    def journal(self, value):
        """Append and flush before worker exit; never write credentials/headers."""
        payload = (
            json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n"
        ).encode("utf-8")
        with self.lock:
            fd = open_descriptor(
                self.directory / "events.jsonl",
                os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                0o600,
            )
            with os.fdopen(fd, "ab") as stream:
                stream.write(payload)
                stream.flush()

    def __call__(self, store):
        self.record_state(store, item_id=None)

    def record_state(self, store, *, item_id):
        session = self.sessions.get(item_id)
        self._save(
            # Diagnostic snapshot identity only: NEVER a guessed run identity.
            "state-" + store.problem.digest + "-" + uuid.uuid4().hex + ".json",
            {
                "schema": "local-math-state-v2" if session else "local-math-state-v1",
                "snapshot": store.snapshot(),
                "source_problem": store.problem.raw,
                "item_id": item_id,
                **(session.finished(store) if session else {}),
                "scope": "visible received mathematical content and controller state; not a model accuracy claim",
            },
        )

    def begin_item(
        self,
        *,
        store,
        item,
        coordinator,
        adapter,
        experiment,
        known_total,
        python_sandbox,
        initial_snapshot,
        entry,
    ):
        from ..entrypoint import code_version
        from ..run_contract import json_policy, resource_identities

        local = not hasattr(coordinator, "authority")

        descriptor = {
            "schema": "math-replay-descriptor-v1",
            "recording_id": uuid.uuid4().hex,
            "runtime_mode": "local" if local else "shared_public",
            "solver": "mathagent",
            "entry": entry,
            "run_id": getattr(coordinator, "authority", coordinator).run_id,
            "item": asdict(item),
            "limits": asdict(coordinator.limits),
            "source_version": code_version(),
            "protocol": "l3-stream-prefill-v1" if local else "l3-public-v1",
            "experiment": asdict(experiment),
            "mathematical_policy": json_policy(),
            "known_total": known_total,
            "soft_seconds": None,
            "python_identity": python_sandbox.identity if python_sandbox else None,
            "resources": resource_identities(
                python_sandbox.identity if python_sandbox else None
            ),
            "public_call_policy": None if local else asdict(coordinator.policy),
            "request_options": {
                "thinking_mode": False,
                "stream": True,
                "assistant_prefill": "STATUS: ",
            }
            if local
            else adapter.request_options,
            "public_contract": asdict(adapter.capabilities)
            if local
            else adapter.public_contract,
            "initial_snapshot": initial_snapshot,
            "started_monotonic": coordinator.clock(),
            "source_problem_hash": store.problem.digest,
            "run_manifest_fingerprint": fingerprint(self.run_manifest)
            if self.run_manifest
            else "component_fixture_no_run_manifest",
            "run_contract": self.run_manifest.get("run_contract")
            if self.run_manifest
            else None,
        }
        session = ItemRecording(self, descriptor, coordinator.clock)
        self.sessions[item.id] = session
        return session


def clock_lane():
    name = threading.current_thread().name
    if name.startswith("r0-review-"):
        return name
    return (
        "route"
        if threading.current_thread().name.startswith("math-route")
        else "controller"
    )


class ItemRecording:
    """An extension of LocalDiagnostics, not a second logging system."""

    def __init__(self, sink, descriptor, clock):
        self.sink, self.descriptor, self.clock = sink, descriptor, clock
        self.lock = threading.RLock()
        self.calls, self.budgets, self.tools = [], [], []
        self.clocks = {"controller": [], "route": []}
        self.reference = sink._save(
            "descriptor-" + uuid.uuid4().hex + ".json", descriptor
        )

    def math_clock(self):
        value = self.clock()
        with self.lock:
            self.clocks.setdefault(clock_lane(), []).append(value)
        self.sink.journal({"event": "math_clock", "lane": clock_lane(), "at": value})
        return value

    def budget(self, row):
        with self.lock:
            self.budgets.append(row)
        self.sink.journal({"event": "budget", **row})

    def call(self, row):
        reference = self.sink.call(
            row | {"recording_id": self.descriptor["recording_id"]}
        )
        with self.lock:
            self.calls.append(reference | {"request_id": row["request_id"]})

    def tool(self, kind, request, execute):
        started = self.clock()
        self.sink.journal(
            {"event": "tool_started", "kind": kind, "request": request, "at": started}
        )
        result = execute()
        self.sink.journal(
            {
                "event": "tool_finished",
                "kind": kind,
                "result": asdict(result),
                "at": self.clock(),
            }
        )
        with self.lock:
            self.tools.append(
                {
                    "kind": kind,
                    "request": request,
                    "result": asdict(result),
                    "started": started,
                    "finished": self.clock(),
                }
            )
        return result

    def finished(self, store):
        with self.lock:
            return {
                "descriptor": self.reference,
                "recorded_calls": list(self.calls),
                "budget_decisions": list(self.budgets),
                "math_clock_reads": self.clocks,
                "tool_executions": list(self.tools),
                "finished_monotonic": self.clock(),
                "recording_scope": "controller invocation, full if initial_snapshot is null, otherwise resume suffix",
                "expected_final": next(
                    (
                        e["details"].get("candidate_revision")
                        for e in reversed(store.events)
                        if e["kind"] == "selection"
                    ),
                    None,
                ),
            }


class RecordingPython:
    def __init__(self, sandbox, recording):
        self.base, self.recording = sandbox, recording
        self.available, self.identity = sandbox.available, sandbox.identity

    def execute_bound(self, code, *, binding, **limits):
        request = {"code": code, "binding": binding, **limits}
        return self.recording.tool(
            "python_observation", request, lambda: self.base.execute(code, **limits)
        )


class RecordingRegistered:
    def __init__(self, executor, recording):
        self.base, self.recording, self.registry = (
            executor,
            recording,
            executor.registry,
        )

    def execute_bound(self, name, args, *, binding, **limits):
        request = {"name": name, "args": args, "binding": binding, **limits}
        return self.recording.tool(
            "registered_recheck",
            request,
            lambda: self.base.execute(name, args, **limits),
        )
