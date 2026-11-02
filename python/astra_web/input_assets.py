from __future__ import annotations

import base64
import hashlib
import re
from pathlib import Path
from typing import Any, Sequence

_MAX_ASSET_BYTES = 25 * 1024 * 1024
_ALLOWED_EXTENSIONS = {".csv", ".tsv", ".json", ".txt", ".tex", ".cif", ".parquet", ".pdf", ".png", ".jpg", ".jpeg"}
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_input_assets(
    input_refs: Any,
    *,
    storage_root: Path,
    repo_root: Path,
) -> list[dict[str, Any]]:
    if input_refs is None:
        return []
    if not isinstance(input_refs, Sequence) or isinstance(input_refs, (str, bytes)):
        raise ValueError("inputRefs must be an array")
    if len(input_refs) > 8:
        raise ValueError("at most 8 input assets are allowed")
    resolved: list[dict[str, Any]] = []
    for ref in input_refs:
        if not isinstance(ref, str) or not ref or "\x00" in ref:
            raise ValueError("each input reference must be a non-empty string")
        if ref.startswith("benchmarks/"):
            root = (repo_root / "data").resolve()
        elif ref.startswith("uploads/"):
            root = storage_root.resolve()
        else:
            raise ValueError(f"unsupported input reference: {ref}")
        target = (root / ref).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise ValueError(f"input asset not found or unsafe: {ref}")
        if target.suffix.lower() not in _ALLOWED_EXTENSIONS:
            raise ValueError(f"unsupported input asset extension: {target.suffix}")
        size = target.stat().st_size
        if size <= 0 or size > _MAX_ASSET_BYTES:
            raise ValueError(f"input asset size is outside the allowed limit: {ref}")
        resolved.append({
            "ref": ref,
            "path": str(target),
            "sha256": _sha256(target),
            "bytes": size,
        })
    return resolved


def store_uploaded_asset(
    *,
    storage_root: Path,
    file_name: Any,
    content_base64: Any,
) -> dict[str, Any]:
    if not isinstance(file_name, str) or not _SAFE_NAME.fullmatch(file_name) or ".." in file_name:
        raise ValueError("invalid upload file name")
    if Path(file_name).suffix.lower() not in _ALLOWED_EXTENSIONS:
        raise ValueError("unsupported upload file extension")
    if not isinstance(content_base64, str):
        raise ValueError("contentBase64 must be a string")
    try:
        content = base64.b64decode(content_base64, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("contentBase64 is invalid") from exc
    if len(content) <= 0 or len(content) > _MAX_ASSET_BYTES:
        raise ValueError("upload size is outside the allowed limit")
    asset_id = hashlib.sha256(content).hexdigest()
    target_dir = storage_root / "uploads" / asset_id
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / file_name
    if not target.exists():
        target.write_bytes(content)
    ref = f"uploads/{asset_id}/{file_name}"
    return resolve_input_assets([ref], storage_root=storage_root, repo_root=storage_root)[0]
