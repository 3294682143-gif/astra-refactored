from __future__ import annotations

import pytest

from python.astra_bridge.domain_host.universal_asset_registry import (
    DomainAssetSpec,
    UniversalAssetRegistry,
)


def test_registry_registers_and_executes_custom_domain_tool():
    reg = UniversalAssetRegistry()

    # Register a control identification tool
    reg.register_asset(
        DomainAssetSpec(
            asset_id="control.sysid_lse",
            domain_id="control",
            version="1.0.0",
            targets=["estimate_parameters"],
            input_schema={"type": "object", "required": ["signals"]},
            output_schema={"type": "object"},
            executor=lambda p: {"mass": 1.0, "damping": 0.2, "stiffness": 10.0},
            evidence_scope="LEAST_SQUARES_ESTIMATION",
            timeout_seconds=5.0,
        )
    )

    assert "control.sysid_lse" in reg.list_assets("control")

    res = reg.execute_asset("control.sysid_lse", {"signals": [1, 2, 3]})
    assert res.status == "SUCCESS"
    assert res.output["mass"] == 1.0
    assert res.evidence_scope == "LEAST_SQUARES_ESTIMATION"


def test_registry_handles_missing_asset_gracefully():
    reg = UniversalAssetRegistry()
    res = reg.execute_asset("non_existent_tool", {})
    assert res.status == "ERROR"
    assert res.evidence_scope == "TOOL_ERROR"
    assert "not found" in res.error_snippet


def test_registry_captures_execution_exception():
    reg = UniversalAssetRegistry()

    def bad_executor(args):
        raise ValueError("Invalid dimension")

    reg.register_asset(
        DomainAssetSpec(
            asset_id="test.bad_tool",
            domain_id="test",
            version="1.0.0",
            targets=["fail"],
            input_schema={},
            output_schema={},
            executor=bad_executor,
            evidence_scope="TEST",
        )
    )

    res = reg.execute_asset("test.bad_tool", {})
    assert res.status == "ERROR"
    assert "Invalid dimension" in res.error_snippet
