"""Content-bound local WASI evidence, not a claim about an external platform."""

import hashlib
import json
import platform
import sys
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def environment():
    cpu = Path("/proc/cpuinfo")
    features = (
        sorted(
            {
                line.strip()
                for line in cpu.read_text(encoding="utf-8").splitlines()
                if line.partition(":")[0].strip()
                in {
                    "model name",
                    "flags",
                    "Features",
                    "CPU architecture",
                    "CPU implementer",
                    "CPU part",
                }
            }
        )
        if cpu.is_file()
        else [platform.processor()]
    )
    return {
        "system": platform.system(),
        "machine": platform.machine(),
        "kernel_release": platform.release(),
        "cpu_features_sha256": hashlib.sha256(
            "\n".join(features).encode("utf-8")
        ).hexdigest(),
        "host_python": sys.version,
        "executable_sha256": sha(sys.executable),
    }


def verify_evidence(profile, junit, evidence, *, sources=None):
    report = json.loads(Path(evidence).read_text(encoding="utf-8"))
    if (
        report.get("schema") != "actual-wasi-execution-v2"
        or report.get("returncode") != 0
        or report.get("profile_sha256") != sha(profile)
        or report.get("junit_sha256") != sha(junit)
        or report.get("environment") != environment()
        or not report.get("sources")
        or not report.get("command")
        or report.get("started_wall", 0) <= 0
        or report.get("finished_wall", 0) < report.get("started_wall", 0)
    ):
        raise ValueError(
            "actual WASI evidence is absent, failed or bound to different inputs"
        )
    for name, digest in report["sources"].items():
        path = Path(name)
        if sources is not None:
            path = Path(sources) / path.name
        if sha(path) != digest:
            raise ValueError("actual acceptance source changed")
    return report
