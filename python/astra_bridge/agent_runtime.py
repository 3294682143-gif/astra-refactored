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
import os
import selectors
import subprocess
import threading
import time
import uuid
from pathlib import Path

from .agent_client import AgentClient
from .agent_host import (
    AgentHost,
    _build_python_sandbox,
    _resolve_python_sandbox_profile,
)
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


# Fixed codes the unsolved projection may carry. A code outside this closed
# vocabulary is replaced by ``FIELD_VALUE`` so a caller can never read a
# free-form string as if it were a contract code.
_UNSOLVED_CODES = (
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
    # A clean child exit that never delivered the `session.solve` result is a
    # protocol defect of its own; it must not be reported as a field failure.
    "NO_SOLVE_RESULT",
    # The Host's own deadline and budget refusals keep their codes here too,
    # otherwise the projection would downgrade them back to a field failure.
    "DEADLINE_EXCEEDED",
    # Stage D+ exploration refusals: the Host's capability refusal and the
    # generative-execution gate's own closed vocabulary. They are reported
    # verbatim instead of collapsing to a field failure.
    "ACTION_NOT_ALLOWED",
    "REFUSED_NO_PROFILE",
    "REFUSED_PROFILE_MISMATCH",
    "REFUSED_SHA_MISMATCH",
    "REFUSED_UNBOUNDED",
    "REFUSED_EXECUTION_FAILED",
    # Budget refusals already arrive as ``BUDGET``; listed for symmetry below.
)

_EXC_CODE_PREFIX = "EXC_"
_EXC_NAME_LIMIT = 24


def _exception_code(exc):
    """Fixed code for one unexpected internal exception.

    Only the *type* name is used, never the message, the arguments or a
    traceback, so no problem text, model text or tool argument can leak into a
    reported code. The alphabet and length are bounded, and anything unusual
    collapses to ``EXC_UNKNOWN``.
    """
    name = type(exc).__name__
    if not isinstance(name, str) or not name or len(name) > _EXC_NAME_LIMIT:
        return _EXC_CODE_PREFIX + "UNKNOWN"
    if not name.replace("_", "a").isalnum() or not name.isascii():
        return _EXC_CODE_PREFIX + "UNKNOWN"
    return _EXC_CODE_PREFIX + name


_STAGES = (
    "spawn", "runtime.initialize", "session.solve", "session.stop",
    "drain", "wait", "reap",
)


def _fixed_stage(stage):
    """The Host step a failed run stopped in, or ``None``.

    Fixed vocabulary only: a caller can never read an arbitrary string as a
    stage, so a diagnostic value cannot become a channel for raw text.
    """
    return stage if stage in _STAGES else None


def _fixed_child_code(code):
    """The child's own fixed code when it wrote exactly that, else ``None``."""
    if not isinstance(code, str):
        return None
    if not 0 < len(code) <= 32:
        return None
    if not code.isascii() or not code.replace("_", "A").isalnum():
        return None
    if not code[0].isupper():
        return None
    return code


def _fixed_unsolved_code(code):
    """Return ``code`` when it is inside the closed vocabulary."""
    if not isinstance(code, str):
        return "FIELD_VALUE"
    if code in _DEPLOYMENT_CODES or code in _UNSOLVED_CODES:
        return code
    if code.startswith(_EXC_CODE_PREFIX):
        suffix = code[len(_EXC_CODE_PREFIX):]
        if suffix and len(suffix) <= _EXC_NAME_LIMIT and suffix.isascii() and suffix.isalnum():
            return code
    return "FIELD_VALUE"


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


def _funnel_metrics(host, session_log):
    """Route/observation funnel counters of one run.

    Every number is derived from the real Node ``SessionLog`` rows and the real
    Host effect records; nothing here trusts a model claim, and no raw model
    text, tool argument or observation is ever copied into a metric.

    * ``routed``  -- Node ``REPAIR`` rows with ``data.kind == "TOOL_ROUTE"``;
    * ``forced``  -- those route rows the Node marked ``data.forced === true``;
    * ``obeyed``  -- ``TOOL_OBSERVATION`` rows that carry a route identity
      (``data.forced === true`` or a non-null ``data.routeId``);
    * ``observation_used`` -- ``CONSENSUS`` rows with
      ``data.stage == "ANSWER_CLOSURE"``, the closure turns that consume an
      input-relative observation;
    * ``closure_evaluations`` -- every ``CONSENSUS`` closure-evaluation row,
      including the ones that found no defect;
    * ``closure_defects`` -- those rows whose bounded ``defects`` list is not
      empty;
    * ``observation_views`` -- the largest ``observationViews`` count on one
      closure row;
    * ``tool_effect_calls`` / ``method_effect_calls`` -- Host effects by action;
    * ``tool_names`` / ``method_ids`` -- deduplicated identities actually spent,
      bounded by the declared caps;
    * ``exploration_calls`` -- admitted bounded generated-Python explorations
      (an exploration is one tool-kind effect, so it is also counted in
      ``tool_effect_calls`` and appears in ``tool_names`` as
      ``generated_exploration``);
    * ``front_budget`` / ``tail_reserve`` -- the Host's deterministic split of
      the flat model-call cap into a front-stage ceiling and a finalization
      reserve (HANDOFF §5 item 4);
    * ``front_spent`` -- the front-stage calls (R0/R2/R4) actually admitted.
    """
    routed = 0
    forced = 0
    obeyed = 0
    observation_used = 0
    closure_evaluations = 0
    closure_defects = 0
    observation_views = 0
    rows = session_log if isinstance(session_log, list) else ()
    for row in rows:
        if not isinstance(row, dict):
            continue
        kind = row.get("kind")
        data = row.get("data")
        if not isinstance(data, dict):
            continue
        if kind == "REPAIR" and data.get("kind") == "TOOL_ROUTE":
            routed += 1
            if data.get("forced") is True:
                forced += 1
        elif kind == "TOOL_OBSERVATION":
            route_id = data.get("routeId")
            if data.get("forced") is True or (
                isinstance(route_id, str)
                and route_id not in ("", "MODEL_SELECTED")
            ):
                obeyed += 1
        elif kind == "CONSENSUS" and data.get("stage") == "ANSWER_CLOSURE":
            closure = _closure_evaluation(data)
            if closure is None:
                continue
            defects, views, used = closure
            closure_evaluations += 1
            if defects:
                closure_defects += 1
            if views > observation_views:
                observation_views = views
            if used:
                observation_used += 1
    tool_effect_calls = 0
    method_effect_calls = 0
    effects = getattr(host, "effects", None)
    for entry in effects if isinstance(effects, list) else ():
        if not isinstance(entry, dict):
            continue
        request = entry.get("request")
        if not isinstance(request, dict):
            continue
        action = request.get("action")
        if not isinstance(action, dict):
            continue
        if action.get("action") == "tool":
            tool_effect_calls += 1
        elif action.get("action") == "explore":
            # Stage D+: an admitted exploration is one tool-kind effect.
            tool_effect_calls += 1
        elif action.get("action") == "math_asset":
            tool_effect_calls += 1
        elif action.get("action") == "method":
            method_effect_calls += 1
    tool_names = getattr(host, "tool_names", None)
    method_ids = getattr(host, "method_ids", None)
    tool_cap = getattr(host, "max_effects", 0)
    method_cap = getattr(host, "max_method_loads", 0)
    return {
        "routed": routed,
        "forced": forced,
        "obeyed": obeyed,
        "observation_used": observation_used,
        "closure_evaluations": closure_evaluations,
        "closure_defects": closure_defects,
        "observation_views": observation_views,
        "tool_effect_calls": tool_effect_calls,
        "method_effect_calls": method_effect_calls,
        "exploration_calls": getattr(host, "exploration_calls", 0),
        "tool_names": _bounded_identities(tool_names, tool_cap),
        "method_ids": _bounded_identities(method_ids, method_cap),
        # Stage quota audit (HANDOFF §5 item 4): the Host's own deterministic
        # split of the flat cap plus the front-stage calls it really admitted.
        # Read defensively so every metrics dict keeps the keys.
        "front_budget": getattr(host, "front_budget", 0),
        "tail_reserve": getattr(host, "tail_reserve", 0),
        "front_spent": getattr(host, "front_spent", 0),
    }


def _closure_evaluation(data):
    """Validated closure fields of one ``CONSENSUS`` row.

    Missing bounded fields fall back to their empty value for compatibility
    with older SessionLogs; a field that is present with the wrong type makes
    the whole row unusable, so the caller skips every closure counter for it.
    """
    request_id = data.get("requestId")
    if (
        "requestId" in data
        and request_id is not None
        and not isinstance(request_id, str)
    ):
        return None
    defects = data.get("defects", [])
    if not _string_list(defects):
        return None
    views = data.get("observationViews", 0)
    if not _is_int(views) or views < 0:
        return None
    used = data.get("observationUsed", False)
    if not isinstance(used, bool):
        return None
    for key in ("closureRequested", "candidateChanged"):
        if key in data and not isinstance(data[key], bool):
            return None
    remaining_defects = data.get("remainingDefects", [])
    if not _string_list(remaining_defects):
        return None
    return defects, views, used


def _string_list(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _bounded_identities(value, cap):
    """Deduplicated, cap-bounded copy of a recorded identity list."""
    if not isinstance(value, list) or not _is_int(cap) or cap < 0:
        return []
    out = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > 128:
            continue
        if item not in out:
            out.append(item)
        if len(out) >= cap:
            break
    return out


def _history_payload(history):
    if not isinstance(history, dict):
        return []
    out = []
    for rid, rec in history.items():
        if not isinstance(rid, str) or not isinstance(rec, dict):
            continue
        req = rec.get("request"); receipt = rec.get("receipt")
        if not isinstance(req, dict) or not isinstance(receipt, dict):
            continue
        out.append({"requestId": rid, "request": req, "receipt": receipt})
    return out


def _resume_session_id(resume):
    if not isinstance(resume, dict):
        return None
    for row in resume.get("sessionLog") or []:
        if isinstance(row, dict) and row.get("kind") == "SESSION_INIT":
            data = row.get("data")
            if isinstance(data, dict) and isinstance(data.get("sessionId"), str) and data["sessionId"]:
                return data["sessionId"]
    return None


def _default_script():
    """P0-3: the production default entry is the self-contained release bundle.

    It runs without the workspace ``node_modules`` (its only sibling dependency
    is the schema shipped next to it). A missing artifact is a fixed error at the
    call site; there is no silent fallback to an unusable path.
    """
    here = Path(__file__).resolve().parent
    packaged = here / "release" / "stdio-runtime.bundle.mjs"
    if packaged.is_file():
        # Installed distribution: the bundle + schema ship inside the package.
        return packaged
    root = Path(__file__).resolve().parents[2]
    return root / "release" / "stdio-runtime.bundle.mjs"


def _dev_script():
    """The workspace TypeScript entry, selected explicitly by a dev config."""
    root = Path(__file__).resolve().parents[2]
    return root / "apps" / "stdio-runtime" / "dist" / "src" / "main.js"


def resolve_script():
    """Resolve the stdio runtime entry.

    ``ASTRA_STDIO_RUNTIME=dev`` explicitly selects the workspace ``dist`` entry;
    otherwise the published release bundle is used. Enabling TS keeps its meaning
    (the engine is TS either way) - only the entry artifact changes.
    """
    if os.environ.get("ASTRA_STDIO_RUNTIME") == "dev":
        return _dev_script()
    return _default_script()


class AgentRuntime:
    """Explicit TS preview runtime behind the official ``solve`` interface.

    The constructor only validates its arguments and captures the injected
    public client; it performs no call, spawns nothing and reads no environment
    variable beyond the child allowlist used at spawn time, plus the single
    optional ``ASTRA_WASI_PROFILE`` that may name an already-accepted generated
    Python profile. With no such profile it reads no file at all.
    """

    def __init__(
        self,
        client,
        *,
        max_model_calls=8,
        max_work_units=4,
        max_effects=1,
        max_reviews=1,
        max_method_loads=0,
        max_repairs=0,
        max_consensus=0,
        max_r0=0,
        problem_seconds=600,
        policy="BEST_EFFORT",
        derive_budget=False,
        node="node",
        mode="platform",
        python_sandbox_profile=None,
        generated_python_gate=None,
        observer=None,
    ):
        if not _is_int(max_model_calls) or not 0 <= max_model_calls <= 256:
            raise ValueError("invalid max_model_calls")
        if not _is_int(max_work_units) or not 1 <= max_work_units <= 64:
            raise ValueError("invalid max_work_units")
        if not _is_int(max_effects) or not 0 <= max_effects <= 2:
            raise ValueError("invalid max_effects")
        if not _is_int(max_reviews) or not 0 <= max_reviews <= 3:
            raise ValueError("invalid max_reviews")
        if not _is_int(max_method_loads) or not 0 <= max_method_loads <= 4:
            raise ValueError("invalid max_method_loads")
        if not _is_int(max_repairs) or not 0 <= max_repairs <= 3:
            raise ValueError("invalid max_repairs")
        if not _is_int(max_consensus) or not 0 <= max_consensus <= 8:
            raise ValueError("invalid max_consensus")
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
        self.max_consensus = max_consensus
        self.max_r0 = max_r0
        self.derive_budget = derive_budget
        self.problem_seconds = float(problem_seconds)
        self.policy = policy
        self.node = node
        self.mode = mode
        self.client = AgentClient(client)
        # Stage D: an optional, already-accepted generated-Python profile. With
        # no profile (argument and ``ASTRA_WASI_PROFILE`` both absent) this is
        # ``(None, None, None)`` and no file is opened, so the default runtime is
        # byte-identical to the pre-Stage-D one.
        self.python_sandbox_profile = _resolve_python_sandbox_profile(
            python_sandbox_profile
        )
        (
            self.python_sandbox,
            self.python_sandbox_identity,
            self.python_sandbox_diagnostic,
        ) = _build_python_sandbox(self.python_sandbox_profile)
        # Stage D+: the fail-closed generative-execution gate. Absent means the
        # default instance, which carries no approved profile and can only
        # refuse; an approved gate is injected explicitly, never discovered.
        self.generated_python_gate = generated_python_gate
        self.observer = observer if callable(observer) else None
        self._solve_lock = threading.Lock()
        self.last_journal = None
        # Defect 3: the real immutable SessionLog events and the real accumulated
        # model/effect/repair spend of the last successful run, so a checkpoint is
        # exported with a non-empty log and real counters (never [] / 0).
        self.last_session_log = None
        self.last_counts = None
        self.last_history = None
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
                "maxConsensus": self.max_consensus,
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
        if remaining["maxModelCalls"] < 0 or remaining["maxEffects"] < 0:
            return "CHECKPOINT_BUDGET"
        next_options = dict(options)
        next_options["maxModelCalls"] = options["maxModelCalls"]
        next_options["maxEffects"] = options["maxEffects"]
        return {
            "options": next_options,
            "sessionLog": plan["sessionLog"],
            "contractVersion": host_checkpoint.body_contract_version(checkpoint),
            "history": plan.get("history") or [],
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
            if row.get("phase") not in ("WORK", "CONSENSUS", "R2", "R4", "REPAIR", "R0", "R0_RECHECK"):
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
                history=_history_payload(self.last_history),
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
        script = resolve_script()
        if not script.is_file():
            return self._unsolved(started, "CHILD_FAILED", False)
        problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
        session_id = uuid.uuid4().hex
        if resume is not None:
            original = _resume_session_id(resume)
            if original is not None:
                session_id = original
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
            "maxConsensus": options["maxConsensus"],
            "maxR0": options["maxR0"],
            "policy": options["policy"],
            "deriveBudget": options["deriveBudget"],
            # G7/PR7 Slice 7d: always present; None on the default path.
            "resumeSessionLog": None,
            "resumeContractVersion": None,
            "resumeHistory": None,
        }
        if resume is not None:
            host_options["resumeSessionLog"] = resume["sessionLog"]
            host_options["resumeContractVersion"] = resume["contractVersion"]
            host_options["resumeHistory"] = resume.get("history")
        host = AgentHost(
            manifest, session_id, deadline, problem, problem_hash, host_options,
            self.client, python_sandbox_profile=self.python_sandbox_profile,
            generated_python_gate=self.generated_python_gate,
            observer=self.observer,
        )
        proc = None
        reaped = False
        result = None
        error_code = None
        # Bounded audit trail of *where* the run ended and *how* the child
        # exited. Both values are fixed vocabulary (a step name and an integer),
        # never model text, problem text or a traceback.
        stage = "spawn"
        child_exit = None
        try:
            host.check_deadline()
            common = {"protocolVersion": manifest["protocolVersion"], "sessionId": session_id}
            init = {
                **common,
                "profileId": _PROFILE_ID,
                "capabilities": {
                    "modelGenerate": "AVAILABLE",
                    "toolExecute": "AVAILABLE" if options["maxEffects"] > 0 else "UNAVAILABLE",
                    "methodLoad": (
                        "AVAILABLE"
                        if options["maxMethodLoads"] > 0 and options["maxEffects"] > 0
                        else "UNAVAILABLE"
                    ),
                    # Stage D+: `AVAILABLE_BOUNDED` only while the Host really
                    # holds a usable sandbox; otherwise `UNAVAILABLE`, which
                    # keeps the exploration action refused.
                    "generatedPython": host.generated_python_capability(),
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
                "maxConsensus": options["maxConsensus"],
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
                stage = method
                host.send(
                    proc,
                    {"jsonrpc": "2.0", "id": frame_id, "method": method, "params": params},
                    method,
                )
                host.pump(proc, until)
            stage = "drain"
            host.drain_tail(proc)
            host.check_deadline()
            stage = "wait"
            try:
                child_exit = proc.wait(timeout=max(0.0, min(host.remaining(), _REAP_SECONDS)))
            except subprocess.TimeoutExpired:
                error_code = "TIMEOUT"
            else:
                if child_exit != 0 or host.stderr_seen:
                    error_code = "CHILD_FAILED"
                elif host.solve_result is None:
                    # A clean exit without a solve result is its own defect and
                    # is reported as such instead of as a field failure.
                    error_code = "NO_SOLVE_RESULT"
                else:
                    result = host.solve_result
        except ProtocolError as exc:
            error_code = exc.code
        except ProbeError as exc:
            error_code = exc.code
        except OSError:
            error_code = "CHILD_FAILED"
        except Exception as exc:  # noqa: BLE001 - fixed code only, no traceback
            error_code = _exception_code(exc)
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
            stage, child_exit,
        )

    def _finish(self, started, host, result, error_code, reaped, before_calls,
                before_records, stage=None, child_exit=None):
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
        metrics.update(
            _funnel_metrics(
                host,
                result.get("sessionLog") if isinstance(result, dict) else None,
            )
        )
        if result is None or error_code is not None:
            if host.model_requests > 0:
                metrics["logical_model_calls"] = host.model_requests
            return self._unsolved(
                started, error_code or "FIELD_VALUE", reaped, metrics, finish,
                stage, child_exit, getattr(host, "stderr_code", None),
            )
        summary = result["summary"]
        final_response = summary["finalResponse"]
        if not isinstance(final_response, str) or not final_response:
            return self._unsolved(
                started, "FIELD_VALUE", reaped, metrics, finish,
                stage, child_exit, getattr(host, "stderr_code", None),
            )
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
        self.last_history = copy.deepcopy(host.history)
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

    def _unsolved(self, started, code, reaped, metrics=None, finish=None,
                  stage=None, child_exit=None, child_code=None):
        code = _fixed_unsolved_code(code)
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
                "routed": 0,
                "forced": 0,
                "obeyed": 0,
                "observation_used": 0,
                "closure_evaluations": 0,
                "closure_defects": 0,
                "observation_views": 0,
                "tool_effect_calls": 0,
                "method_effect_calls": 0,
                "exploration_calls": 0,
                "tool_names": [],
                "method_ids": [],
                "front_budget": 0,
                "tail_reserve": 0,
                "front_spent": 0,
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
            # Bounded, fixed-vocabulary audit trail: which Host step was running,
            # how the child exited, and the child's own fixed code when it wrote
            # one. No model text, no problem text, no traceback.
            "stage": _fixed_stage(stage),
            "childExit": child_exit if _is_int(child_exit) else None,
            "childCode": _fixed_child_code(child_code),
            "trace": [],
            "metrics": metrics,
            "finishReason": finish,
            "childReaped": reaped,
            "elapsedMs": max(0, int((time.monotonic() - started) * 1000)),
        }
