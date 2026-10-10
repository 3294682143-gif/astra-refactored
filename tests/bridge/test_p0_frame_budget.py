"""Unit control for the Host's total frame budget; not a Node traffic test."""

import time

import pytest

from python.astra_bridge import p0_probe, p0_protocol


def test_host_frame_limit_before_pending():
    manifest = p0_protocol.load_manifest()
    host = p0_probe._Host(manifest, "s1", "n1", time.monotonic() + 1.0)
    try:
        host.frames = p0_protocol.LIMITS["maxFramesPerSession"]
        proc = type("P", (), {})()
        proc.stdin = None
        with pytest.raises(p0_probe.ProbeError) as exc:
            host.send(
                proc,
                {
                    "jsonrpc": "2.0",
                    "id": "host-1",
                    "method": "runtime.initialize",
                    "params": {
                        "protocolVersion": p0_protocol.PROTOCOL_VERSION,
                        "sessionId": "s1",
                        "clientCapabilities": {
                            "modelGenerate": "UNAVAILABLE",
                            "toolExecute": "UNAVAILABLE",
                            "methodCatalog": "AVAILABLE",
                            "maxTokens": {"configured": 8192, "verified": False},
                        },
                    },
                },
                "runtime.initialize",
            )
        assert exc.value.code == "FRAME_LIMIT_EXCEEDED"
        assert host.pending is None
    finally:
        host.selector.close()
