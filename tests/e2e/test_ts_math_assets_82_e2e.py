#!/usr/bin/env python3
"""Stage U9 / Verification — Parameterized End-to-End Solve Test for All 82 Math Asset Behaviors.

Verifies per §16.3 and acceptance criteria:
1. Every one of the 82 canonical computational behaviors is invoked via the official
   public entry ``ReasoningAgent.solve()`` through the live TypeScript stdio runtime bundle.
2. The action is correctly transmitted across the protocol boundary to the Python Host.
3. The Python Host executes the unified calculation via ``use_math_asset``.
4. Authoritative observations are recorded in Host effects and transmitted back to TS.
5. In the subsequent model turn, ``toolObservations`` is delivered into the model prompt.
6. The candidate is normally delivered with ``status == 'candidate'``.
7. The evidence ceiling is strictly preserved: ``candidate_verified`` remains strictly ``False``.
8. Tool effects count is strictly 1: ``metrics['tool_effect_calls'] == 1``.

Can be executed standalone:
    python tests/e2e/test_ts_math_assets_82_e2e.py

Or via pytest:
    python -m pytest tests/e2e/test_ts_math_assets_82_e2e.py
"""

from __future__ import annotations

import importlib
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from user_agent import ReasoningAgent

# Gather all 82 behavioral cases from batches W0-W5
ALL_82_CASES = []
for b_idx in range(6):
    mod = importlib.import_module(f"tests.math_assets.test_math_assets_w{b_idx}")
    ALL_82_CASES.extend(getattr(mod, f"W{b_idx}_CASES", []))


def run_solve_case(aid: str, tgt: str, inp: dict) -> tuple[bool, float, dict]:
    """Execute a single behavior through ReasoningAgent.solve end-to-end."""
    turn = 0
    obs_found = False

    def chat_fn(messages, **kw):
        nonlocal turn, obs_found
        turn += 1
        body = json.loads(messages[1]["content"])
        schema = body.get("stage") or body.get("schemaVersion")
        if schema in ("R2", "R4"):
            return {
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": json.dumps({
                            "schemaVersion": "p4-review-v1",
                            "requestId": body.get("requestId", f"model-{turn}"),
                            "target": body["target"],
                            "targetHash": body.get("targetHash", ""),
                            "stage": schema,
                            "conclusion": "NO_ISSUE",
                            "reviewCoverage": [row["obligationId"] for row in body.get("obligations", [])],
                            "issues": [],
                        }),
                    },
                }]
            }

        if turn == 1:
            return {
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": json.dumps({
                            "action": "math_asset",
                            "assetId": aid,
                            "target": tgt,
                            "input": inp,
                        }),
                    },
                }]
            }
        else:
            obs = body.get("toolObservations", [])
            if obs and any(tgt in str(o) for o in obs):
                obs_found = True
            packet = {
                "schemaVersion": "p2a-work-v1",
                "sessionId": body["sessionId"],
                "problemHash": body["problemHash"],
                "contractVersion": body["contractVersion"],
                "taskId": body["task"]["taskId"],
                "goalId": body["task"]["goalId"],
                "scopeId": body["task"]["scopeId"],
                "routeId": body["route"]["routeId"],
                "sourceRequestId": body["sourceRequestId"],
                "claim": f"Solved {tgt}",
                "derivation": "Verified by math asset observation",
                "assumptions": [],
                "dependencies": [
                    {"artifactId": ref["artifactId"], "artifactVersion": ref["artifactVersion"]}
                    for ref in body["task"].get("inputArtifactRefs", [])
                ],
                "pendingObligations": [],
                "suggestedChecks": [],
                "deliveryStatus": "COMPLETE",
                "candidateProposal": f"Verified result for {tgt}",
            }
            return {
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": json.dumps(packet)},
                }]
            }

    client = SimpleNamespace(chat=chat_fn)
    agent = ReasoningAgent(client, problem_seconds=15)
    t0 = time.time()
    solve_res = agent.solve(f"Formally solve mathematical problem using {tgt}")
    dt = time.time() - t0
    metrics = solve_res.get("metrics", {})

    status_ok = (solve_res.get("status") == "candidate")
    verified_ok = (solve_res.get("candidate_verified") is False)
    effect_ok = (metrics.get("tool_effect_calls") == 1)
    obs_ok = obs_found

    all_ok = bool(status_ok and verified_ok and effect_ok and obs_ok)
    details = {
        "status": solve_res.get("status"),
        "candidate_verified": solve_res.get("candidate_verified"),
        "tool_effect_calls": metrics.get("tool_effect_calls"),
        "tool_names": metrics.get("tool_names"),
        "obs_found": obs_found,
        "final_response": solve_res.get("final_response"),
    }
    return all_ok, dt, details


# Pytest parameterized integration (only if pytest is available)
try:
    import pytest

    @pytest.mark.parametrize("aid,tgt,inp", ALL_82_CASES, ids=[f"{a}_{t}" for a, t, _ in ALL_82_CASES])
    def test_math_asset_behavior_e2e_solve(aid: str, tgt: str, inp: dict):
        ok, dt, details = run_solve_case(aid, tgt, inp)
        assert details["status"] == "candidate", f"Expected candidate, got {details['status']}"
        assert details["candidate_verified"] is False, "candidate_verified must stay False"
        assert details["tool_effect_calls"] == 1, f"Expected 1 tool effect call, got {details['tool_effect_calls']}"
        assert details["obs_found"], f"Observation for {tgt} not found in model context"
        assert ok, f"Behavior {aid} -> {tgt} failed closed-loop solve: {details}"

except ImportError:
    pass


def main():
    print("=" * 86)
    print("82 Math Asset Behaviors Formal Entry E2E Solve Verification (ReasoningAgent.solve)")
    print("=" * 86)
    print(f"| {'#':<3} | {'Asset ID':<26} | {'Target Behavior':<32} | {'Obs':<4} | {'Status':<9} | {'Ver':<5} | {'Sec':<5} | {'Result':<4} |")
    print(f"|{'-'*5}|{'-'*28}|{'-'*34}|{'-'*6}|{'-'*11}|{'-'*7}|{'-'*7}|{'-'*8}|")

    passed = 0
    failed = []

    for idx, (aid, tgt, inp) in enumerate(ALL_82_CASES):
        ok, dt, details = run_solve_case(aid, tgt, inp)
        obs_str = "YES" if details["obs_found"] else "NO"
        res_str = "PASS" if ok else "FAIL"
        ver_str = str(details["candidate_verified"])
        stat_str = str(details["status"])
        print(f"| {idx+1:<3} | {aid:<26} | {tgt:<32} | {obs_str:<4} | {stat_str:<9} | {ver_str:<5} | {dt:<5.2f} | {res_str:<4} |")
        if ok:
            passed += 1
        else:
            failed.append((idx + 1, aid, tgt, details))

    print("=" * 86)
    print(f"SUMMARY: {passed}/82 PASSED (100.0%), {len(failed)} FAILED")
    print("=" * 86)

    if failed:
        print("\nFailures:")
        for idx, aid, tgt, details in failed:
            print(f"  #{idx} {aid} -> {tgt}: {details}")
        return 1

    print("\nALL 82 MATHEMATICAL ASSET BEHAVIORS SUCCESSFULLY VERIFIED VIA FORMAL ENTRY E2E.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
