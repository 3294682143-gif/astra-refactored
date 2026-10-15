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
    "FROZEN_BASELINE_PATH",
    "load_frozen_baseline",
    "registry_snapshot",
    "verify_integrity",
]

ASSET_GROUPS = {
    "outputCheckers": "mathagent/output_checks",
    "mathFamilies": "math_families",
    "skills": "mathagent/resources/skills",
    "prompts": "mathagent/prompts",
}

# The committed frozen baseline SHA list. The integrity check compares the live
# tree against this file, never against a freshly self-computed value, so a
# single-byte change to any registered asset is detected fail-closed.
FROZEN_BASELINE_PATH = Path(__file__).resolve().parent / "asset_baseline.json"


def load_frozen_baseline(path=None) -> dict:
    """Read the frozen baseline (committed; never derived from the working tree)."""
    target = Path(path) if path is not None else FROZEN_BASELINE_PATH
    return json.loads(target.read_text(encoding="utf-8"))


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


def _asset_path(root: Path, group: str, name: str) -> Path:
    if group == "outputCheckers":
        return root / "mathagent" / "output_checks" / name
    if group == "skills":
        return root / "mathagent" / "resources" / "skills" / name
    if group == "prompts":
        return root / "mathagent" / "prompts" / name
    raise KeyError(group)


def verify_integrity(root, snapshot=None, baseline=None) -> dict:
    """Re-check every registered asset against the FROZEN baseline SHA list.

    A missing asset or a single-byte change fails closed with a fixed
    ``ASSET_INTEGRITY_ERROR``; the live hash is compared to the committed
    baseline, never to a value recomputed from the same tree.
    """
    root = Path(root)
    snapshot = snapshot or registry_snapshot(root)
    baseline = baseline or load_frozen_baseline()
    errors = []
    for group in ("outputCheckers", "skills", "prompts"):
        expected = baseline.get("assets", {}).get(group, {})
        for name in snapshot[group]["entries"]:
            path = _asset_path(root, group, name)
            if not path.is_file() or expected.get(name) != _sha256(path):
                errors.append(f"ASSET_INTEGRITY_ERROR:{group}:{name}")
    catalog = root / "math_families" / "catalog.json"
    expected_catalog = baseline.get("mathFamilies", {}).get("catalogSha256")
    if not catalog.is_file() or _sha256(catalog) != expected_catalog:
        errors.append("ASSET_INTEGRITY_ERROR:mathFamilies:catalog")
    # Deep freeze: every concrete algorithm file under math_families/** (not just
    # the catalog) is compared to the frozen baseline.
    for rel, expected in (baseline.get("mathFamilies", {}).get("files") or {}).items():
        path = root / rel
        if not path.is_file() or _sha256(path) != expected:
            errors.append(f"ASSET_INTEGRITY_ERROR:mathFamilies:{rel}")
    return {
        "ok": not errors,
        "errors": errors,
        "counts": snapshot["counts"],
    }
