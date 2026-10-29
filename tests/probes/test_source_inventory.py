"""Focused G0 audit tests: real temp git repos, no network."""

import csv
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import audit_source_inventory as audit_mod


def _git(repo, *args):
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _commit(repo, message):
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t",
         "commit", "-q", "-m", message)
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True, stdout=subprocess.PIPE,
    ).stdout.decode().strip()


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "r"
    root.mkdir()
    _git(root, "init", "-q")
    (root / "space name.py").write_text("a\n", encoding="utf-8")
    (root / "制表\t名.md").write_text("b\n", encoding="utf-8")
    (root / "gone.py").write_text("c\n", encoding="utf-8")
    source = _commit(root, "source")
    (root / "space name.py").write_text("a2\n", encoding="utf-8")
    (root / "added.py").write_text("d\n", encoding="utf-8")
    (root / "gone.py").unlink()
    a2 = _commit(root, "a2")
    (root / "target.ts").write_text("e\n", encoding="utf-8")
    target = _commit(root, "target")
    return root, source, a2, target


def test_inventory_paths_and_csv(repo):
    root, source, a2, target = repo
    doc = audit_mod.audit(str(root), source, a2, target)
    assert doc["source"]["commit"] != doc["source"]["tree"]
    paths = {row["path"]: row for row in doc["inventory"]}
    assert set(paths) == {"space name.py", "制表\t名.md", "gone.py"}
    assert paths["space name.py"]["size"] == 2
    assert paths["制表\t名.md"]["blob"]
    assert len(doc["a2_changes"]) == 3
    text = audit_mod._render_csv(doc)
    rows = list(csv.DictReader(io.StringIO(text)))
    assert {r["path"] for r in rows} == set(paths)


def test_seed_owner_and_target_exists(repo):
    root, source, a2, target = repo
    rules = [
        {"pattern": "space name\\.py", "class": "RUNTIME", "owner": "O1",
         "target_paths": ["target.ts"]},
        {"pattern": "制表\t名\\.md", "class": "DOC", "owner": "O2",
         "target_paths": ["untracked.ts"]},
    ]
    doc = audit_mod.audit(str(root), source, a2, target, rules)
    rows = {row["path"]: row for row in doc["inventory"]}
    assert rows["space name.py"]["owner"] == "O1"
    assert rows["space name.py"]["classification"] == "RUNTIME"
    assert rows["space name.py"]["target_exists"] is True
    assert rows["制表\t名.md"]["target_exists"] is False
    assert rows["space name.py"]["status"] == "REVIEW_REQUIRED"
    assert doc["counts"]["closed"] == 0


def test_unmapped_and_conflicting_owner(repo):
    root, source, a2, target = repo
    doc = audit_mod.audit(str(root), source, a2, target)
    assert doc["counts"]["unmapped"] == doc["counts"]["source_files"]
    rules = [
        {"pattern": ".*\\.py", "class": "MATH", "owner": "A"},
        {"pattern": "gone\\.py", "class": "MATH", "owner": "B"},
    ]
    doc2 = audit_mod.audit(str(root), source, a2, target, rules)
    rows = {row["path"]: row for row in doc2["inventory"]}
    assert rows["gone.py"]["status"] == "REVIEW_REQUIRED"
    assert rows["gone.py"]["owner"] is None
    assert doc2["counts"]["unmapped"] > 0


def test_cli_ref_injection_and_exit(repo):
    root, source, a2, target = repo
    with pytest.raises(audit_mod.AuditError):
        audit_mod.audit(str(root), "--help", a2, target)
    code = audit_mod.main(
        ["--repo", str(root), "--source-ref=--help", "--a2-ref", a2,
         "--target-ref", target]
    )
    assert code == 1
    code = audit_mod.main(
        ["--repo", str(root), "--source-ref", source, "--a2-ref", a2,
         "--target-ref", target]
    )
    assert code == 2


def test_seed_validation_and_ignored_fields(repo):
    root, source, a2, target = repo
    for bad in (
        [{"pattern": ".*", "class": "NOPE"}],
        [{"pattern": ".*", "target_paths": "x"}],
        [{"pattern": ".*", "owner": []}],
        [{"pattern": "[", "owner": "A"}],
    ):
        with pytest.raises(audit_mod.AuditError):
            audit_mod.audit(str(root), source, a2, target, bad)
    rules = [{"pattern": ".*", "owner": "A", "status": "CLOSED",
              "evidence": "x"}]
    doc = audit_mod.audit(str(root), source, a2, target, rules)
    assert all(row["status"] == "REVIEW_REQUIRED" for row in doc["inventory"])
    assert all(row["evidence"] == "" for row in doc["inventory"])
