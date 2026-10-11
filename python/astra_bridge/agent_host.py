"""Unified AgentLoop Host callback: one class over the shared P0 reader.

Reuses ``p0_probe._Host`` for framing, selector pump and deadline handling and
the existing P3 action/effect guards. No second channel, no second JSON parser,
no network, no mathematical selection: the only model source is the injected
``AgentClient``, and every receipt stays PROVISIONAL/UNKNOWN. This module never
starts a process; the runtime owns spawn/reap.
"""

from __future__ import annotations

import copy
import time

from .agent_client import AgentClient
from .agent_context import (
    _work_ordinals,
    candidate_packet,
    protected_final,
    validate_context,
)
from .p0_probe import ProbeError, _Host
from .p2_host_fixture import _parse_inner
from .p3_effect_contract import (
    EFFECT_IDS,
    failure_receipt,
    receipt as build_receipt,
    validate_request,
)
from .p3_effects import perform_effect
from .p3_host_context import parse_action, same_json
from .p3_host_protocol import payload as p3_payload
from .agent_protocol import AGENT_HOST_VERSION, payload
from .p2_methods import fixture_catalog
from .p3_host_methods import checked_catalog

__all__ = ["AgentHost"]

_MIN_REMAINING_MS = 25
_MAX_REMAINING_MS = 5000
_MAX_MODEL_CALLS = 4
_MAX_WORK_UNITS = 3
_MAX_EFFECTS = 2
_MAX_REVIEWS = 1
_MAX_METHOD_LOADS = 1
_MAX_TOKENS = 8192
_HOST_SOLVE_ID = "host-2"
_HOST_STOP_ID = "host-3"
_PROFILE_ID = "math-agent-preview-v2"
_ENGINE = "ts"
_MODE = "TS_PREVIEW"
_POLICIES = ("BEST_EFFORT", "STRICT")
_STOP_REASONS = (
    "WORK", "R2", "COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN", "ADMITTED",
    "BUDGET_EXHAUSTED", "DEADLINE_EXCEEDED", "ILLEGAL_TRANSITION",
    "NO_CANDIDATE", "NO_REVIEW", "CONTROL_REJECTED", "PACKET_REJECTED",
    "CONTEXT_REJECTED", "REVIEW_STOP", "REVIEWS_COMPLETE",
    "WORK_UNITS_COMPLETE", "PORT_REJECTED", "STOPPED",
)
_TRACE_KINDS = ("MODEL", "EFFECT", "CONTROL")
_TRACE_STATES = ("DISPATCHED", "RETURNED", "OUTCOME_UNKNOWN", "RECORDED")
_MODEL_TRACE_IDS = ("model-1", "model-2", "model-3", "model-4")
_EFFECT_TRACE_IDS = ("effect-1", "effect-2")
# The root AgentSession emits exactly one control trace id, `control`. The
# older P0/P1/P2/P3 traces are not touched here; this filter only accepts the
# real id the unified AgentSession actually records.
_CONTROL_TRACE_IDS = ("control",)
_SUMMARY_FIELDS = (
    "mode", "targetEnvironment", "sessionId", "status", "finalResponse",
    "candidateVerified", "strictAcceptance", "policy", "reason", "modelCalls",
    "effectCalls", "workUnits", "reviewCalls", "catalogCalls", "methodLoads",
    "stopReason",
)
_TRACE_FIELDS = ("seq", "kind", "id", "state", "code")


def _fail(code="FIELD_VALUE"):
    raise ProbeError(code)


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


class AgentHost(_Host):
    """Host-side unified AgentLoop callback state machine."""

    def __init__(self, manifest, session_id, deadline, problem, problem_hash,
                 options, client):
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
                "maxMethodLoads", "policy",
            ),
        )
        self.max_model_calls = _bounded_int(options["maxModelCalls"], 0, _MAX_MODEL_CALLS)
        self.max_work_units = _bounded_int(options["maxWorkUnits"], 1, _MAX_WORK_UNITS)
        self.max_effects = _bounded_int(options["maxEffects"], 0, _MAX_EFFECTS)
        self.max_reviews = _bounded_int(options["maxReviews"], 0, _MAX_REVIEWS)
        self.max_method_loads = _bounded_int(options["maxMethodLoads"], 0, _MAX_METHOD_LOADS)
        if options["policy"] not in _POLICIES:
            _fail()
        self.policy = options["policy"]
        self.problem = problem
        self.problem_hash = problem_hash
        self.client = client
        self.stop_acked = False
        self.history = {}
        self.effects = []
        self.model_requests = 0
        self.effect_calls = 0
        self.review_calls = 0
        self.catalog_calls = 0
        self.method_loads = 0
        self.catalog = None
        self.method_assets = []
        self.method_catalog = None
        self.initial_client_calls = client.calls
        self.initial_client_records = len(client.snapshot())
        self.stopped = False
        self.last_model_id = None
        self.solve_result = None
        self.route_admissions = {}

    # -- helpers ----------------------------------------------------------

    def remaining_ms(self):
        left = int(self.remaining() * 1000)
        if left < 0:
            return 0
        if left > _MAX_REMAINING_MS:
            return _MAX_REMAINING_MS
        return left

    def _common(self):
        return {"protocolVersion": AGENT_HOST_VERSION, "sessionId": self.session_id}

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
        return self.max_effects

    # -- inbound ----------------------------------------------------------

    def on_request(self, message):
        method = message["method"]
        if method not in ("model.generate", "tool.execute", "method.catalog", "method.load"):
            _fail()
        if self.expected is None or self.expected != (_HOST_SOLVE_ID, "session.solve"):
            _fail()
        if self.pending is not None or self.stopped:
            _fail()
        if self.model_requests > 0 and not self.callback_done:
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
        self.on_tool(message["id"], params)

    def _methods_enabled(self):
        return (
            self.max_method_loads == 1
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
            _fail()
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

    def on_model(self, frame_id, params):
        ordinal = self.model_requests + 1
        if ordinal > self.max_model_calls:
            _fail()
        if self.model_requests == 0 and self._methods_enabled():
            if self.catalog_calls != 1 or not self.callback_done:
                _fail()
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail()
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
        if request["phase"] == "R2":
            if self.review_calls >= self.max_reviews:
                _fail()
            if self.review_calls >= 1:
                _fail()
        else:
            if self.review_calls > 0:
                _fail()
        if request_id in self.history:
            _fail()
        body = validate_context(
            request, self.problem, self.session_id, self.problem_hash,
            self.history, self.effects, self.catalog, self.method_assets,
        )
        if request["phase"] == "WORK":
            reserve_ok = self.max_model_calls - self.model_requests >= 2 + self.max_reviews
            task_id = request["taskId"]
            provenance = body["routeProvenance"]
            pending_new_provenance = None
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
                    completed = len(_work_ordinals(
                        self.history, self.problem, self.session_id, self.problem_hash,
                    ))
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
                and entry["request"].get("action", {}).get("action") == "tool"
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
            allow_tools = reserve_ok and (
                self.effect_calls < self._effect_budget() or cached_tool
            )
            allow_methods = (
                reserve_ok
                and self.catalog is not None
                and bool(self.catalog["entries"])
                and (
                    (self.method_loads < self.max_method_loads
                     and self.effect_calls < self._effect_budget())
                    or cached_method
                )
            )
            if body["allowTools"] is not allow_tools:
                _fail()
            if body["allowMethods"] is not allow_methods:
                _fail()
            expected_allow_route = (
                not self.route_admissions
                and pending_new_provenance is None
                and self.max_model_calls - self.model_requests >= 2 + self.max_reviews
                and self.max_work_units - len(_work_ordinals(
                    self.history, self.problem, self.session_id, self.problem_hash,
                )) >= 2
                and self.remaining_ms() > _MIN_REMAINING_MS
            )
            if body["allowRouteProposal"] is not expected_allow_route:
                _fail()
            expected_allow_final = (
                body["protectedCandidate"] is not None
                and self.max_model_calls - self.model_requests >= 1 + self.max_reviews
            )
            if body["allowFinal"] is not expected_allow_final:
                _fail()
            if pending_new_provenance is not None:
                self.route_admissions[task_id] = pending_new_provenance
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail()
        deadline = min(self.deadline, time.monotonic() + request["remainingMs"] / 1000.0)
        result = self.client.generate(copy.deepcopy(request), deadline)
        if not isinstance(result, dict):
            _fail()
        _exact_keys(result, ("transportStatus", "text", "remainingMs"))
        transport = result["transportStatus"]
        if transport not in ("COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"):
            _fail()
        text = result["text"]
        if not isinstance(text, str):
            _fail()
        self.history[request_id] = {
            "request": copy.deepcopy(request),
            "receipt": {"transportStatus": transport, "text": text},
        }
        self.model_requests += 1
        self.last_model_id = request_id
        if request["phase"] == "R2":
            self.review_calls += 1
        if transport != "COMPLETE":
            self.stopped = True
        if transport == "UNKNOWN":
            self.client.blocked = True
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
        record = self._last_model()
        if record is None:
            _fail()
        request = record["request"]
        if request["phase"] != "WORK":
            _fail()
        if record["receipt"]["transportStatus"] != "COMPLETE":
            _fail()
        if self.effect_calls >= self._effect_budget():
            _fail()
        if self.max_model_calls - self.model_requests < 1 + self.max_reviews:
            _fail()
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail()
        body = _parse_inner(record["request"]["messages"][1]["content"])
        if not isinstance(body, dict):
            _fail()
        binding = self._binding(self.last_model_id)
        action = parse_action(record["receipt"]["text"], binding)
        expected_kind = "method" if wire_method == "method.load" else "tool"
        if action["action"] != expected_kind:
            _fail()
        if expected_kind == "method":
            if body.get("allowMethods") is not True:
                _fail()
            if self.max_method_loads != 1 or self.method_loads >= _MAX_METHOD_LOADS:
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
        try:
            if expected_kind == "method":
                result = perform_effect(
                    bound, root_deadline=self.deadline, catalog=self.method_catalog,
                )
            else:
                result = perform_effect(bound, root_deadline=self.deadline)
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
        if self.model_requests > 0 and not self.callback_done:
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
        ):
            _fail()
        if not _is_int(summary["modelCalls"]) or not self.model_requests <= summary["modelCalls"] <= self.max_model_calls:
            _fail()
        if not _is_int(summary["effectCalls"]) or not self.effect_calls <= summary["effectCalls"] <= self.max_effects:
            _fail()
        if not _is_int(summary["workUnits"]) or not 0 <= summary["workUnits"] <= self.max_work_units:
            _fail()
        if not _is_int(summary["reviewCalls"]) or summary["reviewCalls"] != self.review_calls:
            _fail()
        if summary["reviewCalls"] > self.max_reviews:
            _fail()
        if not _is_int(summary["catalogCalls"]) or summary["catalogCalls"] != self.catalog_calls:
            _fail()
        if not _is_int(summary["methodLoads"]) or summary["methodLoads"] != self.method_loads:
            _fail()
        if summary["methodLoads"] > self.max_method_loads:
            _fail()
        if not isinstance(summary["finalResponse"], str) or not summary["finalResponse"]:
            _fail()
        trace = result["trace"]
        if not isinstance(trace, list) or len(trace) > 64:
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
            if candidate not in self.history:
                _fail()
            packet = candidate_packet(
                self.history, candidate, self.problem, self.session_id, self.problem_hash,
            )
            if packet is None:
                _fail()
            if summary["finalResponse"] != packet["candidateProposal"]:
                _fail()
            first = None
            for request_id in sorted(self.history, key=lambda name: int(name.split("-")[1])):
                if candidate_packet(
                    self.history, request_id, self.problem, self.session_id, self.problem_hash,
                ) is not None:
                    first = request_id
                    break
            if first != candidate:
                _fail()
        self._check_final_provenance(candidate, summary["stopReason"])
        self.solve_result = copy.deepcopy(result)
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
                    and name.split("-")[1] in ("1", "2", "3", "4")
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
            expected = protected_final(
                prior, self.problem, self.session_id, self.problem_hash,
            )
            legal = (
                body.get("schemaVersion") == "agent-work-context-v4"
                and body.get("allowFinal") is True
                and expected is not None
                and same_json(body.get("protectedCandidate"), expected)
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
                if later_request.get("phase") != "R2":
                    _fail()
