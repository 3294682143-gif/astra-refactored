import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerClosureDefects,
  answerClosureNote,
  problemChoiceLetters,
  problemOptionTexts,
} from "../src/agent-answer-closure.js";

test("problem option letters are read from labelled choices", () => {
  const problem = [
    "选择正确的选项：",
    "A. 第一个命题正确",
    "B. 第二个命题错误",
    "C. 两个都正确",
    "D. 两个都错误",
  ].join("\n");
  assert.deepEqual(problemChoiceLetters(problem), ["A", "B", "C", "D"]);
  assert.deepEqual(problemChoiceLetters("设变量 A 与 B 满足 A+B=1"), []);
  assert.deepEqual(
    problemChoiceLetters("下列哪些正确？A. 甲 B. 乙 C. 丙 D. 丁"),
    ["A", "B", "C", "D"],
  );
});

test("option closure requires a table covering every stated option", () => {
  const problem = "A. one\nB. two\nC. three\nD. four";
  const missing = answerClosureDefects({
    problemText: problem,
    candidate: "A、C",
    packet: {
      candidateProposal: "A、C",
      suggestedChecks: ["CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE"],
    },
  });
  assert.equal(missing[0]?.kind, "OPTION_COVERAGE");
  assert.match(missing[0]?.detail ?? "", /D/);

  const complete = answerClosureDefects({
    problemText: problem,
    candidate: "A、C、D",
    packet: {
      candidateProposal: "A、C、D",
      suggestedChecks: ["CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE,D=TRUE"],
    },
  });
  assert.deepEqual(complete, []);
});

test("degree conservation compares a candidate polynomial with the exact maximal minor", () => {
  const defect = answerClosureDefects({
    problemText: "计算亚历山大多项式 P(t)，矩阵如下。",
    candidate: "t^2 - t + 1",
    packet: { candidateProposal: "t^2 - t + 1" },
    exactObservation: {
      operation: "MAXIMAL_MINORS",
      normalized_minors: [
        {
          polynomial:
            "t**6 - 5*t**5 + 10*t**4 - 13*t**3 + 10*t**2 - 5*t + 1",
          multiplicity: 16,
        },
      ],
    },
  });
  assert.equal(defect[0]?.kind, "DEGREE_CONSERVATION");
  assert.match(defect[0]?.detail ?? "", /degree 6.*degree 2/u);
});

test("normalization rejects an unnormalized exact density and requires evidence otherwise", () => {
  const failed = answerClosureDefects({
    problemText: "求概率密度函数 f(x)。",
    candidate: "4*exp(-x^2/2)/sqrt(2*pi)",
    packet: { candidateProposal: "4*exp(-x^2/2)/sqrt(2*pi)" },
    exactObservation: {
      operation: "DENSITY_CHECK",
      normalized: false,
      numeric_integral: "4.0",
    },
  });
  assert.equal(failed[0]?.kind, "NORMALIZATION");

  const noEvidence = answerClosureDefects({
    problemText: "求概率密度函数 f(x)。",
    candidate: "2*exp(-x^2/5)/sqrt(5*pi)",
    packet: { candidateProposal: "2*exp(-x^2/5)/sqrt(5*pi)" },
  });
  assert.equal(noEvidence[0]?.kind, "NORMALIZATION");

  const checked = answerClosureDefects({
    problemText: "求概率密度函数 f(x)。",
    candidate: "2*exp(-x^2/5)/sqrt(5*pi)",
    packet: {
      candidateProposal: "2*exp(-x^2/5)/sqrt(5*pi)",
      suggestedChecks: [
        "CERT1|CHECK|C1|DENSITY_CHECK|integral over R = 1 => PASS",
      ],
    },
  });
  assert.deepEqual(checked, []);
});

test("solution completeness uses the independently solved exact set", () => {
  const wrong = answerClosureDefects({
    problemText: "求方程 x^2 = 1 的所有解。",
    candidate: "{1}",
    packet: { candidateProposal: "{1}" },
    expectedSolutionKeys: ["-1/1", "1/1"],
    requiresExhaustive: true,
  });
  assert.equal(wrong[0]?.kind, "SOLUTION_COMPLETENESS");

  const right = answerClosureDefects({
    problemText: "求方程 x^2 = 1 的所有解。",
    candidate: "{-1,1}",
    packet: { candidateProposal: "{-1,1}" },
    expectedSolutionKeys: ["-1/1", "1/1"],
    requiresExhaustive: true,
  });
  assert.deepEqual(right, []);
});

test("a completeness marker is accepted when no exact set is determinable", () => {
  const marked = answerClosureDefects({
    problemText: "求所有满足条件的参数。",
    candidate: "a>0 或 a=-1",
    packet: {
      candidateProposal: "a>0 或 a=-1",
      suggestedChecks: [
        "CERT1|COMPLETENESS|two disjoint cases; no other branch => PASS",
      ],
    },
    expectedSolutionKeys: null,
    requiresExhaustive: true,
  });
  assert.deepEqual(marked, []);
});

test("closure note names defects without an item id or reference answer", () => {
  const note = answerClosureNote([
    { kind: "DEGREE_CONSERVATION", detail: "degree 6 versus 2" },
  ]);
  assert.match(note, /ANSWER CLOSURE/u);
  assert.match(note, /DEGREE_CONSERVATION/u);
  assert.doesNotMatch(note, /#\d+|item\s+\d+/iu);
});

test("real-root count observations are compared only with a whole numeric candidate", () => {
  const problem = "求方程 x^3-3x+1=0 的实根个数。";
  const wrong = answerClosureDefects({
    problemText: problem,
    candidate: "2",
    packet: { candidateProposal: "2" },
    toolObservations: [
      { name: "real_root_count_expr", operation: "REAL_ROOT_COUNT", result: 3 },
    ],
  });
  assert.equal(wrong[0]?.kind, "REAL_ROOT_COUNT");
  assert.match(wrong[0]?.detail ?? "", /3.*2/u);

  const right = answerClosureDefects({
    problemText: problem,
    candidate: "$3$ 个",
    packet: { candidateProposal: "$3$ 个" },
    toolObservations: [
      { name: "real_root_count_expr", operation: "REAL_ROOT_COUNT", result: 3 },
    ],
  });
  assert.deepEqual(right, []);

  const sentence = answerClosureDefects({
    problemText: problem,
    candidate: "该方程有三个实根，因此答案是 2",
    packet: { candidateProposal: "该方程有三个实根，因此答案是 2" },
    toolObservations: [
      { name: "real_root_count_expr", operation: "REAL_ROOT_COUNT", result: 3 },
    ],
  });
  assert.deepEqual(sentence, []);
});

test("splitting-field degree observations are compared only with an explicit degree", () => {
  const problem = "求 x^4-2 在 Q 上的分裂域次数 [E:Q]。";
  const wrong = answerClosureDefects({
    problemText: problem,
    candidate: "[E:Q]=6",
    packet: { candidateProposal: "[E:Q]=6" },
    toolObservations: [
      { name: "splitting_field_degree_expr", operation: "SPLITTING_FIELD_DEGREE", result: 8 },
    ],
  });
  assert.equal(wrong[0]?.kind, "SPLITTING_FIELD_DEGREE");

  const right = answerClosureDefects({
    problemText: problem,
    candidate: "8",
    packet: { candidateProposal: "8" },
    toolObservations: [
      { name: "splitting_field_degree_expr", operation: "SPLITTING_FIELD_DEGREE", result: 8 },
    ],
  });
  assert.deepEqual(right, []);

  const narrative = answerClosureDefects({
    problemText: problem,
    candidate: "分裂域的扩张次数由本原元方法给出，不是 8",
    packet: { candidateProposal: "分裂域的扩张次数由本原元方法给出，不是 8" },
    toolObservations: [
      { name: "splitting_field_degree_expr", operation: "SPLITTING_FIELD_DEGREE", result: 8 },
    ],
  });
  assert.deepEqual(narrative, []);

  const embedded = answerClosureDefects({
    problemText: problem,
    candidate: "分裂域 Q(alpha)；[E:Q]=6；是 Galois 扩张",
    packet: { candidateProposal: "分裂域 Q(alpha)；[E:Q]=6；是 Galois 扩张" },
    toolObservations: [
      { name: "splitting_field_degree_expr", operation: "SPLITTING_FIELD_DEGREE", result: 8 },
    ],
  });
  assert.equal(embedded[0]?.kind, "SPLITTING_FIELD_DEGREE");
});

test("unrelated tool observations do not force a candidate change", () => {
  assert.deepEqual(
    answerClosureDefects({
      problemText: "计算 f(x,y)=x^2*y 的平面 Laplacian。",
      candidate: "2*y",
      packet: { candidateProposal: "2*y" },
      toolObservations: [
        { name: "planar_laplacian_expr", operation: "PLANAR_LAPLACIAN", result: "2*y" },
      ],
    }),
    [],
  );
});

test("degree conservation reads a unicode superscript candidate instead of skipping it", () => {
  const observation = {
    operation: "MAXIMAL_MINORS",
    normalized_minors: [
      {
        polynomial: "t**6 - 5*t**5 + 10*t**4 - 13*t**3 + 10*t**2 - 5*t + 1",
        multiplicity: 16,
      },
    ],
  };
  const superscript = answerClosureDefects({
    problemText: "计算亚历山大多项式 P(t)，矩阵如下。",
    candidate: "t²-t+1",
    packet: { candidateProposal: "t²-t+1" },
    exactObservation: observation,
  });
  assert.equal(superscript[0]?.kind, "DEGREE_CONSERVATION");
  assert.match(superscript[0]?.detail ?? "", /degree 6.*degree 2/u);

  const agreeing = answerClosureDefects({
    problemText: "计算亚历山大多项式 P(t)，矩阵如下。",
    candidate: "t⁶-5t⁵+10t⁴-13t³+10t²-5t+1",
    packet: { candidateProposal: "t⁶-5t⁵+10t⁴-13t³+10t²-5t+1" },
    exactObservation: observation,
  });
  assert.deepEqual(agreeing, []);
});

test("multi-minor observations are read only when the list itself is consistent", () => {
  const problem = "计算亚历山大多项式 P(t)，矩阵如下。";
  const defectKinds = (normalizedMinors: readonly unknown[], candidate: string) =>
    answerClosureDefects({
      problemText: problem,
      candidate,
      packet: { candidateProposal: candidate },
      exactObservation: {
        operation: "MAXIMAL_MINORS",
        normalized_minors: normalizedMinors,
      },
    }).map((defect) => defect.kind);

  // Same polynomial up to a constant factor (a zero minor is ignored).
  assert.deepEqual(
    defectKinds(
      [
        { polynomial: "t⁶-1", multiplicity: 1 },
        { polynomial: "2*t⁶-2", multiplicity: 2 },
        { polynomial: "0", multiplicity: 3 },
      ],
      "t²-t+1",
    ),
    ["DEGREE_CONSERVATION"],
  );
  // Plain-string entries and a shared total degree are accepted.
  assert.deepEqual(defectKinds(["t³-1", "t³+1"], "t²-t+1"), ["DEGREE_CONSERVATION"]);
  // A consistent list whose highest-degree minor matches the candidate is clean.
  assert.deepEqual(defectKinds(["t³-1", "t³+1"], "t³-1"), []);
  // Mutation: minors of different degree that are not constant multiples of each
  // other make the invariant ambiguous, so no defect is invented.
  assert.deepEqual(defectKinds(["t³-1", "t²-t+1"], "t²-t+1"), []);
  assert.deepEqual(defectKinds([{ polynomial: "t⁶-1" }, { notAPolynomial: 1 }], "t²-t+1"), []);
  assert.deepEqual(defectKinds([], "t²-t+1"), []);
  assert.deepEqual(
    defectKinds([{ polynomial: "0" }, { polynomial: "0" }], "t²-t+1"),
    [],
  );
});

test("real-root and splitting-field defects fire on bare integer tool payloads", () => {
  const rootProblem = "求方程 x^3-3x+1=0 的实根个数。";
  const rootObservation = (result: unknown) => [
    { name: "real_root_count_expr", operation: "REAL_ROOT_COUNT", result },
  ];
  for (const payload of [3, "3", { value: 3 }]) {
    assert.equal(
      answerClosureDefects({
        problemText: rootProblem,
        candidate: "2",
        packet: { candidateProposal: "2" },
        toolObservations: rootObservation(payload),
      })[0]?.kind,
      "REAL_ROOT_COUNT",
    );
    assert.deepEqual(
      answerClosureDefects({
        problemText: rootProblem,
        candidate: "3",
        packet: { candidateProposal: "3" },
        toolObservations: rootObservation(payload),
      }),
      [],
    );
  }

  const splittingProblem = "求 x^4-2 在 Q 上的分裂域次数 [E:Q]。";
  const splittingObservation = (result: unknown) => [
    { name: "splitting_field_degree_expr", operation: "SPLITTING_FIELD_DEGREE", result },
  ];
  for (const payload of [8, "8", { value: 8 }]) {
    assert.equal(
      answerClosureDefects({
        problemText: splittingProblem,
        candidate: "[E:Q]=6",
        packet: { candidateProposal: "[E:Q]=6" },
        toolObservations: splittingObservation(payload),
      })[0]?.kind,
      "SPLITTING_FIELD_DEGREE",
    );
    assert.deepEqual(
      answerClosureDefects({
        problemText: splittingProblem,
        candidate: "[E:Q]=8",
        packet: { candidateProposal: "[E:Q]=8" },
        toolObservations: splittingObservation(payload),
      }),
      [],
    );
  }
});

test("an exact observation only ever satisfies the diagnostic of its own operation", () => {
  const problem = "计算亚历山大多项式 P(t)，矩阵如下。";
  const candidate = "t²-t+1";
  const degreeObservation = {
    operation: "MAXIMAL_MINORS",
    normalized_minors: [{ polynomial: "t**6-1", multiplicity: 1 }],
  };
  const limitObservation = { operation: "LIMIT", value: 1 };
  const kinds = (input: {
    readonly exactObservations?: { readonly get: (operation: string) => unknown };
    readonly exactObservation?: unknown;
  }) =>
    answerClosureDefects({
      problemText: problem,
      candidate,
      packet: { candidateProposal: candidate },
      ...(input.exactObservations === undefined
        ? {}
        : { exactObservations: input.exactObservations as never }),
      ...(input.exactObservation === undefined
        ? {}
        : { exactObservation: input.exactObservation as never }),
    }).map((defect) => defect.kind);

  // A LIMIT result can never ground a degree defect, keyed or legacy.
  assert.deepEqual(
    kinds({ exactObservations: new Map<string, unknown>([["LIMIT", limitObservation]]) }),
    [],
  );
  assert.deepEqual(kinds({ exactObservation: limitObservation }), []);
  // The MAXIMAL_MINORS result does, in either form, and it survives an
  // unrelated LIMIT result being present in the same run.
  assert.deepEqual(
    kinds({
      exactObservations: new Map<string, unknown>([
        ["LIMIT", limitObservation],
        ["MAXIMAL_MINORS", degreeObservation],
      ]),
    }),
    ["DEGREE_CONSERVATION"],
  );
  assert.deepEqual(kinds({ exactObservation: degreeObservation }), [
    "DEGREE_CONSERVATION",
  ]);
});

// ---------------------------------------------------------------------------
// Observation-grounded diagnostics for interpolation_fit_check, stats_ols_check
// and finite_group_structure. Every case below is input-relative: either one
// explicit observed value disagrees with one explicit value the candidate
// states, or no defect is produced at all.
// ---------------------------------------------------------------------------

const INTERPOLATION_PROBLEM = "求过点 (0,1)、(1,2)、(2,5) 的插值多项式 P(x)。";

/** One `interpolation_fit_check` observation view with a caller-given payload. */
function interpolationObservation(result: unknown) {
  return [{ name: "interpolation_fit_check", operation: "INTERPOLATION_FIT", result }];
}

const FAILING_INTERPOLATION = {
  schema: "interpolation-fit-check-v1",
  operation: "INTERPOLATION_FIT",
  variable: "x",
  point_count: 3,
  residuals: ["1/1", "1/1", "4/1"],
  all_zero: false,
  degree: 2,
  interpolating_polynomial: "x**2 + 1",
};

test("interpolation residuals are a defect when the candidate misses the stated points", () => {
  const failed = answerClosureDefects({
    problemText: INTERPOLATION_PROBLEM,
    candidate: "x^2 + 2",
    packet: { candidateProposal: "x^2 + 2" },
    toolObservations: interpolationObservation(FAILING_INTERPOLATION),
  });
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.kind, "INTERPOLATION_RESIDUAL");
  assert.equal(failed[0]?.evidence, "OBSERVATION");
  assert.equal(
    failed[0]?.detail,
    'the exact interpolation check reports residuals ["1/1","1/1","4/1"] at the 3 ' +
      "stated point(s), so the candidate polynomial of degree 2 does not pass " +
      "through those points; the interpolating polynomial is x**2 + 1",
  );

  // A clean residual list is not a defect: the candidate canonicalises to the
  // observed interpolating polynomial, so it really is the unique interpolant.
  const clean = answerClosureDefects({
    problemText: INTERPOLATION_PROBLEM,
    candidate: "(x-1)*(x+1)+2",
    packet: { candidateProposal: "(x-1)*(x+1)+2" },
    toolObservations: interpolationObservation({
      ...FAILING_INTERPOLATION,
      residuals: ["0", "0", "0"],
      all_zero: true,
    }),
  });
  assert.deepEqual(clean, []);

  // Without an observation, and for a problem that is not interpolation-shaped,
  // nothing is invented.
  assert.deepEqual(
    answerClosureDefects({
      problemText: INTERPOLATION_PROBLEM,
      candidate: "x^2 + 2",
      packet: { candidateProposal: "x^2 + 2" },
    }),
    [],
  );
  // The observation is self-identifying: the former route guard was removed,
  // so a real interpolation observation is checked even on a differently
  // worded task. A malformed/absent observation still produces nothing.
  assert.equal(
    answerClosureDefects({
      problemText: "计算三阶行列式的值。",
      candidate: "x^2 + 2",
      packet: { candidateProposal: "x^2 + 2" },
      toolObservations: interpolationObservation(FAILING_INTERPOLATION),
    })[0]?.kind,
    "INTERPOLATION_RESIDUAL",
  );
});

const OLS_PROBLEM = "用最小二乘法求这组数据的回归直线。";

/** One `stats_ols_check` observation view with a caller-given payload. */
function olsObservation(result: unknown) {
  return [{ name: "stats_ols_check", operation: "OLS_CHECK", result }];
}

const FAILING_OLS = {
  schema: "stats-ols-check-v1",
  operation: "OLS_CHECK",
  n: 3,
  slope: "3/2",
  intercept: "-1/2",
  sse: "0",
  sst: "9/2",
  r_squared: "1",
  claim_matches: false,
  residuals: ["0", "0", "0"],
};

test("an OLS claim mismatch is a defect only against an explicitly stated slope or intercept", () => {
  const failed = answerClosureDefects({
    problemText: OLS_PROBLEM,
    candidate: "y = 3x - 1",
    packet: { candidateProposal: "y = 3x - 1" },
    toolObservations: olsObservation(FAILING_OLS),
  });
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.kind, "OLS_MISMATCH");
  assert.equal(failed[0]?.evidence, "OBSERVATION");
  assert.equal(
    failed[0]?.detail,
    "the exact least-squares fit reports slope 3/2 and intercept -1/2 for 3 exact " +
      "data pair(s), but the candidate states slope 3 and intercept -1",
  );

  // `claim_matches === true`, `null`, an absent observation and a candidate that
  // states no slope/intercept are all clean.
  for (const agreeing of [
    olsObservation({ ...FAILING_OLS, claim_matches: true }),
    olsObservation({ ...FAILING_OLS, claim_matches: null }),
    [],
  ]) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: OLS_PROBLEM,
        candidate: "y = 3x - 1",
        packet: { candidateProposal: "y = 3x - 1" },
        toolObservations: agreeing,
      }),
      [],
    );
  }
  assert.deepEqual(
    answerClosureDefects({
      problemText: OLS_PROBLEM,
      candidate: "回归直线由最小二乘公式唯一确定。",
      packet: { candidateProposal: "回归直线由最小二乘公式唯一确定。" },
      toolObservations: olsObservation(FAILING_OLS),
    }),
    [],
  );
  // The candidate states exactly the observed pair even though a different
  // claim was checked: the candidate itself is not wrong.
  assert.deepEqual(
    answerClosureDefects({
      problemText: OLS_PROBLEM,
      candidate: "斜率=3/2，截距=-1/2",
      packet: { candidateProposal: "斜率=3/2，截距=-1/2" },
      toolObservations: olsObservation(FAILING_OLS),
    }),
    [],
  );
});

const GROUP_PROBLEM = "求由 (12) 与 (123) 生成的置换群的阶与共轭类个数。";

/** One `finite_group_structure` observation view with a caller-given payload. */
function groupObservation(result: unknown) {
  return [{ name: "finite_group_structure", operation: "GROUP_STRUCTURE", result }];
}

const OBSERVED_GROUP = {
  schema: "finite-group-structure-v1",
  operation: "GROUP_STRUCTURE",
  degree: 3,
  generator_count: 2,
  order: 6,
  is_abelian: false,
  is_cyclic: false,
  exponent: 6,
  center_size: 1,
  element_orders: { "1": 1, "2": 3, "3": 2 },
  conjugacy_classes: [
    { size: 1, representative: "(1)", element_order: 1 },
    { size: 3, representative: "(12)", element_order: 2 },
    { size: 2, representative: "(123)", element_order: 3 },
  ],
};

test("a group order or conjugacy-class count that contradicts the enumeration is a defect", () => {
  const orderDefect = answerClosureDefects({
    problemText: GROUP_PROBLEM,
    candidate: "该群的阶为 8。",
    packet: { candidateProposal: "该群的阶为 8。" },
    toolObservations: groupObservation(OBSERVED_GROUP),
  });
  assert.equal(orderDefect.length, 1);
  assert.equal(orderDefect[0]?.kind, "GROUP_STRUCTURE_MISMATCH");
  assert.equal(orderDefect[0]?.evidence, "OBSERVATION");
  assert.equal(
    orderDefect[0]?.detail,
    "the exact group enumeration reports order 6 and 3 conjugacy classes, but the " +
      "candidate states order 8",
  );

  const classDefect = answerClosureDefects({
    problemText: GROUP_PROBLEM,
    candidate: "|G| = 6，共轭类个数为 4。",
    packet: { candidateProposal: "|G| = 6，共轭类个数为 4。" },
    toolObservations: groupObservation(OBSERVED_GROUP),
  });
  assert.equal(classDefect[0]?.kind, "GROUP_STRUCTURE_MISMATCH");
  assert.equal(
    classDefect[0]?.detail,
    "the exact group enumeration reports order 6 and 3 conjugacy classes, but the " +
      "candidate states 4 conjugacy classes",
  );

  // Matching values, an absent observation and a candidate that states neither
  // number are clean; element orders are never mistaken for the group order.
  assert.deepEqual(
    answerClosureDefects({
      problemText: GROUP_PROBLEM,
      candidate: "该群的阶为 6，共有 3 个共轭类。",
      packet: { candidateProposal: "该群的阶为 6，共有 3 个共轭类。" },
      toolObservations: groupObservation(OBSERVED_GROUP),
    }),
    [],
  );
  assert.deepEqual(
    answerClosureDefects({
      problemText: GROUP_PROBLEM,
      candidate: "该群的阶为 8。",
      packet: { candidateProposal: "该群的阶为 8。" },
    }),
    [],
  );
  assert.deepEqual(
    answerClosureDefects({
      problemText: GROUP_PROBLEM,
      candidate: "该群非交换，元素的阶为 1、2、3。",
      packet: { candidateProposal: "该群非交换，元素的阶为 1、2、3。" },
      toolObservations: groupObservation(OBSERVED_GROUP),
    }),
    [],
  );
});

test("a malformed observation payload is ignored instead of throwing", () => {
  const malformed: readonly unknown[] = [
    null,
    [FAILING_INTERPOLATION],
    "interpolation-fit-check-v1",
    { ...FAILING_INTERPOLATION, residuals: ["not-a-rational"] },
    { ...FAILING_INTERPOLATION, all_zero: "false" },
    { ...FAILING_INTERPOLATION, interpolating_polynomial: 7 },
    { ...FAILING_INTERPOLATION, variable: "x; drop table" },
  ];
  for (const payload of malformed) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: INTERPOLATION_PROBLEM,
        candidate: "x^2 + 2",
        packet: { candidateProposal: "x^2 + 2" },
        toolObservations: interpolationObservation(payload),
      }),
      [],
    );
  }
  const malformedOls: readonly unknown[] = [
    null,
    [],
    { ...FAILING_OLS, slope: undefined },
    { ...FAILING_OLS, intercept: 1.5 },
    { ...FAILING_OLS, claim_matches: "false" },
  ];
  for (const payload of malformedOls) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: OLS_PROBLEM,
        candidate: "y = 3x - 1",
        packet: { candidateProposal: "y = 3x - 1" },
        toolObservations: olsObservation(payload),
      }),
      [],
    );
  }
  const malformedGroup: readonly unknown[] = [
    null,
    6,
    { ...OBSERVED_GROUP, order: "6" },
    { ...OBSERVED_GROUP, conjugacy_classes: [] },
    { ...OBSERVED_GROUP, conjugacy_classes: [{ representative: "(1)" }] },
  ];
  for (const payload of malformedGroup) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: GROUP_PROBLEM,
        candidate: "该群的阶为 8。",
        packet: { candidateProposal: "该群的阶为 8。" },
        toolObservations: groupObservation(payload),
      }),
      [],
    );
  }
});

test("the closure note names the new observed values for each new defect kind", () => {
  const defects = answerClosureDefects({
    problemText: INTERPOLATION_PROBLEM,
    candidate: "x^2 + 2",
    packet: { candidateProposal: "x^2 + 2" },
    toolObservations: interpolationObservation(FAILING_INTERPOLATION),
  });
  const note = answerClosureNote(defects);
  assert.match(note, /INTERPOLATION_RESIDUAL: /u);
  assert.match(note, /x\*\*2 \+ 1/u);
  assert.match(note, /residuals \["1\/1","1\/1","4\/1"\]/u);
  assert.match(note, /interpolating polynomial/u);
  assert.doesNotMatch(note, /#\d+|item\s+\d+/iu);
  // An unrelated defect set gets no interpolation hint.
  assert.doesNotMatch(
    answerClosureNote([{ kind: "DEGREE_CONSERVATION", detail: "degree 6 versus 2" }]),
    /interpolating polynomial/u,
  );
});

// ---------------------------------------------------------------------------
// Option-level diagnostics: the CHOSEN option's own text vs one observation.
//
// A verdict answer ("B") states no number itself, so the contradiction lives in
// the option text. Every case below is input-relative and fail-closed: the
// chosen option's own text must name the quantity explicitly, the observation
// must be present and well formed, and anything ambiguous stays silent.
// ---------------------------------------------------------------------------

/** A CERT1|OPTIONS row marking exactly the candidate's letters TRUE. */
function optionsRow(problemText: string, candidate: string): string {
  const chosen = new Set(
    [...candidate.matchAll(/(?:^|[^A-Za-z])([A-E])(?=$|[^A-Za-z])/gu)].map((match) =>
      (match[1] ?? "").toUpperCase(),
    ),
  );
  return (
    "CERT1|OPTIONS|" +
    problemChoiceLetters(problemText)
      .map((letter) => letter + "=" + (chosen.has(letter) ? "TRUE" : "FALSE"))
      .join(",")
  );
}

/** One closure query for an option-selection candidate. */
function optionClosure(
  problemText: string,
  candidate: string,
  toolObservations?: readonly {
    name: string;
    operation: string | null;
    result: unknown;
  }[],
) {
  return answerClosureDefects({
    problemText,
    candidate,
    packet: {
      candidateProposal: candidate,
      suggestedChecks: [optionsRow(problemText, candidate)],
    },
    ...(toolObservations === undefined ? {} : { toolObservations }),
  });
}

const OPTION_GROUP_PROBLEM = [
  "关于由 (12) 与 (123) 生成的置换群，选择正确的选项：",
  "A. 该群的阶为 6",
  "B. 该群的阶为 8",
  "C. 该群有 4 个共轭类",
  "D. 该群是循环群",
].join("\n");

const OPTION_GROUP_OBSERVATION = {
  schema: "finite-group-structure-v1",
  operation: "GROUP_STRUCTURE",
  degree: 3,
  order: 6,
  is_abelian: false,
  is_cyclic: false,
  element_orders: { "1": 1, "2": 3, "3": 2 },
  conjugacy_classes: [
    { size: 1, representative: "(1)", element_order: 1 },
    { size: 3, representative: "(12)", element_order: 2 },
    { size: 2, representative: "(123)", element_order: 3 },
  ],
};

function optionGroupObservation(result: unknown) {
  return [{ name: "finite_group_structure", operation: "GROUP_STRUCTURE", result }];
}

test("the option block is read as a letter -> text table and never from prose", () => {
  assert.deepEqual(problemOptionTexts(OPTION_GROUP_PROBLEM), [
    { letter: "A", text: "该群的阶为 6" },
    { letter: "B", text: "该群的阶为 8" },
    { letter: "C", text: "该群有 4 个共轭类" },
    { letter: "D", text: "该群是循环群" },
  ]);
  // A bracket expression is not an option marker: `[E:Q]=6` must not make the
  // block look like it repeats option E.
  assert.deepEqual(
    problemOptionTexts("求分裂域次数 [E:Q]。\nA. [E:Q]=8\nB. [E:Q]=6"),
    [
      { letter: "A", text: "[E:Q]=8" },
      { letter: "B", text: "[E:Q]=6" },
    ],
  );
  assert.deepEqual(problemOptionTexts("求由 (12) 生成的置换群的阶。"), []);
  // A repeated letter makes the block unusable rather than ambiguous.
  assert.deepEqual(problemOptionTexts("A. 甲\nB. 乙\nA. 丙"), []);
});

test("a chosen option's group order or conjugacy count contradicts the enumeration", () => {
  const order = optionClosure(
    OPTION_GROUP_PROBLEM,
    "B",
    optionGroupObservation(OPTION_GROUP_OBSERVATION),
  );
  assert.equal(order.length, 1);
  assert.equal(order[0]?.kind, "OPTION_NUMERIC_CONTRADICTION");
  assert.equal(order[0]?.evidence, "OBSERVATION");
  assert.equal(
    order[0]?.detail,
    "option B asserts group order 8, but the exact group enumeration reports exactly 6",
  );

  const classes = optionClosure(
    OPTION_GROUP_PROBLEM,
    "C",
    optionGroupObservation(OPTION_GROUP_OBSERVATION),
  );
  assert.equal(classes.length, 1);
  assert.equal(classes[0]?.kind, "OPTION_NUMERIC_CONTRADICTION");
  assert.equal(
    classes[0]?.detail,
    "option C asserts conjugacy-class count 4, but the exact group enumeration " +
      "reports exactly 3",
  );

  // Negatives: the chosen option agrees, the contradicting number sits in an
  // UNCHOSEN option, and no observation is present at all.
  assert.deepEqual(
    optionClosure(OPTION_GROUP_PROBLEM, "A", optionGroupObservation(OPTION_GROUP_OBSERVATION)),
    [],
  );
  assert.deepEqual(optionClosure(OPTION_GROUP_PROBLEM, "A"), []);
  assert.deepEqual(
    optionClosure(OPTION_GROUP_PROBLEM, "D", optionGroupObservation(OPTION_GROUP_OBSERVATION)).map(
      (row) => row.kind,
    ),
    ["OPTION_VERDICT_CONTRADICTION"],
  );
});

test("finite-group options are judged against the exact subgroup survey", () => {
  const problem = [
    "设 $D_8$ 是 8 阶二面体群，判断下列命题：",
    "A. $D_8$ 有 8 阶元.",
    "B. $D_8$ 的四阶子群一定是Abel群.",
    "C. $C(D_8)=\\{1\\}$.",
    "D. $[D_8,D_8]$是$2$阶群.",
  ].join("\n");
  const observation = {
    schema: "finite-group-structure-v1",
    operation: "GROUP_STRUCTURE",
    order: 8,
    is_abelian: false,
    is_cyclic: false,
    center_size: 2,
    derived_size: 2,
    conjugacy_classes: [{ size: 1, representative: "1", element_order: 1 }],
    subgroup_summary: [
      { order: 1, count: 1, normal_count: 1, all_abelian: true, all_cyclic: true, has_cyclic: true },
      { order: 2, count: 5, normal_count: 1, all_abelian: true, all_cyclic: true, has_cyclic: true },
      { order: 4, count: 3, normal_count: 3, all_abelian: true, all_cyclic: false, has_cyclic: true },
      { order: 8, count: 1, normal_count: 1, all_abelian: false, all_cyclic: false, has_cyclic: false },
    ],
  };
  const closure = (candidate: string) =>
    answerClosureDefects({
      problemText: problem,
      candidate,
      packet: {
        candidateProposal: candidate,
        suggestedChecks: ["CERT1|OPTIONS|A=TRUE,B=TRUE,C=FALSE,D=TRUE"],
      },
      toolObservations: optionGroupObservation(observation),
    });
  // D is true, but the omitted B is also true: the exact survey proves the
  // omission rather than trusting the candidate's single letter.
  const omitted = closure("D");
  assert.deepEqual(omitted.map((row) => row.kind), ["OPTION_VERDICT_CONTRADICTION"]);
  assert.match(omitted[0]?.detail ?? "", /option B is proven TRUE/u);
  assert.match(omitted[0]?.detail ?? "", /order-4 subgroups/u);
  // C is false by center_size=2, while B and D remain the true options.
  const selectedFalse = closure("C");
  assert.deepEqual(selectedFalse.map((row) => row.kind), ["OPTION_VERDICT_CONTRADICTION"]);
  assert.match(selectedFalse[0]?.detail ?? "", /option C is proven FALSE/u);
  assert.match(selectedFalse[0]?.detail ?? "", /center_size=2/u);
  // Choosing both true options is accepted; A's element-order assertion is not
  // an option fact this survey can disprove and must stay unparsed.
  assert.deepEqual(closure("B, D"), []);
});

test("a chosen option's real-root count contradicts the exact Sturm count", () => {
  const problem = [
    "求方程 x^3-3x+1=0 的实根个数。",
    "A. 3 个实根",
    "B. 2 个实根",
    "C. 该方程有 1 个实根",
  ].join("\n");
  const observation = (result: unknown) => [
    { name: "real_root_count_expr", operation: "REAL_ROOT_COUNT", result },
  ];
  const wrong = optionClosure(problem, "C", observation(3));
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0]?.kind, "OPTION_NUMERIC_CONTRADICTION");
  assert.equal(
    wrong[0]?.detail,
    "option C asserts distinct real-root count 1, but the exact Sturm real-root " +
      "count reports exactly 3",
  );
  assert.deepEqual(optionClosure(problem, "A", observation(3)), []);
  assert.deepEqual(optionClosure(problem, "B"), []);
});

test("a chosen option's splitting-field degree contradicts the exact degree", () => {
  const problem = [
    "求 x^4-2 在 Q 上的分裂域次数 [E:Q]。",
    "A. [E:Q]=8",
    "B. [E:Q]=6",
    "C. 分裂域的次数为 4",
  ].join("\n");
  const observation = (result: unknown) => [
    { name: "splitting_field_degree_expr", operation: "SPLITTING_FIELD_DEGREE", result },
  ];
  for (const candidate of ["B", "C"]) {
    const wrong = optionClosure(problem, candidate, observation(8));
    assert.equal(wrong.length, 1, "the chosen option " + candidate + " is inconsistent");
    assert.equal(wrong[0]?.kind, "OPTION_NUMERIC_CONTRADICTION");
    assert.match(wrong[0]?.detail ?? "", /splitting-field degree/u);
  }
  assert.deepEqual(optionClosure(problem, "A", observation(8)), []);
  assert.deepEqual(optionClosure(problem, "B"), []);
});

test("a chosen option's slope and intercept contradict the exact least-squares fit", () => {
  const problem = [
    "用最小二乘法求这组数据的回归直线，选择正确的选项：",
    "A. 斜率为 3/2，截距为 -1/2",
    "B. 斜率为 3，截距为 -1",
  ].join("\n");
  const observation = [
    {
      name: "stats_ols_check",
      operation: "OLS_CHECK",
      result: {
        schema: "stats-ols-check-v1",
        n: 3,
        slope: "3/2",
        intercept: "-1/2",
        claim_matches: false,
      },
    },
  ];
  const wrong = optionClosure(problem, "B", observation);
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0]?.kind, "OPTION_NUMERIC_CONTRADICTION");
  assert.equal(
    wrong[0]?.detail,
    "option B asserts slope 3, but the exact least-squares fit reports exactly 3/2; " +
      "option B asserts intercept -1, but the exact least-squares fit reports " +
      "exactly -1/2",
  );
  // The chosen option states exactly the observed rationals.
  assert.deepEqual(optionClosure(problem, "A", observation), []);
  assert.deepEqual(optionClosure(problem, "B"), []);
});

test("two numbers inside one option clause never produce a defect", () => {
  const problem = [
    "关于由 (12) 与 (123) 生成的置换群，选择正确的选项：",
    "A. 该群的阶为 6 或 8",
    "B. 该群的阶为 6，共轭类个数为 3",
    "C. 该群的阶为 8，共轭类个数为 3",
  ].join("\n");
  const observation = optionGroupObservation(OPTION_GROUP_OBSERVATION);
  // "6 或 8" names two different orders: which one is asserted is undecidable.
  assert.deepEqual(optionClosure(problem, "A", observation), []);
  // Two numbers in two labelled clauses are both decidable, and both agree.
  assert.deepEqual(optionClosure(problem, "B", observation), []);
  // ...so the same shape still reports the one clause that really differs.
  const wrong = optionClosure(problem, "C", observation);
  assert.equal(wrong.length, 1);
  assert.equal(
    wrong[0]?.detail,
    "option C asserts group order 8, but the exact group enumeration reports exactly 6",
  );
});

test("a negated or hedged option never asserts the group property", () => {
  const problem = [
    "关于由 (12) 与 (123) 生成的置换群，选择正确的选项：",
    "A. 该群不一定可交换",
    "B. 该群是不可交换的",
    "C. 该群不可交换，阶为 8",
    "D. 该群是可交换群",
    "E. 该群是交换群且为循环群",
  ].join("\n");
  const observation = optionGroupObservation(OPTION_GROUP_OBSERVATION);
  // Hedges and negations are not assertions.
  assert.deepEqual(optionClosure(problem, "A", observation), []);
  assert.deepEqual(optionClosure(problem, "B", observation), []);
  // A negative assertion cannot ground a numeric defect for a hedged clause...
  assert.deepEqual(
    optionClosure(problem, "C", observation).map((row) => row.kind),
    ["OPTION_NUMERIC_CONTRADICTION"],
  );
  // ...while a direct assertion of a refuted property is one defect per letter.
  const abelian = optionClosure(problem, "D", observation);
  assert.equal(abelian.length, 1);
  assert.equal(abelian[0]?.kind, "OPTION_VERDICT_CONTRADICTION");
  assert.equal(abelian[0]?.evidence, "OBSERVATION");
  assert.equal(
    abelian[0]?.detail,
    "option D asserts the group is abelian, but the exact group enumeration reports " +
      "is_abelian=false",
  );
  const both = optionClosure(problem, "E", observation);
  assert.equal(both.length, 1);
  assert.equal(
    both[0]?.detail,
    "option E asserts the group is abelian, but the exact group enumeration reports " +
      "is_abelian=false; option E asserts the group is cyclic, but the exact group " +
      "enumeration reports is_cyclic=false",
  );
});

test("the option diagnostics order letters and families deterministically", () => {
  const defects = optionClosure(
    OPTION_GROUP_PROBLEM,
    "B、C、D",
    optionGroupObservation(OPTION_GROUP_OBSERVATION),
  );
  assert.deepEqual(
    defects.map((row) => row.kind),
    ["OPTION_NUMERIC_CONTRADICTION", "OPTION_VERDICT_CONTRADICTION"],
  );
  assert.equal(
    defects[0]?.detail,
    "option B asserts group order 8, but the exact group enumeration reports " +
      "exactly 6; option C asserts conjugacy-class count 4, but the exact group " +
      "enumeration reports exactly 3",
  );
  // The same input always yields the same order.
  assert.deepEqual(
    optionClosure(
      OPTION_GROUP_PROBLEM,
      "B、C、D",
      optionGroupObservation(OPTION_GROUP_OBSERVATION),
    ).map((row) => row.detail),
    defects.map((row) => row.detail),
  );
});

test("an unlabelled bare number in a chosen option is never attributed", () => {
  const problem = [
    "关于由 (12) 与 (123) 生成的置换群，选择正确的选项：",
    "A. 阶为 8",
    "B. 该群的阶为 6，且中心的阶为 1",
    "C. 元素的阶为 2，共轭类个数为 3",
  ].join("\n");
  const observation = optionGroupObservation(OPTION_GROUP_OBSERVATION);
  assert.equal(
    optionClosure(problem, "A", observation)[0]?.kind,
    "OPTION_NUMERIC_CONTRADICTION",
  );
  // "中心的阶为 1" carries a number this check cannot attribute: silent.
  assert.deepEqual(optionClosure(problem, "B", observation), []);
  // `元素的阶` is a different quantity from the group order; the conjugacy
  // count in the same option still agrees.
  assert.deepEqual(optionClosure(problem, "C", observation), []);
});

test("a malformed group observation never throws for the option diagnostics", () => {
  const malformed: readonly unknown[] = [
    null,
    6,
    "6",
    { order: "6" },
    { order: 6 },
    { order: 6, conjugacy_classes: [] },
    { ...OPTION_GROUP_OBSERVATION, conjugacy_classes: [{ representative: "(1)" }] },
  ];
  for (const payload of malformed) {
    for (const candidate of ["B", "C", "D"]) {
      assert.deepEqual(
        optionClosure(OPTION_GROUP_PROBLEM, candidate, optionGroupObservation(payload)),
        [],
      );
    }
  }
  // A non-boolean verdict field is not a usable observation of that property, so
  // no verdict defect is invented for it (the numeric families still read fine).
  const abelianProblem = ["选择正确的选项：", "A. 该群是可交换群", "B. 该群是循环群"].join(
    "\n",
  );
  assert.deepEqual(
    optionClosure(
      abelianProblem,
      "A",
      optionGroupObservation({ ...OPTION_GROUP_OBSERVATION, is_abelian: "false" }),
    ),
    [],
  );
  assert.deepEqual(
    optionClosure(
      abelianProblem,
      "B",
      optionGroupObservation({ ...OPTION_GROUP_OBSERVATION, is_cyclic: null }),
    ),
    [],
  );
});

test("the closure note names the option letter with observed and asserted values", () => {
  const defects = optionClosure(
    OPTION_GROUP_PROBLEM,
    "B、D",
    optionGroupObservation(OPTION_GROUP_OBSERVATION),
  );
  const note = answerClosureNote(defects);
  assert.match(note, /OPTION_NUMERIC_CONTRADICTION: option B asserts group order 8/u);
  assert.match(note, /OPTION_VERDICT_CONTRADICTION: option D asserts/u);
  assert.match(note, /Reconcile the chosen option with the exact observation: option B/u);
  assert.match(note, /Reconcile the chosen option with the exact observation: option D/u);
  assert.doesNotMatch(note, /#\d+|item\s+\d+/iu);
});

// ---------------------------------------------------------------------------
// Observation-grounded diagnostics for the exact count/algebra/verdict tools:
// `gf2_rank`, `gf2_nullspace`, `bounded_enumeration`, `transition_count`,
// `count_by_digit_property`, `count_avoiding_permutations`,
// `cover_time_complete_graph` and `polynomial_function_check`.
//
// Every case is input-relative and fail-closed: one explicitly labelled number
// against one explicit observation, or no defect at all.
// ---------------------------------------------------------------------------

const GF2_RANK_PROBLEM = "求给定二元矩阵 M 在 GF(2) 上的秩。";

/** One `gf2_rank` observation view carrying a caller-given payload. */
function gf2RankObservation(result: unknown) {
  return [{ name: "gf2_rank", operation: null, result }];
}

/** One `gf2_nullspace` observation view carrying a caller-given payload. */
function gf2NullspaceObservation(result: unknown) {
  return [{ name: "gf2_nullspace", operation: null, result }];
}

/** One exact-count observation view for a counting operator. */
function countObservation(name: string, result: unknown) {
  return [{ name, operation: null, result }];
}

/** One `cover_time_complete_graph` observation view. */
function coverTimeObservation(result: unknown) {
  return [{ name: "cover_time_complete_graph", operation: null, result }];
}

/** One `polynomial_function_check` observation view. */
function identityObservation(result: unknown) {
  return [{ name: "polynomial_function_check", operation: null, result }];
}

const IDENTITY_PROBLEM = "判断 f(x)=x 是否满足 f(x+y)=f(x)+f(y)。";

test("a GF(2) rank observation contradicts only an explicit binary-field rank claim", () => {
  const wrong = answerClosureDefects({
    problemText: GF2_RANK_PROBLEM,
    candidate: "该矩阵在 GF(2) 上的秩为 2",
    packet: { candidateProposal: "该矩阵在 GF(2) 上的秩为 2" },
    toolObservations: gf2RankObservation(3),
  });
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0]?.kind, "GF2_RANK_MISMATCH");
  assert.equal(wrong[0]?.evidence, "OBSERVATION");
  assert.equal(
    wrong[0]?.detail,
    "the candidate asserts GF(2) rank 2, but the exact GF(2) elimination " +
      "reports exactly 3",
  );

  // The whole numeric candidate of a problem that *is* a GF(2)-rank question
  // states that rank itself.
  const bare = answerClosureDefects({
    problemText: GF2_RANK_PROBLEM,
    candidate: "$2$",
    packet: { candidateProposal: "2" },
    toolObservations: gf2RankObservation(3),
  });
  assert.equal(bare[0]?.kind, "GF2_RANK_MISMATCH");
  assert.equal(
    bare[0]?.detail,
    "the candidate states 2, but the exact GF(2) elimination reports exactly 3",
  );

  // Negatives: the agreeing claim, a bare rank over an unspecified field, a
  // problem that never names GF(2), and an absent observation.
  for (const agreeing of ["该矩阵在 GF(2) 上的秩为 3", "rank over GF(2) = 3", "3"]) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: GF2_RANK_PROBLEM,
        candidate: agreeing,
        packet: { candidateProposal: agreeing },
        toolObservations: gf2RankObservation(3),
      }),
      [],
    );
  }
  assert.deepEqual(
    answerClosureDefects({
      problemText: "求给定矩阵的秩。",
      candidate: "秩为 2",
      packet: { candidateProposal: "秩为 2" },
      toolObservations: gf2RankObservation(3),
    }),
    [],
  );
  assert.deepEqual(
    answerClosureDefects({
      problemText: "求给定矩阵的秩。",
      candidate: "2",
      packet: { candidateProposal: "2" },
      toolObservations: gf2RankObservation(3),
    }),
    [],
  );
  assert.deepEqual(
    answerClosureDefects({
      problemText: GF2_RANK_PROBLEM,
      candidate: "该矩阵在 GF(2) 上的秩为 2",
      packet: { candidateProposal: "该矩阵在 GF(2) 上的秩为 2" },
    }),
    [],
  );
});

test("a GF(2) nullspace observation contradicts only an explicit nullspace dimension", () => {
  const problem = "求该二元矩阵零空间的维数。";
  const wrong = answerClosureDefects({
    problemText: problem,
    candidate: "零空间维数为 3",
    packet: { candidateProposal: "零空间维数为 3" },
    toolObservations: gf2NullspaceObservation([3, 5]),
  });
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0]?.kind, "GF2_NULLITY_MISMATCH");
  assert.equal(wrong[0]?.evidence, "OBSERVATION");
  assert.equal(
    wrong[0]?.detail,
    "the candidate asserts nullspace dimension 3, but the exact GF(2) kernel " +
      "basis reports exactly 2",
  );

  // The producer may hand the basis over as `{nullspace: [...]}`; the nullity is
  // the basis length either way. An empty basis is the exact dimension 0.
  assert.equal(
    answerClosureDefects({
      problemText: problem,
      candidate: "nullity = 3",
      packet: { candidateProposal: "nullity = 3" },
      toolObservations: gf2NullspaceObservation({ nullspace: [1, 2] }),
    })[0]?.kind,
    "GF2_NULLITY_MISMATCH",
  );
  assert.equal(
    answerClosureDefects({
      problemText: problem,
      candidate: "零空间维数为 1",
      packet: { candidateProposal: "零空间维数为 1" },
      toolObservations: gf2NullspaceObservation([]),
    })[0]?.kind,
    "GF2_NULLITY_MISMATCH",
  );

  // Negatives: agreement, a `维数` that is not a nullspace dimension, and an
  // absent observation.
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "零空间维数为 2",
      packet: { candidateProposal: "零空间维数为 2" },
      toolObservations: gf2NullspaceObservation([3, 5]),
    }),
    [],
  );
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "该矩阵的列空间维数为 3",
      packet: { candidateProposal: "该矩阵的列空间维数为 3" },
      toolObservations: gf2NullspaceObservation([3, 5]),
    }),
    [],
  );
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "零空间维数为 3",
      packet: { candidateProposal: "零空间维数为 3" },
    }),
    [],
  );
});

test("an exact count observation never compares a fraction and never guesses between counts", () => {
  const problem = "求满足条件的序列个数。";
  const pureWrong = answerClosureDefects({
    problemText: problem,
    candidate: "5",
    packet: { candidateProposal: "5" },
    toolObservations: countObservation("transition_count", 8),
  });
  assert.equal(pureWrong.length, 1);
  assert.equal(pureWrong[0]?.kind, "EXACT_COUNT_MISMATCH");
  assert.equal(pureWrong[0]?.evidence, "OBSERVATION");
  assert.equal(
    pureWrong[0]?.detail,
    "the candidate states 5, but the exact transition count reports exactly 8",
  );

  // The labelled form and a chosen option are read the same way.
  assert.equal(
    answerClosureDefects({
      problemText: problem,
      candidate: "共有 5 种",
      packet: { candidateProposal: "共有 5 种" },
      toolObservations: countObservation("count_by_digit_property", 8),
    })[0]?.detail,
    "the candidate asserts exact count 5, but the exact digit-property count " +
      "reports exactly 8",
  );
  const optionProblem = [
    "求满足条件的排列个数，选择正确的选项：",
    "A. 共有 8 种",
    "B. 共有 5 种",
  ].join("\n");
  const optionDefect = optionClosure(
    optionProblem,
    "B",
    countObservation("count_avoiding_permutations", 8),
  );
  assert.equal(optionDefect.length, 1);
  assert.equal(optionDefect[0]?.kind, "EXACT_COUNT_MISMATCH");
  assert.equal(
    optionDefect[0]?.detail,
    "option B asserts exact count 5, but the exact forbidden-cell permutation " +
      "count reports exactly 8",
  );
  assert.deepEqual(
    optionClosure(optionProblem, "A", countObservation("count_avoiding_permutations", 8)),
    [],
  );

  // The fraction-skip rule: a probability answer is never compared to a count,
  // and a fraction-shaped observation never grounds a plain-integer comparison.
  assert.deepEqual(
    answerClosureDefects({
      problemText: "求从中随机取两个对象恰好满足条件的概率。",
      candidate: "223/8330",
      packet: { candidateProposal: "223/8330" },
      toolObservations: countObservation("bounded_enumeration", { count: 223 }),
    }),
    [],
  );
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "共有 5 种",
      packet: { candidateProposal: "共有 5 种" },
      toolObservations: countObservation("bounded_enumeration", {
        favorable: 3,
        total: 10,
        fraction: "3/10",
      }),
    }),
    [],
  );
  // Two different exact counts in one run make the candidate's number
  // unattributable, so nothing is compared.
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "5",
      packet: { candidateProposal: "5" },
      toolObservations: [
        { name: "transition_count", operation: null, result: 8 },
        { name: "count_by_digit_property", operation: null, result: 9 },
      ],
    }),
    [],
  );
  // `bounded_enumeration` reports `{count}`: that is the exact count.
  assert.equal(
    answerClosureDefects({
      problemText: problem,
      candidate: "共有 5 种",
      packet: { candidateProposal: "共有 5 种" },
      toolObservations: countObservation("bounded_enumeration", { count: 8 }),
    })[0]?.detail,
    "the candidate asserts exact count 5, but the exact bounded enumeration " +
      "reports exactly 8",
  );
  // An agreeing count, a suffix-carrying agreeing count and a non-count payload
  // are all clean.
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "$8$ 个",
      packet: { candidateProposal: "$8$ 个" },
      toolObservations: countObservation("transition_count", 8),
    }),
    [],
  );
  for (const payload of [-5, 1.5, "many", { count: -1 }, null]) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: problem,
        candidate: "5",
        packet: { candidateProposal: "5" },
        toolObservations: countObservation("transition_count", payload),
      }),
      [],
    );
  }
});

test("a cover-time observation contradicts only an explicit exact cover-time claim", () => {
  const problem = "求完全图 K_4 上简单随机游走的期望覆盖时间。";
  const wrong = answerClosureDefects({
    problemText: problem,
    candidate: "期望覆盖时间为 5",
    packet: { candidateProposal: "期望覆盖时间为 5" },
    toolObservations: coverTimeObservation("11/2"),
  });
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0]?.kind, "COVER_TIME_MISMATCH");
  assert.equal(wrong[0]?.evidence, "OBSERVATION");
  assert.equal(
    wrong[0]?.detail,
    "the candidate asserts expected cover time 5, but the exact cover-time " +
      "closed form reports exactly 11/2",
  );

  // Negatives: the exact rational in another notation, a float payload (never an
  // exact value), an unlabelled number and an absent observation.
  for (const candidate of ["期望覆盖时间为 11/2", "cover time = 11/2"]) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: problem,
        candidate,
        packet: { candidateProposal: candidate },
        toolObservations: coverTimeObservation("11/2"),
      }),
      [],
    );
  }
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "期望覆盖时间为 5",
      packet: { candidateProposal: "期望覆盖时间为 5" },
      toolObservations: coverTimeObservation(5.5),
    }),
    [],
  );
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "游走 5 步后返回",
      packet: { candidateProposal: "游走 5 步后返回" },
      toolObservations: coverTimeObservation("11/2"),
    }),
    [],
  );
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "期望覆盖时间为 5",
      packet: { candidateProposal: "期望覆盖时间为 5" },
    }),
    [],
  );
  // An exact integer closed form is compared exactly.
  assert.equal(
    answerClosureDefects({
      problemText: problem,
      candidate: "期望覆盖时间为 5",
      packet: { candidateProposal: "期望覆盖时间为 5" },
      toolObservations: coverTimeObservation({ value: 4 }),
    })[0]?.kind,
    "COVER_TIME_MISMATCH",
  );
});

test("a pure verdict contradicts polynomial_function_check only when the residual refutes it", () => {
  const refuted = {
    identity_holds: false,
    residual_terms: [[[1, 1], "2"]],
    witness: { point: [1, 1], residual: "2" },
  };
  const affirmative = answerClosureDefects({
    problemText: IDENTITY_PROBLEM,
    candidate: "成立",
    packet: { candidateProposal: "成立" },
    toolObservations: identityObservation(refuted),
  });
  assert.equal(affirmative.length, 1);
  assert.equal(affirmative[0]?.kind, "IDENTITY_VERDICT_MISMATCH");
  assert.equal(affirmative[0]?.evidence, "OBSERVATION");
  assert.equal(
    affirmative[0]?.detail,
    "the exact residual computation reports identity_holds=false with witness " +
      "point [1,1] residual 2, but the candidate states the pure verdict 成立",
  );

  // The symmetric case: a negative verdict against a proven identity.
  const negative = answerClosureDefects({
    problemText: IDENTITY_PROBLEM,
    candidate: "$\\boxed{假}$",
    packet: { candidateProposal: "假" },
    toolObservations: identityObservation({ identity_holds: true, witness: null }),
  });
  assert.equal(negative.length, 1);
  assert.equal(
    negative[0]?.detail,
    "the exact residual computation reports identity_holds=true, but the " +
      "candidate states the pure verdict $\\boxed{假}$",
  );

  // Negatives: the verdict that agrees, prose, a hedged verdict and a payload
  // whose verdict field is not a real boolean.
  for (const candidate of ["不成立", "该函数成立当且仅当 x=1", "不一定成立"]) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: IDENTITY_PROBLEM,
        candidate,
        packet: { candidateProposal: candidate },
        toolObservations: identityObservation(refuted),
      }),
      [],
    );
  }
  for (const payload of [
    null,
    [],
    { identity_holds: "false" },
    { identity_holds: 0 },
    { residual_terms: [] },
  ]) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: IDENTITY_PROBLEM,
        candidate: "成立",
        packet: { candidateProposal: "成立" },
        toolObservations: identityObservation(payload),
      }),
      [],
    );
  }
});

test("the new observation diagnostics stay silent on ambiguity, negation and hedges", () => {
  const sequenceCount = countObservation("transition_count", 8);
  const twoNumbersProblem = "求满足条件的序列个数，选择正确的选项：";
  // Two labelled numbers in one clause: which one is the count is undecidable.
  assert.deepEqual(
    answerClosureDefects({
      problemText: twoNumbersProblem,
      candidate: "共有 5 种或 6 种",
      packet: { candidateProposal: "共有 5 种或 6 种" },
      toolObservations: sequenceCount,
    }),
    [],
  );
  // Two labelled numbers in two clauses: the count claim is still ambiguous.
  assert.deepEqual(
    answerClosureDefects({
      problemText: twoNumbersProblem,
      candidate: "共有 5 种情形，另有 6 种排列",
      packet: { candidateProposal: "共有 5 种情形，另有 6 种排列" },
      toolObservations: sequenceCount,
    }),
    [],
  );
  // An unattributed number in the same clause yields no defect at all.
  assert.deepEqual(
    answerClosureDefects({
      problemText: twoNumbersProblem,
      candidate: "该矩阵的 2 个行向量共有 5 个满足条件的序列",
      packet: { candidateProposal: "该矩阵的 2 个行向量共有 5 个满足条件的序列" },
      toolObservations: sequenceCount,
    }),
    [],
  );
  // Negations and hedges never assert a value.
  for (const candidate of ["共有 5 种不成立", "可能共有 5 种", "未必共有 5 种", "一定不是 5 种"]) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: twoNumbersProblem,
        candidate,
        packet: { candidateProposal: candidate },
        toolObservations: sequenceCount,
      }),
      [],
    );
  }
  // The same rules hold for the GF(2) families.
  for (const candidate of ["GF(2) 上秩为 2 或 3", "GF(2) 上的秩不是 2", "秩可能为 2"]) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: GF2_RANK_PROBLEM,
        candidate,
        packet: { candidateProposal: candidate },
        toolObservations: gf2RankObservation(3),
      }),
      [],
    );
  }
});

test("malformed observations for the new diagnostics never throw", () => {
  const cases: readonly {
    readonly problemText: string;
    readonly candidate: string;
    readonly observations: readonly { name: string; operation: null; result: unknown }[];
  }[] = [
    {
      problemText: GF2_RANK_PROBLEM,
      candidate: "该矩阵在 GF(2) 上的秩为 2",
      observations: gf2RankObservation({ rank: 3 }),
    },
    {
      problemText: GF2_RANK_PROBLEM,
      candidate: "该矩阵在 GF(2) 上的秩为 2",
      observations: gf2RankObservation(-3),
    },
    {
      problemText: GF2_RANK_PROBLEM,
      candidate: "该矩阵在 GF(2) 上的秩为 2",
      observations: gf2RankObservation("三"),
    },
    {
      problemText: "求零空间维数。",
      candidate: "零空间维数为 3",
      observations: gf2NullspaceObservation({ rows: [3, 5] }),
    },
    {
      problemText: "求零空间维数。",
      candidate: "零空间维数为 3",
      observations: gf2NullspaceObservation([1.5, 3]),
    },
    {
      problemText: "求零空间维数。",
      candidate: "零空间维数为 3",
      observations: gf2NullspaceObservation("basis"),
    },
    {
      problemText: "求序列个数。",
      candidate: "共有 5 种",
      observations: countObservation("transition_count", { value: "8/3" }),
    },
    {
      problemText: "求覆盖时间。",
      candidate: "期望覆盖时间为 5",
      observations: coverTimeObservation("five"),
    },
    {
      problemText: "求覆盖时间。",
      candidate: "期望覆盖时间为 5",
      observations: coverTimeObservation([1, 2]),
    },
    {
      problemText: IDENTITY_PROBLEM,
      candidate: "成立",
      observations: identityObservation("false"),
    },
  ];
  for (const row of cases) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: row.problemText,
        candidate: row.candidate,
        packet: { candidateProposal: row.candidate },
        toolObservations: row.observations,
      }),
      [],
    );
  }
  // An unusable witness does not make the verdict unusable: the defect is still
  // reported, without a witness phrase it cannot justify.
  const noWitness = answerClosureDefects({
    problemText: IDENTITY_PROBLEM,
    candidate: "成立",
    packet: { candidateProposal: "成立" },
    toolObservations: identityObservation({ identity_holds: false, witness: "x=1" }),
  });
  assert.equal(noWitness.length, 1);
  assert.equal(
    noWitness[0]?.detail,
    "the exact residual computation reports identity_holds=false, but the " +
      "candidate states the pure verdict 成立",
  );
  // A structurally broken observation list is ignored rather than thrown on.
  for (const broken of [null, [], [null], [{ name: "gf2_rank" }]]) {
    assert.deepEqual(
      answerClosureDefects({
        problemText: GF2_RANK_PROBLEM,
        candidate: "该矩阵在 GF(2) 上的秩为 2",
        packet: { candidateProposal: "该矩阵在 GF(2) 上的秩为 2" },
        toolObservations: broken as never,
      }),
      [],
    );
  }
});

test("the new defect kinds sit after the option kinds and before solution completeness", () => {
  const problem = [
    "关于给定二元矩阵与相关计数，选择正确的选项：",
    "A. 该群的阶为 6",
    "B. 该群的阶为 8",
    "C. 该群是可交换群",
    "D. 该群是循环群",
  ].join("\n");
  const candidate =
    "B、C；另外 M 在 GF(2) 上的秩为 2；零空间维数为 3；共有 5 种；期望覆盖时间为 5";
  const defects = answerClosureDefects({
    problemText: problem,
    candidate,
    packet: {
      candidateProposal: candidate,
      suggestedChecks: [
        "CERT1|OPTIONS|A=TRUE,B=TRUE,C=TRUE,D=FALSE",
      ],
    },
    toolObservations: [
      {
        name: "finite_group_structure",
        operation: "GROUP_STRUCTURE",
        result: OPTION_GROUP_OBSERVATION,
      },
      { name: "gf2_rank", operation: null, result: 3 },
      { name: "gf2_nullspace", operation: null, result: [1, 2] },
      { name: "transition_count", operation: null, result: 8 },
      { name: "cover_time_complete_graph", operation: null, result: "11/2" },
    ],
    expectedSolutionKeys: ["1/1"],
    requiresExhaustive: true,
  });
  assert.deepEqual(
    defects.map((row) => row.kind),
    [
      "OPTION_NUMERIC_CONTRADICTION",
      "OPTION_VERDICT_CONTRADICTION",
      "GF2_RANK_MISMATCH",
      "GF2_NULLITY_MISMATCH",
      "EXACT_COUNT_MISMATCH",
      "COVER_TIME_MISMATCH",
      "SOLUTION_COMPLETENESS",
    ],
  );
  // Every new kind is observation-grounded.
  for (const row of defects.slice(2, 6)) {
    assert.equal(row.evidence, "OBSERVATION");
  }
  // The identity verdict kind is documented between the option kinds and the
  // completeness check as well.
  assert.deepEqual(
    answerClosureDefects({
      problemText: IDENTITY_PROBLEM,
      candidate: "成立",
      packet: { candidateProposal: "成立" },
      toolObservations: identityObservation({ identity_holds: false }),
      expectedSolutionKeys: ["1/1"],
      requiresExhaustive: true,
    }).map((row) => row.kind),
    ["IDENTITY_VERDICT_MISMATCH", "SOLUTION_COMPLETENESS"],
  );
  // The same input always yields the same order.
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate,
      packet: {
        candidateProposal: candidate,
        suggestedChecks: [
          "CERT1|OPTIONS|A=TRUE,B=TRUE,C=TRUE,D=FALSE",
        ],
      },
      toolObservations: [
        {
          name: "finite_group_structure",
          operation: "GROUP_STRUCTURE",
          result: OPTION_GROUP_OBSERVATION,
        },
        { name: "gf2_rank", operation: null, result: 3 },
        { name: "gf2_nullspace", operation: null, result: [1, 2] },
        { name: "transition_count", operation: null, result: 8 },
        { name: "cover_time_complete_graph", operation: null, result: "11/2" },
      ].reverse(),
      expectedSolutionKeys: ["1/1"],
      requiresExhaustive: true,
    }).map((row) => row.kind),
    defects.map((row) => row.kind),
  );
});

test("the '[' bracket is still not an option marker for the new option checks", () => {
  // `[E:Q]=8` inside an option body must not be read as option E, so the block
  // stays a clean A..B table and only the chosen letter is compared.
  const problem = [
    "求二元矩阵在 GF(2) 上的秩，选择正确的选项：",
    "A. [E:Q]=8，GF(2) 上的秩为 3",
    "B. [E:Q]=6，GF(2) 上的秩为 2",
  ].join("\n");
  assert.deepEqual(problemOptionTexts(problem), [
    { letter: "A", text: "[E:Q]=8，GF(2) 上的秩为 3" },
    { letter: "B", text: "[E:Q]=6，GF(2) 上的秩为 2" },
  ]);
  const wrong = optionClosure(problem, "B", gf2RankObservation(3));
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0]?.kind, "GF2_RANK_MISMATCH");
  assert.equal(
    wrong[0]?.detail,
    "option B asserts GF(2) rank 2, but the exact GF(2) elimination reports " +
      "exactly 3",
  );
  assert.deepEqual(optionClosure(problem, "A", gf2RankObservation(3)), []);
});

test("the closure note names the observed value for each new defect kind", () => {
  const rankNote = answerClosureNote([
    {
      kind: "GF2_RANK_MISMATCH",
      detail: "the candidate asserts GF(2) rank 2, but the exact GF(2) elimination reports exactly 3",
    },
  ]);
  assert.match(rankNote, /- GF2_RANK_MISMATCH: the candidate asserts GF\(2\) rank 2/u);
  assert.match(rankNote, /rank over GF\(2\)/u);
  assert.match(
    answerClosureNote([
      { kind: "GF2_NULLITY_MISMATCH", detail: "nullspace dimension 3 versus 2" },
    ]),
    /nullspace dimension/u,
  );
  assert.match(
    answerClosureNote([{ kind: "EXACT_COUNT_MISMATCH", detail: "5 versus 8" }]),
    /a probability is not a count/u,
  );
  assert.match(
    answerClosureNote([{ kind: "COVER_TIME_MISMATCH", detail: "5 versus 11\/2" }]),
    /expected cover time/u,
  );
  assert.match(
    answerClosureNote([
      { kind: "IDENTITY_VERDICT_MISMATCH", detail: "identity_holds=false" },
    ]),
    /verdict on the functional identity/u,
  );
  // An unrelated defect set gets none of these hints.
  const unrelated = answerClosureNote([
    { kind: "DEGREE_CONSERVATION", detail: "degree 6 versus 2" },
  ]);
  assert.doesNotMatch(unrelated, /GF\(2\) rank|expected cover time|functional identity/u);
  assert.doesNotMatch(rankNote, /#\d+|item\s+\d+/iu);
});

test("degree conservation includes the exact polynomial and compares equal degrees up to a Laurent unit", () => {
  const problem = "计算亚历山大多项式 P(t)。";
  const observed = {
    operation: "MAXIMAL_MINORS",
    normalized_minors: [
      { polynomial: "t**3 - 3*t**2 + t", multiplicity: 2 },
    ],
  };
  const impostor = answerClosureDefects({
    problemText: problem,
    candidate: "t^3 + 1",
    packet: { candidateProposal: "t^3 + 1" },
    exactObservation: observed,
  });
  assert.equal(impostor[0]?.kind, "DEGREE_CONSERVATION");
  assert.equal(impostor[0]?.evidence, "OBSERVATION");
  assert.match(impostor[0]?.detail ?? "", /t\*\*3 - 3\*t\*\*2 \+ t/u);
  assert.match(impostor[0]?.detail ?? "", /coefficients do not match/u);

  // `t^3 - 3t^2 + t` and `t^2 - 3t + 1` differ by the Alexander unit t.
  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "t^2 - 3*t + 1",
      packet: { candidateProposal: "t^2 - 3*t + 1" },
      exactObservation: observed,
    }),
    [],
  );
});

test("observation defects no longer require the same semantic route", () => {
  const roots = answerClosureDefects({
    problemText: "求函数 f(x)=x^3-x 的零点个数。",
    candidate: "3",
    packet: { candidateProposal: "3" },
    toolObservations: [
      { name: "real_root_count_expr", operation: "REAL_ROOT_COUNT", result: 2 },
    ],
  });
  assert.equal(roots[0]?.kind, "REAL_ROOT_COUNT");

  const splitting = answerClosureDefects({
    problemText: "求扩张 [K:Q] 的次数。",
    candidate: "16",
    packet: { candidateProposal: "16" },
    toolObservations: [
      {
        name: "splitting_field_degree_expr",
        operation: "SPLITTING_FIELD_DEGREE",
        result: 8,
      },
    ],
  });
  assert.equal(splitting[0]?.kind, "SPLITTING_FIELD_DEGREE");

  const interpolation = answerClosureDefects({
    problemText: "给定两个点 (0,0),(1,1)，候选多项式为 x+1，核对残差。",
    candidate: "x+1",
    packet: { candidateProposal: "x+1" },
    toolObservations: [
      {
        name: "interpolation_fit_check",
        operation: "INTERPOLATION_FIT",
        result: {
          all_zero: false,
          residuals: ["1/2"],
          variable: "x",
          interpolating_polynomial: "x",
        },
      },
    ],
  });
  assert.equal(interpolation[0]?.kind, "INTERPOLATION_RESIDUAL");
});

test("exact scalar observations catch LIMIT, DEFINITE_INTEGRAL, SIMPLIFY and TRIG_REDUCE mismatches", () => {
  const cases = [
    ["LIMIT", { operation: "LIMIT", limit: "1/2" }, "1"],
    ["DEFINITE_INTEGRAL", { operation: "DEFINITE_INTEGRAL", exact: "pi/2" }, "0"],
    ["SIMPLIFY", { operation: "SIMPLIFY", simplified: "1/3" }, "1/2"],
    ["TRIG_REDUCE", { operation: "TRIG_REDUCE", trig_reduced: "1" }, "0"],
  ] as const;
  for (const [, observation, candidate] of cases) {
    const defects = answerClosureDefects({
      problemText: "计算下列精确值。",
      candidate,
      packet: { candidateProposal: candidate },
      exactObservation: observation,
    });
    assert.equal(defects[0]?.kind, "EXACT_VALUE_MISMATCH", candidate);
    assert.equal(defects[0]?.evidence, "OBSERVATION");
    assert.match(defects[0]?.detail ?? "", /exact_check_expr\[/u);
  }

  // A symbolic candidate with free variables is not coerced into a scalar.
  assert.deepEqual(
    answerClosureDefects({
      problemText: "计算下列精确值。",
      candidate: "pi*(1+ab)*exp(-ab)/(2*b^3)",
      packet: { candidateProposal: "pi*(1+ab)*exp(-ab)/(2*b^3)" },
      exactObservation: { operation: "DEFINITE_INTEGRAL", exact: "pi/2" },
    }),
    [],
  );
  // Standard TeX fractions are the same scalar, not an unknown expression.
  assert.deepEqual(
    answerClosureDefects({
      problemText: "计算下列精确值。",
      candidate: "\\frac{\\pi}{2}",
      packet: { candidateProposal: "\\frac{\\pi}{2}" },
      exactObservation: { operation: "LIMIT", limit: "pi/2" },
    }),
    [],
  );
  assert.equal(
    answerClosureDefects({
      problemText: "计算下列精确值。",
      candidate: "\\frac{\\sqrt{2}}{2}",
      packet: { candidateProposal: "\\frac{\\sqrt{2}}{2}" },
      exactObservation: { operation: "LIMIT", limit: "1/2" },
    })[0]?.kind,
    "EXACT_VALUE_MISMATCH",
  );
});

test("exact scalar observations compare a chosen option body when the candidate is one letter", () => {
  const problem = "求极限。\nA. 1/2\nB. 1/3";
  const wrong = answerClosureDefects({
    problemText: problem,
    candidate: "B",
    packet: {
      candidateProposal: "B",
      suggestedChecks: ["CERT1|OPTIONS|A=TRUE,B=FALSE"],
    },
    exactObservation: { operation: "LIMIT", limit: "1/2" },
  });
  assert.equal(wrong[0]?.kind, "EXACT_VALUE_MISMATCH");
  assert.match(wrong[0]?.detail ?? "", /1\/3/u);

  assert.deepEqual(
    answerClosureDefects({
      problemText: problem,
      candidate: "A",
      packet: {
        candidateProposal: "A",
        suggestedChecks: ["CERT1|OPTIONS|A=TRUE,B=FALSE"],
      },
      exactObservation: { operation: "LIMIT", limit: "1/2" },
    }),
    [],
  );
});

test("linear-system observations enforce the exact solution status", () => {
  const observation = (kind: string) => [
    {
      name: "linear_system_solution_set",
      operation: "SOLUTION_SET",
      result: { kind, rank: 2, basis: [] },
    },
  ];
  const empty = answerClosureDefects({
    problemText: "解线性方程组。",
    candidate: "该方程组有唯一解",
    packet: { candidateProposal: "该方程组有唯一解" },
    toolObservations: observation("EMPTY"),
  });
  assert.equal(empty[0]?.kind, "LINEAR_SYSTEM_STATUS_MISMATCH");
  assert.match(empty[0]?.detail ?? "", /kind EMPTY/u);

  const unique = answerClosureDefects({
    problemText: "解线性方程组。",
    candidate: "无解",
    packet: { candidateProposal: "无解" },
    toolObservations: observation("UNIQUE"),
  });
  assert.equal(unique[0]?.kind, "LINEAR_SYSTEM_STATUS_MISMATCH");

  const affine = answerClosureDefects({
    problemText: "解线性方程组。",
    candidate: "唯一解",
    packet: { candidateProposal: "唯一解" },
    toolObservations: observation("AFFINE"),
  });
  assert.equal(affine[0]?.kind, "LINEAR_SYSTEM_STATUS_MISMATCH");

  assert.deepEqual(
    answerClosureDefects({
      problemText: "解线性方程组。",
      candidate: "唯一解",
      packet: { candidateProposal: "唯一解" },
      toolObservations: observation("UNIQUE"),
    }),
    [],
  );
  // A unique status is not enough: an explicit vector must match `particular`.
  const uniqueObservation = [
    {
      name: "linear_system_solution_set",
      operation: "SOLUTION_SET",
      result: { kind: "UNIQUE", rank: 2, basis: [], particular: ["1", "-2"] },
    },
  ];
  const vectorClosure = (candidate: string) =>
    answerClosureDefects({
      problemText: "解线性方程组。",
      candidate,
      packet: { candidateProposal: candidate },
      toolObservations: uniqueObservation,
    });
  const wrongVector = vectorClosure("唯一解为 (1, 2)");
  assert.equal(wrongVector[0]?.kind, "LINEAR_SYSTEM_STATUS_MISMATCH");
  assert.match(wrongVector[0]?.detail ?? "", /\[1,2\]/u);
  assert.equal(
    vectorClosure("唯一解为 x=1,y=3")[0]?.kind,
    "LINEAR_SYSTEM_STATUS_MISMATCH",
  );
  assert.deepEqual(vectorClosure("(1, -2)"), []);
  assert.deepEqual(vectorClosure("x=1, y=-2"), []);
  // A function call `f(1,2)` is not a solution vector.
  assert.deepEqual(vectorClosure("f(1,2)"), []);
  // A one-dimensional unique solution keeps the same check.
  const oneDimensional = answerClosureDefects({
    problemText: "解线性方程组。",
    candidate: "x=2",
    packet: { candidateProposal: "x=2" },
    toolObservations: [
      {
        name: "linear_system_solution_set",
        operation: "SOLUTION_SET",
        result: { kind: "UNIQUE", rank: 1, particular: ["1"] },
      },
    ],
  });
  assert.equal(oneDimensional[0]?.kind, "LINEAR_SYSTEM_STATUS_MISMATCH");
  // A bare status is not a vector claim and stays accepted.
  assert.deepEqual(vectorClosure("唯一解"), []);
});

test("closure note has actionable hints for the new observation defects and preserves certificates", () => {
  const note = answerClosureNote([
    { kind: "DEGREE_CONSERVATION", detail: "degree 6 versus 2" },
    { kind: "EXACT_VALUE_MISMATCH", detail: "1/2 versus 1" },
    { kind: "LINEAR_SYSTEM_STATUS_MISMATCH", detail: "kind EMPTY" },
  ]);
  assert.match(note, /exact maximal-minor polynomial/u);
  assert.match(note, /exact_check_expr\[MAXIMAL_MINORS\]/u);
  assert.match(note, /Preserve all valid `CERT1\|\.\.\.` rows/u);
  assert.match(note, /EMPTY means no solution/u);
});
