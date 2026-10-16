import { test } from "node:test";
import assert from "node:assert/strict";
import { solutionSetOf, sameRationalSet, type Poly, type Rat } from "../src/agent-semantics.js";

function poly(terms: ReadonlyArray<readonly [string, number]>): Poly {
  return new Map(terms);
}

function keys(values: readonly Rat[] | null): readonly string[] | null {
  return values === null ? null : values.map((value) => `${value.n}/${value.d}`).sort();
}

// §3 exact / negative cases: the completeness oracle must return the WHOLE real
// solution set, or null when the real roots are not all rational. A rational-root
// enumeration alone is never proof of the whole real set.

test("x-2=0 -> exact rational set {2}", () => {
  assert.deepEqual(keys(solutionSetOf(poly([["x", 1], ["", -2]]))), ["2/1"]);
});

test("x^2-2=0 -> null (roots are +/- sqrt(2), not rational)", () => {
  assert.equal(solutionSetOf(poly([["x^2", 1], ["", -2]])), null);
});

test("x(x^2-2)=x^3-2x=0 -> null (0 is rational but +/- sqrt(2) are not)", () => {
  assert.equal(solutionSetOf(poly([["x^3", 1], ["x", -2]])), null);
});

test("x^2+1=0 -> empty set (no real roots), never 'cannot determine'", () => {
  assert.deepEqual(keys(solutionSetOf(poly([["x^2", 1], ["", 1]]))), []);
});

test("(x-1)^2=0 -> {1} (repeated root collapses to one element)", () => {
  assert.deepEqual(keys(solutionSetOf(poly([["x^2", 1], ["x", -2], ["", 1]]))), ["1/1"]);
});

test("x^2-1=0 -> {-1,1} (residual constant: all real roots rational)", () => {
  assert.deepEqual(keys(solutionSetOf(poly([["x^2", 1], ["", -1]]))), ["-1/1", "1/1"]);
});

test("x(x-1)=x^2-x=0 -> {0,1}", () => {
  assert.deepEqual(keys(solutionSetOf(poly([["x^2", 1], ["x", -1]]))), ["0/1", "1/1"]);
});

test("x^4-1=0 -> {-1,1} (residual x^2+1 has no real root)", () => {
  assert.deepEqual(keys(solutionSetOf(poly([["x^4", 1], ["", -1]]))), ["-1/1", "1/1"]);
});

test("x^4-2=0 -> null (real roots +/- 2^(1/4) are irrational)", () => {
  assert.equal(solutionSetOf(poly([["x^4", 1], ["", -2]])), null);
});

test("multi-variable / zero polynomial -> null", () => {
  assert.equal(solutionSetOf(poly([["x*y", 1], ["", -1]])), null);
  assert.equal(solutionSetOf(poly([])), null);
});

test("sameRationalSet is exact and treats null as never equal", () => {
  assert.equal(sameRationalSet(null, null), false);
  assert.equal(sameRationalSet([], []), true);
});
