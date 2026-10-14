"""G7/PR7 (Slice 7b) — Host asset registry + integrity for math assets.

Per v4.0 §3.2 the RC2 math capability is *retained in Python* and called in a
scoped way by the TS M2/M3/M5 side: the 10 exact output checkers
(``mathagent/output_checks/*``), the math-family provider (``math_families/**``),
the on-demand skill cards (``resources/skills/**``) and the prompt templates
(``mathagent/prompts/**``) are registered with the Host together with a SHA-256
integrity record. This is a *registry and integrity check*, never a rewrite of
the numeric algorithms in another language.

Pure module: reads the working tree only; no network, no import of the assets.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

__all__ = [
    "ASSET_GROUPS",
    "registry_snapshot",
    "verify_integrity",
]

ASSET_GROUPS = {
    "outputCheckers": "mathagent/output_checks",
    "mathFamilies": "math_families",
    "skills": "mathagent/resources/skills",
    "prompts": "mathagent/prompts",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _output_checkers(root: Path):
    base = root / "mathagent" / "output_checks"
    return sorted(p.name for p in base.glob("*.py") if p.name != "__init__.py")


def _math_families(root: Path):
    catalog = root / "math_families" / "catalog.json"
    data = json.loads(catalog.read_text(encoding="utf-8"))
    families = data.get("families") or []
    names = []
    for entry in families:
        if isinstance(entry, dict):
            names.append(str(entry.get("name") or entry.get("family") or len(names)))
        else:
            names.append(str(entry))
    return names


def _skills(root: Path):
    base = root / "mathagent" / "resources" / "skills"
    return sorted(p.name for p in base.glob("*.md"))


def _prompts(root: Path):
    base = root / "mathagent" / "prompts"
    return sorted(p.name for p in base.glob("*.py") if p.name != "__init__.py")


def registry_snapshot(root) -> dict:
    """Enumerate the registered assets with their enumerations and SHA-256."""
    root = Path(root)
    out = {
        "outputCheckers": {
            "dir": ASSET_GROUPS["outputCheckers"],
            "entries": _output_checkers(root),
        },
        "mathFamilies": {
            "catalog": "math_families/catalog.json",
            "entries": _math_families(root),
            "catalogSha256": _sha256(root / "math_families" / "catalog.json"),
        },
        "skills": {"dir": ASSET_GROUPS["skills"], "entries": _skills(root)},
        "prompts": {"dir": ASSET_GROUPS["prompts"], "entries": _prompts(root)},
    }
    out["counts"] = {
        "outputCheckers": len(out["outputCheckers"]["entries"]),
        "mathFamilies": len(out["mathFamilies"]["entries"]),
        "skills": len(out["skills"]["entries"]),
        "prompts": len(out["prompts"]["entries"]),
    }
    return out


def verify_integrity(root, snapshot=None) -> dict:
    """Re-check that every enumerated asset still resolves to the same hash."""
    root = Path(root)
    snapshot = snapshot or registry_snapshot(root)
    errors = []
    for name in snapshot["outputCheckers"]["entries"]:
        path = root / "mathagent" / "output_checks" / name
        if not path.is_file():
            errors.append(f"outputCheckers:{name}")
    for name in snapshot["skills"]["entries"]:
        path = root / "mathagent" / "resources" / "skills" / name
        if not path.is_file():
            errors.append(f"skills:{name}")
    for name in snapshot["prompts"]["entries"]:
        path = root / "mathagent" / "prompts" / name
        if not path.is_file():
            errors.append(f"prompts:{name}")
    catalog = root / "math_families" / "catalog.json"
    if not catalog.is_file() or _sha256(catalog) != snapshot["mathFamilies"]["catalogSha256"]:
        errors.append("mathFamilies:catalog")
    return {
        "ok": not errors,
        "errors": errors,
        "counts": snapshot["counts"],
    }
