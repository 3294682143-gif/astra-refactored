"""Astra Web 契约 - JSON Schema 导出脚本."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from python.astra_web.contracts.dto import (
    CapabilitiesDto,
    ErrorDto,
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
    "ErrorDto": ErrorDto,
}

SCHEMA_VERSION = "1.0.0"


def build_one(model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema(
        by_alias=True,
        ref_template="#/$defs/{model}",
    )
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["x-contract-version"] = SCHEMA_VERSION
    schema["title"] = model.__name__
    return schema


def write_schemas(out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name, model in SCHEMA_MODELS.items():
        path = out_dir / f"{name}.schema.json"
        content = json.dumps(build_one(model), ensure_ascii=False, indent=2) + "\n"
        path.write_text(content, encoding="utf-8")
        written.append(path)
    return written


if __name__ == "__main__":
    target_dir = Path(__file__).resolve().parents[3] / "packages" / "web-contract" / "schema"
    files = write_schemas(target_dir)
    print(f"Exported {len(files)} JSON Schemas to {target_dir}")
