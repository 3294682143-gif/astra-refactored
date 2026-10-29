"""Record limited local acceptance only after matching actual WASI test evidence."""

import argparse
import hashlib
import json
import xml.etree.ElementTree as ET
from pathlib import Path

from mathagent.runtime.wasi_acceptance import verify_evidence
from mathagent.sandbox_wasi import WasiPythonSandbox


def accept(profile, junit, output, evidence=None):
    if evidence is None:
        raise ValueError(
            "content-bound actual execution evidence required; historical XML alone cannot certify this profile"
        )
    report = verify_evidence(profile, junit, evidence)
    pending = WasiPythonSandbox(profile, for_validation=True)
    if not pending.available:
        raise ValueError(pending.reason)
    data = pending._validate()
    root = ET.parse(junit).getroot()
    cases = list(root.iter("testcase"))
    names = {row.get("name", "").split("[")[0] for row in cases}
    required = {
        "test_actual_preinstalled_sympy_and_math_work",
        "test_actual_forbidden_capabilities_fail",
        "test_actual_infinite_loop_has_wall_limit_and_is_reaped",
        "test_actual_guest_memory_cap",
        "test_actual_output_bomb_is_truncated_and_reaped",
        "test_actual_two_parallel_questions_cannot_read_each_other",
        "test_actual_worker_has_independent_kernel_wall_timer",
        "test_actual_controller_generated_channel_is_still_provisional",
    }
    if len(cases) < 24 or not required <= names or any(list(row) for row in cases):
        raise ValueError(
            "required actual WASI cases must pass without failures, errors or skips"
        )
    # This tool does not accept fixture-only unit tests as an actual WASI suite.
    if any("test_wasi_actual" not in row.get("classname", "") for row in cases):
        raise ValueError("unexpected test source")
    data["acceptance"] = "LOCAL_T27_T28_PASSED"
    data["acceptance_evidence"] = {
        "junit": str(Path(junit).resolve()),
        "sha256": hashlib.sha256(Path(junit).read_bytes()).hexdigest(),
        "passed": len(cases),
        "formal_platform_accepted": False,
        "execution_evidence_sha256": hashlib.sha256(
            Path(evidence).read_bytes()
        ).hexdigest(),
        "profile_before_acceptance_sha256": report["profile_sha256"],
        "test_sources": report["sources"],
        "environment": report["environment"],
    }
    with Path(output).open("x", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2)
    return data


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    for key in ("profile", "junit", "output", "evidence"):
        p.add_argument("--" + key, required=True)
    d = accept(**vars(p.parse_args()))
    print(
        json.dumps(
            {"acceptance": d["acceptance"], "evidence": d["acceptance_evidence"]}
        )
    )
