"""Topic Memory, Provenance Tracking, Invalidation, and Multi-Format Export (Track 160 AI4S E14).

Complies with Section 9.2 of the Unified Scientific Multi-Agent Execution Plan:
- Multi-tier memory: In-run state, scenario session memory, and long-term topic memory.
- Strict provenance tracking: Every hypothesis, derivation, and audit record binds to data versions and run IDs.
- Cascading invalidation (T37): Upstream dataset modifications or premise invalidations cascade
  to invalidate all derived hypotheses and dependent records.
- User control: View provenance, selectively remove records, and toggle reuse allowance.
- Multi-format export: Formatted JSON, academic Markdown report, and sealed ZIP archive with SHA-256 manifest.
- Time-capsule verification: Validate archive cryptographic integrity and provenance chains.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
import time
from typing import Any, Dict, List, Optional
import zipfile


_TOPIC_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


@dataclass
class HypothesisRecord:
    hypothesis_id: str
    statement: str
    status: str  # "PENDING" | "VALIDATED" | "INVALIDATED" | "REQUIRES_REVERIFICATION"
    data_version_ids: List[str] = field(default_factory=list)
    evidence_hashes: List[str] = field(default_factory=list)
    provenance: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)


@dataclass
class TopicMemoryRecord:
    record_id: str
    topic_id: str
    kind: str  # "HYPOTHESIS" | "OBSERVATION" | "DERIVATION_STEP" | "AUDIT_VERDICT" | "PARAMETER_BOUND"
    content: Dict[str, Any] = field(default_factory=dict)
    provenance_run_id: Optional[str] = None
    data_version_ids: List[str] = field(default_factory=list)
    allow_reuse: bool = True
    is_invalidated: bool = False
    invalidation_reason: Optional[str] = None
    created_at: float = field(default_factory=time.time)


@dataclass
class TopicArchive:
    topic_id: str
    title: str
    scenario_id: str
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    hypotheses: List[HypothesisRecord] = field(default_factory=list)
    memories: List[TopicMemoryRecord] = field(default_factory=list)
    data_versions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    associated_run_ids: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "topic_id": self.topic_id,
            "title": self.title,
            "scenario_id": self.scenario_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "hypotheses": [asdict(h) for h in self.hypotheses],
            "memories": [asdict(m) for m in self.memories],
            "data_versions": self.data_versions,
            "associated_run_ids": self.associated_run_ids,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> TopicArchive:
        hypotheses = [HypothesisRecord(**h) for h in data.get("hypotheses", [])]
        memories = [TopicMemoryRecord(**m) for m in data.get("memories", [])]
        return cls(
            topic_id=data["topic_id"],
            title=data.get("title", ""),
            scenario_id=data.get("scenario_id", ""),
            created_at=data.get("created_at", time.time()),
            updated_at=data.get("updated_at", time.time()),
            hypotheses=hypotheses,
            memories=memories,
            data_versions=data.get("data_versions", {}),
            associated_run_ids=data.get("associated_run_ids", []),
        )


class TopicMemoryManager:
    """Manages persistent scientific research topic memory, cascading invalidation, and exports."""

    def __init__(self, root_dir: Path | str) -> None:
        self.root_dir = Path(root_dir)
        self.topics_dir = self.root_dir / "topics"
        self.topics_dir.mkdir(parents=True, exist_ok=True)

    def _topic_path(self, topic_id: str) -> Path:
        if not isinstance(topic_id, str) or not _TOPIC_ID_RE.fullmatch(topic_id) or ".." in topic_id:
            raise ValueError("invalid topic_id")
        path = (self.topics_dir / topic_id / "topic.json").resolve()
        if not path.is_relative_to(self.topics_dir.resolve()):
            raise ValueError("unsafe topic_id")
        return path

    def create_topic(self, topic_id: str, title: str, scenario_id: str) -> TopicArchive:
        existing = self.get_topic(topic_id)
        if existing is not None:
            return existing
        archive = TopicArchive(topic_id=topic_id, title=title, scenario_id=scenario_id)
        self.save_topic(archive)
        return archive

    def save_topic(self, archive: TopicArchive) -> None:
        archive.updated_at = time.time()
        topic_file = self._topic_path(archive.topic_id)
        topic_file.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(archive.to_dict(), ensure_ascii=False, indent=2)
        temporary = topic_file.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(raw, encoding="utf-8")
        os.replace(temporary, topic_file)

    def get_topic(self, topic_id: str) -> Optional[TopicArchive]:
        path = self._topic_path(topic_id)
        if not path.is_file():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return TopicArchive.from_dict(data)

    def add_data_version(
        self,
        topic_id: str,
        version_id: str,
        dataset_name: str,
        sha256: str,
        record_count: Optional[int],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        archive = self.get_topic(topic_id)
        if not archive:
            raise KeyError(f"Topic '{topic_id}' not found")
        if version_id in archive.data_versions:
            raise ValueError(f"Data version '{version_id}' already exists")
        archive.data_versions[version_id] = {
            "version_id": version_id,
            "dataset_name": dataset_name,
            "sha256": sha256,
            "record_count": record_count,
            "metadata": metadata or {},
            "registered_at": time.time(),
            "status": "ACTIVE",
        }
        self.save_topic(archive)

    def add_hypothesis(
        self,
        topic_id: str,
        hypothesis_id: str,
        statement: str,
        data_version_ids: List[str],
        evidence_hashes: Optional[List[str]] = None,
        provenance: Optional[Dict[str, Any]] = None,
    ) -> HypothesisRecord:
        archive = self.get_topic(topic_id)
        if not archive:
            raise KeyError(f"Topic '{topic_id}' not found")

        if any(existing.hypothesis_id == hypothesis_id for existing in archive.hypotheses):
            raise ValueError(f"Hypothesis '{hypothesis_id}' already exists")
        hyp = HypothesisRecord(
            hypothesis_id=hypothesis_id,
            statement=statement,
            status="PENDING",
            data_version_ids=data_version_ids,
            evidence_hashes=evidence_hashes or [],
            provenance=provenance or {},
        )
        archive.hypotheses.append(hyp)
        self.save_topic(archive)
        return hyp

    def record_memory(
        self,
        topic_id: str,
        record_id: str,
        kind: str,
        content: Dict[str, Any],
        provenance_run_id: Optional[str] = None,
        data_version_ids: Optional[List[str]] = None,
        allow_reuse: bool = True,
    ) -> TopicMemoryRecord:
        archive = self.get_topic(topic_id)
        if not archive:
            raise KeyError(f"Topic '{topic_id}' not found")

        if any(existing.record_id == record_id for existing in archive.memories):
            raise ValueError(f"Memory record '{record_id}' already exists")
        if provenance_run_id and provenance_run_id not in archive.associated_run_ids:
            archive.associated_run_ids.append(provenance_run_id)

        rec = TopicMemoryRecord(
            record_id=record_id,
            topic_id=topic_id,
            kind=kind,
            content=content,
            provenance_run_id=provenance_run_id,
            data_version_ids=data_version_ids or [],
            allow_reuse=allow_reuse,
            is_invalidated=False,
        )
        archive.memories.append(rec)
        self.save_topic(archive)
        return rec

    def cascade_invalidate_data_version(
        self, topic_id: str, version_id: str, reason: str = "Upstream data updated or revoked"
    ) -> Dict[str, List[str]]:
        """Cascading invalidation (T37): Invalidate all memories and hypotheses depending on version_id."""
        archive = self.get_topic(topic_id)
        if not archive:
            raise KeyError(f"Topic '{topic_id}' not found")

        invalidated_memories: List[str] = []
        invalidated_hypotheses: List[str] = []

        # 1. Update data version status
        if version_id in archive.data_versions:
            archive.data_versions[version_id]["status"] = "INVALIDATED"
            archive.data_versions[version_id]["invalidation_reason"] = reason

        # 2. Invalidate dependent memory records
        for mem in archive.memories:
            if version_id in mem.data_version_ids and not mem.is_invalidated:
                mem.is_invalidated = True
                mem.allow_reuse = False
                mem.invalidation_reason = f"Cascaded from data version {version_id}: {reason}"
                invalidated_memories.append(mem.record_id)

        # 3. Mark dependent hypotheses as REQUIRES_REVERIFICATION
        for hyp in archive.hypotheses:
            if version_id in hyp.data_version_ids:
                hyp.status = "REQUIRES_REVERIFICATION"
                invalidated_hypotheses.append(hyp.hypothesis_id)

        self.save_topic(archive)
        return {
            "invalidated_memories": invalidated_memories,
            "invalidated_hypotheses": invalidated_hypotheses,
        }

    def remove_memory(self, topic_id: str, record_id: str) -> bool:
        archive = self.get_topic(topic_id)
        if not archive:
            return False
        orig_len = len(archive.memories)
        archive.memories = [m for m in archive.memories if m.record_id != record_id]
        if len(archive.memories) != orig_len:
            self.save_topic(archive)
            return True
        return False

    def set_memory_reuse(self, topic_id: str, record_id: str, allow_reuse: bool) -> bool:
        archive = self.get_topic(topic_id)
        if not archive:
            return False
        for mem in archive.memories:
            if mem.record_id == record_id:
                mem.allow_reuse = allow_reuse
                self.save_topic(archive)
                return True
        return False

    # -------------------------------------------------------------------------
    # Multi-Format Export
    # -------------------------------------------------------------------------
    def export_json(self, topic_id: str) -> str:
        archive = self.get_topic(topic_id)
        if not archive:
            raise KeyError(f"Topic '{topic_id}' not found")
        data = archive.to_dict()
        data["export_timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        raw = json.dumps(data, ensure_ascii=False, indent=2)
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        data["integrity_sha256"] = digest
        return json.dumps(data, ensure_ascii=False, indent=2)

    def export_markdown(self, topic_id: str) -> str:
        archive = self.get_topic(topic_id)
        if not archive:
            raise KeyError(f"Topic '{topic_id}' not found")

        lines: List[str] = [
            f"# Scientific Research Topic Report: {archive.title}",
            "",
            f"- **Topic ID**: `{archive.topic_id}`",
            f"- **Scenario Domain**: `{archive.scenario_id}`",
            f"- **Created At**: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(archive.created_at))}",
            f"- **Last Updated**: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(archive.updated_at))}",
            f"- **Associated Runs**: {', '.join(archive.associated_run_ids) or 'None'}",
            "",
            "## 1. Research Hypotheses & Status",
            "",
        ]

        if not archive.hypotheses:
            lines.append("_No hypotheses registered._\n")
        else:
            lines.append("| Hypothesis ID | Statement | Status | Dependent Data Versions | Evidence |")
            lines.append("| :--- | :--- | :---: | :--- | :--- |")
            for h in archive.hypotheses:
                status_badge = f"**{h.status}**"
                data_vers = ", ".join(h.data_version_ids) or "None"
                evidence_cnt = f"{len(h.evidence_hashes)} refs"
                lines.append(f"| `{h.hypothesis_id}` | {h.statement} | {status_badge} | {data_vers} | {evidence_cnt} |")
            lines.append("")

        lines.extend([
            "## 2. Dataset Versions & Provenance (Audit Trail)",
            "",
        ])
        if not archive.data_versions:
            lines.append("_No datasets linked._\n")
        else:
            lines.append("| Version ID | Dataset Name | SHA-256 Digest | Records | Status |")
            lines.append("| :--- | :--- | :--- | :---: | :---: |")
            for vid, vinfo in archive.data_versions.items():
                short_hash = vinfo['sha256'][:16] + "..."
                record_count = vinfo['record_count'] if vinfo['record_count'] is not None else "Unknown"
                lines.append(f"| `{vid}` | {vinfo['dataset_name']} | `{short_hash}` | {record_count} | **{vinfo['status']}** |")
            lines.append("")

        lines.extend([
            "## 3. Topic Memory Records & Derivations",
            "",
        ])
        if not archive.memories:
            lines.append("_No memory records captured._\n")
        else:
            lines.append("| Record ID | Kind | Run Provenance | Reusable | Invalidated | Summary / Content |")
            lines.append("| :--- | :--- | :--- | :---: | :---: | :--- |")
            for m in archive.memories:
                run_ref = f"`{m.provenance_run_id}`" if m.provenance_run_id else "-"
                reusable = "YES" if m.allow_reuse else "NO"
                inval = f"INVALIDATED ({m.invalidation_reason})" if m.is_invalidated else "ACTIVE"
                summary_str = json.dumps(m.content, ensure_ascii=False)
                if len(summary_str) > 80:
                    summary_str = summary_str[:77] + "..."
                lines.append(f"| `{m.record_id}` | {m.kind} | {run_ref} | {reusable} | {inval} | {summary_str} |")
            lines.append("")

        lines.extend([
            "---",
            f"*Generated by Inkstone / Astra Scientific Multi-Agent Workbench at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}*",
        ])
        return "\n".join(lines)

    def export_zip(self, topic_id: str, output_path: Path | str) -> Path:
        out_p = Path(output_path)
        out_p.parent.mkdir(parents=True, exist_ok=True)

        json_content = self.export_json(topic_id)
        md_content = self.export_markdown(topic_id)
        archive = self.get_topic(topic_id)
        if not archive:
            raise KeyError(f"Topic '{topic_id}' not found")

        manifest = {
            "archive_format": "INKSTONE_RESEARCH_ARCHIVE_V1",
            "topic_id": archive.topic_id,
            "title": archive.title,
            "scenario_id": archive.scenario_id,
            "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "files": {
                "topic.json": hashlib.sha256(json_content.encode("utf-8")).hexdigest(),
                "report.md": hashlib.sha256(md_content.encode("utf-8")).hexdigest(),
            },
        }
        manifest_raw = json.dumps(manifest, ensure_ascii=False, indent=2)

        with zipfile.ZipFile(out_p, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("manifest.json", manifest_raw)
            zf.writestr("topic.json", json_content)
            zf.writestr("report.md", md_content)

        return out_p

    @staticmethod
    def verify_topic_archive(zip_path: Path | str) -> Dict[str, Any]:
        """Time-capsule verification: inspects archive integrity and cryptographic checksums."""
        zpath = Path(zip_path)
        if not zpath.is_file():
            return {"valid": False, "error": f"File {zpath} does not exist"}

        try:
            with zipfile.ZipFile(zpath, mode="r") as zf:
                names = zf.namelist()
                if "manifest.json" not in names or "topic.json" not in names:
                    return {"valid": False, "error": "Archive missing manifest.json or topic.json"}

                manifest_data = json.loads(zf.read("manifest.json").decode("utf-8"))
                expected_files = manifest_data.get("files", {})

                for filename, expected_hash in expected_files.items():
                    if filename not in names:
                        return {"valid": False, "error": f"File {filename} declared in manifest missing"}
                    actual_data = zf.read(filename)
                    actual_hash = hashlib.sha256(actual_data).hexdigest()
                    if actual_hash != expected_hash:
                        return {
                            "valid": False,
                            "error": f"Checksum mismatch for {filename}: expected {expected_hash}, got {actual_hash}",
                        }

                topic_data = json.loads(zf.read("topic.json").decode("utf-8"))
                records_count = len(topic_data.get("memories", []))
                hypotheses_count = len(topic_data.get("hypotheses", []))

                return {
                    "valid": True,
                    "topic_id": topic_data.get("topic_id"),
                    "scenario_id": topic_data.get("scenario_id"),
                    "records_verified": records_count,
                    "hypotheses_verified": hypotheses_count,
                    "manifest_format": manifest_data.get("archive_format"),
                }
        except Exception as exc:
            return {"valid": False, "error": f"Archive verification failed with exception: {exc}"}
