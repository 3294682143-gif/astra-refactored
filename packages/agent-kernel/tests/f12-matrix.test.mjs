// packages/agent-kernel/tests/f12-matrix.test.mjs
// F-12 测试矩阵补齐：T03 身份绑定 / T19 NOT_DISPATCHED / T20 OUTCOME_UNKNOWN /
// T33 新域零核心改动注册 / T38 内核版本在途不变。
import assert from "node:assert/strict";
import test from "node:test";

import { ContractLedger, KERNEL_VERSION } from "../dist/src/ledger.js";
import { WorkUnitStore } from "../dist/src/workunit-store.js";
import { runUniversalAgentLoop } from "../dist/src/generic-loop.js";

function makeContract() {
  return {
    originalInputRef: "input_0",
    goals: ["g1"],
    scope: {},
    obligations: [{ id: "ob_1", kind: "CANDIDATE_VALIDITY", subjectRef: "s", scopeRef: "sc", acceptancePolicyRef: "p", state: "OPEN" }],
    version: 1,
  };
}

function makeBudget(overrides = {}) {
  return { maxModelCalls: 2, maxToolCalls: 2, deadlineMonotonicMs: 10_000, ...overrides };
}

function makeArtifact(overrides = {}) {
  return {
    artifactId: "art_1",
    version: 1,
    kind: "tool_receipt",
    payloadRef: "ref_1",
    dependencyRefs: [],
    digest: "d1",
    isStale: false,
    ...overrides,
  };
}

test("T03: 同一工具回执（artifact）携带他 run 身份注册时必须被拒绝", () => {
  const storeA = new WorkUnitStore("run_A");
  const foreign = makeArtifact({ artifactId: "art_foreign", runId: "run_B" });
  assert.throws(() => storeA.registerArtifact(foreign), /belongs to run run_B.*T03 identity binding/);
  // 同 run 与不携带身份（向后兼容）均可注册
  storeA.registerArtifact(makeArtifact({ artifactId: "art_own", runId: "run_A" }));
  storeA.registerArtifact(makeArtifact({ artifactId: "art_legacy" }));
  assert.equal(storeA.artifacts.length, 2);
});

test("T19: 根预算耗尽后本地准入拒绝，标记 NOT_DISPATCHED（rejectedCalls 递增、不重置预算）", () => {
  const ledger = new ContractLedger(makeContract(), makeBudget({ maxModelCalls: 1 }));
  assert.equal(ledger.canDispatchModelCall(100), true);
  ledger.recordDispatchedModelCall(true);
  assert.equal(ledger.canDispatchModelCall(101), false);
  assert.equal(ledger.canDispatchModelCall(102), false);
  assert.equal(ledger.consumption.rejectedCalls, 2);
  assert.equal(ledger.consumption.modelCalls, 1); // 拒绝不重置也不占用
});

test("T19b: 超过 deadline 的派发被本地拒绝（不发送即记账 NOT_DISPATCHED）", () => {
  const ledger = new ContractLedger(makeContract(), makeBudget({ deadlineMonotonicMs: 500 }));
  assert.equal(ledger.canDispatchModelCall(501), false);
  assert.equal(ledger.consumption.rejectedCalls, 1);
  assert.equal(ledger.consumption.modelCalls, 0);
});

test("T20: 已发送请求超时且无远端状态证据，记 OUTCOME_UNKNOWN 并停止后续语义", () => {
  const ledger = new ContractLedger(makeContract(), makeBudget());
  ledger.recordDispatchedModelCall(false, true);
  assert.equal(ledger.consumption.unknownOutcomeCalls, 1);
  assert.equal(ledger.consumption.modelCalls, 1); // 已派发计入预算，但结果未知
});

test("T33: 新领域仅凭 DomainAdapter 接口注册即可由同一内核调度（核心零改动）", async () => {
  // inline 最小 dummy 域：不修改 kernel 任何文件，只实现接口。
  const calls = { compile: 0, assess: 0, project: 0 };
  const dummyAdapter = {
    domainId: "dummy.mech",
    compileContract(input) {
      calls.compile++;
      return {
        goals: ["dummy goal"],
        scope: {},
        proposedObligations: [{ id: "ob_dummy", kind: "CANDIDATE_VALIDITY" }],
      };
    },
    validateContract: () => ({ valid: true, errors: [] }),
    buildWorkContext: () => ({ systemPromptSegment: "dummy sys", availableTools: [] }),
    interpretObservation: () => [],
    proposeChecks: () => [],
    assessObligation() {
      calls.assess++;
      return { newState: "ACCEPTED_WITHIN_SCOPE", rationale: "dummy pass" };
    },
    projectDelivery() {
      calls.project++;
      return { deliveryState: "CANDIDATE_AVAILABLE", payload: { ok: true } };
    },
  };
  const hostPorts = {
    model: { requestCompletion: async () => ({ content: "ok", finishReason: "stop", usage: {} }) },
    asset: { execute: async () => ({ callId: "c0", toolName: "none", status: "SUCCESS", output: null }) },
    clock: { nowMonotonicMs: () => 100 },
  };
  const result = await runUniversalAgentLoop({
    domainAdapter: dummyAdapter,
    hostPorts,
    runSpec: { runId: "run_dummy", inputRefs: ["in_1"] },
    budget: makeBudget(),
    rawInput: { rawText: "dummy task" },
  });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
  assert.equal(calls.compile, 1);
  assert.equal(calls.project, 1);
  assert.deepEqual(result.unresolvedObligations, []);
});

test("T38: 内核发行版切换后，在途账本保持创建时版本，新任务显式采用新版本", () => {
  const inFlight = new ContractLedger(makeContract(), makeBudget(), "1.0.0");
  // 模拟内核升级后创建的新账本
  const nextGen = new ContractLedger(makeContract(), makeBudget(), "2.0.0");
  assert.equal(inFlight.kernelVersion, "1.0.0");
  assert.equal(nextGen.kernelVersion, "2.0.0");
  // 在途任务继续演进（义务状态变化）不改变其内核版本
  inFlight.recordObligationAssessment("ob_1", "ACCEPTED_WITHIN_SCOPE");
  assert.equal(inFlight.kernelVersion, "1.0.0");
  // 默认构造对齐当前 KERNEL_VERSION 常量
  const defaulted = new ContractLedger(makeContract(), makeBudget());
  assert.equal(defaulted.kernelVersion, KERNEL_VERSION);
});
