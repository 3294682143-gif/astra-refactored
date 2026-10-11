"""Offline a2 short-path capture over the real LiteRuntime with a fake client.

Research comparison only: not a formal host RPC, not a solver fallback. The
real client, network and tools are never used; the tool spy always refuses.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path

import mathagent
from mathagent.lite import runtime as lite_runtime
from mathagent.lite.methods import MethodCatalog
from mathagent.lite.runtime import LiteRuntime

__all__ = ["capture", "canonical_hash", "main"]

_SCENARIOS = ("direct", "method", "repeat", "truncated", "final-turn-method")
_PROBLEM = "A2 offline alignment \u03b1\U0001f600"
_METHOD_ID = "linearization-spectral"
_BASELINE_VERSION = "0.10.0a2"
_PROFILE_SCHEMA = "a2-shortpath-profile-v1"
_BUNDLE_SCHEMA = "a2-shortpath-bundle-v1"
_MAX_BUNDLE_BYTES = 262144
_MAX_REQUESTS = 3
_TEMPERATURE = "0.2"
_MAX_TOKENS = 8192
_MAX_METHODS = 2
_MAX_METHOD_CHARS = 12000
_MAX_INPUT_CHARS = 60000

_FINAL_JSON = json.dumps(
    {"action": "final", "answer": "synthetic candidate", "complete": True, "unresolved": []},
    ensure_ascii=False,
    separators=(",", ":"),
)
_METHOD_JSON = json.dumps(
    {"action": "method", "id": _METHOD_ID}, ensure_ascii=False, separators=(",", ":")
)

# Fixed trusted source names; the lock may not introduce any other path.
_SOURCE_NAMES = (
    "mathagent/__init__.py",
    "mathagent/lite/runtime.py",
    "mathagent/lite/protocol.py",
    "mathagent/lite/methods.py",
    "mathagent/runtime/platform_adapter.py",
    "mathagent/runtime/platform_coordinator.py",
    "mathagent/runtime/config.py",
    "mathagent/resources/general_v11/SOURCE.json",
)


def canonical_hash(value):
    """SHA256 of canonical compact JSON; data integrity, not authentication."""
    text = json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _root():
    return Path(__file__).resolve().parents[2]


def _verified_sources():
    root = _root()
    lock_path = root / "packages" / "protocol" / "schema" / "a2-source-lock.json"
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ValueError("SOURCE_MISMATCH") from None
    if not isinstance(lock, dict) or set(lock) != set(_SOURCE_NAMES):
        raise ValueError("SOURCE_MISMATCH")
    for name in _SOURCE_NAMES:
        expected = lock[name]
        if not isinstance(expected, str):
            raise ValueError("SOURCE_MISMATCH")
        try:
            data = (root / name).read_bytes()
        except OSError:
            raise ValueError("SOURCE_MISMATCH") from None
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("SOURCE_MISMATCH")
    return {name: lock[name] for name in _SOURCE_NAMES}


def _method_asset(catalog):
    load = catalog.load(_METHOD_ID)
    if getattr(load, "status", None) != "loaded":
        raise ValueError("SOURCE_MISMATCH")
    body = load.body
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    if digest != load.body_sha256 or load.body_chars != len(body):
        raise ValueError("SOURCE_MISMATCH")
    return {
        "id": _METHOD_ID,
        "title": load.title,
        "version": "1.1.0",
        "body": body,
        "bodySha256": digest,
        "bodyChars": load.body_chars,
    }


def _profile(sources):
    catalog = MethodCatalog()
    if not catalog.available:
        raise ValueError("SOURCE_MISMATCH")
    asset = _method_asset(catalog)
    loaded = catalog.load(_METHOD_ID)
    stub = lite_runtime._MethodLoadStub(_METHOD_ID, "already_loaded")
    return {
        "schemaVersion": _PROFILE_SCHEMA,
        "baselineVersion": _BASELINE_VERSION,
        "sources": sources,
        "maxSteps": 3,
        "maxMethods": _MAX_METHODS,
        "maxMethodChars": _MAX_METHOD_CHARS,
        "maxInputChars": _MAX_INPUT_CHARS,
        "temperature": _TEMPERATURE,
        "maxTokens": _MAX_TOKENS,
        "systemPrompt": lite_runtime._SYSTEM_PROMPT,
        "catalogBlock": lite_runtime._method_catalog_block(catalog),
        "turnNotes": [lite_runtime._turn_note(n) for n in (1, 2, 3)],
        "closeoutNotes": [lite_runtime._closeout_note(n) for n in (1, 2, 3)],
        "forceCloseoutNote": lite_runtime._FORCE_CLOSEOUT_NOTE,
        "methodAsset": asset,
        "loadedFeedback": lite_runtime._method_feedback(loaded),
        "repeatedFeedback": lite_runtime._method_feedback(stub),
    }


class _FakeClient:
    """Records real call arguments only; never contacts a real client."""

    def __init__(self, replies):
        self._replies = list(replies)
        self.requests = []
        self.receipts = []

    def chat(self, messages, temperature, max_tokens):
        if temperature != 0.2 or max_tokens != _MAX_TOKENS:
            raise ValueError("FIXTURE_EXHAUSTED")
        if len(self.requests) >= len(self._replies):
            raise ValueError("FIXTURE_EXHAUSTED")
        index = len(self.requests)
        self.requests.append(
            {
                "messages": copy.deepcopy(messages),
                "temperature": str(temperature),
                "maxTokens": max_tokens,
            }
        )
        text, transport = self._replies[index]
        self.receipts.append({"transport": transport, "text": text})
        if transport == "TRUNCATED":
            return {
                "choices": [
                    {
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": "length",
                    }
                ]
            }
        return text


class _GuardExecutor:
    """Counts and refuses; a real tool execution must never happen here."""

    def __init__(self):
        self.count = 0

    def execute(self, name, args, deadline=None, scope=None):
        self.count += 1
        raise RuntimeError("tool execution refused")


class _CountingCatalog(MethodCatalog):
    """Real catalog with a load counter; no behaviour change."""

    def __init__(self):
        self.loads = 0
        super().__init__()

    def load(self, method_id):
        self.loads += 1
        return super().load(method_id)


def _replies(scenario):
    if scenario == "direct":
        return [(_FINAL_JSON, "COMPLETE")]
    if scenario == "method":
        return [(_METHOD_JSON, "COMPLETE"), (_FINAL_JSON, "COMPLETE")]
    if scenario == "repeat":
        return [
            (_METHOD_JSON, "COMPLETE"),
            (_METHOD_JSON, "COMPLETE"),
            (_FINAL_JSON, "COMPLETE"),
        ]
    if scenario == "truncated":
        return [(_FINAL_JSON, "TRUNCATED")]
    return [(_METHOD_JSON, "COMPLETE")]


def _closeout(result):
    for row in result.get("trace", []):
        if row.get("step") == "lite_summary":
            return row.get("content", {}).get("closeout")
    return None


def capture(scenario="direct"):
    """Run one fixed scenario and return an A2Bundle-shaped dict."""
    if scenario not in _SCENARIOS:
        raise ValueError("SCENARIO")
    if mathagent.__version__ != _BASELINE_VERSION:
        raise ValueError("SOURCE_MISMATCH")
    sources = _verified_sources()
    profile = _profile(sources)
    if scenario == "final-turn-method":
        profile = dict(profile, maxSteps=1)
    client = _FakeClient(_replies(scenario))
    executor = _GuardExecutor()
    catalog = _CountingCatalog()
    runtime = LiteRuntime(
        client,
        executor=executor,
        max_steps=profile["maxSteps"],
        max_methods=_MAX_METHODS,
        max_method_chars=_MAX_METHOD_CHARS,
        method_catalog=catalog,
    )
    result = runtime.solve(_PROBLEM)
    if executor.count != 0:
        raise ValueError("TOOL_EXECUTION")
    requests = client.requests
    receipts = client.receipts
    if not requests or len(requests) != len(receipts) or len(requests) > _MAX_REQUESTS:
        raise ValueError("FIXTURE_EXHAUSTED")
    status = result.get("status")
    if status not in ("candidate", "unsolved"):
        raise ValueError("CAPTURE_FAILED")
    bundle = {
        "schemaVersion": _BUNDLE_SCHEMA,
        "scenario": scenario,
        "problem": _PROBLEM,
        "profile": profile,
        "profileHash": canonical_hash(profile),
        "requests": requests,
        "requestHashes": [canonical_hash(row) for row in requests],
        "receipts": receipts,
        "result": {
            "status": status,
            "candidateVerified": False,
            "closeout": _closeout(result),
        },
        "methodLoads": catalog.loads,
        "toolExecutions": 0,
    }
    encoded = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > _MAX_BUNDLE_BYTES:
        raise ValueError("BOUND_EXCEEDED")
    return bundle


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=False, exit_on_error=False, allow_abbrev=False)
    parser.add_argument("--scenario", dest="scenario", default="direct")
    try:
        args, unknown = parser.parse_known_args(argv)
    except Exception:
        sys.stdout.write(json.dumps({"error": "CAPTURE_FAILED"}))
        sys.stdout.write("\n")
        return 2
    if unknown or args.scenario not in _SCENARIOS:
        sys.stdout.write(json.dumps({"error": "CAPTURE_FAILED"}))
        sys.stdout.write("\n")
        return 2
    try:
        bundle = capture(args.scenario)
    except Exception:
        sys.stdout.write(json.dumps({"error": "CAPTURE_FAILED"}))
        sys.stdout.write("\n")
        return 2
    sys.stdout.write(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
