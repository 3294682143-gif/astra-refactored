"""P3 Host callback: one compact class over the shared P0 reader/pump/reap.

Reuses ``p0_probe._Host`` for framing, selector pump and deadline handling.
No second channel, no second JSON parser, no network, no real client: the only
model source is a literal receipt list supplied by the caller. Every failure is
a fixed code and never echoes raw input.
"""

from __future__ import annotations

import copy

from .p0_probe import ProbeError, _Host
from .p3_effect_contract import (
    EFFECT_IDS,
    REQUEST_IDS,
    failure_receipt,
    receipt as build_receipt,
    validate_request,
)
from .p3_effects import perform_effect
from .p3_host_context import (
    effect_key,
    parse_action,
    same_json,
    strict_context,
    validate_receipts,
)
from .p3_host_methods import checked_catalog
from .p3_host_protocol import P3_HOST_VERSION, payload

__all__ = ["P3HostCallback"]

_MIN_REMAINING_MS = 25
_MAX_REMAINING_MS = 3600000
_MAX_MODEL_CALLS = 3
_MAX_EFFECTS = 2
_MAX_METHOD_LOADS = 1
_MAX_TOKENS = 8192
_TEMPERATURE = "0.2"
_BASE_ACTIONS = ("PROPOSE_FINAL", "MARK_UNSOLVED")
_TOOL_ACTION = "CALL_REGISTERED_TOOL"
_METHOD_ACTION = "LOAD_METHOD"
_STOP_REASONS = (
    "FINAL", "UNSOLVED", "FIXTURE_EXHAUSTED", "BUDGET_EXHAUSTED", "TRANSPORT_STOP",
    "ACTION_REJECTED", "EFFECT_UNAVAILABLE", "EFFECT_UNKNOWN", "DEADLINE_EXCEEDED",
    "CONTEXT_REJECTED",
)


def _fail():
    raise ProbeError("FIELD_VALUE")


class P3HostCallback(_Host):
    """Host-side P3 callback state machine over the shared P0 reader."""

    def __init__(self, manifest, session_id, deadline, problem, problem_hash,
                 receipts, max_calls, max_effects, max_method_loads=0):
        super().__init__(manifest, session_id, None, deadline)
        if isinstance(max_calls, bool) or not isinstance(max_calls, int) or not 0 <= max_calls <= _MAX_MODEL_CALLS:
            _fail()
        if isinstance(max_effects, bool) or not isinstance(max_effects, int) or not 0 <= max_effects <= _MAX_EFFECTS:
            _fail()
        if isinstance(max_method_loads, bool) or not isinstance(max_method_loads, int) or not 0 <= max_method_loads <= _MAX_METHOD_LOADS:
            _fail()
        self.problem = problem
        self.problem_hash = problem_hash
        self.receipts = validate_receipts(receipts)
        self.max_calls = max_calls
        self.max_effects = max_effects
        self.max_method_loads = max_method_loads
        self.history = []
        self.effects = []
        self.effect_records = []
        self.model_records = []
        self.anchor = None
        self.cache = {}
        self.source_used = set()
        self.cached_sources = set()
        self.context_hash = None
        self.solve_result = None
        self.model_calls = 0
        self.effect_calls = 0
        self.method_loads = 0
        self.catalog_calls = 0
        self.method_catalog = None
        self.catalog_entries = []
        self.catalog_record = None
        self.catalog_required = (
            max_method_loads == 1 and max_calls > 1 and max_effects > 0
        )
        self.stop_reason = "FIXTURE_EXHAUSTED"
        self.stopped = False

    # -- helpers ----------------------------------------------------------

    def remaining_ms(self):
        left = int(self.remaining() * 1000)
        if left < 0:
            return 0
        if left > _MAX_REMAINING_MS:
            return _MAX_REMAINING_MS
        return left

    def _common(self):
        return {"protocolVersion": P3_HOST_VERSION, "sessionId": self.session_id}

    def _last_model(self):
        if not self.model_records:
            return None
        return self.model_records[-1]

    def _last_action(self):
        record = self._last_model()
        if record is None or record["state"] != "RETURNED":
            return None
        if record["receipt"]["deliveryStatus"] != "COMPLETE":
            return None
        return parse_action(record["receipt"]["text"], self._binding(record["requestId"]))

    def _binding(self, request_id):
        record = self._last_model()
        if record is None:
            _fail()
        params = record["params"]
        return {
            "sessionId": self.session_id,
            "problemHash": self.problem_hash,
            "contractVersion": 1,
            "taskId": params["taskId"],
            "scopeId": params["scopeId"],
            "sourceRequestId": request_id,
        }

    def _allowed(self, ordinal):
        allowed = list(_BASE_ACTIONS)
        if ordinal < self.max_calls:
            tool_left = self.effect_calls < self.max_effects
            tool_cached = any(
                entry["source"] == "PROGRAM_OBSERVATION" for entry in self.cache.values()
            )
            if tool_left or tool_cached:
                allowed.append(_TOOL_ACTION)
            method_left = (
                self.method_loads < _MAX_METHOD_LOADS
                and self.effect_calls < self.max_effects
            )
            method_cached = any(
                entry["source"] == "METHOD_REFERENCE" for entry in self.cache.values()
            )
            if (
                self.max_method_loads == 1
                and self.catalog_entries
                and (method_left or method_cached)
            ):
                allowed.append(_METHOD_ACTION)
        return allowed

    # -- inbound ----------------------------------------------------------

    def on_request(self, message):
        method = message["method"]
        if method not in ("model.generate", "tool.execute", "method.catalog", "method.load"):
            _fail()
        if self.expected is None or self.expected != ("host-2", "session.solve"):
            _fail()
        if self.pending is not None:
            _fail()
        if self.stopped:
            _fail()
        if self.model_calls > 0 and not self.callback_done:
            _fail()
        params = message["params"]
        payload(self.manifest, method, "params", params, self.session_id)
        if method == "model.generate":
            if self.catalog_required and (
                self.catalog_calls != 1 or not self.callback_done
            ):
                _fail()
            self.on_model(message["id"], params)
            return
        if method == "method.catalog":
            if self.model_calls != 0 or self.catalog_calls != 0 or not self.catalog_required:
                _fail()
            if self.remaining_ms() <= _MIN_REMAINING_MS:
                _fail()
            if message["id"] != "node-catalog-1":
                _fail()
            self.on_catalog(message["id"], params)
            return
        if method == "method.load":
            self.on_effect(message["id"], params, "method.load")
            return
        self.on_effect(message["id"], params, "tool.execute")

    def on_catalog(self, frame_id, params):
        if self.catalog_record is not None:
            _fail()
        self.catalog_record = {
            "state": "ADMITTED",
            "params": copy.deepcopy(params),
            "result": None,
        }
        self.catalog_record["state"] = "DISPATCHED"
        from .p2_methods import MethodCatalog, fixture_catalog

        try:
            self.method_catalog = MethodCatalog()
            raw = fixture_catalog(self.method_catalog)
            catalog = checked_catalog(raw)
        except Exception:  # noqa: BLE001 - an unavailable catalog is not a failure
            self.method_catalog = None
            catalog = {"version": "1.1.0", "entries": []}
        self.catalog_entries = copy.deepcopy(catalog["entries"])
        self.catalog_calls = 1
        self.catalog_record["result"] = copy.deepcopy(catalog)
        self.catalog_record["state"] = "OBSERVED"
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            self.stopped = True
        if self.remaining() <= 0:
            raise ProbeError("TIMEOUT")
        result = {
            **self._common(),
            "remainingMs": self.remaining_ms(),
            "catalog": copy.deepcopy(catalog),
        }
        self.callback_done = False
        self.send(self.proc, {"jsonrpc": "2.0", "id": frame_id, "result": result}, "method.catalog")
        self.pending_is_callback = True

    def on_model(self, frame_id, params):
        ordinal = self.model_calls + 1
        if ordinal > min(self.max_calls, _MAX_MODEL_CALLS):
            _fail()
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail()
        request_id = params["requestId"]
        if request_id != REQUEST_IDS[ordinal - 1]:
            _fail()
        if frame_id != "node-" + request_id:
            _fail()
        previous = self._last_model()
        pending_source = None
        if previous is not None:
            if previous["state"] != "RETURNED":
                _fail()
            if previous["receipt"]["deliveryStatus"] != "COMPLETE":
                _fail()
            action = parse_action(previous["receipt"]["text"], self._binding(previous["requestId"]))
            if action["action"] not in ("tool", "method"):
                _fail()
            key = effect_key(action)
            if key not in self.cache:
                _fail()
            source = previous["requestId"]
            if source not in self.source_used:
                if source in self.cached_sources:
                    _fail()
                pending_source = source
        if ordinal >= self.max_calls and self.model_calls >= self.max_calls:
            _fail()
        allowed = self._allowed(ordinal)
        inner = strict_context(
            params, self.problem, self.session_id, self.problem_hash,
            self.history, self.effects, self.anchor, allowed, self.catalog_entries,
        )
        if self.history:
            if params["messages"][0] != self.history[0]["params"]["messages"][0]:
                _fail()
        if self.remaining_ms() <= _MIN_REMAINING_MS:
            _fail()
        if self.anchor is None:
            self.anchor = copy.deepcopy(inner)
        if pending_source is not None:
            self.cached_sources.add(pending_source)
        self.model_records.append({
            "requestId": request_id,
            "state": "ADMITTED",
            "params": copy.deepcopy(params),
            "receipt": None,
        })
        self.model_records[-1]["state"] = "DISPATCHED"
        if self.model_calls < len(self.receipts):
            entry = self.receipts[self.model_calls]
            delivery = entry["deliveryStatus"]
            text = entry["text"]
        else:
            delivery = "ERROR"
            text = ""
        self.model_records[-1]["receipt"] = {"deliveryStatus": delivery, "text": text}
        self.model_records[-1]["state"] = "RETURNED" if delivery != "UNKNOWN" else "OUTCOME_UNKNOWN"
        if delivery != "COMPLETE":
            self.stopped = True
        self.history.append({
            "requestId": request_id,
            "params": copy.deepcopy(params),
            "receipt": {"deliveryStatus": delivery, "text": text},
        })
        self.model_calls += 1
        self.context_hash = params["contextHash"]
        result = {
            **self._common(),
            "requestId": request_id,
            "mode": "MOCK_ONLY",
            "deliveryStatus": delivery,
            "text": text,
            "remainingMs": self.remaining_ms(),
        }
        self.callback_done = False
        self.send(self.proc, {"jsonrpc": "2.0", "id": frame_id, "result": result}, "model.generate")
        self.pending_is_callback = True

    def on_effect(self, frame_id, params, wire_method):
        record = self._last_model()
        if record is None or record["state"] != "RETURNED":
            _fail()
        if record["receipt"]["deliveryStatus"] != "COMPLETE":
            _fail()
        if self.model_calls >= self.max_calls:
            _fail()
        if self.effect_calls >= min(self.max_effects, _MAX_EFFECTS):
            _fail()
        request = validate_request(params["request"])
        if request["effectId"] != EFFECT_IDS[self.effect_calls]:
            _fail()
        if frame_id != "node-effect-" + str(self.effect_calls + 1):
            _fail()
        action = request["action"]
        expected_kind = "method" if wire_method == "method.load" else "tool"
        if action["action"] != expected_kind:
            _fail()
        binding = self._binding(record["requestId"])
        if not same_json(request["binding"], binding):
            _fail()
        parsed = parse_action(record["receipt"]["text"], binding)
        if not same_json(parsed, action):
            _fail()
        source = record["requestId"]
        if source in self.source_used:
            _fail()
        key = effect_key(action)
        if key in self.cache:
            _fail()
        if expected_kind == "method":
            if self.max_method_loads != 1:
                _fail()
            if self.method_catalog is None or self.catalog_calls != 1:
                _fail()
            if self.method_loads >= _MAX_METHOD_LOADS:
                _fail()
            known = False
            for entry in self.catalog_entries:
                if entry["id"] == action["id"]:
                    known = True
                    break
            if not known:
                _fail()
        bound = copy.deepcopy(request)
        bound["remainingMs"] = min(request["remainingMs"], self.remaining_ms())
        if bound["remainingMs"] < _MIN_REMAINING_MS + 1:
            _fail()
        self.effect_records.append({
            "request": copy.deepcopy(bound),
            "state": "ADMITTED",
            "receipt": None,
        })
        self.effect_records[-1]["state"] = "DISPATCHED"
        self.effect_calls += 1
        if expected_kind == "method":
            self.method_loads += 1
        self.source_used.add(source)
        try:
            if expected_kind == "method":
                result = perform_effect(
                    bound, root_deadline=self.deadline, catalog=self.method_catalog
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
        late = self.remaining_ms() <= _MIN_REMAINING_MS
        if late and checked["status"] != "UNKNOWN":
            checked = failure_receipt(bound, "ERROR", "DEADLINE_EXCEEDED")
        self.effect_records[-1]["receipt"] = copy.deepcopy(checked)
        if checked["status"] == "UNKNOWN":
            self.effect_records[-1]["state"] = "OUTCOME_UNKNOWN"
            self.stopped = True
        elif late:
            self.effect_records[-1]["state"] = "OBSERVED"
            self.stopped = True
        else:
            self.effect_records[-1]["state"] = "OBSERVED"
            self.effects.append(copy.deepcopy(checked))
            self.cache[key] = copy.deepcopy(checked)
        if self.remaining() <= 0:
            raise ProbeError("TIMEOUT")
        result_frame = {
            **self._common(),
            "receipt": copy.deepcopy(checked),
            "remainingMs": self.remaining_ms(),
        }
        self.callback_done = False
        self.send(self.proc, {"jsonrpc": "2.0", "id": frame_id, "result": result_frame}, wire_method)
        self.pending_is_callback = True

    # -- outbound results -------------------------------------------------

    def on_result(self, message):
        if self.expected is None:
            _fail()
        if self.pending is not None:
            _fail()
        expected_id, method = self.expected
        if message["id"] != expected_id:
            _fail()
        if method == "runtime.initialize":
            payload(self.manifest, "runtime.initialize", "result", message["result"], self.session_id)
            self.expected = None
            return
        if method == "session.solve":
            self.on_solve_result(message)
            return
        if method == "session.stop":
            self.on_stop_result(message)
            return
        _fail()

    def on_solve_result(self, message):
        result = message["result"]
        payload(self.manifest, "session.solve", "result", result, self.session_id)
        if self.model_calls > 0 and not self.callback_done:
            _fail()
        if result["modelCalls"] != self.model_calls:
            _fail()
        if result["effectCalls"] != self.effect_calls:
            _fail()
        if result["catalogCalls"] != self.catalog_calls:
            _fail()
        if result["methodLoads"] != self.method_loads:
            _fail()
        pending_cache_source = None
        cached = result["cachedEffects"]
        if cached != len(self.cached_sources):
            if not (
                result["stopReason"] == "CONTEXT_REJECTED"
                and cached == len(self.cached_sources) + 1
                and self.model_calls < self.max_calls
                and self._last_model() is not None
                and self._last_model()["state"] == "RETURNED"
                and self._last_model()["receipt"]["deliveryStatus"] == "COMPLETE"
            ):
                _fail()
            record = self._last_model()
            action = parse_action(record["receipt"]["text"], self._binding(record["requestId"]))
            if action["action"] not in ("tool", "method"):
                _fail()
            if effect_key(action) not in self.cache:
                _fail()
            source = record["requestId"]
            if source in self.source_used or source in self.cached_sources:
                _fail()
            pending_cache_source = source
        if result["contextHash"] != self.context_hash:
            _fail()
        if self.model_calls == 0 and result["contextHash"] is not None:
            _fail()
        candidate = result["candidateRequestId"]
        if candidate is not None:
            if self.stopped:
                _fail()
            record = self._last_model()
            if record is None or record["requestId"] != candidate:
                _fail()
            if record["state"] != "RETURNED" or record["receipt"]["deliveryStatus"] != "COMPLETE":
                _fail()
            action = parse_action(record["receipt"]["text"], self._binding(candidate))
            if action["action"] != "final" or not action["complete"] or action["unresolved"]:
                _fail()
            if action["answer"] != result["finalResponse"]:
                _fail()
            if result["stopReason"] != "FINAL":
                _fail()
            if self.remaining_ms() <= _MIN_REMAINING_MS:
                _fail()
            if result["status"] != "candidate":
                _fail()
        else:
            if result["finalResponse"] != "Unsolved.":
                _fail()
            if result["status"] != "unsolved":
                _fail()
        if result["stopReason"] not in _STOP_REASONS:
            _fail()
        if pending_cache_source is not None:
            self.cached_sources.add(pending_cache_source)
        self.stop_reason = result["stopReason"]
        self.solve_result = copy.deepcopy(result)
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
