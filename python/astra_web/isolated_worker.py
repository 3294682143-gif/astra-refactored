from __future__ import annotations

import hashlib
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import Mapping, Optional, Sequence, Tuple

try:
    import win32api
    import win32job
    _HAS_WIN32JOB = True
except ImportError:
    _HAS_WIN32JOB = False

_NETWORK_ISOLATION_AVAILABLE = False


def _job_object_capability() -> Tuple[bool, Sequence[str]]:
    if sys.platform != "win32":
        return False, ("windows_job_object_required",)
    if not _HAS_WIN32JOB:
        return False, ("pywin32_job_object_required",)
    job = None
    try:
        job = win32job.CreateJobObject(None, f"astra_capability_probe_{os.getpid()}")
        win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
        return True, ()
    except Exception:
        return False, ("windows_job_object_initialization_failed",)
    finally:
        if job is not None:
            try:
                win32api.CloseHandle(job)
            except Exception:
                pass


def isolated_worker_capability() -> Tuple[bool, Sequence[str]]:
    job_available, reasons = _job_object_capability()
    if not job_available:
        return False, reasons
    if not _NETWORK_ISOLATION_AVAILABLE:
        return False, ("network_isolation_unavailable",)
    return True, ()


@dataclass(frozen=True)
class WorkerResourceLimits:
    max_cpu_time_seconds: float = 10.0
    max_memory_bytes: int = 512 * 1024 * 1024
    max_active_processes: int = 4
    max_output_bytes: int = 100 * 1024
    require_network_isolation: bool = True


@dataclass(frozen=True)
class ExecutionReceipt:
    execution_id: str
    code_hash: str
    status: str
    exit_code: Optional[int]
    stdout_snippet: str
    stderr_snippet: str
    duration_ms: float
    output_files: Sequence[str]
    resource_limits: WorkerResourceLimits
    isolation_mechanism: str
    network_isolated: bool


def _collect_stream(stream: object, limit: int, state: dict[str, object]) -> None:
    data = bytearray()
    total = 0
    while True:
        chunk = stream.read(8192)
        if not chunk:
            break
        total += len(chunk)
        remaining = max(0, limit - len(data))
        if remaining:
            data.extend(chunk[:remaining])
    state["data"] = bytes(data)
    state["total"] = total


class IsolatedCodeWorker:
    def __init__(self, workspace_root: Optional[pathlib.Path] = None):
        self.workspace_root = workspace_root or pathlib.Path(tempfile.gettempdir()) / "astra_isolated_worker"
        self.workspace_root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _compute_hash(content: str) -> str:
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    @staticmethod
    def _unavailable(
        *,
        execution_id: str,
        code_hash: str,
        start_time: float,
        limits: WorkerResourceLimits,
        reason: str,
    ) -> ExecutionReceipt:
        return ExecutionReceipt(
            execution_id=execution_id,
            code_hash=code_hash,
            status="ISOLATION_UNAVAILABLE",
            exit_code=None,
            stdout_snippet="",
            stderr_snippet=reason,
            duration_ms=(time.monotonic() - start_time) * 1000.0,
            output_files=(),
            resource_limits=limits,
            isolation_mechanism="none",
            network_isolated=False,
        )

    def execute_script(
        self,
        script_code: str,
        execution_id: str,
        input_files: Optional[Mapping[str, str]] = None,
        limits: Optional[WorkerResourceLimits] = None,
    ) -> ExecutionReceipt:
        limits = limits or WorkerResourceLimits()
        code_hash = self._compute_hash(script_code)
        start_time = time.monotonic()
        if limits.require_network_isolation and not _NETWORK_ISOLATION_AVAILABLE:
            return self._unavailable(
                execution_id=execution_id,
                code_hash=code_hash,
                start_time=start_time,
                limits=limits,
                reason="network_isolation_unavailable",
            )
        job_available, reasons = _job_object_capability()
        if not job_available:
            return self._unavailable(
                execution_id=execution_id,
                code_hash=code_hash,
                start_time=start_time,
                limits=limits,
                reason=";".join(reasons),
            )

        task_dir = self.workspace_root / f"task_{execution_id}_{int(start_time * 1000)}"
        task_dir.mkdir(parents=True, exist_ok=True)
        inputs_dir = task_dir / "inputs"
        inputs_dir.mkdir(parents=True, exist_ok=True)
        outputs_dir = task_dir / "outputs"
        outputs_dir.mkdir(parents=True, exist_ok=True)
        if input_files:
            for file_name, content in input_files.items():
                relative = pathlib.Path(file_name)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("unsafe input file name")
                input_path = inputs_dir / relative
                input_path.parent.mkdir(parents=True, exist_ok=True)
                input_path.write_text(content, encoding="utf-8")
                input_path.chmod(stat.S_IREAD)
        script_path = task_dir / "main.py"
        script_path.write_text(script_code, encoding="utf-8")
        script_path.chmod(stat.S_IREAD)
        clean_env = {
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", "C:\\Windows"),
            "PATH": str(pathlib.Path(os.environ.get("SYSTEMROOT", "C:\\Windows")) / "System32"),
            "ASTRA_TASK_INPUTS": str(inputs_dir),
            "ASTRA_TASK_OUTPUTS": str(outputs_dir),
            "PYTHONUNBUFFERED": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }

        job = None
        proc = None
        try:
            job = win32job.CreateJobObject(None, f"job_{execution_id}")
            info = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
            info["BasicLimitInformation"]["LimitFlags"] = (
                win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | win32job.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                | win32job.JOB_OBJECT_LIMIT_PROCESS_MEMORY
                | win32job.JOB_OBJECT_LIMIT_PROCESS_TIME
            )
            info["BasicLimitInformation"]["ActiveProcessLimit"] = limits.max_active_processes
            info["BasicLimitInformation"]["PerProcessUserTimeLimit"] = int(limits.max_cpu_time_seconds * 10_000_000)
            info["ProcessMemoryLimit"] = limits.max_memory_bytes
            win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, info)
        except Exception:
            if job is not None:
                try:
                    win32api.CloseHandle(job)
                except Exception:
                    pass
            return self._unavailable(
                execution_id=execution_id,
                code_hash=code_hash,
                start_time=start_time,
                limits=limits,
                reason="windows_job_object_configuration_failed",
            )

        stdout_state: dict[str, object] = {}
        stderr_state: dict[str, object] = {}
        threads = []
        status = "COMPLETED"
        exit_code = None
        try:
            proc = subprocess.Popen(
                [sys.executable, "-I", str(script_path)],
                cwd=str(task_dir),
                env=clean_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
            try:
                win32job.AssignProcessToJobObject(job, proc._handle)
            except Exception:
                proc.kill()
                proc.wait()
                return self._unavailable(
                    execution_id=execution_id,
                    code_hash=code_hash,
                    start_time=start_time,
                    limits=limits,
                    reason="windows_job_object_assignment_failed",
                )
            threads = [
                threading.Thread(target=_collect_stream, args=(proc.stdout, limits.max_output_bytes, stdout_state), daemon=True),
                threading.Thread(target=_collect_stream, args=(proc.stderr, limits.max_output_bytes, stderr_state), daemon=True),
            ]
            for thread in threads:
                thread.start()
            try:
                exit_code = proc.wait(timeout=limits.max_cpu_time_seconds)
                if exit_code != 0:
                    status = "ERROR"
            except subprocess.TimeoutExpired:
                status = "TIMEOUT"
                try:
                    win32job.TerminateJobObject(job, 1)
                except Exception:
                    pass
                proc.kill()
                proc.wait()
            for thread in threads:
                thread.join(timeout=2.0)
        except Exception:
            status = "ERROR"
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait()
        finally:
            try:
                win32api.CloseHandle(job)
            except Exception:
                pass

        stdout = bytes(stdout_state.get("data", b"")).decode("utf-8", errors="replace")
        stderr = bytes(stderr_state.get("data", b"")).decode("utf-8", errors="replace")
        if status == "TIMEOUT":
            stderr = f"Execution exceeded deadline of {limits.max_cpu_time_seconds}s"
        elif status == "ERROR" and not stderr:
            stderr = "Subprocess launch or execution failure"
        output_bytes = int(stdout_state.get("total", 0)) + int(stderr_state.get("total", 0))
        produced_files = []
        output_file_bytes = 0
        if outputs_dir.is_dir():
            for path in outputs_dir.rglob("*"):
                if path.is_file():
                    output_file_bytes += path.stat().st_size
                    produced_files.append(str(path.relative_to(outputs_dir)))
        if output_bytes > 2 * limits.max_output_bytes or output_file_bytes > limits.max_output_bytes:
            status = "OUTPUT_LIMIT_EXCEEDED"

        return ExecutionReceipt(
            execution_id=execution_id,
            code_hash=code_hash,
            status=status,
            exit_code=exit_code,
            stdout_snippet=stdout,
            stderr_snippet=stderr,
            duration_ms=(time.monotonic() - start_time) * 1000.0,
            output_files=produced_files,
            resource_limits=limits,
            isolation_mechanism="windows_job_object_hard_limit",
            network_isolated=False,
        )
