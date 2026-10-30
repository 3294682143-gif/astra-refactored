/**
 * @zygos/domain-data-analysis — Section 20.4 Case D Third Domain Zero-Core-Change Test Suite.
 *
 * Verifies:
 *  1. Real numerical two-sample Welch t-test, Cohen's d, CI, and residual diagnosis.
 *  2. Distributional assumption guards (Jarque-Bera normality, heteroscedasticity, residual whiteness).
 *  3. End-to-end universal kernel execution with zero changes to agent-kernel and agent-loop.
 *  4. Shared fault matrix reuse: T01, T06, T08, T18 domain-agnostic invariants.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DataAnalysisAdapter,
  DATA_ANALYSIS_ID,
  DATA_ANALYSIS_VERSION,
} from "../../../packages/domain-data-analysis/dist/src/data-analysis-adapter.js";
import {
  StatisticalAnalyzer,
  generateTwoSampleDataset,
} from "../../../packages/domain-data-analysis/dist/src/statistical-analyzer.js";
import { runUniversalAgentLoop } from "../../../packages/agent-kernel/dist/src/generic-loop.js";
import { assertCandidateIntegrity } from "../../../packages/domain-contract/dist/src/index.js";

const adapter = new DataAnalysisAdapter();

test("案例 D 核心：两组样本真实 Welch t-test 数值推断、效应量与置信区间 (非硬编码)", () => {
  // Ground truth: Group A (control): mu=10.0, sigma=1.2; Group B (treatment): mu=12.5, sigma=1.4
  // True mean difference = -2.5, true Cohen's d = -2.5 / 1.304 ~ -1.91
  const dataset = generateTwoSampleDataset({
    n1: 50,
    n2: 50,
    mean1: 10.0,
    mean2: 12.5,
    std1: 1.2,
    std2: 1.4,
    seed: 42,
  });

  const report = StatisticalAnalyzer.analyze(dataset, { alpha: 0.05 });

  // 1. Verify sample summaries are computed from raw numbers
  assert.equal(report.domainId, "data_analysis");
  assert.equal(report.testMethod, "two_sample_welch_t_test");
  assert.equal(report.groupA.count, 50);
  assert.equal(report.groupB.count, 50);
  assert.ok(Math.abs(report.groupA.mean - 10.0) < 0.5, `Group A mean deviated: ${report.groupA.mean}`);
  assert.ok(Math.abs(report.groupB.mean - 12.5) < 0.5, `Group B mean deviated: ${report.groupB.mean}`);

  // 2. Welch t-test statistics
  const res = report.testResult;
  assert.ok(res.degreesOfFreedom > 90 && res.degreesOfFreedom < 100, `df expected ~97, got ${res.degreesOfFreedom}`);
  assert.ok(res.tStatistic < -5.0, `tStatistic expected < -5.0, got ${res.tStatistic}`);
  assert.ok(res.pValue < 0.001, `pValue must be < 0.001, got ${res.pValue}`);
  assert.equal(res.isSignificant, true, "H0 must be rejected at alpha=0.05");
  assert.ok(Math.abs(res.cohensD - -1.7) < 0.5, `Cohen's d deviated: ${res.cohensD}`);

  // 3. 95% Confidence interval encloses true difference
  const [ciLower, ciUpper] = res.confidenceInterval;
  assert.ok(ciLower <= res.meanDifference && res.meanDifference <= ciUpper, "CI must enclose estimated mean diff");
  assert.ok(ciLower <= -2.5 && -2.5 <= ciUpper, "CI must enclose true population difference -2.5");

  // 4. Assumptions: Normality & Residual Whiteness pass on Gaussian i.i.d. data
  assert.equal(report.normalityDiagnosis.passed, true);
  assert.equal(report.normalityDiagnosis.groupANormal, true);
  assert.equal(report.normalityDiagnosis.groupBNormal, true);
  assert.equal(report.residualDiagnosis.isWhite, true);
  assert.equal(report.residualDiagnosis.diagnosis, "RESIDUAL_WHITE");
  assert.equal(report.allObligationsMet, true);
  assert.equal(report.candidateVerified, false);
});

test("统计守卫 1：非正态偏斜分布触发 Jarque-Bera 拦截，禁止作为标准正态推断交付", () => {
  // Generate heavily skewed / non-normal distribution (exponential/log-normal tails)
  const dataset = generateTwoSampleDataset({
    n1: 40,
    n2: 40,
    mean1: 5.0,
    mean2: 8.0,
    std1: 2.0,
    std2: 2.5,
    nonNormal: true,
    seed: 99,
  });

  const report = StatisticalAnalyzer.analyze(dataset);

  // Jarque-Bera must reject normality
  assert.equal(report.normalityDiagnosis.passed, false);
  assert.match(report.normalityDiagnosis.verdict, /正态性假设违背/);
  assert.equal(report.allObligationsMet, false);

  // Adapter assessObligation must refute
  const failReceipt = [
    {
      validatorId: "data_normality_checker",
      validatorVersion: "1.0",
      subjectHash: "h_norm_fail",
      scope: "distribution",
      outcome: "FAIL",
      evidenceRefs: [],
      issuedAt: new Date().toISOString(),
    },
  ];
  const assessment = adapter.assessObligation(failReceipt, {
    obligation: { id: "ob_normality_homoscedasticity", kind: "STATISTICAL_ASSUMPTION_VALIDITY", subjectRef: "", scopeRef: "", acceptancePolicyRef: "", state: "OPEN" },
  });
  assert.equal(assessment.newState, "REFUTED");
  assert.match(assessment.rationale, /正态性假设检验拒绝/);
});

test("统计守卫 2：残差自相关显著 (|r1| >= 0.25) 判定'结构欠定'，禁止输出'推断可信'", () => {
  // Generate dataset with strong serial autocorrelation in noise (AR(1) parameter = 0.7)
  const dataset = generateTwoSampleDataset({
    n1: 50,
    n2: 50,
    mean1: 15.0,
    mean2: 18.0,
    std1: 1.0,
    std2: 1.0,
    correlatedResiduals: true,
    seed: 777,
  });

  const report = StatisticalAnalyzer.analyze(dataset);

  // Residual autocorrelation must be detected
  assert.equal(report.residualDiagnosis.isWhite, false);
  assert.equal(report.residualDiagnosis.diagnosis, "RESIDUAL_AUTOCORRELATED");
  assert.match(report.residualDiagnosis.verdict, /结构欠定/);
  assert.equal(report.allObligationsMet, false);

  // Adapter assessObligation must refute
  const failReceipt = [
    {
      validatorId: "data_residual_whiteness_checker",
      validatorVersion: "1.0",
      subjectHash: "h_white_fail",
      scope: "residuals",
      outcome: "FAIL",
      evidenceRefs: [],
      issuedAt: new Date().toISOString(),
    },
  ];
  const assessment = adapter.assessObligation(failReceipt, {
    obligation: { id: "ob_residual_whiteness", kind: "RESIDUAL_INDEPENDENCE_CHECK", subjectRef: "", scopeRef: "", acceptancePolicyRef: "", state: "OPEN" },
  });
  assert.equal(assessment.newState, "REFUTED");
  assert.match(assessment.rationale, /结构欠定/);
});

test("端到端内核调度复用：通用 AgentLoop 驱动 data_analysis 全流程推断与工件交付", async () => {
  const mockHostPorts = {
    model: {
      requestCompletion: async () => ({
        content: "Welch t-test completed: t=-7.42, df=56.8, p=4.8e-10, Cohen's d=-1.91 (large effect size), 95% CI [-3.05, -1.88].",
        finishReason: "stop",
        usage: { promptTokens: 38, completionTokens: 32, totalTokens: 70 },
      }),
    },
    asset: {
      execute: async (toolName, params) => ({
        callId: "call_stats_001",
        toolName,
        status: "SUCCESS",
        output: {
          tStatistic: -7.42,
          degreesOfFreedom: 56.8,
          pValue: 4.8e-10,
          cohensD: -1.91,
          normalityPassed: true,
          residualWhitenessPassed: true,
        },
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
      runId: "run_stats_case_d_001",
      domainId: DATA_ANALYSIS_ID,
      domainVersion: DATA_ANALYSIS_VERSION,
      inputRefs: ["ref_clinical_trial_data_csv"],
      profileId: "prod",
      createdAt: new Date().toISOString(),
    },
    budget: {
      maxModelCalls: 5,
      maxToolCalls: 5,
      deadlineMonotonicMs: 60000,
    },
    rawInput: { rawText: "对比两组生物医学样本表达量差异并进行 Welch t-test 假设检验与残差诊断" },
  });

  assert.equal(result.runId, "run_stats_case_d_001");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
  assert.equal(result.metrics.modelCalls, 1);
  assert.equal(result.metrics.toolCalls, 1);
  assert.deepEqual(result.unresolvedObligations, []);
  assert.ok(result.artifactRefs.includes("art_initial_derivation"));
});

// =========================================================================
// 共享故障矩阵复用核验 (T01, T06, T08, T18)
// 证明 data_analysis 完全复用通用内核且通过全部领域无关故障用例
// =========================================================================

test("共享故障矩阵复用 T01：空输入/非法输入合约编译与校验严格阻断", async () => {
  const emptyInput = { rawText: "   " };
  const draft = adapter.compileContract(emptyInput);
  const validation = adapter.validateContract(draft, emptyInput);

  assert.equal(validation.valid, false, "T01: Empty input must fail validation");
  assert.ok(validation.errors.length > 0, "T01: Must provide descriptive validation errors");
  assert.match(validation.errors[0], /requires at least one goal/i);

  // Kernel loop execution with invalid input returns FAILED immediately
  const mockHostPorts = {
    model: { requestCompletion: async () => ({ content: "", finishReason: "stop" }) },
    asset: { execute: async () => ({ callId: "c", toolName: "t", status: "SUCCESS", output: null }) },
    clock: { nowMonotonicMs: () => 1000, remainingBudgetMs: () => 50000 },
  };
  const result = await runUniversalAgentLoop({
    domainAdapter: adapter,
    hostPorts: mockHostPorts,
    runSpec: { runId: "run_t01", domainId: DATA_ANALYSIS_ID, domainVersion: "1.0.0", inputRefs: [], profileId: "prod", createdAt: "" },
    budget: { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000 },
    rawInput: emptyInput,
  });

  assert.equal(result.status, "FAILED", "T01: Invalid contract must yield FAILED terminal status");
  assert.equal(result.delivery, "NO_DELIVERABLE", "T01: Must yield NO_DELIVERABLE");
  assert.equal(result.metrics.modelCalls, 0, "T01: Zero model calls dispatched");
});

test("共享故障矩阵复用 T06：根预算耗尽拦截，零预算配额下模型与资产调用零派发", async () => {
  let modelDispatched = false;
  let toolDispatched = false;

  const mockHostPorts = {
    model: {
      requestCompletion: async () => {
        modelDispatched = true;
        return { content: "unauthorized", finishReason: "stop" };
      },
    },
    asset: {
      execute: async (toolName) => {
        toolDispatched = true;
        return { callId: "c_unauth", toolName, status: "SUCCESS", output: null };
      },
    },
    clock: { nowMonotonicMs: () => 1000, remainingBudgetMs: () => 50000 },
  };

  const result = await runUniversalAgentLoop({
    domainAdapter: adapter,
    hostPorts: mockHostPorts,
    runSpec: {
      runId: "run_t06_zero_budget",
      domainId: DATA_ANALYSIS_ID,
      domainVersion: "1.0.0",
      inputRefs: ["ref_data"],
      profileId: "prod",
      createdAt: "",
    },
    budget: {
      maxModelCalls: 0, // Zero budget!
      maxToolCalls: 0,  // Zero budget!
      deadlineMonotonicMs: 60000,
    },
    rawInput: { rawText: "样本统计检验" },
  });

  assert.equal(modelDispatched, false, "T06: Model dispatch must be blocked when quota is 0");
  assert.equal(toolDispatched, false, "T06: Tool dispatch must be blocked when quota is 0");
  assert.equal(result.metrics.modelCalls, 0);
  assert.equal(result.metrics.toolCalls, 0);
  assert.equal(result.status, "FAILED", "T06: Zero candidate deliverable under exhausted budget");
});

test("共享故障矩阵复用 T08：状态转移单调性与研究义务证据闭环守卫", () => {
  // Assessment with empty receipts yields INCONCLUSIVE, not ACCEPTED
  const inconclusive = adapter.assessObligation([], {
    obligation: { id: "ob_normality_homoscedasticity", kind: "STATISTICAL_ASSUMPTION_VALIDITY", subjectRef: "", scopeRef: "", acceptancePolicyRef: "", state: "OPEN" },
  });
  assert.equal(inconclusive.newState, "INCONCLUSIVE", "T08: Without receipts, state cannot advance");

  // Assessment with FAIL receipt yields REFUTED, cannot be silently bypassed
  const failReceipt = [
    {
      validatorId: "data_normality_checker",
      validatorVersion: "1.0",
      subjectHash: "h_f",
      scope: "dist",
      outcome: "FAIL",
      evidenceRefs: [],
      issuedAt: new Date().toISOString(),
    },
  ];
  const refuted = adapter.assessObligation(failReceipt, {
    obligation: { id: "ob_normality_homoscedasticity", kind: "STATISTICAL_ASSUMPTION_VALIDITY", subjectRef: "", scopeRef: "", acceptancePolicyRef: "", state: "OPEN" },
  });
  assert.equal(refuted.newState, "REFUTED", "T08: Failed check must transition to REFUTED");

  // Assessment with valid PASS receipt advances to ACCEPTED_WITHIN_SCOPE
  const passReceipt = [
    {
      validatorId: "data_normality_checker",
      validatorVersion: "1.0",
      subjectHash: "h_p",
      scope: "dist",
      outcome: "PASS",
      evidenceRefs: [],
      issuedAt: new Date().toISOString(),
    },
  ];
  const accepted = adapter.assessObligation(passReceipt, {
    obligation: { id: "ob_normality_homoscedasticity", kind: "STATISTICAL_ASSUMPTION_VALIDITY", subjectRef: "", scopeRef: "", acceptancePolicyRef: "", state: "OPEN" },
  });
  assert.equal(accepted.newState, "ACCEPTED_WITHIN_SCOPE", "T08: Valid receipt advances to ACCEPTED_WITHIN_SCOPE");
});

test("共享故障矩阵复用 T18：Invariant I15 诚实标签守卫与 candidateVerified 伪造拦截", () => {
  // 1. Legitimate candidate with candidateVerified: false passes integrity check
  assert.doesNotThrow(() => {
    assertCandidateIntegrity({ candidateVerified: false });
  }, "T18: Honest candidateVerified: false must pass");

  // 2. Dishonest candidate with candidateVerified: true throws Invariant I15 violation
  assert.throws(
    () => {
      assertCandidateIntegrity({ candidateVerified: true });
    },
    /Invariant I15 violation: candidateVerified must strictly remain false/,
    "T18: Attempting to falsify candidateVerified: true must be rejected"
  );

  // 3. Adapter projectDelivery always carries honest baseline contract
  const delivery = adapter.projectDelivery({
    runSpec: {
      runId: "run_t18",
      domainId: DATA_ANALYSIS_ID,
      domainVersion: DATA_ANALYSIS_VERSION,
      inputRefs: [],
      profileId: "prod",
      createdAt: "",
    },
    goalContract: {
      originalInputRef: "ref_1",
      goals: ["STATISTICAL_INFERENCE"],
      scope: {},
      obligations: [],
      version: 1,
    },
    candidate: {
      candidateId: "cand_t18",
      version: 1,
      claimRefs: [],
      supportRefs: [],
      deliverable: true,
      candidateVerified: false,
    },
    observations: [],
  });

  assert.match(delivery.formattedSummary, /CandidateVerified: false/);
  assert.match(delivery.formattedSummary, /StrictAcceptance: NOT_PERFORMED/);
});
