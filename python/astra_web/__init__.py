"""Astra Web BFF (Backend-for-Frontend).

只读接口：从 SQLite 索引 + 文件存档中读取运行记录 / 回放 / 资产。
外部 SolveResult 的导入与校验由 `replays` 模块提供（库/CLI 使用，不经 HTTP 暴露）。
"""
from __future__ import annotations

__version__ = "0.1.0"
__all__ = ["__version__"]
