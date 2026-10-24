"""导入外部 SolveResult JSON / JSONL 历史日志：校验 → 规整 → 入库。

对外契约
--------
* 合法的 SolveResult 必须包含 L1 载荷（``summary`` 或 ``result``）。
* 可选字段：``run_id`` / ``created_at`` / ``status`` / ``scenario`` /
  ``model`` / ``seed`` / ``duration_s`` / ``details`` (L2) / ``artifacts`` (L3) /
  ``tags``。
* run_id 若未提供则自动生成 ``run-<uuid8>``。
* 任何路径字段在落盘前都会经过 ``Store.safe_join``，越界即拒绝。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

from .archive import atomic_write_bytes, atomic_write_json
from .storage import DuplicateRunError, Store, is_valid_run_id

logger = logging.getLogger("astra_web.replays")

__all__ = [
    "ImportValidationError",
    "normalize_run",
    "import_json_bytes",
    "import_json_file",
    "import_jsonl_bytes",
    "import_jsonl_file",
]


class ImportValidationError(ValueError):
    """导入载荷未通过校验。"""


_ARTIFACT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
_ALLOWED_STATUS = {"ok", "failed", "partial", "running"}


# --------------------------------------------------------------------- 校验
def normalize_run(raw: Any, *, source: str) -> dict[str, Any]:
    """校验并规整一条 SolveResult。失败抛 `ImportValidationError`。"""
    if not isinstance(raw, Mapping):
        raise ImportValidationError("run payload must be a JSON object")

    # --- run_id
    run_id = raw.get("run_id")
    if run_id is None:
        run_id = raw.get("id")
    if run_id is None:
        run_id = f"run-{uuid.uuid4().hex[:16]}"
    if not is_valid_run_id(run_id):
        raise ImportValidationError(f"invalid run_id: {run_id!r}")

    # --- L1
    summary = raw.get("summary")
    if summary is None:
        summary = raw.get("result")
    if summary is None:
        raise ImportValidationError("missing L1 payload: 'summary' or 'result' is required")
    try:
        summary_json = json.dumps(summary, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise ImportValidationError(f"L1 payload is not JSON-serializable: {exc}") from exc

    # --- created_at
    created_at = raw.get("created_at")
    if created_at is None:
        created_at = time.time()
    if isinstance(created_at, bool) or not isinstance(created_at, (int, float)):
        raise ImportValidationError("created_at must be a number")

    # --- status
    status = raw.get("status", "ok")
    if status not in _ALLOWED_STATUS:
        raise ImportValidationError(
            f"unsupported status: {status!r}; expected one of {sorted(_ALLOWED_STATUS)}"
        )

    # --- L2
    details = raw.get("details")
    if details is None:
        details = raw.get("trace")
    if details is not None and not isinstance(details, (dict, list)):
        raise ImportValidationError("L2 'details' must be an object or array")

    # --- L3
    artifacts = raw.get("artifacts", [])
    if not isinstance(artifacts, list):
        raise ImportValidationError("'artifacts' must be an array")

    # --- 元数据
    scenario = raw.get("scenario")
    model = raw.get("model")
    seed = raw.get("seed")
    duration_s = raw.get("duration_s")
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int)):
        raise ImportValidationError("seed must be an integer")
    if duration_s is not None and (
        isinstance(duration_s, bool) or not isinstance(duration_s, (int, float))
    ):
        raise ImportValidationError("duration_s must be a number")

    tags_raw = raw.get("tags", [])
    if isinstance(tags_raw, str):
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
    elif isinstance(tags_raw, list) and all(isinstance(t, str) for t in tags_raw):
        tags = [t.strip() for t in tags_raw if t.strip()]
    elif tags_raw == []:
        tags = []
    else:
        raise ImportValidationError("tags must be a string or an array of strings")

    checksum = hashlib.sha256(summary_json.encode("utf-8")).hexdigest()

    return {
        "run_id": run_id,
        "created_at": float(created_at),
        "source": source,
        "status": status,
        "scenario": scenario if isinstance(scenario, str) else None,
        "model": model if isinstance(model, str) else None,
        "seed": seed,
        "duration_s": float(duration_s) if duration_s is not None else None,
        "summary": summary,
        "summary_json": summary_json,
        "details": details,
        "artifacts": artifacts,
        "tags": tags,
        "checksum": checksum,
    }


def _normalize_artifacts(run_id: str, artifacts: list[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for idx, a in enumerate(artifacts):
        if not isinstance(a, Mapping):
            raise ImportValidationError(f"artifact[{idx}] must be an object")

        name = a.get("name")
        if not isinstance(name, str) or not _ARTIFACT_NAME_RE.match(name):
            raise ImportValidationError(
                f"artifact[{idx}].name invalid: {name!r} "
                f"(allowed: alnum . _ - , no separators)"
            )

        text = a.get("text")
        b64 = a.get("data_base64", a.get("base64"))
        if text is not None and b64 is not None:
            raise ImportValidationError(
                f"artifact[{idx}] cannot specify both 'text' and 'data_base64'"
            )
        if text is not None:
            if not isinstance(text, str):
                raise ImportValidationError(f"artifact[{idx}].text must be a string")
            data = text.encode("utf-8")
        elif b64 is not None:
            if not isinstance(b64, str):
                raise ImportValidationError(f"artifact[{idx}].data_base64 must be a string")
            try:
                data = base64.b64decode(b64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ImportValidationError(
                    f"artifact[{idx}].data_base64 is not valid base64"
                ) from exc
        else:
            raise ImportValidationError(
                f"artifact[{idx}] has no payload ('text' or 'data_base64' required)"
            )

        mime = a.get("mime", a.get("content_type", "application/octet-stream"))
        if not isinstance(mime, str):
            raise ImportValidationError(f"artifact[{idx}].mime must be a string")

        kind = a.get("kind", "attachment")
        if not isinstance(kind, str):
            raise ImportValidationError(f"artifact[{idx}].kind must be a string")

        out.append({
            "asset_id": f"{run_id}:{name}",
            "run_id": run_id,
            "kind": kind,
            "name": name,
            "mime": mime,
            "data": data,
            "bytes": len(data),
        })
    return out


# --------------------------------------------------------------------- 落盘
def _persist(store: Store, raw: Any, *, source: str, overwrite: bool) -> dict[str, Any]:
    norm = normalize_run(raw, source=source)
    run_id: str = norm["run_id"]

    if store.has_run(run_id) and not overwrite:
        raise ImportValidationError(f"duplicate run_id: {run_id}")

    run_dir_rel = f"runs/{run_id}"
    store.safe_join(run_dir_rel).mkdir(parents=True, exist_ok=True)

    # L2
    l2_rel: str | None = None
    if norm["details"] is not None:
        l2_rel = f"{run_dir_rel}/details.json"
        atomic_write_json(store.safe_join(l2_rel), norm["details"])

    # L3
    artifacts = _normalize_artifacts(run_id, norm["artifacts"])
    l3_rel: str | None = None
    asset_rows: list[dict[str, Any]] = []
    if artifacts:
        l3_rel = f"{run_dir_rel}/artifacts"
        for art in artifacts:
            rel = f"{l3_rel}/{art['name']}"
            target = store.safe_join(rel)
            atomic_write_bytes(target, art["data"])
            asset_rows.append({
                "asset_id": art["asset_id"],
                "run_id": run_id,
                "kind": art["kind"],
                "rel_path": rel,
                "mime": art["mime"],
                "bytes": art["bytes"],
                "created_at": time.time(),
            })

    record = {
        "run_id": run_id,
        "created_at": norm["created_at"],
        "source": source,
        "status": norm["status"],
        "scenario": norm["scenario"],
        "model": norm["model"],
        "seed": norm["seed"],
        "duration_s": norm["duration_s"],
        "summary_json": norm["summary_json"],
        "l2_path": l2_rel,
        "l3_path": l3_rel,
        "tags": ",".join(norm["tags"]),
        "checksum": norm["checksum"],
    }

    try:
        # 显式覆盖=离线重放导入的刻意动作：允许替换终态行（其余调用方不允许）
        store.save_run(
            record,
            assets=asset_rows,
            overwrite=overwrite,
            allow_terminal_replace=overwrite,
        )
    except DuplicateRunError as exc:
        raise ImportValidationError(str(exc)) from exc

    return {
        "run_id": run_id,
        "created_at": norm["created_at"],
        "source": source,
        "status": norm["status"],
        "scenario": norm["scenario"],
        "summary": norm["summary"],
        "l2_path": l2_rel,
        "l3_path": l3_rel,
        "tags": norm["tags"],
        "checksum": norm["checksum"],
        "assets": len(asset_rows),
    }


# --------------------------------------------------------------------- 入口
def import_json_bytes(
    store: Store,
    blob: bytes | str,
    *,
    source: str = "import-json",
    overwrite: bool = False,
) -> dict[str, Any]:
    """导入单条 SolveResult JSON。"""
    try:
        text = blob.decode("utf-8") if isinstance(blob, (bytes, bytearray)) else blob
    except UnicodeDecodeError as exc:
        raise ImportValidationError(f"payload is not valid UTF-8: {exc}") from exc
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ImportValidationError(f"invalid JSON: {exc}") from exc
    return _persist(store, raw, source=source, overwrite=overwrite)


def import_json_file(
    store: Store,
    path: str | Path,
    *,
    source: str = "import-json",
    overwrite: bool = False,
) -> dict[str, Any]:
    return import_json_bytes(store, Path(path).read_bytes(), source=source, overwrite=overwrite)


def import_jsonl_bytes(
    store: Store,
    blob: bytes | str,
    *,
    source: str = "import-jsonl",
    overwrite: bool = False,
    strict: bool = True,
) -> list[dict[str, Any]]:
    """导入 JSONL 历史日志。

    strict=True  ：任意一行失败即抛 `ImportValidationError`（含行号）。
    strict=False ：跳过坏行并写入 logger，返回成功记录列表。
    """
    try:
        text = blob.decode("utf-8") if isinstance(blob, (bytes, bytearray)) else blob
    except UnicodeDecodeError as exc:
        raise ImportValidationError(f"payload is not valid UTF-8: {exc}") from exc

    results: list[dict[str, Any]] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            raw = json.loads(stripped)
        except json.JSONDecodeError as exc:
            msg = f"line {lineno}: invalid JSON: {exc}"
            if strict:
                raise ImportValidationError(msg) from exc
            logger.warning(msg)
            continue
        try:
            results.append(_persist(store, raw, source=source, overwrite=overwrite))
        except ImportValidationError as exc:
            msg = f"line {lineno}: {exc}"
            if strict:
                raise ImportValidationError(msg) from exc
            logger.warning(msg)
            continue
    return results


def import_jsonl_file(
    store: Store,
    path: str | Path,
    *,
    source: str = "import-jsonl",
    overwrite: bool = False,
    strict: bool = True,
) -> list[dict[str, Any]]:
    return import_jsonl_bytes(
        store, Path(path).read_bytes(),
        source=source, overwrite=overwrite, strict=strict,
    )
