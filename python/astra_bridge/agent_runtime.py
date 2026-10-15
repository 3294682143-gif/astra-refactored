"""Thin Python Host runtime for the explicit ``engine="ts"`` preview entry.

One process, one root deadline, one injected public client. This module owns
spawn/reap of the Node stdio runtime and the three Host requests
(``runtime.initialize`` / ``session.solve`` / ``session.stop``); it performs no
mathematical decision, no retry and no remote cancellation claim. Every failure
is a fixed code and never falls back to the legacy Python solver.
"""

from __future__ import annotations

import copy
import hashlib
import math
import selectors
import subprocess
import threading
import time
import uuid
from pathlib import Path

from .agent_client import AgentClient
from .agent_host import AgentHost
from . import host_carriers, host_checkpoint
from .agent_protocol import AGENT_HOST_VERSION, load_manifest, payload
from .p0_probe import ProbeError, _child_env, _close_streams, _reap
from .p0_protocol import ProtocolError

__all__ = ["AgentRuntime"]

_MAX_TIMEOUT = 3600.0
_MAX_REMAINING_MS = 3600000
_REAP_SECONDS = 1.0
_MAX_PROBLEM_CHARS = 8192
_MAX_TOKENS = 8192
_HOST_IDS = ("host-1", "host-2", "host-3")
_PROFILE_ID = "math-agent-preview-v2"
_POLICIES = ("BEST_EFFORT", "STRICT")
_UNSOLVED = "Unsolved."
_DEPLOYMENT_CODES = ("CHILD_FAILED", "SPAWN_FAILED")
_RESUME_MODES = ("local", "shared_public")


def _fail(code="FIELD_VALUE"):
    raise ProbeError(code)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _code_points(value):
    count = 0
    index = 0
    length = len(value)
    while index < length:
        unit = ord(value[index])
        if 0xD800 <= unit <= 0xDBFF:
            if index + 1 >= length:
                return None
            if not 0xDC00 <= ord(value[index + 1]) <= 0xDFFF:
                return None
            index += 2
        elif 0xDC00 <= unit <= 0xDFFF:
            return None
        else:
            index += 1
        count += 1
    return count


def _default_script():
    root = Path(__file__).resolve().parents[2]
    return root / "apps" / "stdio-runtime" / "dist" / "src" / "main.js"


class AgentRuntime:
    """Explicit TS preview runtime behind the official ``solve`` interface.

    The constructor only validates its arguments and captures the injected
    public client; it performs no call, spawns nothing and reads no environment
    variable beyond the child allowlist used at spawn time.
    """

    def __init__(
        self,
        client,
        *,
        max_model_calls=4,
        max_work_units=2,
        max_effects=1,
        max_reviews=1,
        max_method_loads=0,
        max_repairs=0,
        max_r0=0,
        problem_seconds=5,
        policy="BEST_EFFORT",
        derive_budget=False,
        node="node",
        mode="platform",
    ):
        if not _is_int(max_model_calls) or not 0 <= max_model_calls <= 32:
            raise ValueError("invalid max_model_calls")
        if not _is_int(max_work_units) or not 1 <= max_work_units <= 32:
            raise ValueError("invalid max_work_units")
        if not _is_int(max_effects) or not 0 <= max_effects <= 2:
            raise ValueError("invalid max_effects")
        if not _is_int(max_reviews) or not 0 <= max_reviews <= 1:
            raise ValueError("invalid max_reviews")
        if not _is_int(max_method_loads) or not 0 <= max_method_loads <= 1:
            raise ValueError("invalid max_method_loads")
        if not _is_int(max_repairs) or not 0 <= max_repairs <= 1:
            raise ValueError("invalid max_repairs")
        if not _is_int(max_r0) or not 0 <= max_r0 <= 1:
            raise ValueError("invalid max_r0")
        if not isinstance(derive_budget, bool):
            raise ValueError("invalid derive_budget")
        if isinstance(problem_seconds, bool) or not isinstance(problem_seconds, (int, float)):
            raise ValueError("invalid problem_seconds")
        if not math.isfinite(problem_seconds) or not 0 < problem_seconds <= _MAX_TIMEOUT:
            raise ValueError("invalid problem_seconds")
        if policy not in _POLICIES:
            raise ValueError("invalid policy")
        if not isinstance(node, str) or not node:
            raise ValueError("invalid node")
        if mode not in host_carriers.MODES:
            raise ValueError("invalid mode")
        self.max_model_calls = max_model_calls
        self.max_work_units = max_work_units
        self.max_effects = max_effects
        self.max_reviews = max_reviews
        self.max_method_loads = max_method_loads
        self.max_repairs = max_repairs
        self.max_r0 = max_r0
        self.derive_budget = derive_budget
        self.problem_seconds = float(problem_seconds)
        self.policy = policy
        self.node = node
        self.mode = mode
        self.client = AgentClient(client)
        self._solve_lock = threading.Lock()
        self.last_journal = None
        # Defect 3: the real immutable SessionLog events and the real accumulated
        # model/effect/repair spend of the last successful run, so a checkpoint is
        # exported with a non-empty log and real counters (never [] / 0).
        self.last_session_log = None
        self.last_counts = None
        self.last_problem_hash = None

    # -- public surface ---------------------------------------------------

    def solve(self, problem, metadata=None, resume_checkpoint=None):
        """Run one bounded TS preview solve; never falls back to Python.

        ``resume_checkpoint`` is optional. When it is ``None`` the run is
        byte-identical to before. When it is supplied the Host first verifies
        the checkpoint identity through ``host_checkpoint`` and only then
        injects the authenticated SessionLog prefix; an in-flight
        ``OUTCOME_UNKNOWN`` request blocks the resume instead of replaying it.
        """
        started = time.monotonic()
        if not isinstance(problem, str) or not problem.strip():
            raise ValueError("invalid problem")
        length = _code_points(problem)
        if length is None or length > _MAX_PROBLEM_CHARS:
            raise ValueError("invalid problem")
        try:
            problem.encode("utf-8", errors="strict")
        except UnicodeEncodeError:
            raise ValueError("invalid problem") from None
        if not self._solve_lock.acquire(False):
            return self._unsolved(started, "ILLEGAL_TRANSITION", False)
        try:
            # Capture the trusted configuration once, before any spawn or
            # callback, so a later mutation of this instance cannot widen the
            # permissions of the run already in flight.
            options = {
                "maxModelCalls": self.max_model_calls,
                "maxWorkUnits": self.max_work_units,
                "maxEffects": self.max_effects,
                "maxReviews": self.max_reviews,
                "maxMethodLoads": self.max_method_loads,
                "maxRepairs": self.max_repairs,
                "maxR0": self.max_r0,
                "policy": self.policy,
                "problemSeconds": self.problem_seconds,
                "node": self.node,
                "deriveBudget": self.derive_budget,
            }
            resume = None
            if resume_checkpoint is not None:
                if self.mode not in _RESUME_MODES:
                    return self._unsolved(started, "FIELD_VALUE", False)
                prepared = self._prepare_resume(problem, options, resume_checkpoint)
                if isinstance(prepared, str):
                    return self._unsolved(started, prepared, False)
                options = prepared["options"]
                resume = prepared
            return self._solve(started, problem, options, resume)
        finally:
            self._solve_lock.release()

    # -- internals --------------------------------------------------------

    def _prepare_resume(self, problem, options, checkpoint):
        """Verify one checkpoint and tighten the root budget; fixed codes only.

        Returns the prepared resume mapping on success, or a fixed error code
        string. A blocked plan (an in-flight ``OUTCOME_UNKNOWN`` request id) is
        reported as ``OUTCOME_UNKNOWN`` and never replayed.
        """
        problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
        root_deadline_ms = max(1, min(_MAX_REMAINING_MS, int(self.problem_seconds * 1000)))
        try:
            prior = host_carriers.bind_carrier(
                self.mode, problem_hash, uuid.uuid4().hex, _PROFILE_ID,
                max_model_calls=self.max_model_calls,
                max_work_units=self.max_work_units,
                max_effects=self.max_effects,
                root_deadline_ms=root_deadline_ms,
            )
        except host_carriers.CarrierError as exc:
            return exc.code
        try:
            plan = host_checkpoint.resume_plan(
                checkpoint,
                prior=prior,
                session_id=uuid.uuid4().hex,
            )
        except host_checkpoint.CheckpointError as exc:
            return exc.code
        except host_carriers.CarrierError as exc:
            return exc.code
        if plan["blocked"]:
            return "OUTCOME_UNKNOWN"
        remaining = plan["remaining"]
        next_options = dict(options)
        next_options["maxModelCalls"] = min(
            options["maxModelCalls"], remaining["maxModelCalls"],
        )
        next_options["maxEffects"] = min(
            options["maxEffects"], remaining["maxEffects"],
        )
        return {
            "options": next_options,
            "sessionLog": plan["sessionLog"],
            "contractVersion": host_checkpoint.body_contract_version(checkpoint),
        }

    def export_checkpoint(self, problem, contract_version=1):
        """Export one controlled checkpoint of the last *successful* run.

        The checkpoint carries the real, non-empty SessionLog event sequence the
        Node run produced and the real accumulated model/effect spend (never a
        hard-coded empty log or ``effectCalls=0``). A non-resumable carrier, a
        malformed problem, a different problem hash or a rejected export yields
        ``None`` rather than a partial checkpoint.
        """
        if self.mode not in _RESUME_MODES:
            return None
        if not isinstance(problem, str) or not problem.strip():
            return None
        if self.last_session_log is None or not self.last_counts:
            return None
        problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
        if problem_hash != self.last_problem_hash:
            return None
        journal = self.last_journal if isinstance(self.last_journal, list) else []
        ledger, unknown = [], []
        for row in journal:
            if not isinstance(row, dict):
                continue
            state = row.get("state")
            if state not in ("REMOTE_TERMINAL_CONFIRMED", "OUTCOME_UNKNOWN"):
                continue
            if row.get("phase") not in ("WORK", "R2", "REPAIR", "R0"):
                continue
            ledger.append(row)
            if state == "OUTCOME_UNKNOWN":
                unknown.append(row.get("requestId"))
        root_deadline_ms = max(1, min(_MAX_REMAINING_MS, int(self.problem_seconds * 1000)))
        try:
            carrier = host_carriers.bind_carrier(
                self.mode, problem_hash, uuid.uuid4().hex, _PROFILE_ID,
                max_model_calls=self.max_model_calls,
                max_work_units=self.max_work_units,
                max_effects=self.max_effects,
                root_deadline_ms=root_deadline_ms,
            )
            return host_checkpoint.export_checkpoint(
                carrier=carrier, problem_hash=problem_hash,
                contract_version=contract_version,
                spent={
                    "modelCalls": self.last_counts.get("modelCalls", 0),
                    "effectCalls": self.last_counts.get("effectCalls", 0),
                },
                ledger=ledger,
                session_log=list(self.last_session_log),
                unknown_request_ids=unknown,
            )
        except (host_checkpoint.CheckpointError, host_carriers.CarrierError):
            return None

    def _solve(self, started, problem, options, resume=None):
        before_calls = self.client.calls
        before_records = len(self.client.snapshot())
        if self.client.blocked:
            return self._unsolved(started, "OUTCOME_UNKNOWN", False)
        deadline = started + options["problemSeconds"]
        try:
            manifest = load_manifest()
        except ProtocolError as exc:
            return self._unsolved(started, exc.code, False)
        script = _default_script()
        if not script.is_file():
            return self._unsolved(started, "CHILD_FAILED", False)
        problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
        session_id = uuid.uuid4().hex
        try:
            host_carriers.bind_carrier(
                self.mode, problem_hash, session_id, _PROFILE_ID,
                max_model_calls=self.max_model_calls, max_work_units=self.max_work_units,
                max_effects=self.max_effects,
                root_deadline_ms=max(1, min(_MAX_REMAINING_MS, int(self.problem_seconds * 1000))),
            )
        except host_carriers.CarrierError as exc:
            return self._unsolved(started, exc.code, False)
        host_options = {
            "maxModelCalls": options["maxModelCalls"],
            "maxWorkUnits": options["maxWorkUnits"],
            "maxEffects": options["maxEffects"],
            "maxReviews": options["maxReviews"],
            "maxMethodLoads": options["maxMethodLoads"],
            "maxRepairs": options["maxRepairs"],
            "maxR0": options["maxR0"],
            "policy": options["policy"],
            "deriveBudget": options["deriveBudget"],
            # G7/PR7 Slice 7d: always present; None on the default path.
            "resumeSessionLog": None,
            "resumeContractVersion": None,
        }
        if resume is not None:
            host_options["resumeSessionLog"] = resume["sessionLog"]
            host_options["resumeContractVersion"] = resume["contractVersion"]
        host = AgentHost(
            manifest, session_id, deadline, problem, problem_hash, host_options,
            self.client,
        )
        proc = None
        reaped = False
        result = None
        error_code = None
        try:
            host.check_deadline()
            common = {"protocolVersion": AGENT_HOST_VERSION, "sessionId": session_id}
            init = {
                **common,
                "profileId": _PROFILE_ID,
                "capabilities": {
                    "modelGenerate": "AVAILABLE",
                    "toolExecute": "AVAILABLE" if options["maxEffects"] > 0 else "UNAVAILABLE",
                    "methodLoad": (
                        "AVAILABLE"
                        if options["maxMethodLoads"] == 1 and options["maxEffects"] > 0
                        else "UNAVAILABLE"
                    ),
                    "generatedPython": "UNAVAILABLE",
                    "maxTokens": _MAX_TOKENS,
                    "maxTokensVerified": False,
                    "journal": "IN_MEMORY_ONLY",
                    "requireExplicitFinishForTools": True,
                },
                "remainingMs": max(1, min(_MAX_REMAINING_MS, int(host.remaining() * 1000))),
                "maxModelCalls": options["maxModelCalls"],
                "maxWorkUnits": options["maxWorkUnits"],
                "maxEffects": options["maxEffects"],
                "maxReviews": options["maxReviews"],
                "maxMethodLoads": options["maxMethodLoads"],
                "maxRepairs": options["maxRepairs"],
                "maxR0": options["maxR0"],
                "policy": options["policy"],
                "deriveBudget": options["deriveBudget"],
            }
            solve = {
                **common,
                "problem": problem,
                "problemHash": problem_hash,
                "remainingMs": max(1, min(_MAX_REMAINING_MS, int(host.remaining() * 1000))),
            }
            if resume is not None:
                solve["resumeSessionLog"] = resume["sessionLog"]
                solve["resumeContractVersion"] = resume["contractVersion"]
            stop = dict(common)
            payload(manifest, "runtime.initialize", "params", init, session_id)
            payload(manifest, "session.solve", "params", solve, session_id)
            payload(manifest, "session.stop", "params", stop, session_id)
            try:
                proc = subprocess.Popen(
                    [options["node"], str(script), "--agent-loop"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=_child_env(),
                    bufsize=0,
                )
            except OSError:
                error_code = "SPAWN_FAILED"
                proc = None
            if proc is None:
                return self._finish(
                    started, host, None, error_code, False, before_calls,
                    before_records,
                )
            host.proc = proc
            host.register("stdout", proc.stdout, selectors.EVENT_READ)
            host.register("stderr", proc.stderr, selectors.EVENT_READ)
            host.check_deadline()
            init["remainingMs"] = max(1, min(init["remainingMs"], int(host.remaining() * 1000)))
            solve["remainingMs"] = max(1, min(solve["remainingMs"], int(host.remaining() * 1000)))
            steps = (
                ("runtime.initialize", _HOST_IDS[0], init, lambda: host.expected is None),
                ("session.solve", _HOST_IDS[1], solve, lambda: host.solve_result is not None),
                ("session.stop", _HOST_IDS[2], stop, lambda: host.stop_acked),
            )
            for method, frame_id, params, until in steps:
                host.send(
                    proc,
                    {"jsonrpc": "2.0", "id": frame_id, "method": method, "params": params},
                    method,
                )
                host.pump(proc, until)
            host.drain_tail(proc)
            host.check_deadline()
            try:
                code = proc.wait(timeout=max(0.0, min(host.remaining(), _REAP_SECONDS)))
            except subprocess.TimeoutExpired:
                error_code = "TIMEOUT"
            else:
                if code != 0 or host.stderr_seen:
                    error_code = "CHILD_FAILED"
                elif host.solve_result is None:
                    error_code = "FIELD_VALUE"
                else:
                    result = host.solve_result
        except ProtocolError as exc:
            error_code = exc.code
        except ProbeError as exc:
            error_code = exc.code
        except OSError:
            error_code = "CHILD_FAILED"
        except Exception:  # noqa: BLE001 - fixed code only, never a traceback
            error_code = "FIELD_VALUE"
        finally:
            try:
                host.selector.close()
            except OSError:
                pass
            if proc is not None:
                reaped = _reap(proc)
                _close_streams(proc)
                if not reaped:
                    error_code = "CHILD_FAILED"
                    result = None
        return self._finish(
            started, host, result, error_code, reaped, before_calls, before_records,
        )

    def _finish(self, started, host, result, error_code, reaped, before_calls,
                before_records):
        """One unified return after the child has been reaped and closed.

        Every metric is taken from the real Host counters and the current
        private journal slice, so a spent model call is never washed to zero by
        a later failure. A missing Node result leaves the logical model count
        unknown (``None``) rather than a fabricated zero.
        """
        journal = self.client.snapshot()
        self.last_journal = copy.deepcopy(journal[before_records:])
        # Usage accounting follows the last settlement of each
        # (sessionId, requestId) pair in this run's journal slice. A request
        # that ended OUTCOME_UNKNOWN is never counted as zero: it is either a
        # known public usage or an unknown-usage request. A request whose text
        # is present but whose usage is missing still counts as unknown usage,
        # never as a fabricated complete.
        settled = {}
        order = []
        for row in journal[before_records:]:
            request_id = row.get("requestId")
            session_id = row.get("sessionId")
            if not isinstance(request_id, str) or not isinstance(session_id, str):
                continue
            key = (session_id, request_id)
            if key not in settled:
                order.append(key)
            settled[key] = row
        reported_tokens = 0
        known_usage_requests = 0
        unknown_usage = 0
        finish = None
        for key in order:
            row = settled[key]
            state = row.get("state")
            if state not in ("REMOTE_TERMINAL_CONFIRMED", "OUTCOME_UNKNOWN"):
                continue
            usage = row.get("usage")
            if isinstance(usage, dict) and _is_int(usage.get("total_tokens")):
                reported_tokens += usage["total_tokens"]
                known_usage_requests += 1
            else:
                unknown_usage += 1
            if row.get("finishReason") is not None:
                finish = row["finishReason"]
        actual_calls = self.client.calls - before_calls
        if actual_calls > known_usage_requests:
            unknown_usage = max(unknown_usage, actual_calls - known_usage_requests)
        metrics = {
            "client_method_calls": actual_calls,
            "logical_model_calls": None,
            "effect_calls": host.effect_calls,
            "review_calls": host.review_calls,
            "catalog_calls": host.catalog_calls,
            "method_loads": host.method_loads,
            "asset_calls": getattr(host, "asset_calls", 0),
            "work_units": None,
            "frames": host.frames,
            "remote_outcome_unknown": self.client.blocked,
            "known_http_attempts": None,
            "reported_tokens": reported_tokens if known_usage_requests > 0 else None,
            "unknown_usage_requests": unknown_usage,
        }
        if result is None or error_code is not None:
            if host.model_requests > 0:
                metrics["logical_model_calls"] = host.model_requests
            return self._unsolved(
                started, error_code or "FIELD_VALUE", reaped, metrics, finish,
            )
        summary = result["summary"]
        final_response = summary["finalResponse"]
        if not isinstance(final_response, str) or not final_response:
            return self._unsolved(started, "FIELD_VALUE", reaped, metrics, finish)
        trace = []
        for row in result["trace"]:
            trace.append(
                {
                    "seq": row["seq"],
                    "kind": row["kind"],
                    "id": row["id"],
                    "state": row["state"],
                    "code": row["code"],
                }
            )
        metrics["logical_model_calls"] = summary["modelCalls"]
        metrics["work_units"] = summary["workUnits"]
        # Defect 3: retain the run's real SessionLog prefix and accumulated spend
        # for a later checkpoint export.
        session_log_rows = result.get("sessionLog")
        self.last_session_log = copy.deepcopy(session_log_rows) if isinstance(session_log_rows, list) else None
        self.last_counts = {
            "modelCalls": summary["modelCalls"],
            "effectCalls": summary["effectCalls"],
            "repairCalls": summary["repairCalls"],
        }
        self.last_problem_hash = host.problem_hash
        return {
            "engine": "ts",
            "status": summary["status"],
            "final_response": final_response,
            "candidate_verified": False,
            "strictAcceptance": "NOT_PERFORMED",
            "mode": "TS_PREVIEW",
            "targetEnvironment": "TARGET_UNVERIFIED",
            "stopReason": summary["stopReason"],
            "reason": summary["reason"],
            "unresolvedObligations": list(summary["unresolvedObligations"]),
            "carrier": self.mode,
            "sessionId": host.session_id,
            "trace": trace,
            "metrics": metrics,
            "finishReason": finish,
            "childReaped": reaped,
            "elapsedMs": max(0, int((time.monotonic() - started) * 1000)),
        }

    def _unsolved(self, started, code, reaped, metrics=None, finish=None):
        if code not in _DEPLOYMENT_CODES and code not in (
            "TIMEOUT", "FIELD_VALUE", "ILLEGAL_TRANSITION", "OUTCOME_UNKNOWN",
            "MANIFEST_INVALID", "VERSION_MISMATCH", "EOF", "FRAME_TOO_LARGE",
            "FRAME_LIMIT_EXCEEDED", "INVALID_JSON", "INVALID_UTF8",
            "DUPLICATE_KEY", "DEPTH_EXCEEDED", "UNSAFE_INTEGER",
            "NON_FINITE_NUMBER", "FLOAT_TOKEN", "EXTRA_FIELD", "MISSING_FIELD",
            "FIELD_TYPE", "UNKNOWN_METHOD", "REJECTED_METHOD",
            "SESSION_MISMATCH", "ID_MISMATCH", "UNKNOWN_SCHEMA_KEYWORD",
            "CHECKPOINT_SHAPE", "CHECKPOINT_DIGEST", "CHECKPOINT_PROBLEM",
            "CHECKPOINT_VERSION", "CHECKPOINT_MODE", "CHECKPOINT_BUDGET",
            "CHECKPOINT_CARRIER", "CHECKPOINT_SEQ", "CHECKPOINT_BOUND",
            "CHECKPOINT_ENCODING", "BUDGET_WIDENED", "BUDGET", "MODE",
            "PROBLEM_HASH", "SESSION", "PROFILE", "CARRIER",
            "CROSS_PROBLEM_SESSION", "REQUEST_ID",
        ):
            code = "FIELD_VALUE"
        if metrics is None:
            metrics = {
                "client_method_calls": 0,
                "logical_model_calls": 0,
                "effect_calls": 0,
                "review_calls": 0,
                "catalog_calls": 0,
                "method_loads": 0,
                "work_units": 0,
                "frames": 0,
                "remote_outcome_unknown": self.client.blocked,
                "known_http_attempts": None,
                "reported_tokens": None,
                "unknown_usage_requests": 0,
            }
        return {
            "engine": "ts",
            "status": "unsolved",
            "final_response": _UNSOLVED,
            "candidate_verified": False,
            "strictAcceptance": "NOT_PERFORMED",
            "mode": "TS_PREVIEW",
            "targetEnvironment": "TARGET_UNVERIFIED",
            "stopReason": "ERROR",
            "reason": "NO_CANDIDATE",
            "unresolvedObligations": [],
            "code": code,
            "trace": [],
            "metrics": metrics,
            "finishReason": finish,
            "childReaped": reaped,
            "elapsedMs": max(0, int((time.monotonic() - started) * 1000)),
        }
