"""Tests for standalone execution of release bundle and default solve path."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
import pytest

from scripts.build_release_manifest import ROOT
from python.astra_bridge.agent_runtime import _default_script, resolve_script
from python.astra_bridge.agent_protocol import AGENT_HOST_V14_VERSION
from user_agent import ReasoningAgent


def test_bundle_file_exists():
    bundle_path = _default_script()
    assert bundle_path.is_file(), f"Release bundle must exist at {bundle_path}"
    assert bundle_path.stat().st_size > 100_000, "Release bundle must be non-empty bundled JS"


def test_bundle_standalone_initialize():
    bundle_path = _default_script()
    proc = subprocess.Popen(
        ["node", str(bundle_path), "--agent-loop"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        # Send runtime.initialize frame with exact required capabilities and options
        init_frame = {
            "jsonrpc": "2.0",
            "id": "host-1",
            "method": "runtime.initialize",
            "params": {
                "protocolVersion": AGENT_HOST_V14_VERSION,
                "sessionId": "test-bundle-session",
                "profileId": "math-agent-preview-v2",
                "capabilities": {
                    "modelGenerate": "AVAILABLE",
                    "toolExecute": "AVAILABLE",
                    "methodLoad": "UNAVAILABLE",
                    "generatedPython": "UNAVAILABLE",
                    "maxTokens": 8192,
                    "maxTokensVerified": False,
                    "journal": "IN_MEMORY_ONLY",
                    "requireExplicitFinishForTools": True,
                },
                "remainingMs": 10000,
                "maxModelCalls": 4,
                "maxWorkUnits": 2,
                "maxEffects": 1,
                "maxReviews": 1,
                "maxMethodLoads": 0,
                "maxRepairs": 1,
                "maxConsensus": 1,
                "maxR0": 0,
                "policy": "BEST_EFFORT",
                "deriveBudget": False,
            },
        }
        proc.stdin.write(json.dumps(init_frame) + "\n")
        proc.stdin.flush()

        # Read line response
        line = proc.stdout.readline()
        assert line, "Bundle must output response to runtime.initialize"
        resp = json.loads(line)
        assert resp.get("id") == "host-1"
        assert "result" in resp, f"Expected success result, got: {resp}"
    finally:
        proc.kill()
        proc.wait(timeout=2.0)


def _mock_client():
    from types import SimpleNamespace

    def chat(messages, temperature=0.2, max_tokens=8192):
        return {
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": json.dumps({
                            "candidateProposal": "42",
                            "claim": "Answer is 42",
                            "derivation": "Solved directly",
                            "deliveryStatus": "COMPLETE",
                        }),
                    },
                }
            ]
        }

    return SimpleNamespace(chat=chat)


def test_bundle_fails_closed_when_the_v14_sibling_is_missing(tmp_path):
    """A bundle without its v1.4 schema must not silently downgrade to v1.3.

    The old active entry fell back to the v1.3 sibling and then rejected the
    Python v1.4 initialize frame with FIELD_VALUE, which surfaced as an empty
    stream / EOF. The active entry now has only a v1.4 path and must fail with a
    fixed child code instead of loading a different protocol.
    """
    copied_bundle = tmp_path / "stdio-runtime.bundle.mjs"
    shutil.copy2(_default_script(), copied_bundle)
    schema_dir = tmp_path / "schema"
    schema_dir.mkdir()
    shutil.copy2(
        ROOT / "release" / "schema" / "agent-host-v13.schema.json",
        schema_dir / "agent-host-v13.schema.json",
    )
    completed = subprocess.run(
        ["node", str(copied_bundle), "--agent-loop"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        timeout=15,
    )
    assert completed.returncode != 0
    assert completed.stdout == ""
    assert completed.stderr.strip() in {
        "FIELD_VALUE", "MANIFEST_INVALID", "VERSION_MISMATCH",
    }


def test_default_reasoning_agent_uses_ts_engine_and_bundle():
    agent = ReasoningAgent(_mock_client())
    assert agent.engine == "ts"
    res = agent.solve("What is 6 times 7?")
    assert isinstance(res, dict)
    assert res.get("engine") == "ts"
    assert "status" in res
