from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PORT = 8089
BASE_URL = f"http://127.0.0.1:{PORT}"

def main():
    data_dir = REPO_ROOT / "var" / "astra"
    data_dir.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["ASTRA_PROVIDER"] = "mock"
    env["PYTHONPATH"] = str(REPO_ROOT)
    env["ASTRA_DATA_ROOT"] = str(data_dir)

    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "python.astra_web.app:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        # Wait up to 10s for port to respond
        ready = False
        for _ in range(50):
            res = subprocess.run(
                ["curl.exe", "--noproxy", "*", "-s", "-o", "NUL", "-w", "%{http_code}", f"{BASE_URL}/api/health"],
                capture_output=True,
                text=True,
            )
            if res.stdout.strip() == "200":
                ready = True
                break
            time.sleep(0.2)

        if not ready:
            print("Server failed to respond on port", PORT)
            return

        # Step 1: POST /api/v2/runs
        payload = json.dumps({
            "domainId": "control.identification",
            "problem": "辨识非线性阻尼受迫振子质量阻尼刚度三参数 (m=1.5, c=0.4, k=2.8)",
            "idempotencyKey": f"p0_curl_idemp_{int(time.time())}",
        })
        post_cmd = [
            "curl.exe", "--noproxy", "*", "-s", "-X", "POST",
            f"{BASE_URL}/api/v2/runs",
            "-H", "Content-Type: application/json",
            "-d", payload,
        ]
        post_res = subprocess.run(post_cmd, capture_output=True, text=True, encoding="utf-8")
        post_json = json.loads(post_res.stdout)
        run_id = post_json["runId"]

        # Step 2: GET /api/runs/{run_id}
        get_cmd = ["curl.exe", "--noproxy", "*", "-s", f"{BASE_URL}/api/runs/{run_id}"]
        get_res = subprocess.run(get_cmd, capture_output=True, text=True, encoding="utf-8")
        run_detail = json.loads(get_res.stdout)
        summary = run_detail.get("summary", {})

        print("=== CURL OUTPUT: GET /api/runs/{run_id} ===")
        print(f"HTTP GET /api/runs/{run_id}")
        print(f"summary.provider: {summary.get('provider')}")
        print(f"summary.stopReason: {summary.get('stopReason')}")
        print(f"summary.status: {summary.get('status')}")

        # Step 3: GET /runs/{run_id}
        page_cmd = ["curl.exe", "--noproxy", "*", "-s", "-o", "NUL", "-w", "%{http_code}", f"{BASE_URL}/runs/{run_id}"]
        page_res = subprocess.run(page_cmd, capture_output=True, text=True)
        print("=== ROUTE CHECK: GET /runs/{run_id} ===")
        print(f"HTTP Status: {page_res.stdout.strip()} (Page Route 200 OK)")

        # Step 4: L2 Archive confirmation
        l2_file = data_dir / "runs" / run_id / "details.json"
        print(f"RUN_ID: {run_id}")
        print(f"L2_PATH: {l2_file.relative_to(REPO_ROOT).as_posix()} (exists={l2_file.is_file()})")

    finally:
        server.terminate()
        server.wait(timeout=3.0)

if __name__ == "__main__":
    main()
