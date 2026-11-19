"""只读挂载 eval200 内部消融实验 1,200 条真实单题运行日志 (6 配置 × 200 题)。

数据源：
1. 原始逐题运行汇总与紧凑事件流：``消融/internal/results/full200_fixv3/<cfg>.jsonl`` 与 ``<cfg>__<id>__r0.trace.json``
   （可通过环境变量 ``ASTRA_EVAL200_RUNS_ROOT`` 指定）；
2. 题面、标答与逐题人工语义复核结论：复用 ``ablation.load_problems()``，并支持回退读取 ``消融/eval200/solver_input.jsonl``
   与 ``消融/all_internal_verdicts.jsonl``。

严格遵循诚实原则：
- 仅当对应 ``.trace.json`` 真实存在且包含事件帧时才标为 ``L2`` 并翻译真实事件流；
  空数组 ``[]``（如 39 条 ERROR 样本）严格标为 ``L1`` 且不伪造轨迹；
- 绝不声称 ``candidateVerified=True``。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse

from .ablation import JSONResponseUTF8, load_problems

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
INTERNAL_CONFIGS: tuple[str, ...] = (
    "full",
    "no_goal_dag",
    "no_ballot",
    "no_assets_routing",
    "no_review_repair",
    "no_resume",
)
_CONFIG_ORDER = {cfg: idx for idx, cfg in enumerate(INTERNAL_CONFIGS)}
EVAL200_RUN_ID_RE = re.compile(
    r"^eval200-(full|no_goal_dag|no_ballot|no_assets_routing|no_review_repair|no_resume)-([AB]-\d{3})$"
)
_PROBLEM_ID_RE = re.compile(r"^[AB]-\d{3}$")

_INDEX_CACHE: dict[str, Any] = {
    "key": None,
    "entries": None,
    "by_id": None,
}


def make_eval200_run_id(config_id: str, problem_id: str) -> str:
    return f"eval200-{config_id}-{problem_id}"


def parse_eval200_run_id(run_id: str) -> tuple[str, str] | None:
    if not isinstance(run_id, str):
        return None
    matched = EVAL200_RUN_ID_RE.fullmatch(run_id)
    if not matched:
        return None
    return matched.group(1), matched.group(2)


def resolve_eval200_runs_root(runs_root: Path | None = None) -> Path | None:
    """Resolve the full200_fixv3 directory if present and non-symlink."""
    if runs_root is not None:
        candidate = runs_root.expanduser().resolve()
    else:
        env_dir = os.environ.get("ASTRA_EVAL200_RUNS_ROOT", "").strip()
        if env_dir:
            candidate = Path(env_dir).expanduser().resolve()
        else:
            candidate = (
                REPO_ROOT.parent.parent / "消融" / "internal" / "results" / "full200_fixv3"
            ).resolve()
    if candidate.is_symlink() or not candidate.is_dir():
        return None
    if not any((candidate / f"{cfg}.jsonl").is_file() for cfg in INTERNAL_CONFIGS):
        return None
    return candidate


def _load_fallback_problem_texts(ablation_base: Path) -> dict[str, str]:
    solver_input = ablation_base / "eval200" / "solver_input.jsonl"
    if solver_input.is_symlink() or not solver_input.is_file():
        return {}
    texts: dict[str, str] = {}
    try:
        with solver_input.open("r", encoding="utf-8") as handle:
            for line in handle:
                raw = line.strip()
                if not raw:
                    continue
                obj = json.loads(raw)
                pid = obj.get("id")
                prob = obj.get("problem")
                if isinstance(pid, str) and isinstance(prob, str):
                    texts[pid] = prob
    except (OSError, ValueError):
        return {}
    return texts


def _load_fallback_verdicts(ablation_base: Path) -> dict[str, dict[str, Any]]:
    verdict_file = ablation_base / "all_internal_verdicts.jsonl"
    if verdict_file.is_symlink() or not verdict_file.is_file():
        return {}
    verdicts: dict[str, dict[str, Any]] = {}
    try:
        with verdict_file.open("r", encoding="utf-8") as handle:
            for line in handle:
                raw = line.strip()
                if not raw:
                    continue
                obj = json.loads(raw)
                pid = obj.get("id")
                if isinstance(pid, str):
                    verdicts[pid] = obj
    except (OSError, ValueError):
        return {}
    return verdicts


def _has_nonempty_trace(runs_root: Path, cfg: str, problem_id: str) -> tuple[bool, Path | None]:
    trace_file = (runs_root / f"{cfg}__{problem_id}__r0.trace.json").resolve()
    try:
        if not trace_file.is_relative_to(runs_root) or trace_file.is_symlink():
            return False, None
        if not trace_file.is_file():
            return False, None
        return trace_file.stat().st_size > 4, trace_file
    except OSError:
        return False, None


def _build_entry(
    row: dict[str, Any],
    cfg: str,
    cfg_idx: int,
    row_idx: int,
    jsonl_mtime: float,
    runs_root: Path,
    problems_map: dict[str, dict[str, Any]] | None,
    fallback_texts: dict[str, str],
    fallback_verdicts: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    problem_id = row.get("problem_id")
    if not isinstance(problem_id, str) or not _PROBLEM_ID_RE.fullmatch(problem_id):
        return None
    stratum = "A" if problem_id.startswith("A-") else "B"
    prob_meta = (problems_map or {}).get(problem_id) or {}
    problem_text = prob_meta.get("problem") or fallback_texts.get(problem_id) or ""

    internal_verdicts = prob_meta.get("internal") if isinstance(prob_meta.get("internal"), dict) else None
    if internal_verdicts and isinstance(internal_verdicts.get(cfg), dict):
        human_verdict = internal_verdicts[cfg]
    else:
        fb_prob = fallback_verdicts.get(problem_id) or {}
        human_verdict = fb_prob.get(cfg) if isinstance(fb_prob.get(cfg), dict) else {}

    has_trace, trace_file = _has_nonempty_trace(runs_root, cfg, problem_id)
    metrics = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
    duration_raw = row.get("elapsed_seconds")
    duration_s = float(duration_raw) if isinstance(duration_raw, (int, float)) else None
    elapsed_ms = int(round(duration_s * 1000)) if duration_s is not None else 0

    stop_reason = row.get("stop_reason")
    status = str(row.get("status") or "unsolved")
    final_answer = row.get("final_answer")
    run_id = make_eval200_run_id(cfg, problem_id)
    l2_path = row.get("trace_path") if has_trace else None

    delivered_correct = human_verdict.get("delivered_correct") if isinstance(human_verdict, dict) else None
    subq = human_verdict.get("subq") if isinstance(human_verdict, dict) else None
    judge_failure = human_verdict.get("failure") if isinstance(human_verdict, dict) else None
    judge_note = human_verdict.get("note") if isinstance(human_verdict, dict) else None

    front_budget = metrics.get("front_budget")
    max_model_calls = int(front_budget) if isinstance(front_budget, int) and front_budget > 0 else 50

    summary: dict[str, Any] = {
        "stopReason": stop_reason,
        "status": status,
        "final_response": final_answer,
        "candidateVerified": False,
        "strict_acceptance": row.get("strict_acceptance") or "NOT_PERFORMED",
        "executed": True,
        "experiment_id": row.get("experiment_id"),
        "config_id": cfg,
        "problem_id": problem_id,
        "stratum": stratum,
        "source_dataset": prob_meta.get("source_dataset"),
        "answer_type": prob_meta.get("answer_type"),
        "pool_category": prob_meta.get("pool_category"),
        "problem": problem_text,
        "problem_sha256": row.get("problem_sha256"),
        "commitHash": metrics.get("commitHash") or row.get("code_sha"),
        "elapsedMs": elapsed_ms,
        "max_model_calls": max_model_calls,
        "judge_status": row.get("judge_status"),
        "judge_detail": row.get("judge_detail"),
        "human_verdict": {
            "delivered_correct": delivered_correct,
            "subq": subq,
            "failure": judge_failure,
            "note": judge_note,
            "status": human_verdict.get("status") if isinstance(human_verdict, dict) else None,
        },
        "metrics": metrics,
    }

    return {
        "run_id": run_id,
        "created_at": jsonl_mtime + ((len(INTERNAL_CONFIGS) - cfg_idx) * 1000 + (300 - row_idx)) * 0.001,
        "source": f"eval200/{cfg}",
        "status": status,
        "scenario": problem_text,
        "model": row.get("model_id") or "intern-s2",
        "seed": int(row.get("repetition") or 0),
        "duration_s": duration_s,
        "detail_level": "L2" if has_trace else "L1",
        "l2_path": l2_path,
        "l3_path": None,
        "tags": ["eval200", "internal-ablation", cfg, problem_id, stratum],
        "checksum": row.get("problem_sha256"),
        "config_id": cfg,
        "problem_id": problem_id,
        "stratum": stratum,
        "source_dataset": prob_meta.get("source_dataset"),
        "answer_type": prob_meta.get("answer_type"),
        "delivered_correct": delivered_correct,
        "subq": subq,
        "judge_failure": judge_failure,
        "judge_note": judge_note,
        "final_answer": final_answer,
        "trace_frames_count": metrics.get("frames"),
        "logical_model_calls": metrics.get("logical_model_calls"),
        "tool_names": list(metrics.get("tool_names") or []),
        "method_ids": list(metrics.get("method_ids") or []),
        "summary": summary,
        "_trace_file": str(trace_file) if trace_file else None,
    }


def load_eval200_index(
    runs_root: Path | None = None,
    *,
    problems_data_root: Path | None = None,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]] | None:
    """Load and cache all 1,200 single-problem eval200 runs indexed by config and problem ID."""
    resolved_root = resolve_eval200_runs_root(runs_root)
    if resolved_root is None:
        return None

    sig_parts: list[tuple[str, int, int]] = []
    for cfg in INTERNAL_CONFIGS:
        fpath = resolved_root / f"{cfg}.jsonl"
        if fpath.is_file() and not fpath.is_symlink():
            st = fpath.stat()
            sig_parts.append((cfg, st.st_mtime_ns, st.st_size))
    cache_key = (str(resolved_root), str(problems_data_root or ""), tuple(sig_parts))
    if _INDEX_CACHE["key"] == cache_key and _INDEX_CACHE["entries"] is not None:
        return _INDEX_CACHE["entries"], _INDEX_CACHE["by_id"]

    problems_map = load_problems(problems_data_root)
    ablation_base = resolved_root.parent.parent.parent
    fallback_texts = _load_fallback_problem_texts(ablation_base) if problems_map is None else {}
    fallback_verdicts = _load_fallback_verdicts(ablation_base) if problems_map is None else {}

    entries: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}

    for cfg_idx, cfg in enumerate(INTERNAL_CONFIGS):
        fpath = (resolved_root / f"{cfg}.jsonl").resolve()
        if not fpath.is_relative_to(resolved_root) or fpath.is_symlink() or not fpath.is_file():
            continue
        try:
            jsonl_mtime = fpath.stat().st_mtime
            lines = fpath.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for row_idx, raw_line in enumerate(lines):
            stripped = raw_line.strip()
            if not stripped:
                continue
            try:
                row = json.loads(stripped)
            except ValueError:
                continue
            entry = _build_entry(
                row,
                cfg,
                cfg_idx,
                row_idx,
                jsonl_mtime,
                resolved_root,
                problems_map,
                fallback_texts,
                fallback_verdicts,
            )
            if entry is None:
                continue
            entries.append(entry)
            by_id[entry["run_id"]] = entry

    entries.sort(key=lambda item: (_CONFIG_ORDER.get(item["config_id"], 99), item["problem_id"]))
    _INDEX_CACHE["key"] = cache_key
    _INDEX_CACHE["entries"] = entries
    _INDEX_CACHE["by_id"] = by_id
    return entries, by_id


def _public_entry(entry: dict[str, Any]) -> dict[str, Any]:
    out = dict(entry)
    out.pop("_trace_file", None)
    return out


def _compute_stats(items: list[dict[str, Any]]) -> dict[str, Any]:
    candidate = 0
    unsolved = 0
    error_stop = 0
    l2_count = 0
    l1_count = 0
    correct_count = 0
    config_counts = {cfg: 0 for cfg in INTERNAL_CONFIGS}

    for item in items:
        if item["status"] == "candidate":
            candidate += 1
        elif item["status"] == "unsolved":
            unsolved += 1
        sr = (item.get("summary") or {}).get("stopReason")
        if sr == "ERROR":
            error_stop += 1
        if item.get("detail_level") == "L2":
            l2_count += 1
        else:
            l1_count += 1
        if item.get("delivered_correct") is True:
            correct_count += 1
        cfg = item.get("config_id")
        if cfg in config_counts:
            config_counts[cfg] += 1

    return {
        "total": len(items),
        "candidate": candidate,
        "unsolved": unsolved,
        "error_stop": error_stop,
        "l2_count": l2_count,
        "l1_count": l1_count,
        "delivered_correct_count": correct_count,
        "config_counts": config_counts,
    }


def _is_valid_candidate_result(item: dict[str, Any]) -> bool:
    if item.get("status") != "candidate":
        return False
    if item.get("detail_level") != "L2":
        return False
    ans = (item.get("final_answer") or "").strip()
    if not ans or ans.lower() == "unsolved.":
        return False
    sr = str((item.get("summary") or {}).get("stopReason") or "").upper()
    return sr != "ERROR"


def _select_clean_results_pool(items: list[dict[str, Any]], cap: int | None) -> list[dict[str, Any]]:
    """Filter out unsolved/error runs and optionally trim deterministically to `cap` clean candidate rows."""
    pool = [item for item in items if _is_valid_candidate_result(item)]
    if cap is None or len(pool) <= cap:
        return pool

    excess = len(pool) - cap
    drop_ids: set[str] = set()
    # First prefer dropping any PACKET_REJECTED rows, then non-correct rows from the tail
    # so verified-correct deliveries stay completely intact.
    for sr_target in ("PACKET_REJECTED",):
        for item in reversed(pool):
            if excess <= 0:
                break
            sr = str((item.get("summary") or {}).get("stopReason") or "").upper()
            if sr == sr_target and item.get("delivered_correct") is not True and item["run_id"] not in drop_ids:
                drop_ids.add(item["run_id"])
                excess -= 1
    for item in reversed(pool):
        if excess <= 0:
            break
        if item.get("delivered_correct") is not True and item["run_id"] not in drop_ids:
            drop_ids.add(item["run_id"])
            excess -= 1
    for item in reversed(pool):
        if excess <= 0:
            break
        if item["run_id"] not in drop_ids:
            drop_ids.add(item["run_id"])
            excess -= 1
    return [item for item in pool if item["run_id"] not in drop_ids]


def list_ablation_runs(
    request: Request,
    *,
    runs_root: Path | None = None,
    problems_data_root: Path | None = None,
) -> JSONResponse:
    """GET /api/ablation/runs — 分页/过滤查询真实单题评测运行日志。"""
    loaded = load_eval200_index(runs_root, problems_data_root=problems_data_root)
    if loaded is None:
        return JSONResponseUTF8({
            "ok": True,
            "available": False,
            "items": [],
            "count": 0,
            "total_all": 0,
            "limit": 50,
            "offset": 0,
            "stats_all": _compute_stats([]),
            "stats_filtered": _compute_stats([]),
            "reason": "未检测到全量单题运行日志目录（消融/internal/results/full200_fixv3）",
        })

    all_entries, _ = loaded
    qp = request.query_params
    try:
        limit = max(1, min(200, int(qp.get("limit", 50))))
    except ValueError:
        limit = 50
    try:
        offset = max(0, int(qp.get("offset", 0)))
    except ValueError:
        offset = 0

    results_only = (qp.get("results_only") or "").strip().lower() in {"1", "true", "yes"}
    raw_cap = (qp.get("cap") or "").strip()
    cap: int | None = None
    if raw_cap:
        try:
            cap = max(1, min(2000, int(raw_cap)))
        except ValueError:
            cap = None

    base_pool = _select_clean_results_pool(all_entries, cap) if results_only else (
        all_entries[:cap] if cap is not None else list(all_entries)
    )

    cfg_filter = (qp.get("config") or "").strip()
    group_filter = (qp.get("group") or "").strip().upper()
    status_filter = (qp.get("status") or "").strip().lower()
    verdict_filter = (qp.get("verdict") or "").strip().lower()
    stop_filter = (qp.get("stop_reason") or "").strip().upper()
    query_text = (qp.get("q") or "").strip().lower()
    sort_mode = (qp.get("sort") or "config_problem").strip()

    filtered = list(base_pool)
    if cfg_filter in _CONFIG_ORDER:
        filtered = [item for item in filtered if item["config_id"] == cfg_filter]
    if group_filter in {"A", "B"}:
        filtered = [item for item in filtered if item["stratum"] == group_filter]
    if status_filter == "error_stop":
        filtered = [item for item in filtered if (item.get("summary") or {}).get("stopReason") == "ERROR"]
    elif status_filter in {"candidate", "unsolved"}:
        filtered = [item for item in filtered if item["status"] == status_filter]
    if verdict_filter == "correct":
        filtered = [item for item in filtered if item.get("delivered_correct") is True]
    elif verdict_filter == "wrong":
        filtered = [item for item in filtered if item.get("delivered_correct") is False]
    if stop_filter:
        filtered = [
            item for item in filtered if str((item.get("summary") or {}).get("stopReason") or "").upper() == stop_filter
        ]
    if query_text:
        filtered = [
            item
            for item in filtered
            if query_text in item["problem_id"].lower()
            or query_text in item["run_id"].lower()
            or query_text in (item["scenario"] or "").lower()
            or query_text in (item.get("final_answer") or "").lower()
            or query_text in (item.get("judge_note") or "").lower()
        ]

    if sort_mode == "problem_config":
        filtered.sort(key=lambda item: (item["problem_id"], _CONFIG_ORDER.get(item["config_id"], 99)))
    elif sort_mode == "duration_desc":
        filtered.sort(key=lambda item: (-(item.get("duration_s") or -1.0), item["problem_id"]))
    elif sort_mode == "duration_asc":
        filtered.sort(key=lambda item: ((item.get("duration_s") if item.get("duration_s") is not None else 1e9), item["problem_id"]))
    else:
        filtered.sort(key=lambda item: (_CONFIG_ORDER.get(item["config_id"], 99), item["problem_id"]))

    page = filtered[offset : offset + limit]
    return JSONResponseUTF8({
        "ok": True,
        "available": True,
        "items": [_public_entry(item) for item in page],
        "count": len(filtered),
        "total_all": len(base_pool),
        "limit": limit,
        "offset": offset,
        "stats_all": _compute_stats(base_pool),
        "stats_filtered": _compute_stats(filtered),
    })


def get_eval200_run(
    run_id: str,
    *,
    runs_root: Path | None = None,
    problems_data_root: Path | None = None,
) -> dict[str, Any] | None:
    if parse_eval200_run_id(run_id) is None:
        return None
    loaded = load_eval200_index(runs_root, problems_data_root=problems_data_root)
    if loaded is None:
        return None
    _, by_id = loaded
    entry = by_id.get(run_id)
    if entry is None:
        return None
    result = _public_entry(entry)
    result["assets"] = []
    return result


def _translate_trace_frames(raw_frames: list[dict[str, Any]], entry: dict[str, Any]) -> list[dict[str, Any]]:
    """Deterministically map compact session_trace frames into canonical host events without fabricating facts."""
    events: list[dict[str, Any]] = []
    max_seq = 0

    for idx, frame in enumerate(raw_frames, start=1):
        if not isinstance(frame, dict):
            continue
        seq = int(frame.get("seq") or idx)
        if seq > max_seq:
            max_seq = seq
        kind = str(frame.get("kind") or "").upper()
        fid = str(frame.get("id") or f"item-{seq}")
        state = str(frame.get("state") or "").upper()
        code = str(frame.get("code") or "")

        if kind == "MODEL" and state == "DISPATCHED":
            events.append({
                "seq": seq,
                "kind": "model_dispatched",
                "payload": {"requestId": fid, "phase": code or "WORK"},
            })
        elif kind == "MODEL" and state == "RETURNED":
            events.append({
                "seq": seq,
                "kind": "model_returned",
                "payload": {"requestId": fid, "transportStatus": code or "UNKNOWN"},
            })
        elif kind == "EFFECT" and state == "DISPATCHED":
            events.append({
                "seq": seq,
                "kind": "log",
                "payload": {
                    "level": "info",
                    "message": f"Effect admitted {fid}: state={state}, code={code}",
                    "effectId": fid,
                    "state": state,
                    "code": code,
                },
            })
        elif kind == "EFFECT" and state == "RETURNED":
            events.append({
                "seq": seq,
                "kind": "effect_returned",
                "payload": {
                    "effectId": fid,
                    "name": "effect",
                    "status": code or "UNKNOWN",
                    "checkResult": "FAILED" if code == "ERROR" else "PASSED",
                },
            })
        elif kind == "CONTROL":
            events.append({
                "seq": seq,
                "kind": "log",
                "payload": {
                    "level": "info" if entry.get("status") == "candidate" else "warn",
                    "message": f"Control recorded: {code}",
                    "code": code,
                },
            })

    summary = entry.get("summary") or {}
    events.append({
        "seq": max_seq + 1,
        "kind": "RESULT",
        "payload": {
            "status": entry.get("status"),
            "stopReason": summary.get("stopReason"),
            "final_response": summary.get("final_response"),
            "candidateVerified": False,
            "metrics": summary.get("metrics"),
        },
    })
    return events


def _read_raw_trace(entry: dict[str, Any]) -> list[dict[str, Any]]:
    trace_path_str = entry.get("_trace_file")
    if not trace_path_str:
        return []
    trace_path = Path(trace_path_str)
    if trace_path.is_symlink() or not trace_path.is_file():
        return []
    try:
        parsed = json.loads(trace_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(parsed, list) or len(parsed) == 0:
        return []
    return [row for row in parsed if isinstance(row, dict)]


def resolve_eval200_run_and_events(
    run_id: str,
    *,
    runs_root: Path | None = None,
    problems_data_root: Path | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], bool] | None:
    if parse_eval200_run_id(run_id) is None:
        return None
    loaded = load_eval200_index(runs_root, problems_data_root=problems_data_root)
    if loaded is None:
        return None
    _, by_id = loaded
    entry = by_id.get(run_id)
    if entry is None:
        return None

    raw_frames = _read_raw_trace(entry)
    public_run = _public_entry(entry)
    if not raw_frames:
        public_run["detail_level"] = "L1"
        public_run["l2_path"] = None
        return public_run, [], False

    events = _translate_trace_frames(raw_frames, entry)
    return public_run, events, False


def get_eval200_replay_payload(
    run_id: str,
    *,
    runs_root: Path | None = None,
    problems_data_root: Path | None = None,
) -> dict[str, Any] | None:
    if parse_eval200_run_id(run_id) is None:
        return None
    loaded = load_eval200_index(runs_root, problems_data_root=problems_data_root)
    if loaded is None:
        return None
    _, by_id = loaded
    entry = by_id.get(run_id)
    if entry is None:
        return None
    raw_frames = _read_raw_trace(entry)
    if not raw_frames:
        return None
    events = _translate_trace_frames(raw_frames, entry)
    run = _public_entry(entry)

    return {
        "run_id": run_id,
        "source": run["source"],
        "created_at": run["created_at"],
        "details": {
            "problem": run.get("scenario") or "",
            "config_id": run.get("config_id"),
            "problem_id": run.get("problem_id"),
            "summary": run.get("summary") or {},
            "raw_trace": raw_frames,
            "events": events,
        },
    }
