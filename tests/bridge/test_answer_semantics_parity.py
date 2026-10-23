"""Differential parity: Python mirrors the Node ``canonicalAnswerKey``.

The consensus ballot runs on both sides, so the two key functions must agree on
which answers are "the same answer"; a disagreement can make the Node deliver a
packet the Host projection considers superseded. This test runs the *compiled*
Node helper (a pure function, no I/O, no model, no child session) over the same
language-neutral fixture the Python test reads and compares the key strings.

It skips when the TypeScript build output is absent, so a source-only checkout
stays green without a rebuild.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from python.astra_bridge.answer_semantics import canonical_answer_key

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "apps" / "stdio-runtime" / "dist" / "src" / "agent-answer-key.js"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "canonical_answer_keys.v2.json"

_SCRIPT = """
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const mod = await import(pathToFileURL(process.argv[1]).href);
const inputs = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify(inputs.map((text) => mod.canonicalAnswerKey(text))));
"""


def _inputs():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    seen = []
    for group in data["same"]:
        seen.extend(group["inputs"])
    for pair in data["different"]:
        seen.extend((pair["left"], pair["right"]))
    for case in data["pythonKeys"]:
        seen.append(case["input"])
    out = []
    for text in seen:
        if text not in out:
            out.append(text)
    return out


@pytest.mark.skipif(
    not DIST.is_file() or shutil.which("node") is None,
    reason="compiled Node answer-key helper is not present",
)
def test_python_key_matches_the_node_helper(tmp_path):
    inputs = _inputs()
    corpus = tmp_path / "inputs.json"
    corpus.write_text(json.dumps(inputs, ensure_ascii=False), encoding="utf-8")
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", _SCRIPT, str(DIST), str(corpus)],
        capture_output=True,
        timeout=120,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")[:500]
    node_keys = json.loads(proc.stdout.decode("utf-8"))
    assert len(node_keys) == len(inputs)
    mismatches = [
        (text, node_key, canonical_answer_key(text))
        for text, node_key in zip(inputs, node_keys)
        if node_key != canonical_answer_key(text)
    ]
    assert mismatches == []
