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
