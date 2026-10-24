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


# 非终态状态：仍可能被推进为终态的状态集合。
# 终态记录（不在此集合内）一律**不可覆盖**，见 Store.save_run_terminal。
NON_TERMINAL_STATUSES = frozenset({"running", "queued"})


def is_terminal_status(status: Any) -> bool:
    """状态是否为终态（不可再被写入改写）。"""
    return isinstance(status, str) and status not in NON_TERMINAL_STATUSES


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
        conn = sqlite3.connect(str(self._db_path), isolation_level=None, timeout=15.0)
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
        return str(p.relative_to(self.root)).replace("\\", "/")

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
        allow_terminal_replace: bool = False,
    ) -> None:
        """原子地写入 runs 行 + 关联 assets 行（单事务）。

        终态保护：``overwrite=True`` 默认**仍拒绝**覆盖已存在的终态记录，
        只有显式传入 ``allow_terminal_replace=True``（当前仅离线重放导入的
        显式覆盖路径使用）才允许替换。这样“完成记录被覆盖”不可能由疏漏触发。
        """
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
                    "SELECT status FROM runs WHERE run_id=?", (run_id,)
                ).fetchone()
                if existing and not overwrite:
                    raise DuplicateRunError(f"run_id already exists: {run_id}")
                if existing and is_terminal_status(existing["status"]) and not allow_terminal_replace:
                    raise DuplicateRunError(
                        f"terminal record is immutable (pass allow_terminal_replace=True to override): {run_id}"
                    )
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

    def save_run_terminal(self, record: Mapping[str, Any]) -> bool:
        """原子写入终态记录；若既有记录已是终态则**拒绝覆盖**并返回 False。

        与 ``save_run(overwrite=True)`` 的区别：
        * 只更新 runs 行，不触碰该 run 的 assets 行；
        * 已存在的终态记录不会被改写（t1-[4]：完成记录不可被覆盖）。
        """
        run_id = record["run_id"]
        if not is_valid_run_id(run_id):
            raise DuplicateRunError(f"invalid run_id: {run_id!r}")

        cols = (
            "run_id", "created_at", "source", "status", "scenario", "model",
            "seed", "duration_s", "summary_json", "l2_path", "l3_path",
            "tags", "checksum",
        )
        values = tuple(record.get(c) for c in cols)
        update_cols = [c for c in cols if c != "run_id"]
        set_sql = ",".join(f"{c}=?" for c in update_cols)
        update_values = tuple(record.get(c) for c in update_cols)

        with self._lock, self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                row = c.execute("SELECT status FROM runs WHERE run_id=?", (run_id,)).fetchone()
                if row is not None and is_terminal_status(row["status"]):
                    c.execute("ROLLBACK")
                    return False
                if row is None:
                    c.execute(
                        f"INSERT INTO runs({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
                        values,
                    )
                else:
                    c.execute(f"UPDATE runs SET {set_sql} WHERE run_id=?", (*update_values, run_id))
                c.execute("COMMIT")
                return True
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
