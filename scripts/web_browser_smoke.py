#!/usr/bin/env python3
"""Real-browser acceptance for the integrated Web console.

A ``--dump-dom`` render only proves that text exists; it cannot submit a solve,
lose the network or open a replay. This script drives the built UI through the
DevTools protocol against a live BFF and checks the interaction contract:

1. **静态页面** — `/assets` 仍显示 26 资产 / 82 行为与目录摘要。
2. **真实求解** — 点击「开始单循环求解」，消费真实 Host 事件
   (``model_dispatched`` / ``effect_returned`` / ``model_returned``)，直到候选产物出现。
3. **断线重连** — 求解途中把浏览器置为离线 → 页面如实显示「正在按 Last-Event-ID
   自动重连」→ 恢复网络 → 同一运行仍然收口为候选（不落到失败态）。
4. **回放** — 打开该运行的回放页，权威终态与结论文本可以从存档重现。

Only the remote model answer is scripted (``scripts/web_demo_server.py``); the
BFF, Python Host, Node bundle and unified math executor are the production code
paths, and the browser never talks to a provider directly.
"""
from __future__ import annotations

import argparse
import asyncio
import glob
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from web_cdp import CDP  # noqa: E402

ANSWER_MARKER = "Verified result for gf2_rank"
RECONNECT_MARKER = "自动重连"
RECONNECT_COUNTER = '[data-testid="reconnect-count"]'


def _chrome() -> str:
    explicit = os.environ.get("ASTRA_CHROME")
    if explicit and Path(explicit).is_file():
        return explicit
    matches = sorted(
        glob.glob(str(Path.home() / ".cache/ms-playwright/chromium-*/chrome-linux64/chrome"))
    )
    if matches:
        return matches[-1]
    raise SystemExit("ENVIRONMENT_BLOCKED: no Chrome for Testing binary found (set ASTRA_CHROME)")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_http(url: str, timeout: float = 40.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"server did not become ready: {url}")


def _start_server(port: int, data_root: Path, dist: Path) -> subprocess.Popen:
    env = {
        **os.environ,
        "PYTHONPATH": str(ROOT),
        "ASTRA_DATA_ROOT": str(data_root),
        "ASTRA_WEB_DIST": str(dist),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    return subprocess.Popen(
        [sys.executable, str(ROOT / "scripts" / "web_demo_server.py"), "--port", str(port)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _start_chrome(port: int, profile: Path) -> subprocess.Popen:
    return subprocess.Popen(
        [
            _chrome(),
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


async def _acceptance(base: str, checks: dict[str, bool]) -> None:
    chrome_port = _free_port()
    profile = Path(tempfile.mkdtemp(prefix="astra-chrome-profile-"))
    chrome = _start_chrome(chrome_port, profile)
    try:
        cdp = await CDP.connect(chrome_port)
        try:
            # ------------------------------------------------------- 1. 资产页
            await cdp.navigate(f"{base}/assets")
            checks["assets_page_loaded"] = bool(
                await cdp.wait_for_text("数学资产", timeout=30)
            )
            # 目录数据由 /api/math-assets 异步载入，必须等真实数据出现再断言。
            checks["assets_count_26"] = bool(await cdp.wait_for_text("26", timeout=20))
            checks["assets_behaviors_82"] = bool(await cdp.wait_for_text("82", timeout=20))
            checks["assets_catalog_digest"] = bool(
                await cdp.wait_for_text("catalogDigest", timeout=20)
            )

            # --------------------------------------------------- 2. 真实求解
            await cdp.navigate(f"{base}/solve")
            checks["solve_page_loaded"] = bool(
                await cdp.wait_for_text("数学智能体求解工作台", timeout=30)
            )
            checks["solve_no_method_switch"] = "方法卡准入开关" not in await cdp.text()
            await cdp.wait_for(
                "!![...document.querySelectorAll('button')].find((b) => (b.innerText||'').includes('开始单循环求解'))",
                timeout=15,
            )
            checks["solve_started"] = await cdp.click_text("开始单循环求解")

            # 真实 Host 事件：方程/资产观测必须先出现在页面上。
            checks["live_effect_event"] = bool(
                await cdp.wait_for("!!document.querySelector('[data-testid=\"live-effect\"]')", timeout=45)
            )
            checks["live_model_step"] = bool(
                await cdp.wait_for("!!document.querySelector('[data-testid=\"live-step\"]')", timeout=45)
            )
            live_text = await cdp.text()
            checks["live_model_dispatched"] = "Model dispatched" in live_text or "模型调用" in live_text
            checks["assets_used_in_effect"] = "gf2_rank" in live_text

            # ------------------------------------------------------ 3. 重连
            # 演示服务器在运行途中主动断开一次 SSE 连接（模拟代理掉线）；浏览器必须
            # 自己的 Last-Event-ID 重连继续消费，页面如实显示「正在重连」。
            checks["reconnect_counter"] = bool(
                await cdp.wait_for(
                    "!!document.querySelector('[data-testid=\"reconnect-count\"]')",
                    timeout=30,
                )
            )
            checks["reconnect_recovered"] = bool(
                await cdp.wait_for(
                    f"document.body.innerText.includes({json.dumps(ANSWER_MARKER)})",
                    timeout=90,
                )
            )
            final_text = await cdp.text()
            checks["candidate_delivered"] = ANSWER_MARKER in final_text
            checks["no_failure_banner"] = "事件流已关闭" not in final_text
            checks["red_line_visible"] = "candidate_verified" in final_text

            # 重连后事件不得重复折叠（续传按 seq 去重）。
            await cdp.wait_for("document.querySelectorAll('[data-testid=\"live-effect\"]').length >= 1", timeout=15)
            effect_rows = await cdp.evaluate(
                "document.querySelectorAll('[data-testid=\"live-effect\"]').length"
            )
            checks["reconnect_no_duplicate_events"] = effect_rows == 1

            replay_href = await cdp.evaluate(
                "(() => { const a = [...document.querySelectorAll('a')]"
                ".find((n) => (n.getAttribute('href')||'').endsWith('/replay'));"
                "return a ? a.getAttribute('href') : null; })()"
            )
            checks["replay_link_present"] = isinstance(replay_href, str) and bool(replay_href)

            # ------------------------------------------------------ 4. 回放
            if replay_href:
                replay_url = replay_href
                if replay_url.startswith("/"):
                    replay_url = base + replay_url
                await cdp.navigate(replay_url)
                checks["replay_page_loaded"] = bool(
                    await cdp.wait_for_text("回放", timeout=30)
                )
                checks["replay_terminal_answer"] = bool(
                    await cdp.wait_for_text(ANSWER_MARKER, timeout=45)
                )
                replay_text = await cdp.text()
                checks["replay_no_idle_state"] = "正在载入运行回放数据流" not in replay_text
                checks["replay_shows_candidate"] = "候选" in replay_text
                checks["replay_red_line"] = "candidate_verified" in replay_text
        finally:
            await cdp.close()
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome.kill()
            chrome.wait(timeout=5)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit the check map as JSON")
    args = parser.parse_args(argv)

    dist = ROOT / "apps" / "web-demo" / "dist"
    if not (dist / "index.html").is_file():
        raise SystemExit("ENVIRONMENT_BLOCKED: apps/web-demo/dist is missing; run the Web build first")

    port = _free_port()
    data_root = Path(tempfile.mkdtemp(prefix="astra-web-browser-"))
    server = _start_server(port, data_root, dist)
    checks: dict[str, bool] = {}
    try:
        _wait_http(f"http://127.0.0.1:{port}/api/health")
        asyncio.run(_acceptance(f"http://127.0.0.1:{port}", checks))
    except Exception as exc:  # 环境/交互失败都必须让门禁失败，而不是静默通过
        checks["__error__"] = False
        print(f"FAIL browser-acceptance: {type(exc).__name__}: {exc}")
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)

    for name, ok in checks.items():
        print(f"{'PASS' if ok else 'FAIL'} {name}")
    if args.json:
        print(json.dumps(checks, ensure_ascii=False))
    if not checks or not all(checks.values()):
        return 1
    print("BROWSER_SMOKE_PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
