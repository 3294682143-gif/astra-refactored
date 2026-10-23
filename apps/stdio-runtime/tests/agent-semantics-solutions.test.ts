import { test } from "node:test";
import assert from "node:assert/strict";
import {
  polynomialOf,
  problemRelationPolynomial,
  solutionSetOf,
  sameRationalSet,
  type Poly,
  type Rat,
} from "../src/agent-semantics.js";

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

test("the six gate cases through problemRelationPolynomial", () => {
  const sol = (problem: string) => solutionSetOf(problemRelationPolynomial(problem));
  assert.deepEqual(keys(sol("x/2-1=0")), ["2/1"]); // {2}
  assert.equal(sol("x^2/2-1=0"), null); // {−√2,√2}: real roots not all rational -> undeterminable
  assert.equal(sol("x(x^2-2)=0"), null); // {0} would be incomplete -> undeterminable
  assert.deepEqual(keys(sol("x^2+1=0")), []); // empty real set (distinct from "unsolvable")
  assert.deepEqual(keys(sol("(x-1)^2=0")), ["1/1"]); // repeated root collapses to {1}
  // (x^2-1)/(x-1)=0: the domain exclusion (x≠1) is not representable here, so the
  // relation is undeterminable -> fail closed; the excluded point is never accepted.
  assert.equal(problemRelationPolynomial("(x^2-1)/(x-1)=0"), null);
});

// The answers models actually write in Chinese use Unicode notation: `²³⁴`
// superscript exponents, `⁻¹` for an inverse, `−` U+2212 and `·`/`×` for
// multiplication. The parser must read them as the same polynomial, and it must
// stay strict about everything else.

test("unicode superscript exponents parse as the same polynomial as ^ and **", () => {
  const expected = poly([
    ["t^2", 1],
    ["t", -1],
    ["", 1],
  ]);
  assert.deepEqual(polynomialOf("t²-t+1"), expected);
  assert.deepEqual(polynomialOf("t^2-t+1"), expected);
  assert.deepEqual(polynomialOf("t**2-t+1"), expected);
  assert.deepEqual(polynomialOf("t¹²"), poly([["t^12", 1]]));
  assert.deepEqual(polynomialOf("2x²"), poly([["x^2", 2]]));
  assert.deepEqual(polynomialOf("(x+1)²"), poly([["x^2", 1], ["x", 2], ["", 1]]));
});

test("unicode minus, middle dot and multiplication sign parse like ASCII", () => {
  assert.deepEqual(polynomialOf("x−1"), poly([["x", 1], ["", -1]]));
  assert.deepEqual(polynomialOf("2·x"), poly([["x", 2]]));
  assert.deepEqual(polynomialOf("3×x"), poly([["x", 3]]));
  assert.deepEqual(polynomialOf("t² − t + 1"), poly([["t^2", 1], ["t", -1], ["", 1]]));
});

test("a superscript inverse stays one Laurent monomial or nothing", () => {
  assert.deepEqual(polynomialOf("x⁻¹"), poly([["x^-1", 1]]));
  assert.deepEqual(polynomialOf("x⁻¹·x"), poly([["", 1]]));
  // A non-monomial base cannot be inverted into a polynomial: fail closed.
  assert.equal(polynomialOf("(x+1)⁻¹"), null);
});

test("the unicode notation never weakens the existing guards", () => {
  // Unknown symbols stay unparsable; a lone superscript is not an expression.
  assert.equal(polynomialOf("x@2"), null);
  assert.equal(polynomialOf("²"), null);
  assert.equal(polynomialOf("x⁻"), null);
  // A lone lowercase letter is still one variable, never a number.
  assert.deepEqual(polynomialOf("x"), poly([["x", 1]]));
  // The ASCII `x^-1` form keeps its previous (unparsable) behaviour.
  assert.equal(polynomialOf("x^-1"), null);
});
