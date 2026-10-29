/**
 * Stage A: every routed tool must receive its own truthful input constraint in
 * the forced semantic-tool-turn prompt. Integer-parameter tools must never keep
 * the old blanket "quoted JSON string" instruction: their contracts reject
 * quoted numbers as `invalid_input`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { P3Action } from "@astra/protocol";
import {
  checkerSupportsObligation,
  methodToolInputConstraint,
  semanticToolTurnNote,
} from "../src/agent-loop.js";
import type { SemanticToolRoute } from "../src/agent-semantics.js";

interface ConstraintCase {
  readonly toolName: string;
  readonly operation: string;
  readonly argsTemplate: string;
  readonly constraint: string;
  readonly integerParameters: boolean;
}

const TOOL_CONSTRAINTS: readonly ConstraintCase[] = [
  {
    toolName: "solve_quadratic_diophantine",
    operation: "SOLVE_QUADRATIC_DIOPHANTINE",
    argsTemplate:
      '{"a":<integer>,"b":<integer>,"c":<integer>,"d":<integer>,"e":<integer>,"f":<integer>,"y_bound":<positive integer>}',
    constraint:
      "Pass a, b, c, d, e, f (and optional y_bound) as JSON integers with |coeff|<=32 and a!=0; do not quote numbers.",
    integerParameters: true,
  },
  {
    toolName: "symbolic_diophantine_with_timeout",
    operation: "SYMBOLIC_DIOPHANTINE",
    argsTemplate:
      '{"lhs":"<quadratic polynomial>","rhs":"<quadratic polynomial>","variables":["x","y"],"timeout_ms":<positive integer>}',
    constraint:
      "Pass lhs (and optional rhs) as polynomial strings using ** for powers, and optional two-variable list variables.",
    integerParameters: false,
  },
  {
    toolName: "solve_system_guarded_expr",
    operation: "SYSTEM_OF_EXPRESSIONS",
    argsTemplate:
      '{"expressions":["<polynomial expression>"],"variables":["x","y"],"timeout_ms":<positive integer>,"n_starts":<positive integer>,"seed":<integer>}',
    constraint:
      "Pass expressions as an array of <=6 polynomial strings (using **) and variables as an array of <=3 variable names.",
    integerParameters: false,
  },
  {
    toolName: "polynomial_function_check",
    operation: "POLYNOMIAL_FUNCTION_CHECK",
    argsTemplate:
      '{"equation":"<functional equality>","function":"<unary function name>","argument":"<variable name>","variables":["<variable name>"],"expression":"<candidate rational polynomial>"}',
    constraint:
      "Pass exactly the five fields equation, function, argument, variables and univariate rational polynomial expression.",
    integerParameters: false,
  },
  {
    toolName: "gf2_rank",
    operation: "GF2_RANK",
    argsTemplate: '{"rows":[<nonnegative integer bit rows>]}',
    constraint:
      "Pass rows ONLY as an array of <=8 non-negative JSON integers encoding binary rows (<=8 bits); do not pass width or strings.",
    integerParameters: true,
  },
  {
    toolName: "gf2_nullspace",
    operation: "GF2_NULLSPACE",
    argsTemplate:
      '{"rows":[<nonnegative integer bit rows>],"width":<integer 1..8>}',
    constraint:
      "Pass rows (<=8 non-negative JSON integers) and integer width (1..8) only; do not quote integers.",
    integerParameters: true,
  },
  {
    toolName: "transition_count",
    operation: "TRANSITION_COUNT",
    argsTemplate:
      '{"length":<integer 1..6>,"num_states":<integer 1..4>,"transitions":[[0,1]],"starts":[0],"ends":[1]}',
    constraint:
      "Pass integer length (1..6), integer num_states (1..4), transitions as [u,v] integer pairs, and optional integer arrays starts/ends (omit if default, never null).",
    integerParameters: true,
  },
  {
    toolName: "independence_polynomial_chain",
    operation: "INDEPENDENCE_POLYNOMIAL_CHAIN",
    argsTemplate: '{"n":<integer 0..16>}',
    constraint:
      "Pass n as a non-negative JSON integer (0..16); do not quote n.",
    integerParameters: true,
  },
  {
    toolName: "count_by_digit_property",
    operation: "COUNT_BY_DIGIT_PROPERTY",
    argsTemplate:
      '{"digit_set":[<digits>],"max_digits":<integer 1..3>,"modulus":<integer 1..64>,"residue":<integer>,"include_zero":<boolean>}',
    constraint:
      "Pass digit_set (array of ints 0..9), max_digits (1..3), and optional modulus (1..64), residue (0..modulus-1), include_zero (boolean).",
    integerParameters: true,
  },
  {
    toolName: "rook_numbers",
    operation: "ROOK_NUMBERS",
    argsTemplate: '{"n":<integer 1..5>,"forbidden":[[0,0]]}',
    constraint:
      "Pass integer n (1..5) and forbidden as an array of <=10 [r,c] integer pairs with 0<=r,c<n.",
    integerParameters: true,
  },
  {
    toolName: "count_avoiding_permutations",
    operation: "COUNT_AVOIDING_PERMUTATIONS",
    argsTemplate: '{"n":<integer 1..6>,"forbidden":[[0,0]]}',
    constraint:
      "Pass integer n (1..6) and forbidden as an array of [i, pi_i] integer pairs with 0<=i,pi_i<n.",
    integerParameters: true,
  },
  {
    toolName: "cover_time_complete_graph",
    operation: "COVER_TIME_COMPLETE_GRAPH",
    argsTemplate: '{"num_vertices":<integer 2..8>}',
    constraint: "Pass num_vertices as a JSON integer in 2..8.",
    integerParameters: true,
  },
  {
    toolName: "markov_expected_steps",
    operation: "MARKOV_EXPECTED_STEPS",
    argsTemplate:
      '{"transition":[[0.5,0.5],[0.5,0.5]],"start":0,"targets":[1]}',
    constraint:
      "Pass transition as a <=6x6 matrix of exact decimal numbers summing to 1 per row, integer start, and non-empty integer array targets.",
    integerParameters: true,
  },
  {
    toolName: "finite_difference_derivative",
    operation: "FINITE_DIFFERENCE_DERIVATIVE",
    argsTemplate: '{"f":"sin(x)","x":0,"h":0.01,"method":"central"}',
    constraint:
      "Pass f as an expression string in x, numeric x (|x|<=100), numeric step h (1e-6..1), and optional method (central/forward/backward).",
    integerParameters: false,
  },
  {
    toolName: "richardson_extrapolate",
    operation: "RICHARDSON_EXTRAPOLATE",
    argsTemplate:
      '{"f":"sin(x)","x":0,"h":0.01,"method":"central","order":2}',
    constraint:
      "Pass f as an expression string in x, numeric x (|x|<=100), numeric step h (1e-6..1), and optional method and integer order (1..8).",
    integerParameters: false,
  },
];

function routeOf(item: ConstraintCase): SemanticToolRoute {
  return {
    id: item.operation,
    toolName: item.toolName,
    operation: item.operation,
    argsTemplate: item.argsTemplate,
  };
}

for (const item of TOOL_CONSTRAINTS) {
  test(`forced semantic-tool-turn prompt gives ${item.toolName} its own input constraint`, () => {
    const route = routeOf(item);
    const constraint = methodToolInputConstraint(route);
    assert.equal(constraint, item.constraint);

    const note = semanticToolTurnNote(route);
    assert.match(note, /SEMANTIC TOOL TURN/u);
    assert.ok(note.includes(`"name":"${item.toolName}"`));
    assert.ok(note.includes(item.constraint));
    assert.ok(note.includes("Never substitute a different tool."));
    assert.doesNotMatch(
      note,
      /Copy the explicit expression, polynomial or function exactly from the problem statement/u,
    );
    if (item.integerParameters) {
      assert.doesNotMatch(note, /quoted JSON string/u);
    }
  });
}

test("checkerSupportsObligation accepts linear_system_solution_set matrix plus rhs", () => {
  const problem = "解线性方程组 2x+3y=1, x-y=0。";
  const action = {
    action: "tool",
    name: "linear_system_solution_set",
    args: {
      matrix: [
        ["2", "3"],
        ["1", "-1"],
      ],
      rhs: ["1", "0"],
      variables: ["x", "y"],
      domain: "RATIONAL",
    },
    scope: "solve the supplied linear system",
  } as P3Action;

  assert.equal(checkerSupportsObligation(action, problem), true);
});

test("checkerSupportsObligation still fails closed without matrix plus rhs", () => {
  const problem = "解线性方程组 2x+3y=1, x-y=0。";
  const missingRhs = {
    action: "tool",
    name: "linear_system_solution_set",
    args: {
      matrix: [["2", "3"]],
      variables: ["x", "y"],
      domain: "RATIONAL",
    },
    scope: "solve the supplied linear system",
  } as P3Action;

  assert.equal(checkerSupportsObligation(missingRhs, problem), false);
});
