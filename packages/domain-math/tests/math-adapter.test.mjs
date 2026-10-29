import assert from "node:assert/strict";
import test from "node:test";
import { MathDomainAdapter } from "../dist/src/math-adapter.js";

const adapter = new MathDomainAdapter();

test("compileContract: 自动识别证明题与普通计算题目标", () => {
  const proofContract = adapter.compileContract({ rawText: "请证明对所有素数 p > 2，p^2 - 1 能被 24 整除" });
  assert.deepEqual(proofContract.goals, ["PROOF"]);
  assert.equal(proofContract.proposedObligations.length, 4);

  const valueContract = adapter.compileContract({ rawText: "求方程 x^2 - 5x + 6 = 0 的值" });
  assert.deepEqual(valueContract.goals, ["VALUE"]);
});

test("proposeChecks: 为数学候选生成代数求值与边界校验规范", () => {
  const checks = adapter.proposeChecks({
    candidateId: "cand_1",
    rawContent: { value: 42 },
    artifacts: [],
  });
  assert.equal(checks.length, 2);
  assert.equal(checks[0].validatorId, "math_algebraic_evaluator");
  assert.equal(checks[1].validatorId, "math_boundary_verifier");
});

test("interpretObservation: 成功与失败观察精准归约", () => {
  const okEvidence = adapter.interpretObservation({
    callId: "c1",
    toolName: "math.linear-algebra",
    status: "SUCCESS",
    output: { rank: 2 },
  });
  assert.equal(okEvidence[0].verified, true);
  assert.equal(okEvidence[0].scope, "EXACT_NUMERICAL_COMPUTATION");

  const errEvidence = adapter.interpretObservation({
    callId: "c2",
    toolName: "math.linear-algebra",
    status: "ERROR",
    output: null,
    errorSnippet: "Matrix is singular",
  });
  assert.equal(errEvidence[0].verified, false);
  assert.equal(errEvidence[0].scope, "TOOL_ERROR");
});

test("compareCandidates: 精确等价性与差异识别", () => {
  const compSame = adapter.compareCandidates(
    { candidateId: "c1", rawContent: { ans: "1/2" }, artifacts: [] },
    { candidateId: "c2", rawContent: { ans: "1/2" }, artifacts: [] }
  );
  assert.equal(compSame.result, "EQUIVALENT");

  const compDiff = adapter.compareCandidates(
    { candidateId: "c1", rawContent: { ans: "1/2" }, artifacts: [] },
    { candidateId: "c2", rawContent: { ans: "1/3" }, artifacts: [] }
  );
  assert.equal(compDiff.result, "DIFFERENT");
});

test("projectDelivery: 格式化 CERT1 证书并严格保证 candidateVerified 为 false", () => {
  const delivery = adapter.projectDelivery({
    runSpec: {
      runId: "run_math_100",
      domainId: "math",
      domainVersion: "1.4.0",
      inputRefs: ["ref_p1"],
      profileId: "prod",
      createdAt: "2026-10-29T20:00:00Z",
    },
    goalContract: {
      originalInputRef: "ref_p1",
      goals: ["VALUE"],
      scope: {},
      obligations: [],
      version: 1,
    },
    candidate: {
      candidateId: "cand_99",
      version: 1,
      claimRefs: [],
      supportRefs: [],
      deliverable: true,
      candidateVerified: false,
    },
    observations: [],
  });

  assert.equal(delivery.deliveryState, "CANDIDATE_AVAILABLE");
  assert.match(delivery.formattedSummary, /CERT1 MATHEMATICAL AUDIT CERTIFICATE/);
  assert.match(delivery.formattedSummary, /CandidateVerified: false/);
  assert.equal(delivery.exportedFiles[0].name, "CERT1.txt");
});
