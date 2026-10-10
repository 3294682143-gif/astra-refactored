"""Explicit opt-in WASI profile; no ordinary-process fallback for generated code.

The guest receives only read-only interpreter/math libraries and an empty,
invocation-private directory. Host process limits complement WASI capabilities;
they are not what provides filesystem/network isolation.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import selectors
import signal
import subprocess
import tempfile
import time
from pathlib import Path

from .runtime.config import fingerprint
from .runtime.wasi_acceptance import environment


def _remove_private_contents(root):
    """Iterative cleanup of our own job tree, never following guest symlinks."""
    stack = [(root, False)]
    while stack:
        path, visited = stack.pop()
        if visited:
            path.rmdir()
            continue
        os.chmod(path, 0o700, follow_symlinks=False)
        stack.append((path, True))
        with os.scandir(path) as entries:
            for entry in entries:
                child = Path(entry.path)
                if entry.is_dir(follow_symlinks=False):
                    stack.append((child, False))
                else:
                    child.unlink()


class WasiPythonSandbox:
    def __init__(self, profile, *, for_validation=False):
        self.profile = Path(profile).resolve(strict=True)
        self.for_validation = for_validation
        self.available = False
        self.identity = None
        self.reason = "WASI profile not validated"
        try:
            data = self._validate()
        except (OSError, ValueError, TypeError, KeyError) as exc:
            self.reason = "WASI profile invalid: " + type(exc).__name__
        else:
            self.identity = fingerprint(data)
            self.available, self.reason = (
                True,
                "explicit locally validated WASI profile",
            )

    def _validate(self):
        data = json.loads(self.profile.read_text(encoding="utf-8"))
        if self.identity is not None and fingerprint(data) != self.identity:
            raise ValueError("profile changed during this lifecycle")
        if (
            data.get("schema") != "astra-wasi-profile-v1"
            or data.get("acceptance")
            not in (
                {"LOCAL_T27_T28_PASSED", "PRECONDITIONS_ONLY_NOT_ACCEPTED"}
                if self.for_validation
                else {"LOCAL_T27_T28_PASSED"}
            )
            or data.get("guest_memory_mib") != 512
            or data.get("host_address_space_mib") != 1024
        ):
            raise ValueError("unaccepted or incompatible profile")
        if data.get("installation_environment") != environment():
            raise ValueError("profile is not bound to the current target host environment")
        if not self.for_validation and not data.get("acceptance_evidence", {}).get("execution_evidence_sha256"):
            raise ValueError("content-bound actual acceptance evidence required")
        for key in (
            "python",
            "runtime",
            "libraries",
            "wasmtime_package",
            "compiled_module",
        ):
            if not isinstance(data[key], str) or not Path(data[key]).is_absolute():
                raise ValueError("explicit absolute runtime paths required")
        hashes = data["file_hashes"]
        if not isinstance(hashes, dict) or not hashes:
            raise ValueError("runtime source pin missing")
        required = set()
        for root in (
            Path(data["runtime"]),
            Path(data["libraries"]),
            Path(data["wasmtime_package"]),
        ):
            if root.is_symlink() or not root.is_dir():
                raise ValueError("invalid resource root")
            for path in root.rglob("*"):
                if path.is_symlink():
                    raise ValueError("symlink in runtime resources")
                if path.is_file():
                    required.add(str(path))
        if (
            not required <= hashes.keys()
            or str(Path(__file__).with_name("_wasi_worker.py")) not in hashes
        ):
            raise ValueError("untracked runtime file or worker")
        for name, expected in hashes.items():
            path = Path(name)
            if (
                path.is_symlink()
                or not path.is_file()
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected
            ):
                raise ValueError("runtime file changed")
        if data["python"] not in hashes:
            raise ValueError("untracked host interpreter")
        if data["compiled_module"] not in hashes or str(Path(__file__)) not in hashes:
            raise ValueError("untracked compiled module or supervisor")
        return data

    def execute(
        self, code, *, deadline, problem_id, scope="bounded generated exploration"
    ):
        from .tools import ToolResult

        if not self.available:
            return ToolResult(
                "backend_unavailable",
                "generated_python",
                None,
                "NONE",
                scope,
                detail=self.reason,
            )
        if (
            not isinstance(code, str)
            or len(code) > 65536
            or len(code.encode("utf-8")) > 65536
            or not isinstance(problem_id, str)
            or not problem_id.strip()
            or not isinstance(scope, str)
            or not scope.strip()
            or type(deadline) not in (float, int)
            or not math.isfinite(deadline)
        ):
            return ToolResult("invalid_input", "generated_python", None, "NONE", scope)
        try:
            config = self._validate()
        except (OSError, ValueError, TypeError, KeyError):
            return ToolResult(
                "backend_unavailable",
                "generated_python",
                None,
                "NONE",
                scope,
                detail="runtime pin changed",
            )
        seconds = min(30.0, deadline - time.monotonic())
        if seconds <= 0:
            return ToolResult(
                "resource_limited",
                "generated_python",
                None,
                "NONE",
                scope,
                detail="original deadline",
            )
        started = time.monotonic()
        output, stop_reason, receipt = bytearray(), None, None
        # No input path from the model is mounted. Invocation isolation is stricter
        # than per-question reuse; no files survive to a sibling or later call.
        with tempfile.TemporaryDirectory(prefix="astra-wasi-job-") as temporary:
            root = Path(temporary)
            work = root / "work"
            work.mkdir()
            receipt_path = root / "host-receipt.json"
            env = {
                "PATH": "/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "PYTHONDONTWRITEBYTECODE": "1",
                "TOKIO_WORKER_THREADS": "1",
                "RAYON_NUM_THREADS": "1",
            }
            proc = subprocess.Popen(
                [
                    config["python"],
                    "-I",
                    "-S",
                    "-B",
                    str(Path(__file__).with_name("_wasi_worker.py")),
                    "--runtime",
                    config["runtime"],
                    "--libraries",
                    config["libraries"],
                    "--work",
                    str(work),
                    "--receipt",
                    str(receipt_path),
                    "--seconds",
                    str(seconds),
                    "--parent-pid",
                    str(os.getpid()),
                    "--wasmtime-package",
                    config["wasmtime_package"],
                    "--compiled-module",
                    config["compiled_module"],
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=root,
                env=env,
                start_new_session=True,
            )
            selector = selectors.DefaultSelector()
            selector.register(proc.stdout, selectors.EVENT_READ)
            selector.register(proc.stderr, selectors.EVENT_READ)
            os.set_blocking(proc.stdin.fileno(), False)
            selector.register(proc.stdin, selectors.EVENT_WRITE)
            pending = memoryview(code.encode("utf-8"))
            try:
                while selector.get_map():
                    remaining = seconds - (time.monotonic() - started)
                    if remaining <= 0:
                        stop_reason = "wall_timeout"
                        break
                    try:
                        entries = list(work.rglob("*"))
                    except (OSError, RecursionError):
                        stop_reason = "workspace_limit"
                        break
                    # Extra disk guard, in addition to guest per-file RLIMIT_FSIZE.
                    if (
                        len(entries) > 128
                        or any(len(p.relative_to(work).parts) > 32 for p in entries)
                        or sum(p.lstat().st_size for p in entries if not p.is_symlink())
                        > 16 * 1024**2
                    ):
                        stop_reason = "workspace_limit"
                        break
                    for key, _ in selector.select(min(0.05, remaining)):
                        if key.fileobj is proc.stdin:
                            if pending:
                                try:
                                    sent = os.write(key.fd, pending[:4096])
                                    pending = pending[sent:]
                                except BrokenPipeError:
                                    pending = pending[len(pending) :]
                            if not pending:
                                selector.unregister(proc.stdin)
                                proc.stdin.close()
                            continue
                        block = os.read(key.fd, 4096)
                        if not block:
                            selector.unregister(key.fileobj)
                        else:
                            keep = max(0, 65536 - len(output))
                            output.extend(block[:keep])
                            if len(block) > keep:
                                stop_reason = "output_limit"
                                break
                    if stop_reason:
                        break
                if proc.poll() is None:
                    remaining = seconds - (time.monotonic() - started)
                    if not stop_reason and remaining > 0:
                        try:
                            proc.wait(timeout=remaining)
                        except subprocess.TimeoutExpired:
                            stop_reason = "wall_timeout"
                    if proc.poll() is None:
                        os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=2)
                if receipt_path.is_file() and receipt_path.stat().st_size < 4096:
                    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            finally:
                if proc.poll() is None:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(timeout=2)
                selector.close()
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream and not stream.closed:
                        stream.close()
                _remove_private_contents(work)
        success = (
            not stop_reason
            and proc.returncode == 0
            and receipt is not None
            and receipt.get("exit_code") == 0
        )
        result = {
            "output": output.decode("utf-8", errors="replace"),
            "truncated": stop_reason == "output_limit",
            "reason": stop_reason or (receipt or {}).get("reason", "worker_failure"),
            "exit_code": proc.returncode,
            "elapsed_seconds": time.monotonic() - started,
            "resources": receipt,
            "reaped": True,
            "work_directory_removed": True,
            "guest_memory_mib": 512,
            "host_address_space_mib": 1024,
            "mathematical_status": "UNVERIFIED",
        }
        status = (
            "ok"
            if success
            else "resource_limited"
            if stop_reason or proc.returncode < 0
            else "error"
        )
        return ToolResult(
            status,
            "generated_python",
            result,
            "BOUNDED_OBSERVATION" if success else "NONE",
            scope,
            detail="WASI execution is not a proof or an original-problem mapping.",
        )
