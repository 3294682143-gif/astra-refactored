/**
 * @zygos/domain-scientific-computing — Case B Scientific Computing & Numerical Verification Test Suite.
 *
 * Verifies:
 *  1. 1D Heat Conduction PDE Finite Difference Method (FDM) vs Exact Analytical Reference Solution
 *     u(x, t) = sin(pi * x) * exp(-alpha * pi^2 * t)
 *  2. Richardson Extrapolation Multi-Mesh Refinement (nx=20, 40, 80) Spatial Order ~ 2.0
 *  3. CFL Stability Guard (r = alpha * dt / dx^2 <= 0.5)
 *  4. Fault Injection 1: MISSING_BOUNDARY triggers boundary condition violation / Challenge
 *  5. Fault Injection 2: CFL_VIOLATION triggers stability divergence / Challenge
 *  6. End-to-end Universal Kernel execution (ScientificComputingAdapter + AgentKernel)
 *  7. Strict Invariant I15 enforcement (candidateVerified: false)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  HeatEquationSolver,
  ScientificComputingAdapter,
  SCI_COMPUTING_ID,
  SCI_COMPUTING_VERSION,
} from "../../../packages/domain-scientific-computing/dist/src/index.js";
import { runUniversalAgentLoop } from "../../../packages/agent-kernel/dist/src/generic-loop.js";

const adapter = new ScientificComputingAdapter();

test("案例 B 核心 1：FDM 数值解与解析参考解精确对照 (非硬编码)", () => {
  const alpha = 0.1;
  const tFinal = 0.2;
  const sol = HeatEquationSolver.solve({ alpha, tFinal, nx: 40 });

  // 1. Grid properties
  assert.equal(sol.nx, 40);
  assert.equal(sol.xGrid.length, 41);
  assert.ok(sol.cfl <= 0.5, `CFL must be <= 0.5, got ${sol.cfl}`);

  // 2. Exact vs Numerical L2 error bound
  // At t=0.2 with alpha=0.1, max error should be well under 0.005
  assert.ok(sol.l2Error < 0.005, `L2 error too large: ${sol.l2Error}`);
  assert.ok(sol.maxError < 0.008, `Max error too large: ${sol.maxError}`);

  // 3. Peak value comparison at x = 0.5
  const midIdx = 20;
  const uMid = sol.numericalValues[midIdx];
  const exactMid = sol.exactValues[midIdx];
  const theoreticalMid = Math.sin(Math.PI * 0.5) * Math.exp(-0.1 * Math.PI * Math.PI * 0.2);

  assert.ok(Math.abs(exactMid - theoreticalMid) < 1e-12, "Analytical reference math mismatch");
  assert.ok(Math.abs(uMid - theoreticalMid) < 0.005, `Numerical solution deviated from exact: ${uMid} vs ${theoreticalMid}`);
});

test("案例 B 核心 2：Richardson 外推法多网格空间收敛阶验证 (二阶精度 O(dx^2))", () => {
  const report = HeatEquationSolver.verifyConvergence({ alpha: 0.1, tFinal: 0.2 }, [20, 40, 80]);

  assert.equal(report.scheme, "forward_euler_finite_difference");
  assert.equal(report.expectedOrder, 2.0);
  assert.equal(report.grids.length, 3);

  // Each mesh refinement cuts error by ~ 4x (2^2)
  const e20 = report.grids[0].l2Error;
  const e40 = report.grids[1].l2Error;
  const e80 = report.grids[2].l2Error;

  assert.ok(e20 > e40, `Monotonic refinement failed: e20=${e20}, e40=${e40}`);
  assert.ok(e40 > e80, `Monotonic refinement failed: e40=${e40}, e80=${e80}`);

  // Observed order must be close to theoretical 2.0
  assert.ok(
    Math.abs(report.observedOrder - 2.0) <= 0.25,
    `Empirical spatial order deviated from 2.0: ${report.observedOrder}`
  );
  assert.equal(report.isOrderConsistent, true);
  assert.equal(report.cflDiagnosis.isStable, true);
  assert.equal(report.boundaryDiagnosis.dirichletMatched, true);
  assert.equal(report.allObligationsMet, true);
  assert.equal(report.candidateVerified, false); // Invariant I15
});

test("案例 B 故障注入 1：MISSING_BOUNDARY 触发边界守恒违例 / Challenge", () => {
  const faultReport = HeatEquationSolver.verifyConvergence({
    alpha: 0.1,
    tFinal: 0.2,
    fault: "MISSING_BOUNDARY",
  });

  assert.equal(faultReport.boundaryDiagnosis.dirichletMatched, false);
  assert.ok(faultReport.boundaryDiagnosis.verdict.includes("边界条件违例"));
  assert.equal(faultReport.allObligationsMet, false, "Must reject when boundary missing");
  assert.equal(faultReport.candidateVerified, false);
});

test("案例 B 故障注入 2：CFL_VIOLATION 触发显式格式数值发散 / Challenge", () => {
  const faultReport = HeatEquationSolver.verifyConvergence({
    alpha: 0.1,
    tFinal: 0.2,
    fault: "CFL_VIOLATION",
  });

  assert.equal(faultReport.cflDiagnosis.isStable, false);
  assert.ok(faultReport.cflDiagnosis.maxCfl > 0.5, `Max CFL must exceed 0.5: ${faultReport.cflDiagnosis.maxCfl}`);
  assert.ok(faultReport.cflDiagnosis.verdict.includes("CFL 条件违例"));
  assert.equal(faultReport.allObligationsMet, false, "Must reject when CFL violated");
  assert.equal(faultReport.candidateVerified, false);
});

test("案例 B 协议闭环：ScientificComputingAdapter 契约生成与义务提出", () => {
  const input = { rawText: "一维非齐次热传导方程数值复现 (alpha=0.1, tFinal=0.2)" };
  const contract = adapter.compileContract(input);

  assert.deepEqual(contract.goals, ["NUMERICAL_EXPERIMENT", "METHOD_REPLICATION"]);
  assert.equal(contract.proposedObligations.length, 2);
  assert.equal(contract.proposedObligations[0].id, "ob_mesh_convergence");
  assert.equal(contract.proposedObligations[1].id, "ob_boundary_conservation");

  const validation = adapter.validateContract(contract, input);
  assert.equal(validation.valid, true);
});

test("案例 B 通用内核执行：零核心改动接入通用 AgentKernel", async () => {
  const mockHostPorts = {
    model: {
      requestCompletion: async () => ({
        content: "Finite difference discretization O(dx^2), CFL=0.16 <= 0.5",
        finishReason: "stop",
        usage: { promptTokens: 40, completionTokens: 25, totalTokens: 65 },
      }),
    },
    asset: {
      execute: async (toolName, params) => ({
        callId: "call_heat_fdm_01",
        toolName,
        status: "SUCCESS",
        output: { observedOrder: 1.98, l2Error: 0.0012, cflNumber: 0.16 },
      }),
    },
    clock: {
      nowMonotonicMs: () => 1000,
      remainingBudgetMs: () => 60000,
    },
  };

  const result = await runUniversalAgentLoop({
    domainAdapter: adapter,
    hostPorts: mockHostPorts,
    runSpec: {
      runId: "run_scicomp_case_b_001",
      domainId: SCI_COMPUTING_ID,
      domainVersion: SCI_COMPUTING_VERSION,
      inputRefs: ["ref_case_b_heat_pde"],
      profileId: "prod",
      createdAt: new Date().toISOString(),
    },
    budget: { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000 },
    rawInput: { rawText: "1D Heat Conduction FDM Replication" },
  });

  assert.equal(result.runId, "run_scicomp_case_b_001");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
});
