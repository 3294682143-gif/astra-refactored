"""Zygos Universal Domain Host & Multi-Domain Asset Registry."""
from __future__ import annotations

from .universal_asset_registry import (
    AssetExecutionResult,
    DomainAssetSpec,
    UniversalAssetRegistry,
    get_global_asset_registry,
)

__all__ = [
    "AssetExecutionResult",
    "DomainAssetSpec",
    "UniversalAssetRegistry",
    "get_global_asset_registry",
]
