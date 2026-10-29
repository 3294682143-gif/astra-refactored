# D-03 只读 BFF、导入与存档实现

以下代码可直接落地到 `python/astra_web/`，无需修改即可运行测试。

## 1. `python/astra_web/__init__.py`

```python
"""Astra Web BFF (Backend-for-Frontend).

只读接口：从 SQLite 索引 + 文件存档中读取运行记录 / 回放 / 资产。
外部 SolveResult 的导入与校验由 `replays` 模块提供（库/CLI 使用，不经 HTTP 暴露）。
"""
from __future__ import annotations

__version__ = "0.1.0"
__all__ = ["__version__"]
```

## 2. `python/astra_web/storage.py`

```python
"""SQLite 索引 + 文件存档的存储层。

目录布局（root 由环境变量 ASTRA_DATA_ROOT 或调用方指定）::

    <root>/
        index.db
        runs/<run_id>/details.json          # L2 详细存档（可选）
        runs/<run_id>/artifacts/<name>      # L3 附件（可选）
        assets/                             # 预留给未来只读资产托管

安全约束
--------
* `run_id` 必须匹配 ``^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`` 且不含 ``..``。
* 所有落盘路径必须经过 `Store.safe_join()`，该方法在 `resolve()` 之后
  强制要求目标位于 `root` 之内，从而阻断 ``../../etc/passwd`` 之类的穿越。
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

SCHEMA_VERSION = 1

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class StorageError(RuntimeError):
    """存储层通用错误。"""


class PathTraversalError(StorageError):
    """路径越界（穿越尝试）。"""


class DuplicateRunError(StorageError):
    """run_id 已存在且未开启 overwrite。"""


def is_valid_run_id(run_id: Any) -> bool:
    """run_id 白名单校验：非空、无 `..`、符合字符集。"""
    if not isinstance(run_id, str) or not run_id:
        return False
    if ".." in run_id:
        return False
    return _RUN_ID_RE.match(run_id) is not None


_DDL = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    run_id       TEXT PRIMARY KEY,
    created_at   REAL NOT NULL,
    source       TEXT NOT NULL,
    status       TEXT NOT NULL,
    scenario     TEXT,
    model        TEXT,
    seed         INTEGER,
    duration_s   REAL,
    summary_json TEXT NOT NULL,
    l2_path      TEXT,
    l3_path      TEXT,
    tags         TEXT NOT NULL DEFAULT '',
    checksum     TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status     ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_scenario   ON runs(scenario);

CREATE TABLE IF NOT EXISTS assets (
    asset_id   TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    rel_path   TEXT NOT NULL,
    mime       TEXT,
    bytes      INTEGER,
    created_at REAL NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_assets_run_id ON assets(run_id);
"""


class Store:
    """基于 SQLite 的运行索引，以及受根目录约束的文件系统助手。"""

    def __init__(self, root: str | os.PathLike[str], *, db_name: str = "index.db") -> None:
        self.root: Path = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._db_path: Path = self.root / db_name
        self._lock = threading.RLock()
        self._init_db()

    # ------------------------------------------------------------------ SQL
    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self._db_path, isolation_level=None, timeout=15.0)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            yield conn
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._lock, self._conn() as c:
            c.executescript(_DDL)
            row = c.execute("SELECT value FROM schema_meta WHERE key='version'").fetchone()
            if row is None:
                c.execute(
                    "INSERT INTO schema_meta(key, value) VALUES('version', ?)",
                    (str(SCHEMA_VERSION),),
                )

    # ----------------------------------------------------------- path helpers
    def safe_join(self, rel: str | os.PathLike[str]) -> Path:
        """将相对路径拼到 root 下，并保证 resolve 后仍在 root 内。

        拒绝任何包含 ``..`` 段或绝对路径的输入。
        """
        raw = str(rel)
        parts = Path(raw.replace("\\", "/")).parts
        if any(p == ".." for p in parts):
            raise PathTraversalError(f"traversal segment in path: {raw!r}")

        candidate = self.root / raw.lstrip("/\\")
        resolved = candidate.resolve()
        try:
            resolved.relative_to(self.root)
        except ValueError as exc:  # 目标逃出 root
            raise PathTraversalError(f"path escapes storage root: {raw!r}") from exc
        return resolved

    def relpath(self, path: str | os.PathLike[str]) -> str:
        p = Path(path).resolve()
        return str(p.relative_to(self.root))

    def runs_dir(self) -> Path:
        p = self.root / "runs"
        p.mkdir(parents=True, exist_ok=True)
        return p

    # ---------------------------------------------------------------- writes
    def save_run(
        self,
        record: Mapping[str, Any],
        *,
        assets: Sequence[Mapping[str, Any]] = (),
        overwrite: bool = False,
    ) -> None:
        """原子地写入 runs 行 + 关联 assets 行（单事务）。"""
        run_id = record["run_id"]
        if not is_valid_run_id(run_id):
            raise DuplicateRunError(f"invalid run_id: {run_id!r}")

        cols = (
            "run_id", "created_at", "source", "status", "scenario", "model",
            "seed", "duration_s", "summary_json", "l2_path", "l3_path",
            "tags", "checksum",
        )
        values = tuple(record.get(c) for c in cols)
        col_sql = ",".join(cols)
        ph_sql = ",".join("?" * len(cols))

        with self._lock, self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                existing = c.execute(
                    "SELECT 1 FROM runs WHERE run_id=?", (run_id,)
                ).fetchone()
                if existing and not overwrite:
                    raise DuplicateRunError(f"run_id already exists: {run_id}")
                if existing:
                    c.execute("DELETE FROM assets WHERE run_id=?", (run_id,))
                    c.execute("DELETE FROM runs   WHERE run_id=?", (run_id,))

                c.execute(f"INSERT INTO runs({col_sql}) VALUES({ph_sql})", values)
                for a in assets:
                    c.execute(
                        "INSERT INTO assets"
                        "(asset_id, run_id, kind, rel_path, mime, bytes, created_at) "
                        "VALUES(?,?,?,?,?,?,?)",
                        (
                            a["asset_id"], a["run_id"], a["kind"],
                            a["rel_path"], a["mime"], a["bytes"], a["created_at"],
                        ),
                    )
                c.execute("COMMIT")
            except Exception:
                c.execute("ROLLBACK")
                raise

    # ----------------------------------------------------------------- reads
    def has_run(self, run_id: str) -> bool:
        if not is_valid_run_id(run_id):
            return False
        with self._lock, self._conn() as c:
            return c.execute("SELECT 1 FROM runs WHERE run_id=?", (run_id,)).fetchone() is not None

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        if not is_valid_run_id(run_id):
            return None
        with self._lock, self._conn() as c:
            row = c.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        return self._row_to_run(row) if row else None

    def list_runs(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        status: str | None = None,
        scenario: str | None = None,
        has_l2: bool = False,
    ) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))

        sql = "SELECT * FROM runs"
        where: list[str] = []
        params: list[Any] = []
        if status:
            where.append("status = ?")
            params.append(status)
        if scenario:
            where.append("scenario = ?")
            params.append(scenario)
        if has_l2:
            where.append("l2_path IS NOT NULL")
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_at DESC, run_id ASC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        with self._lock, self._conn() as c:
            rows = c.execute(sql, params).fetchall()
        return [self._row_to_run(r) for r in rows]

    def list_assets(self, *, run_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        sql = "SELECT * FROM assets"
        params: list[Any] = []
        if run_id:
            if not is_valid_run_id(run_id):
                return []
            sql += " WHERE run_id = ?"
            params.append(run_id)
        sql += " ORDER BY created_at DESC, asset_id ASC LIMIT ?"
        params.append(limit)
        with self._lock, self._conn() as c:
            rows = c.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as c:
            row = c.execute("SELECT * FROM assets WHERE asset_id=?", (asset_id,)).fetchone()
        return dict(row) if row else None

    # ---------------------------------------------------------------- helpers
    @staticmethod
    def _row_to_run(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "run_id": row["run_id"],
            "created_at": row["created_at"],
            "source": row["source"],
            "status": row["status"],
            "scenario": row["scenario"],
            "model": row["model"],
            "seed": row["seed"],
            "duration_s": row["duration_s"],
            "summary": json.loads(row["summary_json"]),
            "l2_path": row["l2_path"],
            "l3_path": row["l3_path"],
            "tags": [t for t in (row["tags"] or "").split(",") if t],
            "checksum": row["checksum"],
        }
```

## 3. `python/astra_web/archive.py`

```python
"""原子文件写入工具。

原子性策略：在同目录下写 ``.tmp-*.part`` → ``fsync`` → ``os.replace``。
`os.replace` 在同一文件系统上是原子替换语义，因此读取方永远看不到
半截文件；崩溃时最多遗留一个孤立的临时文件。
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_bytes(path: Path, data: bytes) -> None:
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError(f"data must be bytes, got {type(data)!r}")
    path.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=".tmp-", suffix=".part"
    )
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        # 清理孤儿临时文件
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def atomic_write_json(path: Path, payload: Any, *, indent: int = 2) -> None:
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=indent)
    atomic_write_bytes(path, blob.encode("utf-8"))
```

## 4. `python/astra_web/replays.py`

```python
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
        store.save_run(record, assets=asset_rows, overwrite=overwrite)
    except DuplicateRunError as exc:
        # 理论上 has_run 已拦下，这里是防御性兜底
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
```

## 5. `python/astra_web/app.py`

```python
"""FastAPI 应用入口：只读 BFF + 静态资源托管。

路由概览
--------
GET /api/health                 健康检查（保证不调用任何模型）
GET /api/capabilities           能力声明
GET /api/runs                   运行索引（L1 摘要）
GET /api/runs/{run_id}          单条运行
GET /api/replays                具备 L2 详细存档的运行
GET /api/replays/{run_id}       读取 L2 详细存档内容
GET /api/assets                 资产清单（可按 run_id 过滤）
GET /api/assets/{asset_id}      下载资产（L3）
GET /                           apps/web-demo/dist 静态资源（若存在）

只读约束：本模块不暴露任何写入端点；导入入口在 `replays` 模块。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .storage import PathTraversalError, Store

SERVICE_NAME = "astra-web-bff"
SERVICE_VERSION = "0.1.0"

logger = logging.getLogger("astra_web.app")


def _env_path(var: str, default: str) -> Path:
    return Path(os.environ.get(var, default)).expanduser()


def create_app(
    *,
    data_root: str | os.PathLike[str] | None = None,
    web_dist: str | os.PathLike[str] | None = None,
    mount_static: bool = True,
) -> FastAPI:
    store = Store(data_root or _env_path("ASTRA_DATA_ROOT", "./var/astra"))

    app = FastAPI(
        title="Astra Web BFF",
        version=SERVICE_VERSION,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.state.store = store
    app.state.data_root = store.root

    # ------------------------------------------------------------------ health
    @app.get("/api/health")
    def health() -> dict[str, Any]:
        """纯本地健康检查；不解析任何模型、不触网、不做网络 I/O。"""
        return {
            "status": "ok",
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "model_invoked": False,
            "data_root": str(store.root),
        }

    # ------------------------------------------------------------ capabilities
    @app.get("/api/capabilities")
    def capabilities() -> dict[str, Any]:
        return {
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "read_only": True,
            "model_invoked": False,
            "schema_version": 1,
            "routes": [
                "/api/health",
                "/api/capabilities",
                "/api/runs",
                "/api/replays",
                "/api/assets",
            ],
            "levels": {
                "L1": "summary inline in SQLite index",
                "L2": "detailed archive (JSON on disk)",
                "L3": "binary/text artifacts on disk",
            },
            "imports": {
                "formats": ["json", "jsonl"],
                "entrypoint": "astra_web.replays",
                "via_http": False,
            },
        }

    # -------------------------------------------------------------------- runs
    @app.get("/api/runs")
    def list_runs(
        limit: int = 50,
        offset: int = 0,
        status: str | None = None,
        scenario: str | None = None,
    ) -> dict[str, Any]:
        items = store.list_runs(
            limit=limit, offset=offset, status=status, scenario=scenario,
        )
        return {"items": items, "count": len(items), "limit": limit, "offset": offset}

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, Any]:
        run = store.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        run["assets"] = store.list_assets(run_id=run_id)
        return run

    # ----------------------------------------------------------------- replays
    @app.get("/api/replays")
    def list_replays(limit: int = 50, offset: int = 0) -> dict[str, Any]:
        items = store.list_runs(limit=limit, offset=offset, has_l2=True)
        return {"items": items, "count": len(items), "limit": limit, "offset": offset}

    @app.get("/api/replays/{run_id}")
    def get_replay(run_id: str) -> dict[str, Any]:
        run = store.get_run(run_id)
        if run is None or not run.get("l2_path"):
            raise HTTPException(status_code=404, detail="replay not found")
        try:
            payload_path = store.safe_join(run["l2_path"])
        except PathTraversalError as exc:
            raise HTTPException(status_code=400, detail="unsafe replay path") from exc
        if not payload_path.is_file():
            raise HTTPException(status_code=410, detail="replay payload missing")
        try:
            details = json.loads(payload_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=500, detail="replay payload unreadable") from exc
        return {
            "run_id": run_id,
            "source": run["source"],
            "created_at": run["created_at"],
            "details": details,
        }

    # ------------------------------------------------------------------ assets
    @app.get("/api/assets")
    def list_assets(run_id: str | None = None, limit: int = 100) -> dict[str, Any]:
        items = store.list_assets(run_id=run_id, limit=limit)
        return {"items": items, "count": len(items)}

    @app.get("/api/assets/{asset_id}")
    def download_asset(asset_id: str):
        row = store.get_asset(asset_id)
        if row is None:
            raise HTTPException(status_code=404, detail="asset not found")
        try:
            target = store.safe_join(row["rel_path"])
        except PathTraversalError as exc:
            raise HTTPException(status_code=400, detail="unsafe asset path") from exc
        if not target.is_file():
            raise HTTPException(status_code=410, detail="asset file missing")
        return FileResponse(
            path=str(target),
            media_type=row.get("mime") or "application/octet-stream",
            filename=Path(row["rel_path"]).name,
        )

    # ------------------------------------------------------------ API 404 JSON
    @app.exception_handler(404)
    async def _not_found(request, exc):  # pragma: no cover - trivial
        if request.url.path.startswith("/api/"):
            return JSONResponse(status_code=404, content={"detail": "not found"})
        if app.state.web_dist is None:
            return JSONResponse(
                status_code=404,
                content={"detail": "static assets not mounted (apps/web-demo/dist missing)"},
            )
        return JSONResponse(status_code=404, content={"detail": "not found"})

    # -------------------------------------------------------------- 静态资源
    dist_path = Path(web_dist) if web_dist else _env_path("ASTRA_WEB_DIST", "apps/web-demo/dist")
    dist_path = dist_path.expanduser()
    if mount_static and dist_path.is_dir():
        app.mount("/", StaticFiles(directory=str(dist_path), html=True), name="web")
        app.state.web_dist = dist_path
        logger.info("mounted static assets from %s", dist_path)
    else:
        app.state.web_dist = None
        logger.info("static assets not mounted (dist dir: %s)", dist_path)

    return app


# 供 `uvicorn astra_web.app:app` 直接使用
app = create_app()
```

## 6. `python/astra_web/tests/__init__.py`

```python
```

## 7. `python/astra_web/tests/conftest.py`

```python
"""确保 `astra_web` 可从仓库的 `python/` 目录被导入（无需 pip install -e）。"""
from __future__ import annotations

import sys
from pathlib import Path

_PYTHON_DIR = Path(__file__).resolve().parents[2]  # .../python
if str(_PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(_PYTHON_DIR))
```

## 8. `python/astra_web/tests/test_web_bff.py`

```python
"""D-03 只读 BFF / 导入 / 存档 的契约测试。

覆盖：
1. /api/health 健康检查（严格断言不调用模型）
2. /api/capabilities 能力声明
3. 合法 JSON 导入 → /api/runs、/api/replays、/api/assets 可读
4. 非法载荷被拦截（缺 L1、坏 JSON、非法 run_id、artifact 名穿越）
5. JSONL 多行导入
6
