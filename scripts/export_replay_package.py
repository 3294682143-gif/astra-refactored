"""F-13 时间胶囊导出器：把黄金 run 的 L2 存档导出为独立可回放 replay-package。

目录结构：
  release/replay-packages/{domain}/{run_id}/
    manifest.json      # 版本/来源/runId/SHA256 校验/复跑命令
    details.json       # L2 全量存档（events + summary，原样拷贝）
    README.md          # 离线回放步骤（web /runs/{id}/replay + 复跑脚本指引）

诚实性：details.json 原样拷贝并附 SHA256；manifest 记录导出时间、源路径、
生产入口（mock provider 或真实 atria），不做任何内容修饰。
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import sys
import time

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA_ROOT = pathlib.Path(os.environ.get("ASTRA_DATA_ROOT", REPO_ROOT / "var" / "astra"))
OUT_ROOT = REPO_ROOT / "release" / "replay-packages"

GOLDEN_RUNS = [
    ("math", "golden_math_20261030_v3"),
    ("control", "p0_curl_idemp_1793336256"),
    ("data_analysis", "p1_curl_da_idemp_20261030"),
    ("scientific_computing", "golden_scicomp_20261030"),
]


def sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    exported = []
    for domain, run_id in GOLDEN_RUNS:
        src = DATA_ROOT / "runs" / run_id / "details.json"
        if not src.is_file():
            print(f"[SKIP] {domain}/{run_id}: L2 存档不存在 {src}")
            continue
        out_dir = OUT_ROOT / domain / run_id
        out_dir.mkdir(parents=True, exist_ok=True)
        dst = out_dir / "details.json"
        shutil.copyfile(src, dst)

        summary = json.loads(dst.read_text(encoding="utf-8")).get("summary", {})
        manifest = {
            "replayVersion": "1.0.0",
            "runId": run_id,
            "domainId": (summary.get("metadata") or {}).get("domainId", domain),
            "problem": summary.get("problem"),
            "status": summary.get("status"),
            "stopReason": summary.get("stopReason"),
            "provider": summary.get("provider"),
            "candidateVerified": summary.get("candidate_verified", summary.get("candidateVerified")),
            "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sourcePath": str(src.relative_to(REPO_ROOT)),
            "detailsSha256": sha256_file(dst),
            "replay": {
                "web": f"启动 BFF 后访问 /runs/{run_id}/replay",
                "verify": f"python -c \"import hashlib,pathlib;print(hashlib.sha256(pathlib.Path('details.json').read_bytes()).hexdigest())\"",
            },
        }
        (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        (out_dir / "README.md").write_text(
            f"# 时间胶囊 · {domain} / {run_id}\n\n"
            f"- 状态：{summary.get('status')}（stopReason={summary.get('stopReason')}）\n"
            f"- provider：{summary.get('provider')}（candidateVerified={manifest['candidateVerified']}）\n"
            f"- 离线回放：`details.json` 为 L2 全量存档原样拷贝（SHA256 见 manifest.json）；\n"
            f"  将其放入 ASTRA_DATA_ROOT/runs/{run_id}/ 后启动 BFF，访问 /runs/{run_id}/replay。\n"
            f"- 复跑：问题文本见 manifest.json 的 problem 字段，经 POST /api/v2/runs 同域重跑对比。\n",
            encoding="utf-8",
        )
        exported.append((domain, run_id, manifest["detailsSha256"][:12]))
        print(f"[OK] {domain}/{run_id} sha256={manifest['detailsSha256'][:12]} status={manifest['status']}")

    print(f"EXPORTED {len(exported)}/{len(GOLDEN_RUNS)}")
    assert len(exported) == len(GOLDEN_RUNS), "有黄金题未导出"


if __name__ == "__main__":
    main()
