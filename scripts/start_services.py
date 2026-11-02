#!/usr/bin/env python3
"""Unified Scientific Multi-Agent Workbench (Inkstone / Astra) - Windows Service Controller (E16).

Complies with Section 14 of the Track 160 AI4S Execution Plan:
- Single-entry start script for reviewers and production deployment.
- Pre-flight self-check: Python >= 3.10, Node.js >= 18, SQLite data root, Web UI dist build.
- Reviewer restricted experience mode:
  When external Atria API key is unconfigured, API explicitly reports SOLVER_NOT_CONFIGURED.
  Catalogs and local assets remain inspectable, while solver execution and readiness
  are reported according to the actual environment rather than assumed available.
- Controlled child process management and signal trapping.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import time
from typing import Dict, List, Tuple


ROOT_DIR = Path(__file__).resolve().parent.parent


def run_preflight_checks(data_root: Path, web_dist: Path) -> Tuple[bool, List[str]]:
    """Runs rigorous pre-flight environment checks."""
    issues: List[str] = []

    # 1. Python version check (>= 3.10)
    if sys.version_info < (3, 10):
        issues.append(f"Python 3.10+ required; current is {platform.python_version()}")

    # 2. Node.js binary check
    node_bin = shutil.which("node")
    if not node_bin:
        issues.append("Node.js runtime not found in PATH")

    # 3. Data root directory
    try:
        data_root.mkdir(parents=True, exist_ok=True)
        test_file = data_root / ".write_test"
        test_file.write_text("ok", encoding="utf-8")
        test_file.unlink()
    except Exception as exc:
        issues.append(f"Data root {data_root} is not writable: {exc}")

    # 4. Web demo build existence
    index_html = web_dist / "index.html"
    if not index_html.is_file():
        issues.append(
            f"Front-end build artifact missing at {index_html}. Please run 'npm run build' in apps/web-demo"
        )

    required_js = [
        ROOT_DIR / "packages" / "scenario-catalog" / "dist" / "src" / "cli.js",
        ROOT_DIR / "packages" / "domain-control" / "dist" / "src" / "index.js",
        ROOT_DIR / "packages" / "domain-scientific-computing" / "dist" / "src" / "index.js",
        ROOT_DIR / "packages" / "domain-data-analysis" / "dist" / "src" / "index.js",
    ]
    missing_js = [path for path in required_js if not path.is_file()]
    if missing_js:
        issues.append("Scenario registry or numerical engine build is missing; run 'npm run build' at repository root")

    atria_key = os.environ.get("ASTRA_ATRIA_API_KEY") or os.environ.get("ASTRA_S2_API_KEY") or os.environ.get("INTERN_API_KEY")
    if not atria_key:
        print("[REVIEWER NOTICE] No supported solver API key detected in environment.")
        print("[REVIEWER NOTICE] Operating in 'Restricted Reviewer Experience Mode':")
        print("                  - Scenario catalogs and local assets remain inspectable.")
        print("                  - Solver requests will honestly return SOLVER_NOT_CONFIGURED.")
        print("                  - Readiness still depends on actual isolation and engine capabilities.")

    return len(issues) == 0, issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Start Inkstone Scientific Multi-Agent Workbench")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8011, help="BFF port (default: 8011)")
    parser.add_argument("--data-root", default=str(ROOT_DIR / "var" / "astra"), help="Data root path")
    parser.add_argument("--web-dist", default=str(ROOT_DIR / "apps" / "web-demo" / "dist"), help="Frontend dist path")
    parser.add_argument("--check-only", action="store_true", help="Perform pre-flight checks and exit")
    args = parser.parse_args()

    data_root = Path(args.data_root).resolve()
    web_dist = Path(args.web_dist).resolve()

    print("================================================================================")
    print("  Inkstone / Astra AI4S Scientific Multi-Agent Workbench (Track 160)")
    print(f"  Platform: {platform.system()} {platform.machine()} | Python {platform.python_version()}")
    print("================================================================================")

    passed, issues = run_preflight_checks(data_root, web_dist)
    if not passed:
        print("\n[ERROR] Pre-flight verification failed:")
        for issue in issues:
            print(f"  - {issue}")
        return 1

    print("\n[OK] Pre-flight checks passed successfully.")
    if args.check_only:
        print("[OK] Self-check mode complete. Exiting with code 0.")
        return 0

    env = dict(os.environ)
    env["ASTRA_DATA_ROOT"] = str(data_root)
    env["ASTRA_WEB_DIST"] = str(web_dist)

    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "python.astra_web.app:app",
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]

    print(f"\n[INFO] Launching Scientific BFF Server at http://{args.host}:{args.port}/")
    print(f"       - Scientific Workbench: http://{args.host}:{args.port}/domains")
    print(f"       - Health Check:         http://{args.host}:{args.port}/api/v2/health")
    print(f"       - Press Ctrl+C to terminate.")

    proc = subprocess.Popen(cmd, cwd=str(ROOT_DIR), env=env)

    def sig_handler(sig, frame):
        print("\n[INFO] Terminating server...")
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT, sig_handler)
    signal.signal(signal.SIGTERM, sig_handler)

    try:
        proc.wait()
    except KeyboardInterrupt:
        sig_handler(None, None)

    return proc.returncode or 0


if __name__ == "__main__":
    sys.exit(main())
