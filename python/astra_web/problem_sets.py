"""JSONL 题目集导入、持久化与批量执行入口。

支持三种诚实且可追踪的导入模式：
1. ``catalog``（默认）：严格解析并验证 JSONL 题集行（必须含非空 ``problem`` / ``question`` / ``prompt`` / ``scenario``），
   安全落盘于 ``store.root/problem_sets/<set_id>.json``，供浏览与单题发起求解，不擅自触发模型调用；
2. ``enqueue``：在验证并保存题集的同时，经由 ``ExecutionManager.enqueue_run`` 受控单并发入队
   （上限 50 题；未配置真实求解器时队列按既定契约如实以 ``SOLVER_NOT_CONFIGURED`` 收口，绝不伪造答案）；
3. ``replays``：复用 ``replays.import_jsonl_bytes`` 导入历史 SolveResult JSONL 归档。
"""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

from .archive import atomic_write_json
from .config import default_budget
from .replays import ImportValidationError
from .storage import Store

MAX_PROBLEM_SET_BYTES = 4 * 1024 * 1024
MAX_PROBLEM_SET_ITEMS = 1000
MAX_ENQUEUE_ITEMS = 50

_SET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")


def is_valid_problem_set_id(set_id: Any) -> bool:
    return isinstance(set_id, str) and bool(_SET_ID_RE.fullmatch(set_id))


def _extract_problem_text(raw: Mapping[str, Any]) -> str:
    for key in ("problem", "prompt", "question", "scenario", "text"):
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def parse_problem_set_jsonl(jsonl_text: str) -> list[dict[str, Any]]:
    """逐行校验 JSONL 题目集文本，失败抛出带行号的 ``ImportValidationError``。"""
    if not isinstance(jsonl_text, str):
        raise ImportValidationError("jsonl_text must be a string")
    encoded_len = len(jsonl_text.encode("utf-8", errors="ignore"))
    if encoded_len > MAX_PROBLEM_SET_BYTES:
        raise ImportValidationError(f"JSONL payload exceeds {MAX_PROBLEM_SET_BYTES} bytes limit")

    items: list[dict[str, Any]] = []
    for lineno, raw_line in enumerate(jsonl_text.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise ImportValidationError(f"line {lineno}: invalid JSON: {exc}") from exc
        if not isinstance(obj, Mapping):
            raise ImportValidationError(f"line {lineno}: expected a JSON object")

        problem_text = _extract_problem_text(obj)
        if not problem_text:
            raise ImportValidationError(
                f"line {lineno}: missing non-empty 'problem' (or 'question'/'prompt') text"
            )

        item_idx = len(items) + 1
        raw_id = obj.get("id") or obj.get("problem_id")
        item_id = raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else f"P-{item_idx:03d}"

        entry: dict[str, Any] = {
            "index": item_idx,
            "id": item_id,
            "problem": problem_text,
            "stratum": obj.get("stratum") if isinstance(obj.get("stratum"), str) else None,
            "language": obj.get("language") if isinstance(obj.get("language"), str) else None,
            "answer_type": obj.get("answer_type") if isinstance(obj.get("answer_type"), str) else None,
            "source_dataset": obj.get("source_dataset") if isinstance(obj.get("source_dataset"), str) else None,
            "reference_answer": obj.get("reference_answer") if isinstance(obj.get("reference_answer"), str) else None,
        }
        items.append(entry)
        if len(items) > MAX_PROBLEM_SET_ITEMS:
            raise ImportValidationError(f"problem set exceeds maximum of {MAX_PROBLEM_SET_ITEMS} items")

    if not items:
        raise ImportValidationError("JSONL payload contains no problem items")
    return items


def _problem_sets_dir(store: Store) -> Path:
    base = store.safe_join("problem_sets")
    base.mkdir(parents=True, exist_ok=True)
    return base


def save_problem_set(
    store: Store,
    *,
    name: str | None,
    items: list[dict[str, Any]],
    mode: str,
    enqueued_run_ids: list[str] | None = None,
) -> dict[str, Any]:
    set_id = f"pset-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    clean_name = name.strip()[:120] if isinstance(name, str) and name.strip() else set_id
    record = {
        "set_id": set_id,
        "name": clean_name,
        "created_at": time.time(),
        "mode": mode,
        "count": len(items),
        "enqueued_run_ids": list(enqueued_run_ids or []),
        "items": items,
    }
    target = store.safe_join(f"problem_sets/{set_id}.json")
    atomic_write_json(target, record)
    return record


def list_problem_sets(store: Store) -> list[dict[str, Any]]:
    base = _problem_sets_dir(store)
    records: list[dict[str, Any]] = []
    for path in base.glob("*.json"):
        if path.is_symlink() or not path.is_file():
            continue
        set_id = path.stem
        if not is_valid_problem_set_id(set_id):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        items = data.get("items") if isinstance(data.get("items"), list) else []
        records.append({
            "set_id": data.get("set_id") or set_id,
            "name": data.get("name") or set_id,
            "created_at": float(data.get("created_at") or path.stat().st_mtime),
            "mode": data.get("mode") or "catalog",
            "count": len(items),
            "enqueued_run_ids": list(data.get("enqueued_run_ids") or []),
            "sample_preview": (items[0].get("problem") or "")[:90] if items else "",
        })
    records.sort(key=lambda r: (-r["created_at"], r["set_id"]))
    return records


def get_problem_set(store: Store, set_id: str) -> dict[str, Any] | None:
    if not is_valid_problem_set_id(set_id):
        return None
    target = store.safe_join(f"problem_sets/{set_id}.json")
    if target.is_symlink() or not target.is_file():
        return None
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def delete_problem_set(store: Store, set_id: str) -> bool:
    if not is_valid_problem_set_id(set_id):
        return False
    target = store.safe_join(f"problem_sets/{set_id}.json")
    if target.is_symlink() or not target.is_file():
        return False
    target.unlink()
    return True


def build_run_request_for_problem(
    item: Mapping[str, Any],
    *,
    set_id: str,
    max_method_loads: int | None = None,
    problem_seconds: int | None = None,
) -> dict[str, Any]:
    budget = default_budget()
    if max_method_loads is not None:
        budget["max_method_loads"] = max(0, min(4, int(max_method_loads)))
    if problem_seconds is not None:
        budget["problem_seconds"] = max(5, min(7200, int(problem_seconds)))
    return {
        "problem": item["problem"],
        "max_model_calls": budget["max_model_calls"],
        "max_work_units": budget["max_work_units"],
        "max_effects": budget["max_effects"],
        "max_reviews": budget["max_reviews"],
        "max_method_loads": budget["max_method_loads"],
        "max_repairs": budget["max_repairs"],
        "max_consensus": budget["max_consensus"],
        "max_r0": budget["max_r0"],
        "problem_seconds": budget["problem_seconds"],
        "policy": budget["policy"],
        "engine": "ts",
        "idempotency_key": f"{set_id}-{item['index']}",
        "metadata": {
            "source": "problem-set-import",
            "problem_set_id": set_id,
            "problem_item_id": item.get("id"),
            "stratum": item.get("stratum"),
        },
    }
