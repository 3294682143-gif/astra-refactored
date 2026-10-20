/**
 * @astra/math-contract — P2-A M1 contract compiler.
 *
 * Builds a versioned P2 contract from the original problem text. The problem
 * text is kept verbatim and identified by sha256. Goal selection is a
 * conservative single-class keyword template: it is a work view, never a
 * claim that the template is semantically equivalent to the problem, and
 * `semanticStatus` stays `UNKNOWN`. No obligation is ever SATISFIED here.
 */

import { createHash } from "node:crypto";

import {
  P2_LIMITS,
  P2Error,
  P2_ERROR_CODES,
  canonicalScope,
  detectLoneSurrogates,
  p2Snapshot,
  validateP2GoalSpecs,
  type P2Contract,
  type P2GoalKind,
  type P2GoalSpec,
  type P2Obligation,
  type P2ObligationKind,
  type P2Task,
  type RecordEnvelope,
  type Scope,
} from "@astra/protocol";

export const P2_COMPILER_VERSION = "0.0.0-p2a" as const;

/** sha256 of the exact UTF-8 bytes of the problem text, lowercase hex. */
export function p2ProblemHashOf(problem: string): string {
  return createHash("sha256").update(problem, "utf8").digest("hex");
}

/** Deterministic scope identity: sha256 over the canonical scope JSON. */
export function p2ScopeIdOf(scope: Scope): string {
  return createHash("sha256").update(canonicalScope(scope), "utf8").digest("hex");
}

const KIND_OBLIGATIONS: Readonly<Record<P2GoalKind, readonly P2ObligationKind[]>> = {
  VALUE: ["DOMAIN_VALIDITY", "CANDIDATE_VALIDITY", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
  ALL_SOLUTIONS: [
    "DOMAIN_VALIDITY",
    "CANDIDATE_VALIDITY",
    "BOUNDARY_EXCEPTIONS",
    "EXHAUSTIVENESS",
    "INDEPENDENT_DERIVATION",
    "OUTPUT_COVERAGE",
  ],
  COUNT: [
    "COUNT_OBJECTS",
    "NO_DUPLICATES",
    "EXHAUSTIVENESS",
    "INDEPENDENT_DERIVATION",
    "OUTPUT_COVERAGE",
  ],
  OPTIMIZATION: [
    "FEASIBILITY",
    "GLOBAL_BOUND",
    "ATTAINMENT",
    "INDEPENDENT_DERIVATION",
    "OUTPUT_COVERAGE",
  ],
  PROOF: ["PREMISES", "QUANTIFIERS", "PROOF_GOAL", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
  PARAMETER: [
    "DOMAIN_VALIDITY",
    "BOUNDARY_EXCEPTIONS",
    "INDEPENDENT_DERIVATION",
    "OUTPUT_COVERAGE",
  ],
  MULTIPART: ["SUBGOAL_COVERAGE", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
  UNKNOWN: ["ANSWER_REQUEST", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
};

/** Fixed expected-result strings. They describe the work, not a proof. */
const KIND_EXPECTED: Readonly<Record<P2ObligationKind, string>> = {
  DOMAIN_VALIDITY: "state the declared domain and its validity conditions",
  CANDIDATE_VALIDITY: "state candidate(s) and their validity conditions",
  BOUNDARY_EXCEPTIONS: "state boundary cases and exceptions",
  EXHAUSTIVENESS: "state why the candidate set is exhaustive over the declared domain",
  COUNT_OBJECTS: "state the counted objects and the counting basis",
  NO_DUPLICATES: "state why no object is counted twice",
  FEASIBILITY: "state the feasible region under the declared constraints",
  GLOBAL_BOUND: "state a global bound over the declared domain",
  ATTAINMENT: "state whether the bound is attained and where",
  PREMISES: "state the premises used",
  QUANTIFIERS: "state the quantifier structure used",
  PROOF_GOAL: "state the proof goal and its steps",
  SUBGOAL_COVERAGE: "state how the declared subgoals are covered",
  INDEPENDENT_DERIVATION:
    "state a second derivation of the answer that does not reuse the first one, and state whether it agrees with the stated candidate",
  OUTPUT_COVERAGE: "state how the requested output is covered",
  ANSWER_REQUEST: "state the requested answer",
};

const KIND_ACCEPTANCE: Readonly<Record<P2ObligationKind, string>> = {
  DOMAIN_VALIDITY: "domain-validity-review",
  CANDIDATE_VALIDITY: "candidate-validity-review",
  BOUNDARY_EXCEPTIONS: "boundary-exceptions-review",
  EXHAUSTIVENESS: "exhaustiveness-review",
  COUNT_OBJECTS: "count-objects-review",
  NO_DUPLICATES: "no-duplicates-review",
  FEASIBILITY: "feasibility-review",
  GLOBAL_BOUND: "global-bound-review",
  ATTAINMENT: "attainment-review",
  PREMISES: "premises-review",
  QUANTIFIERS: "quantifiers-review",
  PROOF_GOAL: "proof-goal-review",
  SUBGOAL_COVERAGE: "subgoal-coverage-review",
  INDEPENDENT_DERIVATION: "independent-derivation-review",
  OUTPUT_COVERAGE: "output-coverage-review",
  ANSWER_REQUEST: "answer-request-review",
};

const ALL_SOLUTIONS_PATTERN =
  /(?:全部|所有)(?:实数|复数)?解|all\s+(?:real\s+|complex\s+)?solutions?/;

/**
 * A real multi-part problem statement: at least two independently labelled
 * sub-questions. The pattern only recognises an explicit ordered label
 * sequence `(a) ... (b) ...` (or `a) ... b) ...`), so a single labelled part
 * or an unlabelled sentence never becomes MULTIPART. It is a work view, never
 * a claim that the template is semantically equivalent to the problem.
 */
const MULTIPART_PART_PATTERN =
  /(?:^|[\s,;:。；：])(?:\(([a-h])\)|([a-h])\))\s*\S/gu;

/**
 * The ordered distinct sub-question labels of a real multi-part statement.
 * Returns an empty list unless at least two distinct labels appear in
 * ascending order, so `(b) ... (a) ...` and a repeated single label are not
 * multi-part. Nothing here is a mathematical parse.
 */
export function multipartPartLabels(problem: string): readonly string[] {
  const labels: string[] = [];
  for (const match of problem.matchAll(MULTIPART_PART_PATTERN)) {
    const label = match[1] ?? match[2];
    if (typeof label !== "string") {
      continue;
    }
    if (!labels.includes(label)) {
      labels.push(label);
    }
  }
  if (labels.length < 2) {
    return [];
  }
  const sorted = [...labels].sort();
  for (let index = 0; index < labels.length; index += 1) {
    if (labels[index] !== sorted[index]) {
      return [];
    }
  }
  return labels;
}

const KEYWORD_RULES: readonly (readonly [P2GoalKind, readonly string[]])[] = [
  ["COUNT", ["number of", "how many", "计数", "个数"]],
  ["OPTIMIZATION", ["maximum", "minimum", "maximize", "minimize", "最大", "最小"]],
  ["PROOF", ["prove", "proof", "证明"]],
  ["VALUE", ["compute", "evaluate", "calculate", "计算", "求值"]],
];

/**
 * Conservative parameter-classification rule. A problem is a parameter
 * problem only when it names a parameter AND asks for a classification, a
 * range of values or the value of that parameter. Both halves are required, so
 * a problem that merely mentions a parameter (e.g. "compute the value of x
 * given parameter a") is not reclassified. This is a work view, never a
 * semantic parse, and it never uses a fixed problem id or route id.
 */
const PARAMETER_SUBJECT_PATTERN = /parameter|参数/;
const PARAMETER_REQUEST_PATTERN =
  /classify|classification|分类|取值范围|range of values|value of the parameter|parameter values?/;

/** True iff the problem is a conservative parameter-classification problem. */
export function isParameterProblem(problem: string): boolean {
  const lowered = problem.toLowerCase();
  return PARAMETER_SUBJECT_PATTERN.test(lowered) && PARAMETER_REQUEST_PATTERN.test(lowered);
}

/**
 * Conservative single-class keyword selection. Exactly one class must match;
 * zero matches or several matches both yield `UNKNOWN`. This is not a general
 * semantic parse and never claims to be one.
 *
 * A real multi-part statement (two or more ordered sub-question labels) is
 * classified as `MULTIPART` before the keyword rules run: the sub-questions
 * are the goal structure, so a keyword inside one part never decides the
 * whole-problem class. The label scan is structural only and is not a
 * mathematical parse.
 */
export function selectP2GoalKind(problem: string): P2GoalKind {
  const lowered = problem.toLowerCase();
  if (multipartPartLabels(problem).length >= 2) {
    return "MULTIPART";
  }
  if (isParameterProblem(problem)) {
    return "PARAMETER";
  }
  const matched: P2GoalKind[] = [];
  if (ALL_SOLUTIONS_PATTERN.test(lowered)) {
    matched.push("ALL_SOLUTIONS");
  }
  for (const [kind, needles] of KEYWORD_RULES) {
    if (needles.some((needle) => lowered.includes(needle))) {
      matched.push(kind);
    }
  }
  return matched.length === 1 ? (matched[0] as P2GoalKind) : "UNKNOWN";
}

/**
 * A general single-letter zero-factor pattern `x(x−1)=0`-style hint. It only
 * records that a factor may need a zero check; it produces no answer and no
 * branch conclusion.
 */
export function zeroFactorHints(problem: string): readonly string[] {
  const hints: string[] = [];
  const pattern = /([A-Za-z])\s*\(\s*\1\s*[-−]\s*[0-9]+\s*\)\s*=\s*0/g;
  for (const match of problem.matchAll(pattern)) {
    const variable = match[1];
    if (typeof variable === "string") {
      hints.push(`${variable}=0需要检查`);
    }
  }
  return hints;
}

function defaultScope(goalId: string, kind: P2GoalKind, problem: string): Scope {
  return {
    scopeId: goalId,
    domain: "UNKNOWN",
    variableBindings: {},
    quantifiers: [],
    localAssumptions: [],
    branchConditions: kind === "PARAMETER" ? [...parameterBranches(problem)] : [],
    referenceablePremises: [],
  };
}

/**
 * The trusted parameter branches of a real parameter-classification problem:
 * the parameter's special value (`<p>=0`) and the ordinary case (`<p>!=0`).
 * Structural work view only -- never a mathematical parse, never a fixed
 * problem id. An empty list means no parameter name was declared.
 */
export function parameterBranches(problem: string): readonly string[] {
  const match = /(?:parameter|参数)\s*([A-Za-z])/.exec(problem);
  const name = match ? match[1] : undefined;
  if (name === undefined) {
    return [];
  }
  return [`${name}=0`, `${name}!=0`];
}

/**
 * The declared sub-question labels of one real multi-part problem, or an empty
 * list when the problem is not multi-part. The labels are the only structural
 * input of the MULTIPART goal tree; no fixed problem id and no fixed route id
 * is ever used.
 */
function multipartLabels(problem: string): readonly string[] {
  return multipartPartLabels(problem);
}

/**
 * Build the MULTIPART goal tree of one real multi-part problem: one leaf
 * subgoal per declared sub-question label, each with its own goal id, scope
 * and (later) its own obligation and task. The root keeps the whole-problem
 * scope. Nothing here is a mathematical decomposition.
 */
function buildMultipartSpecs(problem: string, labels: readonly string[]): readonly P2GoalSpec[] {
  const rootId = "goal-1";
  const subgoals = labels.map((label) => {
    const goalId = `goal-1-${label}`;
    return {
      goalId,
      kind: "VALUE" as P2GoalKind,
      scope: defaultScope(goalId, "VALUE", problem),
      subgoals: [],
    };
  });
  return [
    {
      goalId: rootId,
      kind: "MULTIPART" as P2GoalKind,
      scope: defaultScope(rootId, "MULTIPART", problem),
      subgoals,
    },
  ];
}

function normalizeSpec(spec: P2GoalSpec, problem: string): P2GoalSpec {
  const scope = spec.scope;
  const withId: Scope = { ...scope, scopeId: p2ScopeIdOf(scope) };
  const subgoals = spec.subgoals.map((child) => normalizeSpec(child, problem));
  return { goalId: spec.goalId, kind: spec.kind, scope: withId, subgoals };
}

function buildGoalSpecs(problem: string, goalSpecs?: readonly P2GoalSpec[]): readonly P2GoalSpec[] {
  if (goalSpecs === undefined) {
    const kind = selectP2GoalKind(problem);
    if (kind === "MULTIPART") {
      const labels = multipartLabels(problem);
      if (labels.length >= 2) {
        return buildMultipartSpecs(problem, labels).map((spec) => normalizeSpec(spec, problem));
      }
    }
    const goalId = "goal-1";
    return [normalizeSpec({ goalId, kind, scope: defaultScope(goalId, kind, problem), subgoals: [] }, problem)];
  }
  const validated = validateP2GoalSpecs(goalSpecs);
  return validated.map((spec) => normalizeSpec(spec, problem));
}

interface GoalPlan {
  readonly goal: P2GoalSpec;
  readonly obligations: readonly P2ObligationKind[];
}

function planGoal(goal: P2GoalSpec): GoalPlan {
  return { goal, obligations: KIND_OBLIGATIONS[goal.kind] };
}

/** Depth-first flatten of the goal tree; MULTIPART parents are kept as nodes. */
function flattenGoals(goals: readonly P2GoalSpec[]): readonly P2GoalSpec[] {
  const out: P2GoalSpec[] = [];
  const walk = (goal: P2GoalSpec): void => {
    out.push(goal);
    for (const child of goal.subgoals) {
      walk(child);
    }
  };
  for (const goal of goals) {
    walk(goal);
  }
  return out;
}

/**
 * Compile the P2-A M1 contract.
 *
 * `problem` is preserved verbatim and hashed; `version` and `eventSeq` must be
 * safe positive integers. Every record id is session-scoped and version-scoped
 * so a revision never overwrites the previous version's records, while
 * `taskId`/`obligationId` stay stable per goal/kind for ledger comparison.
 * The result is deep-frozen.
 */
export function compileP2Contract(
  problem: string,
  sessionId: string,
  goalSpecs?: readonly P2GoalSpec[],
  eventSeq = 1,
  version = 1,
): P2Contract {
  if (typeof problem !== "string" || problem.length === 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!detectLoneSurrogates(problem).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if ([...problem].length > P2_LIMITS.maxProblemChars) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    [...sessionId].length > 128 ||
    !detectLoneSurrogates(sessionId).ok
  ) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 1) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }

  const problemHash = p2ProblemHashOf(problem);
  const goals = buildGoalSpecs(problem, goalSpecs);
  const flatGoals = flattenGoals(goals);
  const plans = flatGoals.map((goal) => planGoal(goal));

  const obligations: P2Obligation[] = [];
  const tasks: P2Task[] = [];
  const taskIdsByGoal = new Map<string, string[]>();
  const childGoalIdsByParent = new Map<string, string[]>();

  for (const goal of flatGoals) {
    if (goal.subgoals.length > 0) {
      childGoalIdsByParent.set(
        goal.goalId,
        goal.subgoals.map((child) => child.goalId),
      );
    }
  }

  for (const plan of plans) {
    const goal = plan.goal;
    const goalTaskIds: string[] = [];
    const childGoalIds = childGoalIdsByParent.get(goal.goalId) ?? [];
    const units: readonly (readonly [string, P2ObligationKind])[] =
      childGoalIds.length > 0
        ? [
            ...childGoalIds.map(
              (childGoalId) => [`${goal.goalId}:cover:${childGoalId}`, "SUBGOAL_COVERAGE"] as const,
            ),
            [`${goal.goalId}:OUTPUT_COVERAGE`, "OUTPUT_COVERAGE"] as const,
          ]
        : plan.obligations.map((kind) => [`${goal.goalId}:${kind}`, kind] as const);
    for (const [unitId, kind] of units) {
      const obligationId = unitId;
      const taskId = unitId;
      const envelope: RecordEnvelope = {
        recordId: `${sessionId}:m1:${version}:obligation:${obligationId}`,
        sessionId,
        problemHash,
        sourceModule: "M1",
        taskId,
        contractVersion: version,
        artifactVersion: 1,
        scopeId: goal.scope.scopeId,
        eventSeq,
      };
      obligations.push({
        envelope,
        obligationId,
        goalId: goal.goalId,
        kind,
        status: "OPEN",
        acceptance: null,
      });
      const taskEnvelope: RecordEnvelope = {
        recordId: `${sessionId}:m1:${version}:task:${taskId}`,
        sessionId,
        problemHash,
        sourceModule: "M1",
        taskId,
        contractVersion: version,
        artifactVersion: 1,
        scopeId: goal.scope.scopeId,
        eventSeq,
      };
      tasks.push({
        envelope: taskEnvelope,
        taskId,
        goalId: goal.goalId,
        obligationId,
        scopeId: goal.scope.scopeId,
        inputArtifactRefs: [],
        dependencyTaskIds: [],
        expectedResult: KIND_EXPECTED[kind],
        acceptanceCriteria: KIND_ACCEPTANCE[kind],
        delivery: "READY",
      });
      goalTaskIds.push(taskId);
    }
    taskIdsByGoal.set(goal.goalId, goalTaskIds);
  }

  if (obligations.length > P2_LIMITS.maxObligations || tasks.length > P2_LIMITS.maxTasks) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }

  const taskIndex = new Map(tasks.map((task) => [task.taskId, task]));
  const withDeps = tasks.map((task) => {
    const goalTaskIds = taskIdsByGoal.get(task.goalId) ?? [];
    const deps: string[] = [];
    const childGoalIds = childGoalIdsByParent.get(task.goalId) ?? [];
    if (task.obligationId.startsWith(`${task.goalId}:cover:`)) {
      const childGoalId = task.obligationId.slice(`${task.goalId}:cover:`.length);
      const childTaskIds = taskIdsByGoal.get(childGoalId) ?? [];
      for (const candidate of childTaskIds) {
        if (candidate.endsWith(":OUTPUT_COVERAGE")) {
          deps.push(candidate);
        }
      }
    } else if (task.obligationId.endsWith(":EXHAUSTIVENESS")) {
      for (const candidate of [`${task.goalId}:CANDIDATE_VALIDITY`, `${task.goalId}:BOUNDARY_EXCEPTIONS`]) {
        if (taskIndex.has(candidate)) {
          deps.push(candidate);
        }
      }
    } else if (task.obligationId.endsWith(":OUTPUT_COVERAGE")) {
      if (childGoalIds.length > 0) {
        for (const childGoalId of childGoalIds) {
          const coverId = `${task.goalId}:cover:${childGoalId}`;
          if (taskIndex.has(coverId)) {
            deps.push(coverId);
          }
        }
      } else {
        for (const candidate of goalTaskIds) {
          if (candidate !== task.taskId) {
            deps.push(candidate);
          }
        }
      }
    }
    return { ...task, dependencyTaskIds: deps };
  });

  const envelope: RecordEnvelope = {
    recordId: `${sessionId}:m1:${version}:contract`,
    sessionId,
    problemHash,
    sourceModule: "M1",
    contractVersion: version,
    artifactVersion: 1,
    eventSeq,
  };

  return p2Snapshot({
    envelope,
    problemFullText: problem,
    problemHash,
    contractVersion: version,
    semanticStatus: "UNKNOWN",
    riskHints: zeroFactorHints(problem),
    goals,
    obligations,
    tasks: withDeps,
  });
}
