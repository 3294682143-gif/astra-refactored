"""Local evaluation transport observations, not remote cancellation evidence.

HTTP streaming here exposes response headers before reading a non-streaming JSON
body. It NEVER enables model streaming and never logs credentials or model text.
"""

import json
import re
import time

import requests

from .response import public_choice, terminal_reason


def exception_types(exc):
    pending, seen, names = [exc], set(), []
    while pending and len(names) < 12:
        error = pending.pop(0)
        if not isinstance(error, BaseException) or id(error) in seen:
            continue
        seen.add(id(error))
        names.append(type(error).__name__[:64])
        pending.extend([error.__cause__, error.__context__])
        pending.extend(arg for arg in error.args if isinstance(arg, BaseException))
        # urllib3 exposes reason/original_error on its public exception classes.
        pending.extend(
            [getattr(error, "reason", None), getattr(error, "original_error", None)]
        )
    return names


class BufferedJSONResponse:
    def __init__(self, value):
        self.value = value

    def raise_for_status(self):
        pass  # Checked while the response was owned by observe_json_post.

    def json(self):
        return self.value


def observe_json_post(
    url, *, headers, data, timeout, record, post=None, clock=time.monotonic
):
    post = post or requests.post
    start = clock()
    connect, read = timeout if isinstance(timeout, tuple) else (timeout, timeout)
    record.update(
        stage="waiting_response_headers",
        http_attempts=1,
        connect_timeout_seconds=connect,
        read_timeout_seconds=read,
        send_state="unknown_after_http_call",
        response_headers_seconds=None,
        first_body_chunk_seconds=None,
        response_bytes=0,
        confirmed_ended=False,
        usage=None,
        remote_usage_unknown=True,
    )
    response = None
    try:
        response = post(
            url,
            headers=headers,
            data=data,
            timeout=timeout,
            allow_redirects=False,
            stream=True,
        )
        record.update(
            http_status=response.status_code,
            response_headers_seconds=max(0, clock() - start),
            stage="response_headers",
        )
        request_id = response.headers.get("x-request-id", "")
        if isinstance(request_id, str) and re.fullmatch(
            r"[A-Za-z0-9._:-]{1,128}", request_id
        ):
            record["public_request_id"] = request_id
        if 400 <= response.status_code < 500 and response.status_code != 408:
            record.update(confirmed_ended=True, rejected=True)
        response.raise_for_status()
        record["stage"] = "response_body"
        body = bytearray()
        for block in response.iter_content(chunk_size=4096):
            if not block:
                continue
            if record["first_body_chunk_seconds"] is None:
                record["first_body_chunk_seconds"] = max(0, clock() - start)
            record["response_bytes"] += len(block)
            if len(body) + len(block) > 2 * 1024 * 1024:
                raise ValueError("response_capacity")
            body.extend(block)
        record["stage"] = "json_decode"
        value = json.loads(body)
        choice = public_choice(value)
        reason = terminal_reason(choice) if choice is not None else None
        if reason is not None:
            record.update(confirmed_ended=True, finish_reason=reason)
        usage = value.get("usage")
        if isinstance(usage, dict):
            observed = {
                k: usage[k]
                for k in ("prompt_tokens", "completion_tokens", "total_tokens")
                if type(usage.get(k)) is int and usage[k] >= 0
            }
            if observed:
                record.update(
                    usage=observed, remote_usage_unknown="total_tokens" not in observed
                )
        record["stage"] = "public_json_return"
        return BufferedJSONResponse(value)
    except BaseException as exc:
        record["exception_types"] = exception_types(exc)
        raise
    finally:
        record["elapsed_seconds"] = max(0, clock() - start)
        if response is not None:
            try:
                response.close()
            except Exception as exc:  # noqa: BLE001 - cleanup is not a lifecycle receipt
                record["cleanup_error_type"] = type(exc).__name__[:64]
