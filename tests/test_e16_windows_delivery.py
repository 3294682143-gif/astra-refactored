"""Test suite for Work Package E16: Windows Delivery and Reviewer Experience.

Verifies:
1. Pre-flight self-check validation (Python, Node.js, writable data root, Web dist build).
2. Reviewer restricted experience mode: unconfigured API key gracefully returns
   SOLVER_NOT_CONFIGURED without crashing, faking results, or hanging.
3. Health check endpoint (/api/v2/health) reports correct platform, scenario readiness, and status.
4. Windows launcher batch script (run_inkstone.bat) existence and valid syntax.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import pytest

from starlette.requests import Request
from starlette.responses import JSONResponse

from scripts.start_services import run_preflight_checks
from python.astra_web.storage import Store
from python.astra_web.v2_routes import v2_health, create_v2_run


def test_e16_preflight_checks():
    with tempfile.TemporaryDirectory() as tmpdir:
        data_root = Path(tmpdir) / "astra_data"
        web_dist = Path(tmpdir) / "web_dist"
        web_dist.mkdir(parents=True, exist_ok=True)
        (web_dist / "index.html").write_text("<!DOCTYPE html><html></html>", encoding="utf-8")

        # 1. Normal pre-flight pass
        passed, issues = run_preflight_checks(data_root, web_dist)
        assert passed is True
        assert len(issues) == 0

        # 2. Missing index.html pre-flight failure
        (web_dist / "index.html").unlink()
        passed_fail, issues_fail = run_preflight_checks(data_root, web_dist)
        assert passed_fail is False
        assert any("Front-end build artifact missing" in i for i in issues_fail)


def test_e16_cli_check_only_mode():
    repo_root = Path(__file__).resolve().parent.parent
    cmd = [sys.executable, "scripts/start_services.py", "--check-only"]
    proc = subprocess.run(
        cmd,
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.returncode == 0
    assert "Pre-flight checks passed successfully" in proc.stdout
    assert "Self-check mode complete" in proc.stdout


@pytest.mark.anyio
async def test_e16_reviewer_restricted_experience_mode():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = Store(tmpdir)

        class DummyState:
            pass

        class DummyApp:
            def __init__(self):
                self.state = DummyState()
                self.state.store = store
                from python.astra_web.queue import ExecutionManager
                # Intentionally pass solver=None to simulate judge environment without API keys
                self.state.execution_manager = ExecutionManager(store, solver=None)

        app = DummyApp()

        # 1. Probe /api/v2/health
        scope_health = {"type": "http", "method": "GET", "path": "/api/v2/health", "headers": [], "app": app}
        req_health = Request(scope_health)
        resp_health = v2_health(req_health)
        assert resp_health.status_code == 200
        health_data = json.loads(resp_health.body.decode("utf-8"))
        assert health_data["status"] == "DEGRADED"
        assert health_data["solverConfigured"] is False
        assert health_data["isolatedWorkerAvailable"] is False
        assert health_data["judgeModeAvailable"] is True
        assert health_data["scenariosCount"] == 4

        # 2. Dispatch run in unconfigured mode
        scope_run = {"type": "http", "method": "POST", "path": "/api/v2/runs", "headers": [], "app": app}
        req_run = Request(scope_run)

        async def mock_json():
            return {
                "scenarioId": "control.identification",
                "problem": "Estimate oscillator parameters without external API key",
            }

        req_run.json = mock_json
        resp_run = await create_v2_run(req_run)

        assert resp_run.status_code in (200, 201)
        run_data = json.loads(resp_run.body.decode("utf-8"))

        # Strict: must honestly report SOLVER_NOT_CONFIGURED and candidateVerified=False
        assert run_data["code"] == "SOLVER_NOT_CONFIGURED"
        assert run_data["candidateVerified"] is False


def test_e16_windows_batch_launcher_script():
    repo_root = Path(__file__).resolve().parent.parent
    bat_path = repo_root / "run_inkstone.bat"
    assert bat_path.is_file(), "run_inkstone.bat must exist in repository root"

    content = bat_path.read_text(encoding="utf-8")
    assert "@echo off" in content
    assert "start_services.py" in content
    assert "%ERRORLEVEL%" in content
