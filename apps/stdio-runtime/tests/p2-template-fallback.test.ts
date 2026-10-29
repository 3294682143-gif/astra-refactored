/**
 * G3/PR4 §6.1 matrix row E13 — the fixed-template fallback.
 *
 * When a problem cannot be classified into a richer goal kind, the conservative
 * M1 template compiles it to a fixed `UNKNOWN` goal whose single answer
 * obligation is `ANSWER_REQUEST`. The template is deterministic: the same
 * problem compiles to the same goals/obligations/tasks, so an R0 planning review
 * that does not certify a bounded revision falls back to this fixed template and
 * continues under the same root budget — it never claims extra planning budget
 * and never loops.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileP2Contract } from "@astra/math-contract";

const UNCLASSIFIED = "Solve the equation x^2=4";

test("E13 fallback: an unclassifiable problem uses the fixed deterministic template", () => {
  const first = compileP2Contract(UNCLASSIFIED, "e13-fallback");
  const second = compileP2Contract(UNCLASSIFIED, "e13-fallback");

  // The conservative template leaves the goal UNKNOWN.
  assert.equal(first.goals[0]?.kind, "UNKNOWN");
  // The single answer obligation of an UNKNOWN goal is ANSWER_REQUEST.
  assert.ok(first.obligations.some((row) => row.kind === "ANSWER_REQUEST"));
  // Deterministic fixed template: same goals, obligations and tasks on replay.
  assert.deepEqual(first.goals, second.goals);
  assert.deepEqual(first.obligations, second.obligations);
  assert.deepEqual(first.tasks, second.tasks);
  // The bounded template never explodes into unbounded planning tasks.
  assert.ok(first.tasks.length >= 1 && first.tasks.length <= 5);
});
