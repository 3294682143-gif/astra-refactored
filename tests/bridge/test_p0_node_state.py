"""P0 Node state-machine negative controls against the real compiled probe.

Each case drives the real Node stdio probe with a fixed frame batch and asserts
a non-zero exit, the exact fixed stderr code and the absence of a successful
probe acknowledgement. No network, no model, no solver path.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SCRIPT = ROOT / "apps" / "stdio-runtime" / "dist" / "src" / "main.js"
SESSION = "p0-session-1"


def _require_node():
    if not SCRIPT.exists():
        pytest.skip("compiled Node probe not present")


def _req(rid, method, params):
    return json.dumps(
        {"jsonrpc": "2.0", "id": rid, "method": method, "params": params},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _init(rid="host-1", session=SESSION, version="1.0-p0", extra=None):
    params = {
        "protocolVersion": version,
        "sessionId": session,
        "clientCapabilities": {
            "modelGenerate": "UNAVAILABLE",
            "toolExecute": "UNAVAILABLE",
            "methodCatalog": "AVAILABLE",
            "maxTokens": {"configured": 8192, "verified": False},
        },
    }
    if extra is not None:
        params.update(extra)
    return _req(rid, "runtime.initialize", params)


def _probe(rid="host-2", session=SESSION, version="1.0-p0", nonce="n1"):
    return _req(
        rid,
        "runtime.probe",
        {"protocolVersion": version, "sessionId": session, "nonce": nonce},
    )


def _catalog_result(rid="node-1", session=SESSION, version="1.0-p0"):
    entries = [{"id": f"m{i}", "title": f"t{i}"} for i in range(20)]
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": rid,
            "result": {
                "protocolVersion": version,
                "sessionId": session,
                "entries": entries,
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _run(frames):
    payload = ("\n".join(frames) + "\n").encode("utf-8")
    proc = subprocess.Popen(
        ["node", str(SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        out, err = proc.communicate(input=payload, timeout=2)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2)
    return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


CASES = [
    ("wrong-session-probe", [_init(), _probe(session="other")], "SESSION_MISMATCH"),
    ("wrong-version-init", [_init(version="1.0-p1")], "FIELD_VALUE"),
    ("extra-init-payload", [_init(extra={"extra": 1})], "EXTRA_FIELD"),
    ("production-solve", [_req("host-1", "session.solve", {})], "REJECTED_METHOD"),
    ("callback-wrong-id", [_init(), _probe(), _catalog_result(rid="node-9")], "ID_MISMATCH"),
    (
        "callback-wrong-session",
        [_init(), _probe(), _catalog_result(session="other")],
        "SESSION_MISMATCH",
    ),
    (
        "stop-during-callback",
        [_init(), _probe(), _req("host-3", "session.stop", {"protocolVersion": "1.0-p0", "sessionId": SESSION})],
        "FIELD_VALUE",
    ),
    ("duplicate-host-id", [_init(), _init()], "ID_MISMATCH"),
    ("duplicate-callback", [_init(), _probe(), _catalog_result(), _catalog_result()], "ID_MISMATCH"),
    ("node-prefixed-host-id", [_init(rid="node-1")], "ID_MISMATCH"),
]


@pytest.mark.parametrize("name,frames,code", CASES, ids=[c[0] for c in CASES])
def test_node_state_rejection(name, frames, code):
    _require_node()
    returncode, out, err = _run(frames)
    assert returncode != 0, name
    assert err.strip().splitlines()[-1] == code, (name, err)
    assert out.count('"catalogAcknowledged":true') == (
        1 if name == "duplicate-callback" else 0
    ), name
    assert '"stopped":true' not in out, name
