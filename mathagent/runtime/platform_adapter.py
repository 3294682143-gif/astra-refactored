"""Non-streaming public baseline contract, without private client inspection.

Reference: InternLM/Challenge-Cup-2026@43be244a, llm_client.py. Normal returns
are strings, native tool requests are assistant-message dictionaries. That
interface drops finish_reason/usage; they cannot be reconstructed or fabricated.
"""

from __future__ import annotations

import inspect
import threading
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict

from .adapter import Generation
from .coordinator import AdmissionError
from .protocol import messages, parse_response
from .public_coordination import public_call_binding
from .response import public_choice, terminal_reason, TerminalDeliveryError
from .adapter import RequestNotDispatched, ProviderRejected, RateLimited


class PublicResponseError(Exception):
    pass


def public_delivery(response, max_chars):
    finish, usage, public_return = None, {}, False
    if isinstance(response, str):
        text, public_return = response, True
    elif isinstance(response, dict):
        if response.get("error"):
            raise PublicResponseError("public_response_error")
        if "choices" in response:
            choice = public_choice(response)
            if choice is None:
                raise PublicResponseError("missing_public_choice")
            finish = terminal_reason(choice)
            message = choice.get("message")
            if not isinstance(message, dict):
                raise PublicResponseError("nonstream_message_required")
            # A raw envelope with absent termination data is not the documented
            # lossy string-return contract and is not assumed complete.
        else:
            message = response
            finish = terminal_reason(message)
            public_return = "finish_reason" not in message
        if message.get("role", "assistant") != "assistant":
            raise PublicResponseError("unexpected_message_role")
        if message.get("tool_calls"):
            raise PublicResponseError("native_tool_calls_not_executed")
        text = message.get("content")
        if isinstance(response.get("usage"), dict):
            usage = {
                k: response["usage"][k]
                for k in ("prompt_tokens", "completion_tokens", "total_tokens")
                if type(response["usage"].get(k)) is int and response["usage"][k] >= 0
            }
    else:
        raise PublicResponseError("unsupported_public_return_type")
    if not isinstance(text, str):
        raise PublicResponseError("public_text_required")
    if len(text) > max_chars:
        raise PublicResponseError("public_text_resource_limit")
    return text, finish, usage, public_return


class PlatformAdapter:
    def __init__(self, client, coordinator, *, diagnostic_sink=None):
        if not callable(getattr(client, "chat", None)):
            raise TypeError("injected public chat interface required")
        self.client, self.coordinator = client, coordinator
        self.diagnostic_sink = diagnostic_sink
        self._work_metadata = ContextVar('rc_work_metadata', default=None)
        # An explicit named public parameter is the binding contract. **kwargs
        # alone is not evidence. The pinned public baseline exercises this exact
        # parameter; three-argument clients keep working with a visible limitation.
        try:
            parameter = inspect.signature(
                client.chat, follow_wrapped=False
            ).parameters.get("thinking_mode")
        except (TypeError, ValueError):
            parameter = None
        supported = parameter is not None and parameter.kind in {
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        }
        self.request_options = {"thinking_mode": False} if supported else {}
        self.public_contract = {
            "thinking_mode_overridden": supported,
            "non_thinking_requested": supported,
            "thinking_contract": "named_public_parameter"
            if supported
            else "not_exposed_by_client",
        }

    @contextmanager
    def work_context(self, metadata):
        token = self._work_metadata.set(dict(metadata))
        try:
            yield
        finally:
            self._work_metadata.reset(token)

    def generate(
        self,
        item,
        *,
        goal,
        kind,
        problem,
        verified=(),
        provisional=(),
        review_input="",
        skill="",
        deadline=None,
        once=None,
        final=False,
        priority=10,
    ):
        coord = self.coordinator
        args = {
            "problem": problem,
            "goal": goal,
            "kind": kind,
            "verified": verified,
            "provisional": provisional,
            "review_input": review_input,
            "skill": skill,
            "max_chars": coord.policy.max_input_chars,
        }
        try:
            packet = messages(**args)
        except ValueError:
            if not skill:
                raise
            packet = messages(**(args | {"skill": ""}))
        if packet[-1] != {"role": "assistant", "content": "STATUS: "}:
            raise ValueError("unexpected internal prefill contract")
        packet = packet[:-1]  # Standard complete messages; no unconfirmed prefill.
        return self.invoke_packet(
            item,
            packet=packet,
            kind=kind,
            deadline=deadline,
            once=once,
            final=final,
            priority=priority,
        )

    def invoke_packet(
        self,
        item,
        *,
        packet,
        kind,
        deadline=None,
        once=None,
        final=False,
        priority=10,
        protocol="l3",
    ):
        """Complete-message transport; protocol interpretation is caller-owned.

        R4 callers retain ACTION parsing and never enter the new Controller.
        """
        coord = self.coordinator
        if protocol not in {"l3", "r4", "lite"}:
            raise ValueError("explicit delivery protocol required")
        if (
            not isinstance(packet, list)
            or not packet
            or not isinstance(packet[-1], dict)
            or packet[-1].get("role") != "user"
        ):
            raise ValueError("public complete messages require a final user message")
        if any(
            not isinstance(row, dict)
            or set(row) != {"role", "content"}
            or row["role"] not in {"system", "user", "assistant"}
            or not isinstance(row["content"], str)
            for row in packet
        ):
            raise ValueError("unsupported public message shape")
        if sum(len(row["content"]) for row in packet) > coord.policy.max_input_chars:
            raise ValueError("complete public context exceeds capacity")
        intent = {
            "kind": kind,
            "deadline": deadline,
            "once": once,
            "final": final,
            "priority": priority,
            "protocol": protocol,
        }
        request_parameters = {
            "temperature": 0.2,
            "max_tokens": coord.limits.max_tokens,
            **self.request_options,
        }
        admission_started = coord.clock()
        try:
            lease = coord.acquire(
                item, kind, deadline=deadline, once=once, final=final, priority=priority
            )
        except AdmissionError as exc:
            if self.diagnostic_sink is not None:
                self._record_diagnostic(
                    {
                        "request_id": "not-admitted-" + uuid.uuid4().hex,
                        "item_id": item.id,
                        "decision": "refused",
                        "refusal": type(exc).__name__,
                        "kind": kind,
                        "messages": packet,
                        "intent": intent,
                        "request_parameters": request_parameters,
                        "started_monotonic": coord.clock(),
                        "protocol": protocol,
                    }
                )
            raise
        completed = threading.Event()
        attach = getattr(coord, 'attach_work_context', None)
        if callable(attach):
            attach(lease, self._work_metadata.get() or {})
        started = coord.clock()
        captured = {
            "text": "",
            "finish": None,
            "usage": {},
            "error": None,
            "public_return": False,
        }

        def worker():
            outcome = "RETURNED"
            try:
                if not coord.may_dispatch(lease):
                    outcome = "NOT_DISPATCHED"
                    captured["error"] = "not_dispatched"
                    return
                # Select the documented path before calling. Never TypeError/drop-
                # kwargs/retry, never set model, stream, n, timeout or cancellation.
                with public_call_binding(coord, lease):
                    response = self.client.chat(
                        messages=packet,
                        temperature=0.2,
                        max_tokens=coord.limits.max_tokens,
                        **self.request_options,
                    )
                try:
                    # A valid terminal receipt survives an unusable body, but
                    # invalid choice identity is still a response-schema error.
                    if isinstance(response, dict) and not response.get("error"):
                        choice = (
                            public_choice(response)
                            if "choices" in response
                            else response
                        )
                        if choice is not None:
                            captured["finish"] = terminal_reason(choice)
                    text, finish, usage, public_return = public_delivery(
                        response, coord.policy.max_response_chars
                    )
                except (TypeError, ValueError):
                    raise PublicResponseError(
                        "invalid_public_response_schema"
                    ) from None
                captured.update(
                    text=text, finish=finish, usage=usage, public_return=public_return
                )
            except TerminalDeliveryError as exc:
                captured['error'] = 'terminal_delivery_invalid'
                captured['finish'] = exc.reason
                outcome = 'INVALID_PUBLIC_RESPONSE'
            except RequestNotDispatched:
                captured['error'] = 'not_dispatched'
                outcome = 'NOT_DISPATCHED'
            except (ProviderRejected, RateLimited) as exc:
                captured['error'] = type(exc).__name__
                outcome = 'CONFIRMED_REJECTION'
            except PublicResponseError as exc:
                captured["error"] = str(exc)  # Only local fixed codes, never SDK text.
                outcome = "INVALID_PUBLIC_RESPONSE"
            except BaseException as exc:  # noqa: BLE001 - worker must settle before returning
                # Worker boundary only. The platform SDK may have retried internally;
                # its exception text, private fields and attempt counts are not read.
                captured["error"] = "public_client_" + type(exc).__name__[:64]
                outcome = (
                    "PUBLIC_CLIENT_CONFIGURATION_ERROR"
                    if isinstance(exc, TypeError)
                    else "PUBLIC_CLIENT_ERROR"
                )
            finally:
                try:
                    coord.settle_public_call(
                        lease,
                        outcome=outcome,
                        finish_reason=captured["finish"],
                        public_return=captured["public_return"],
                    )
                finally:
                    completed.set()

        thread = threading.Thread(
            target=worker, name="platform-public-call", daemon=True
        )
        try:
            thread.start()
        except RuntimeError:
            coord.settle_public_call(lease, outcome="NOT_DISPATCHED")
            raise
        # Soft role/phase wait ends independently of its original live lease.
        if (
            not completed.wait(max(0, lease.deadline - coord.clock()))
            and coord.clock() >= item.deadline
        ):
            coord.stop_dispatch("item_generation_deadline")
        done = completed.is_set()
        late = coord.clock() >= lease.deadline
        error = (
            captured["error"] if done else "public_call_outstanding_at_local_deadline"
        )
        text = captured["text"] if done else ""
        finish = captured["finish"] if done else None
        public_return = bool(done and captured["public_return"])
        parser = parse_response
        if protocol == "r4":
            from .r4_protocol import parse_r4_delivery

            parser = parse_r4_delivery
        elif protocol == "lite":
            from ..lite.protocol import parse_lite_delivery

            parser = parse_lite_delivery
        parsed = parser(
            text,
            finish_reason=finish,
            prefill=False,
            transport_complete=done and not error and not late,
            complete_public_return=public_return,
        )
        transport = {
            "runtime_mode": "platform",
            "local_method_returned": done,
            "delivery_basis": "baseline_public_return"
            if public_return
            else "explicit_metadata_or_incomplete",
            "finish_metadata_available": finish is not None,
            "prefill_sent": False,
            "remote_cancellation_confirmed": False,
            "skill_included": any(
                row["role"] == "user"
                and "\n\nRELEVANT_SKILL:\n" in row["content"]
                and row["content"]
                .rsplit("\n\nRELEVANT_SKILL:\n", 1)[1]
                .split("\n\nACTIVE_WORK_UNIT_KIND:\n", 1)[0]
                not in {"", "NONE"}
                for row in packet
            ),
            "stream_requested": False,
            "request_started_monotonic": started,
            "admission_wait_seconds": max(0.0, started - admission_started),
        }
        result = Generation(
            lease.id,
            parsed,
            finish,
            error,
            late,
            dict(captured["usage"]) if done else {},
            transport,
        )
        self._record_diagnostic(
            {
                "request_id": lease.id,
                "item_id": item.id,
                "kind": kind,
                "messages": packet,
                "decision": "admitted",
                "intent": intent,
                "request_parameters": request_parameters,
                "visible_response": text,
                "finish_reason": finish,
                "usage": result.usage,
                "public_return": public_return,
                "error": error,
                "late": late,
                "protocol": protocol,
                "started_monotonic": started,
                "elapsed_seconds": max(0, coord.clock() - started),
                "returned_monotonic": coord.clock(),
                "lease": asdict(lease),
                "generation": asdict(result),
            }
        )
        return result

    def _record_diagnostic(self, row):
        if self.diagnostic_sink is not None:
            try:
                self.diagnostic_sink(row)
            except (OSError, ValueError, TypeError):
                self.coordinator.stop_dispatch("local_diagnostic_persistence_failed")
