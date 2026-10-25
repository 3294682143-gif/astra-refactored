#!/usr/bin/env python3
"""Run the Web/math integration gates and write an evidence-backed report.

This reporter never converts a skipped, errored or timed-out command into PASS.
Use ``--strict`` in the final gate; the process exits non-zero if any required
command fails.
"""
from __future__ import annotations

import argparse
import glob
import glob
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs" / "WEB_MATH_INTEGRATION_ACCEPTANCE.md"
EVIDENCE = ROOT / "var" / "web-math-integration" / "evidence.json"


def _run(name: str, argv: list[str], cwd: Path | None = None, timeout: int = 600) -> dict:
    started = time.time()
    base = cwd or ROOT
    expanded: list[str] = []
    for arg in argv:
        if "*" in arg:
            pattern = str(base / arg) if not Path(arg).is_absolute() else arg
            matches = sorted(glob.glob(pattern))
            expanded.extend(matches if matches else [arg])
        else:
            expanded.append(arg)
    try:
        proc = subprocess.run(
            expanded,
            cwd=str(base),
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        code = proc.returncode
        stdout, stderr = proc.stdout, proc.stderr
        status = "PASS" if code == 0 else "FAIL"
    except subprocess.TimeoutExpired as exc:
        code = None
        stdout = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        stderr = (exc.stderr or "") if isinstance(exc.stderr, str) else ""
        status = "TIMEOUT"
    except Exception as exc:  # noqa: BLE001 - report the actual exception
        code = None
        stdout = ""
        stderr = f"{type(exc).__name__}: {exc}"
        status = "FAIL"
    return {
        "name": name,
        "argv": expanded,
        "cwd": str(base),
        "status": status,
        "exitCode": code,
        "durationSeconds": round(time.time() - started, 2),
        "stdoutTail": stdout[-4000:],
        "stderrTail": stderr[-4000:],
    }


def _catalog_summary() -> dict:
    sys.path.insert(0, str(ROOT))
    from python.astra_web.math_assets_catalog import summary_payload

    try:
        return summary_payload()
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--out", type=Path, default=DOC)
    args = parser.parse_args(argv)

    py = sys.executable
    node = "node"
    web = ROOT / "apps" / "web-demo"
    ts = ROOT / "node_modules" / "typescript" / "bin" / "tsc"
    esbuild = ROOT / "node_modules" / "esbuild" / "bin" / "esbuild"
    web_tsc = web / "node_modules" / ".bin" / "tsc"
    web_vite = web / "node_modules" / ".bin" / "vite"

    commands = [
        ("math-assets-generated-check", [py, "scripts/build_math_assets.py", "--check"], ROOT),
        ("protocol-v14-check", [py, "packages/protocol/scripts/build_agent_host_v14_schema.py", "--check"], ROOT),
        ("release-manifest-verify", [py, "scripts/build_release_manifest.py", "--verify", "release/BUILD_MANIFEST.json"], ROOT),
        ("web-schema-check", [py, "-m", "python.astra_web.contracts.schema_export", "--check", "--out", "packages/web-contract/schema"], ROOT),
        ("web-manifest-check", [py, "scripts/sync_web_release_manifest.py", "--check"], ROOT),
        ("tsc", [node, str(ts), "-b"], ROOT),
        ("node-tests", [node, "--test", "packages/protocol/dist/tests/*.test.js", "apps/stdio-runtime/dist/tests/*.test.js"], ROOT),
        ("web-logic-tests", [node, "--test", "apps/web-demo/src/domain/__tests__/*.test.ts"], ROOT),
        ("web-typecheck", [str(web_tsc), "-p", "tsconfig.json", "--noEmit"], web),
        ("web-build", [str(web_vite), "build"], web),
        ("browser-smoke", [py, "scripts/web_browser_smoke.py"], ROOT),
        ("web-unit-bff", [py, "-m", "pytest", "-q", "-p", "no:cacheprovider",
                          "tests/test_web_bff.py", "tests/test_web_contract.py",
                          "tests/test_web_math_assets.py", "tests/test_web_solver_adapter.py",
                          "tests/test_web_public_chat_port.py",
                          "tests/test_web_restart_recovery.py",
                          "tests/test_web_review_regressions.py",
                          "tests/e2e/test_web_math_failure_paths.py",
                          "tests/e2e/test_web_math_streaming.py",
                          # 超时安全：派发即计数、迟到结果不得改写已交付计数
                          "tests/e2e/test_ts_entry_safety.py"], ROOT),
        ("bff-82", [py, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/e2e/test_web_math_assets_82_e2e.py"], ROOT),
        ("core-82", [py, "tests/e2e/test_ts_math_assets_82_e2e.py"], ROOT),
    ]
    results = [_run(name, argv, cwd=cwd) for name, argv, cwd in commands]
    catalog = _catalog_summary()
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    status = subprocess.run(["git", "status", "--short"], cwd=ROOT, capture_output=True, text=True).stdout.splitlines()
    failed = [row for row in results if row["status"] != "PASS"]
    overall = "PASS" if not failed and not catalog.get("error") else "FAIL"

    report = {
        "schemaVersion": "web-math-integration-evidence-v1",
        "generatedAt": int(time.time()),
        "gitHead": head,
        "dirty": bool(status),
        "workingTree": status[:100],
        "python": platform.python_version(),
        "platform": platform.platform(),
        "catalog": catalog,
        "commands": results,
        "overall": overall,
    }
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Web 与统一数学资产整合验收报告",
        "",
        f"- 生成时间（epoch）：`{report['generatedAt']}`",
        f"- Git HEAD：`{head}`",
        f"- 工作树有未提交改动：`{report['dirty']}`",
        f"- Python：`{report['python']}`；平台：`{report['platform']}`",
        f"- 规范目录：{catalog.get('assetCount', '未取得')} 项资产 / {catalog.get('computationBehaviorCount', '未取得')} 项行为 / {catalog.get('guidanceOnlyCount', '未取得')} 项仅指导",
        f"- catalogVersion：`{catalog.get('catalogVersion', '未取得')}`",
        f"- catalogDigest：`{catalog.get('catalogDigest', '未取得')}`",
        f"- **总体判定：{overall}**",
        "",
        "| 门禁 | 状态 | 退出码 | 耗时(s) |",
        "|---|---|---:|---:|",
    ]
    for row in results:
        lines.append(f"| `{row['name']}` | {row['status']} | {row['exitCode']} | {row['durationSeconds']} |")
    lines += ["", "## 命令与输出尾部", ""]
    for row in results:
        lines += [
            f"### {row['name']}",
            "",
            f"- 命令：`{' '.join(row['argv'])}`",
            f"- 工作目录：`{row['cwd']}`",
            f"- 状态：`{row['status']}`，退出码：`{row['exitCode']}`",
            "",
            "```text",
            (row["stdoutTail"] + ("\n" + row["stderrTail"] if row["stderrTail"] else "")).strip(),
            "```",
            "",
        ]
    lines += [
        "## 可离线复跑的最小门禁子集",
        "",
        "复核环境若缺少 Node、浏览器或部分 Python 依赖，下列命令只依赖 Python stdlib + pytest",
        "（或完全不依赖 pytest），足以独立判定四类边界回归与资产/协议/清单一致性：",
        "",
        "```bash",
        "# 四类边界回归（R1 PID 复用 / R2 终态落盘窗口 / R3 请求配对 / R4 未发送）",
        "python3 -m pytest -q tests/test_web_review_regressions.py",
        "# 同一组边界的 pytest-free 探针（输出 JSON，all_passed 即结论）",
        "python3 tests/web_review/probe_restart_recovery.py .",
        "# 恢复与生产客户端回归（含 Host 真实事件 → 重启恢复链路）",
        "python3 -m pytest -q tests/test_web_restart_recovery.py tests/test_web_public_chat_port.py",
        "# 资产 / 协议 / 发布清单",
        "python3 scripts/build_math_assets.py --check",
        "python3 packages/protocol/scripts/build_agent_host_v14_schema.py --check",
        "python3 scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json",
        "python3 scripts/sync_web_release_manifest.py --check",
        "```",
        "",
        "## 边界说明",
        "",
        "- 本报告只记录真实命令输出；失败、超时和未执行不会被写成 PASS。",
        "- 82 项测试只替代远端模型响应；Node、Host、统一数学资产执行和 BFF 均为正式代码。",
        "- `candidate_verified` 始终为 `False`；计算行为成功不等于整题数学证明。",
        "- 本报告不包含任何已执行的真实外部模型评测；如需真实模型结果，必须另记独立证据。",
        "",
    ]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    print(f"REPORT {args.out} overall={overall} failed={len(failed)}")
    return 0 if overall == "PASS" or not args.strict else 1


if __name__ == "__main__":
    raise SystemExit(main())
