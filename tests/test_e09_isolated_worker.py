"""Tests for E09: Isolated code execution worker, resource limits, and process tree termination."""

import os
from pathlib import Path
import tempfile
import pytest

from python.astra_web.isolated_worker import (
    IsolatedCodeWorker,
    WorkerResourceLimits,
)


def test_e09_isolated_worker_normal_execution():
    with tempfile.TemporaryDirectory() as tmpdir:
        worker = IsolatedCodeWorker(workspace_root=Path(tmpdir))

        script = """
import json
import os

inputs_dir = os.environ.get("ASTRA_TASK_INPUTS")
outputs_dir = os.environ.get("ASTRA_TASK_OUTPUTS")

with open(os.path.join(inputs_dir, "input_data.json"), "r") as f:
    data = json.load(f)

result = {"sum": sum(data["numbers"]), "count": len(data["numbers"])}

with open(os.path.join(outputs_dir, "result.json"), "w") as f:
    json.dump(result, f)

print("SUCCESS_COMPLETED")
"""
        inputs = {"input_data.json": '{"numbers": [10, 20, 30, 40]}'}
        receipt = worker.execute_script(
            script_code=script,
            execution_id="exec_test_01",
            input_files=inputs,
            limits=WorkerResourceLimits(max_cpu_time_seconds=5.0, require_network_isolation=False),
        )

        assert receipt.status == "COMPLETED"
        assert receipt.exit_code == 0
        assert "SUCCESS_COMPLETED" in receipt.stdout_snippet
        assert "result.json" in receipt.output_files
        assert receipt.duration_ms > 0


def test_e09_isolated_worker_timeout_and_process_cleanup():
    with tempfile.TemporaryDirectory() as tmpdir:
        worker = IsolatedCodeWorker(workspace_root=Path(tmpdir))

        # Infinite loop
        script = """
import time
while True:
    time.sleep(0.01)
"""
        receipt = worker.execute_script(
            script_code=script,
            execution_id="exec_test_timeout",
            limits=WorkerResourceLimits(max_cpu_time_seconds=1.2, require_network_isolation=False),
        )

        assert receipt.status == "TIMEOUT"
        assert "exceeded deadline" in receipt.stderr_snippet


def test_e09_isolated_worker_environment_sanitization():
    with tempfile.TemporaryDirectory() as tmpdir:
        worker = IsolatedCodeWorker(workspace_root=Path(tmpdir))

        # Test script that tries to snoop environment for secrets
        script = """
import os
secrets = [k for k in os.environ.keys() if "SECRET" in k or "TOKEN" in k or "KEY" in k]
print(f"SECRETS_FOUND={secrets}")
"""
        # Set a dummy secret in parent env
        os.environ["SUPER_SECRET_TOKEN"] = "CLASSIFIED_12345"
        try:
            receipt = worker.execute_script(
                script_code=script,
                execution_id="exec_test_env_snoop",
                limits=WorkerResourceLimits(max_cpu_time_seconds=5.0, require_network_isolation=False),
            )
            assert receipt.status == "COMPLETED"
            assert "SECRETS_FOUND=[]" in receipt.stdout_snippet
        finally:
            os.environ.pop("SUPER_SECRET_TOKEN", None)
