# D-01 交付报告：Web 契约与语义层实现

> 基线：`eb36a5acadc5de53d1c436b63faefca193b7d3f4` · 分支：`前端设计` · F1 冻结签核：`docs/web/08-f1-freeze-signoff.md`

以下为 **完整可落地代码**，按生产级标准（strict Pydantic v2 + 零 Node 依赖 TS + JSON Schema 导出 + 反例测试）编排。

---

## 一、Python 侧：`python/astra_web/contracts/`

### 1.1 `python/astra_web/contracts/enums.py`

```python
"""Astra Web 契约 - 权威枚举定义.

所有枚举均继承 (str, Enum) 以保证 JSON 序列化时的值稳定性.
禁止在业务层使用裸字符串比较, 一律通过本模块的枚举常量.
"""
from __future__ import annotations

from enum import Enum


class StatusCode(str, Enum):
    """Run 顶层状态码 (权威).

    与 `StopReason` 一一映射, 由 mapping.classify_stop_reason 强制推导,
    DTO 层的 model_validator 会校验一致性; 不允许手工构造不一致的组合.
    """
    SOLVED = "solved"
    UNSOLVED = "unsolved"
    REVISE_REJECTED = "revise_rejected"
    ABORTED = "aborted"
    ERROR = "error"


class StopReason(str, Enum):
    """终止原因 (权威).

    命名采用 SCREAMING_SNAKE_CASE, 与 solve() 内核返回字段保持字节一致.
    """
    SOLVED = "SOLVED"
    REVIEWS_COMPLETE = "REVIEWS_COMPLETE"
    REVISE_REJECTED = "REVISE_REJECTED"
    MAX_ITER = "MAX_ITER"
    TIMEOUT = "TIMEOUT"
    BUDGET_EXCEEDED = "BUDGET_EXCEEDED"
    CANCELLED = "CANCELLED"
    ERROR = "ERROR"


class TraceStage(str, Enum):
    """单条 Trace 所处阶段."""
    PLAN = "plan"
    DRAFT = "draft"
    REVIEW = "review"
    REVISE = "revise"
    FINALIZE = "finalize"
    ERROR = "error"


class EventType(str, Enum):
    """SSE / WebSocket 事件类型."""
    STARTED = "started"
    TRACE = "trace"
    METRICS = "metrics"
    STATUS = "status"
    COMPLETED = "completed"
    ERROR = "error"


class ErrorCategory(str, Enum):
    """错误归类 (供前端 UI 决策重试/降级)."""
    VALIDATION = "validation"
    PROVIDER = "provider"
    TIMEOUT = "timeout"
    BUDGET = "budget"
    INTERNAL = "internal"
```

---

### 1.2 `python/astra_web/contracts/mapping.py`

```python
"""Astra Web 契约 - status / stopReason 权威映射表与归类逻辑.

设计原则:
  1. 本模块是**唯一**允许 stop_reason -> status 推导的入口.
  2. 所有映射表用 MappingProxyType 冻结, 防止运行时被误改.
  3. 中文标签仅用于展示, 不参与任何业务判断.
"""
from __future__ import annotations

from types import MappingProxyType
from typing import Final, Mapping

from .enums import StatusCode, StopReason

# ---------------------------------------------------------------------------
# 权威映射表 (唯一事实来源 / single source of truth)
# ---------------------------------------------------------------------------

STOP_REASON_TO_STATUS: Final[Mapping[StopReason, StatusCode]] = MappingProxyType(
    {
        StopReason.SOLVED: StatusCode.SOLVED,
        StopReason.REVIEWS_COMPLETE: StatusCode.UNSOLVED,
        StopReason.REVISE_REJECTED: StatusCode.REVISE_REJECTED,
        StopReason.MAX_ITER: StatusCode.UNSOLVED,
        StopReason.TIMEOUT: StatusCode.UNSOLVED,
        StopReason.BUDGET_EXCEEDED: StatusCode.UNSOLVED,
        StopReason.CANCELLED: StatusCode.ABORTED,
        StopReason.ERROR: StatusCode.ERROR,
    }
)

STOP_REASON_LABEL_ZH: Final[Mapping[StopReason, str]] = MappingProxyType(
    {
        StopReason.SOLVED: "已求解",
        StopReason.REVIEWS_COMPLETE: "评审完成",
        StopReason.REVISE_REJECTED: "修订被拒",
        StopReason.MAX_ITER: "已达迭代上限",
        StopReason.TIMEOUT: "超时",
        StopReason.BUDGET_EXCEEDED: "预算耗尽",
        StopReason.CANCELLED: "已取消",
        StopReason.ERROR: "错误",
    }
)

# 需要携带 candidate 才能成立的 status 集合
_STATUS_REQUIRES_CANDIDATE: Final[frozenset[StatusCode]] = frozenset(
    {StatusCode.SOLVED, StatusCode.REVISE_REJECTED}
)

# 需要 error 字段必须为 None 的 status 集合
_STATUS_FORBIDS_ERROR: Final[frozenset[StatusCode]] = frozenset(
    {StatusCode.SOLVED, StatusCode.UNSOLVED, StatusCode.REVISE_REJECTED}
)

# 需要 error 字段必须非 None 的 status 集合
_STATUS_REQUIRES_ERROR: Final[frozenset[StatusCode]] = frozenset({StatusCode.ERROR})


# ---------------------------------------------------------------------------
# 归类逻辑
# ---------------------------------------------------------------------------

def classify_stop_reason(reason: StopReason) -> StatusCode:
    """由 stopReason 推导权威 status.

    Raises:
        KeyError: reason 不在映射表中 (理论上不可能, 枚举已封闭).
    """
    return STOP_REASON_TO_STATUS[reason]


def label_zh(reason: StopReason) -> str:
    """获取 stopReason 的中文展示标签."""
    return STOP_REASON_LABEL_ZH[reason]


def requires_candidate(status: StatusCode) -> bool:
    return status in _STATUS_REQUIRES_CANDIDATE


def forbids_error(status: StatusCode) -> bool:
    return status in _STATUS_FORBIDS_ERROR


def requires_error(status: StatusCode) -> bool:
    return status in _STATUS_REQUIRES_ERROR


__all__ = [
    "STOP_REASON_TO_STATUS",
    "STOP_REASON_LABEL_ZH",
    "classify_stop_reason",
    "label_zh",
    "requires_candidate",
    "forbids_error",
    "requires_error",
]
```

---

### 1.3 `python/astra_web/contracts/dto.py`

```python
"""Astra Web 契约 - Pydantic v2 strict DTO 模型.

适配 astra.solve() 公开返回对象的序列化契约. 所有模型:
  - extra="forbid"    : 未声明字段一律拒绝 (防止字段漂移)
  - frozen=True       : 不可变, 支持 hash 与安全传递
  - 统一经 model_validator 校验跨字段不变量

禁止在此模块引入任何 web / 网络依赖, 保持纯数据层.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from .enums import (
    ErrorCategory,
    EventType,
    StatusCode,
    StopReason,
    TraceStage,
)
from .mapping import (
    classify_stop_reason,
    forbids_error,
    requires_candidate,
    requires_error,
)

# ---------------------------------------------------------------------------
# 共享配置 & 类型别名
# ---------------------------------------------------------------------------

_BASE_CFG = ConfigDict(
    extra="forbid",
    frozen=True,
    populate_by_name=True,
    validate_assignment=False,
    ser_json_timedelta="float",
)

RunId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_\-:.]+$")]
MethodId = Annotated[str, Field(min_length=1, max_length=64)]
ShortText = Annotated[str, Field(min_length=1, max_length=512)]
LongText = Annotated[str, Field(min_length=1, max_length=65536)]


# ---------------------------------------------------------------------------
# 基础 DTO
# ---------------------------------------------------------------------------

class ErrorDto(BaseModel):
    """错误对象. 仅在 status=error 时出现, 或作为事件信封的 payload."""
    model_config = _BASE_CFG

    code: Annotated[str, Field(min_length=1, max_length=128)]
    message: Annotated[str, Field(min_length=1, max_length=4096)]
    category: ErrorCategory
    retryable: bool = False
    details: dict[str, Any] | None = None


class MetricsDto(BaseModel):
    """Run 级指标快照. 所有数值均为非负且可加."""
    model_config = _BASE_CFG

    iterations: Annotated[int, Field(ge=0, le=1_000_000)]
    method_loads: Annotated[int, Field(ge=0, le=1_000_000)]
    tokens_in: Annotated[int, Field(ge=0)] = 0
    tokens_out: Annotated[int, Field(ge=0)] = 0
    wall_ms: Annotated[int, Field(ge=0)]
    cost_usd: Annotated[float, Field(ge=0.0)] = 0.0


class TraceRowDto(BaseModel):
    """单条 trace 记录."""
    model_config = _BASE_CFG

    seq: Annotated[int, Field(ge=0)]
    ts_ms: Annotated[int, Field(ge=0)]
    stage: TraceStage
    method_id: MethodId | None = None
    summary: Annotated[str, Field(min_length=1, max_length=8192)]
    payload: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Run 请求
# ---------------------------------------------------------------------------

class RunRequestDto(BaseModel):
    """新建 Run 的请求体.

    约束要点:
      - max_method_loads 只允许 0 或 1 (Literal[0,1] + bool 硬拒绝)
      - input 大小由 server LimitsDto 二次校验
    """
    model_config = _BASE_CFG

    method_id: MethodId
    input: LongText
    max_method_loads: Literal[0, 1] = 0
    max_iterations: Annotated[int, Field(ge=1, le=64)] = 8
    timeout_ms: Annotated[int, Field(ge=1_000, le=600_000)] = 60_000
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("max_method_loads", mode="before")
    @classmethod
    def _reject_bool(cls, v: Any) -> Any:
        # Python 中 True == 1, 必须显式拒绝, 否则 bool 会污染契约
        if isinstance(v, bool):
            raise ValueError(
                "max_method_loads must be an integer 0 or 1, not a boolean"
            )
        return v


# ---------------------------------------------------------------------------
# Solve 结果 (核心 DTO)
# ---------------------------------------------------------------------------

class SolveResultDto(BaseModel):
    """solve() 公开返回对象的 Web 契约投影.

    不变量 (由 model_validator 强制):
      I-1  status 必须等于 classify_stop_reason(stop_reason)
      I-2  status 属于 {solved, revise_rejected} 时 candidate 必须非空
      I-3  status=error 时 error 必须非空
      I-4  status 属于 {solved, unsolved, revise_rejected} 时 error 必须为 None
    """
    model_config = _BASE_CFG

    run_id: RunId
    status: StatusCode
    stop_reason: StopReason
    candidate: Annotated[str | None, Field(max_length=65536)] = None
    trace: list[TraceRowDto] = Field(default_factory=list)
    metrics: MetricsDto
    error: ErrorDto | None = None

    @model_validator(mode="after")
    def _enforce_invariants(self) -> "SolveResultDto":
        expected = classify_stop_reason(self.stop_reason)
        if self.status is not expected:
            raise ValueError(
                f"status {self.status.value!r} is inconsistent with "
                f"stop_reason {self.stop_reason.value!r} "
                f"(expected {expected.value!r})"
            )

        if requires_candidate(self.status) and not self.candidate:
            raise ValueError(
                f"candidate must be non-empty when status is {self.status.value!r}"
            )

        if requires_error(self.status) and self.error is None:
            raise ValueError(
                f"error must be provided when status is {self.status.value!r}"
            )

        if forbids_error(self.status) and self.error is not None:
            raise ValueError(
                f"error must be None when status is {self.status.value!r}"
            )

        return self


# ---------------------------------------------------------------------------
# 事件信封 (SSE / WebSocket)
# ---------------------------------------------------------------------------

class RunEventEnvelope(BaseModel):
    """流式事件信封, 所有事件共用该外壳.

    payload 结构依 event 类型而定, 前端应在解包前先做 event 分派.
    """
    model_config = _BASE_CFG

    event: EventType
    run_id: RunId
    seq: Annotated[int, Field(ge=0)]
    ts_ms: Annotated[int, Field(ge=0)]
    payload: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# 能力描述
# ---------------------------------------------------------------------------

class MethodCapabilityDto(BaseModel):
    model_config = _BASE_CFG

    method_id: MethodId
    display_name: Annotated[str, Field(min_length=1, max_length=128)]
    description: Annotated[str, Field(max_length=2048)] = ""
    tags: list[ShortText] = Field(default_factory=list)


class LimitsDto(BaseModel):
    model_config = _BASE_CFG

    max_input_chars: Annotated[int, Field(ge=1)]
    max_iterations: Annotated[int, Field(ge=1)]
    max_method_loads: Annotated[int, Field(ge=0, le=1)]
    timeout_ms: Annotated[int, Field(ge=1)]


class CapabilitiesDto(BaseModel):
    model_config = _BASE_CFG

    schema_version: Annotated[str, Field(min_length=1, max_length=32)]
    server_version: Annotated[str, Field(min_length=1, max_length=64)]
    methods: list[MethodCapabilityDto] = Field(default_factory=list)
    limits: LimitsDto
    features: list[ShortText] = Field(default_factory=list)


__all__ = [
    "ErrorDto",
    "MetricsDto",
    "TraceRowDto",
    "RunRequestDto",
    "SolveResultDto",
    "RunEventEnvelope",
    "MethodCapabilityDto",
    "LimitsDto",
    "CapabilitiesDto",
]
```

---

### 1.4 `python/astra_web/contracts/__init__.py`

```python
"""Astra Web 契约与语义层.

对外导出:
  - 枚举: StatusCode / StopReason / TraceStage / EventType / ErrorCategory
  - 映射: STOP_REASON_TO_STATUS / STOP_REASON_LABEL_ZH / classify_stop_reason
  - DTO : SolveResultDto / TraceRowDto / MetricsDto / RunEventEnvelope
          RunRequestDto / CapabilitiesDto / ErrorDto
"""
from __future__ import annotations

from .dto import (
    CapabilitiesDto,
    ErrorDto,
    LimitsDto,
    MethodCapabilityDto,
    MetricsDto,
    RunEventEnvelope,
    RunRequestDto,
    SolveResultDto,
    TraceRowDto,
)
from .enums import (
    ErrorCategory,
    EventType,
    StatusCode,
    StopReason,
    TraceStage,
)
from .mapping import (
    STOP_REASON_LABEL_ZH,
    STOP_REASON_TO_STATUS,
    classify_stop_reason,
    forbids_error,
    label_zh,
    requires_candidate,
    requires_error,
)

__all__ = [
    # enums
    "StatusCode",
    "StopReason",
    "TraceStage",
    "EventType",
    "ErrorCategory",
    # mapping
    "STOP_REASON_TO_STATUS",
    "STOP_REASON_LABEL_ZH",
    "classify_stop_reason",
    "label_zh",
    "requires_candidate",
    "forbids_error",
    "requires_error",
    # dto
    "ErrorDto",
    "MetricsDto",
    "TraceRowDto",
    "RunRequestDto",
    "SolveResultDto",
    "RunEventEnvelope",
    "MethodCapabilityDto",
    "LimitsDto",
    "CapabilitiesDto",
]
```

---

### 1.5 `python/astra_web/contracts/schema_export.py`

```python
"""Astra Web 契约 - JSON Schema 导出脚本.

用法:
    python -m astra_web.contracts.schema_export --out schema/
    python -m astra_web.contracts.schema_export --bundle schema/contract.bundle.json

产物:
    schema/SolveResultDto.schema.json
    schema/RunEventEnvelope.schema.json
    ...
    schema/contract.bundle.json    (可选, 合并所有 $defs)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from .dto import (
    CapabilitiesDto,
    ErrorDto,
    LimitsDto,
    MethodCapabilityDto,
    MetricsDto,
    RunEventEnvelope,
    RunRequestDto,
    SolveResultDto,
    TraceRowDto,
)

SCHEMA_MODELS: dict[str, type[BaseModel]] = {
    "SolveResultDto": SolveResultDto,
    "TraceRowDto": TraceRowDto,
    "MetricsDto": MetricsDto,
    "RunEventEnvelope": RunEventEnvelope,
    "RunRequestDto": RunRequestDto,
    "CapabilitiesDto": CapabilitiesDto,
    "MethodCapabilityDto": MethodCapabilityDto,
    "LimitsDto": LimitsDto,
    "ErrorDto": ErrorDto,
}

SCHEMA_VERSION = "1.0.0"


# ---------------------------------------------------------------------------
# 构建
# ---------------------------------------------------------------------------

def build_one(model: type[BaseModel]) -> dict[str, Any]:
    """为单个模型生成 JSON Schema (validation 模式, 保留 $defs)."""
    schema = model.model_json_schema(
        by_alias=True,
        ref_template="#/$defs/{model}",
    )
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["x-contract-version"] = SCHEMA_VERSION
    schema["title"] = model.__name__
    return schema


def build_bundle() -> dict[str, Any]:
    """合并所有模型到单个 bundle, 复用顶层 $defs 命名空间."""
    defs: dict[str, Any] = {}
    entries: dict[str, Any] = {}

    for name, model in SCHEMA_MODELS.items():
        one = build_one(model)
        local_defs = one.pop("$defs", {})
        # 命名冲突检测: 相同 name 的 $def 内容必须一致
        for k, v in local_defs.items():
            if k in defs and defs[k] != v:
                raise RuntimeError(
                    f"$defs naming collision for {k!r}: "
                    f"两个模型生成了同名但不同定义的子 schema"
                )
            defs[k] = v
        entries[name] = one

    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "x-contract-version": SCHEMA_VERSION,
        "$defs": defs,
        "schemas": entries,
    }


# ---------------------------------------------------------------------------
# IO
# ---------------------------------------------------------------------------

def _dump(obj: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )


def write_schemas(out_dir: Path) -> list[Path]:
    written: list[Path] = []
    for name, model in SCHEMA_MODELS.items():
        path = out_dir / f"{name}.schema.json"
        _dump(build_one(model), path)
        written.append(path)
    return written


def write_bundle(path: Path) -> Path:
    _dump(build_bundle(), path)
    return path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_argv(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="astra_web.contracts.schema_export",
        description="导出 Astra Web 契约的 JSON Schema",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=Path("schema"),
        help="单模型 schema 输出目录 (默认: schema/)",
    )
    p.add_argument(
        "--bundle",
        type=Path,
        default=None,
        help="可选: 合并 bundle 的输出文件路径",
    )
    p.add_argument(
        "--stdout",
        action="store_true",
        help="仅输出 bundle 到 stdout, 不落盘",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_argv(argv)

    if args.stdout:
        json.dump(
            build_bundle(),
            sys.stdout,
            ensure_ascii=False,
            indent=2,
            sort_keys=False,
        )
        sys.stdout.write("\n")
        return 0

    written = write_schemas(args.out)
    if args.bundle is not None:
        written.append(write_bundle(args.bundle))

    for p in written:
        print(f"[schema_export] wrote {p}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

---

## 二、TypeScript 侧：`packages/web-contract/`

### 2.1 `packages/web-contract/package.json`

```json
{
  "name": "@zygos/web-contract",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Astra Web 契约类型与常量 (纯类型, 零运行时依赖)",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "sideEffects": false,
  "files": ["src"],
  "engines": { "node": ">=18" }
}
```

### 2.2 `packages/web-contract/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "./dist",
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src/**/*.ts"]
}
```

### 2.3 `packages/web-contract/src/types.ts`

```typescript
/**
 * Astra Web 契约 - 纯类型定义.
 *
 * 设计约束:
 *   1. 本文件只包含 `type` / `interface`, **不得** 引入任何值导出.
 *   2. 与 python/astra_web/contracts/dto.py 一一对应, 由 CI 校验漂移.
 *   3. 禁止 import 任何 Node 内置模块或第三方包.
 */

// ---------------------------------------------------------------------------
// 枚举 (字符串字面量联合, 与 Python (str, Enum) 值严格一致)
// ---------------------------------------------------------------------------

export type StatusCode =
  | "solved"
  | "unsolved"
  | "revise_rejected"
  | "aborted"
  | "error";

export type StopReason =
  | "SOLVED"
  | "REVIEWS_COMPLETE"
  | "REVISE_REJECTED"
  | "MAX_ITER"
  | "TIMEOUT"
  | "BUDGET_EXCEEDED"
  | "CANCELLED"
  | "ERROR";

export type TraceStage =
  | "plan"
  | "draft"
  | "review"
  | "revise"
  | "finalize"
  | "error";

export type EventType =
  | "started"
  | "trace"
  | "metrics"
  | "status"
  | "completed"
  | "error";

export type ErrorCategory =
  | "validation"
  | "provider"
  | "timeout"
  | "budget"
  | "internal";

// ---------------------------------------------------------------------------
// 基础 DTO
// ---------------------------------------------------------------------------

export interface ErrorDto {
  readonly code: string;
  readonly message: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown> | null;
}

export interface MetricsDto {
  readonly iterations: number;
  readonly method_loads: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly wall_ms: number;
  readonly cost_usd: number;
}

export interface TraceRowDto {
  readonly seq: number;
  readonly ts_ms: number;
  readonly stage: TraceStage;
  readonly method_id?: string | null;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Run 请求
// ---------------------------------------------------------------------------

/** 契约硬约束: max_method_loads 只允许 0 或 1. */
export type MaxMethodLoads = 0 | 1;

export interface RunRequestDto {
  readonly method_id: string;
  readonly input: string;
  readonly max_method_loads?: MaxMethodLoads;
  readonly max_iterations?: number;
  readonly timeout_ms?: number;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Solve 结果
// ---------------------------------------------------------------------------

export interface SolveResultDto {
  readonly run_id: string;
  readonly status: StatusCode;
  readonly stop_reason: StopReason;
  readonly candidate?: string | null;
  readonly trace: readonly TraceRowDto[];
  readonly metrics: MetricsDto;
  readonly error?: ErrorDto | null;
}

// ---------------------------------------------------------------------------
// 事件信封
// ---------------------------------------------------------------------------

export interface RunEventEnvelope {
  readonly event: EventType;
  readonly run_id: string;
  readonly seq: number;
  readonly ts_ms: number;
  readonly payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 能力描述
// ---------------------------------------------------------------------------

export interface MethodCapabilityDto {
  readonly method_id: string;
  readonly display_name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface LimitsDto {
  readonly max_input_chars: number;
  readonly max_iterations: number;
  readonly max_method_loads: MaxMethodLoads;
  readonly timeout_ms: number;
}

export interface CapabilitiesDto {
  readonly schema_version: string;
  readonly server_version: string;
  readonly methods: readonly MethodCapabilityDto[];
  readonly limits: LimitsDto;
  readonly features: readonly string[];
}
```

### 2.4 `packages/web-contract/src/constants.ts`

```typescript
/**
 * Astra Web 契约 - 运行时常量.
 *
 * 与 python/astra_web/contracts/mapping.py 严格对齐:
 *   - STOP_REASON_VALUES    : 全量枚举值白名单 (用于运行时入参校验)
 *   - STOP_REASON_TO_STATUS : status 权威映射
 *   - STOP_REASON_LABEL_ZH  : 中文展示标签
 *   - classifyStopReason()  : 归类入口 (唯一权威)
 *
 * 零依赖, 无副作用, 可 tree-shake.
 */
import type { StatusCode, StopReason } from "./types.js";

// ---------------------------------------------------------------------------
// 白名单
// ---------------------------------------------------------------------------

export const STOP_REASON_VALUES: readonly StopReason[] = Object.freeze([
  "SOLVED",
  "REVIEWS_COMPLETE",
  "REVISE_REJECTED",
  "MAX_ITER",
  "TIMEOUT",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "ERROR",
] as const);

export const STATUS_CODE_VALUES: readonly StatusCode[] = Object.freeze([
  "solved",
  "unsolved",
  "revise_rejected",
  "aborted",
  "error",
] as const);

// ---------------------------------------------------------------------------
// 权威映射
// ---------------------------------------------------------------------------

/** stopReason -> status 的**唯一权威映射** (与后端映射表字节一致). */
export const STOP_REASON_TO_STATUS: Readonly<Record<StopReason, StatusCode>> =
  Object.freeze({
    SOLVED: "solved",
    REVIEWS_COMPLETE: "unsolved",
    REVISE_REJECTED: "revise_rejected",
    MAX_ITER: "unsolved",
    TIMEOUT: "unsolved",
    BUDGET_EXCEEDED: "unsolved",
    CANCELLED: "aborted",
    ERROR: "error",
  });

/** stopReason -> 中文展示标签. 仅用于 UI, 不参与业务判断. */
export const STOP_REASON_LABEL_ZH: Readonly<Record<StopReason, string>> =
  Object.freeze({
    SOLVED: "已求解",
    REVIEWS_COMPLETE: "评审完成",
    REVISE_REJECTED: "修订被拒",
    MAX_ITER: "已达迭代上限",
    TIMEOUT: "超时",
    BUDGET_EXCEEDED: "预算耗尽",
    CANCELLED: "已取消",
    ERROR: "错误",
  });

// ---------------------------------------------------------------------------
// 归类逻辑
// ---------------------------------------------------------------------------

/** 由 stopReason 推导权威 status. */
export function classifyStopReason(reason: StopReason): StatusCode {
  return STOP_REASON_TO_STATUS[reason];
}

/** 获取 stopReason 的中文展示标签. */
export function labelForStopReason(reason: StopReason): string {
  return STOP_REASON_LABEL_ZH[reason];
}

/** 运行时守卫: 判断未知字符串是否为合法 stopReason. */
export function isStopReason(v: unknown): v is StopReason {
  return (
    typeof v === "string" &&
    (STOP_REASON_VALUES as readonly string[]).includes(v)
  );
}

/** 运行时守卫: 判断未知字符串是否为合法 status. */
export function isStatusCode(v: unknown): v is StatusCode {
  return (
    typeof v === "string" &&
    (STATUS_CODE_VALUES as readonly string[]).includes(v)
  );
}
```

### 2.5 `packages/web-contract/src/index.ts`

```typescript
/**
 * @zygos/web-contract 入口.
 * 纯类型 + 常量, 无 Node / 浏览器运行时依赖.
 */
export * from "./types.js";
export * from "./constants.js";
```

---

## 三、反例测试与边界断言

### 3.1 `python/tests/test_contracts_dto.py`

```python
"""Astra Web 契约 - 反例与边界测试.

覆盖:
  - 正向: solved 全字段/JSON roundtrip
  - 映射: 全枚举覆盖 + 一致性
  - 反例: status/stop_reason 不一致, 缺 candidate, 缺 error, 多余 error
  - 反例: candidate + REVISE_REJECTED (正向), 无 candidate + REVISE_REJECTED (反例)
  - 反例: unsolved + REVIEWS_COMPLETE (正向)
  - 反例: 非法类型 (bool 混入 max_method_loads, 未知 stopReason, extra 字段)
  - 不变量: 冻结模型不可变
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest
from pydantic import ValidationError

from astra_web.contracts import (
    CapabilitiesDto,
    ErrorCategory,
    ErrorDto,
    EventType,
    LimitsDto,
    MetricsDto,
    RunEventEnvelope,
    RunRequestDto,
    SolveResultDto,
    StatusCode,
    StopReason,
    STOP_REASON_LABEL_ZH,
    STOP_REASON_TO_STATUS,
    TraceRowDto,
    TraceStage,
    classify_stop_reason,
    label_zh,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def metrics_payload() -> dict[str, Any]:
    return dict(
        iterations=3,
        method_loads=1,
        tokens_in=120,
        tokens_out=480,
        wall_ms=4_200,
        cost_usd=0.012,
    )


def trace_row_payload(seq: int = 0) -> dict[str, Any]:
    return dict(
        seq=seq,
        ts_ms=1_700_000_000_000 + seq,
        stage="plan",
        summary="初始规划",
        payload={"note": "ok"},
    )


def solve_payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = dict(
        run_id="run_test_001",
        status="solved",
        stop_reason="SOLVED",
        candidate="最终答案",
        trace=[trace_row_payload(0), trace_row_payload(1)],
        metrics=metrics_payload(),
    )
    base.update(overrides)
    return base


def error_payload() -> dict[str, Any]:
    return dict(
        code="provider.timeout",
        message="上游超时",
        category="provider",
        retryable=True,
    )


# ---------------------------------------------------------------------------
# 1. 正向通路
# ---------------------------------------------------------------------------

class TestHappyPath:
    def test_solved_full_roundtrip(self) -> None:
        dto = SolveResultDto.model_validate(solve_payload())
        assert dto.status is StatusCode.SOLVED
        assert dto.stop_reason is StopReason.SOLVED
        assert dto.candidate == "最终答案"
        assert dto.error is None
        assert len(dto.trace) == 2

    def test_solved_json_roundtrip(self) -> None:
        dto = SolveResultDto.model_validate(solve_payload())
        raw = dto.model_dump_json()
        dto2 = SolveResultDto.model_validate_json(raw)
        assert dto2 == dto

    def test_dict_roundtrip(self) -> None:
        dto = SolveResultDto.model_validate(solve_payload())
        assert SolveResultDto.model_validate(dto.model_dump()) == dto


# ---------------------------------------------------------------------------
# 2. 映射完备性 / 一致性
# ---------------------------------------------------------------------------

class TestStopReasonStatusMapping:
    def test_mapping_covers_all_stop_reasons(self) -> None:
        assert set(STOP_REASON_TO_STATUS) == set(StopReason)

    def test_label_covers_all_stop_reasons(self) -> None:
        assert set(STOP_REASON_LABEL_ZH) == set(StopReason)

    def test_classify_matches_dict(self) -> None:
        for r in StopReason:
            assert classify_stop_reason(r) is STOP_REASON_TO_STATUS[r]

    def test_label_matches_dict(self) -> None:
        for r in StopReason:
            assert label_zh(r) == STOP_REASON_LABEL_ZH[r]

    @pytest.mark.parametrize(
        ("reason", "expected"),
        [
            (StopReason.SOLVED, StatusCode.SOLVED),
            (StopReason.REVIEWS_COMPLETE, StatusCode.UNSOLVED),
            (StopReason.REVISE_REJECTED, StatusCode.REVISE_REJECTED),
            (StopReason.MAX_ITER, StatusCode.UNSOLVED),
            (StopReason.TIMEOUT, StatusCode.UNSOLVED),
            (StopReason.B