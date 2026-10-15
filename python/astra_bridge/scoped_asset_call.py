"""G7/PR7 (Slice 7b) — Host-side scoped asset call enforcement.

The TS M2/M3/M5 side may only reference a registered math asset **within a
trusted scope and contract version**. This module turns such a reference into a
bounded, integrity-checked descriptor or refuses it with a fixed code. It is the
Host half of the "范围化调用" (scoped call): the TS side never passes an arbitrary
path or reads an asset directly.

Scoped here means: the asset must be in the Host registry, the scope id must be a
canonical scope hash, and the contract version must be one the Host accepts
(``{1,2}``, per the G3/PR4 contractVersion relaxation). No I/O beyond reading the
registry/integrity; no execution.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from .host_assets_registry import ASSET_GROUPS, load_frozen_baseline, registry_snapshot

__all__ = ["AssetCallError", "scoped_asset_call"]

_ACCEPTED_CONTRACT_VERSIONS = (1, 2)


class AssetCallError(Exception):
    """Fixed-code scoped-asset failure; never carries raw input."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _is_hash64(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scoped_asset_call(group, asset_id, *, scope_id, contract_version, root):
    """Return a bounded scoped descriptor for one registered math asset.

    Refuses an unknown group/asset, a non-canonical scope id or a contract
    version the Host does not accept.
    """
    if group not in ASSET_GROUPS:
        raise AssetCallError("UNKNOWN_GROUP")
    if not isinstance(asset_id, str) or not asset_id:
        raise AssetCallError("UNKNOWN_ASSET")
    if not _is_hash64(scope_id):
        raise AssetCallError("BAD_SCOPE")
    if contract_version not in _ACCEPTED_CONTRACT_VERSIONS:
        raise AssetCallError("BAD_VERSION")

    root = Path(root)
    snapshot = registry_snapshot(root)
    entries = snapshot[group]["entries"]
    if asset_id not in entries:
        raise AssetCallError("UNKNOWN_ASSET")

    # Frozen-baseline tamper detection: the live hash must equal the committed
    # baseline SHA. A single-byte change to any registered asset (or the family
    # catalog) is a fail-closed ASSET_INTEGRITY_ERROR.
    baseline = load_frozen_baseline()
    if group == "mathFamilies":
        path = root / "math_families" / "catalog.json"
        expected = baseline.get("mathFamilies", {}).get("catalogSha256")
    else:
        path = {
            "outputCheckers": root / "mathagent" / "output_checks" / asset_id,
            "skills": root / "mathagent" / "resources" / "skills" / asset_id,
            "prompts": root / "mathagent" / "prompts" / asset_id,
        }[group]
        expected = baseline.get("assets", {}).get(group, {}).get(asset_id)
    if not path.is_file():
        raise AssetCallError("ASSET_INTEGRITY_ERROR")
    live = _sha256(path)
    if expected is None or live != expected:
        raise AssetCallError("ASSET_INTEGRITY_ERROR")
    # Deep freeze: a mathFamilies reference also verifies every concrete algorithm
    # file under math_families/** against the frozen baseline.
    if group == "mathFamilies":
        for rel, want in (baseline.get("mathFamilies", {}).get("files") or {}).items():
            member = root / rel
            if not member.is_file() or _sha256(member) != want:
                raise AssetCallError("ASSET_INTEGRITY_ERROR")

    descriptor = {
        "group": group,
        "assetId": asset_id,
        "scopeId": scope_id,
        "contractVersion": contract_version,
        "sha256": live,
    }
    return descriptor
