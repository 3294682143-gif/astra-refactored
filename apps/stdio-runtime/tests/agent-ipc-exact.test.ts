/**
 * G4/PR5 Slice 4c — E17 big-integer / exact-rational IPC fidelity.
 *
 * Numbers beyond `Number.MAX_SAFE_INTEGER` must travel as canonical strings (or
 * an explicit tagged field) so no JS `Number` rounding can occur; the strict
 * scanner refuses a raw unsafe integer token instead of silently rounding it,
 * and the canonical encoding hashes deterministically (cross-language stable).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { detectNonFiniteTokens, detectUnsafeNumbers, p4Hash } from "@astra/protocol";

const BIG = "9007199254740993"; // 2^53 + 1, not representable exactly as a JS Number
const RATIONAL = "1/3";

test("E17: a raw unsafe integer token is refused, never rounded", () => {
  assert.equal(detectUnsafeNumbers(`{"n":${BIG}}`).ok, false); // 2^53 + 1
  assert.equal(detectUnsafeNumbers(`{"n":9007199254740991}`).ok, true); // MAX_SAFE_INTEGER
  assert.equal(detectUnsafeNumbers(`{"n":9007199254740992}`).ok, false); // 2^53
  // A non-finite token is refused too (never coerced to a lossy Number).
  assert.equal(detectNonFiniteTokens(`{"n":NaN}`).ok, false);
});

test("E17: a canonical-string big integer / exact rational survives unchanged", () => {
  const payload = { coefficient: BIG, rational: RATIONAL, scale: { kind: "EXACT_INT", value: BIG } };
  const serialized = JSON.stringify(payload);
  // The exact values survive as strings; JSON.parse never sees a big Number.
  const parsed = JSON.parse(serialized) as { coefficient: string; rational: string };
  assert.equal(parsed.coefficient, BIG);
  assert.equal(parsed.rational, RATIONAL);
  assert.equal(typeof parsed.coefficient, "string");
  // Deterministic, cross-language-stable hash of the canonical encoding.
  const hashA = p4Hash(serialized);
  const hashB = p4Hash(JSON.stringify({ ...payload }));
  assert.equal(hashA, hashB);
  assert.match(hashA, /^[0-9a-f]{64}$/u);
  // A different value hashes differently (no collision by rounding 2^53+1 -> 2^53).
  assert.notEqual(p4Hash(JSON.stringify({ ...payload, coefficient: "9007199254740992" })), hashA);
});
