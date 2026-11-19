"""静态消融实验汇总数据（eval200 外部 3 + 内部 6 九组配置）只读接口。

数据源：仓库内 ``ablation_data/summary.json``，由逐题人工语义复核产物离线生成，
不含题目文本与标准答案（隐藏测试数据不入仓）。缺失或损坏时如实返回不可用，
不做任何估算或编造。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse

DATA_ROOT = Path(__file__).resolve().parent / "ablation_data"
SUMMARY_BYTE_LIMIT = 2 * 1024 * 1024


class JSONResponseUTF8(JSONResponse):
    media_type = "application/json; charset=utf-8"


def load_summary(data_root: Path | None = None) -> dict[str, Any] | None:
    root = (data_root or DATA_ROOT).resolve()
    summary_path = root / "summary.json"
    if root.is_symlink() or summary_path.is_symlink() or not summary_path.is_file():
        return None
    try:
        if summary_path.stat().st_size > SUMMARY_BYTE_LIMIT:
            return None
        with summary_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("configs"), list):
        return None
    return payload


def ablation_summary(request: Request) -> JSONResponse:
    summary = load_summary()
    if summary is None:
        return JSONResponseUTF8(
            {"ok": False, "error": "ablation summary unavailable"}, status_code=503
        )
    return JSONResponseUTF8({"ok": True, "data": summary})


_PROBLEM_ID_PATTERN = re.compile(r"^[AB]-\d{3}$")
_PROBLEMS_CACHE: dict[str, Any] = {"mtime": None, "items": None}


def load_problems(data_root: Path | None = None) -> dict[str, dict[str, Any]] | None:
    """Load per-problem verdict details, cached by file mtime."""
    root = (data_root or DATA_ROOT).resolve()
    path = root / "problems.jsonl"
    if root.is_symlink() or path.is_symlink() or not path.is_file():
        return None
    try:
        mtime = path.stat().st_mtime
        if _PROBLEMS_CACHE["items"] is not None and _PROBLEMS_CACHE["mtime"] == mtime:
            return _PROBLEMS_CACHE["items"]
        items: dict[str, dict[str, Any]] = {}
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                item = json.loads(line)
                pid = item.get("id")
                if not isinstance(pid, str) or not _PROBLEM_ID_PATTERN.fullmatch(pid):
                    return None
                items[pid] = item
    except (OSError, ValueError):
        return None
    _PROBLEMS_CACHE["mtime"] = mtime
    _PROBLEMS_CACHE["items"] = items
    return items


def list_ablation_problems(request: Request) -> JSONResponse:
    problems = load_problems()
    if problems is None:
        return JSONResponseUTF8(
            {"ok": False, "error": "ablation problems unavailable"}, status_code=503
        )
    offset = max(0, int(request.query_params.get("offset", 0)))
    limit = min(100, max(1, int(request.query_params.get("limit", 25))))
    group = request.query_params.get("group")
    pool_category = request.query_params.get("pool_category")
    rows = sorted(problems.values(), key=lambda item: item["id"])
    if group in {"A", "B"}:
        rows = [item for item in rows if item["id"].startswith(group + "-")]
    if pool_category:
        rows = [item for item in rows if item.get("pool_category") == pool_category]
    page = rows[offset:offset + limit]
    items = [
        {
            "id": item["id"],
            "answer_type": item.get("answer_type"),
            "source_dataset": item.get("source_dataset"),
            "pool_category": item.get("pool_category"),
            "verdicts": {
                cfg: verdict.get("delivered_correct")
                for cfg, verdict in {**item["external"], **item["internal"]}.items()
            },
        }
        for item in page
    ]
    return JSONResponseUTF8({"ok": True, "items": items, "count": len(rows), "offset": offset, "limit": limit})


def get_ablation_problem(request: Request) -> JSONResponse:
    problem_id = request.path_params.get("problem_id", "")
    if not _PROBLEM_ID_PATTERN.fullmatch(problem_id):
        return JSONResponseUTF8({"ok": False, "error": "invalid problem id"}, status_code=400)
    problems = load_problems()
    if problems is None:
        return JSONResponseUTF8(
            {"ok": False, "error": "ablation problems unavailable"}, status_code=503
        )
    item = problems.get(problem_id)
    if item is None:
        return JSONResponseUTF8({"ok": False, "error": "problem not found"}, status_code=404)
    return JSONResponseUTF8({"ok": True, "data": item})
