from __future__ import annotations

import threading
from dataclasses import asdict, dataclass, field
from typing import Any

from .config import ClientCapabilities
from .coordinator import GlobalCoordinator, Item
from .protocol import ParsedResponse, messages, parse_response
from .request_observer import RequestObserverThread, observing
from .response import TerminalDeliveryError, public_choice, terminal_reason
from .transport import TransportResponse, UnconfirmedTransportFailure, safe_transport


class ConfirmedCancellation(Exception):
    """Public integration seam: client guarantees the generation has ended."""


class RequestNotDispatched(Exception):
    """The local client/adapter proves no provider request was sent (no refund)."""


class RateLimited(Exception):
    """A confirmed rejected request; retry-after must come from public response data."""

    def __init__(self, retry_after: float):
        self.retry_after = retry_after


class ProviderRejected(Exception):
    """A complete HTTP rejection, not an ambiguous timeout or transport exception."""

    def __init__(self, status_code):
        if (
            type(status_code) is not int
            or not 400 <= status_code < 500
            or status_code == 408
        ):
            raise ValueError("not a confirmed provider rejection")
        self.status_code = status_code
        super().__init__(f"provider_rejected_http_{status_code}")


@dataclass(frozen=True)
class Generation:
    request_id: str
    parsed: ParsedResponse
    finish_reason: str | None
    error: str | None
    late: bool
    usage: dict
    transport: dict = field(default_factory=dict)


class S2Adapter:
    def __init__(
        self,
        client: Any,
        coordinator: GlobalCoordinator,
        capabilities: ClientCapabilities,
        *,
        diagnostic=False,
        diagnostic_sink=None,
        lifecycle_sink=None,
        request_profile="fixed_8192",
    ):
        capabilities.validate(diagnostic=diagnostic)
        from ..request_policy import PROFILES

        if request_profile not in PROFILES:
            raise ValueError("unsupported request profile")
        self.request_profile = request_profile
        coordinator.bind_request_profile(request_profile)
        self.diagnostic = diagnostic
        self.diagnostic_sink, self.lifecycle_sink = diagnostic_sink, lifecycle_sink
        if not callable(getattr(client, "chat", None)):
            raise TypeError("public chat interface required")
        self.client, self.coordinator, self.capabilities = (
            client,
            coordinator,
            capabilities,
        )

    def generate(
        self,
        item: Item,
        *,
        goal: str,
        kind: str,
        problem: str,
        verified=(),
        provisional=(),
        review_input="",
        skill="",
        deadline=None,
        once=None,
        final=False,
        priority=10,
        output_class="full",
        purpose=None,
    ) -> Generation:
        if purpose is not None and (
            not isinstance(purpose, str) or not 0 < len(purpose) <= 64
        ):
            raise ValueError("invalid task purpose")
        if self.diagnostic and (kind != "capability_probe" or once != "probe"):
            raise ValueError(
                "unconfirmed cancellation is allowed only for the explicit one-shot diagnostic"
            )
        packet_args = {
            "problem": problem,
            "goal": goal,
            "kind": kind,
            "verified": verified,
            "provisional": provisional,
            "review_input": review_input,
            "skill": skill,
            "max_chars": self.capabilities.max_input_chars,
        }
        effective_skill = skill
        try:
            packet = messages(**packet_args)
        except ValueError:
            if not skill:
                raise
            # Optional retrieval may be omitted; required math premises are never cut.
            packet = messages(**(packet_args | {"skill": ""}))
            effective_skill = ""
        coord = self.coordinator
        from ..request_policy import effective_max_tokens

        maximum = effective_max_tokens(
            self.request_profile, output_class, coord.limits.max_tokens
        )
        rate_options = {}
        if getattr(coord, "provider_rate_policy", None) is not None:
            from .provider_rate import token_reservation

            rate_options["reserved_tokens"] = token_reservation(packet, maximum)
        admission_started = coord.clock()
        lease = coord.acquire(
            item,
            kind,
            deadline=deadline,
            once=once,
            final=final,
            priority=priority,
            **rate_options,
        )
        started = coord.clock()
        intent = {
            "kind": kind,
            "deadline": deadline,
            "once": once,
            "final": final,
            "priority": priority,
        }
        if purpose is not None:
            intent["task_purpose"] = purpose
        if self.request_profile != "fixed_8192":
            intent.update(
                request_profile=self.request_profile,
                output_class=output_class,
                effective_max_tokens=maximum,
            )
        observed_transport = {}

        def lifecycle(row):
            nonlocal observed_transport
            if row.get("event") == "http_dispatch":
                coord.record_request_fact(
                    lease, "transport_attempt:" + str(row.get("attempt", 1)), 1
                )
            if "transport" in row:
                # Request-local immutable snapshots, including observations made
                # before chat() returns. Never use the client's shared last_* state.
                observed_transport = safe_transport(row["transport"])
            if self.lifecycle_sink is not None:
                try:
                    self.lifecycle_sink(
                        dict(
                            request_id=lease.id,
                            item_id=item.id,
                            kind=kind,
                            intent=intent,
                            **row,
                        )
                    )
                except (OSError, ValueError, TypeError):
                    coord.stop_dispatch("local_diagnostic_persistence_failed")
                    raise

        lifecycle(
            {
                "event": "admitted",
                "lease": asdict(lease),
                "messages": packet,
                "at": started,
            }
        )
        cancellation = threading.Event()
        completed = threading.Event()
        captured = {
            "text": "",
            "reason": None,
            "usage": {},
            "error": None,
            "ended": False,
            "transport": {},
        }

        def worker():
            response = None
            try:
                # Admission is counted before dispatch. A delayed local worker may
                # not start a new generation after cancellation/the original deadline.
                if cancellation.is_set() or not coord.may_dispatch(lease):
                    raise RequestNotDispatched()
                kwargs = {
                    "messages": packet,
                    "temperature": 0.2,
                    "max_tokens": maximum,
                    "stream": True,
                    self.capabilities.thinking_parameter: False,
                    # Soft deadlines bound the caller and mathematical adoption,
                    # not observation of an already dispatched remote generation.
                    # Item.deadline is already bounded by the original run end.
                    self.capabilities.timeout_parameter: max(
                        0, item.deadline - coord.clock()
                    ),
                    self.capabilities.cancellation_parameter: cancellation,
                }
                with observing(lifecycle):
                    coord.record_request_fact(lease, "dispatch_attempted", maximum)
                    response = self.client.chat(**kwargs)
                if isinstance(response, TransportResponse):
                    captured["transport"] = safe_transport(response.transport)
                chunks = [response] if isinstance(response, dict) else response
                observed_response = False
                for chunk in chunks:
                    if not observed_response:
                        coord.record_request_fact(
                            lease, "provider_response_observed", 1
                        )
                        observed_response = True
                    choice = public_choice(chunk)
                    if choice is not None:
                        reason = terminal_reason(choice)
                        if reason is not None:
                            # Remote lifecycle and mathematical/format completeness
                            # are separate. Later decoding errors cannot undo an end.
                            captured.update(reason=reason, ended=True)
                        delta = choice.get("delta") or choice.get("message") or {}
                        content = delta.get("content")
                        if content is None:
                            content = ""
                        if not isinstance(content, str):
                            raise TypeError("content must be text")
                        captured["text"] += content
                    usage = chunk.get("usage") or {}
                    captured["usage"].update(
                        {
                            k: usage[k]
                            for k in (
                                "prompt_tokens",
                                "completion_tokens",
                                "total_tokens",
                            )
                            if type(usage.get(k)) is int and usage[k] >= 0
                        }
                    )
                    if (
                        captured["ended"]
                        and self.capabilities.terminal_response_confirms_end
                    ):
                        # This explicitly confirmed terminal contract, not socket
                        # EOF or close(), proves that generation ended. Do not wait
                        # for a potentially stuck iterator/usage-only tail.
                        break
                if not captured["ended"]:
                    captured["error"] = "unconfirmed_stream_end"
            except RequestNotDispatched:
                captured.update(ended=True, error="not_dispatched")
            except TerminalDeliveryError as exc:
                captured["transport"] = safe_transport(exc.transport)
                captured.update(
                    ended=True, reason=exc.reason, error="terminal_delivery_invalid"
                )
            except ConfirmedCancellation:
                captured.update(ended=True, error="cancelled")
            except UnconfirmedTransportFailure as exc:
                captured.update(
                    error=exc.error_type, transport=safe_transport(exc.transport)
                )
                if (
                    exc.transport.get("failure_code")
                    == "provider_stream_error_unconfirmed"
                ):
                    coord.stop_dispatch("UNCLASSIFIED_PROVIDER_ERROR")
            except ProviderRejected as exc:
                coord.record_request_fact(lease, "provider_response_observed", 1)
                captured["transport"] = safe_transport(getattr(exc, "transport", {}))
                captured.update(
                    ended=True, error=f"provider_rejected_http_{exc.status_code}"
                )
                if exc.status_code in {400, 401, 403, 404, 422}:
                    coord.stop_dispatch("CONFIGURATION_ERROR")
            except RateLimited as exc:
                coord.record_request_fact(lease, "provider_response_observed", 1)
                captured["transport"] = safe_transport(getattr(exc, "transport", {}))
                captured.update(ended=True, error="rate_limited")
                coord.cooldown(exc.retry_after)
            except Exception as exc:  # noqa: BLE001 - unknown provider errors retain the live permit
                # Arbitrary client exceptions may follow an ambiguous dispatch.
                # Do not store exception text, credentials, or claim remote termination.
                captured["error"] = type(exc).__name__
            finally:
                try:
                    coord.finish(
                        lease,
                        status="FAILED" if captured["error"] else "FINISHED",
                        detail=captured["error"] or "terminal response",
                        confirmed_ended=captured["ended"],
                        local_worker_ended=True,
                    )
                except Exception as exc:  # noqa: BLE001 - settlement failure is not successful delivery
                    captured["error"] = "settlement_" + type(exc).__name__
                finally:
                    try:
                        lifecycle(
                            {
                                "event": "request_worker_finished",
                                "at": coord.clock(),
                                "confirmed_ended": captured["ended"],
                                "error": captured["error"],
                                "finish_reason": captured["reason"],
                                "visible_response": captured["text"],
                                "usage": captured["usage"],
                                "late": coord.clock() >= lease.deadline,
                                "transport": dict(captured["transport"]),
                            }
                        )
                    finally:
                        completed.set()
                # Best-effort local stream disposal is never evidence of remote
                # cancellation and must not delay the bounded caller return.
                if not isinstance(response, dict) and callable(
                    getattr(response, "close", None)
                ):
                    try:
                        response.close()
                    except Exception:  # noqa: BLE001, S110 - cleanup cannot certify termination; no provider text
                        pass

        thread = RequestObserverThread(
            target=worker, run_id=coord.run_id, completed=completed
        )
        if coord.clock() >= lease.deadline:
            worker()  # Provably not dispatched; no thread race or hard-grace wait.
        else:
            thread.start()
        timeout = max(0, lease.deadline - coord.clock())
        # No hard-termination grace at a soft phase boundary.
        if not completed.wait(timeout) and coord.clock() >= item.deadline:
            cancellation.set()
        if not completed.is_set():
            coord.finish(
                lease,
                status="FAILED",
                detail="cancellation_unconfirmed_lease_retained",
                confirmed_ended=False,
            )
        late = coord.clock() >= lease.deadline
        done = completed.is_set()
        # No returned object is later mutated by the worker.
        text = captured["text"]
        reason = captured["reason"] if done else None
        error = captured["error"] if done else "cancellation_unconfirmed_lease_retained"
        parsed = parse_response(
            text,
            finish_reason=reason,
            transport_complete=done and not error and not late,
        )
        result = Generation(
            lease.id,
            parsed,
            reason,
            error,
            late,
            dict(captured["usage"]),
            {
                **observed_transport,
                **captured["transport"],
                "remote_ended": bool(done and captured["ended"]),
                "caller_deadline": lease.deadline,
                "observation_deadline": item.deadline,
                "skill_included": bool(effective_skill),
                "stream_requested": True,
                "request_started_monotonic": started,
                "admission_wait_seconds": max(0.0, started - admission_started),
                "effective_max_tokens": maximum,
                "request_profile": self.request_profile,
                "output_class": output_class,
                "global_max_tokens": coord.limits.max_tokens,
            },
        )
        if parsed.valid:
            coord.record_request_fact(lease, "protocol_valid", 1)
        if self.diagnostic_sink is not None:
            try:
                self.diagnostic_sink(
                    {
                        "request_id": lease.id,
                        "item_id": item.id,
                        "kind": kind,
                        "messages": packet,
                        "decision": "admitted",
                        "intent": intent,
                        "lease": asdict(lease),
                        "request_parameters": {
                            "thinking_mode": False,
                            "temperature": 0.2,
                            "max_tokens": maximum,
                            "stream": True,
                            "assistant_prefill": "STATUS: ",
                        },
                        "visible_response": text,
                        "finish_reason": reason,
                        "usage": result.usage,
                        "error": error,
                        "late": late,
                        "protocol": "l3-stream-prefill-v1",
                        "generation": asdict(result),
                        "started_monotonic": started,
                        "returned_monotonic": coord.clock(),
                    }
                )
            except (OSError, ValueError, TypeError):
                coord.stop_dispatch("local_diagnostic_persistence_failed")
        return result
