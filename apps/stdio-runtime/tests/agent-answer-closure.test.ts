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
  assert.deepEqual(
    answerClosureDefects({
      problemText: "计算三阶行列式的值。",
      candidate: "x^2 + 2",
      packet: { candidateProposal: "x^2 + 2" },
      toolObservations: interpolationObservation(FAILING_INTERPOLATION),
    }),
    [],
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
  toolObservations?: readonly { name: string; operation: string; result: unknown }[],
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
