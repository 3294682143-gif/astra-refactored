import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractLedger,
  WorkUnitStore,
  CandidateGate,
  runUniversalAgentLoop,
} from "../dist/src/index.js";
import { MathDomainAdapter } from "../../domain-math/dist/src/math-adapter.js";

test("I01: 目标契约变更严格保留原始输入引用并自增版本号", () => {
  const ledger = new ContractLedger(
    {
      originalInputRef: "ref_orig_99",
      goals: ["VALUE"],
      scope: { raw: "x^2=4" },
      obligations: [],
      version: 1,
    },
    { maxModelCalls: 10, maxToolCalls: 5, deadlineMonotonicMs: Date.now() + 10000 }
  );

  ledger.updateContract((curr) => ({
    goals: ["ALL_SOLUTIONS"],
    scope: { ...curr.scope, domain: "real" },
  }));

  assert.equal(ledger.contract.originalInputRef, "ref_orig_99");
  assert.equal(ledger.contract.version, 2);
  assert.deepEqual(ledger.contract.goals, ["ALL_SOLUTIONS"]);
});

test("I02 (T01): 结构合法回答不自动关闭研究义务", () => {
  const ledger = new ContractLedger(
    {
      originalInputRef: "ref_1",
      goals: ["PROOF"],
      scope: {},
      obligations: [
        { id: "ob_1", kind: "PROOF_RIGOR", subjectRef: "s1", scopeRef: "sc1", acceptancePolicyRef: "p1", state: "OPEN" },
      ],
      version: 1,
    },
    { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: Date.now() + 10000 }
  );

  assert.equal(ledger.allObligationsAccepted(), false);
  ledger.recordObligationAssessment("ob_1", "SUPPORTED", "Partial lemma proved");
  assert.equal(ledger.allObligationsAccepted(), false); // Still not accepted within scope
  ledger.recordObligationAssessment("ob_1", "ACCEPTED_WITHIN_SCOPE", "Full receipt valid");
  assert.equal(ledger.allObligationsAccepted(), true);
});

test("I05 & I06 (T18, T19): 根预算耗尽拒绝派发，区分本地未发送与已发送未决", () => {
  const ledger = new ContractLedger(
    { originalInputRef: "r1", goals: ["VALUE"], scope: {}, obligations: [], version: 1 },
    { maxModelCalls: 2, maxToolCalls: 1, deadlineMonotonicMs: 1000 }
  );

  // Dispatch first call
  assert.equal(ledger.canDispatchModelCall(500), true);
  ledger.recordDispatchedModelCall(true);

  // Dispatch second call (timed out without evidence)
  assert.equal(ledger.canDispatchModelCall(600), true);
  ledger.recordDispatchedModelCall(false, true);

  // Third call exceeds budget
  assert.equal(ledger.canDispatchModelCall(700), false);
  assert.equal(ledger.consumption.modelCalls, 2);
  assert.equal(ledger.consumption.rejectedCalls, 1);
  assert.equal(ledger.consumption.unknownOutcomeCalls, 1);
});

test("I09 (T05): 上游产物版本更新，依赖 DAG 级联标记 STALE", () => {
  const store = new WorkUnitStore("run_dag");

  // A -> B -> C
  store.registerArtifact({
    artifactId: "art_A",
    version: 1,
    kind: "data",
    payloadRef: "pA1",
    dependencyRefs: [],
    digest: "dA1",
    isStale: false,
  });

  store.registerArtifact({
    artifactId: "art_B",
    version: 1,
    kind: "model",
    payloadRef: "pB1",
    dependencyRefs: ["art_A"],
    digest: "dB1",
    isStale: false,
  });

  store.registerArtifact({
    artifactId: "art_C",
    version: 1,
    kind: "report",
    payloadRef: "pC1",
    dependencyRefs: ["art_B"],
    digest: "dC1",
    isStale: false,
  });

  assert.equal(store.isArtifactStale("art_B"), false);
  assert.equal(store.isArtifactStale("art_C"), false);

  // Now update upstream art_A to version 2
  store.registerArtifact({
    artifactId: "art_A",
    version: 2,
    kind: "data",
    payloadRef: "pA2",
    dependencyRefs: [],
    digest: "dA2",
    isStale: false,
  });

  // Downstream art_B and art_C must be STALE
  assert.equal(store.isArtifactStale("art_B"), true);
  assert.equal(store.isArtifactStale("art_C"), true);
});

test("T06: 循环依赖任务提案被拒绝", () => {
  const store = new WorkUnitStore("run_cyc");
  assert.throws(
    () => {
      store.addTask({
        taskId: "task_loop",
        goalRefs: [],
        dependencies: ["task_loop"], // self-dependency
        routeId: "r1",
        state: "PENDING",
      });
    },
    { message: /Circular dependency detected/ }
  );
});

test("I04 & I10 (T08, T14): 截断与部分修复被门控拦截，保留父候选", () => {
  const gate = new CandidateGate();

  // Initial candidate
  const initial = {
    candidateId: "cand_root",
    version: 1,
    claimRefs: [],
    supportRefs: [],
    deliverable: true,
    candidateVerified: false,
  };
  const res1 = gate.proposeCandidate(initial, []);
  assert.equal(res1.accepted, true);

  // Review raises 2 challenges
  gate.raiseChallenge({
    challengeId: "ch_domain",
    targetRef: "cand_root",
    issueKind: "MISSING_DOMAIN_BOUNDARY",
    evidenceRefs: ["ev_1"],
    requiredResolution: "Check x != 0",
    state: "OPEN",
  });
  gate.raiseChallenge({
    challengeId: "ch_extrema",
    targetRef: "cand_root",
    issueKind: "UNCHECKED_EXTREMA",
    evidenceRefs: ["ev_2"],
    requiredResolution: "Check f''(x)",
    state: "OPEN",
  });

  // 1. Truncated output proposal rejected (I04)
  const resTrunc = gate.proposeCandidate(
    { candidateId: "cand_trunc", version: 2, claimRefs: [], supportRefs: [], deliverable: true, candidateVerified: false },
    ["ch_domain"],
    true // isTruncatedOrError
  );
  assert.equal(resTrunc.accepted, false);
  assert.match(resTrunc.reason, /Invariant I04/);

  // 2. Partial repair (only resolves ch_domain) rejected (I10)
  const resPartial = gate.proposeCandidate(
    { candidateId: "cand_partial", version: 2, claimRefs: [], supportRefs: [], deliverable: true, candidateVerified: false },
    ["ch_domain"]
  );
  assert.equal(resPartial.accepted, false);
  assert.match(resPartial.reason, /Invariant I10/);
  assert.equal(gate.activeCandidate.candidateId, "cand_root"); // Preserved!

  // 3. Full repair resolves both challenges
  const resFull = gate.proposeCandidate(
    { candidateId: "cand_repaired", version: 2, claimRefs: [], supportRefs: [], deliverable: true, candidateVerified: false },
    ["ch_domain", "ch_extrema"]
  );
  assert.equal(resFull.accepted, true);
  assert.equal(gate.activeCandidate.candidateId, "cand_repaired");
});

test("I11 (T15): 被客观验证否定的候选不得作为回退结果交付", () => {
  const gate = new CandidateGate();
  gate.proposeCandidate(
    { candidateId: "cand_bad", version: 1, claimRefs: [], supportRefs: [], deliverable: true, candidateVerified: false },
    []
  );

  // Receipt fails
  gate.recordRefutation("cand_bad", {
    validatorId: "num_check",
    validatorVersion: "1.0",
    subjectHash: "h1",
    scope: "all",
    outcome: "FAIL",
    evidenceRefs: [],
    issuedAt: new Date().toISOString(),
  });

  assert.equal(gate.isCandidateRefuted("cand_bad"), true);
  assert.equal(gate.activeCandidate, undefined); // Refuted candidate cannot be active
});

test("UniversalAgentLoop 贯通测试（MathDomainAdapter + GenericLoop）", async () => {
  const mathAdapter = new MathDomainAdapter();

  const mockHostPorts = {
    model: {
      requestCompletion: async () => ({
        content: "x = 2",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    },
    asset: {
      execute: async (toolName, params) => ({
        callId: "call_1",
        toolName,
        status: "SUCCESS",
        output: { result: "verified" },
      }),
    },
    clock: {
      nowMonotonicMs: () => 1000,
      remainingBudgetMs: () => 50000,
    },
  };

  const result = await runUniversalAgentLoop({
    domainAdapter: mathAdapter,
    hostPorts: mockHostPorts,
    runSpec: {
      runId: "run_universal_001",
      domainId: "math",
      domainVersion: "1.4.0",
      inputRefs: ["ref_prob_1"],
      profileId: "prod",
      createdAt: new Date().toISOString(),
    },
    budget: {
      maxModelCalls: 5,
      maxToolCalls: 5,
      deadlineMonotonicMs: 60000,
    },
    rawInput: { rawText: "求方程 2x = 4 的解" },
  });

  assert.equal(result.runId, "run_universal_001");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
  assert.equal(result.metrics.modelCalls, 1);
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.artifactRefs.length, 1);
});
