"""P2 Host callback class: one reader, strict order, fixed receipts only."""

from __future__ import annotations

import copy
import json

from .p0_probe import ProbeError, _Host
from .p2_host_fixture import OfflineP2Client, _parse_inner, strict_context
from .p2_host_protocol import P2_HOST_VERSION, payload

__all__ = ["P2HostCallback"]

_CATALOG_ID = "node-catalog-1"
_METHOD_ID = "node-method-1"
_MAX_TOKENS = 8192
_RESERVE_MS = 25
_MAX_FRAME_BYTES = 65536
_DELIVERY = ("COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN")


class P2HostCallback(_Host):
    def __init__(self, manifest, session_id, deadline, problem, problem_hash, client, max_calls, max_loads, method_id):
        super().__init__(manifest, session_id, None, deadline)
        self.problem = problem
        self.problem_hash = problem_hash
        self.client = client
        self.max_calls = max_calls
        self.max_loads = max_loads
        self.method_id = method_id
        self.model_calls = 0
        self.method_loads = 0
        self.method_status = "NONE"
        self.context_hash = None
        self.context_method_loaded = False
        self.allowed_asset = None
        self.catalog_entries = None
        self.solve_result = None
        self.seen = set()
        self.history = {}
        self.last_complete = True

    def public_data(self):
        return {"protocolVersion": P2_HOST_VERSION, "sessionId": self.session_id}

    def remaining_ms(self):
        return max(0, min(5000, int(self.remaining() * 1000)))

    def _budget(self):
        return self.remaining() * 1000 > _RESERVE_MS

    def _catalog(self):
        if self.catalog_entries is None:
            from .p2_methods import fixture_catalog

            self.catalog_entries = fixture_catalog().get("entries", [])
        return self.catalog_entries

    def on_request(self, message):
        method = message["method"]
        if self.expected is None or self.expected[1] != "session.solve":
            raise ProbeError("ID_MISMATCH")
        if self.pending is not None:
            raise ProbeError("ID_MISMATCH")
        if method not in ("method.catalog", "method.load", "model.generate"):
            raise ProbeError("UNKNOWN_METHOD")
        if self.max_calls == 0:
            raise ProbeError("FIELD_VALUE")
        params = message["params"]
        payload(self.manifest, method, "params", params, self.session_id)
        if method == "method.catalog":
            if message["id"] != _CATALOG_ID or method in self.seen:
                raise ProbeError("ID_MISMATCH")
            if self.max_loads != 1 or self.method_id is None:
                raise ProbeError("FIELD_VALUE")
            if self.model_calls or not self._budget():
                raise ProbeError("FIELD_VALUE")
            self.seen.add(method)
            entries = self._catalog()
            result = {
                **self.public_data(),
                "remainingMs": self.remaining_ms(),
                "catalog": {"version": "1.1.0", "entries": entries},
            }
            self.callback_done = False
            self.send(self.proc, {"jsonrpc": "2.0", "id": _CATALOG_ID, "result": result}, "method.catalog")
            self.pending_is_callback = True
            return
        if method == "method.load":
            if message["id"] != _METHOD_ID or method in self.seen:
                raise ProbeError("ID_MISMATCH")
            if "method.catalog" not in self.seen or self.method_loads >= self.max_loads:
                raise ProbeError("FIELD_VALUE")
            if self.model_calls > 0:
                raise ProbeError("FIELD_VALUE")
            if not self._budget():
                raise ProbeError("TIMEOUT")
            if params["methodId"] != self.method_id:
                raise ProbeError("ID_MISMATCH")
            if not any(entry.get("id") == self.method_id for entry in self._catalog()):
                raise ProbeError("FIELD_VALUE")
            self.seen.add(method)
            self.method_loads += 1
            from .p2_methods import fixture_load

            loaded = fixture_load(self.method_id)
            asset = loaded.get("asset")
            if loaded.get("status") == "loaded" and isinstance(asset, dict):
                frame = json.dumps(
                    {"jsonrpc": "2.0", "id": _METHOD_ID, "result": {**self.public_data(), "remainingMs": self.remaining_ms(), "methodId": self.method_id, "status": "loaded", "asset": asset}},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
                if len(frame) > _MAX_FRAME_BYTES:
                    loaded = {"status": "integrity_failed", "asset": None}
                    asset = None
            if loaded.get("status") == "loaded" and isinstance(asset, dict):
                self.allowed_asset = asset
                self.method_status = "LOADED"
            else:
                self.method_status = "REFUSED"
            result = {
                **self.public_data(),
                "remainingMs": self.remaining_ms(),
                "methodId": self.method_id,
                "status": loaded.get("status"),
                "asset": asset,
            }
            self.callback_done = False
            self.send(self.proc, {"jsonrpc": "2.0", "id": _METHOD_ID, "result": result}, "method.load")
            self.pending_is_callback = True
            return
        request_id = "model-" + str(self.model_calls + 1)
        if message["id"] != "node-" + request_id:
            raise ProbeError("ID_MISMATCH")
        if self.method_id is not None and self.max_loads == 1:
            if "method.catalog" not in self.seen:
                raise ProbeError("ID_MISMATCH")
            entries = self.catalog_entries
            if entries is None:
                raise ProbeError("ID_MISMATCH")
            if any(entry.get("id") == self.method_id for entry in entries):
                if "method.load" not in self.seen:
                    raise ProbeError("FIELD_VALUE")
        if not self.last_complete:
            raise ProbeError("FIELD_VALUE")
        if self.model_calls >= min(self.max_calls, 3):
            raise ProbeError("FIELD_VALUE")
        if not self._budget():
            raise ProbeError("TIMEOUT")
        if params["requestId"] != request_id or params["problemHash"] != self.problem_hash:
            raise ProbeError("FIELD_VALUE")
        if request_id in self.history:
            raise ProbeError("FIELD_VALUE")
        if params["contractVersion"] != 1 or params["maxTokens"] != _MAX_TOKENS:
            raise ProbeError("FIELD_VALUE")
        messages = params["messages"]
        inner = strict_context(
            messages, params, self.problem, self.session_id, self.problem_hash,
            self.allowed_asset, self.history,
        )
        self.model_calls += 1
        receipt = self.client.chat(messages, temperature=0.2, max_tokens=_MAX_TOKENS)
        if not isinstance(receipt, dict) or receipt.get("deliveryStatus") not in _DELIVERY:
            raise ProbeError("FIELD_VALUE")
        text = receipt.get("text")
        if not isinstance(text, str):
            raise ProbeError("FIELD_VALUE")
        self.history[request_id] = {
            "params": copy.deepcopy(params),
            "receipt": copy.deepcopy(receipt),
        }
        self.context_hash = params["contextHash"]
        self.context_method_loaded = bool(inner["methodAssets"])
        self.last_complete = False
        if receipt["deliveryStatus"] == "COMPLETE":
            try:
                packet = _parse_inner(text)
            except ProbeError:
                packet = None
            if isinstance(packet, dict) and packet.get("deliveryStatus") == "COMPLETE":
                self.last_complete = True
        result = {
            **self.public_data(),
            "requestId": request_id,
            "mode": "MOCK_ONLY",
            "deliveryStatus": receipt["deliveryStatus"],
            "text": text,
            "remainingMs": self.remaining_ms(),
        }
        payload(self.manifest, "model.generate", "result", result, self.session_id)
        self.callback_done = False
        self.send(self.proc, {"jsonrpc": "2.0", "id": "node-" + request_id, "result": result}, "model.generate")
        self.pending_is_callback = True

    def on_result(self, message):
        if self.expected is None or self.pending is not None:
            raise ProbeError("ID_MISMATCH")
        expected_id, method = self.expected
        if message["id"] != expected_id:
            raise ProbeError("ID_MISMATCH")
        result = message["result"]
        payload(self.manifest, method, "result", result, self.session_id)
        if method == "runtime.initialize":
            if result["mode"] != "MOCK_ONLY" or result["targetEnvironment"] != "TARGET_UNVERIFIED":
                raise ProbeError("FIELD_VALUE")
            self.expected = None
            return
        if method == "session.stop":
            if result["stopped"] is not True:
                raise ProbeError("FIELD_VALUE")
            self.stop_acked = True
            self.expected = None
            return
        if method != "session.solve":
            raise ProbeError("ID_MISMATCH")
        if result["candidateVerified"] is not False or result["strictAcceptance"] != "NOT_PERFORMED":
            raise ProbeError("FIELD_VALUE")
        if result["mode"] != "MOCK_ONLY":
            raise ProbeError("FIELD_VALUE")
        if result["modelCalls"] != self.model_calls or result["methodLoads"] != self.method_loads:
            raise ProbeError("FIELD_VALUE")
        if self.model_calls > 0 and result["methodStatus"] == "LOADED" and self.allowed_asset is None:
            raise ProbeError("FIELD_VALUE")
        if self.model_calls > 0 and result["methodStatus"] == "LOADED" and not self.context_method_loaded:
            raise ProbeError("FIELD_VALUE")
        if self.model_calls == 0 and result["status"] != "unsolved":
            raise ProbeError("FIELD_VALUE")
        if self.model_calls > 0 and not self.callback_done:
            raise ProbeError("FIELD_VALUE")
        if self.model_calls == 0:
            context_hash = result["contextHash"]
            if context_hash is not None and (
                not isinstance(context_hash, str) or len(context_hash) != 64
            ):
                raise ProbeError("FIELD_VALUE")
        elif result["contextHash"] != self.context_hash:
            raise ProbeError("FIELD_VALUE")
        if result["status"] == "candidate":
            candidate_id = result["candidateRequestId"]
            if not isinstance(candidate_id, str) or candidate_id not in self.history:
                raise ProbeError("FIELD_VALUE")
            row = self.history[candidate_id]
            row_params = row["params"]
            row_receipt = row["receipt"]
            if row_receipt.get("deliveryStatus") != "COMPLETE":
                raise ProbeError("FIELD_VALUE")
            try:
                packet = _parse_inner(row_receipt["text"])
            except ProbeError:
                raise ProbeError("FIELD_VALUE")
            if not isinstance(packet, dict) or packet.get("deliveryStatus") != "COMPLETE":
                raise ProbeError("FIELD_VALUE")
            proposal = packet.get("candidateProposal")
            if not isinstance(proposal, str) or not proposal.strip():
                raise ProbeError("FIELD_VALUE")
            if proposal != result["finalResponse"]:
                raise ProbeError("FIELD_VALUE")
            if packet.get("sourceRequestId") != candidate_id:
                raise ProbeError("FIELD_VALUE")
            if packet.get("sessionId") != self.session_id or packet.get("problemHash") != self.problem_hash:
                raise ProbeError("FIELD_VALUE")
            if packet.get("contractVersion") != 1:
                raise ProbeError("FIELD_VALUE")
            if packet.get("taskId") != row_params.get("taskId") or packet.get("scopeId") != row_params.get("scopeId"):
                raise ProbeError("FIELD_VALUE")
            try:
                inner = _parse_inner(row_params["messages"][1]["content"])
            except (ProbeError, KeyError, IndexError, TypeError):
                raise ProbeError("FIELD_VALUE")
            if not isinstance(inner, dict):
                raise ProbeError("FIELD_VALUE")
            task = inner.get("task")
            obligations = inner.get("obligations")
            if not isinstance(task, dict) or not isinstance(obligations, list):
                raise ProbeError("FIELD_VALUE")
            # The Host does not re-derive candidate eligibility: the Node
            # control side is the single source of that decision. Only the
            # structural presence of the task's own obligation row is checked.
            if not any(
                isinstance(entry, dict)
                and entry.get("obligationId") == task.get("obligationId")
                for entry in obligations
            ):
                raise ProbeError("FIELD_VALUE")
            if result["artifactCount"] < 1 or result["artifactCount"] > self.model_calls:
                raise ProbeError("FIELD_VALUE")
        elif result["candidateRequestId"] is not None:
            raise ProbeError("FIELD_VALUE")
        self.solve_result = result
        self.expected = None
