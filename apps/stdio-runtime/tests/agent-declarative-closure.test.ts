import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizePermutationCycles,
  canonicalizePolynomialUpToUnit,
  evaluateDeclarativeClosureContract,
} from "../src/agent-answer-closure.js";
import { extractMathStructuralSignature } from "../src/agent-semantics.js";
import { P4ReviewSession } from "@astra/math-review";
import { p4Target } from "@astra/protocol";

test("canonicalizePermutationCycles rotates and sorts disjoint cycles", () => {
  assert.equal(canonicalizePermutationCycles("(2 6 1)(4 3 5)"), "(1 2 6)(3 5 4)");
  assert.equal(canonicalizePermutationCycles("(1 2 6)(3 5 4)"), "(1 2 6)(3 5 4)");
  assert.equal(canonicalizePermutationCycles("(1)"), "()");
  assert.equal(canonicalizePermutationCycles("()"), "()");
});

test("canonicalizePolynomialUpToUnit normalizes up to +/- t^k", () => {
  assert.equal(canonicalizePolynomialUpToUnit("t^2 - 3*t + 1"), "t^2 - 3*t + 1");
  assert.equal(canonicalizePolynomialUpToUnit("-t + 3 - t^-1"), "t^2 - 3*t + 1");
  assert.equal(canonicalizePolynomialUpToUnit("-t^2 + 3*t - 1"), "t^2 - 3*t + 1");
});

test("compare.algebraic-equivalence.v2 contract evaluates equivalence", () => {
  const match = evaluateDeclarativeClosureContract(
    "compare.algebraic-equivalence.v2",
    "1 + \\sqrt{2}",
    { result: "\\sqrt{2} + 1" },
  );
  assert.equal(match.satisfied, true);

  const mismatch = evaluateDeclarativeClosureContract(
    "compare.algebraic-equivalence.v2",
    "2",
    { result: "3" },
  );
  assert.equal(mismatch.satisfied, false);
  assert.equal(mismatch.defect?.kind, "EXACT_VALUE_MISMATCH");
});

test("compare.polynomial-up-to-unit.v2 contract matches up to unit", () => {
  const match = evaluateDeclarativeClosureContract(
    "compare.polynomial-up-to-unit.v2",
    "-t + 3 - t^-1",
    { normalized_fitting_polynomial: "t^2 - 3*t + 1" },
  );
  assert.equal(match.satisfied, true);

  const mismatch = evaluateDeclarativeClosureContract(
    "compare.polynomial-up-to-unit.v2",
    "t^3",
    { normalized_fitting_polynomial: "t^2 - 3*t + 1" },
  );
  assert.equal(mismatch.satisfied, false);
  assert.equal(mismatch.defect?.kind, "EXACT_VALUE_MISMATCH");
});

test("compare.solution-space-basis.v2 contract validates dimension", () => {
  const match = evaluateDeclarativeClosureContract(
    "compare.solution-space-basis.v2",
    "y = c_1 e^x + c_2 e^{2x}, dimension is 2",
    { basis_dimension: 2 },
  );
  assert.equal(match.satisfied, true);

  const mismatch = evaluateDeclarativeClosureContract(
    "compare.solution-space-basis.v2",
    "dimension is 1",
    { basis_dimension: 2 },
  );
  assert.equal(mismatch.satisfied, false);
  assert.equal(mismatch.defect?.kind, "EXACT_VALUE_MISMATCH");
});

test("compare.permutation-canonical-cycle.v1 contract validates disjoint cycles", () => {
  const match = evaluateDeclarativeClosureContract(
    "compare.permutation-canonical-cycle.v1",
    "(2 6 1)(4 3 5)",
    { canonical_cycles: "(1 2 6)(3 5 4)" },
  );
  assert.equal(match.satisfied, true);

  const mismatch = evaluateDeclarativeClosureContract(
    "compare.permutation-canonical-cycle.v1",
    "(1 2)(3 4)",
    { canonical_cycles: "(1 2 6)(3 5 4)" },
  );
  assert.equal(mismatch.satisfied, false);
  assert.equal(mismatch.defect?.kind, "GROUP_STRUCTURE_MISMATCH");
});

test("compare.measure-normalization.v2 contract rejects negative probabilities and unnormalized measures", () => {
  const neg = evaluateDeclarativeClosureContract(
    "compare.measure-normalization.v2",
    "P(X=1) = -0.5",
    {},
  );
  assert.equal(neg.satisfied, false);
  assert.equal(neg.defect?.kind, "NORMALIZATION");

  const unnorm = evaluateDeclarativeClosureContract(
    "compare.measure-normalization.v2",
    "f(x) = 2x",
    { normalized: false },
  );
  assert.equal(unnorm.satisfied, false);
  assert.equal(unnorm.defect?.kind, "NORMALIZATION");
});

test("compare.option-proposition-truth.v2 rejects refuted option and accepts proved", () => {
  const refuted = evaluateDeclarativeClosureContract(
    "compare.option-proposition-truth.v2",
    "选项 A 正确",
    { status: "REFUTED", witness: [1, 2], refuted_option: "A" },
  );
  assert.equal(refuted.satisfied, false);
  assert.equal(refuted.defect?.kind, "OPTION_VERDICT_CONTRADICTION");

  const proved = evaluateDeclarativeClosureContract(
    "compare.option-proposition-truth.v2",
    "选项 B 正确",
    { status: "PROVED", proved_option: "B" },
  );
  assert.equal(proved.satisfied, true);
});

test("extractMathStructuralSignature extracts 8 dimensional math features", () => {
  const sig1 = extractMathStructuralSignature("已知置换 \\sigma = (1 2 3) \\in S_5，求 \\sigma^{-2}");
  assert.equal(sig1.hasPermutationCycles, true);

  const sig2 = extractMathStructuralSignature("设数列 a_{n+2} = 3 a_{n+1} - 2 a_n，求通解");
  assert.equal(sig2.hasRecurrenceOrMarkovStationary, true);

  const sig3 = extractMathStructuralSignature("求 Alexander 矩阵的行列式与 Laurent 多项式不变量");
  assert.equal(sig3.hasLaurentOrParametricMatrixDet, true);

  const sig4 = extractMathStructuralSignature("设总体 X 服从指数分布，求参数的极大似然估计 MLE");
  assert.equal(sig4.hasStatisticalInference, true);

  const sig5 = extractMathStructuralSignature("考虑单纯复形 K 的欧拉示性数与有限拓扑公理");
  assert.equal(sig5.hasTopologyOrManifoldAxioms, true);
});

test("P4ReviewSession formal certificate lock prevents LLM text override", () => {
  const dummySession = Object.create(P4ReviewSession.prototype) as any;
  dummySession.formalOrExactCertificate = false;

  assert.equal(dummySession.hasFormalOrExactCertificate(), false);
  assert.equal(dummySession.isOverridePermitted("LLM_TEXT_ONLY"), true);
  assert.equal(dummySession.isOverridePermitted(undefined), true);
  assert.equal(dummySession.isOverridePermitted("MACHINE_VERIFIED"), true);

  dummySession.setFormalOrExactCertificate(true);
  assert.equal(dummySession.hasFormalOrExactCertificate(), true);
  assert.equal(dummySession.isOverridePermitted("LLM_TEXT_ONLY"), false);
  assert.equal(dummySession.isOverridePermitted(undefined), false);
  assert.equal(dummySession.isOverridePermitted("MACHINE_VERIFIED"), true);
});
