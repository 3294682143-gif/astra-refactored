"""G5/PR6 (local) — conservative OfficialClient request policy unit tests."""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from python.astra_bridge import model_request_policy as p  # noqa: E402


def test_max_tokens_is_conservatively_capped():
    assert p.MAX_TOKENS == 8192
    assert p.clamp_max_tokens(8192) == 8192
    assert p.clamp_max_tokens(16384) == 8192  # never widened above the ceiling
    assert p.clamp_max_tokens(None) == 8192
    assert p.clamp_max_tokens(0) == 1
    assert p.clamp_max_tokens(True) == 8192  # bool is not an int request


def test_missing_usage_is_unknown_not_zero():
    assert p.normalize_usage(None) is None
    assert p.normalize_usage({}) is None
    assert p.normalize_usage({"prompt_tokens": 5}) == {"prompt_tokens": 5}
    # a malformed / negative / bool count is dropped, never coerced to 0
    assert p.normalize_usage({"completion_tokens": -1, "total_tokens": True}) is None
    assert p.normalize_usage({"total_tokens": 9007199254740993}) is None


def test_finish_reason_normalization():
    assert p.normalize_finish_reason({"finish_reason": "stop"}) == "stop"
    assert p.normalize_finish_reason({"finish_reason": "length"}) == "length"
    assert p.normalize_finish_reason({"finish_reason": "weird"}) == "other"
    assert p.normalize_finish_reason({}) is None
    assert p.normalize_finish_reason({"finish_reason": ""}) is None


def test_reasoning_used_is_public_only():
    assert p.reasoning_used({"reasoning_content": "thinking..."}) is True
    assert p.reasoning_used({"reasoning": "x"}) is True
    assert p.reasoning_used({"reasoning_content": "  "}) is False
    assert p.reasoning_used({}) is False
    # never reads a private attribute
    class _Priv:
        _reasoning = "secret"
    assert p.reasoning_used(_Priv()) is False
