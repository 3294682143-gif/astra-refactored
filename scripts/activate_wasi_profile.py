"""Publish an installation-relative descriptor ONLY for this tested local profile."""

import argparse
import json
from pathlib import Path

from mathagent.sandbox_wasi import WasiPythonSandbox


def activate(root, profile):
    root, profile = Path(root).resolve(strict=True), Path(profile).resolve(strict=True)
    if not profile.is_relative_to(root):
        raise ValueError("profile must reside in this submission")
    sandbox = WasiPythonSandbox(profile)
    if not sandbox.available:
        raise ValueError(sandbox.reason)
    data = sandbox._validate()
    if not data.get("acceptance_evidence", {}).get("execution_evidence_sha256"):
        raise ValueError("content-bound actual acceptance required for activation")
    for name in data["file_hashes"]:
        if not Path(name).resolve().is_relative_to(root):
            raise ValueError("profile pins resources outside this installation")
    with (root / "mathagent/resources/platform-python.json").open(
        "x", encoding="utf-8"
    ) as stream:
        json.dump({"profile": profile.relative_to(root).as_posix()}, stream)
    return {
        "python_available": True,
        "profile_identity": sandbox.identity,
        "formal_platform_accepted": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--profile", required=True)
    print(json.dumps(activate(**vars(parser.parse_args()))))
