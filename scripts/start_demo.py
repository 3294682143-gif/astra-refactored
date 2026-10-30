#!/usr/bin/env python3
"""Track160 一键演示启动（跨平台版）：BFF(8011) + mock-gateway(8787) + inkstone UI(8899)。

无真实 key 时走诚实不可用路径（SOLVER_NOT_CONFIGURED）；
协议观测台走 mock 合成源并在 UI 标注 synthetic。
Ctrl+C 统一退出并回收子进程。
"""
from __future__ import annotations

import os
import pathlib
import signal
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INKSTONE = pathlib.Path(os.environ.get("INKSTONE_RE_LAB_ROOT", r"D:\书生\inkstone-re-lab"))

env = dict(os.environ)
env.setdefault("ASTRA_DATA_ROOT", str(ROOT / "var" / "astra"))
env.setdefault("ASTRA_WEB_DIST", str(ROOT / "apps" / "web-demo" / "dist"))
env.setdefault("ASTRA_PROTOCOL_SOURCE", "mock")
env.setdefault("INKSTONE_GATEWAY_URL", "http://127.0.0.1:8787")

procs = [
    subprocess.Popen(
        ["node", str(INKSTONE / "tools" / "mock-gateway.mjs"), "--port", "8787", "--host", "127.0.0.1"],
        env=env,
    ),
    subprocess.Popen(["node", str(INKSTONE / "tools" / "aiyan-ui.mjs")], env=env),
    subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "python.astra_web.app:app", "--host", "127.0.0.1", "--port", "8011"],
        cwd=str(ROOT),
        env=env,
    ),
]

print("AI4S 驾驶舱   -> http://127.0.0.1:8011/home")
print("智衍·衡鉴     -> http://127.0.0.1:8899/ (导航末项「AI4S 驾驶舱」深链回 8011)")
print("mock-gateway  -> http://127.0.0.1:8787/health (synthetic)")
print("Ctrl+C 退出并回收全部子进程")


def shutdown(*_args) -> None:
    for p in procs:
        p.terminate()
    sys.exit(0)


signal.signal(signal.SIGINT, shutdown)
signal.signal(signal.SIGTERM, shutdown)
for p in procs:
    p.wait()
