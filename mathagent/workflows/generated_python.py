"""R3-gated, optional generated exploration; execution never grants evidence."""

import json
import ast
import time
from dataclasses import asdict

from ..domain import Artifact, FailureRecord
from ..review_context import ReviewContext
from ..runtime.config import fingerprint


class GeneratedPythonWorkflow:
    def __init__(self, *, store, budget, review, sandbox, checkpoint, clock=None):
        self.store, self.budget, self.review = store, budget, review
        self.sandbox, self.checkpoint = sandbox, checkpoint
        self.clock = clock or getattr(review, "clock", time.monotonic)

    def preflight(self, proposal):
        if not self.sandbox or not self.sandbox.available:
            return "generated_python_unavailable"
        args = proposal.args
        if (
            set(args) != {"code"}
            or not isinstance(args["code"], str)
            or not args["code"].strip()
            or len(args["code"].encode()) > 65536
        ):
            return "generated_python_input"
        try:
            tree = ast.parse(args["code"])
        except (SyntaxError, ValueError, RecursionError):
            return "generated_python_syntax"
        denied = {
            "numpy",
            "scipy",
            "pip",
            "subprocess",
            "socket",
            "ctypes",
            "requests",
            "mathagent",
            "math_families",
        }
        for node in ast.walk(tree):
            names = (
                [a.name for a in node.names]
                if isinstance(node, ast.Import)
                else [node.module or ""]
                if isinstance(node, ast.ImportFrom)
                else []
            )
            if any(name.split(".")[0] in denied for name in names):
                return "generated_python_capability_mismatch"
        # This is capability feedback, not the security boundary: WASI remains mandatory.
        return ""

    def process(
        self,
        artifact,
        unit,
        proposal,
        *,
        closing=False,
        deadline=None,
        _review_only=False,
        _reviewed=None,
        _enforce_deadline=True,
    ):
        stage = self.budget.finish_end if closing else self.budget.solving_end
        deadline = min(stage, deadline) if deadline is not None else stage
        if not self.sandbox or not self.sandbox.available:
            self.store.failures.append(
                FailureRecord(artifact.id, "generated_python_unavailable")
            )
            self.store.event(
                "tool_unavailable",
                proposed_tool="generated_python",
                action="general_work_unit",
            )
            return artifact
        args = proposal.args
        if (
            set(args) != {"code"}
            or not isinstance(args["code"], str)
            or not args["code"].strip()
            or len(args["code"]) > 65536
            or len(args["code"].encode()) > 65536
        ):
            self.store.failures.append(
                FailureRecord(artifact.id, "generated_python_input")
            )
            self.store.event(
                "tool_preflight_failed",
                target=artifact.id,
                reason="generated_python_input",
                no_model_review=True,
            )
            return artifact
        key = fingerprint((artifact.digest, self.sandbox.identity))
        receipts = self.store.control.setdefault("generated_python_receipts", {})
        previous = receipts.get(key)
        if previous:
            if previous.get("observation") in self.store.artifacts:
                return self.store.artifacts[previous["observation"]]
            self.store.failures.append(
                FailureRecord(
                    artifact.id,
                    "generated_python_previous_execution_without_observation",
                )
            )
            self.store.event(
                "generated_python_not_replayed",
                target=artifact.id,
                reason="execution started without a committed receipt; kernel wall timer still applies",
            )
            return artifact
        context = ReviewContext(
            task=unit.goal,
            contract="Untrusted generated Python exploration in a pinned WASI runtime. No network, installation, host commands, uncontrolled processes, or host data. Read-only interpreter and declared math libraries; private ephemeral work directory. At most min(30 seconds, original stage deadline), 512 MiB guest linear memory, 1 GiB host virtual memory and 64 KiB output. No output, exit code, or printed PASS certifies mathematics or the original-problem mapping.",
            mapping=json.dumps(
                {
                    "purpose": proposal.purpose,
                    "domain": proposal.domain,
                    "mapping": proposal.mapping,
                    "obligations": unit.obligations,
                },
                ensure_ascii=False,
            ),
            conditions=str(unit.scope)
            + "; dependencies remain provisional unless separately checked",
            bindings=(artifact.digest, fingerprint(args), self.sandbox.identity),
        )
        self.store.event(
            "tool_preflight",
            target=artifact.id,
            tool="generated_python",
            status="INPUT_CONTRACT_ACCEPTED",
        )
        report = _reviewed or self.review.review(
            "task_tool",
            "R3",
            artifact,
            deadline=deadline,
            context=context,
            **({"closing": True} if closing else {}),
        )
        self.store.event(
            "tool_review_reused" if _reviewed else "tool_review",
            target=artifact.id,
            interpretation=report.interpretation if report else "UNKNOWN",
        )
        if (
            not report
            or not report.complete
            or report.interpretation != "NO_SPECIFIC_ISSUE"
        ):
            self.store.failures.append(
                FailureRecord(artifact.id, "generated_python_review_blocked")
            )
            self.store.event(
                "generated_python_review_blocked",
                target=artifact.id,
                interpretation=report.interpretation if report else "UNKNOWN",
            )
            return artifact
        if _review_only:
            return report
        if _enforce_deadline and self.clock() >= deadline:
            self.store.failures.append(
                FailureRecord(artifact.id, "generated_python_deadline")
            )
            return artifact
        with self.store.lock:
            if key in receipts:
                return self.store.artifacts.get(
                    receipts[key].get("observation"), artifact
                )
            receipts[key] = {"state": "STARTED", "target": artifact.id}
            self.checkpoint()
        options = {
            "deadline": deadline,
            "problem_id": self.store.problem.digest,
            "scope": proposal.domain,
        }
        if callable(getattr(self.sandbox, "execute_bound", None)):
            result = self.sandbox.execute_bound(
                args["code"],
                **options,
                binding={
                    "unit": asdict(unit),
                    "proposal": asdict(proposal),
                    "artifact_digest": artifact.digest,
                    "unverified_dependencies": artifact.unverified_dependencies,
                },
            )
        else:
            result = self.sandbox.execute(args["code"], **options)
        self.store.event(
            "tool_result",
            target=artifact.id,
            proposal=asdict(proposal),
            result=asdict(result),
            mapping_status="UNVERIFIED",
            position="R3",
        )
        self.store.event(
            "tool_executed",
            target=artifact.id,
            tool="generated_python",
            status=result.status,
        )
        self.store.event(
            "tool_verified_scope",
            target=artifact.id,
            evidence_kind=result.evidence_kind,
            coverage=result.declared_scope,
            original_problem_mapping_verified=False,
        )
        if result.status != "ok":
            self.store.failures.append(
                FailureRecord(artifact.id, "generated_python_" + result.status)
            )
            receipts[key] = {
                "state": "FINISHED_WITHOUT_OBSERVATION",
                "target": artifact.id,
                "execution_status": result.status,
            }
            self.checkpoint()
            return artifact
        observation = Artifact(
            "python-" + artifact.id,
            self.store.problem.digest,
            unit.route,
            unit.id + "-python",
            json.dumps(asdict(result), ensure_ascii=False),
            "local_generated_python",
            unit.scope,
            (artifact.id,),
            tuple(sorted({artifact.id, *artifact.unverified_dependencies})),
            True,
        )
        self.store.append(observation)
        receipts[key] = {
            "state": "FINISHED",
            "target": artifact.id,
            "observation": observation.id,
        }
        self.checkpoint()
        return observation
