"""Generate golden sample packages for Math, Control, Data Analysis, and Scientific Computing (F-04)."""

import csv
import json
import math
from pathlib import Path
import random

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = REPO_ROOT / "samples"


def generate_math_sample():
    math_dir = SAMPLES_DIR / "math"
    math_dir.mkdir(parents=True, exist_ok=True)

    problem = {
        "domainId": "math",
        "problemId": "math_quadratic_001",
        "title": "一元二次多项式精确因式分解与实数根判定",
        "rawText": "求解多项式方程 x^2 - 5x + 6 = 0 的所有实数根，并给出因式分解形式",
        "polynomial": "x^2 - 5x + 6",
    }
    (math_dir / "problem.json").write_text(json.dumps(problem, indent=2, ensure_ascii=False), encoding="utf-8")

    input_spec = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["domainId", "rawText"],
        "properties": {
            "domainId": {"const": "math"},
            "rawText": {"type": "string"},
            "profileId": {"type": "string", "default": "prod"},
            "budgets": {
                "maxModelCalls": {"type": "integer", "default": 5},
                "maxToolCalls": {"type": "integer", "default": 5},
                "timeoutMs": {"type": "integer", "default": 60000},
            },
        },
    }
    (math_dir / "input_spec.json").write_text(json.dumps(input_spec, indent=2), encoding="utf-8")

    expected_output = {
        "status": "candidate",
        "candidateVerified": False,
        "stopReason": "STOPPED",
        "domainId": "math",
        "expectedResults": {
            "roots": [2.0, 3.0],
            "factors": ["(x - 2)", "(x - 3)"],
            "discriminant": 1.0,
            "rootCount": 2,
        },
        "invariants": {
            "candidateVerified": False,
            "strictAcceptance": "NOT_PERFORMED",
        },
    }
    (math_dir / "expected_output.json").write_text(json.dumps(expected_output, indent=2, ensure_ascii=False), encoding="utf-8")

    replay_package = {
        "replayVersion": "1.0.0",
        "runId": "run_golden_math_001",
        "domainId": "math",
        "problem": problem["rawText"],
        "recordedResult": expected_output,
        "isDeterministic": True,
    }
    (math_dir / "replay_package.json").write_text(json.dumps(replay_package, indent=2, ensure_ascii=False), encoding="utf-8")


def generate_control_sample():
    ctrl_dir = SAMPLES_DIR / "control"
    ctrl_dir.mkdir(parents=True, exist_ok=True)

    problem = {
        "domainId": "control.identification",
        "problemId": "control_oscillator_001",
        "title": "单自由度机械阻尼振子参数辨识与白噪声残差检验",
        "rawText": "针对受迫阻尼振子系统 m*x'' + c*x' + k*x = u(t)，输入激励为方波与正弦叠加信号，辨识物理参数 m, c, k",
        "nominalParameters": {"m": 1.0, "c": 0.2, "k": 1.5},
    }
    (ctrl_dir / "problem.json").write_text(json.dumps(problem, indent=2, ensure_ascii=False), encoding="utf-8")

    # Generate timeseries CSV
    # m*x'' + c*x' + k*x = u(t)
    dt = 0.01
    t_end = 10.0
    steps = int(t_end / dt)
    m, c, k = 1.0, 0.2, 1.5

    x = 0.0
    v = 0.0
    random.seed(42)

    rows = [["timestamp", "u", "x", "v"]]
    for i in range(steps + 1):
        t = i * dt
        # Input signal: sum of sines
        u = 2.0 * math.sin(1.2 * t) + 1.0 * math.cos(3.0 * t)
        noise = random.gauss(0, 0.005)
        # Acceleration
        a = (u - c * v - k * x) / m
        # Semi-implicit Euler integration
        v += a * dt
        x += v * dt
        rows.append([f"{t:.4f}", f"{u:.6f}", f"{(x + noise):.6f}", f"{v:.6f}"])

    with open(ctrl_dir / "input_timeseries.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerows(rows)

    input_spec = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["domainId", "timeseriesFile", "algorithm"],
        "properties": {
            "domainId": {"const": "control.identification"},
            "timeseriesFile": {"type": "string"},
            "algorithm": {"type": "string", "enum": ["least_squares", "recursive_least_squares"]},
            "dt": {"type": "number", "default": 0.01},
        },
    }
    (ctrl_dir / "input_spec.json").write_text(json.dumps(input_spec, indent=2), encoding="utf-8")

    expected_output = {
        "status": "candidate",
        "candidateVerified": False,
        "stopReason": "STOPPED",
        "domainId": "control.identification",
        "expectedParameterRanges": {
            "m": {"expected": 1.0, "tolerance": 0.05, "min": 0.95, "max": 1.05},
            "c": {"expected": 0.2, "tolerance": 0.05, "min": 0.15, "max": 0.25},
            "k": {"expected": 1.5, "tolerance": 0.08, "min": 1.42, "max": 1.58},
        },
        "expectedDiagnostics": {
            "rmse": {"max": 0.05},
            "r1Autocorrelation": {"expected": -0.5, "tolerance": 0.2},
            "conditionNumberGuard": True,
        },
        "invariants": {
            "candidateVerified": False,
        },
    }
    (ctrl_dir / "expected_output.json").write_text(json.dumps(expected_output, indent=2, ensure_ascii=False), encoding="utf-8")

    replay_package = {
        "replayVersion": "1.0.0",
        "runId": "run_golden_control_001",
        "domainId": "control.identification",
        "problem": problem["rawText"],
        "recordedResult": expected_output,
        "isDeterministic": True,
    }
    (ctrl_dir / "replay_package.json").write_text(json.dumps(replay_package, indent=2, ensure_ascii=False), encoding="utf-8")


def generate_data_analysis_sample():
    da_dir = SAMPLES_DIR / "data_analysis"
    da_dir.mkdir(parents=True, exist_ok=True)

    problem = {
        "domainId": "data_analysis",
        "problemId": "data_analysis_welch_001",
        "title": "两独立组高通量基因表达水平显著性差异分析与残差诊断",
        "rawText": "分析实验组与对照组各50例生物样本基因表达量，执行两样本 Welch's t-test，计算 Cohen's d 效应量与 95% 置信区间",
        "nominalParameters": {
            "groupA": {"n": 50, "mean": 10.0, "std": 1.2},
            "groupB": {"n": 50, "mean": 12.5, "std": 1.4},
        },
    }
    (da_dir / "problem.json").write_text(json.dumps(problem, indent=2, ensure_ascii=False), encoding="utf-8")

    # Generate raw CSV
    random.seed(42)
    rows = [["sample_id", "group", "expression_level"]]
    for i in range(1, 51):
        val = random.gauss(10.0, 1.2)
        rows.append([f"CTR_{i:03d}", "control", f"{val:.4f}"])
    for i in range(1, 51):
        val = random.gauss(12.5, 1.4)
        rows.append([f"TRT_{i:03d}", "treatment", f"{val:.4f}"])

    with open(da_dir / "input_dataset.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerows(rows)

    input_spec = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["domainId", "datasetFile", "testType"],
        "properties": {
            "domainId": {"const": "data_analysis"},
            "datasetFile": {"type": "string"},
            "testType": {"type": "string", "enum": ["two_sample_welch_t_test", "student_t_test"]},
            "alpha": {"type": "number", "default": 0.05},
        },
    }
    (da_dir / "input_spec.json").write_text(json.dumps(input_spec, indent=2), encoding="utf-8")

    expected_output = {
        "status": "candidate",
        "candidateVerified": False,
        "stopReason": "STOPPED",
        "domainId": "data_analysis",
        "testMethod": "two_sample_welch_t_test",
        "expectedStatRanges": {
            "tStatistic": {"min": -12.0, "max": -7.0},
            "degreesOfFreedom": {"min": 92.0, "max": 98.0},
            "pValue": {"max": 0.001},
            "isSignificant": True,
            "meanDifference": {"expected": -2.5, "min": -3.0, "max": -2.0},
            "cohensD": {"min": -2.5, "max": -1.5},
        },
        "expectedGuards": {
            "normalityPassed": True,
            "residualWhitenessPassed": True,
        },
        "invariants": {
            "candidateVerified": False,
        },
    }
    (da_dir / "expected_output.json").write_text(json.dumps(expected_output, indent=2, ensure_ascii=False), encoding="utf-8")

    replay_package = {
        "replayVersion": "1.0.0",
        "runId": "run_golden_data_analysis_001",
        "domainId": "data_analysis",
        "problem": problem["rawText"],
        "recordedResult": expected_output,
        "isDeterministic": True,
    }
    (da_dir / "replay_package.json").write_text(json.dumps(replay_package, indent=2, ensure_ascii=False), encoding="utf-8")


def generate_scicomp_sample():
    sci_dir = SAMPLES_DIR / "scientific_computing"
    sci_dir.mkdir(parents=True, exist_ok=True)

    problem = {
        "domainId": "scientific_computing",
        "problemId": "scicomp_heat_fdm_001",
        "title": "一维非齐次热传导方程显式差分求解与 Richardson 空间二阶收敛验证",
        "rawText": "针对热扩散方程 du/dt = 0.1 * d^2u/dx^2, x in [0, 1], t in [0, 0.2]，采用前向显式差分格式，验证空间收敛阶接近 2.0",
        "parameters": {"alpha": 0.1, "tFinal": 0.2, "length": 1.0},
    }
    (sci_dir / "problem.json").write_text(json.dumps(problem, indent=2, ensure_ascii=False), encoding="utf-8")

    input_spec = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["domainId", "parameters", "meshGrids"],
        "properties": {
            "domainId": {"const": "scientific_computing"},
            "parameters": {
                "alpha": {"type": "number", "default": 0.1},
                "tFinal": {"type": "number", "default": 0.2},
            },
            "meshGrids": {"type": "array", "items": {"type": "integer"}, "default": [20, 40, 80]},
        },
    }
    (sci_dir / "input_spec.json").write_text(json.dumps(input_spec, indent=2), encoding="utf-8")

    expected_output = {
        "status": "candidate",
        "candidateVerified": False,
        "stopReason": "STOPPED",
        "domainId": "scientific_computing",
        "scheme": "forward_euler_finite_difference",
        "expectedConvergenceRanges": {
            "observedOrder": {"expected": 2.0, "min": 1.85, "max": 2.15},
            "cflMax": {"max": 0.5},
            "isOrderConsistent": True,
            "dirichletMatched": True,
        },
        "invariants": {
            "candidateVerified": False,
        },
    }
    (sci_dir / "expected_output.json").write_text(json.dumps(expected_output, indent=2, ensure_ascii=False), encoding="utf-8")

    replay_package = {
        "replayVersion": "1.0.0",
        "runId": "run_golden_scicomp_001",
        "domainId": "scientific_computing",
        "problem": problem["rawText"],
        "recordedResult": expected_output,
        "isDeterministic": True,
    }
    (sci_dir / "replay_package.json").write_text(json.dumps(replay_package, indent=2, ensure_ascii=False), encoding="utf-8")


def main():
    print("Generating golden samples...")
    generate_math_sample()
    print(" - samples/math created")
    generate_control_sample()
    print(" - samples/control created")
    generate_data_analysis_sample()
    print(" - samples/data_analysis created")
    generate_scicomp_sample()
    print(" - samples/scientific_computing created")
    print("Golden samples generated successfully!")


if __name__ == "__main__":
    main()
