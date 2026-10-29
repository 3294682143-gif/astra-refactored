"""Run the version-controlled REAL worker suite and bind its JUnit to this install.

No model requests. Test bodies execute only in WASI; Controller Review is a
fixed-response fixture and is reported as such. Never accepts historical XML.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from mathagent.runtime.wasi_acceptance import environment, sha
from mathagent.sandbox_wasi import WasiPythonSandbox


def run(profile, output, tests=None):
    profile, output = Path(profile).resolve(strict=True), Path(output).resolve()
    source = (
        Path(tests)
        if tests
        else Path(__file__).resolve().parent.parent / "tests/actual/test_wasi_actual.py"
    ).resolve(strict=True)
    pending = WasiPythonSandbox(profile, for_validation=True)
    if not pending.available:
        raise ValueError(pending.reason)
    output.mkdir(parents=True, exist_ok=False)
    junit = output / "actual-wasi.xml"
    hashes = {str(source): sha(source), str(Path(__file__).resolve()): sha(__file__)}
    profile_hash = sha(profile)
    command = [
        sys.executable,
        "-m",
        "pytest",
        "-q",
        str(source),
        "--junitxml=" + str(junit),
    ]
    started = time.time()
    env = os.environ.copy()
    env["ASTRA_WASI_TEST_PROFILE"] = str(profile)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(command, env=env, timeout=600, check=False)
    if sha(profile) != profile_hash or any(sha(p) != h for p, h in hashes.items()):
        raise ValueError("test/profile changed during actual acceptance")
    pending._validate()
    evidence = {
        "schema": "actual-wasi-execution-v2",
        "command": command,
        "returncode": result.returncode,
        "started_wall": started,
        "finished_wall": time.time(),
        "profile_sha256": profile_hash,
        "junit_sha256": sha(junit),
        "sources": hashes,
        "environment": environment(),
        "formal_platform_accepted": False,
        "scope": "real local WASI guest and process boundaries; fixed-response Controller Review; no real model",
    }
    with (output / "evidence.json").open("x", encoding="utf-8") as stream:
        json.dump(evidence, stream, indent=2)
    return result.returncode


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tests", help="explicit installed acceptance source")
    raise SystemExit(run(**vars(parser.parse_args())))
