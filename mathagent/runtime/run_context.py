"""Trusted runner configuration, never inferred from a question or client internals.

Construct this object in the authorized host/runner and inject it into the Agent.
It is NOT a credential, authentication mechanism, or a claim that the competition
permits shared files. Untrusted solve metadata must not be deserialized into it.
"""

import math
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import Limits, fingerprint
from .coordinator import AdmissionError, GlobalCoordinator


@dataclass(frozen=True)
class RunContext:
    run_id: str
    shared_dir: str
    evidence: str
    boot_id: str
    started: float
    wall_started: float
    source_version: str
    config_version: str
    known_total: int | None = None
    resume: bool = False
    public_return_authority: str = "explicit_terminal_only"
    limits: Limits = field(default_factory=Limits)
    topology: str = "same_host_same_boot"

    def __post_init__(self):
        for name in (
            "run_id",
            "shared_dir",
            "evidence",
            "boot_id",
            "source_version",
            "config_version",
        ):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip() or len(value) > 4096:
                raise ValueError("explicit trusted run identity/evidence required")
        if not Path(self.shared_dir).is_absolute():
            raise ValueError(
                "shared storage must be an explicit absolute installation path"
            )
        if self.topology != "same_host_same_boot" or not isinstance(
            self.limits, Limits
        ):
            raise ValueError(
                "only confirmed same-host SQLite coordination is implemented"
            )
        if self.known_total is not None and (
            type(self.known_total) is not int or self.known_total < 1
        ):
            raise ValueError(
                "known total must be public frozen progress, not an estimate"
            )
        if type(self.resume) is not bool:
            raise ValueError("explicit recovery boolean required")
        if self.public_return_authority not in {
            "explicit_terminal_only",
            "official_public_return",
        }:
            raise ValueError("unsupported public terminal responsibility contract")
        for value in (self.started, self.wall_started):
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError("finite original clock values required")

    def coordinator(self, *, current_version, experiment, python_identity):
        boot = (
            Path("/proc/sys/kernel/random/boot_id").read_text(encoding="utf-8").strip()
        )
        if boot != self.boot_id or self.source_version != current_version:
            raise AdmissionError("trusted run boot/code identity mismatch")
        if self.started > time.monotonic() or self.wall_started > time.time() + 1:
            raise AdmissionError("original run cannot start in the future")
        # Resume is a per-worker operation, not a new resource/config identity.
        frozen = asdict(self)
        frozen.pop("resume")
        return GlobalCoordinator(
            Path(self.shared_dir) / "coordinator.sqlite3",
            self.run_id,
            limits=self.limits,
            boot_id=boot,
            started=self.started,
            wall_started=self.wall_started,
            version=fingerprint((frozen, experiment.ablation, python_identity)),
        )
