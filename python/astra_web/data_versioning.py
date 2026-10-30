"""Data versioning and artifact invalidation registry (F-10 / K17 / T37).

Enforces:
1. Dataset versioning: v1 -> v2 creates new immutable version without overwriting history.
2. Artifact lineage: Artifacts explicitly track upstream dataset ID, version, and content hash.
3. Invalidation: Updating upstream dataset automatically marks downstream artifacts STALE
   while preserving historical identity and cryptographic hashes.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time
from typing import Any, Dict, List, Optional


class DataVersionManager:
    """Manages versioned datasets and automated artifact invalidation (T37)."""

    def __init__(self, storage_root: Path):
        self.storage_root = storage_root
        self.datasets_dir = storage_root / "datasets"
        self.artifacts_dir = storage_root / "artifacts"
        self.registry_file = storage_root / "version_registry.json"

        self.datasets_dir.mkdir(parents=True, exist_ok=True)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self._load_registry()

    def _load_registry(self) -> None:
        if self.registry_file.is_file():
            try:
                self._state = json.loads(self.registry_file.read_text(encoding="utf-8"))
            except Exception:
                self._state = {"datasets": {}, "artifacts": {}}
        else:
            self._state = {"datasets": {}, "artifacts": {}}

    def _save_registry(self) -> None:
        self.registry_file.write_text(json.dumps(self._state, indent=2, ensure_ascii=False), encoding="utf-8")

    @staticmethod
    def _compute_hash(data: Any) -> str:
        serialized = json.dumps(data, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    def register_dataset(self, dataset_id: str, payload: Dict[str, Any], description: str = "") -> Dict[str, Any]:
        """Register a new dataset (version 1)."""
        content_hash = self._compute_hash(payload)
        version = 1

        record = {
            "datasetId": dataset_id,
            "version": version,
            "contentHash": content_hash,
            "description": description,
            "createdAt": time.time(),
            "versionsHistory": [
                {"version": 1, "contentHash": content_hash, "timestamp": time.time()}
            ],
        }

        # Store immutable dataset snapshot
        snapshot_file = self.datasets_dir / f"{dataset_id}_v{version}.json"
        snapshot_file.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

        self._state["datasets"][dataset_id] = record
        self._save_registry()
        return record

    def update_dataset(self, dataset_id: str, new_payload: Dict[str, Any], reason: str = "") -> Dict[str, Any]:
        """Update dataset to a new version, triggering T37 downstream artifact invalidation."""
        if dataset_id not in self._state["datasets"]:
            raise KeyError(f"Dataset '{dataset_id}' does not exist.")

        record = self._state["datasets"][dataset_id]
        old_version = record["version"]
        new_version = old_version + 1
        new_hash = self._compute_hash(new_payload)

        # Store immutable snapshot for new version
        snapshot_file = self.datasets_dir / f"{dataset_id}_v{new_version}.json"
        snapshot_file.write_text(json.dumps(new_payload, indent=2, ensure_ascii=False), encoding="utf-8")

        record["version"] = new_version
        record["contentHash"] = new_hash
        record["versionsHistory"].append({
            "version": new_version,
            "contentHash": new_hash,
            "timestamp": time.time(),
            "updateReason": reason,
        })

        # T37 Automated Invalidation: Find all artifacts tied to this dataset and older versions
        invalidated_count = 0
        for art_id, art in self._state["artifacts"].items():
            if art["datasetId"] == dataset_id and art["datasetVersion"] < new_version:
                if art["status"] == "ACTIVE":
                    art["status"] = "STALE"
                    art["invalidationReason"] = (
                        f"T37_DATASET_VERSION_UPDATED: Upstream dataset '{dataset_id}' "
                        f"promoted from v{art['datasetVersion']} to v{new_version}"
                    )
                    art["invalidatedAt"] = time.time()
                    invalidated_count += 1

        self._save_registry()
        return {
            "dataset": record,
            "invalidatedArtifactsCount": invalidated_count,
            "newVersion": new_version,
        }

    def register_artifact(
        self,
        artifact_id: str,
        dataset_id: str,
        dataset_version: int,
        content: Dict[str, Any],
        kind: str = "EXPERIMENT_REPORT",
    ) -> Dict[str, Any]:
        """Register an experiment artifact tied to a specific dataset version."""
        if dataset_id not in self._state["datasets"]:
            raise KeyError(f"Dataset '{dataset_id}' does not exist.")

        ds_record = self._state["datasets"][dataset_id]
        is_current_version = (ds_record["version"] == dataset_version)

        art_hash = self._compute_hash(content)
        art_file = self.artifacts_dir / f"{artifact_id}.json"
        art_file.write_text(json.dumps(content, indent=2, ensure_ascii=False), encoding="utf-8")

        art_record = {
            "artifactId": artifact_id,
            "kind": kind,
            "datasetId": dataset_id,
            "datasetVersion": dataset_version,
            "upstreamDatasetHash": ds_record["contentHash"] if is_current_version else "OUTDATED_HASH",
            "artifactHash": art_hash,
            "status": "ACTIVE" if is_current_version else "STALE",
            "invalidationReason": None if is_current_version else "REGISTERED_AGAINST_HISTORICAL_DATASET",
            "createdAt": time.time(),
        }

        self._state["artifacts"][artifact_id] = art_record
        self._save_registry()
        return art_record

    def get_artifact(self, artifact_id: str) -> Optional[Dict[str, Any]]:
        return self._state["artifacts"].get(artifact_id)

    def get_dataset(self, dataset_id: str) -> Optional[Dict[str, Any]]:
        return self._state["datasets"].get(dataset_id)
