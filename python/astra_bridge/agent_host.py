"""Unified AgentLoop Host callback: one class over the shared P0 reader.

Reuses ``p0_probe._Host`` for framing, selector pump and deadline handling and
the existing P3 action/effect guards. No second channel, no second JSON parser,
no network, no mathematical selection: the only model source is the injected
``AgentClient``, and every receipt stays PROVISIONAL/UNKNOWN. This module never
starts a process; the runtime owns spawn/reap.
"""

from __future__ import annotations

import hashlib

import json

import copy
import os
import time
from pathlib import Path

from .agent_client import AgentClient
from .agent_context import (
    _projection_for_source,
    _work_ordinals,
    candidate_packet,
    validate_context,
)
from .agent_history import project_artifacts
from .agent_progress import PROGRESS_POLICY, yielded_task_ids
from .p0_probe import ProbeError, _Host
from .p2_host_fixture import _parse_inner
from .generated_execution_gate import (
    EXECUTION_REFUSALS,
    GATE_REASONS,
    ExecutionRequest,
    GenerativeExecutionGate,
)
from .p3_effect_contract import (
    EFFECT_IDS,
    MAX_OBSERVATION_BYTES,
    failure_receipt,
    receipt as build_receipt,
    validate_request,
)
from .p3_effects import perform_effect
from .p3_host_context import parse_action, same_json
from .p3_host_protocol import payload as p3_payload
from .agent_protocol import AGENT_HOST_VERSION, payload, resolve_node_version
from .p2_methods import fixture_catalog
from .p3_host_methods import checked_catalog
from .scoped_asset_call import AssetCallError, scoped_asset_call
from .generated.math_assets import MATH_ASSET_BY_ID

__all__ = ["AgentHost"]


def _asset_input_contract(asset_id, target):
    """The canonical parameter contract of one math asset, or ``None``.

    This mirrors the Node fallback in ``agent-loop.ts`` byte-for-byte in shape:
    the model must see the real required/optional parameters after a failed
    asset call, not a guessed skeleton. Only catalog data is returned; no
    observation, answer or model text is involved.
    """
    if not isinstance(asset_id, str):
        return None
    definition = MATH_ASSET_BY_ID.get(asset_id)
    if not isinstance(definition, dict):
        return None
    behaviors = definition.get("behaviors")
    if not isinstance(behaviors, list):
        return None
    matching = [
        row for row in behaviors
        if isinstance(row, dict) and (target is None or row.get("target") == target)
    ]
    listed = (matching if matching else behaviors)[:4]
    contract = []
    for row in listed:
        if not isinstance(row, dict):
            continue
        contract.append({
            "target": row.get("target"),
            "requiredParams": list(row.get("requiredParams") or []),
            "optionalParams": list(row.get("optionalParams") or []),
        })
    if not contract:
        return None
    return {"assetId": asset_id, "behaviors": contract}


_MIN_REMAINING_MS = 25
_MAX_REMAINING_MS = 3600000
_MAX_MODEL_CALLS = 256
_MAX_WORK_UNITS = 64
# The public ``maxEffects`` option caps grantable TOOL effects at two. A loaded
# method card is a separate slot, so the total effect-id capacity is
# ``max_effects + max_method_loads`` while methods are enabled.
_MAX_EFFECTS = 2
_MAX_REVIEWS = 3
_MAX_METHOD_LOADS = 4
# Front-stage calls one enabled R0 review costs: 3 role reviews + 1 recheck.
_R0_FRONT_CALLS = 4
_MAX_TOKENS = 8192
# Stage quota vocabulary (HANDOFF §5 item 4). Front stages spend the planning /
# review ceiling; candidate stages only exist after a candidate-bearing turn and
# therefore arm the finalization reserve.
_FRONT_PHASES = ("R0", "R2", "R4")
_CANDIDATE_PHASES = ("R2", "R4", "REPAIR", "CONSENSUS")
_HOST_SOLVE_ID = "host-2"
_HOST_STOP_ID = "host-3"
_PROFILE_ID = "math-agent-preview-v2"
_ENGINE = "ts"
_MODE = "TS_PREVIEW"
_POLICIES = ("BEST_EFFORT", "STRICT")
_STOP_REASONS = (
    "WORK", "CONSENSUS", "R2", "R4", "REPAIR", "R0", "COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN", "ADMITTED",
    "BUDGET_EXHAUSTED", "DEADLINE_EXCEEDED", "ILLEGAL_TRANSITION",
    "NO_CANDIDATE", "NO_REVIEW", "CONTROL_REJECTED", "PACKET_REJECTED",
    "CONTEXT_REJECTED", "REVIEW_STOP", "REVIEWS_COMPLETE",
    "WORK_UNITS_COMPLETE", "REVISED_CANDIDATE", "REVISE_REJECTED",
    "PORT_REJECTED", "STOPPED",
)
_TRACE_KINDS = ("MODEL", "EFFECT", "CONTROL")
_TRACE_STATES = ("DISPATCHED", "RETURNED", "OUTCOME_UNKNOWN", "RECORDED")
_MODEL_TRACE_IDS = tuple("model-" + str(n) for n in range(1, 257))
# The effect trace namespace is the shared boundary contract, never a second
# hard-coded list: when ``EFFECT_IDS`` grows, the trace filter follows.
_EFFECT_TRACE_IDS = tuple(EFFECT_IDS)
# The root AgentSession emits exactly one control trace id, `control`. The
# older P0/P1/P2/P3 traces are not touched here; this filter only accepts the
# real id the unified AgentSession actually records.
_CONTROL_TRACE_IDS = ("control",)
_SUMMARY_FIELDS = (
    "mode", "targetEnvironment", "sessionId", "status", "finalResponse",
    "candidateVerified", "strictAcceptance", "policy", "reason", "modelCalls",
    "effectCalls", "workUnits", "reviewCalls", "repairCalls", "catalogCalls",
    "methodLoads", "stopReason", "unresolvedObligations",
)
_TRACE_FIELDS = ("seq", "kind", "id", "state", "code")

# Stage D: the single environment variable an operator may use to provision an
# already-accepted WASI profile. Absent or empty means "no sandbox", which must
# stay byte-identical to the pre-Stage-D default path (no file I/O at all).
WASI_PROFILE_ENV = "ASTRA_WASI_PROFILE"
# Fixed diagnostic code for an unavailable generated-Python runtime. Nothing
# else (no path, no message, no traceback) is ever carried.
_WASI_UNAVAILABLE = "WASI_SANDBOX_UNAVAILABLE"
# Stage D+: the two values the ``generatedPython`` capability may carry. Only
# ``AVAILABLE_BOUNDED`` -- reported exclusively while a usable sandbox is held --
# enables the one controlled exploration action.
_GENERATED_PYTHON_UNAVAILABLE = "UNAVAILABLE"
_GENERATED_PYTHON_BOUNDED = "AVAILABLE_BOUNDED"
# The single recorded identity of an admitted bounded exploration effect.
_EXPLORATION_TOOL_NAME = "generated_exploration"
# The fixed profile identity and bounds the Host asks the gate for. They never
# come from the model: the gate admits an exploration only when the approved
# deployment profile names this id and covers these caps.
EXPLORE_PROFILE_ID = "astra-wasi-bounded-v1"
_EXPLORE_MAX_SECONDS = 5
_EXPLORE_MAX_BYTES = 65536
# Fixed refusal for an exploration action while no bounded sandbox is offered.
_EXPLORE_ACTION_NOT_ALLOWED = "ACTION_NOT_ALLOWED"


def _resolve_python_sandbox_profile(python_sandbox_profile):
    """The explicit profile, else a non-empty ``ASTRA_WASI_PROFILE``.

    ``None`` means "no sandbox and no file I/O". An explicitly supplied profile
    always wins over the environment, so a configured deployment is never
    silently overridden by an ambient variable.
    """
    if python_sandbox_profile is not None:
        return python_sandbox_profile
    try:
        value = os.environ.get(WASI_PROFILE_ENV)
    except Exception:  # noqa: BLE001 - an unreadable environment is "no profile"
        return None
    if isinstance(value, str) and value.strip():
        return value
    return None


def _build_python_sandbox(python_sandbox_profile=None):
    """Return ``(sandbox, identity, diagnostic)`` for an optional WASI profile.

    With no profile this returns ``(None, None, None)`` and reads nothing at
    all, so every existing Host/Runtime path is unchanged. With a profile it
    builds ``mathagent.tools.PythonSandbox`` once and binds its identity; an
    unusable runtime degrades to ``None`` plus one fixed diagnostic code instead
    of raising, so a caller has exactly two states: a usable sandbox or None.
    """
    profile = _resolve_python_sandbox_profile(python_sandbox_profile)
    if profile is None:
        return None, None, None
    try:
        from mathagent.tools import PythonSandbox

        sandbox = PythonSandbox(profile=profile)
    except Exception:  # noqa: BLE001 - an unavailable WASI runtime is not a crash
        return None, None, _WASI_UNAVAILABLE
    if not getattr(sandbox, "available", False):
        return None, None, _WASI_UNAVAILABLE
    return sandbox, getattr(sandbox, "identity", None), None


def _p4_hash(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def _fail(code="FIELD_VALUE"):
    # Diagnostic origin only; never part of a returned object or protocol frame.
    import inspect

    frame = inspect.currentframe()
    caller = frame.f_back if frame is not None else None
    origin = None
    if caller is not None:
        origin = "%s:%d" % (
            os.path.basename(caller.f_code.co_filename),
            caller.f_lineno,
        )
    raise ProbeError(code, origin)


_REPO_ROOT = Path(__file__).resolve().parents[2]


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _exact_keys(value, keys):
    if not isinstance(value, dict):
        _fail()
    if set(value.keys()) != set(keys) or len(value) != len(keys):
        _fail()


def _bounded_int(value, low, high):
    if not _is_int(value) or not low <= value <= high:
        _fail()
    return value


def _checked_resume_log(value):
    """Authenticated SessionLog prefix: fixed kind + bounded data only."""
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 512:
        _fail()
    out = []
    for index, row in enumerate(value):
        if not isinstance(row, dict):
            _fail()
        if set(row.keys()) != {"seq", "kind", "data"} or len(row) != 3:
            _fail()
        if not _is_int(row["seq"]) or row["seq"] != index + 1:
            _fail()
        kind = row["kind"]
        if not isinstance(kind, str) or not kind or len(kind) > 64:
            _fail()
        if not isinstance(row["data"], dict):
            _fail()
        out.append({"seq": row["seq"], "kind": kind, "data": copy.deepcopy(row["data"])})
    return out


def _checked_resume_version(value):
    """Declared contract version of a resume checkpoint (1 or 2)."""
    if value is None:
        return None
    if not _is_int(value) or value not in (1, 2):
        _fail()
    return value


def _trace_id(kind, value):
    """Fixed trace id per kind; a model raw string is never echoed."""
    if kind == "MODEL":
        if value in _MODEL_TRACE_IDS:
            return value
        _fail()
    if kind == "EFFECT":
        if value in _EFFECT_TRACE_IDS:
            return value
        _fail()
    if kind == "CONTROL":
        if value in _CONTROL_TRACE_IDS:
            return value
        _fail()
    _fail()


def _js_canonical(val):
    if isinstance(val, dict):
        def _is_index(k):
            if isinstance(k, int) and not isinstance(k, bool):
                return 0 <= k < 4294967295
            if isinstance(k, str) and k.isdigit():
                if len(k) > 1 and k.startswith("0"):
                    return False
                n = int(k)
                return 0 <= n < 4294967295 and str(n) == k
            return False

        index_keys = []
        string_keys = []
        for k in val.keys():
            if _is_index(k):
                index_keys.append(k)
            else:
                string_keys.append(k)
        index_keys.sort(key=lambda x: int(x))
        canonical = {}
        for k in index_keys:
            canonical[str(k)] = _js_canonical(val[k])
        for k in string_keys:
            canonical[str(k)] = _js_canonical(val[k])
        return canonical
    elif isinstance(val, list):
        return [_js_canonical(item) for item in val]
    return val


class AgentHost(_Host):
    """Host-side unified AgentLoop callback state machine."""

    def __init__(self, manifest, session_id, deadline, problem, problem_hash,
                 options, client, *, python_sandbox_profile=None,
                 generated_python_gate=None, observer=None,
                 node_version=None, model_endpoint=None):
        if manifest.get("protocolVersion") != AGENT_HOST_VERSION:
            _fail()
        super().__init__(manifest, session_id, None, deadline)
        if not isinstance(problem, str) or not problem.strip():
            _fail()
        if not isinstance(problem_hash, str) or len(problem_hash) != 64:
            _fail()
        if not isinstance(client, AgentClient):
            _fail()
        if not isinstance(options, dict):
            _fail()
        _exact_keys(
            options,
            (
                "maxModelCalls", "maxWorkUnits", "maxEffects", "maxReviews",
                "maxMethodLoads", "maxRepairs", "maxConsensus", "maxR0",
                "policy", "deriveBudget",
                "resumeSessionLog", "resumeContractVersion", "resumeHistory",
            ),
        )
        if not isinstance(options["deriveBudget"], bool):
            _fail()
        self.derive_budget = options["deriveBudget"]
        # G7/PR7 Slice 7d: an optional authenticated resume prefix. Absent keys
        # stay None, so the default path is byte-identical.
        self.resume_session_log = _checked_resume_log(options.get("resumeSessionLog"))
        self.resume_contract_version = _checked_resume_version(
            options.get("resumeContractVersion")
        )
        self.max_model_calls = _bounded_int(options["maxModelCalls"], 0, _MAX_MODEL_CALLS)
        # HANDOFF §5 item 4 (阶段配额): the flat cap is split deterministically
        # into a front-stage ceiling and a finalization reserve. ``front_budget``
        # bounds every R0 planning call plus every review call (R2/R4) to a
        # quarter of the soft budget; ``tail_reserve`` is how many calls a
        # candidate-bearing turn must leave untouched for the finalization
        # stages (R2/R4/REPAIR), so a fresh WORK/CONSENSUS may never eat it.
        # Integer ceiling only: no float ever enters a comparison.
        self.front_budget = max(1, -(-self.max_model_calls * 25 // 100))
        self.tail_reserve = max(1, -(-self.max_model_calls * 10 // 100))
        self.max_work_units = _bounded_int(options["maxWorkUnits"], 1, _MAX_WORK_UNITS)
        self.max_effects = _bounded_int(options["maxEffects"], 0, _MAX_EFFECTS)
        self.max_reviews = _bounded_int(options["maxReviews"], 0, _MAX_REVIEWS)
        self.max_method_loads = _bounded_int(options["maxMethodLoads"], 0, _MAX_METHOD_LOADS)
        self.max_repairs = _bounded_int(options["maxRepairs"], 0, 3)
        self.max_consensus = _bounded_int(options["maxConsensus"], 0, 8)
        self.max_r0 = _bounded_int(options["maxR0"], 0, 1)
        # The R0 stage is a fixed, bounded planning shape: three independent
        # role reviews plus at most one recheck and one revision. When the
        # profile explicitly enables it, the front allowance must be able to
        # host that shape, otherwise the third review would be refused by a
        # quota that was calibrated for a stage that no longer exists. The
        # 25 % rule still applies to every other front call (R2/R4).
        if self.max_r0 >= 1 and self.front_budget < _R0_FRONT_CALLS:
            self.front_budget = _R0_FRONT_CALLS
        if options["policy"] not in _POLICIES:
            _fail()
        self.policy = options["policy"]
        self.problem = problem
        self.problem_hash = problem_hash
        self.client = client
        # Optional read-only progress observer. It receives only bounded
        # control facts (phase/status/ids), never model text or observations.
        self.observer = observer if callable(observer) else None
        self.node_version = node_version or resolve_node_version()
        self.model_endpoint = model_endpoint or "openai-compatible"
        self._emit("SESSION_INIT", {
            "sessionId": self.session_id,
            "problemHash": self.problem_hash,
            "nodeVersion": self.node_version,
            "modelEndpoint": self.model_endpoint,
            "budgets": {
                "maxModelCalls": self.max_model_calls,
                "maxWorkUnits": self.max_work_units,
                "maxEffects": self.max_effects,
                "maxReviews": self.max_reviews,
                "maxMethodLoads": self.max_method_loads,
                "maxRepairs": self.max_repairs,
                "maxConsensus": self.max_consensus,
                "maxR0": self.max_r0,
            },
        })
        # Stage D: an optional, already-accepted WASI profile. ``None`` means no
        # sandbox and no file I/O, so the default Host path is byte-identical.
        self.python_sandbox_profile = _resolve_python_sandbox_profile(
            python_sandbox_profile
        )
        (
            self.python_sandbox,
            self.python_sandbox_identity,
            self.python_sandbox_diagnostic,
        ) = _build_python_sandbox(self.python_sandbox_profile)
        # Stage D+: the fail-closed generative-execution gate. The default
        # instance carries no approved profile, so it can only refuse; a trusted
        # caller may inject an approving one. It never executes anything itself.
        self.generated_python_gate = (
            generated_python_gate
            if generated_python_gate is not None
            else GenerativeExecutionGate()
        )
        # Bounded, deduplicated telemetry: admitted explorations only.
        self.exploration_calls = 0
        self.stop_acked = False
        self.history = {}
        self.effects = []
        resume_history = options.get("resumeHistory")
        if resume_history is not None:
            if not isinstance(resume_history, list) or len(resume_history) > 256:
                _fail()
            prefix_ids = set()
            for row in (self.resume_session_log or ()):
                if isinstance(row, dict) and row.get("kind") == "MODEL_REQUEST":
                    data = row.get("data")
                    if isinstance(data, dict) and isinstance(data.get("requestId"), str):
                        prefix_ids.add(data["requestId"])
            for rec in resume_history:
                if not isinstance(rec, dict) or set(rec.keys()) != {"requestId", "request", "receipt"}:
                    _fail()
                rid = rec["requestId"]; req = rec["request"]; receipt = rec["receipt"]
                if not isinstance(rid, str) or not isinstance(req, dict) or not isinstance(receipt, dict):
                    _fail()
                if rid not in prefix_ids:
                    continue
                messages = req.get("messages")
                if not isinstance(messages, list) or _p4_hash(messages) != req.get("contextHash"):
                    _fail()
                if req.get("sessionId") != session_id or req.get("problemHash") != problem_hash:
                    _fail()
                if receipt.get("transportStatus") != "COMPLETE" or not isinstance(receipt.get("text"), str):
                    _fail()
                self.history[rid] = {"request": copy.deepcopy(req), "receipt": copy.deepcopy(receipt)}
        self.model_requests = 0
        # Requests the client proved it never sent (budget precheck refused): the
        # logical call is still accounted for, but no remote outcome is unknown.
        self.not_dispatched_requests = 0
        self.effect_calls = 0
        # Effects are budgeted per kind: ``tool_effect_count`` is spent only by
        # tool actions, ``method_loads`` only by method-card loads, and
        # ``effect_calls`` is the total id capacity actually used.
        self.tool_effect_count = 0
        # Bounded, deduplicated identity of what was really spent. Names and
        # card ids only: no raw args, no observation, no model text.
        self.tool_names = []
        self.method_ids = []
        self.resume_model_offset = 0
        self.resume_effect_offset = 0
        if self.resume_session_log:
            self.resume_model_offset = sum(1 for r in self.resume_session_log if isinstance(r, dict) and r.get("kind") == "MODEL_REQUEST" and not any(isinstance(x,dict) and x.get("kind")=="FINAL" for x in self.resume_session_log))
            self.model_requests = self.resume_model_offset
            self.resume_effect_offset = sum(1 for r in self.resume_session_log if isinstance(r, dict) and r.get("kind") in ("TOOL_OBSERVATION", "METHOD_LOAD"))
            self.effect_calls = self.resume_effect_offset
            self.tool_effect_count = sum(
                1 for r in self.resume_session_log
                if isinstance(r, dict) and r.get("kind") == "TOOL_OBSERVATION"
            )
        self.review_calls = 0
        self.repair_calls = 0
        self.consensus_calls = 0
        # Stage-quota spend, both derived from admitted requests only:
        # ``front_spent`` counts R0/R2/R4 admissions, and
        # ``candidate_stage_seen`` flips once a post-candidate phase
        # (R2/R4/REPAIR/CONSENSUS) is admitted -- never from model text.
        self.front_spent = 0
        self.candidate_stage_seen = False
        self.catalog_calls = 0
        self.method_loads = 0
        if self.resume_session_log:
            self.method_loads = sum(
                1 for r in self.resume_session_log
                if isinstance(r, dict) and r.get("kind") == "METHOD_LOAD"
            )
            # A resumed prefix keeps its own stage spend: the LOG's phase column
            # is control data, so the same quotas become neither wider nor
            # narrower by resuming.
            if self.resume_model_offset:
                for row in self.resume_session_log:
                    if not isinstance(row, dict) or row.get("kind") != "MODEL_REQUEST":
                        continue
                    data = row.get("data")
                    phase = data.get("phase") if isinstance(data, dict) else None
                    if phase in _FRONT_PHASES:
                        self.front_spent += 1
                    if phase in _CANDIDATE_PHASES:
                        self.candidate_stage_seen = True
        self.asset_calls = 0
        self.catalog = None
        self.method_assets = []
        self.method_catalog = None
        self.initial_client_calls = client.calls
        self.initial_client_records = len(client.snapshot())
        self.stopped = False
        self.last_model_id = None
        self.solve_result = None
        self.route_admissions = {}
        self.dependency_admissions = {}
        self.redo_record = None

    # -- helpers ----------------------------------------------------------

    def remaining_ms(self):
        left = int(self.remaining() * 1000)
        if left < 0:
            return 0
        if left > _MAX_REMAINING_MS:
            return _MAX_REMAINING_MS
        return left

    def generated_python_capability(self):
        """The advertised ``capabilities.generatedPython`` value of this Host.

        ``AVAILABLE_BOUNDED`` only while a usable sandbox is actually held;
        every other state reports ``UNAVAILABLE`` so the Node side never offers
        the exploration action it cannot serve.
        """
        sandbox = self.python_sandbox
        if sandbox is not None and getattr(sandbox, "available", False):
            return _GENERATED_PYTHON_BOUNDED
        return _GENERATED_PYTHON_UNAVAILABLE

    def _exploration_request(self, code):
        """The Host's own bounded execution request for one source string.

        The bounds are Host constants, never model input: the gate admits the
        request only when the approved profile covers them.
        """
        digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
        return ExecutionRequest(
            EXPLORE_PROFILE_ID, digest, _EXPLORE_MAX_SECONDS, _EXPLORE_MAX_BYTES
        )

    def generated_exploration(self, request, code, *, gate, scope=None):
        """The one execution seam for bounded generated Python.

        Stage D+ reaches it only through ``_on_explore_effect`` -- i.e. only for
        an admitted ``explore`` action, only while this Host advertises
        ``AVAILABLE_BOUNDED`` (a usable sandbox), only when the injected
        ``GenerativeExecutionGate`` admits the request and only when one
        tool-kind effect id is still free. A trusted caller may also call it
        directly with its own gate.

        The decision is taken by the gate before anything executes; without a
        sandbox (the default path) the result is the fixed ``REFUSED_NO_PROFILE``
        refusal and no code runs. A successful run is a
        ``BOUNDED_OBSERVATION`` tagged ``BOUNDED_OBSERVATION_NOT_PROOF``: it is
        never a proof, never a certificate and never an obligation discharge.
        """
        from .generated_execution_gate import DEFAULT_SCOPE, execute_with_gate

        return execute_with_gate(
            gate,
            self.python_sandbox,
            request,
            code,
            deadline=self.deadline,
            problem_id=self.session_id,
            scope=DEFAULT_SCOPE if scope is None else scope,
        )

    def _common(self):
        return {"protocolVersion": AGENT_HOST_VERSION, "sessionId": self.session_id}

    def _is_resuming(self):
        """True when this run was handed an authenticated SessionLog prefix."""
        return bool(self.resume_session_log)

    def _resumed_candidate(self):
        """The candidate rebuilt from the resumed log's delivered events, or None."""
        proposal = None
        for row in self.resume_session_log or ():
            if not isinstance(row, dict):
                continue
            kind = row.get("kind")
            data = row.get("data")
            if not isinstance(data, dict):
                continue
            candidate = data.get("candidateProposal")
            if not isinstance(candidate, str) or not candidate:
                continue
            if kind == "WORKUNIT" and data.get("deliveryStatus") == "COMPLETE":
                proposal = candidate
            elif kind == "REPAIR" and data.get("accepted") is True:
                proposal = candidate
        return proposal

    def _emit(self, kind, payload):
        if self.observer is None:
            return
        try:
            self.observer({"kind": kind, "payload": dict(payload)})
        except Exception:
            # A telemetry sink can never change the mathematical run.
            pass

    def _last_model(self):
        if self.last_model_id is None:
            return None
        return self.history.get(self.last_model_id)

    def _binding(self, request_id):
        record = self.history.get(request_id)
        if record is None:
            _fail()
        request = record["request"]
        return {
            "sessionId": self.session_id,
            "problemHash": self.problem_hash,
            "contractVersion": 1,
            "taskId": request["taskId"],
            "scopeId": request["scopeId"],
            "sourceRequestId": request_id,
        }

    def _effect_budget(self):
        """Total effect-id capacity: the tool quota plus the method slot.

        ``max_effects`` stays the public TOOL quota (0..2) and remains what the
        Node body advertises for tool actions. Loaded method cards have their
        own bounded quota, so ``max_method_loads`` cards plus ``max_effects``
        tools must fit; otherwise a card eats a tool call. The total is
        additionally bounded by the shared ``EFFECT_IDS`` namespace, so the
        Host never promises an id the boundary contract cannot bind.
        """
        method_slot = self.max_method_loads if self._methods_enabled() else 0
        return min(self.max_effects + method_slot, len(EFFECT_IDS))

    def _effect_admission(self, kind):
        """Fixed effect-budget order: total capacity first, then the kind quota."""
        if self.effect_calls >= self._effect_budget():
            return False
        if kind == "method":
            return self.method_loads < self.max_method_loads
        return self.tool_effect_count < self.max_effects

    def _advertised_actions(self, reserve_ok, cached_tool, cached_method):
        """The two action grants the Node body must advertise for this WORK turn.

        Tool and method quotas are split. They share only the total effect-id
        capacity and the common deadline/review reserve.
        """
        catalog_ready = self.catalog is not None and bool(self.catalog["entries"])
        return (
            reserve_ok and (self._effect_admission("tool") or cached_tool),
            reserve_ok
            and catalog_ready
            and (self._effect_admission("method") or cached_method),
        )

    # -- inbound ----------------------------------------------------------

    def on_request(self, message):
        method = message["method"]
        if method not in ("model.generate", "tool.execute", "method.catalog", "method.load", "asset.scoped", "math_asset.execute"):
            _fail()
        if self.expected is None or self.expected != (_HOST_SOLVE_ID, "session.solve"):
            _fail()
        if self.pending is not None or self.stopped:
            if os.environ.get("ASTRA_DEBUG_GUARD") == "1":
                import sys as _debug_sys
                request = (message.get("params") or {}).get("request") or {}
                _debug_sys.stderr.write(
                    "ASTRA_HOST_STOP method=%r phase=%r pending=%r stopped=%r\n"
                    % (method, request.get("phase"), self.pending is not None, self.stopped)
                )
                _debug_sys.stderr.flush()
            _fail()
        if self.model_requests > self.resume_model_offset and not self.callback_done:
            _fail()
        params = message["params"]
        payload(self.manifest, method, "params", params, self.session_id)
        if method == "model.generate":
            self.on_model(message["id"], params)
            return
        if method == "method.catalog":
            self.on_catalog(message["id"], params)
            return
        if method == "method.load":
            self.on_effect(message["id"], params, "method.load")
            return
        if method == "asset.scoped":
            self.on_asset(message["id"], params)
            return
        if method == "math_asset.execute":
            self.on_math_asset(message["id"], params)
            return
        self.on_tool(message["id"], params)

    def _methods_enabled(self):
        return (
            self.max_method_loads > 0
            and self.max_effects > 0
            and self.max_model_calls >= 2 + self.max_reviews
        )

    def on_catalog(self, frame_id, params):
        if not self._methods_enabled():
            _fail()
        if self.catalog_calls != 0 or self.model_requests != 0:
            _fail()
        if frame_id != "node-catalog-1":
            _fail()
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail("DEADLINE_EXCEEDED")
        remaining = params["remainingMs"]
        if not _is_int(remaining) or remaining < _MIN_REMAINING_MS + 1 or remaining > _MAX_REMAINING_MS:
            _fail()
        now = time.monotonic()
        if min(self.deadline, now + remaining / 1000.0) <= now:
            _fail()
        self.deadline = min(self.deadline, now + remaining / 1000.0)
        self.catalog_calls = 1
        try:
            from mathagent.lite.methods import MethodCatalog

            self.method_catalog = MethodCatalog()
            catalog = checked_catalog(fixture_catalog(self.method_catalog))
        except Exception:  # noqa: BLE001 - an unavailable catalog is not a failure
            self.method_catalog = None
            catalog = {"version": "1.1.0", "entries": []}
        self.catalog = copy.deepcopy(catalog)
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            self.stopped = True
        self.callback_done = False
        self.send(
            self.proc,
            {
                "jsonrpc": "2.0",
                "id": frame_id,
                "result": {
                    **self._common(),
                    "remainingMs": self.remaining_ms(),
                    "catalog": copy.deepcopy(catalog),
                },
            },
            "method.catalog",
        )
        self.pending_is_callback = True

    def on_asset(self, frame_id, params):
        """G7/PR7 Slice 7e: scoped math-asset descriptor within a trusted scope."""
        _exact_keys(
            params,
            ("protocolVersion", "sessionId", "assetGroup", "assetId", "scopeId", "contractVersion"),
        )
        if params["sessionId"] != self.session_id:
            _fail()
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail("DEADLINE_EXCEEDED")
        try:
            descriptor = scoped_asset_call(
                params["assetGroup"],
                params["assetId"],
                scope_id=params["scopeId"],
                contract_version=params["contractVersion"],
                root=_REPO_ROOT,
            )
        except AssetCallError as exc:
            _fail(exc.code)
        self.asset_calls += 1
        self.send(
            self.proc,
            {
                "jsonrpc": "2.0",
                "id": frame_id,
                "result": {**self._common(), "descriptor": descriptor},
            },
            "asset.scoped",
        )

    def on_math_asset(self, frame_id, params):
        if params["sessionId"] != self.session_id:
            _fail()
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail("DEADLINE_EXCEEDED")
        # The public ``max_effects`` is the TOOL quota, not the total effect-id
        # capacity. Method cards have their own slot, so a math asset must be
        # admitted against the shared capacity plus the tool-kind quota;
        # comparing ``effect_calls`` to ``max_effects`` would refuse the second
        # asset after one method card even though the tool quota is still free.
        if not self._effect_admission("tool"):
            _fail("BUDGET")
        request = params["request"]
        binding = request.get("binding", {})
        source_id = str(binding.get("sourceRequestId", self.last_model_id or frame_id))
        for entry in self.effects:
            if (
                isinstance(entry, dict)
                and isinstance(entry.get("request"), dict)
                and isinstance(entry["request"].get("binding"), dict)
                and entry["request"]["binding"].get("sourceRequestId") == source_id
            ):
                _fail()
        context = {
            "sessionId": self.session_id,
            "problemHash": self.problem_hash,
            "contractVersion": int(binding.get("contractVersion", 1)),
            "taskId": str(binding.get("taskId", "")),
            "goalId": str(binding.get("goalId", "")),
            "scopeId": str(binding.get("scopeId", "")),
            "sourceRequestId": source_id,
        }
        deadline = time.monotonic() + (self.remaining_ms() / 1000.0)
        from .math_assets_runtime import use_math_asset
        result = use_math_asset(
            request,
            context=context,
            deadline=deadline,
        )
        effect_id = EFFECT_IDS[self.effect_calls]
        self.effect_calls += 1
        self.math_asset_calls = getattr(self, "math_asset_calls", 0) + 1
        self.tool_effect_count += 1
        asset_identity = request.get("target") or request.get("assetId")
        if (
            asset_identity
            and asset_identity not in self.tool_names
            and len(self.tool_names) < self.max_effects
        ):
            self.tool_names.append(asset_identity)

        effect_entries = []
        for obs in result.get("observations", []):
            obs_dict = {
                "result": _js_canonical(obs.get("value")),
                "operation": obs.get("quantity"),
                "target": obs.get("quantity"),
            }
            obs_str = json.dumps(obs_dict, separators=(",", ":"), ensure_ascii=False)
            obs_hash = hashlib.sha256(obs_str.encode("utf-8")).hexdigest()
            receipt = {
                "effectId": effect_id,
                "binding": {
                    "sessionId": self.session_id,
                    "problemHash": self.problem_hash,
                    "contractVersion": int(binding.get("contractVersion", 1)),
                    "taskId": str(binding.get("taskId", "")),
                    "scopeId": str(binding.get("scopeId", "")),
                    "sourceRequestId": source_id,
                },
                "source": "PROGRAM_OBSERVATION",
                "level": "PROVISIONAL",
                "status": "COMPLETE" if result.get("status") in ("COMPLETE", "SUCCESS") else "ERROR",
                "observation": obs_str,
                "observationHash": obs_hash,
                "checkResult": "UNKNOWN",
            }
            action_payload = {
                "action": "math_asset",
                "assetId": request.get("assetId"),
                "input": copy.deepcopy(request.get("input", {})),
            }
            if "target" in request:
                action_payload["target"] = request["target"]
            effect_entry = {
                "request": {
                    "effectId": effect_id,
                    "binding": copy.deepcopy(receipt["binding"]),
                    "action": action_payload,
                    "remainingMs": self.remaining_ms(),
                },
                "receipt": copy.deepcopy(receipt),
            }
            self.effects.append(effect_entry)
            effect_entries.append(effect_entry)

        if not effect_entries and str(result.get("status")) not in ("COMPLETE", "SUCCESS"):
            # A math asset that did not complete (NEEDS_INPUT / OUT_OF_SCOPE /
            # UNAVAILABLE / ERROR) carries no observation, so the model would
            # never learn that its call failed. Record one *failure* receipt with
            # the real status / limitations / guidance and the real catalog input
            # contract: it is a PROVISIONAL ERROR receipt, never a result, and the
            # Node loop keeps it out of every observation view.
            failure_target = request.get("target") or request.get("input", {}).get("target")
            failure_observation = json.dumps(
                {
                    "effectFailure": {
                        "assetId": request.get("assetId"),
                        "target": failure_target,
                        "status": str(result.get("status") or "UNKNOWN"),
                        "limitations": list(result.get("limitations") or [])[:6],
                        "guidance": list(result.get("guidance") or [])[:6],
                        "inputContract": _asset_input_contract(
                            request.get("assetId"), failure_target
                        ),
                        "receivedInputKeys": sorted(
                            str(key) for key in (request.get("input") or {})
                        ),
                    }
                },
                separators=(",", ":"),
                ensure_ascii=False,
            )
            failure_receipt = {
                "effectId": effect_id,
                "binding": {
                    "sessionId": self.session_id,
                    "problemHash": self.problem_hash,
                    "contractVersion": int(binding.get("contractVersion", 1)),
                    "taskId": str(binding.get("taskId", "")),
                    "scopeId": str(binding.get("scopeId", "")),
                    "sourceRequestId": source_id,
                },
                "source": "PROGRAM_OBSERVATION",
                "level": "PROVISIONAL",
                "status": "ERROR",
                "observation": failure_observation,
                "observationHash": hashlib.sha256(
                    failure_observation.encode("utf-8")
                ).hexdigest(),
                "checkResult": "UNKNOWN",
            }
            action_payload = {
                "action": "math_asset",
                "assetId": request.get("assetId"),
                "input": copy.deepcopy(request.get("input", {})),
            }
            if "target" in request:
                action_payload["target"] = request["target"]
            failure_entry = {
                "request": {
                    "effectId": effect_id,
                    "binding": copy.deepcopy(failure_receipt["binding"]),
                    "action": action_payload,
                    "remainingMs": self.remaining_ms(),
                },
                "receipt": copy.deepcopy(failure_receipt),
            }
            self.effects.append(failure_entry)
            effect_entries.append(failure_entry)

        receipts_list = [entry["receipt"] for entry in effect_entries]
        self._emit("effect_returned", {
            "effectId": effect_id,
            "action": "math_asset",
            "name": asset_identity,
            "status": result.get("status"),
            "source": "PROGRAM_OBSERVATION",
            "checkResult": "UNKNOWN",
        })
        self._emit("TOOL_OBSERVATION", {
            "id": effect_id,
            "tool": asset_identity,
            "args": params.get("input"),
            "observation": result.get("observations") if isinstance(result, dict) else str(result),
            "output": result.get("observations") if isinstance(result, dict) else str(result),
            "status": "error" if (isinstance(result, dict) and result.get("status") == "ERROR") else "done",
        })
        self.send(
            self.proc,
            {
                "jsonrpc": "2.0",
                "id": frame_id,
                "result": {
                    **self._common(),
                    "remainingMs": self.remaining_ms(),
                    "result": result,
                    "receipts": receipts_list,
                },
            },
            "math_asset.execute",
        )

    def on_model(self, frame_id, params):
        ordinal = self.model_requests + 1
        if ordinal > self.max_model_calls:
            _fail("BUDGET")
        if self.model_requests == 0 and self._methods_enabled():
            if self.catalog_calls != 1 or not self.callback_done:
                _fail()
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail("DEADLINE_EXCEEDED")
        request = params["request"]
        request_id = request["requestId"]
        if request_id != "model-" + str(ordinal):
            _fail()
        if frame_id != "node-" + request_id:
            _fail()
        if request["sessionId"] != self.session_id:
            _fail()
        if request["problemHash"] != self.problem_hash:
            _fail()
        if request["maxTokens"] != _MAX_TOKENS:
            _fail()
        # Stage quotas, in the fixed order: the total cap (already checked as
        # ``ordinal``), then the front-stage ceiling for R0/review calls, then
        # the finalization reserve that only bars fresh WORK/CONSENSUS turns
        # once a candidate-bearing turn has really happened. Both refusals use
        # the existing BUDGET vocabulary.
        if request["phase"] in _FRONT_PHASES:
            if self.front_spent >= self.front_budget:
                _fail("BUDGET")
        elif request["phase"] in ("WORK", "CONSENSUS"):
            if (
                self.candidate_stage_seen
                and self.max_model_calls - self.model_requests <= self.tail_reserve
            ):
                _fail("BUDGET")
        if request["phase"] in ("R2", "R4"):
            # Bounded review rounds share one authorized review budget. R4 is
            # only a re-review after at least one evidence-triggered repair.
            if self.review_calls >= self.max_reviews:
                _fail("BUDGET")
            if request["phase"] == "R4" and self.repair_calls < 1:
                _fail()
        elif request["phase"] == "REPAIR":
            # A bounded sequence of evidence-triggered revisions: at most one
            # per review round, never more than the authorized repair budget.
            if self.max_repairs < 1:
                _fail("BUDGET")
            if self.review_calls < 1:
                _fail()
            if self.repair_calls >= self.max_repairs:
                _fail("BUDGET")
            # At most one revision per review round: a REPAIR must be preceded
            # by a review that has not already produced a repair.
            if self.repair_calls >= self.review_calls:
                _fail()
            if self.max_model_calls - self.model_requests < 1:
                _fail("BUDGET")
        elif request["phase"] == "CONSENSUS":
            # A bounded blind re-solve / adjudication before candidate delivery.
            # It never follows a review and never produces a Host artifact by
            # itself; only the selected packet is later accepted by Node.
            if self.max_consensus < 1 or self.consensus_calls >= self.max_consensus:
                _fail("BUDGET")
            if self.review_calls > 0:
                _fail()
            if not any(
                isinstance(record, dict)
                and isinstance(record.get("request"), dict)
                and record["request"].get("phase") == "WORK"
                for record in self.history.values()
            ):
                _fail()
        else:
            if self.review_calls > 0:
                _fail()
        if request_id in self.history:
            _fail()
        # A task that already yielded this session is never scheduled again:
        # the check runs before the context validation and before any client
        # call, so a re-dispatch of a yielded task costs no new model call.
        if request["phase"] == "WORK":
            if request["taskId"] in yielded_task_ids(self.history, self.effects):
                _fail()
        body = validate_context(
            request, self.problem, self.session_id, self.problem_hash,
            self.history, self.effects, self.catalog, self.method_assets,
        )
        if request["phase"] == "WORK":
            # The fixed policy is control data: the Host re-checks the exact
            # four-field identity itself and never trusts a body-supplied
            # threshold.
            policy = body.get("progressPolicy")
            if not isinstance(policy, dict) or not same_json(policy, PROGRESS_POLICY):
                _fail()
            reserve_ok = self.max_model_calls - self.model_requests >= 2 + self.max_reviews
            task_id = request["taskId"]
            control_provenance = body.get("controlRouteProvenance")
            provenance = (
                control_provenance
                if control_provenance is not None
                else body["routeProvenance"]
            )
            pending_new_provenance = None
            dep_provenance = body["dependencyProvenance"]
            pending_new_dependency = None
            # A redo request (already recorded, or proposed by this very body)
            # suppresses the route/continuation proposal flags: the remaining
            # budget must stay reserved for the redo WORK and its R2 review.
            prospective_redo_used = (
                self.redo_record is not None or body["revisionProvenance"] is not None
            )
            if provenance is not None and dep_provenance is not None:
                _fail()
            if dep_provenance is not None:
                if not isinstance(dep_provenance, dict):
                    _fail()
                recorded_dep = self.dependency_admissions.get(task_id)
                if recorded_dep is None:
                    if len(self.dependency_admissions) >= 2:
                        _fail()
                    if task_id != "dep-task-" + dep_provenance["sourceRequestId"]:
                        _fail()
                    if self.max_model_calls - self.model_requests < 1 + self.max_reviews:
                        _fail()
                    completed = len(project_artifacts(
                        self.history, self.session_id, self.problem_hash,
                    )["rows"])
                    if self.max_work_units - completed < 1:
                        _fail()
                    if self.remaining_ms() <= _MIN_REMAINING_MS:
                        _fail()
                    pending_new_dependency = copy.deepcopy(dep_provenance)
                elif not same_json(recorded_dep, dep_provenance):
                    _fail()
            if provenance is not None:
                if not isinstance(provenance, dict):
                    _fail()
                recorded = self.route_admissions.get(task_id)
                if recorded is None:
                    if self.route_admissions:
                        _fail()
                    if task_id != "route-task-" + provenance["sourceRequestId"]:
                        _fail()
                    if self.max_model_calls - self.model_requests < 1 + self.max_reviews:
                        _fail()
                    completed = len(project_artifacts(
                        self.history, self.session_id, self.problem_hash,
                    )["rows"])
                    if self.max_work_units - completed < 1:
                        _fail()
                    if self.remaining_ms() <= _MIN_REMAINING_MS:
                        _fail()
                    pending_new_provenance = copy.deepcopy(provenance)
                elif not same_json(recorded, provenance):
                    _fail()
            cached_tool = any(
                isinstance(entry, dict)
                and isinstance(entry.get("request"), dict)
                and isinstance(entry["request"].get("binding"), dict)
                and entry["request"]["binding"].get("taskId") == task_id
                and (
                    entry["request"].get("action", {}).get("action") in ("tool", "math_asset")
                    or entry.get("receipt", {}).get("source") == "PROGRAM_OBSERVATION"
                )
                for entry in self.effects
            )
            cached_method = any(
                isinstance(entry, dict)
                and isinstance(entry.get("request"), dict)
                and isinstance(entry["request"].get("binding"), dict)
                and entry["request"]["binding"].get("taskId") == task_id
                and entry["request"].get("action", {}).get("action") == "method"
                for entry in self.effects
            )
            allow_tools, allow_methods = self._advertised_actions(
                reserve_ok, cached_tool, cached_method,
            )
            if not self.derive_budget:
                if body["allowTools"] != allow_tools:
                    _fail()
                if body["allowMethods"] != allow_methods:
                    _fail()
            expected_allow_route = (
                not self.route_admissions
                and pending_new_provenance is None
                and not prospective_redo_used
                and self.max_model_calls - self.model_requests >= 2 + self.max_reviews
                and self.max_work_units - len(project_artifacts(
                    self.history, self.session_id, self.problem_hash,
                )["rows"]) >= 2
                and self.remaining_ms() > _MIN_REMAINING_MS
            )
            if not self.derive_budget and body["allowRouteProposal"] is not expected_allow_route:
                _fail()
            expected_allow_continuation = (
                len(self.dependency_admissions) + (1 if pending_new_dependency is not None else 0) < 2
                and not prospective_redo_used
                and self.max_model_calls - self.model_requests >= 2 + self.max_reviews
                and self.max_work_units - len(project_artifacts(
                    self.history, self.session_id, self.problem_hash,
                )["rows"]) >= 2
                and self.remaining_ms() > _MIN_REMAINING_MS
            )
            if not self.derive_budget and body["allowTaskContinuation"] is not expected_allow_continuation:
                _fail()
            revision = body["revisionProvenance"]
            redo_used = self.redo_record is not None
            pending_redo = None
            if revision is not None:
                if not isinstance(revision, dict):
                    _fail()
                if redo_used:
                    if not same_json(self.redo_record, revision):
                        _fail()
                else:
                    if self.max_model_calls - self.model_requests < 1 + self.max_reviews:
                        _fail()
                    completed = len(project_artifacts(
                        self.history, self.session_id, self.problem_hash,
                    )["rows"])
                    if self.max_work_units - completed < 1:
                        _fail()
                    if self.remaining_ms() <= _MIN_REMAINING_MS:
                        _fail()
                    pending_redo = copy.deepcopy(revision)
                    redo_used = True
            expected_allow_redo = (
                not redo_used
                and self.max_model_calls - self.model_requests >= 2 + self.max_reviews
                and self.max_work_units - len(project_artifacts(
                    self.history, self.session_id, self.problem_hash,
                )["rows"]) >= 2
                and self.remaining_ms() > _MIN_REMAINING_MS
            )
            if not self.derive_budget and body["allowArtifactRedo"] is not expected_allow_redo:
                _fail()
            if redo_used:
                if body["allowRouteProposal"] is not False:
                    _fail()
                if body["allowTaskContinuation"] is not False:
                    _fail()
            expected_allow_final = (
                body["protectedCandidate"] is not None
                and self.max_model_calls - self.model_requests >= 1 + self.max_reviews
            )
            if not self.derive_budget and body["allowFinal"] is not expected_allow_final:
                _fail()
            if self.remaining_ms() <= _MIN_REMAINING_MS:
                _fail()
            if pending_redo is not None:
                self.redo_record = pending_redo
            if pending_new_provenance is not None:
                self.route_admissions[task_id] = pending_new_provenance
            if pending_new_dependency is not None:
                self.dependency_admissions[task_id] = pending_new_dependency
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail("DEADLINE_EXCEEDED")
        deadline = min(self.deadline, time.monotonic() + request["remainingMs"] / 1000.0)
        self._emit("model_dispatched", {
            "requestId": request_id,
            "phase": request["phase"],
            "modelCalls": self.model_requests,
            "remainingMs": self.remaining_ms(),
        })
        result = self.client.generate(copy.deepcopy(request), deadline)
        if not isinstance(result, dict):
            _fail()
        _exact_keys(result, ("transportStatus", "text", "remainingMs", "dispatchState"))
        transport = result["transportStatus"]
        if transport not in ("COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"):
            _fail()
        dispatch_state = result["dispatchState"]
        if dispatch_state not in ("DISPATCHED", "NOT_DISPATCHED"):
            _fail()
        sent = dispatch_state == "DISPATCHED"
        text = result["text"]
        if not isinstance(text, str):
            _fail()
        self.history[request_id] = {
            "request": copy.deepcopy(request),
            "receipt": {"transportStatus": transport, "text": text},
        }
        self.model_requests += 1
        self.last_model_id = request_id
        if request["phase"] in _FRONT_PHASES:
            self.front_spent += 1
        if request["phase"] in _CANDIDATE_PHASES:
            self.candidate_stage_seen = True
        if request["phase"] in ("R2", "R4"):
            self.review_calls += 1
        elif request["phase"] == "REPAIR":
            self.repair_calls += 1
        elif request["phase"] == "CONSENSUS":
            self.consensus_calls += 1
        if transport != "COMPLETE":
            if os.environ.get("ASTRA_DEBUG_GUARD") == "1":
                import sys as _debug_sys
                _debug_sys.stderr.write(
                    "ASTRA_TRANSPORT_STOP phase=%r request=%r transport=%r remaining=%r deadline=%r now=%r\n"
                    % (
                        request.get("phase"), request_id, transport,
                        request.get("remainingMs"), deadline, time.monotonic(),
                    )
                )
                _debug_sys.stderr.flush()
            self.stopped = True
        if transport == "UNKNOWN" and sent:
            # Only a request that actually left this process can have an unknown
            # remote outcome; a never-dispatched call proves nothing was sent.
            self.client.blocked = True
        if not sent:
            self.not_dispatched_requests += 1
        self._emit("model_returned", {
            "requestId": request_id,
            "phase": request["phase"],
            "transportStatus": transport,
            # ``dispatchState`` travels with the event: persistence and restart
            # recovery must be able to tell "provably not sent" from "sent and
            # unknown" without re-deriving it from a transport status alone.
            "dispatchState": dispatch_state,
            "modelCalls": self.model_requests,
            "remainingMs": self.remaining_ms(),
        })
        self.callback_done = False
        self.send(
            self.proc,
            {
                "jsonrpc": "2.0",
                "id": frame_id,
                "result": {
                    **self._common(),
                    "requestId": request_id,
                    "receipt": {
                        "transportStatus": transport,
                        "text": text,
                        "remainingMs": self.remaining_ms(),
                    },
                },
            },
            "model.generate",
        )
        self.pending_is_callback = True

    def on_tool(self, frame_id, params):
        self.on_effect(frame_id, params, "tool.execute")

    def on_effect(self, frame_id, params, wire_method):
        expected_kind = "method" if wire_method == "method.load" else "tool"
        record = self._last_model()
        if record is None:
            _fail()
        request = record["request"]
        if request["phase"] != "WORK":
            _fail()
        if record["receipt"]["transportStatus"] != "COMPLETE":
            _fail()
        if self.max_model_calls - self.model_requests < 1 + self.max_reviews:
            _fail("BUDGET")
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail("DEADLINE_EXCEEDED")
        body = _parse_inner(record["request"]["messages"][1]["content"])
        if not isinstance(body, dict):
            _fail()
        binding = self._binding(self.last_model_id)
        action = parse_action(record["receipt"]["text"], binding)
        if action["action"] == "explore":
            # Stage D+ controlled exploration: its own admission branch, so the
            # tool/method wire contract below stays byte-identical.
            self._on_explore_effect(frame_id, params, wire_method, action, binding)
            return
        if action["action"] != expected_kind:
            _fail()
        # One fixed budget order: the total id capacity, then the per-kind
        # quota (tool actions vs method-card loads), then the action grant the
        # Node body itself advertised.
        if not self._effect_admission(expected_kind):
            _fail("BUDGET")
        if expected_kind == "method":
            if body.get("allowMethods") is not True:
                _fail()
            if self.catalog is None or self.method_catalog is None or self.catalog_calls != 1:
                _fail()
            if not any(entry["id"] == action["id"] for entry in self.catalog["entries"]):
                _fail()
        else:
            if body.get("allowTools") is not True:
                _fail()
        effect_request = validate_request(params["request"])
        if effect_request["effectId"] != EFFECT_IDS[self.effect_calls]:
            _fail()
        if frame_id != "node-" + effect_request["effectId"]:
            _fail()
        if not same_json(effect_request["binding"], binding):
            _fail()
        if not same_json(effect_request["action"], action):
            _fail()
        source_id = effect_request["binding"]["sourceRequestId"]
        for entry in self.effects:
            if (
                isinstance(entry, dict)
                and isinstance(entry.get("request"), dict)
                and isinstance(entry["request"].get("binding"), dict)
                and entry["request"]["binding"].get("sourceRequestId") == source_id
            ):
                _fail()
        bound = copy.deepcopy(effect_request)
        bound["remainingMs"] = min(effect_request["remainingMs"], self.remaining_ms())
        if bound["remainingMs"] < _MIN_REMAINING_MS + 1:
            _fail()
        self.effect_calls += 1
        if expected_kind == "method":
            self.method_loads += 1
            if (
                action["id"] not in self.method_ids
                and len(self.method_ids) < self.max_method_loads
            ):
                self.method_ids.append(action["id"])
        else:
            self.tool_effect_count += 1
            if (
                action["name"] not in self.tool_names
                and len(self.tool_names) < self.max_effects
            ):
                self.tool_names.append(action["name"])
        try:
            if expected_kind == "method":
                result = perform_effect(
                    bound, root_deadline=self.deadline, catalog=self.method_catalog,
                    python_sandbox=self.python_sandbox,
                )
            else:
                result = perform_effect(
                    bound, root_deadline=self.deadline,
                    python_sandbox=self.python_sandbox,
                )
        except Exception:  # noqa: BLE001 - an unknown outcome is never a proof
            result = failure_receipt(bound, "UNKNOWN", "UNKNOWN_OUTCOME")
        try:
            checked = build_receipt(bound, result["status"], result["observation"])
        except Exception:  # noqa: BLE001 - a forged receipt is a fixed failure
            checked = failure_receipt(bound, "UNKNOWN", "UNKNOWN_OUTCOME")
        if not same_json(checked, result):
            checked = failure_receipt(bound, "UNKNOWN", "UNKNOWN_OUTCOME")
        if self.remaining_ms() <= _MIN_REMAINING_MS and checked["status"] != "UNKNOWN":
            checked = failure_receipt(bound, "ERROR", "DEADLINE_EXCEEDED")
        self.effects.append({"request": copy.deepcopy(bound), "receipt": copy.deepcopy(checked)})
        if (
            expected_kind == "method"
            and checked["status"] == "COMPLETE"
            and checked["source"] == "METHOD_REFERENCE"
            and self.catalog is not None
        ):
            asset = self._method_asset(checked, action["id"])
            if asset is None:
                checked = failure_receipt(bound, "UNKNOWN", "UNKNOWN_OUTCOME")
                self.effects[-1]["receipt"] = copy.deepcopy(checked)
            elif not any(item["id"] == asset["id"] for item in self.method_assets):
                self.method_assets.append(asset)
        if checked["status"] == "UNKNOWN":
            self.stopped = True
            self.client.blocked = True
        self._emit("effect_returned", {
            "effectId": checked.get("effectId"),
            "action": expected_kind,
            "name": action.get("name") or action.get("id"),
            "status": checked.get("status"),
            "source": checked.get("source"),
            "checkResult": checked.get("checkResult"),
        })
        if expected_kind == "method":
            self._emit("METHOD_LOAD", {
                "effectId": checked.get("effectId"),
                "methodId": action.get("id"),
                "status": checked.get("status"),
                "checkResult": checked.get("checkResult", "COMPLETE"),
            })
        else:
            self._emit("TOOL_OBSERVATION", {
                "id": checked.get("effectId"),
                "tool": action.get("name", "tool"),
                "args": action.get("args"),
                "observation": checked.get("observation"),
                "output": checked.get("observation"),
                "status": "error" if checked.get("status") == "ERROR" else "done",
            })
        self.callback_done = False
        self.send(
            self.proc,
            {
                "jsonrpc": "2.0",
                "id": frame_id,
                "result": {
                    **self._common(),
                    "receipt": copy.deepcopy(checked),
                    "remainingMs": self.remaining_ms(),
                },
            },
            wire_method,
        )
        self.pending_is_callback = True

    def _on_explore_effect(self, frame_id, params, wire_method, action, binding):
        """Admit and run one bounded generated-Python exploration.

        The admission order is fixed and fail-closed, and every refusal happens
        before the effect id is consumed and before any code can run:

        1. the Host must actually hold a usable sandbox -- the same state that
           makes it advertise ``AVAILABLE_BOUNDED`` -- else ``ACTION_NOT_ALLOWED``;
        2. one tool-kind effect id must still be free, else ``BUDGET``;
        3. the GenerativeExecutionGate must return ``ADMITTED``, else its own
           fixed ``REFUSED_NO_PROFILE`` / ``REFUSED_PROFILE_MISMATCH`` /
           ``REFUSED_SHA_MISMATCH`` / ``REFUSED_UNBOUNDED``.

        An admitted run is exactly one tool-kind effect: it spends one id from
        the existing capacity, records ``generated_exploration`` in
        ``tool_names`` and yields an explicitly untrusted ``BOUNDED_OBSERVATION``
        tagged ``BOUNDED_OBSERVATION_NOT_PROOF``. It is never a proof, never a
        certificate and never an obligation discharge.
        """
        if wire_method != "tool.execute":
            _fail()
        if self.generated_python_capability() != _GENERATED_PYTHON_BOUNDED:
            _fail(_EXPLORE_ACTION_NOT_ALLOWED)
        if not self._effect_admission("tool"):
            _fail("BUDGET")
        execution_request = self._exploration_request(action["code"])
        try:
            gate_decision = self.generated_python_gate.decision(execution_request)
        except Exception:  # noqa: BLE001 - a broken gate is a refusal, not a crash
            gate_decision = "REFUSED_NO_PROFILE"
        if gate_decision != "ADMITTED":
            if not isinstance(gate_decision, str) or gate_decision not in GATE_REASONS:
                gate_decision = "REFUSED_UNBOUNDED"
            _fail(gate_decision)
        # From here on the wire contract is validated exactly like a tool
        # effect; the effect id is consumed only after every check passes.
        effect_request = validate_request(params["request"])
        if effect_request["effectId"] != EFFECT_IDS[self.effect_calls]:
            _fail()
        if frame_id != "node-" + effect_request["effectId"]:
            _fail()
        if not same_json(effect_request["binding"], binding):
            _fail()
        if not same_json(effect_request["action"], action):
            _fail()
        source_id = effect_request["binding"]["sourceRequestId"]
        for entry in self.effects:
            if (
                isinstance(entry, dict)
                and isinstance(entry.get("request"), dict)
                and isinstance(entry["request"].get("binding"), dict)
                and entry["request"]["binding"].get("sourceRequestId") == source_id
            ):
                _fail()
        bound = copy.deepcopy(effect_request)
        bound["remainingMs"] = min(effect_request["remainingMs"], self.remaining_ms())
        if bound["remainingMs"] < _MIN_REMAINING_MS + 1:
            _fail()
        # Admitted: one tool-kind effect id, one bounded exploration record.
        self.effect_calls += 1
        self.tool_effect_count += 1
        self.exploration_calls += 1
        if (
            _EXPLORATION_TOOL_NAME not in self.tool_names
            and len(self.tool_names) < self.max_effects
        ):
            self.tool_names.append(_EXPLORATION_TOOL_NAME)
        outcome = self.generated_exploration(
            execution_request,
            action["code"],
            gate=self.generated_python_gate,
            scope=action["scope"],
        )
        checked = self._exploration_receipt(bound, outcome)
        if self.remaining_ms() <= _MIN_REMAINING_MS and checked["status"] != "UNKNOWN":
            checked = failure_receipt(bound, "ERROR", "DEADLINE_EXCEEDED")
        self.effects.append({"request": copy.deepcopy(bound), "receipt": copy.deepcopy(checked)})
        if checked["status"] == "UNKNOWN":
            self.stopped = True
            self.client.blocked = True
        self.callback_done = False
        self.send(
            self.proc,
            {
                "jsonrpc": "2.0",
                "id": frame_id,
                "result": {
                    **self._common(),
                    "receipt": copy.deepcopy(checked),
                    "remainingMs": self.remaining_ms(),
                },
            },
            wire_method,
        )
        self.pending_is_callback = True

    @staticmethod
    def _exploration_receipt(bound, outcome):
        """One receipt for one gate outcome; never a truncated or invented one."""
        admitted = isinstance(outcome, dict) and outcome.get("admitted") is True
        payload = outcome.get("result") if admitted else None
        if admitted and isinstance(payload, dict):
            observation = {
                "kind": "BOUNDED_OBSERVATION",
                "interpretation": "BOUNDED_OBSERVATION_NOT_PROOF",
                "status": payload.get("status"),
                "result": payload.get("output"),
            }
            try:
                text = json.dumps(
                    observation, allow_nan=False, ensure_ascii=False,
                    separators=(",", ":"), default=str,
                )
            except (ValueError, TypeError, RecursionError, OverflowError):
                text = None
            if text is not None and len(text.encode("utf-8", "replace")) <= MAX_OBSERVATION_BYTES:
                return build_receipt(bound, "COMPLETE", text)
            # An oversized observation is refused, never truncated or faked.
            return failure_receipt(bound, "ERROR", "OUTPUT_TOO_LARGE")
        reason = outcome.get("reason") if isinstance(outcome, dict) else None
        if not isinstance(reason, str) or (
            reason not in EXECUTION_REFUSALS and reason not in GATE_REASONS
        ):
            reason = "EFFECT_FAILED"
        return build_receipt(bound, "ERROR", json.dumps({"code": reason}, separators=(",", ":")))

    def _method_asset(self, checked, method_id):
        """Strictly re-check one METHOD_REFERENCE observation; None on failure."""
        try:
            observation = _parse_inner(checked["observation"])
            if not isinstance(observation, dict):
                return None
            if set(observation.keys()) != {"method", "asset", "interpretation"}:
                return None
            if observation["method"] != method_id:
                return None
            if observation["interpretation"] != "ADVISORY_NOT_PROOF":
                return None
            asset = observation["asset"]
            if not isinstance(asset, dict):
                return None
            if set(asset.keys()) != {
                "id", "title", "version", "body", "bodySha256", "bodyChars",
            }:
                return None
            if asset["id"] != method_id:
                return None
            title = None
            for entry in self.catalog["entries"]:
                if entry["id"] == method_id:
                    title = entry["title"]
                    break
            if title is None or asset["title"] != title:
                return None
            if asset["version"] != self.catalog["version"]:
                return None
            body = asset["body"]
            if not isinstance(body, str) or not body.strip():
                return None
            try:
                body.encode("utf-8", errors="strict")
            except UnicodeEncodeError:
                return None
            if not _is_int(asset["bodyChars"]) or asset["bodyChars"] != len(body):
                return None
            digest = asset["bodySha256"]
            if not isinstance(digest, str) or len(digest) != 64:
                return None
            for ch in digest:
                if ch not in "0123456789abcdef":
                    return None
            import hashlib

            if hashlib.sha256(body.encode("utf-8")).hexdigest() != digest:
                return None
            return copy.deepcopy(asset)
        except Exception:  # noqa: BLE001 - a malformed asset is never cached
            return None

    # -- outbound results -------------------------------------------------

    def on_result(self, message):
        if self.expected is None or self.pending is not None:
            _fail()
        expected_id, method = self.expected
        if message["id"] != expected_id:
            _fail()
        if method == "runtime.initialize":
            self.on_init_result(message)
            return
        if method == "session.solve":
            self.on_solve_result(message)
            return
        if method == "session.stop":
            self.on_stop_result(message)
            return
        _fail()

    def on_init_result(self, message):
        result = message["result"]
        payload(self.manifest, "runtime.initialize", "result", result, self.session_id)
        if result["engine"] != _ENGINE or result["mode"] != _MODE:
            _fail()
        self.expected = None

    def on_stop_result(self, message):
        result = message["result"]
        payload(self.manifest, "session.stop", "result", result, self.session_id)
        if result["stopped"] is not True:
            _fail()
        if self.solve_result is None:
            _fail()
        self.stop_acked = True
        self.expected = None

    def on_solve_result(self, message):
        result = message["result"]
        payload(self.manifest, "session.solve", "result", result, self.session_id)
        if self.model_requests > self.resume_model_offset and not self.callback_done:
            _fail()
        summary = result["summary"]
        _exact_keys(summary, _SUMMARY_FIELDS)
        if summary["sessionId"] != self.session_id:
            _fail()
        if summary["mode"] != _MODE or summary["targetEnvironment"] != "TARGET_UNVERIFIED":
            _fail()
        if summary["candidateVerified"] is not False:
            _fail()
        if summary["strictAcceptance"] != "NOT_PERFORMED":
            _fail()
        if summary["policy"] != self.policy:
            _fail()
        if summary["stopReason"] not in _STOP_REASONS:
            _fail()
        if summary["reason"] not in (
            "BEST_EFFORT_CANDIDATE", "STRICT_NOT_VERIFIED", "NO_CANDIDATE",
            "STALE_CANDIDATE", "DEADLINE_EXCEEDED",
            "REVISED_CANDIDATE", "REVISE_REJECTED",
        ):
            _fail()
        if (
            not _is_int(summary["modelCalls"])
            or summary["modelCalls"] < self.model_requests
            or summary["modelCalls"] > self.max_model_calls
        ):
            _fail()
        if (
            not _is_int(summary["effectCalls"])
            or not self.effect_calls <= summary["effectCalls"] <= self._effect_budget()
        ):
            _fail()
        if (
            not _is_int(summary["workUnits"])
            or summary["workUnits"] < 0
            or summary["workUnits"] > self.max_work_units
        ):
            _fail()
        if not _is_int(summary["reviewCalls"]) or summary["reviewCalls"] != self.review_calls:
            _fail()
        if summary["reviewCalls"] > self.max_reviews:
            _fail()
        if not _is_int(summary["repairCalls"]) or summary["repairCalls"] != self.repair_calls:
            _fail()
        if summary["repairCalls"] > self.max_repairs:
            _fail()
        if not _is_int(summary["catalogCalls"]) or summary["catalogCalls"] != self.catalog_calls:
            _fail()
        if not _is_int(summary["methodLoads"]) or summary["methodLoads"] != self.method_loads:
            _fail()
        if summary["methodLoads"] > self.max_method_loads:
            _fail()
        unresolved = summary["unresolvedObligations"]
        if not isinstance(unresolved, list) or len(unresolved) > 32:
            _fail()
        for item in unresolved:
            if not isinstance(item, str) or not item or len(item) > 256:
                _fail()
        if len(set(unresolved)) != len(unresolved):
            _fail()
        if not isinstance(summary["finalResponse"], str) or not summary["finalResponse"]:
            _fail()
        trace = result["trace"]
        if not isinstance(trace, list) or len(trace) > 128:
            _fail()
        for index, row in enumerate(trace):
            _exact_keys(row, _TRACE_FIELDS)
            if row["seq"] != index + 1:
                _fail()
            if row["kind"] not in _TRACE_KINDS or row["state"] not in _TRACE_STATES:
                _fail()
            if row["code"] not in _STOP_REASONS:
                _fail()
            _trace_id(row["kind"], row["id"])
        candidate = result["candidateRequestId"]
        if candidate is None:
            if summary["status"] != "unsolved":
                _fail()
            if summary["finalResponse"] != "Unsolved.":
                _fail()
        else:
            if summary["status"] != "candidate":
                _fail()
            if self.policy == "STRICT":
                _fail()
            if self._is_resuming():
                # Step 2: a resumed run must NOT be trusted blindly. The final
                # answer has to equal the candidate rebuilt from the restored
                # SessionLog's own WORKUNIT/REPAIR events (Candidate Provenance
                # Check); a forged FINAL is rejected instead of returned.
                rebuilt = self._resumed_candidate()
                if rebuilt is None or summary["finalResponse"] != rebuilt:
                    _fail()
            else:
                if candidate not in self.history:
                    _fail()
                packet = candidate_packet(
                    self.history, candidate, self.problem, self.session_id, self.problem_hash,
                )
                if packet is None:
                    _fail()
                projection = project_artifacts(
                    self.history, self.session_id, self.problem_hash,
                )
                row = projection["bySourceRef"].get(candidate)
                if not isinstance(row, dict):
                    _fail()
                if row["availability"] != "ACTIVE":
                    _fail()
                latest = None
                for other in projection["rows"]:
                    if other["artifactId"] != row["artifactId"]:
                        continue
                    if latest is None or other["envelope"]["artifactVersion"] > latest["envelope"]["artifactVersion"]:
                        latest = other
                if latest is not row:
                    _fail()
                if summary["finalResponse"] != packet["candidateProposal"]:
                    _fail()
            # Node decides which eligible candidate is protected (by goal-kind
            # answer obligation); the Host only VERIFIES that the recorded
            # candidate is a real ACTIVE, latest-version, eligible packet, which
            # the checks above already establish. It no longer re-selects "the
            # first" candidate itself.
        if not self._is_resuming():
            self._check_final_provenance(candidate, summary["stopReason"])
        self.solve_result = copy.deepcopy(result)
        private_state = result.get("privateState")
        if isinstance(private_state, dict):
            session_log = private_state.get("sessionLog")
            if isinstance(session_log, dict) and isinstance(session_log.get("events"), list):
                for ev in session_log["events"]:
                    if not isinstance(ev, dict):
                        continue
                    kind = ev.get("kind")
                    data = ev.get("data")
                    if not isinstance(data, dict):
                        continue
                    clean_data = {k: v for k, v in data.items() if not k.startswith("__")}
                    if kind in (
                        "CONTRACT", "TASK_STARTED", "WORKUNIT",
                        "REVIEW_CHALLENGE", "REPAIR", "CONSENSUS",
                    ):
                        self._emit(kind, clean_data)
        self.expected = None

    def _check_final_provenance(self, candidate, stop_reason):
        """Reject a forged final confirmation; never echo raw model text.

        Every COMPLETE WORK record whose raw text parses as a ``final`` action
        must be a real confirmation of the protected candidate that already
        existed in the history before it: the source context must be the v3
        shape with ``allowFinal`` true and a ``protectedCandidate`` equal to the
        Host-rebuilt projection of that earlier history, in the same scope, and
        the action must match answer/complete/unresolved exactly. A legal final
        stops further WORK, so at most the authorized R2 calls may follow it.
        An illegal final is a control rejection: the Loop must have stopped with
        CONTROL_REJECTED and no later model call may exist. A STRICT run keeps
        its candidate withheld, so ``candidate`` may legitimately be ``None``.
        """
        try:
            ordered = sorted(
                (
                    (int(name.split("-")[1]), name)
                    for name in self.history
                    if isinstance(name, str)
                    and name.startswith("model-")
                    and name.split("-")[1] in tuple(str(n) for n in range(1, 257))
                )
            )
        except Exception:  # noqa: BLE001 - a malformed key is not a final
            return
        for ordinal, request_id in ordered:
            record = self.history.get(request_id)
            if not isinstance(record, dict):
                continue
            request = record.get("request")
            receipt = record.get("receipt")
            if not isinstance(request, dict) or not isinstance(receipt, dict):
                continue
            if request.get("phase") != "WORK":
                continue
            if receipt.get("transportStatus") != "COMPLETE":
                continue
            text = receipt.get("text")
            if not isinstance(text, str):
                continue
            try:
                action = parse_action(text, self._binding(request_id))
            except Exception:  # noqa: BLE001 - a non-action is not a final
                continue
            if not isinstance(action, dict) or action.get("action") != "final":
                continue
            body = _parse_inner(request["messages"][1]["content"])
            if not isinstance(body, dict):
                _fail()
            prior = {}
            for other_ordinal, other_id in ordered:
                if other_ordinal < ordinal:
                    prior[other_id] = self.history[other_id]
            # The Host only VERIFIES the projection the Node recorded for this
            # WORK context; it never re-selects "the first" candidate. The
            # expected projection is rebuilt for the recorded source request.
            recorded = body.get("protectedCandidate")
            recorded_source = None
            if isinstance(recorded, dict) and isinstance(recorded.get("binding"), dict):
                recorded_source = recorded["binding"].get("sourceRequestId")
            expected = None
            if isinstance(recorded_source, str):
                expected = _projection_for_source(
                    prior, self.problem, self.session_id, self.problem_hash, recorded_source,
                )
            legal = (
                body.get("schemaVersion") == "agent-work-context-v7"
                and body.get("allowFinal") is True
                and expected is not None
                and same_json(recorded, expected)
                and action.get("answer") == expected["answer"]
                and action.get("complete") is True
                and action.get("unresolved") == []
            )
            if not legal:
                if stop_reason != "CONTROL_REJECTED":
                    _fail()
                for later_ordinal, later_id in ordered:
                    if later_ordinal > ordinal:
                        _fail()
                continue
            if candidate is not None and candidate != expected["binding"]["sourceRequestId"]:
                _fail()
            for later_ordinal, later_id in ordered:
                if later_ordinal <= ordinal:
                    continue
                later = self.history.get(later_id)
                if not isinstance(later, dict):
                    _fail()
                later_request = later.get("request")
                if not isinstance(later_request, dict):
                    _fail()
                if later_request.get("phase") not in ("R2", "R4", "REPAIR"):
                    _fail()
