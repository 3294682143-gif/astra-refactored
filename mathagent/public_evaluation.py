"""Explicit local public-SDK evaluation facility, NOT the official Agent entry.

The pinned SDK gets an observed transport before it can wrap exceptions. Every
logical call shares the durable coordinator; opaque failures retain their lease.
No old run, result or judge is modified by this module.
"""

import copy
import hashlib
import importlib.util
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from .eval_dispatch import not_attempted
from .evaluation_policy import EvaluationPolicy
from .experiments import ExperimentConfig
from .finalization import UNSOLVED
from .platform_resources import platform_python
from .runtime.config import fingerprint
from .runtime.http_observer import observe_json_post
from .runtime.platform_coordinator import PlatformPolicy
from .runtime.protocol import parse_response
from .runtime.public_coordination import current_public_lease
from .runtime.response import public_choice
from .shared_entry import solve_shared_public

PUBLIC_SDK_SHA256 = "1da165e26a13651f4a812be11a836edd040912fc8ba0691e6746fb5a3277f737"


def check_sdk(path):
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != PUBLIC_SDK_SHA256:
        raise ValueError("public SDK does not match the reviewed source snapshot")


class PublicEvalClient:
    def __init__(
        self,
        *,
        sdk_path,
        coord,
        item,
        prior,
        stop,
        model_id,
        connect_timeout=10,
        read_timeout=300,
        evaluation_policy=None,
        protocol="l3",
    ):
        check_sdk(sdk_path)
        self.coord, self.item, self.prior, self.stop = coord, item, prior, stop
        self.model = model_id
        if protocol not in {"l3", "r4"}:
            raise ValueError("explicit evaluation delivery protocol required")
        self.protocol = protocol
        self.evaluation_policy = evaluation_policy or EvaluationPolicy()
        if not isinstance(self.evaluation_policy, EvaluationPolicy):
            raise TypeError("explicit EvaluationPolicy required")
        self.consecutive_delivery_failures = 0
        self.stop_reason = ""
        self.connect_timeout, self.read_timeout = connect_timeout, read_timeout
        self.local, self.lock, self.records = threading.local(), threading.RLock(), {}
        spec = importlib.util.spec_from_file_location("observed_public_sdk", sdk_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # Only this isolated, source-pinned SDK module is wired. Never monkeypatch
        # requests globally, introspect client secrets, or alter the submitted Agent.
        module.requests = SimpleNamespace(post=self._post)
        self.sdk_type = module.InternChatClient
        if self.sdk_type(retry=1).model != model_id:
            raise ValueError("public SDK model differs from frozen model identity")
        with coord.transaction() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS public_eval_transport (request TEXT PRIMARY KEY, item TEXT, record TEXT)"
            )

    def _check(self):
        self.prior.validate()
        if self.stop.is_set() or self.coord.clock() >= self.item.deadline:
            raise RuntimeError("local_evaluation_dispatch_stopped")

    def _stop(self, reason):
        with self.lock:
            self.stop_reason = self.stop_reason or reason
            self.stop.set()
            self.coord.stop_dispatch(self.stop_reason)

    def _record_delivery(self, message, record):
        if (
            not isinstance(message, dict)
            or message.get("role", "assistant") != "assistant"
            or message.get("tool_calls")
            or not isinstance(message.get("content"), str)
            or len(message["content"]) > PlatformPolicy().max_response_chars
        ):
            self._stop("unusable_public_response")
            raise ValueError("unusable_public_response")
        parser = parse_response
        if self.protocol == "r4":
            from .runtime.r4_protocol import parse_r4_delivery

            parser = parse_r4_delivery
        parsed = parser(
            message["content"], finish_reason=record["finish_reason"], prefill=False
        )
        category = (
            "content_filter"
            if record["finish_reason"] == "content_filter"
            else "truncated"
            if record["finish_reason"] == "length"
            else "protocol_invalid"
            if not parsed.valid
            else "complete"
            if parsed.closed
            else "task_incomplete"
        )
        with self.lock:
            self.consecutive_delivery_failures = (
                self.consecutive_delivery_failures + 1
                if category in {"truncated", "protocol_invalid"}
                else 0
            )
            record.update(
                delivery_category=category,
                protocol=self.protocol,
                semantic_protocol_assessed=self.protocol == "l3",
                protocol_valid=parsed.valid,
                delivery_complete=parsed.closed,
                consecutive_delivery_failures=self.consecutive_delivery_failures,
            )
            reason = self.evaluation_policy.delivery_stop_reason(
                category=category, consecutive=self.consecutive_delivery_failures
            )
            if reason:
                self._stop(reason)

    def _post(self, url, *, headers, data, timeout):
        self._check()
        payload = json.loads(data)
        if (
            set(payload)
            != {"model", "messages", "temperature", "max_tokens", "thinking_mode"}
            or payload["model"] != self.model
            or payload["thinking_mode"] is not False
            or payload["temperature"] != 0.2
            or payload["max_tokens"] != self.coord.limits.max_tokens
        ):
            raise ValueError("frozen_public_evaluation_request_mismatch")
        # The exact SDK has retry=1. A second HTTP attempt is refused even if a
        # future SDK regression tried it, rather than hiding it inside one lease.
        if self.local.record["http_attempts"]:
            raise RuntimeError("second_transport_attempt_forbidden")
        remaining = self.local.lease.deadline - self.coord.clock()
        if remaining <= 0:
            raise RuntimeError("local_predispatch_deadline")
        with self.lock:
            self.records[self.local.lease.id] = copy.deepcopy(self.local.record) | {
                "http_attempts": 1,
                "stage": "http_dispatch",
                "remote_usage_unknown": True,
            }
        response = observe_json_post(
            url,
            headers=headers,
            data=data,
            timeout=(
                min(self.connect_timeout, remaining),
                min(self.read_timeout, remaining),
            ),
            record=self.local.record,
        )
        # Keep the already-validated public envelope in THIS request's worker,
        # not in the persisted diagnostics or a shared last-response attribute.
        self.local.response = copy.deepcopy(response.json())
        return response

    def chat(self, messages, temperature=0.2, max_tokens=8192, *, thinking_mode=False):
        lease = current_public_lease(self.coord, self.item)
        borrowed = lease is not None
        if lease is None:
            self._check()
            lease = self.coord.acquire(self.item, "public_sdk_call", final=True)
        record = {
            "http_attempts": 0,
            "confirmed_ended": False,
            "usage": None,
            "remote_usage_unknown": False,
            "error_type": None,
            "stage": "local_admission",
        }
        self.local.record, self.local.lease = record, lease
        self.local.response = None
        with self.lock:
            self.records[lease.id] = copy.deepcopy(record)
        try:
            if thinking_mode is not False:
                raise ValueError("evaluation non-thinking contract")
            self._check()
            if not borrowed and not self.coord.may_dispatch(lease):
                raise RuntimeError("public_predispatch_stopped")
            sdk = self.sdk_type(retry=1)
            if sdk.model != self.model:
                raise ValueError("public SDK model changed")
            result = sdk.chat(messages, temperature, max_tokens, thinking_mode=False)
            if not record["confirmed_ended"]:
                raise RuntimeError("remote_end_unconfirmed")
            choice = public_choice(self.local.response)
            if choice is None:
                raise RuntimeError("missing_current_public_choice")
            message = (
                {"role": "assistant", "content": result}
                if isinstance(result, str)
                else copy.deepcopy(result)
            )
            self._record_delivery(message, record)
            delivery = {"message": message, "finish_reason": record["finish_reason"]}
            if "index" in choice:
                delivery["index"] = choice["index"]
            envelope = {"choices": [delivery]}
            if record["usage"] is not None:
                envelope["usage"] = copy.deepcopy(record["usage"])
            return envelope
        except BaseException as exc:  # noqa: BLE001 - shared stop and settlement boundary
            record["error_type"] = type(exc).__name__[:64]
            self._stop("public_client_failure_or_unknown_lifecycle")
            raise RuntimeError(
                "public_evaluation_call_failed_see_redacted_transport"
            ) from None
        finally:
            not_sent = record["http_attempts"] == 0
            ended = record["confirmed_ended"] or not_sent
            with self.lock:
                self.records[lease.id] = copy.deepcopy(record)
            self.coord.finish(
                lease,
                status="FAILED" if record["error_type"] else "FINISHED",
                detail="not_dispatched"
                if not_sent
                else "public_terminal"
                if ended
                else "remote_state_unknown",
                confirmed_ended=ended,
            )
            with self.coord.transaction() as db:
                db.execute(
                    "INSERT INTO public_eval_transport VALUES(?,?,?)",
                    (lease.id, self.item.id, json.dumps(record, allow_nan=False)),
                )

    def diagnostics(self):
        with self.lock:
            records = copy.deepcopy(list(self.records.values()))
        with self.coord.transaction() as db:
            active = db.execute(
                "SELECT COUNT(*) FROM requests WHERE item=? AND status='IN_FLIGHT'",
                (self.item.id,),
            ).fetchone()[0]
        return {
            "attempted": any(r["http_attempts"] for r in records),
            "provider_success": bool(records)
            and all(r.get("finish_reason") in {"stop", "end_turn"} for r in records)
            and not active
            and not any(r["error_type"] for r in records),
            "not_attempted_due_to_guard": not any(r["http_attempts"] for r in records),
            "remote_usage_unknown": bool(active)
            or any(r.get("remote_usage_unknown") for r in records),
            "retained_remote_unknown": active,
            "incomplete_delivery_calls": sum(
                r.get("finish_reason") in {"length", "content_filter"} for r in records
            ),
            "had_truncation": any(r.get("finish_reason") == "length" for r in records),
            "content_filtered_calls": sum(
                r.get("finish_reason") == "content_filter" for r in records
            ),
            "protocol_failure_calls": sum(
                r.get("delivery_category") == "protocol_invalid" for r in records
            ),
            "all_deliveries_complete": bool(records)
            and not active
            and all(r.get("delivery_complete", False) for r in records),
            "bootstrap_succeeded": any(
                r.get("protocol_valid", False)
                and r.get("finish_reason") in {"stop", "end_turn"}
                for r in records
            ),
            "run_stop_reason": self.stop_reason,
            "transport": records,
        }


def solve_public_item(
    row,
    *,
    sdk_path,
    coord,
    prior,
    stop,
    model_id,
    connect_timeout=10,
    read_timeout=300,
    python_sandbox_profile=None,
    expected_python_identity=None,
    evaluation_policy=None,
    experiment=None,
    known_total=None,
    diagnostic_sink=None,
):
    if stop.is_set():
        return not_attempted(row)
    item = client = None
    result = {"final_response": UNSOLVED}
    try:
        prior.validate()
        item, _ = coord.register_item(
            str(row["idx"]), fingerprint(row["problem"]), started=time.monotonic()
        )
        coord.admit_item(item)
        if stop.is_set():
            return not_attempted(row)
        client = PublicEvalClient(
            sdk_path=sdk_path,
            coord=coord,
            item=item,
            prior=prior,
            stop=stop,
            model_id=model_id,
            connect_timeout=connect_timeout,
            read_timeout=read_timeout,
            evaluation_policy=evaluation_policy,
        )
        experiment = experiment or ExperimentConfig()
        sandbox = (
            platform_python(python_sandbox_profile)
            if experiment.enabled("python")
            else None
        )
        identity = sandbox.identity if sandbox else None
        if identity != expected_python_identity:
            raise ValueError("platform Python configuration changed after run freeze")
        result = solve_shared_public(
            row["problem"],
            client=client,
            authority=coord,
            item=item,
            known_total=known_total,
            experiment=experiment,
            python_sandbox=sandbox,
            diagnostic_sink=diagnostic_sink,
        )
    except Exception as exc:  # noqa: BLE001 - local evaluation reports errors and stops dispatch
        stop.set()
        result["error_type"] = type(exc).__name__[:64]
    finally:
        if item is not None:
            coord.close_item(item, result)
    execution = client.diagnostics() if client else not_attempted(row)["execution"]
    metrics = coord.metrics()
    reason = execution.get("run_stop_reason", "")
    if not reason and (result.get("error_type") or stop.is_set()):
        reason = "runtime_or_shared_run_guard_stopped"
    if not reason and execution.get("retained_remote_unknown", 0):
        reason = "unknown_remote_lifecycle"
    if not reason and coord.clock() >= metrics["deadline"]:
        reason = "run_deadline"
    if not reason and metrics["calls"] >= coord.limits.logical_requests:
        reason = "logical_budget_exhausted"
    execution.update(
        run_can_continue=not reason,
        run_stop_reason=reason,
        item_recovery=(
            "candidate_returned_after_delivery_failure"
            if result["final_response"] != UNSOLVED
            else "no_candidate_after_delivery_failure"
        )
        if execution.get("incomplete_delivery_calls", 0)
        or execution.get("protocol_failure_calls", 0)
        else "not_needed",
    )
    if reason:
        stop.set()
    return {
        "idx": row["idx"],
        **result,
        "execution": execution,
        "status": "candidate" if result["final_response"] != UNSOLVED else "unsolved",
    }
