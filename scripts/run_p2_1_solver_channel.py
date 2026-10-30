# scripts/run_p2_1_solver_channel.py
# 经 solver 通道（ASTRA_PROVIDER=atria）实跑 1 道多选票题 + 1 道数学推导题
import json
import os
import sys
import time
from pathlib import Path

repo_root = Path(__file__).resolve().parents[1]
if str(repo_root) not in sys.path:
    sys.path.insert(0, str(repo_root))

os.environ["ASTRA_PROVIDER"] = "atria"
os.environ["ASTRA_ATRIA_API_KEY"] = "sk-f62a-REDACTED"
os.environ["ASTRA_ATRIA_ENDPOINT"] = "https://discovery-api.intern-ai.org.cn/v1/chat/completions"
os.environ["ASTRA_ATRIA_REASONING_MODE"] = "hybrid"

from python.astra_web.solver_adapter import build_solver_from_env

def run_solver_turn(name, prompt, max_tokens=256):
    print(f"\n==========================================", flush=True)
    print(f"Executing Solver Channel: {name}", flush=True)
    print(f"Prompt: {prompt}", flush=True)
    
    solver = build_solver_from_env()
    client = solver._build_client({"problem_seconds": 120})
    
    t0 = time.monotonic()
    resp = client.chat(
        messages=[
            {"role": "system", "content": "你是由端砚网关驱动的严谨数学与逻辑求解器。"},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
        max_tokens=max_tokens,
    )
    elapsed = round(time.monotonic() - t0, 3)
    choice = resp["choices"][0]
    usage = resp.get("usage") or {}
    finish_reason = choice.get("finish_reason")
    content = choice["message"].get("content") or ""
    
    print(f"Elapsed: {elapsed}s", flush=True)
    print(f"HTTP Finish: {finish_reason}", flush=True)
    print(f"Usage: {usage}", flush=True)
    print(f"Content: {content[:160]}...", flush=True)
    
    return {
        "name": name,
        "elapsed": elapsed,
        "finish_reason": finish_reason,
        "usage": usage,
        "content": content,
    }

def main():
    # 1. 选票关快响应题 (ballot check)
    r_ballot = run_solver_turn(
        name="选票关快响应 (ballot)",
        prompt="[ballot vote] 请对候选解 x=2 做出裁决：方程 x^2 - 4 = 0 在正实数域的解是否为 x=2？只需回复 YES 或 NO。",
        max_tokens=256,
    )
    
    # 2. 数学推导题 (derivation)
    r_derive = run_solver_turn(
        name="推导关深度推理 (math derivation)",
        prompt="求方程 x^2 - 5x + 6 = 0 的所有解，写出简要因式分解步骤。",
        max_tokens=256,
    )
    
    print("\nSummary Results:", flush=True)
    print("Ballot:", r_ballot["usage"], f"{r_ballot['elapsed']}s", r_ballot["finish_reason"], flush=True)
    print("Derive:", r_derive["usage"], f"{r_derive['elapsed']}s", r_derive["finish_reason"], flush=True)

if __name__ == "__main__":
    main()
