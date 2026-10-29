import assert from "node:assert/strict";
import test from "node:test";
import { assertCandidateIntegrity, isTerminalRunState } from "../dist/src/index.js";

test("assertCandidateIntegrity: 允许 candidateVerified 为 false", () => {
  assert.doesNotThrow(() => {
    assertCandidateIntegrity({ candidateVerified: false });
  });
});

test("assertCandidateIntegrity: 拒绝 candidateVerified 为 true (违背红线 I15)", () => {
  assert.throws(
    () => {
      // @ts-expect-error test illegal state
      assertCandidateIntegrity({ candidateVerified: true });
    },
    { message: /Invariant I15 violation/ }
  );
});

test("isTerminalRunState: 正确识别终态与在途态", () => {
  assert.equal(isTerminalRunState("COMPLETED"), true);
  assert.equal(isTerminalRunState("FAILED"), true);
  assert.equal(isTerminalRunState("CANCELLED"), true);
  assert.equal(isTerminalRunState("RUNNING"), false);
  assert.equal(isTerminalRunState("WAITING"), false);
  assert.equal(isTerminalRunState("QUEUED"), false);
});
