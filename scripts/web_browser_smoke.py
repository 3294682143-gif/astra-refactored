#!/usr/bin/env python3
"""Headless browser smoke for the built Web UI and BFF static mount.

This is intentionally a real browser render, not a JSON-only assertion. It uses
the locally provisioned Chrome for Testing binary (override with
``ASTRA_CHROME``) and checks the rendered DOM for the two user-facing pages.
It is a smoke check, not a substitute for the interaction acceptance matrix.
"""
from __future__ import annotations

import glob
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _chrome() -> str:
    explicit = os.environ.get("ASTRA_CHROME")
    if explicit and Path(explicit).is_file():
        return explicit
    matches = sorted(glob.glob(str(Path.home() / ".cache/ms-playwright/chromium-*/chrome-linux64/chrome")))
    if matches:
        return matches[-1]
    raise SystemExit("ENVIRONMENT_BLOCKED: no Chrome for Testing binary found (set ASTRA_CHROME)")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait(url: str, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"server did not become ready: {url}")


def _render(url: str) -> str:
    command = [
        _chrome(),
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--virtual-time-budget=6000",
        "--dump-dom",
        url,
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=45)
    if result.returncode != 0:
        raise RuntimeError(f"chrome failed: {result.stderr[-800:]}")
    return result.stdout


def main() -> int:
    dist = ROOT / "apps" / "web-demo" / "dist"
    if not (dist / "index.html").is_file():
        raise SystemExit("ENVIRONMENT_BLOCKED: apps/web-demo/dist is missing; run the Web build first")
    port = _free_port()
    data_root = Path(tempfile.mkdtemp(prefix="astra-web-browser-"))
    env = {
        **os.environ,
        "PYTHONPATH": str(ROOT),
        "ASTRA_DATA_ROOT": str(data_root),
        "ASTRA_WEB_DIST": str(dist),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "python.astra_web.app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        _wait(f"http://127.0.0.1:{port}/api/health")
        assets = _render(f"http://127.0.0.1:{port}/assets")
        solve = _render(f"http://127.0.0.1:{port}/solve")
        checks = {
            "assets_title": "数学资产" in assets,
            "asset_count": "26" in assets,
            "behavior_count": "82" in assets,
            "catalog_digest": "catalogDigest" in assets,
            "solve_title": "数学智能体求解工作台" in solve,
            "effect_budget": "数学资产调用额度" in solve,
            "no_method_switch": "方法卡准入开关" not in solve,
        }
        for name, ok in checks.items():
            print(f"{'PASS' if ok else 'FAIL'} {name}")
        if not all(checks.values()):
            return 1
        print("BROWSER_SMOKE_PASS")
        return 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
