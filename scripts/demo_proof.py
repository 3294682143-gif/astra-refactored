"""In-process end-to-end proof for the GF(2) demo (fallback / on-stage backup).

Runs the OFFICIAL ReasoningAgent path for the recommended demo problem and prints
the delivered candidate plus the real math-asset evidence. No HTTP server, no
background process tree — immune to the console/process-group kill observed when
the long-lived web server is used on this machine.

Usage:  python scripts/demo_proof.py
"""
from __future__ import annotations
import json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT); sys.path.insert(0, str(ROOT))

from tests.web_math_helpers import MathAssetScriptedClient
from python.astra_bridge.public_chat_port import PublicChatPort
from python.astra_web.solver_adapter import SolverAdapter

PROBLEM = "已知线性系统方程 Ax=b，求 GF(2) 秩及通解，并验证齐次空间正交基。"
ASSET_ID, TARGET, INPUT = "math.linear-algebra", "gf2_rank", {"rows": [1, 2]}

events = []
def observer(event):
    events.append(event)

def factory(budgets=None):
    secs = (budgets or {}).get("problem_seconds", 600)
    return PublicChatPort(MathAssetScriptedClient(ASSET_ID, TARGET, INPUT), request_seconds=secs)

def main() -> int:
    adapter = SolverAdapter(client_factory=factory)
    req = {"problem": PROBLEM, "engine": "ts", "_event_sink": observer,
           "max_model_calls": 32, "max_work_units": 4, "max_effects": 1, "max_reviews": 2,
           "max_method_loads": 1, "max_repairs": 1, "max_consensus": 1, "max_r0": 1,
           "problem_seconds": 600, "policy": "BEST_EFFORT"}
    res = adapter(req)
    keep = ["status","stopReason","code","final_response","reason","candidate_verified","strictAcceptance","elapsedMs"]
    print("===== DELIVERY CARD =====")
    print(json.dumps({k: res.get(k) for k in keep}, ensure_ascii=False, indent=2))
    # real math evidence from events
    print("\n===== MATH ASSET EVIDENCE =====")
    found = False
    for ev in events:
        k = ev.get("kind")
        if k == "effect_returned" and ev["payload"].get("name") == TARGET:
            print("effect_returned:", json.dumps(ev["payload"], ensure_ascii=False)); found = True
        if k == "TOOL_OBSERVATION":
            for row in (ev["payload"].get("output") or []):
                print("TOOL_OBSERVATION:", json.dumps(row, ensure_ascii=False)); found = True
    ok = res.get("status") == "candidate" and res.get("candidate_verified") is False and found
    print("\n>>>", "PASS: delivered CANDIDATE (candidate_verified=false) with real gf2_rank evidence." if ok
          else "FAIL: see above.")
    return 0 if ok else 1

if __name__ == "__main__":
    raise SystemExit(main())
