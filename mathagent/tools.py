"""Registered source functions are trusted code, not a generated Python sandbox."""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import re
import signal
import time
from dataclasses import dataclass
from importlib.resources import files

from .input_contracts import validate_inputs
from .runtime.config import fingerprint
from .tool_contracts import (
    CONTRACTS,
    InvalidToolInput,
    OutsideAuditScope,
    ToolAudit,
    audit_output,
    normalize_inputs,
)


@dataclass(frozen=True)
class ToolResult:
    status: str
    tool: str
    result: object
    evidence_kind: str
    declared_scope: str
    certificate: object = None
    detail: str = ""
    verification: ToolAudit | None = None
    requested_scope: str = ""
    input_hash: str = ""
    input_contract: object = None


@dataclass(frozen=True)
class ToolProposal:
    name: str
    args: dict
    purpose: str
    domain: str
    mapping: str


def parse_tool_proposal(text: str):
    """A bounded suggestion, not a model action or a verification verdict."""
    prefix = re.match(r"^TOOL:\s*([a-z][a-z0-9_]*);\s*INPUT:\s*", text)
    if not prefix:
        return None
    try:
        args, end = json.JSONDecoder().raw_decode(text[prefix.end() :])
    except (ValueError, TypeError):
        return None
    suffix = text[prefix.end() + end :]
    match = re.fullmatch(
        r";\s*PURPOSE:\s*(.+?);\s*DOMAIN:\s*(.+?);\s*MAPPING:\s*(.+)", suffix
    )
    if not isinstance(args, dict) or not match:
        return None
    return ToolProposal(prefix[1], args, match[1], match[2], match[3])


def _registered_worker(conn, name, args):
    os.setsid()
    import ctypes
    parent = os.getppid()
    if parent == 1 or ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        return
    if os.getppid() != parent:
        return
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        # Bound native math-library worker pools before they are imported.
        os.environ["OPENBLAS_NUM_THREADS"] = "1"
        os.environ["OMP_NUM_THREADS"] = "1"
        from math_families.bridge.dispatch import call_tool

        value = call_tool(name, args)
        payload = json.dumps(value, ensure_ascii=False, default=str, allow_nan=False)
        if len(payload.encode()) > 65536:
            conn.send({"status": "resource_limited", "result": None})
        else:
            conn.send(json.loads(payload))
    except MemoryError:
        conn.send(
            {
                "status": "resource_limited",
                "result": None,
                "detail": "registered tool memory cap",
            }
        )
    except Exception as exc:  # noqa: BLE001 - child reports only exception type to its parent
        conn.send({"status": "error", "result": None, "detail": type(exc).__name__})
    finally:
        conn.close()


class RegisteredExecutor:
    def __init__(self):
        self.registry = json.loads(
            files("mathagent")
            .joinpath("resources/tool-registry.json")
            .read_text(encoding="utf-8")
        )["tools"]

    def execute(self, name, args, *, deadline, scope: str):
        if (
            not isinstance(name, str)
            or name not in self.registry
            or not isinstance(args, dict)
            or not isinstance(scope, str)
            or not scope.strip()
        ):
            return ToolResult("invalid_input", name, None, "NONE", scope)
        spec = self.registry[name]
        required = set(spec.get("required_params", []))
        allowed = required | set(spec.get("optional_params", []))
        if not required <= args.keys() or args.keys() - allowed:
            return ToolResult(
                "invalid_input", name, None, "NONE", scope, detail="argument contract"
            )
        try:
            encoded = json.dumps(args, allow_nan=False)
            args = json.loads(
                encoded
            )  # Freeze arguments before producer dispatch and independent checking.
        except (ValueError, TypeError, RecursionError, OverflowError):
            return ToolResult("invalid_input", name, None, "NONE", scope)
        if len(encoded) > 10000 or time.monotonic() >= deadline:
            return ToolResult("resource_limited", name, None, "NONE", scope)
        try:
            input_contract = validate_inputs(name, args)
        except InvalidToolInput as exc:
            return ToolResult(
                "invalid_input",
                name,
                None,
                "NONE",
                spec["declared_scope"],
                detail=str(exc),
                requested_scope=scope,
            )
        except OutsideAuditScope as exc:
            return ToolResult(
                "out_of_scope",
                name,
                None,
                "NONE",
                spec["declared_scope"],
                detail=str(exc),
                requested_scope=scope,
            )
        if name in CONTRACTS:
            try:
                normalize_inputs(name, args)
            except InvalidToolInput as exc:
                return ToolResult(
                    "invalid_input",
                    name,
                    None,
                    "NONE",
                    spec["declared_scope"],
                    detail=str(exc),
                    requested_scope=scope,
                )
            except OutsideAuditScope:
                pass  # The producer may support a broader domain, but cannot receive this audit's authority.
        context = mp.get_context("spawn")
        parent, child = context.Pipe(duplex=False)
        proc = context.Process(target=_registered_worker, args=(child, name, args))
        proc.start()
        child.close()
        result = {"status": "resource_limited", "result": None}
        try:
            if parent.poll(max(0, min(30, deadline - time.monotonic()))):
                result = parent.recv()
        except EOFError:
            result = {"status": "error", "result": None}
        finally:
            if proc.is_alive():
                # The child creates its own session; kill its controlled descendants too.
                try:
                    if os.getpgid(proc.pid) == proc.pid:
                        os.killpg(proc.pid, signal.SIGKILL)
                    else:
                        proc.kill()
                except ProcessLookupError:
                    pass
            proc.join(timeout=2)
            parent.close()
        status = result.get("status", "error")
        audit = audit_output(
            name,
            args,
            result.get("result"),
            execution_status=status,
            certificate=result.get("certificate"),
        )
        if audit.status in {"MISMATCH", "INVALID_INPUT"}:
            status = "verification_failed"
        # Conservative explicit categories. No tool can grant VERIFIED via this wrapper.
        categories = {
            "closed_form_conjecture": "CONJECTURE",
            "identify_constant": "CONJECTURE",
            "numeric_extremum_search_expr": "NUMERICAL_SUPPORT",
            "certificate_check_expr": "NUMERICAL_SUPPORT",
            "solve_system_guarded_expr": "NUMERICAL_SUPPORT",
            "count_angle_ratio_locus": "NUMERICAL_SUPPORT",
            "normal_overflow_seats": "NUMERICAL_SUPPORT",
            "finite_difference_derivative": "NUMERICAL_SUPPORT",
            "richardson_extrapolate": "NUMERICAL_SUPPORT",
        }
        kind = (
            categories.get(name, "BOUNDED_OBSERVATION")
            if status in {"ok", "partial"}
            else "NONE"
        )
        if audit.status == "VERIFIED_FOR_INPUT":
            kind = "EXACT_FOR_INPUT"
        elif audit.status == "CHECKED_NUMERICAL_FOR_INPUT":
            kind = "NUMERICAL_SUPPORT"
        elif audit.status in {
            "CHECKED_CONJECTURE_FOR_INPUT",
            "CHECKED_WITNESS_FOR_INPUT",
        }:
            kind = (
                "CONJECTURE"
                if name
                in {
                    "closed_form_conjecture",
                    "identify_constant",
                    "subset_gap_worst_case",
                    "worst_configuration_search",
                }
                else "BOUNDED_OBSERVATION"
            )
        output = result.get("result")
        if audit.status == "MISMATCH" and not audit.result_hash:
            # Non-JSON producer data must not poison persisted events/final output.
            output = None
        return ToolResult(
            status,
            name,
            output,
            kind,
            audit.scope
            if audit.status == "VERIFIED_FOR_INPUT"
            or audit.status.startswith("CHECKED_")
            else spec["declared_scope"],
            result.get("certificate"),
            "Execution is not proof; mapping is provisional.",
            audit,
            scope,
            fingerprint((name, args)),
            input_contract,
        )


class PythonSandbox:
    """Explicit accepted WASI profile, otherwise fail closed as before."""

    available = False
    reason = "No explicitly accepted generated-Python isolation profile configured"

    def __init__(self, *, profile=None):
        self.backend = None
        self.identity = None
        if profile is not None:
            from .sandbox_wasi import WasiPythonSandbox

            try:
                self.backend = WasiPythonSandbox(profile)
                self.available = self.backend.available
                self.reason = self.backend.reason
                self.identity = self.backend.identity
            except (OSError, ValueError, TypeError):
                self.reason = "Explicit WASI profile unavailable"

    def execute(self, code, **limits):
        if self.backend is not None and self.available:
            return self.backend.execute(code, **limits)
        return ToolResult(
            "backend_unavailable",
            "generated_python",
            None,
            "NONE",
            "NONE",
            detail=self.reason,
        )
