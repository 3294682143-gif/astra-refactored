"""Explicit uncommitted-source provenance for a user-authorized local run."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from tarfile import open as open_archive


def source_files(root):
    root = Path(root).resolve(strict=True)
    paths = (
        subprocess.check_output(
            [
                "git",
                "--no-optional-locks",
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            cwd=root,
        )
        .decode()
        .split("\0")
    )
    records = []
    for name in sorted(set(paths) - {""}):
        path = root / name
        if not path.is_file():
            continue
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError("source snapshot cannot include external/symlink files")
        records.append(
            {"path": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        )
    if not records:
        raise ValueError("empty source inventory")
    return records


def capture(root, output, runtime_hash):
    root, output = Path(root).resolve(strict=True), Path(output).resolve()
    if output.is_relative_to(root):
        raise ValueError("source snapshot must be outside the implementation root")
    archive = output.with_suffix(".tar.gz")
    if output.exists() or archive.exists():
        raise ValueError("source snapshot must not overwrite existing evidence")
    files = source_files(root)
    base = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    dirty = bool(
        subprocess.check_output(
            ["git", "--no-optional-locks", "status", "--porcelain"], cwd=root
        ).strip()
    )
    with open_archive(archive, "x:gz") as bundle:
        for record in files:
            bundle.add(root / record["path"], arcname=record["path"], recursive=False)
    if source_files(root) != files:
        raise ValueError("source changed during snapshot creation")
    record = {
        "schema": "uncommitted-source-v1",
        "root": str(root),
        "base_commit": base,
        "candidate_committed": False,
        "working_tree_dirty": dirty,
        "runtime_hash": runtime_hash,
        "files": files,
        "archive": str(archive),
        "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    }
    with output.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
    return {
        "path": str(output),
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    }


def validate(root, reference, runtime_hash):
    root = Path(root).resolve(strict=True)
    if not isinstance(reference, dict) or set(reference) != {"path", "sha256"}:
        raise ValueError("explicit source snapshot reference required")
    path = Path(reference["path"]).resolve(strict=True)
    if (
        path.is_relative_to(root)
        or hashlib.sha256(path.read_bytes()).hexdigest() != reference["sha256"]
    ):
        raise ValueError("source snapshot identity mismatch")
    record = json.loads(path.read_text(encoding="utf-8"))
    if (
        set(record)
        != {
            "schema",
            "root",
            "base_commit",
            "candidate_committed",
            "working_tree_dirty",
            "runtime_hash",
            "files",
            "archive",
            "archive_sha256",
        }
        or record["schema"] != "uncommitted-source-v1"
        or record["root"] != str(root)
        or record["candidate_committed"] is not False
        or type(record["working_tree_dirty"]) is not bool
        or re.fullmatch(r"[0-9a-f]{40}", record["base_commit"]) is None
        or record["runtime_hash"] != runtime_hash
    ):
        raise ValueError("invalid source snapshot provenance")
    base = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    if base != record["base_commit"] or source_files(root) != record["files"]:
        raise ValueError("working source changed after snapshot freeze")
    archive = Path(record["archive"]).resolve(strict=True)
    if (
        archive != path.with_suffix(".tar.gz")
        or hashlib.sha256(archive.read_bytes()).hexdigest() != record["archive_sha256"]
    ):
        raise ValueError("source snapshot archive changed")
    return record
