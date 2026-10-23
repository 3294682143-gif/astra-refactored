/**
 * Method/tool fusion: a hit tool route names the `general_v11` card that owns
 * that mathematical family, so `semanticMethodRoute` ranks that card first.
 * Everything else about the scoring, the bound and the tie-break is unchanged,
 * and a problem with no tool route keeps its previous list exactly.
 *
 * The entries below are the metadata the catalog exposes (id plus `objects`
 * and `structures` tokens only): the router never reads a method body, an item
 * index, a reference answer or any hidden table.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { P2MethodEntry } from "@astra/protocol";
import {
  preferredMethodForToolRoute,
  semanticMethodRoute,
  semanticToolRoute,
} from "../src/agent-semantics.js";

function entry(
  id: string,
  objects: readonly string[],
  structures: readonly string[],
): P2MethodEntry {
  return { id, title: id, objects, structures };
}

/** The 20 `general_v11` cards, metadata only. */
const CATALOG: readonly P2MethodEntry[] = Object.freeze([
  entry("domain-equivalence", ["equation", "rational_expression", "radical", "parameter"], [
    "domain",
    "equivalence",
    "degeneracy",
  ]),
  entry("proof-counterexamples", ["statement", "set", "function", "sequence"], [
    "quantifier",
    "necessity",
    "sufficiency",
    "counterexample",
  ]),
  entry("invariants-extremal", ["configuration", "game", "integer", "graph"], [
    "invariant",
    "parity",
    "potential",
    "extremal",
  ]),
  entry("induction-recurrence", ["sequence", "integer", "recursive_object"], [
    "induction",
    "recurrence",
    "well_founded",
  ]),
  entry("finite-state-dp", ["sequence", "graph", "finite_state"], [
    "dynamic_programming",
    "automaton",
    "residue_tracking",
  ]),
  entry("counting-bijections", ["set", "combinatorial_object", "sample_space"], [
    "bijection",
    "double_counting",
    "inclusion_exclusion",
  ]),
  entry("generating-functions", ["sequence", "polynomial", "formal_series"], [
    "generating_function",
    "convolution",
    "recurrence",
  ]),
  entry("modular-crt", ["integer", "congruence"], [
    "modular_constraints",
    "prime_power",
    "residue_tracking",
  ]),
  entry("integral-symmetry", ["integral", "function", "region"], [
    "symmetry",
    "substitution",
    "improper_integral",
  ]),
  entry(
    "coordinates-geometry",
    ["point", "line", "plane", "curve", "geometric_configuration"],
    ["coordinates", "metric", "incidence", "symmetry"],
  ),
  entry("inequalities-optimization", ["function", "inequality", "feasible_set"], [
    "convexity",
    "monotonicity",
    "bound",
    "equality_case",
  ]),
  entry("linearization-spectral", [
    "matrix",
    "linear_system",
    "linear_map",
    "quadratic_form",
  ], ["rank", "nullspace", "eigenvalue", "change_of_basis"]),
  entry("conditioning-indicators", [
    "random_variable",
    "sample_space",
    "event",
    "distribution",
  ], ["conditional_probability", "indicator", "coupling", "independence"]),
  entry("convergence-limits", ["sequence", "function", "integral", "random_variable"], [
    "convergence",
    "domination",
    "uniform_integrability",
    "limit_distribution",
  ]),
  entry("differential-equations", [
    "differential_equation",
    "operator",
    "series",
    "physical_model",
  ], ["initial_value", "boundary_value", "separation", "linearization"]),
  entry("algebraic-structures", ["group", "ring", "field", "polynomial"], [
    "homomorphism",
    "quotient",
    "factorization",
    "extension",
  ]),
  entry("topology-local-global", ["metric_space", "topological_space", "map", "set"], [
    "compactness",
    "completeness",
    "basis",
    "local_global",
  ]),
  entry("statistical-inference", ["sample", "parameter", "likelihood", "distribution"], [
    "confidence_interval",
    "hypothesis_test",
    "sufficiency",
    "fisher_information",
  ]),
  entry("regression-diagnostics", ["regression", "design_matrix", "response", "error"], [
    "least_squares",
    "regularization",
    "collinearity",
    "heteroskedasticity",
  ]),
  entry("numerical-approximation", [
    "function",
    "algorithm",
    "matrix",
    "differential_equation",
  ], ["error_bound", "conditioning", "discretization", "interpolation"]),
]);

// A least-squares/regression item that also carries statement wording: without
// the fusion the proof card wins on token count alone.
const OLS_PROBLEM = "对成对数据做最小二乘拟合直线，并证明关于量词与必要性的命题。";
const GROUP_PROBLEM = "求 $A_4$ 中共轭类的个数。";
// No tool route at all: the list must stay exactly the word-only baseline.
const PLAIN_PROBLEM = "设 f 是连续函数，讨论其在区间上的单调性与凸性，并求极值。";

test("preferredMethodForToolRoute maps every registered route to its owning card", () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ["GROUP_STRUCTURE", "algebraic-structures"],
    ["SPLITTING_FIELD_DEGREE", "algebraic-structures"],
    ["EXACT_FACTOR_OVER_EXTENSION", "algebraic-structures"],
    ["REAL_ROOT_COUNT", "domain-equivalence"],
    ["LINEAR_SYSTEM_SOLUTION_SET", "linearization-spectral"],
    ["EXACT_MAXIMAL_MINORS", "linearization-spectral"],
    ["POLYNOMIAL_EXPAND_COEFFICIENTS", "generating-functions"],
    ["CIRCLE_LAPLACIAN", "differential-equations"],
    ["PLANAR_LAPLACIAN", "differential-equations"],
    ["EXACT_TRIG_REDUCE", "differential-equations"],
    ["EXACT_DEFINITE_INTEGRAL", "integral-symmetry"],
    ["EXACT_LIMIT", "convergence-limits"],
    ["EXACT_DENSITY_CHECK", "conditioning-indicators"],
    ["FINITE_ENUMERATION", "counting-bijections"],
    ["INTERPOLATION_FIT", "numerical-approximation"],
    ["OLS_CHECK", "regression-diagnostics"],
    ["EXACT_SIMPLIFY", "domain-equivalence"],
  ];
  const ids = new Set(CATALOG.map((item) => item.id));
  for (const [routeId, methodId] of expected) {
    const route = Object.freeze({
      id: routeId,
      toolName: "exact_check_expr",
      operation: routeId,
      argsTemplate: "{}",
    });
    assert.equal(preferredMethodForToolRoute(route), methodId);
    // Every target must be a real card of the catalog.
    assert.equal(ids.has(methodId), true);
  }
});

test("preferredMethodForToolRoute is pure and null for unknown or absent routes", () => {
  assert.equal(preferredMethodForToolRoute(null), null);
  assert.equal(
    preferredMethodForToolRoute(
      Object.freeze({ id: "NOT_A_ROUTE", toolName: "x", operation: "X", argsTemplate: "{}" }),
    ),
    null,
  );
  const route = semanticToolRoute(OLS_PROBLEM);
  assert.ok(route !== null);
  const first = preferredMethodForToolRoute(route);
  assert.equal(first, "regression-diagnostics");
  assert.equal(preferredMethodForToolRoute(route), first);
  assert.equal(route.id, "OLS_CHECK");
  // The route object itself is never mutated by the mapping.
  assert.deepEqual(route, semanticToolRoute(OLS_PROBLEM));
});

test("an OLS_CHECK route puts regression-diagnostics first", () => {
  assert.equal(semanticToolRoute(OLS_PROBLEM)?.operation, "OLS_CHECK");
  const routed = semanticMethodRoute(OLS_PROBLEM, CATALOG);
  assert.equal(routed[0], "regression-diagnostics");
  assert.ok(routed.length <= 3);
  // The word-only scores still decide the remaining order.
  assert.deepEqual([...routed], ["regression-diagnostics", "proof-counterexamples", "coordinates-geometry"]);
});

test("a GROUP_STRUCTURE route puts algebraic-structures first", () => {
  assert.equal(semanticToolRoute(GROUP_PROBLEM)?.operation, "GROUP_STRUCTURE");
  assert.deepEqual([...semanticMethodRoute(GROUP_PROBLEM, CATALOG)], ["algebraic-structures"]);
});

test("a problem with no tool route keeps the unchanged baseline order", () => {
  assert.equal(semanticToolRoute(PLAIN_PROBLEM), null);
  assert.deepEqual(
    [...semanticMethodRoute(PLAIN_PROBLEM, CATALOG)],
    ["inequalities-optimization", "convergence-limits", "integral-symmetry"],
  );
});

test("fusion is deterministic, order independent and bounded", () => {
  for (const problem of [OLS_PROBLEM, GROUP_PROBLEM, PLAIN_PROBLEM]) {
    const first = semanticMethodRoute(problem, CATALOG);
    assert.deepEqual(first, semanticMethodRoute(problem, CATALOG));
    assert.deepEqual(first, semanticMethodRoute(problem, [...CATALOG].reverse()));
    assert.ok(first.length <= 3);
    const known = new Set(CATALOG.map((item) => item.id));
    assert.equal(first.every((id) => known.has(id)), true);
  }
});

test("a route whose owning card is not loaded never fabricates a candidate", () => {
  const subset = CATALOG.filter((item) => item.id !== "regression-diagnostics");
  const routed = semanticMethodRoute(OLS_PROBLEM, subset);
  assert.equal(routed.includes("regression-diagnostics"), false);
  // The word-only baseline for the remaining cards is untouched.
  assert.deepEqual([...routed], ["proof-counterexamples", "coordinates-geometry"]);
});
