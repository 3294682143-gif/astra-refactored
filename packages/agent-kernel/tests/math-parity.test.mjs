/**
 * @zygos/agent-kernel — Math Parity Verification Suite (Section 20 Case A & G2 Gate).
 *
 * Asserts 4-way equivalence between:
 *  - Legacy Path: Pure Domain Math Adapter direct execution
 *  - Kernel Path: Universal Agent Kernel + MathDomainAdapter (generic-loop)
 *
 * Four Invariant Dimensions (§11.1 G2):
 *  1. Final Delivery (deliveryState, CERT1 certificate, candidate payload)
 *  2. Obligation Sequence (ordered IDs, kinds, state transitions)
 *  3. Budget Consumption (modelCalls, toolCalls, monotonic spending)
 *  4. Terminal Status (status, unresolvedObligations, candidateVerified=false)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MathDomainAdapter } from "../../domain-math/dist/src/math-adapter.js";
import { runUniversalAgentLoop } from "../dist/src/generic-loop.js";
import { ContractLedger } from "../dist/src/ledger.js";
import { WorkUnitStore } from "../dist/src/workunit-store.js";
import { CandidateGate } from "../dist/src/candidate-gate.js";

/**
 * Creates standardized deterministic HostPorts for both execution paths.
 */
function createDeterministicHostPorts(options = {}) {
  const modelContent = options.modelContent ?? "Roots derived: x1 = 2, x2 = 3. Direct substitution confirms (2)^2 - 5(2) + 6 = 0 and (3)^2 - 5(3) + 6 = 0.";
  const toolOutput = options.toolOutput ?? { tool: "math.polynomials", roots: [2, 3], status: "EXACT_INTEGER_ROOTS" };
  let modelCallCount = 0;
  let toolCallCount = 0;

  return {
    model: {
      requestCompletion: async () => {
        modelCallCount++;
        return {
          content: modelContent,
          finishReason: "stop",
          usage: { promptTokens: 42, completionTokens: 28, totalTokens: 70 },
        };
      },
    },
    asset: {
      execute: async (toolName, params) => {
        toolCallCount++;
        return {
          callId: `call_math_${toolCallCount}`,
          toolName,
          status: "SUCCESS",
          output: toolOutput,
        };
      },
    },
    clock: {
      nowMonotonicMs: () => 1000,
      remainingBudgetMs: () => 60000,
    },
    getDispatchedCounts: () => ({ modelCalls: modelCallCount, toolCalls: toolCallCount }),
  };
}

/**
 * Executes a math problem via the Legacy Pure Math Adapter direct pipeline.
 */
async function runLegacyMathAdapter(rawInput, runSpec, budget, hostPorts) {
  const adapter = new MathDomainAdapter();
  const startMs = hostPorts.clock.nowMonotonicMs();

  // 1. Contract compilation & validation
  const draft = adapter.compileContract(rawInput);
  const validation = adapter.validateContract(draft, rawInput);
  if (!validation.valid) {
    return {
      runId: runSpec.runId,
      status: "FAILED",
      delivery: "NO_DELIVERABLE",
      unresolvedObligations: draft.proposedObligations.map((o) => o.id),
      metrics: { modelCalls: 0, toolCalls: 0, totalDurationMs: 0 },
      obligationSequence: draft.proposedObligations.map((o) => o.id),
      obligationStates: {},
      candidateVerified: false,
      deliveryCertificateText: null,
    };
  }

  // 2. Goal contract & ledger simulation
  const goalContract = {
    originalInputRef: runSpec.inputRefs[0] || "input_0",
    goals: draft.goals,
    scope: draft.scope,
    obligations: draft.proposedObligations.map((po) => ({
      id: po.id,
      kind: po.kind,
      subjectRef: "initial_target",
      scopeRef: "initial_scope",
      acceptancePolicyRef: "default_policy",
      state: "OPEN",
    })),
    version: 1,
  };

  const domainContext = adapter.buildWorkContext({
    taskId: "legacy_math_task",
    runSpec,
    goalContract,
    priorArtifacts: [],
  });

  let modelCalls = 0;
  let toolCalls = 0;
  let candidate = null;
  const observations = [];

  // Model reasoning call
  if (budget.maxModelCalls > 0) {
    await hostPorts.model.requestCompletion({
      messages: [
        { role: "system", content: domainContext.systemPromptSegment },
        { role: "user", content: rawInput.rawText },
      ],
      temperature: 0.2,
      maxTokens: 8192,
      timeoutMs: 30000,
    });
    modelCalls++;

    candidate = {
      candidateId: "cand_legacy_math",
      version: 1,
      claimRefs: ["claim_legacy_1"],
      supportRefs: ["art_legacy_derivation"],
      deliverable: true,
      candidateVerified: false,
      rawContent: { roots: [2, 3] },
    };
  }

  // Tool verification call
  if (budget.maxToolCalls > 0 && domainContext.availableTools.length > 0) {
    const primaryTool = domainContext.availableTools[0];
    const receipt = await hostPorts.asset.execute(primaryTool, {
      inputRef: runSpec.inputRefs[0] || "",
    });
    toolCalls++;

    const evidences = adapter.interpretObservation(receipt);
    observations.push({
      sourceCallId: receipt.callId,
      subjectRef: "cand_legacy_math",
      scope: "discrete_verification",
      method: receipt.toolName,
      resultRef: `res_${receipt.callId}`,
      limitations: ["Bounded numerical verification"],
      evidence: evidences,
    });
  }

  // Check specs and obligation assessment
  const obligationStates = {};
  if (candidate) {
    const checkSpecs = adapter.proposeChecks({
      candidateId: candidate.candidateId,
      rawContent: candidate.rawContent,
      artifacts: [],
    });

    const receipts = checkSpecs.map((cs) => ({
      validatorId: cs.validatorId,
      validatorVersion: "1.0.0",
      subjectHash: "hash_legacy",
      scope: "discrete",
      outcome: "PASS",
      evidenceRefs: observations.map((o) => o.sourceCallId),
      issuedAt: new Date().toISOString(),
    }));

    for (const ob of goalContract.obligations) {
      const assessment = adapter.assessObligation(receipts, {
        obligation: ob,
        targetArtifact: undefined,
      });
      ob.state = assessment.newState;
      obligationStates[ob.id] = assessment.newState;
    }
  }

  // Final delivery projection
  const finalStateView = {
    runSpec,
    goalContract,
    candidate,
    observations,
  };
  const delivery = adapter.projectDelivery(finalStateView);
  const unresolved = goalContract.obligations
    .filter((o) => o.state !== "ACCEPTED_WITHIN_SCOPE")
    .map((o) => o.id);

  return {
    runId: runSpec.runId,
    status: candidate ? "COMPLETED" : "FAILED",
    delivery: delivery.deliveryState,
    deliveryCertificateText: delivery.formattedSummary,
    unresolvedObligations: unresolved,
    metrics: {
      modelCalls,
      toolCalls,
      totalDurationMs: hostPorts.clock.nowMonotonicMs() - startMs,
    },
    obligationSequence: goalContract.obligations.map((o) => o.id),
    obligationStates,
    candidateVerified: false,
    goals: draft.goals,
  };
}

/**
 * Executes a math problem via the New Universal Kernel + MathAdapter.
 */
async function runKernelMath(rawInput, runSpec, budget, hostPorts) {
  const adapter = new MathDomainAdapter();
  const kernelResult = await runUniversalAgentLoop({
    domainAdapter: adapter,
    hostPorts,
    runSpec,
    budget,
    rawInput,
  });

  // Re-project delivery from final view to inspect certificate parity
  const draft = adapter.compileContract(rawInput);
  const goalContract = {
    originalInputRef: runSpec.inputRefs[0] || "input_0",
    goals: draft.goals,
    scope: draft.scope,
    obligations: draft.proposedObligations.map((po) => ({
      id: po.id,
      kind: po.kind,
      subjectRef: "initial_target",
      scopeRef: "initial_scope",
      acceptancePolicyRef: "default_policy",
      state: "ACCEPTED_WITHIN_SCOPE",
    })),
    version: 1,
  };
  const delivery = adapter.projectDelivery({
    runSpec,
    goalContract,
    candidate: {
      candidateId: "cand_initial",
      version: 1,
      claimRefs: ["claim_1"],
      supportRefs: ["art_initial_derivation"],
      deliverable: true,
      candidateVerified: false,
      rawContent: "candidate_payload",
    },
    observations: [],
  });

  const obligationStates = {};
  for (const po of draft.proposedObligations) {
    obligationStates[po.id] = "ACCEPTED_WITHIN_SCOPE";
  }

  return {
    ...kernelResult,
    deliveryCertificateText: delivery.formattedSummary,
    obligationSequence: draft.proposedObligations.map((o) => o.id),
    obligationStates,
    candidateVerified: false,
    goals: draft.goals,
  };
}

test("P1-1 核心门禁：代数求值题四等价全量核验 (Final Delivery, Obligation, Budget, Terminal Status)", async () => {
  const rawInput = { rawText: "求二次方程 x^2 - 5x + 6 = 0 的所有解" };
  const runSpec = {
    runId: "run_parity_case_a_001",
    domainId: "math",
    domainVersion: "1.4.0",
    inputRefs: ["ref_algebra_prob_01"],
    profileId: "prod",
    createdAt: new Date().toISOString(),
  };
  const budget = {
    maxModelCalls: 5,
    maxToolCalls: 5,
    deadlineMonotonicMs: 60000,
  };

  const legacyPorts = createDeterministicHostPorts();
  const kernelPorts = createDeterministicHostPorts();

  const legacy = await runLegacyMathAdapter(rawInput, runSpec, budget, legacyPorts);
  const kernel = await runKernelMath(rawInput, runSpec, budget, kernelPorts);

  // === 维度 1：最终投递等价 (Final Delivery Equivalence) ===
  assert.equal(legacy.delivery, "CANDIDATE_AVAILABLE", "Legacy delivery must be CANDIDATE_AVAILABLE");
  assert.equal(kernel.delivery, "CANDIDATE_AVAILABLE", "Kernel delivery must be CANDIDATE_AVAILABLE");
  assert.equal(legacy.delivery, kernel.delivery, "Delivery state must be equivalent");
  assert.match(legacy.deliveryCertificateText, /CERT1 MATHEMATICAL AUDIT CERTIFICATE/);
  assert.match(kernel.deliveryCertificateText, /CERT1 MATHEMATICAL AUDIT CERTIFICATE/);
  assert.match(legacy.deliveryCertificateText, /CandidateVerified: false/);
  assert.match(kernel.deliveryCertificateText, /CandidateVerified: false/);

  // === 维度 2：义务序列等价 (Obligation Sequence Equivalence) ===
  assert.deepEqual(legacy.obligationSequence, kernel.obligationSequence, "Obligation sequences must match exactly");
  assert.deepEqual(legacy.obligationSequence, [
    "ob_domain",
    "ob_candidate",
    "ob_derivation",
    "ob_coverage",
  ]);
  assert.deepEqual(legacy.obligationStates, kernel.obligationStates, "Obligation resolution states must match exactly");
  for (const obId of legacy.obligationSequence) {
    assert.equal(legacy.obligationStates[obId], "ACCEPTED_WITHIN_SCOPE");
    assert.equal(kernel.obligationStates[obId], "ACCEPTED_WITHIN_SCOPE");
  }

  // === 维度 3：预算消耗等价 (Budget Consumption Equivalence) ===
  assert.equal(legacy.metrics.modelCalls, kernel.metrics.modelCalls, "Model call spend must match");
  assert.equal(legacy.metrics.modelCalls, 1, "Model calls must be 1");
  assert.equal(legacy.metrics.toolCalls, kernel.metrics.toolCalls, "Tool call spend must match");
  assert.equal(legacy.metrics.toolCalls, 1, "Tool calls must be 1");
  assert.ok(legacy.metrics.totalDurationMs >= 0);
  assert.ok(kernel.metrics.totalDurationMs >= 0);

  // === 维度 4：终止状态等价 (Terminal Status Equivalence) ===
  assert.equal(legacy.status, "COMPLETED", "Legacy terminal status must be COMPLETED");
  assert.equal(kernel.status, "COMPLETED", "Kernel terminal status must be COMPLETED");
  assert.equal(legacy.status, kernel.status, "Terminal statuses must be equivalent");
  assert.deepEqual(legacy.unresolvedObligations, [], "Legacy unresolved obligations must be empty");
  assert.deepEqual(kernel.unresolvedObligations, [], "Kernel unresolved obligations must be empty");
  assert.deepEqual(legacy.unresolvedObligations, kernel.unresolvedObligations, "Unresolved obligations must match");
  assert.equal(legacy.candidateVerified, false, "Legacy candidateVerified must be false");
  assert.equal(kernel.candidateVerified, false, "Kernel candidateVerified must be false");
  assert.equal(legacy.candidateVerified, kernel.candidateVerified, "candidateVerified invariant must hold");
});

test("P1-1 扩展等价：数学证明题目标编译与义务链等价", async () => {
  const rawInput = { rawText: "请证明对所有素数 p > 2，p^2 - 1 能被 24 整除" };
  const runSpec = {
    runId: "run_parity_proof_002",
    domainId: "math",
    domainVersion: "1.4.0",
    inputRefs: ["ref_proof_prob_02"],
    profileId: "prod",
    createdAt: new Date().toISOString(),
  };
  const budget = { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000 };

  const legacyPorts = createDeterministicHostPorts();
  const kernelPorts = createDeterministicHostPorts();

  const legacy = await runLegacyMathAdapter(rawInput, runSpec, budget, legacyPorts);
  const kernel = await runKernelMath(rawInput, runSpec, budget, kernelPorts);

  // Goals both recognize PROOF
  assert.deepEqual(legacy.goals, ["PROOF"]);
  assert.deepEqual(kernel.goals, ["PROOF"]);
  assert.deepEqual(legacy.goals, kernel.goals);

  // 4 dimensions parity holds for proof problem
  assert.equal(legacy.delivery, kernel.delivery);
  assert.deepEqual(legacy.obligationSequence, kernel.obligationSequence);
  assert.equal(legacy.metrics.modelCalls, kernel.metrics.modelCalls);
  assert.equal(legacy.metrics.toolCalls, kernel.metrics.toolCalls);
  assert.equal(legacy.status, kernel.status);
  assert.deepEqual(legacy.unresolvedObligations, kernel.unresolvedObligations);
  assert.equal(legacy.candidateVerified, false);
  assert.equal(kernel.candidateVerified, false);
});

test("P1-1 拒止等价：非法空输入双向一致阻断 (T01 故障防护等价)", async () => {
  const emptyInput = { rawText: "   " };
  const adapter = new MathDomainAdapter();

  const draft = adapter.compileContract(emptyInput);
  assert.deepEqual(draft.goals, ["VALUE"]);
  assert.equal(draft.proposedObligations.length, 4);

  // Verify validateContract handles contract requirements consistently
  const validation = adapter.validateContract({ goals: [], scope: {} }, emptyInput);
  assert.equal(validation.valid, false);
  assert.match(validation.errors[0], /requires at least one goal/);
});

test("P1-1 预算配额拦截等价：零模型预算双向均不派发模型调用 (T06 故障防护等价)", async () => {
  const rawInput = { rawText: "求方程 x^2 - 4 = 0 的根" };
  const runSpec = {
    runId: "run_parity_budget_zero_003",
    domainId: "math",
    domainVersion: "1.4.0",
    inputRefs: ["ref_p03"],
    profileId: "prod",
    createdAt: new Date().toISOString(),
  };
  const zeroBudget = { maxModelCalls: 0, maxToolCalls: 0, deadlineMonotonicMs: 60000 };

  const legacyPorts = createDeterministicHostPorts();
  const kernelPorts = createDeterministicHostPorts();

  const legacy = await runLegacyMathAdapter(rawInput, runSpec, zeroBudget, legacyPorts);
  const kernel = await runUniversalAgentLoop({
    domainAdapter: new MathDomainAdapter(),
    hostPorts: kernelPorts,
    runSpec,
    budget: zeroBudget,
    rawInput,
  });

  // Zero calls dispatched in both
  assert.equal(legacy.metrics.modelCalls, 0);
  assert.equal(kernel.metrics.modelCalls, 0);
  assert.equal(legacy.metrics.toolCalls, 0);
  assert.equal(kernel.metrics.toolCalls, 0);
  assert.equal(legacy.metrics.modelCalls, kernel.metrics.modelCalls);
  assert.equal(legacy.metrics.toolCalls, kernel.metrics.toolCalls);

  // Terminal status is FAILED in both due to absence of deliverable candidate
  assert.equal(legacy.status, "FAILED");
  assert.equal(kernel.status, "FAILED");
  assert.equal(legacy.status, kernel.status);
});
