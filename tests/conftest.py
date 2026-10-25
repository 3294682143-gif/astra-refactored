"""Pytest 会话级测试隔离。

背景（实测缺陷 t1-[5]）
-----------------------
本机 pytest 默认 basetemp 为 ``%LOCALAPPDATA%\\Temp\\pytest-of-<user>``。
该目录存在，但其 ACL 拒绝了当前用户的列目录权限，pytest 的 tmpdir 插件在
``os.scandir(basetemp)`` 处抛出 ``PermissionError: [WinError 5] 拒绝访问``，
于是**所有使用 ``tmp_path`` 的测试在 fixture 阶段直接 ERROR**（实测
``9 passed / 9 errors``）。这与运行中的 ``uvicorn`` 服务无关：pytest 只是
被迫复用一个已不受本进程控制的共享目录。

修复策略（测试自持、自用、不依赖服务）
--------------------------------------
本文件在会话开始时**自己创建一个独立临时目录**作为 basetemp：
1. 允许用 ``ASTRA_PYTEST_BASETEMP`` 显式指定（CI/沙箱可覆盖）；
2. 否则用 ``tempfile.mkdtemp()`` 新建一个仅属于本次会话的私有目录；
3. 兜底再退到工作区内的 ``.astra-pytest-tmp``。

每一步都会**主动自检**该目录可列、可写——只有自检通过的目录才会被采用，
避免把一次 ACL 事故变成一批 ERROR。测试全程不依赖任何运行中的服务，也不
复用任何他人拥有的全局目录。
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import uuid
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _is_usable(path: Path) -> bool:
    """目录必须真实可列、可写；否则视为不可用（这正是本机全局 basetemp 的病）。"""
    try:
        path.mkdir(parents=True, exist_ok=True)
        with os.scandir(path):
            pass
        probe = path / f".probe-{uuid.uuid4().hex[:8]}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError:
        return False
    return True


def session_basetemp() -> Path:
    """按优先级挑选一个本次会话自持、且自检通过的 basetemp。"""
    candidates: list[Path] = []
    explicit = os.environ.get("ASTRA_PYTEST_BASETEMP")
    if explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.append(Path(tempfile.gettempdir()) / f"astra-pytest-{os.getpid()}-{uuid.uuid4().hex[:8]}")
    candidates.append(_REPO_ROOT / ".astra-pytest-tmp" / uuid.uuid4().hex[:8])

    errors: list[str] = []
    for candidate in candidates:
        if _is_usable(candidate):
            return candidate
        errors.append(str(candidate))
    raise RuntimeError("no usable pytest basetemp directory; tried: " + "; ".join(errors))


# 仅当 basetemp 由本 conftest 创建时才在会话末尾回收（显式 --basetemp 由调用方负责）
_OWNED_BASETEMP: Path | None = None


def pytest_configure(config) -> None:
    """在 tmpdir 插件首次取用 basetemp 之前，把它指向本次会话自持的独立目录。"""
    global _OWNED_BASETEMP
    if getattr(config.option, "basetemp", None):
        return  # 调用方显式指定（例如 --basetemp=...）时不覆盖
    owned = session_basetemp()
    _OWNED_BASETEMP = owned
    config.option.basetemp = str(owned)


def pytest_sessionfinish(session, exitstatus) -> None:
    """全绿时回收本次会话自持的 basetemp，避免在临时区留下垃圾目录。"""
    if _OWNED_BASETEMP is None:
        return
    if getattr(session, "testsfailed", 0):
        return  # 有失败时保留现场，便于排查
    import shutil

    shutil.rmtree(_OWNED_BASETEMP, ignore_errors=True)


# --- Windows compatibility guards from the unified-math baseline ---
if sys.platform == "win32":
    try:
        from math_families.core import guard

        def _win_run_with_timeout(func, timeout_ms, *args, **kwargs):
            res_box = [None]
            err_box = [None]

            def target():
                try:
                    res_box[0] = func(*args, **kwargs)
                except Exception as exc:
                    err_box[0] = exc

            th = threading.Thread(target=target, daemon=True)
            th.start()
            th.join(timeout=max(timeout_ms / 1000.0, 0.05))
            if th.is_alive():
                return ("timeout", None)
            if err_box[0] is not None:
                raise err_box[0]
            return ("ok", res_box[0])

        guard.run_with_timeout = _win_run_with_timeout
    except Exception:
        pass

    try:
        from math_families.families import diophantine

        def _win_run_isolated(func, *args, timeout_s=5):
            res_box = [None]
            err_box = [None]

            def target():
                try:
                    res_box[0] = func(*args)
                except Exception as exc:
                    err_box[0] = exc

            th = threading.Thread(target=target, daemon=True)
            th.start()
            th.join(timeout=timeout_s)
            if th.is_alive():
                return ("timeout", None)
            if err_box[0] is not None:
                return ("error", str(err_box[0]))
            return ("ok", res_box[0])

        diophantine._run_isolated = _win_run_isolated
    except Exception:
        pass
