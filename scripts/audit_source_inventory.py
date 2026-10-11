#!/usr/bin/env python3
"""G0 read-only git source inventory audit (TASK-0029 core slice).

Emits a deterministic, machine-checkable inventory of a source commit tree,
the a2 delta against it, and per-path classification/ownership candidates.
Nothing here certifies migration: every matched row stays REVIEW_REQUIRED and
the CLI exits 2 until independent human acceptance exists.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import subprocess
import sys

GIT_TIMEOUT = 30
CLASSES = (
    "RUNTIME",
    "MATH",
    "HOST",
    "ASSET",
    "TEST",
    "DOC",
    "CONFIG",
    "REVIEW_REQUIRED",
)
REGULAR_MODES = ("100644", "100755")
_HEX40 = re.compile("[0-9a-f]{40}")
LEVELS = ("L1", "L2", "L1+L2")


class AuditError(Exception):
    """Fixed-code failure; details never reach stdout."""


def _git(repo, args):
    argv = ["git", "-C", repo] + list(args)
    try:
        proc = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=GIT_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise AuditError("GIT_EXEC_FAILED") from exc
    if proc.returncode != 0:
        raise AuditError("GIT_COMMAND_FAILED")
    return proc.stdout


def _reject_ref(ref):
    if not isinstance(ref, str) or not ref or ref.startswith("-"):
        raise AuditError("INVALID_REF")
    if any(ch in ref for ch in ("\x00", "\n", "\r")):
        raise AuditError("INVALID_REF")
    return ref


def _resolve(repo, ref):
    ref = _reject_ref(ref)
    commit = _git(
        repo, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]
    ).decode("utf-8", "replace").strip()
    if not _HEX40.fullmatch(commit):
        raise AuditError("UNRESOLVED_REF")
    tree = _git(
        repo, ["rev-parse", "--verify", "--end-of-options", commit + "^{tree}"]
    ).decode("utf-8", "replace").strip()
    if not _HEX40.fullmatch(tree):
        raise AuditError("UNRESOLVED_REF")
    return commit, tree


def _ls_tree(repo, commit):
    """Parse `ls-tree -rz -l` NUL records; paths keep spaces/tabs/Unicode."""
    raw = _git(repo, ["ls-tree", "-rz", "-l", commit])
    entries = []
    for record in raw.split(b"\x00"):
        if not record:
            continue
        meta, sep, path = record.partition(b"\t")
        if not sep:
            raise AuditError("MALFORMED_LS_TREE")
        fields = meta.split()
        if len(fields) != 4:
            raise AuditError("MALFORMED_LS_TREE")
        mode = fields[0].decode("ascii", "replace")
        obj_type = fields[1].decode("ascii", "replace")
        blob = fields[2].decode("ascii", "replace")
        size_field = fields[3]
        if size_field == b"-":
            size = None
        else:
            try:
                size = int(size_field)
            except ValueError as exc:
                raise AuditError("MALFORMED_LS_TREE") from exc
        entries.append(
            {
                "mode": mode,
                "type": obj_type,
                "blob": blob,
                "size": size,
                "path": path.decode("utf-8", "surrogateescape"),
            }
        )
    entries.sort(key=lambda item: item["path"])
    return entries


def _source_id(path):
    return hashlib.sha256(path.encode("utf-8", "surrogateescape")).hexdigest()


def _load_seed(seed):
    if seed is None:
        return []
    if isinstance(seed, str):
        try:
            with open(seed, "r", encoding="utf-8") as handle:
                seed = json.load(handle)
        except (OSError, ValueError) as exc:
            raise AuditError("SEED_LOAD_FAILED") from exc
    if not isinstance(seed, list):
        raise AuditError("SEED_NOT_ARRAY")
    rules = []
    for item in seed:
        if not isinstance(item, dict):
            raise AuditError("SEED_RULE_INVALID")
        pattern = item.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise AuditError("SEED_RULE_INVALID")
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            raise AuditError("SEED_PATTERN_INVALID") from exc
        rule = _validate_rule(item)
        rule["_re"] = compiled
        rules.append(rule)
    return rules


def _validate_rule(item):
    """Accept only known fields with strict types; unknown fields are dropped."""
    rule = {"pattern": item["pattern"]}
    klass = item.get("class")
    if klass is not None:
        if not isinstance(klass, str) or klass not in CLASSES:
            raise AuditError("SEED_RULE_INVALID")
        rule["class"] = klass
    owner = item.get("owner")
    if owner is not None:
        if not isinstance(owner, str) or not owner:
            raise AuditError("SEED_RULE_INVALID")
        rule["owner"] = owner
    target_paths = item.get("target_paths")
    if target_paths is not None:
        if not isinstance(target_paths, list):
            raise AuditError("SEED_RULE_INVALID")
        for path in target_paths:
            if not isinstance(path, str) or not path:
                raise AuditError("SEED_RULE_INVALID")
        rule["target_paths"] = list(target_paths)
    level = item.get("level")
    if level is not None:
        if not isinstance(level, str) or level not in LEVELS:
            raise AuditError("SEED_RULE_INVALID")
        rule["level"] = level
    decision = item.get("decision")
    if decision is not None:
        if not isinstance(decision, str) or not decision:
            raise AuditError("SEED_RULE_INVALID")
        rule["decision"] = decision
    capability_id = item.get("capability_id")
    if capability_id is not None:
        if not isinstance(capability_id, str) or not capability_id:
            raise AuditError("SEED_RULE_INVALID")
        rule["capability_id"] = capability_id
    return rule


def _fallback_class(path):
    lowered = path.lower()
    parts = lowered.split("/")
    if lowered.endswith(".md") or lowered.endswith(".rst"):
        return "DOC"
    if lowered.endswith((".json", ".toml", ".yaml", ".yml", ".ini", ".cfg")):
        return "CONFIG"
    if parts[0] in ("tests", "test") or "/tests/" in lowered:
        return "TEST"
    if parts[0] in ("docs", "doc"):
        return "DOC"
    if parts[0] in ("assets", "resources", "fixtures"):
        return "ASSET"
    return "REVIEW_REQUIRED"


def _classify(path, rules):
    matches = [rule for rule in rules if rule["_re"].fullmatch(path)]
    if not matches:
        return {
            "classification": _fallback_class(path),
            "owner": None,
            "status": "UNMAPPED",
            "matched_rule": None,
            "target_paths": [],
            "level": None,
            "decision": None,
            "capability_id": None,
        }
    owners = {rule.get("owner") for rule in matches}
    chosen = matches[0]
    if len(owners) > 1 or chosen.get("owner") is None:
        return {
            "classification": "REVIEW_REQUIRED",
            "owner": None,
            "status": "REVIEW_REQUIRED",
            "matched_rule": chosen.get("pattern"),
            "target_paths": [],
            "level": None,
            "decision": None,
            "capability_id": None,
        }
    return {
        "classification": chosen.get("class", "REVIEW_REQUIRED"),
        "owner": chosen.get("owner"),
        "status": "REVIEW_REQUIRED",
        "matched_rule": chosen.get("pattern"),
        "target_paths": list(chosen.get("target_paths") or []),
        "level": chosen.get("level"),
        "decision": chosen.get("decision"),
        "capability_id": chosen.get("capability_id"),
    }


def _target_exists(target_paths, target_index):
    if not target_paths:
        return None
    return all(path in target_index for path in target_paths)


def _inventory(entries, rules, target_index):
    rows = []
    for entry in entries:
        path = entry["path"]
        info = _classify(path, rules)
        irregular = entry["mode"] not in REGULAR_MODES or entry["type"] != "blob"
        if irregular:
            info = dict(info)
            info["classification"] = "REVIEW_REQUIRED"
            info["status"] = "UNMAPPED"
            info["owner"] = None
        rows.append(
            {
                "path": path,
                "source_id": _source_id(path),
                "mode": entry["mode"],
                "type": entry["type"],
                "blob": entry["blob"],
                "size": entry["size"],
                "classification": info["classification"],
                "owner": info["owner"],
                "status": info["status"],
                "matched_rule": info["matched_rule"],
                "target_paths": info["target_paths"],
                "target_exists": _target_exists(info["target_paths"], target_index),
                "level": info["level"],
                "decision": info["decision"],
                "capability_id": info["capability_id"],
                "test": "",
                "evidence": "",
            }
        )
    return rows


def _a2_changes(source_entries, a2_entries):
    source_index = {entry["path"]: entry for entry in source_entries}
    a2_index = {entry["path"]: entry for entry in a2_entries}
    changes = []
    for path in sorted(set(source_index) | set(a2_index)):
        src = source_index.get(path)
        a2 = a2_index.get(path)
        if src is None:
            change = "added"
        elif a2 is None:
            change = "deleted"
        elif src["blob"] != a2["blob"] or src["mode"] != a2["mode"]:
            change = "modified"
        else:
            continue
        changes.append(
            {
                "path": path,
                "change": change,
                "source_blob": None if src is None else src["blob"],
                "source_mode": None if src is None else src["mode"],
                "a2_blob": None if a2 is None else a2["blob"],
                "a2_mode": None if a2 is None else a2["mode"],
            }
        )
    return changes


def audit(repo, source, a2, target, seed_rules=None):
    """Return the G0 audit document. Read-only; never writes files."""
    rules = _load_seed(seed_rules)
    source_commit, source_tree = _resolve(repo, source)
    a2_commit, a2_tree = _resolve(repo, a2)
    target_commit, target_tree = _resolve(repo, target)
    source_entries = _ls_tree(repo, source_commit)
    a2_entries = _ls_tree(repo, a2_commit)
    target_entries = _ls_tree(repo, target_commit)
    target_index = {entry["path"] for entry in target_entries}
    inventory = _inventory(source_entries, rules, target_index)
    changes = _a2_changes(source_entries, a2_entries)
    unmapped = sum(
        1
        for row in inventory
        if row["status"] == "UNMAPPED" or row["owner"] is None
    )
    review_required = sum(
        1 for row in inventory if row["status"] == "REVIEW_REQUIRED"
    )
    classified = sum(
        1 for row in inventory if row["classification"] != "REVIEW_REQUIRED"
    )
    return {
        "source": {"commit": source_commit, "tree": source_tree},
        "a2": {"commit": a2_commit, "tree": a2_tree},
        "target": {"commit": target_commit, "tree": target_tree},
        "inventory": inventory,
        "a2_changes": changes,
        "counts": {
            "source_files": len(inventory),
            "classified": classified,
            "unmapped": unmapped,
            "review_required": review_required,
            "closed": 0,
        },
        "complete": False,
    }


CSV_FIELDS = (
    "path",
    "source_id",
    "mode",
    "type",
    "blob",
    "size",
    "classification",
    "owner",
    "status",
    "matched_rule",
    "target_paths",
    "target_exists",
    "level",
    "decision",
    "capability_id",
    "test",
    "evidence",
)


def _render_csv(document):
    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer, fieldnames=CSV_FIELDS, lineterminator="\n", extrasaction="ignore"
    )
    writer.writeheader()
    for row in document["inventory"]:
        record = dict(row)
        record["target_paths"] = ";".join(row["target_paths"])
        writer.writerow(record)
    return buffer.getvalue()


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="audit_source_inventory.py",
        description="Read-only G0 git source inventory audit.",
    )
    parser.add_argument("--repo", default=".")
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--a2-ref", required=True)
    parser.add_argument("--target-ref", required=True)
    parser.add_argument("--seed", default=None)
    parser.add_argument("--format", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    try:
        document = audit(
            args.repo,
            args.source_ref,
            args.a2_ref,
            args.target_ref,
            args.seed,
        )
    except AuditError as exc:
        sys.stderr.write("AUDIT_ERROR %s\n" % exc)
        return 1
    if args.format == "csv":
        sys.stdout.write(_render_csv(document))
    else:
        json.dump(document, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
