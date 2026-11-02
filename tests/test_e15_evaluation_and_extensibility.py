from __future__ import annotations

from pathlib import Path

from python.astra_web.evaluation_matrix import (
    BENCHMARK_TASKS,
    RunEvaluationResult,
    ScientificEvaluationEngine,
)


def _scripted_runner(task, group):
    behavior = {
        "B0": (False, 1, 0, False, 0.25),
        "B1": (True, 0, 1, False, 0.80),
        "B2": (True, 3, 1, True, 1.0),
        "B3": (True, 3, 1, True, 0.90),
        "A1": (True, 2, 1, False, 0.85),
        "A2": (False, 3, 1, False, 0.0),
        "A3": (False, 3, 1, False, 0.70),
        "A4": (True, 3, 1, True, 0.90),
        "A5": (True, 4, 2, True, 0.85),
    }
    success, model_calls, tool_calls, repaired, score = behavior[group]
    return RunEvaluationResult(
        task_id=task.task_id,
        scenario_id=task.scenario_id,
        group=group,
        success=success,
        model_calls=model_calls,
        tool_calls=tool_calls,
        repaired=repaired,
        scientific_precision_score=score,
        duration_ms=1,
        audit_verdict="SCRIPTED_RUNNER",
        configuration={"evaluationMode": group},
    )


def test_e15_evaluation_baselines_b0_to_b3():
    engine = ScientificEvaluationEngine(random_seed=42, runner=_scripted_runner)
    suite = engine.run_full_suite(groups=["B0", "B1", "B2", "B3"])
    summary = suite["summary"]
    assert summary["B0"]["success_rate"] == 0.0
    assert summary["B0"]["avg_tool_calls"] == 0.0
    assert summary["B2"]["success_count"] == len(BENCHMARK_TASKS)
    assert summary["B2"]["precision_denominator"] == len(BENCHMARK_TASKS)
    assert summary["B2"]["repair_rate"] == 1.0
    assert summary["B3"]["avg_precision"] < summary["B2"]["avg_precision"]
    assert all(result["configuration"]["evaluationMode"] == result["group"] for result in suite["raw_results"])


def test_e15_ablations_a1_to_a5():
    engine = ScientificEvaluationEngine(random_seed=42, runner=_scripted_runner)
    suite = engine.run_full_suite(groups=["B2", "A1", "A2", "A3", "A4", "A5"])
    summary = suite["summary"]
    assert summary["A1"]["success_rate"] == 1.0
    assert summary["A2"]["success_rate"] == 0.0
    assert summary["A3"]["repair_rate"] == 0.0
    assert summary["A4"]["success_rate"] == 1.0
    assert summary["A5"]["avg_model_calls"] > summary["B2"]["avg_model_calls"]
    assert summary["A5"]["avg_tool_calls"] > summary["B2"]["avg_tool_calls"]
    assert all(item["precision_denominator"] == len(BENCHMARK_TASKS) for item in summary.values())


def test_e15_factsheet_markdown_and_json_serialization():
    engine = ScientificEvaluationEngine(random_seed=42, runner=_scripted_runner)
    suite = engine.run_full_suite()
    assert "summary" in suite
    assert len(suite["summary"]) == 9
    assert len(suite["raw_results"]) == 9 * len(BENCHMARK_TASKS)
    md = ScientificEvaluationEngine.format_factsheet_markdown(suite)
    assert "# AI4S Multi-Agent Scientific Research Ablation & Baseline Factsheet" in md
    assert "**B0**" in md
    assert "**B2**" in md
    assert "**A2**" in md
    assert "B2 与 B3" in md
    assert "0.880 -> 0.960" not in md


def test_e15_fifth_scenario_extensibility_contract():
    import subprocess

    plugin_ts = Path(__file__).resolve().parent.parent / "packages" / "domain-materials" / "src" / "materials-plugin.ts"
    assert plugin_ts.is_file()
    content = plugin_ts.read_text(encoding="utf-8")
    assert "materials.bandgap" in content
    assert "MATERIALS_SCENARIO_CONTRACT" in content
    assert "MATERIALS_SCENARIO_PLUGIN" in content
    assert "crystallographer" in content
    assert "thermodynamic_reviewer" in content
    repo_root = Path(__file__).resolve().parent.parent
    cmd = [
        "node",
        "--experimental-strip-types",
        "--test",
        "packages/domain-materials/tests/materials-extensibility.test.mjs",
    ]
    proc = subprocess.run(
        cmd,
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.returncode == 0, f"Node extensibility test failed:\n{proc.stdout}\n{proc.stderr}"
    assert "pass 2" in proc.stdout or "2 pass" in proc.stdout
