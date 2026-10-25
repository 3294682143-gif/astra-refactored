/**
 * @astra/stdio-runtime — unified AgentLoop composition root (async, injected ports).
 *
 * One root AgentSession owns the single deadline, the global model/effect
 * counters and the trace; one P4RecheckModelGate owns the sequential model
 * ledger across every work unit, tool and R2 review. The injected async ports
 * are the only model/effect entry points. No fixture, no prefilled receipts,
 * no Python, no retry. This module performs no direct I/O of its own: every
 * model/effect call goes through the captured ports. Every candidate stays
 * unverified.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  P3_TOOL_NAMES,
  P4_R0_MAX_ROOT_CALLS,
  P4_R0_ROLE,
  P4_R0_ROLE_DIMENSION,
  p2AnswerObligationForGoal,
  p2IsAnswerObligationKindForGoal,
  p2Snapshot,
  p4Hash,
  p4Target,
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentLoopSummary,
  type AgentModelPhase,
  type AgentPorts,
  type AgentTraceCode,
  type P2Artifact,
  type P2ArtifactRef,
  type P2GoalKind,
  type P2ObligationKind,
  type P2MethodAsset,
  type P2MethodCatalog,
  type P2Task,
  type P3Action,
  type P3EffectReceipt,
  type MathAssetResult,
  type MathAssetObservation,
  MATH_ASSET_CATALOG_DIGEST,
  MATH_ASSET_BY_ID,
  type P4Challenge,
  type P4CoverageRow,
  type P4DeliveryPolicy,
  type P4FinalDecision,
  type P4ReviseBasis,
  type P4S1Assessment,
  type P4Target,
} from "@astra/protocol";
import type { AgentModelReceipt, AgentModelRequest, P2Contract } from "@astra/protocol";
import {
  ContractLedger,
  P4R0PlanRevisionSession,
  compileP2Contract,
  prepareP4R0,
  prepareP4R0Recheck,
} from "@astra/math-contract";
import {
  P3EffectGate,
  P4RecheckModelGate,
  chooseP2ReadyTask,
  monotonicToolGuard,
  parseP3Action,
  p3EffectKey,
} from "@astra/math-gateway";
import { P2WorkunitStore } from "@astra/math-workunit";
import {
  P4R0RecheckSession,
  P4R0ReviewSession,
  P4ReviewSession,
  aggregateP4R0Reviews,
  createP4R0RevisionTrigger,
  roleVerdictOf,
} from "@astra/math-review";
import { P4CandidateGate, P4DiagnosticLedger, p4CheckedPropertyForTool, reviseCandidate } from "@astra/math-audit";
import {
  AGENT_MAX_EFFECTS,
  AGENT_MAX_METHOD_ASSETS,
  AgentSession,
  SessionLog,
  SESSION_LOG_KIND,
  SESSION_LOG_SCHEMA_VERSION,
  ReplayRunner,
  p3MethodCatalog,
  readAsset,
} from "@astra/runtime-core";
import { AgentCalls } from "./agent-loop-calls.js";
import { projectProtectedFinal, validateAgentFinal } from "./agent-final.js";
import { buildAgentWorkContext } from "./agent-loop-context.js";
import { AgentWorkflowRoutes } from "./agent-workflow.js";
import {
  certificateCorrection,
  isCertifiedPacket,
  summarizeCertificate,
} from "./agent-answer-certificate.js";
import {
  answerClosureDefects,
  answerClosureNote,
  problemChoiceLetters,
  type AnswerClosureDefect,
  type ExactObservationView,
  type ToolObservationView,
} from "./agent-answer-closure.js";
import { canonicalAnswerKey, sameAnswerKey } from "./agent-answer-key.js";
import { AgentRevisionAdmission } from "./agent-revision.js";
import { AgentProgressPolicy } from "./agent-progress.js";
import {
  boundedAwait,
  captureAgentOptions,
  captureAgentPorts,
  checkedAgentReceipt,
  deriveRootBudget,
  type CapturedAgentOptions,
  type CapturedAgentPorts,
} from "./agent-loop-io.js";
import {
  polynomialOf,
  problemRelationPolynomial,
  rationalSetElements,
  samePolynomial,
  sameRationalSet,
  semanticMethodRoute,
  semanticToolRoute,
  semanticMathAssetRoute,
  solutionSetOf,
  type SemanticToolRoute,
  type SemanticMathAssetRoute,
} from "./agent-semantics.js";

const MIN_MS = 25;

/**
 * Stage D+: the single recorded identity of one admitted bounded exploration
 * effect. It never names a registered tool and never matches a closure lookup,
 * so an exploration observation can ground no defect and satisfies no
 * obligation; it stays bounded, deduplicated telemetry.
 */
const EXPLORATION_TOOL_NAME = "generated_exploration";

/**
 * The post-card method/tool co-prompt is advisory prompt text only: it names
 * the card that was just loaded, the deterministic route and the safe argument
 * skeleton. It changes no control flow, spends no model call and never counts
 * as evidence. The cap keeps the appended block well inside the ordinary WORK
 * message budget.
 */
const MAX_METHOD_TOOL_COPROMPT_CHARS = 600;

/**
 * One truthful line of the routed tool's input constraints. It is derived from
 * the route identity and template shape only; it adds no numeric limit that the
 * registered tool does not itself enforce.
 */
export function methodToolInputConstraint(route: SemanticToolRoute): string {
  switch (route.toolName) {
    case "bounded_enumeration":
      return "Use positive integer range sizes and an integer choose; the predicate is a string.";
    case "linear_system_solution_set":
      return "Every matrix and rhs entry must be a quoted exact rational string; domain is RATIONAL or REAL.";
    case "interpolation_fit_check":
    case "stats_ols_check":
      return "All point, data and claimed values must be quoted exact rational strings.";
    case "finite_group_structure":
      return "Use cycle-notation generator strings plus an integer degree, or one closed named group string.";
    case "real_root_count_expr":
    case "splitting_field_degree_expr":
    case "polynomial_expand_coefficients":
    case "circle_laplacian_expr":
    case "planar_laplacian_expr":
      return "Expression and variable names must be quoted JSON strings; copy the input exactly.";
    case "solve_quadratic_diophantine":
      return "Pass a, b, c, d, e, f (and optional y_bound) as JSON integers with |coeff|<=32 and a!=0; do not quote numbers.";
    case "symbolic_diophantine_with_timeout":
      return "Pass lhs (and optional rhs) as polynomial strings using ** for powers, and optional two-variable list variables.";
    case "solve_system_guarded_expr":
      return "Pass expressions as an array of <=6 polynomial strings (using **) and variables as an array of <=3 variable names.";
    case "polynomial_function_check":
      return "Pass exactly the five fields equation, function, argument, variables and univariate rational polynomial expression.";
    case "gf2_rank":
      return "Pass rows ONLY as an array of <=8 non-negative JSON integers encoding binary rows (<=8 bits); do not pass width or strings.";
    case "gf2_nullspace":
      return "Pass rows (<=8 non-negative JSON integers) and integer width (1..8) only; do not quote integers.";
    case "transition_count":
      return "Pass integer length (1..6), integer num_states (1..4), transitions as [u,v] integer pairs, and optional integer arrays starts/ends (omit if default, never null).";
    case "independence_polynomial_chain":
      return "Pass n as a non-negative JSON integer (0..16); do not quote n.";
    case "count_by_digit_property":
      return "Pass digit_set (array of ints 0..9), max_digits (1..3), and optional modulus (1..64), residue (0..modulus-1), include_zero (boolean).";
    case "rook_numbers":
      return "Pass integer n (1..5) and forbidden as an array of <=10 [r,c] integer pairs with 0<=r,c<n.";
    case "count_avoiding_permutations":
      return "Pass integer n (1..6) and forbidden as an array of [i, pi_i] integer pairs with 0<=i,pi_i<n.";
    case "cover_time_complete_graph":
      return "Pass num_vertices as a JSON integer in 2..8.";
    case "markov_expected_steps":
      return "Pass transition as a <=6x6 matrix of exact decimal numbers summing to 1 per row, integer start, and non-empty integer array targets.";
    case "finite_difference_derivative":
      return "Pass f as an expression string in x, numeric x (|x|<=100), numeric step h (1e-6..1), and optional method (central/forward/backward).";
    case "richardson_extrapolate":
      return "Pass f as an expression string in x, numeric x (|x|<=100), numeric step h (1e-6..1), and optional method and integer order (1..8).";
    default:
      if (route.operation === "MAXIMAL_MINORS") {
        return "Every matrix entry must be a quoted JSON string; copy the exact entries from the statement.";
      }
      if (route.operation === "DENSITY_CHECK") {
        return "Density, variable and bounds must be quoted strings; give the density only on its support.";
      }
      if (route.operation === "LIMIT") {
        return "Expression, variable and limit point must be quoted JSON strings.";
      }
      return "Every expression and matrix entry must be a quoted JSON string; copy it exactly.";
  }
}

/**
 * The advisory system note of one forced semantic-tool turn. It names the routed
 * tool, its safe argument skeleton and that route's exact input constraints;
 * the note is prompt text only and never executes or validates the action.
 */
export function semanticToolTurnNote(route: SemanticToolRoute): string {
  return (
    "\n\nSEMANTIC TOOL TURN (" + route.operation + "). This problem contains a " +
    route.operation + " object that must be computed from the problem statement. " +
    "Before delivering a WorkPacket, return exactly one JSON tool action " +
    "{\"action\":\"tool\",\"name\":\"" + route.toolName + "\",\"args\":" + route.argsTemplate +
    ",\"scope\":\"<what is computed from the problem statement>\"} " +
    "and nothing else. " +
    methodToolInputConstraint(route) + " Never substitute a different tool. " +
    "Do not return a WorkPacket in this turn. The observation is input-relative and is not a proof of the mapping. " +
    "After the observation, return a COMPLETE WorkPacket with a best-effort candidate."
  );
}

/**
 * Bounded advisory text appended to the user message of the first WORK turn
 * after a method card load. A routed tool is named with its exact safe args
 * skeleton so the model can act on the card instead of writing a final packet
 * from memory and being forced to discard it.
 */
function methodToolCoPrompt(methodId: string, route: SemanticToolRoute): string {
  const block =
    "\n\nMETHOD+TOOL ADVISORY (card " + methodId + ", tool " + route.toolName + "). " +
    "Prefer one tool turn over a final WorkPacket: " +
    "{\"action\":\"tool\",\"name\":\"" + route.toolName + "\",\"args\":" + route.argsTemplate +
    ",\"scope\":\"<what is computed from the problem statement>\"}. " +
    methodToolInputConstraint(route) + " " +
    "After PROGRAM_OBSERVATION, submit the complete WorkPacket as usual.";
  const chars = [...block];
  return chars.length <= MAX_METHOD_TOOL_COPROMPT_CHARS
    ? block
    : chars.slice(0, MAX_METHOD_TOOL_COPROMPT_CHARS).join("");
}

function mathAssetCoPrompt(route: SemanticMathAssetRoute): string {
  const block =
    "\n\nMATH ASSET ADVISORY (" + route.assetId + ", target " + route.target + "). " +
    "Prefer one math_asset action over a final WorkPacket: " +
    "{\"action\":\"math_asset\",\"assetId\":\"" + route.assetId + "\",\"target\":\"" + route.target + "\",\"input\":" + route.argsTemplate + "}. " +
    "After PROGRAM_OBSERVATION, submit the complete WorkPacket as usual.";
  const chars = [...block];
  return chars.length <= MAX_METHOD_TOOL_COPROMPT_CHARS
    ? block
    : chars.slice(0, MAX_METHOD_TOOL_COPROMPT_CHARS).join("");
}

const MAX_EXPLORATION_COPROMPT_CHARS = 900;

/**
 * Bounded post-card advisory for a problem with no fixed semantic tool route
 * while the Host has advertised a usable bounded Python sandbox. It is prompt
 * text only and is never emitted on the default path (`allowExplore=false`),
 * so the offline run stays byte-identical.
 */
function explorationCoPrompt(): string {
  const block =
    "\n\nPOST-METHOD EXPLORATION ADVISORY. No fixed semantic tool route matched this problem. " +
    "A bounded Python exploration is available in this session. If the problem involves symbolic integration, series or limits, linear algebra, differential equations, group/ring properties, or a numeric multi-option check, reply first with exactly one JSON exploration action " +
    "{\"action\":\"explore\",\"code\":\"import sympy as sp\\n# compute exact invariants and print results\\nprint(...)\",\"scope\":\"verify key mathematical quantities with SymPy\"} " +
    "and nothing else. Its observation is a BOUNDED_OBSERVATION_NOT_PROOF and is input-relative data, not a proof or a certificate. After the observation, submit the complete WorkPacket. Do not invent a tool name or a different action.";
  const chars = [...block];
  return chars.length <= MAX_EXPLORATION_COPROMPT_CHARS
    ? block
    : chars.slice(0, MAX_EXPLORATION_COPROMPT_CHARS).join("");
}

/**
 * B2 (DECISION-0150): auxiliary (non-answer) obligations whose open state must
 * be reported honestly. A proof's `PREMISES` (E05) and an optimization's
 * `ATTAINMENT` (E06) never carry the whole-problem candidate, but while they
 * are unclosed the delivered candidate stays unverified. The frozen
 * `P2_ANSWER_OBLIGATION_BY_GOAL` authority is untouched.
 */
const AUX_OBLIGATION_KINDS: readonly P2ObligationKind[] = ["PREMISES", "ATTAINMENT"];

/** Shape/type failures that one bounded model-side schema repair may correct. */
const SCHEMA_REPAIR_CODES: ReadonlySet<string> = new Set([
  "PACKET_SCHEMA",
  "PACKET_BINDING",
  "PACKET_DELIVERY",
  "PACKET_FORBIDDEN_FIELD",
  // The model may add explanatory assumptions that are not declared in the
  // trusted scope. That is a repairable shape/scope mistake for this one
  // bounded turn; the same task and scope are retained.
  "PACKET_SCOPE_VIOLATION",
  "SCOPE_MISMATCH",
  "ROUTE_MISMATCH",
  "VERSION_MISMATCH",
  "UNKNOWN_DEPENDENCY",
  "DUPLICATE_ID",
  // A maxLength/type violation is reported as FIELD_VALUE by the strict
  // WorkPacket schema. One bounded repair may shorten an overlong derivation
  // or fix a scalar field; it never changes the task or the answer policy.
  "FIELD_VALUE",
]);

/**
 * The declared goal kind of one goal id, or `UNKNOWN` when the goal is not
 * part of the trusted contract. The goal tree is walked read-only; nothing
 * here is a mathematical decision.
 */
function goalKindOf(
  goals: readonly { readonly goalId: string; readonly kind: P2GoalKind; readonly subgoals: readonly unknown[] }[],
  goalId: string,
): P2GoalKind {
  for (const goal of goals) {
    if (goal.goalId === goalId) {
      return goal.kind;
    }
    const nested = goalKindOf(
      goal.subgoals as readonly { readonly goalId: string; readonly kind: P2GoalKind; readonly subgoals: readonly unknown[] }[],
      goalId,
    );
    if (nested !== "UNKNOWN") {
      return nested;
    }
  }
  return "UNKNOWN";
}

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function boundedProblem(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > 8192) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

function boundedSession(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > 128) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

/**
 * B3 (DECISION-0150): the trusted parameter branches of a PARAMETER goal, or
 * an empty list for a non-PARAMETER (or unknown) goal. These are the bounded
 * trusted gap source for the multi-gap REPAIR flagship: a revised child must
 * restate every trusted branch or the revision fails closed.
 */
function parameterGapsOf(
  goals: readonly {
    readonly goalId: string;
    readonly kind: P2GoalKind;
    readonly scope?: { readonly branchConditions?: readonly string[] };
    readonly subgoals: readonly unknown[];
  }[],
  goalId: string,
): readonly string[] {
  for (const goal of goals) {
    if (goal.goalId === goalId) {
      return goal.kind === "PARAMETER" ? (goal.scope?.branchConditions ?? []) : [];
    }
    const nested = parameterGapsOf(goal.subgoals as never, goalId);
    if (nested.length > 0) {
      return nested;
    }
  }
  return [];
}

/**
 * Defect 2(a) (Trusted RC Package): the standalone single-letter variables the
 * original problem declares. The compiled scope carries an empty
 * `variableBindings`, so the problem text is the only structural variable
 * source; a letter counts only as a whole token, so prose letters never
 * masquerade as variables.
 */
function problemVariableSet(problem: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const match of problem.matchAll(/(^|[^A-Za-z])([A-Za-z])(?=[^A-Za-z]|$)/gu)) {
    out.add(match[2] as string);
  }
  return out;
}

/** True when `name` appears in `expression` as a whole identifier, not as a substring. */
function identifierUsed(expression: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "u").test(expression);
}

/**
 * Defect 2(a) hardening: an S1 checker may ground a REPAIR only when its actual
 * tool request is bound to the original problem's variables. A declared
 * variable must be one the problem declares and must actually appear in the
 * checker expression, so a valid-but-unrelated observation (e.g. `2+2=4`) can
 * never become a revision basis.
 */
function checkerArgsRelevant(action: P3Action, problemVars: ReadonlySet<string>): boolean {
  if (
    action.action !== "tool" ||
    typeof action.args !== "object" ||
    action.args === null ||
    Array.isArray(action.args)
  ) {
    return false;
  }
  const args = action.args as Record<string, unknown>;
  const vars = args.variables;
  if (!Array.isArray(vars) || vars.length === 0) {
    return false;
  }
  const expression = typeof args.expression === "string" ? args.expression : null;
  for (const variable of vars) {
    if (typeof variable !== "string" || variable.trim().length === 0) {
      return false;
    }
    if (!problemVars.has(variable)) {
      return false;
    }
    if (expression !== null && !identifierUsed(expression, variable)) {
      return false;
    }
  }
  return true;
}

/**
 * Defect 3(b) (Trusted RC): rebuild a COMPLETE resumed run from its authenticated
 * SessionLog prefix. The prefix already records the terminal FINAL decision, so
 * the returned result re-states that verdict and the delivered candidate with no
 * new model/effect call; `null` means "no FINAL, continue normally". This process
 * made zero calls, so every counter it reports is honestly zero.
 */
function reconstructResumedResult(
  events: readonly { readonly seq: number; readonly kind: string; readonly data: Readonly<Record<string, unknown>> }[],
  session: string,
  problemHash: string,
  opts: CapturedAgentOptions,
): AgentLoopResult | null {
  const finalEvent = events.find((row) => row.kind === "FINAL");
  if (finalEvent === undefined) {
    return null;
  }
  const data = finalEvent.data;
  const status = data.status;
  const reason = data.reason;
  const finalResponse = data.finalResponse;
  if (
    (status !== "candidate" && status !== "unsolved") ||
    typeof finalResponse !== "string" ||
    finalResponse.length === 0 ||
    typeof reason !== "string"
  ) {
    return null;
  }
  let binding: Record<string, unknown> | null = null;
  for (const row of events) {
    if (row.kind !== "WORKUNIT" && row.kind !== "REPAIR") {
      continue;
    }
    const eventData = row.data;
    const delivered = row.kind === "WORKUNIT" ? eventData.deliveryStatus === "COMPLETE" : eventData.accepted === true;
    const proposal = eventData.candidateProposal;
    if (!delivered || typeof proposal !== "string" || proposal.trim().length === 0) {
      continue;
    }
    binding = {
      sessionId: session,
      problemHash,
      contractVersion: 1,
      artifactId: typeof eventData.artifactId === "string" ? eventData.artifactId : "resumed-1",
      artifactVersion: typeof eventData.artifactVersion === "number" ? eventData.artifactVersion : 1,
      taskId: typeof eventData.taskId === "string" ? eventData.taskId : "resumed",
      goalId: typeof eventData.goalId === "string" ? eventData.goalId : "goal-1",
      scopeId: typeof eventData.scopeId === "string" ? eventData.scopeId : problemHash,
      sourceRequestId: typeof eventData.sourceRequestId === "string" ? eventData.sourceRequestId : "model-1",
    };
  }
  const unresolvedRaw = data.unresolvedObligations;
  const unresolved = Array.isArray(unresolvedRaw)
    ? unresolvedRaw.filter((item): item is string => typeof item === "string")
    : [];
  const summary = p2Snapshot({
    mode: "TS_PREVIEW",
    targetEnvironment: "TARGET_UNVERIFIED",
    sessionId: session,
    status,
    finalResponse,
    candidateVerified: false,
    strictAcceptance: "NOT_PERFORMED",
    policy: opts.policy,
    reason,
    modelCalls: 0,
    effectCalls: 0,
    workUnits: 0,
    reviewCalls: 0,
    repairCalls: 0,
    catalogCalls: 0,
    methodLoads: 0,
    stopReason: status === "candidate" ? "WORK_UNITS_COMPLETE" : "NO_CANDIDATE",
    unresolvedObligations: unresolved,
  }) as AgentLoopSummary;
  const decision = p2Snapshot({
    mode: "MOCK_ONLY",
    targetEnvironment: "TARGET_UNVERIFIED",
    stage: "S3",
    policy: opts.policy,
    status,
    finalResponse,
    candidateVerified: false,
    strictAcceptance: "NOT_PERFORMED",
    submissionEligibility: status === "candidate" ? "BEST_EFFORT" : "WITHHELD",
    protectedCandidate: binding,
    targetHash: null,
    unresolvedChallenges: 0,
    openObligations: 0,
    coverage: [] as readonly unknown[],
    reason,
  });
  return p2Snapshot({
    summary,
    privateState: {
      session: { events: [] as readonly unknown[], sessionId: session, code: "WORK_UNITS_COMPLETE" },
      sessionLog: { schemaVersion: SESSION_LOG_SCHEMA_VERSION, version: events.length, events },
      decision,
    },
  }) as unknown as AgentLoopResult;
}

/**
 * Step 1 hard gate: a checker supports the challenged answer obligation ONLY
 * when the relation it checks is the original problem's own relation (polynomial-
 * equivalent) AND its request is bound to the problem's variables. `x+999` or a
 * constant is never equivalent to the problem relation, so it can never ground a
 * revision; `x*(x-1)` for `x(x-1)=0` is.
 */
export function checkerSupportsObligation(action: P3Action, problemText: string): boolean {
  if (action.action !== "tool" || !checkerArgsRelevant(action, problemVariableSet(problemText))) {
    return false;
  }
  const args = action.args as Record<string, unknown>;
  if (action.name === "linear_system_solution_set") {
    return Array.isArray(args.matrix) && Array.isArray(args.rhs);
  }
  const expression = typeof args.expression === "string" ? args.expression : null;
  if (expression === null) {
    return false;
  }
  return samePolynomial(polynomialOf(expression), problemRelationPolynomial(problemText));
}

/**
 * Build the bounded, model-visible schema-repair context. This is not a second
 * solver: it repeats the same task with the rejected packet and the fixed
 * WorkPacket field contract. The caller owns the one-attempt policy.
 */
function buildSchemaRepairMessages(
  base: readonly { readonly role: "system" | "user"; readonly content: string }[],
  previousText: string,
  code: string,
  requestId: string,
): {
  readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
  readonly contextHash: string;
  readonly contextBytes: number;
} {
  const baseBytes =
    Buffer.byteLength(base[0]!.content, "utf8") +
    Buffer.byteLength(base[1]!.content, "utf8");
  const available = Math.max(0, 59_000 - baseBytes);
  const clipped = [...previousText].slice(0, Math.min(4096, available)).join("");
  // The Host re-parses the user message with the same strict context
  // validator that served the original request. Keep that message valid JSON
  // and advance only the request-bound sourceRequestId; the rejected packet
  // and the repair identity live in the system message.
  let repairBody: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(base[1]!.content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("SCHEMA_REPAIR_CONTEXT");
    }
    repairBody = { ...(parsed as Record<string, unknown>), sourceRequestId: requestId };
  } catch {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const replyTask = repairBody["task"] as Record<string, unknown> | undefined;
  const replyRoute = repairBody["route"] as Record<string, unknown> | undefined;
  const bindingLines = [
    "currentProblemHash=" + String(repairBody["problemHash"] ?? ""),
    "currentSessionId=" + String(repairBody["sessionId"] ?? ""),
    "currentContractVersion=" + String(repairBody["contractVersion"] ?? ""),
    "currentTaskId=" + String(replyTask?.["taskId"] ?? ""),
    "currentGoalId=" + String(replyTask?.["goalId"] ?? ""),
    "currentScopeId=" + String(replyTask?.["scopeId"] ?? ""),
    "currentRouteId=" + String(replyRoute?.["routeId"] ?? ""),
    "currentSourceRequestId=" + requestId,
  ].join("\n");
  const messages = [
    {
      role: "system" as const,
      content:
        base[0]!.content +
        " Your previous WorkPacket was rejected by the control schema. Return ONE corrected WorkPacket and nothing else." +
        " candidateProposal MUST be a JSON string or null (never an object); deliveryStatus MUST be exactly COMPLETE, INCOMPLETE, TRUNCATED or ERROR." +
        " If the answer is complete, use deliveryStatus=COMPLETE, pendingObligations=[] and candidateProposal as the answer string." +
        " Keep the current task and scope; use sourceRequestId exactly as the value given below." +
        " If claim, derivation or candidateProposal exceeded 4096 Unicode code points, shorten each field; do not paste the rejected derivation again." +
        " assumptions MUST be an empty array unless each entry is already a declared scope assumption; never invent a new assumption." +
        "\n\nSCHEMA_REPAIR_CONTROL\n" +
        "rejectedCode=" + code + "\n" +
        bindingLines + "\n" +
        "PREVIOUS_REJECTED_WORKPACKET=" + clipped,
    },
    { role: "user" as const, content: JSON.stringify(repairBody) },
  ];
  const serialized = JSON.stringify(messages);
  return {
    messages,
    contextHash: p4Hash(serialized),
    contextBytes: Buffer.byteLength(serialized, "utf8"),
  };
}

/**
 * B1 (DECISION-0150): dispatch one R0 planning-stage model call through the
 * injected model port using only the shared root budget. R0 has no work task,
 * so it bypasses the P4RecheckModelGate; the root still owns the ordinal and
 * the deadline. Every call is one separate `model.generate` under its own root
 * request id; no call is ever shared by two reviewers or replayed after it has
 * settled. Returns an UNKNOWN receipt on any port/validation failure.
 *
 * `phase` is the request phase ("R0" for the three reviews and the revision,
 * "R0_RECHECK" for the single recheck). The root trace keeps the fixed `R0`
 * control code so the public trace vocabulary stays closed.
 */
async function r0Generate(
  root: AgentSession,
  ports: CapturedAgentPorts,
  sessionLog: SessionLog,
  requestId: string,
  phase: AgentModelPhase,
  context: {
    readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
    readonly contextHash: string;
    readonly contextBytes: number;
  },
  scopeId: string,
): Promise<AgentModelReceipt> {
  const remaining = root.remainingMs();
  if (remaining <= MIN_MS) {
    fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }
  const request = p2Snapshot({
    sessionId: root.sessionId,
    problemHash: root.problemHash,
    requestId,
    phase,
    taskId: "r0",
    scopeId,
    messages: context.messages,
    contextHash: context.contextHash,
    contextBytes: context.contextBytes,
    remainingMs: remaining,
    maxTokens: 8192 as const,
  }) as AgentModelRequest;
  sessionLog.append("MODEL_REQUEST", {
    phase,
    requestId,
    contextHash: request.contextHash,
    contextBytes: request.contextBytes,
    messages: request.messages,
  });
  const reserved = root.reserveModel("R0");
  if (reserved !== requestId) {
    fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
  }
  let raw: unknown;
  try {
    raw = await boundedAwait(() => ports.model.generate(request), remaining);
  } catch {
    root.settleModel(requestId, "UNKNOWN");
    return Object.freeze({ transportStatus: "UNKNOWN" as const, text: "" }) as AgentModelReceipt;
  }
  let receipt: AgentModelReceipt;
  try {
    receipt = checkedAgentReceipt(raw);
  } catch {
    root.settleModel(requestId, "UNKNOWN");
    return Object.freeze({ transportStatus: "UNKNOWN" as const, text: "" }) as AgentModelReceipt;
  }
  root.settleModel(requestId, receipt.transportStatus);
  return receipt;
}

/**
 * B1 + HANDOFF §5 item 5: the bounded R0 three-review stage.
 *
 * Fixed order, fixed bounds. Three *independent* role reviews (题意 / 方法 /
 * 任务·工具) are dispatched as three separate model calls under three different
 * root request ids, then a pure controller aggregates them. Only an aggregate
 * `ISSUES` continues: one `reviseGoals` revision proposal (contractVersion
 * 1 -> 2) is recorded and the revised plan is re-examined by exactly one
 * targeted recheck. The revision is applied only when that recheck is a usable
 * `NO_ISSUE`; every inconclusive, unparseable or illegal path falls back to the
 * fixed deterministic template under the same root budget — never a second
 * bump, never a second recheck and never extra planning budget.
 *
 * Every one of the stage's at most five calls is guarded the same way the main
 * loop guards its own calls: `root.nextModelId()` (the root ordinal peek that
 * `callsLeft()` mirrors) says whether another call is still affordable, and the
 * dispatch itself goes through `root.reserveModel` inside `r0Generate`.
 */
async function runBoundedR0(
  initial: P2Contract,
  root: AgentSession,
  ports: CapturedAgentPorts,
  opts: CapturedAgentOptions,
  problemText: string,
  session: string,
  sessionLog: SessionLog,
): Promise<P2Contract> {
  const fallback = (): P2Contract => compileP2Contract(problemText, session, undefined);
  try {
    if (root.stopped() || root.remainingMs() <= MIN_MS) {
      return initial;
    }
    // prepareP4R0 caps the frozen planning view at the fixed five-call stage
    // design (three reviews + one recheck + one revision); the real root budget
    // is unchanged, so R0 still spends only the calls it actually makes.
    const r0RootCalls = Math.min(opts.maxModelCalls, P4_R0_MAX_ROOT_CALLS);
    const prep = prepareP4R0(initial, {
      enabled: true,
      planningModelCalls: 1,
      remainingRootCalls: r0RootCalls,
      remainingMs: root.remainingMs(),
    });
    if (prep.action !== "REQUEST_REVIEW") {
      return initial;
    }
    const scopeId = prep.target.binding.planHash;
    const review = new P4R0ReviewSession(prep);
    for (const role of P4_R0_ROLE) {
      if (root.stopped() || root.remainingMs() <= MIN_MS) {
        break;
      }
      const requestId = root.nextModelId();
      if (requestId === null) {
        break;
      }
      const admitted = review.admit(role, requestId, root.remainingMs(), r0RootCalls);
      const receipt = await r0Generate(root, ports, sessionLog, requestId, "R0", admitted.context, scopeId);
      review.markDispatched(role);
      review.settle(role, receipt.transportStatus, receipt.text, root.remainingMs());
      const verdict = roleVerdictOf(review.snapshot(role));
      sessionLog.append("R0_REVIEW", {
        role,
        requestId,
        verdict,
        dimension: P4_R0_ROLE_DIMENSION[role],
        issueCount: verdict === "ISSUES" ? 1 : 0,
      });
    }
    const snapshots = review.snapshots();
    const aggregate = aggregateP4R0Reviews(snapshots);
    sessionLog.append("R0_REVIEW", {
      role: "AGGREGATE",
      conclusion: aggregate.conclusion,
      issueDimensions: aggregate.issueDimensions,
      dissents: aggregate.dissents.map((row) => ({
        role: row.role,
        dimension: row.dimension,
        verdict: row.verdict,
      })),
    });
    if (aggregate.conclusion !== "ISSUES") {
      return initial;
    }
    // The revision proposal is bound to the first ISSUES role in the fixed
    // order; the aggregate's full ISSUES dimension list is what the aggregate
    // row above records.
    const issueSnapshot = snapshots.find((row) => roleVerdictOf(row) === "ISSUES");
    if (issueSnapshot === undefined) {
      return initial;
    }
    const trigger = createP4R0RevisionTrigger(prep, issueSnapshot);
    const revisionRequestId = root.nextModelId();
    if (revisionRequestId === null) {
      return fallback();
    }
    const revision = new P4R0PlanRevisionSession(prep, trigger, 1);
    const rAdmitted = revision.admit(root.remainingMs(), 2, 3);
    const rReceipt = await r0Generate(
      root,
      ports,
      sessionLog,
      revisionRequestId,
      "R0",
      rAdmitted.context,
      scopeId,
    );
    revision.markDispatched();
    revision.settle(rReceipt.transportStatus, rReceipt.text, root.remainingMs());
    const revisionSnapshot = revision.snapshot();
    if (revisionSnapshot.revisedContract === null) {
      return fallback();
    }
    // Exactly one targeted recheck of the revised plan. It is fed by the
    // already-recorded revision snapshot, so the revision can never take effect
    // without it: only a usable NO_ISSUE recheck applies the single bump.
    const recheckRequestId = root.nextModelId();
    if (recheckRequestId === null) {
      return fallback();
    }
    // The recheck preparation is pinned by its own contract to a two-call
    // budget view; the real guard on the shared root is `nextModelId` below.
    const recheckPrep = prepareP4R0Recheck(prep, trigger, revisionSnapshot, {
      planningModelCalls: 1,
      remainingRootCalls: 2,
      remainingMs: root.remainingMs(),
    });
    const recheck = new P4R0RecheckSession(recheckPrep, 1);
    const cAdmitted = recheck.admit(root.remainingMs(), 1, 2);
    const cReceipt = await r0Generate(
      root,
      ports,
      sessionLog,
      recheckRequestId,
      "R0_RECHECK",
      cAdmitted.context,
      recheckPrep.target.binding.planHash,
    );
    recheck.markDispatched();
    const cSettled = recheck.settle(cReceipt.transportStatus, cReceipt.text, root.remainingMs());
    if (cSettled.code !== "OK" || cSettled.report === null) {
      return fallback();
    }
    if (cSettled.report.conclusion !== "NO_ISSUE") {
      return fallback();
    }
    // The revision session records a *proposal* against a private ledger; it is
    // not itself an activatable contract. Recompile a clean version-2 contract
    // from the revised goal tree so the main ledger sees OPEN obligations and
    // READY tasks (the single bounded bump is now applied).
    const revised = compileP2Contract(
      problemText,
      session,
      revisionSnapshot.revisedContract.goals,
      revisionSnapshot.revisedContract.envelope.eventSeq,
      2,
    );
    sessionLog.append("CONTRACT_REVISED", { fromVersion: 1, toVersion: revised.contractVersion });
    return revised;
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    try {
      return fallback();
    } catch {
      return initial;
    }
  }
}

/** Semantic operation label carried by the Host-side tool funnel metrics. */
function toolOperationFor(
  name: string,
  args: Readonly<Record<string, unknown>>,
  route: SemanticToolRoute | null,
): string | null {
  if (route !== null && route.toolName === name) return route.operation;
  const operation = args["operation"];
  if (typeof operation === "string" && operation.trim().length > 0) {
    return operation.trim();
  }
  switch (name) {
    case "real_root_count_expr":
      return "REAL_ROOT_COUNT";
    case "splitting_field_degree_expr":
      return "SPLITTING_FIELD_DEGREE";
    case "circle_laplacian_expr":
      return "CIRCLE_LAPLACIAN";
    case "planar_laplacian_expr":
      return "PLANAR_LAPLACIAN";
    case "interpolation_fit_check":
      return "INTERPOLATION_FIT";
    case "stats_ols_check":
      return "OLS_CHECK";
    case "finite_group_structure":
      return "GROUP_STRUCTURE";
    case "bounded_enumeration":
      return "ENUMERATE";
    case "polynomial_expand_coefficients":
      return "EXPAND_COEFFICIENTS";
    case "linear_system_solution_set":
      return "SOLUTION_SET";
    default:
      return null;
  }
}

// G7/PR7 Slice 7e: the S1 checker tool -> registered output_checker asset key.
const S1_CHECKER_ASSET: Readonly<Record<string, string>> = Object.freeze({
  polynomial_expand_coefficients: "symbolic.py",
  linear_system_solution_set: "algebraic.py",
});

export async function runAgentLoop(
  problem: string,
  sessionId: string,
  options: AgentLoopOptions,
  ports: AgentPorts,
): Promise<AgentLoopResult> {
  const problemText = boundedProblem(problem);
  const session = boundedSession(sessionId);
  const opts0 = captureAgentOptions(options);
  const captured = captureAgentPorts(ports);
  const problemHash = p4Hash(problemText);
  let contract = compileP2Contract(
    problemText,
    session,
    opts0.goalSpecs.length > 0 ? opts0.goalSpecs : undefined,
  );
  // One budget, derived from the compiled task graph, is the single source.
  const derived = opts0.deriveBudget
    ? deriveRootBudget(
        contract.tasks.length,
        opts0.maxReviews,
        opts0.maxModelCalls,
        opts0.maxWorkUnits,
        opts0.maxConsensus,
      )
    : null;
  const opts: CapturedAgentOptions =
    derived === null
      ? opts0
      : Object.freeze({
          ...opts0,
          maxWorkUnits: derived.maxWorkUnits,
          maxModelCalls: derived.maxModelCalls,
        });
  // Public `maxEffects` is the tool quota; method cards have their own quota.
  // The root owns the shared total effect-id capacity. The hard id-table
  // ceiling is owned by @astra/runtime-core.
  const totalEffectCapacity =
    opts.maxEffects === 0
      ? 0
      : Math.min(
          opts.maxEffects + opts.maxMethodLoads,
          AGENT_MAX_EFFECTS,
        );
  // The Host owns the 0..4 method quota; this loop deliberately spends at most
  // two distinct bodies per run so a routed second card cannot widen the path.
  const methodLoadCapacity = Math.min(opts.maxMethodLoads, AGENT_MAX_METHOD_ASSETS);
  const root = new AgentSession({
    sessionId: session,
    problemHash,
    maxModelCalls: opts.maxModelCalls,
    maxEffects: totalEffectCapacity,
    remainingMs: opts.remainingMs,
    now: opts.now,
  });
  // G4/PR5 Slice 4a: the immutable SessionLog is the single source of truth for
  // what the model saw; every model request is a deterministic projection of it.
  const sessionLog = new SessionLog();
  // G7/PR7 Slice 7d: an authenticated resume prefix is pre-seeded as
  // already-settled events, so the settled model/tool calls are never
  // re-dispatched. Absent keeps the default path byte-identical.
  if (opts.resumeSessionLog !== null && opts.resumeSessionLog.length > 0) {
    for (const row of opts.resumeSessionLog) {
      const kind = SESSION_LOG_KIND.find((candidate) => candidate === row.kind);
      if (kind === undefined) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      sessionLog.append(kind, row.data);
    }
  } else {
    sessionLog.append("SESSION_INIT", { sessionId: session, problemHash });
  }
  // Defect 3(b) (Trusted RC): a resumed run whose authenticated prefix already
  // records a FINAL decision is COMPLETE. Rebuild the delivered candidate and
  // the recorded verdict from the event stream and return it with ZERO new
  // model/effect calls. A prefix without a FINAL event falls through to the
  // normal bounded continuation.
  let reconstructedPartial = false;
  if (opts.resumeSessionLog !== null && opts.resumeSessionLog.length > 0) {
    // Step 2: any non-empty resume prefix is first re-checked with the SAME
    // tamper detector as read-only replay (event sequence, request hashes, and a
    // FINAL answer that must equal the candidate rebuilt from the WORKUNIT/
    // REPAIR events). A tampered prefix is rejected, never trusted.
    const replay = new ReplayRunner().replay({
      schemaVersion: SESSION_LOG_SCHEMA_VERSION,
      version: opts.resumeSessionLog.length,
      events: opts.resumeSessionLog as never,
    });
    if (!replay.ok) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const resumed = reconstructResumedResult(opts.resumeSessionLog, session, problemHash, opts);
    if (resumed !== null) {
      return resumed;
    }
    reconstructedPartial = true;
  }
  if (reconstructedPartial && opts.resumeSessionLog !== null) {
    const carriedModels = opts.resumeSessionLog.filter((row) => row.kind === "MODEL_REQUEST").length;
    for (let index = 0; index < carriedModels; index += 1) {
      if (root.modelCalls() >= opts.maxModelCalls) break;
      const settledId = root.reserveModel("WORK");
      root.settleModel(settledId, "COMPLETE");
    }
    // P0-2: carry the already-spent tool/effect budget too, so a resumed run can
    // use only the remaining allowance and continues the effect id namespace
    // (effect-2, ...). A replayed effect is not re-run.
    const carriedEffects = opts.resumeSessionLog.filter(
      (row) => row.kind === "TOOL_OBSERVATION" || row.kind === "METHOD_LOAD",
    ).length;
    for (let index = 0; index < carriedEffects; index += 1) {
      if (root.effectCalls() >= totalEffectCapacity) break;
      const settledEffect = root.reserveEffect(`effect-${index + 1}`);
      root.settleEffect(settledEffect, "COMPLETE");
    }
  }
  // B1 (DECISION-0150): the bounded, opt-in R0 planning review. It runs before
  // any WORK, shares the same root budget, and may change the contract to
  // version 2 via at most one `reviseGoals`. With the default `maxR0=0` this is
  // a no-op and the run is byte-identical to before.
  if (opts.maxR0 >= 1) {
    contract = await runBoundedR0(contract, root, captured, opts, problemText, session, sessionLog);
  }
  sessionLog.append("CONTRACT", {
    contractVersion: contract.contractVersion,
    tasks: contract.tasks.length,
    obligations: contract.obligations.length,
  });
  const ledger = new ContractLedger(contract);
  const store = new P2WorkunitStore(ledger.snapshot());
  const workflow = new AgentWorkflowRoutes(ledger, store);
  const revision = new AgentRevisionAdmission(ledger, store, (task) => workflow.forTask(task));
  const gate = new P4RecheckModelGate(
    session,
    problemHash,
    contract.contractVersion,
    opts.maxModelCalls,
    root.modelCalls(),
  );
  const calls = new AgentCalls(root, gate, captured, sessionLog);
  const progress = new AgentProgressPolicy();

  let workUnits = 0;
  let schemaRepairs = 0;
  let verifyCalls = 0;
  const refutationDone = new Set<string>();
  let reviewCalls = 0;
  let repairCalls = 0;
  let catalogCalls = 0;
  const resumedRows = opts.resumeSessionLog ?? [];
  let toolEffects = resumedRows.filter((row) => row.kind === "TOOL_OBSERVATION").length;
  let methodLoads = resumedRows.filter((row) => row.kind === "METHOD_LOAD").length;
  let catalog: P2MethodCatalog | null = null;
  let methodAssets: P2MethodAsset[] = [];
  const mathAssetObservations: MathAssetObservation[] = [];
  const assetGuidanceNotes: Array<{ assetId: string; guidance: readonly string[] }> = [];
  let stop: AgentTraceCode = "NO_CANDIDATE";
  let target: P4Target | null = null;
  let protectedOrigin: P4Target | null = null;
  let review: P4ReviewSession | null = null;
  let protectedReview: P4ReviewSession | null = null;
  let reviewTarget: P4Target | null = null;
  let firstReviewOrdinal = 2;
  let candidateTask: P2Task | null = null;
  let revisedDecision: ReturnType<typeof reviseCandidate>["decision"] | null = null;
  let lastRevisionAccepted = false;
  let s1Assessment: P4S1Assessment | null = null;
  let s1AssetDescriptor: string | null = null;
  let s3AssetDescriptor: string | null = null;
  let s2Transaction: {
    readonly supersededObligationIds: readonly string[];
    readonly preservedObligationIds: readonly string[];
    readonly preservedParentArtifactId: string | null;
  } | null = null;

  // Run-scoped answer-closure evidence. A routed exact tool is usually forced on
  // an EARLIER task than the task that carries the answer, so completed tool
  // observations must survive task transitions; the closure itself is still
  // spent at most once per run. Exact-check results are keyed by operation, so a
  // later unrelated operation (e.g. LIMIT) can never displace the
  // MAXIMAL_MINORS/DENSITY_CHECK result a specific diagnostic needs.
  const toolObservationViews: ToolObservationView[] = [];
  const exactObservations = new Map<string, ExactObservationView>();
  let answerClosureTurns = 0;
  const consumedObservationHashes = new Set<string>();

  const callsLeft = (): number => opts.maxModelCalls - root.modelCalls();

  // Stage D+: the single controlled exploration action is offered only when the
  // Host advertised the bounded generated-Python capability. With the default
  // (absent/false) the action word is never offered and a parsed `explore`
  // reply is treated exactly like an unparseable one.
  const allowExploration = opts.allowExploration === true;

  const reserve = (): number =>
    target !== null && target.availability === "ACTIVE" && opts.maxReviews > 0 ? 1 : 0;

  if (opts.resumeSessionLog !== null && opts.resumeSessionLog.length > 0 && reconstructedPartial) {
    for (const row of opts.resumeSessionLog) {
      if (row.kind !== "WORKUNIT") continue;
      const data = row.data as Record<string, unknown>;
      const taskId = data.taskId; const receipt = data.workReceipt; const routeInput = data.routeInput;
      if (typeof taskId !== "string" || typeof receipt !== "object" || receipt === null) continue;
      try {
        if (typeof routeInput === "object" && routeInput !== null) { try { store.registerRoute(routeInput as never); } catch { /* registered */ } }
        const runningTask = ledger.startTask(taskId);
        const artifact = store.accept(runningTask, { ...(receipt as Record<string, unknown>), eventSeq: ledger.nextEventSeq() } as never);
        const ref = { artifactId: artifact.artifactId, artifactVersion: artifact.envelope.artifactVersion ?? 1 };
        ledger.recordDelivery(taskId, ref, artifact.deliveryStatus === "COMPLETE" ? "DELIVERED" : "PARTIAL", ledger.nextEventSeq());
        workUnits += 1;
        const snapR = ledger.snapshot();
        const obligationR = snapR.obligations.find((row) => row.obligationId === runningTask.obligationId);
        const rootGoalR = snapR.goals.some((goal) => goal.goalId === runningTask.goalId);
        if (obligationR !== undefined && rootGoalR && p2IsAnswerObligationKindForGoal(goalKindOf(snapR.goals, runningTask.goalId), obligationR.kind)) {
          target = p4Target(snapR, artifact, "ACTIVE");
          protectedOrigin = target;
          candidateTask = runningTask;
        }
      } catch (error) { if (!(error instanceof P2Error)) throw error; fail(P2_ERROR_CODES.PACKET_BINDING); }
    }
  }

  const methodsEnabled =
    opts.maxMethodLoads > 0 &&
    captured.effect !== null &&
    captured.catalog !== null &&
    opts.maxEffects > 0 &&
    totalEffectCapacity > 0 &&
    opts.maxModelCalls >= 2 + opts.maxReviews;
  if (methodsEnabled && root.remainingMs() > MIN_MS) {
    const readRemaining = root.remainingMs();
    let raw: unknown = null;
    try {
      raw = await boundedAwait(() => {
        catalogCalls += 1;
        return captured.catalog!.read(readRemaining);
      }, readRemaining);
    } catch {
      raw = null;
    }
    if (raw !== null) {
      try {
        catalog = p3MethodCatalog(p2Snapshot(raw));
      } catch {
        catalog = null;
      }
    }
    if (catalog === null || catalog.entries.length === 0) {
      catalog = null;
    }
  }

  try {
    while (workUnits < opts.maxWorkUnits && !root.stopped()) {
      if (callsLeft() <= reserve() || root.remainingMs() <= MIN_MS) {
        stop = root.remainingMs() <= MIN_MS ? "DEADLINE_EXCEEDED" : "BUDGET_EXHAUSTED";
        break;
      }
      const ready = ledger.readyTasks();
      const pendingRedoTaskId = revision.pendingTaskId();
      const redoReady =
        pendingRedoTaskId === null
          ? []
          : ready.filter((task) => task.taskId === pendingRedoTaskId);
      // A pending redo whose task is not genuinely READY is a control
      // inconsistency: never fall back to an unrelated ordinary task while a
      // redo is pending, because that would move other mathematical state.
      if (pendingRedoTaskId !== null && redoReady.length === 0) {
        root.stop("CONTROL_REJECTED");
        stop = "CONTROL_REJECTED";
        break;
      }
      // A dynamically admitted route task is preferred while it is genuinely
      // READY; otherwise the original ready set is used unchanged.
      const routeReady = ready.filter(
        (task) =>
          workflow.provenanceOf(task.taskId) !== null ||
          workflow.dependencyProvenanceOf(task.taskId) !== null,
      );
      const chosen = chooseP2ReadyTask(
        ledger.snapshot(),
        redoReady.length > 0 ? redoReady : routeReady.length > 0 ? routeReady : ready,
      );
      if (chosen === null) {
        stop = "WORK_UNITS_COMPLETE";
        break;
      }
      let running: P2Task;
      try {
        running = ledger.startTask(chosen.taskId);
      } catch (error) {
        if (!(error instanceof P2Error)) {
          throw error;
        }
        stop = "CONTROL_REJECTED";
        break;
      }
      const route = workflow.forTask(running);
      const observations: P3EffectReceipt[] = [];
      const seenEffectIds = new Set<string>();
      for (const item of calls.effects) {
        const receipt = item.receipt;
        if (receipt.binding.taskId !== running.taskId) {
          continue;
        }
        if (receipt.status !== "COMPLETE" && receipt.status !== "ERROR") {
          continue;
        }
        if (seenEffectIds.has(receipt.effectId)) {
          continue;
        }
        seenEffectIds.add(receipt.effectId);
        observations.push(receipt);
      }
      let subGate: P3EffectGate | null = null;
      const effectRoom = totalEffectCapacity - root.effectCalls();
      if (effectRoom > 0 && captured.effect !== null) {
        subGate = new P3EffectGate(
          {
            sessionId: session,
            problemHash,
            contractVersion: contract.contractVersion,
            taskId: running.taskId,
            scopeId: running.scopeId,
          },
          effectRoom,
          root.effectCalls() + 1,
        );
      }
      let advanced = false;
      let yielded = false;
      let methodSelectionAttempted = false;
      // Set only when a new card body was just loaded. The next WORK turn
      // consumes it once to append the bounded method/tool advisory.
      let methodToolCoPromptCardId: string | null = null;
      let forcedMethodSelection = false;
      let forcedMethodCandidates: readonly string[] = [];
      // The routed list is run-task scoped so the optional second-card offer can
      // refer back to the same METHOD_ROUTE row after the first body is loaded.
      let routedMethodCandidates: readonly string[] = [];
      let secondMethodRouteEligible = false;
      let secondMethodOfferPending = false;
      let methodLoadRefusalNotice: string | null = null;
      let methodLoadRefusalUsed = false;
      let enumerationAttempted = false;
      let forcedEnumerationSelection = false;
      let exactCheckAttempted = false;
      let forcedExactCheckSelection = false;
      let forcedExactCheckOperation: string | null = null;
      let semanticToolAttempted = false;
      let forcedSemanticToolSelection = false;
      let forcedSemanticToolRoute: SemanticToolRoute | null = null;
      let mathAssetAttempted = false;
      let forcedMathAssetSelection = false;
      let forcedMathAssetRoute: SemanticMathAssetRoute | null = null;
      let forcedRetryUsed = false;
      let forcedTurnFailedOpen = false;
      let verdictClosureAttempted = false;
      let forcedVerdictClosure = false;
      let densityClosureAttempted = false;
      let forcedDensityClosure = false;
      let densityCheckFailure: string | null = null;
      // Batch 2 (deep loop): bounded, fail-closed retry of a TRANSIENT model
      // failure on the SAME task. An unusable/unknown transport is never accepted
      // as progress or evidence; we may re-ask a bounded number of times.
      let workRetries = 0;
      while (!root.stopped()) {
        forcedTurnFailedOpen = false;
        let secondMethodOfferShown = false;
        if (root.remainingMs() <= MIN_MS) {
          stop = "DEADLINE_EXCEEDED";
          break;
        }
        const inputs: P2Artifact[] = [];
        let inputOk = true;
        for (const ref of running.inputArtifactRefs) {
          const entry = store.get(ref);
          if (entry.availability !== "ACTIVE") {
            inputOk = false;
            break;
          }
          inputs.push(entry.artifact);
        }
        if (!inputOk) {
          stop = "CONTROL_REJECTED";
          break;
        }
        const cachedTool = observations.some(
          (item) => item.source === "PROGRAM_OBSERVATION",
        );
        const cachedMethod = observations.some(
          (item) => item.source === "METHOD_REFERENCE",
        );
        // The model reserve is never lowered by a cache hit: a later WORK and
        // the R2 review must still fit. A cache hit only keeps an action
        // advertised when the root effect room is already spent.
        const allowTools =
          subGate !== null &&
          callsLeft() >= 2 + opts.maxReviews &&
          (toolEffects < opts.maxEffects || cachedTool);
        const allowMethods =
          catalog !== null &&
          subGate !== null &&
          callsLeft() >= 2 + opts.maxReviews &&
          ((methodLoads < methodLoadCapacity &&
            root.effectCalls() < totalEffectCapacity) ||
            cachedMethod);
        // Stage D+: one bounded exploration is offered only when the Host
        // advertised the bounded capability AND the same tool-kind effect room
        // a tool action would need is still free. It reserves one model call
        // for the follow-up work packet, exactly like a tool action.
        const allowExplore =
          allowExploration &&
          subGate !== null &&
          callsLeft() >= 2 + opts.maxReviews &&
          toolEffects < opts.maxEffects &&
          root.effectCalls() < totalEffectCapacity;
        const protectedCandidate = projectProtectedFinal(ledger.snapshot(), target);
        const sameScope =
          protectedCandidate !== null &&
          protectedCandidate.binding.scopeId === running.scopeId;
        const exposedCandidate = sameScope ? protectedCandidate : null;
        const allowFinal = sameScope && callsLeft() >= 1 + opts.maxReviews;
        // The proposal flag reserves the current WORK call itself: admission
        // is only considered for the budget left after this work is received.
        const remainingCallsAfterWork = callsLeft() - 1;
        const remainingUnitsAfterWork = opts.maxWorkUnits - workUnits - 1;
        const allowRouteProposal =
          !revision.hasUsed() &&
          remainingCallsAfterWork >= 1 &&
          remainingUnitsAfterWork >= 1 &&
          workflow.canAdmit(
            remainingCallsAfterWork,
            opts.maxReviews,
            remainingUnitsAfterWork,
            root.remainingMs(),
          );
        const allowTaskContinuation =
          !revision.hasUsed() &&
          remainingCallsAfterWork >= 1 &&
          remainingUnitsAfterWork >= 1 &&
          workflow.canContinue(
            remainingCallsAfterWork,
            opts.maxReviews,
            remainingUnitsAfterWork,
            root.remainingMs(),
          );
        // The redo flag is a budget question only: a pending redo makes
        // `canRedo` false by itself, so no pending condition belongs here.
        const allowArtifactRedo =
          remainingCallsAfterWork >= 1 &&
          remainingUnitsAfterWork >= 1 &&
          revision.canRedo(
            remainingCallsAfterWork,
            opts.maxReviews,
            remainingUnitsAfterWork,
            root.remainingMs(),
          );
        const requestId = root.nextModelId();
        if (requestId === null) {
          stop = "BUDGET_EXHAUSTED";
          break;
        }
        const answerSnapshot = ledger.snapshot();
        const runningObligation = answerSnapshot.obligations.find(
          (row) => row.obligationId === running.obligationId,
        );
        const answerKind = p2AnswerObligationForGoal(
          goalKindOf(answerSnapshot.goals, running.goalId),
        );
        const answerBearingTask =
          target === null &&
          runningObligation !== undefined &&
          runningObligation.kind === answerKind &&
          answerSnapshot.goals.some((goal) => goal.goalId === running.goalId);
        // Deep loop step 1 (opt-in, `maxRepairs >= 1`): EVIDENCE BEFORE
        // DELIVERY. On the first turn of the answer-bearing task the fixed
        // system prompt additionally asks for one refutation attempt with a
        // registered tool, so the review and repair gates have a real program
        // observation instead of a model's opinion. The flag changes only the
        // system prompt of that one turn: the recorded user payload is
        // byte-identical, no packet is ever dropped and no protocol shape
        // changes. With `maxRepairs=0` the run is byte-identical.
        let refutationRequired = false;
        if (
          opts.maxRepairs >= 1 &&
          schemaRepairs === 0 &&
          verifyCalls === 0 &&
          allowTools &&
          subGate !== null &&
          !refutationDone.has(running.taskId) &&
          !observations.some((item) => item.source === "PROGRAM_OBSERVATION")
        ) {
          refutationRequired = answerBearingTask;
          if (refutationRequired) {
            verifyCalls += 1;
            refutationDone.add(running.taskId);
            sessionLog.append("REPAIR", {
              kind: "REFUTATION_REQUEST",
              taskId: running.taskId,
              verifyCalls,
            });
          }
        }
        let context: ReturnType<typeof buildAgentWorkContext>;
        try {
          // Read-only wiring of the declared scope-coverage rows of this task
          // AND of its declared upstream tasks (the tasks it consumes). A task's
          // own declaration is registered only after it runs, so in practice a
          // row is read by the downstream consumers that depend on the declaring
          // task. The rows are declared data only: they never close an
          // obligation, never change the ready set and are never a coverage
          // proof. A missing declaration is an empty list.
          const upstreamTaskIds = new Set(running.dependencyTaskIds);
          const declaredCoverage = store
            .scopeCoverageSnapshot()
            .filter((row) => row.taskId === running.taskId || upstreamTaskIds.has(row.taskId));
          context = buildAgentWorkContext({
            contract: ledger.snapshot(),
            task: running,
            route,
            requestId,
            inputs,
            toolObservations: observations,
            allowTools,
            allowMethods,
            allowFinal,
            protectedCandidate: exposedCandidate,
            catalog,
            methodAssets,
            allowRouteProposal,
            allowTaskContinuation,
            allowArtifactRedo,
            routeProvenance: workflow.provenanceOf(running.taskId),
            dependencyProvenance: workflow.dependencyProvenanceOf(running.taskId),
            revisionProvenance: revision.provenanceFor(running.taskId),
            revisionTarget: revision.targetFor(running.taskId),
            scopeCoverage: declaredCoverage,
            refutationRequired,
            explorationAvailable: allowExplore,
          });
        } catch (error) {
          if (!(error instanceof P2Error)) {
            throw error;
          }
          stop = "CONTEXT_REJECTED";
          break;
        }
        const buildConsensusContext = (nextId: string, note: string) => {
          const upstreamTaskIds = new Set(running.dependencyTaskIds);
          const declaredCoverage = store
            .scopeCoverageSnapshot()
            .filter(
              (row) =>
                row.taskId === running.taskId || upstreamTaskIds.has(row.taskId),
            );
          const built = buildAgentWorkContext({
            contract: ledger.snapshot(),
            task: running,
            route,
            requestId: nextId,
            inputs,
            toolObservations: observations,
            allowTools,
            allowMethods,
            allowFinal: false,
            protectedCandidate: exposedCandidate,
            catalog,
            methodAssets,
            allowRouteProposal,
            allowTaskContinuation,
            allowArtifactRedo,
            routeProvenance: null,
            dependencyProvenance: null,
            revisionProvenance: null,
            revisionTarget: null,
            scopeCoverage: declaredCoverage,
            refutationRequired: false,
          });
          const messages = [
            {
              role: "system" as const,
              content: built.messages[0]!.content + "\n\n" + note,
            },
            built.messages[1]!,
          ];
          return {
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          };
        };
        if (forcedDensityClosure) {
          const note =
            "\n\nDENSITY NORMALIZATION FAILURE. exact_check_expr reports that the claimed density integrates to " +
            JSON.stringify(densityCheckFailure ?? "a value other than 1") +
            ", not 1. A probability density must integrate to 1. Re-derive the distribution from the process definition " +
            "(time change, reflection principle or conditioning), correct both the CDF and the density, and do not repeat the same density. " +
            "Return exactly one complete WorkPacket with the corrected answer and include " +
            "`CERT1|CHECK|C1|DENSITY_CHECK|<integral computation> => PASS` and `CERT1|FINAL|OK` in suggestedChecks.";
          const messages = [
            {
              role: "system" as const,
              content: context.messages[0]!.content + note,
            },
            context.messages[1]!,
          ];
          context = {
            ...context,
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          };
        } else if (forcedVerdictClosure) {
          const note =
            "\n\nVERDICT CONSISTENCY TURN. Your own candidate begins with an affirmative verdict but also says the proposition is not always true. " +
            "For a universal statement, one counterexample makes the verdict FALSE; a statement that is only typical or needs an extra condition is FALSE. " +
            "Return exactly one complete WorkPacket with candidateProposal exactly \"错误\" and suggestedChecks containing " +
            "`CERT1|CHECK|C1|COUNTEREXAMPLE|<explicit counterexample or quantifier reason> => PASS`, `CERT1|VERDICT|FALSE`, and `CERT1|FINAL|错误`. " +
            "Keep the current task and scope; do not return a WorkPacket with an affirmative verdict in this turn.";
          const messages = [
            {
              role: "system" as const,
              content: context.messages[0]!.content + note,
            },
            context.messages[1]!,
          ];
          context = {
            ...context,
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          };
        } else if (forcedExactCheckSelection) {
          const operation = forcedExactCheckOperation ?? "SIMPLIFY";
          const operationArgs =
            operation === "MAXIMAL_MINORS"
              ? "matrix: <the explicit matrix>, variable: \"t\""
              : operation === "TRIG_REDUCE"
                ? "expression: <the trigonometric/polynomial expression>, variable: \"x\""
                : operation === "FACTOR_OVER_EXTENSION"
                  ? "expression: <the polynomial>, variable: \"x\", minimal_polynomials: [<minimal polynomials of the actual claimed generators>]; test both the claimed field and the field generated by all roots, and require splits_completely=true for a splitting field"
                  : operation === "DENSITY_CHECK"
                    ? "density: <the claimed density valid on its support only; do not include text such as 'for x>=0'>, variable: \"x\", lower: \"0\", upper: \"oo\"; Phi(x) and phi(x) are accepted standard normal notation"
                    : operation === "LIMIT"
                      ? "expression: <the expression>, variable: \"x\", point: <the limit point>"
                      : operation === "DEFINITE_INTEGRAL"
                        ? "expression: <the integrand as a JSON string>, variable: \"x\", lower: <the lower bound as a JSON string>, upper: <the upper bound as a JSON string>"
                        : operation === "SIMPLIFY"
                          ? "expression: <the expression>, variable: \"x\""
                          : "expression: <the expression>, variable: \"x\"";
          const note =
            "\n\nEXACT CHECK TURN. This answer involves a " + operation + " obligation. " +
            "Before delivering a WorkPacket, return exactly one JSON tool action " +
            "{\"action\":\"tool\",\"name\":\"exact_check_expr\",\"args\":{\"operation\":\"" + operation + "\"," + operationArgs + "},\"scope\":\"<what is being checked>\"} " +
            "and nothing else. Every expression and every matrix entry must be a quoted JSON string; never place raw arithmetic in JSON. " +
            "Copy the explicit matrix/expression exactly from the problem statement; do not retype or simplify its entries. " +
            "Use ** or ^ for powers; every matrix entry is still a quoted JSON string. " +
            "do not return a WorkPacket in this turn. The observation is an input-relative exact computation, not a proof of the mapping. " +
            "After the observation, return a COMPLETE WorkPacket with a best-effort candidate; do not use INCOMPLETE merely because a check is inconclusive.";
          const messages = [
            {
              role: "system" as const,
              content: context.messages[0]!.content + note,
            },
            context.messages[1]!,
          ];
          context = {
            ...context,
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          };
        } else if (forcedEnumerationSelection) {
          const note =
            "\n\nFINITE ENUMERATION TURN. This problem asks for a finite count or probability. " +
            "Before delivering a WorkPacket, return exactly one JSON tool action " +
            "{\"action\":\"tool\",\"name\":\"bounded_enumeration\",\"args\":{\"ranges\":[<positive sizes>],\"choose\":<k>,\"predicate\":\"<expression>\"},\"scope\":\"<what is enumerated>\"} " +
            "and nothing else. `ranges` describes ONE physical item: it generates the Cartesian product " +
            "0..n_i-1 over its attributes, not one range per selected position. `choose` is the number of " +
            "items selected. `predicate` may use distinct(i), count(i,v), size(), sum(i), min(i), max(i) and " +
            "contains(i,v); distinct(i) is computed across the selected subset. Choose attributes that make " +
            "the target event expressible, and do not substitute a closed-form pattern formula for the enumeration. " +
            "Do not return a WorkPacket in this turn.";
          const messages = [
            {
              role: "system" as const,
              content: context.messages[0]!.content + note,
            },
            context.messages[1]!,
          ];
          context = {
            ...context,
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          };
        } else if (forcedMathAssetSelection && forcedMathAssetRoute !== null) {
          const route = forcedMathAssetRoute;
          const note =
            "\n\nMATH ASSET TURN. This problem involves a mathematical computation (" + route.assetId + ":" + route.target + "). " +
            "Before delivering a WorkPacket, return exactly one JSON math_asset action: " +
            "{\"action\":\"math_asset\",\"assetId\":\"" + route.assetId + "\",\"target\":\"" + route.target + "\",\"input\":" + route.argsTemplate + "} " +
            "and nothing else. Do not return a WorkPacket in this turn.";
          const messages = [
            {
              role: "system" as const,
              content: context.messages[0]!.content + note,
            },
            context.messages[1]!,
          ];
          context = {
            ...context,
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          };
        } else if (forcedSemanticToolSelection && forcedSemanticToolRoute !== null) {
          const route = forcedSemanticToolRoute;
          const note = semanticToolTurnNote(route);
          const messages = [
            {
              role: "system" as const,
              content: context.messages[0]!.content + note,
            },
            context.messages[1]!,
          ];
          context = {
            ...context,
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          };
        } else if (forcedMethodSelection) {
          const routed = forcedMethodCandidates
            .map((id) => catalog?.entries.find((entry) => entry.id === id) ?? null)
            .filter((entry) => entry !== null);
          const routedIds = new Set(routed.map((entry) => entry.id));
          const remainingIds =
            catalog === null
              ? []
              : catalog.entries
                  .map((entry) => entry.id)
                  .filter((id) => !routedIds.has(id));
          const routeNote =
            routed.length === 0
              ? ""
              : "\n\nRouted method candidates (metadata only; bodies are not loaded):\n" +
                routed
                  .map((entry) => {
                    const objects = Array.isArray(entry.objects)
                      ? entry.objects.join(", ")
                      : "";
                    return entry.id + " — " + entry.title + " — " + objects;
                  })
                  .join("\n") +
                "\nOther available method ids: " +
                remainingIds.join(", ") +
                ".";
          const note =
            "\n\nMETHOD SELECTION TURN. Before delivering a WorkPacket, choose exactly one method id from methodCatalog. " +
            "Return exactly one JSON action {\"action\":\"method\",\"id\":\"<one id from methodCatalog>\"} and nothing else. " +
            "Do not return a WorkPacket in this turn." +
            routeNote;
          const messages = [
            {
              role: "system" as const,
              content: context.messages[0]!.content + note,
            },
            context.messages[1]!,
          ];
          context = {
            ...context,
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          };
        }
        // The first load is mandatory once a method-consultation turn is
        // selected. A second load is only ever an OFFER on the immediately
        // following turn: the model still sees the first body, the remaining
        // routed metadata and the ordinary answer path. A second candidate is
        // offered only when the routed list genuinely has one, the first card
        // is not that second candidate, the shared call reserve still fits and
        // the Host advertised method loading through its catalog/effect ports.
        const loadedMethodIds = methodAssets.map((asset) => asset.id);
        const firstLoadedMethodId =
          methodAssets.length === 1 ? methodAssets[0]!.id : null;
        const secondMethodCandidateId = routedMethodCandidates[1] ?? null;
        const offerSecondMethod =
          secondMethodOfferPending &&
          !forcedTurnFailedOpen &&
          firstLoadedMethodId !== null &&
          secondMethodCandidateId !== null &&
          routedMethodCandidates.length >= 2 &&
          firstLoadedMethodId !== secondMethodCandidateId &&
          methodLoads < methodLoadCapacity &&
          catalog !== null &&
          subGate !== null &&
          captured.catalog !== null &&
          root.effectCalls() < totalEffectCapacity &&
          callsLeft() >= 2 + opts.maxReviews;
        secondMethodOfferShown = offerSecondMethod;
        if (offerSecondMethod) {
          secondMethodOfferPending = false;
        }
        const methodEntryLine = (entry: {
          readonly id: string;
          readonly title: string;
          readonly objects?: readonly string[];
        }): string =>
          entry.id + " — " + entry.title + " — " +
          (Array.isArray(entry.objects) ? entry.objects.join(", ") : "");
        const remainingRouted = routedMethodCandidates
          .filter((id) => !loadedMethodIds.includes(id))
          .map((id) => catalog?.entries.find((entry) => entry.id === id) ?? null)
          .filter((entry) => entry !== null);
        const loadedMethodNote =
          loadedMethodIds.length === 0
            ? ""
            : "\n\nLoaded method card ids (bodies are in methodAssets): " +
              loadedMethodIds.join(", ") +
              ".";
        const remainingRoutedNote =
          remainingRouted.length === 0
            ? ""
            : "\nRouted method candidates not yet loaded (metadata only):\n" +
              remainingRouted.map(methodEntryLine).join("\n");
        let methodOfferNote = "";
        if (offerSecondMethod) {
          methodOfferNote =
            "\n\nSECOND METHOD SELECTION TURN (optional)." +
            loadedMethodNote +
            remainingRoutedNote +
            "\nYou may return exactly one JSON action " +
            "{\"action\":\"method\",\"id\":\"<one routed id>\"} to load one more card, " +
            "or answer now with exactly one complete WorkPacket. The second load is optional " +
            "and is never required. Do not return a WorkPacket and a method action together.";
        } else if (methodLoadRefusalNotice !== null) {
          methodOfferNote =
            "\n\n" + methodLoadRefusalNotice +
            loadedMethodNote +
            remainingRoutedNote;
          methodLoadRefusalNotice = null;
        } else if (methodAssets.length >= 2) {
          const canStillAct =
            !observations.some(
              (item) =>
                item.source === "PROGRAM_OBSERVATION" ||
                item.source === "GENERATED_OBSERVATION",
            ) &&
            ((allowTools && toolEffects < opts.maxEffects) || allowExplore) &&
            root.effectCalls() < totalEffectCapacity &&
            callsLeft() >= 2 + opts.maxReviews;
          methodOfferNote =
            "\n\nMETHOD CONTEXT." +
            loadedMethodNote +
            remainingRoutedNote +
            (canStillAct
              ? "\nNo further method load is available; you may invoke one registered tool or one bounded exploration action if needed, or answer with exactly one complete WorkPacket now."
              : "\nNo further method load is available; answer with exactly one complete WorkPacket now.");
        }
        if (methodOfferNote !== "") {
          const messages = [
            {
              role: "system" as const,
              content: context.messages[0]!.content + methodOfferNote,
            },
            context.messages[1]!,
          ];
          context = {
            ...context,
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
          };
        }
        // The immediate post-card WORK turn sees the routed tool's exact safe
        // args skeleton. This is prompt text only and is a byte-identical
        // no-op whenever any guard fails; a packet submitted anyway still goes
        // through the existing forced-tool fallback below.
        if (captured.mathAsset !== null && captured.mathAsset !== undefined) {
          const mathRoute = semanticMathAssetRoute(problemText);
          if (
            mathRoute !== null &&
            !observations.some((item) => item.source === "PROGRAM_OBSERVATION") &&
            allowTools &&
            toolEffects < opts.maxEffects &&
            root.effectCalls() < totalEffectCapacity &&
            callsLeft() >= 2 + opts.maxReviews
          ) {
            const messages = [
              {
                role: "system" as const,
                content:
                  context.messages[0]!.content +
                  mathAssetCoPrompt(mathRoute),
              },
              context.messages[1]!,
            ];
            context = {
              ...context,
              messages,
              contextHash: p4Hash(JSON.stringify(messages)),
              contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
            };
          }
        } else if (methodToolCoPromptCardId !== null && methodAssets.length >= 1) {
          const methodToolRoute = semanticToolRoute(problemText);
          if (
            methodToolRoute !== null &&
            !observations.some((item) => item.source === "PROGRAM_OBSERVATION") &&
            allowTools &&
            toolEffects < opts.maxEffects &&
            root.effectCalls() < totalEffectCapacity &&
            callsLeft() >= 2 + opts.maxReviews
          ) {
            // The advisory belongs on the SYSTEM message: the Host parses the
            // user message as exactly one JSON object (`validate_context`), so
            // appending prose there made every post-card WORK turn a fixed
            // FIELD_VALUE rejection. The trusted body is left byte-identical.
            const messages = [
              {
                role: "system" as const,
                content:
                  context.messages[0]!.content +
                  methodToolCoPrompt(methodToolCoPromptCardId, methodToolRoute),
              },
              context.messages[1]!,
            ];
            context = {
              ...context,
              messages,
              contextHash: p4Hash(JSON.stringify(messages)),
              contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
            };
          } else if (
            methodToolRoute === null &&
            allowExplore &&
            !observations.some(
              (item) =>
                item.source === "PROGRAM_OBSERVATION" ||
                item.source === "GENERATED_OBSERVATION",
            )
          ) {
            const messages = [
              {
                role: "system" as const,
                content: context.messages[0]!.content + explorationCoPrompt(),
              },
              context.messages[1]!,
            ];
            context = {
              ...context,
              messages,
              contextHash: p4Hash(JSON.stringify(messages)),
              contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
            };
          }
          // "Just loaded" is consumed by exactly this next WORK turn.
          methodToolCoPromptCardId = null;
        }
        if (assetGuidanceNotes.length > 0) {
          const guidanceStr = assetGuidanceNotes
            .map((g) => `\n\n[MATH ASSET GUIDANCE: ${g.assetId}]\n${g.guidance.join("\n")}`)
            .join("");
          if (!context.messages[0]!.content.includes(guidanceStr)) {
            const messages = [
              {
                role: "system" as const,
                content: context.messages[0]!.content + guidanceStr,
              },
              context.messages[1]!,
            ];
            context = {
              ...context,
              messages,
              contextHash: p4Hash(JSON.stringify(messages)),
              contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
            };
          }
        }
        let outcome = await calls.model({
          task: running,
          phase: "WORK",
          messages: context.messages,
          contextHash: context.contextHash,
          contextBytes: context.contextBytes,
        });
        if (outcome.receipt.transportStatus !== "COMPLETE") {
          // Pi truncated-tool-barrier (E08/E09): a reply that is not COMPLETE
          // never yields a tool/method action, an artifact or a candidate. An
          // explicit length/TRUNCATED is marked TRUNCATED; a missing finish
          // reason stays COMPLETENESS_UNKNOWN and conservatively bans actions.
          sessionLog.append("TRUNCATION", {
            phase: "WORK",
            transportStatus: outcome.receipt.transportStatus,
            completeness:
              outcome.receipt.transportStatus === "TRUNCATED"
                ? "TRUNCATED"
                : "COMPLETENESS_UNKNOWN",
          });
        }
        if (
          outcome.receipt.transportStatus !== "COMPLETE" ||
          outcome.code !== "WORK" ||
          root.remainingMs() <= MIN_MS
        ) {
          const transient =
            outcome.code !== "WORK" && outcome.code !== "DEADLINE_EXCEEDED";
          if (
            transient &&
            workRetries < 2 &&
            callsLeft() > reserve() &&
            root.remainingMs() > MIN_MS
          ) {
            workRetries += 1;
            continue;
          }
          stop = outcome.code === "WORK" ? "DEADLINE_EXCEEDED" : outcome.code;
          break;
        }
        let action: P3Action | null = null;
        try {
          const parsedAction = parseP3Action(outcome.receipt.text);
          // Stage D+ controlled exploration: the action word is offered (and
          // honoured) only when the Host advertised `AVAILABLE_BOUNDED`
          // generated Python. Otherwise an `explore` reply is treated exactly
          // like an unparseable one, so every default run is unchanged.
          action =
            parsedAction.action === "explore" && !allowExploration ? null : parsedAction;
        } catch {
          action = null;
        }
        // A forced method/tool turn is a protocol gate, not advice. If the
        // reply does not name the requested effect, re-send the same bounded
        // instruction exactly once. After that one retry the turn fails open
        // to the model's best-effort packet; no observation is ever invented.
        const forcedRouteAtAction = forcedSemanticToolRoute;
        const forcedMethodAtAction = forcedMethodSelection;
        const obeyedRouteAtAction =
          forcedRouteAtAction !== null &&
          action?.action === "tool" &&
          action.name === forcedRouteAtAction.toolName &&
          (forcedRouteAtAction.toolName !== "exact_check_expr" ||
            (typeof action.args["operation"] === "string" &&
              action.args["operation"] === forcedRouteAtAction.operation));
        if (forcedMethodAtAction || forcedRouteAtAction !== null) {
          const obeyedMethod = forcedMethodAtAction && action?.action === "method";
          const obeyedTool = obeyedRouteAtAction;
          if (!obeyedMethod && !obeyedTool) {
            if (!forcedRetryUsed) {
              forcedRetryUsed = true;
              sessionLog.append("REPAIR", {
                kind: "FORCED_TURN_RETRY",
                routeId:
                  forcedRouteAtAction?.id ??
                  (forcedMethodAtAction ? "METHOD_SELECTION" : null),
                expectedTool: forcedRouteAtAction?.toolName ?? null,
                expectedOperation: forcedRouteAtAction?.operation ?? null,
                expectedMethod: forcedMethodAtAction,
                observedKind: action === null ? "PACKET_OR_TEXT" : action.action,
                attempt: 1,
                taskId: running.taskId,
              });
              continue;
            }
            // One retry was already spent. Consume no fabricated evidence and
            // let the ordinary packet/action path decide from here.
            forcedTurnFailedOpen = true;
          }
          forcedMethodSelection = false;
          forcedMethodCandidates = [];
          forcedEnumerationSelection = false;
          forcedExactCheckSelection = false;
          forcedSemanticToolSelection = false;
          forcedMathAssetSelection = false;
          forcedExactCheckOperation = null;
          forcedSemanticToolRoute = null;
          forcedMathAssetRoute = null;
          forcedRetryUsed = false;
        }
        if (action !== null && action.action === "math_asset") {
          if (captured.mathAsset === null || captured.mathAsset === undefined) {
            stop = "CONTROL_REJECTED";
            break;
          }
          if (root.effectCalls() >= totalEffectCapacity || toolEffects >= opts.maxEffects) {
            stop = "CONTROL_REJECTED";
            break;
          }
          const reservedOrdinal = root.effectCalls() + 1;
          const effectId = `effect-${reservedOrdinal}`;
          const reservedEffect = root.reserveEffect(effectId);
          let mathAssetResult: MathAssetResult;
          try {
            mathAssetResult = (await captured.mathAsset.execute({
              action: "math_asset",
              assetId: action.assetId,
              ...(action.target ? { target: action.target } : {}),
              input: action.input,
              binding: {
                taskId: running.taskId,
                goalId: running.goalId,
                scopeId: running.scopeId,
                contractVersion: contract.contractVersion,
                sourceRequestId: outcome.requestId,
              },
            })) as MathAssetResult;
          } catch {
            root.settleEffect(reservedEffect, "ERROR");
            stop = "CONTROL_REJECTED";
            break;
          }
          const isComplete = (mathAssetResult.status as string) === "COMPLETE" || (mathAssetResult.status as string) === "SUCCESS";
          root.settleEffect(reservedEffect, isComplete ? "COMPLETE" : "ERROR");
          toolEffects += 1;

          // Reject catalog digest drift fail-closed
          if (mathAssetResult.catalogDigest && mathAssetResult.catalogDigest !== MATH_ASSET_CATALOG_DIGEST) {
            stop = "CONTROL_REJECTED";
            break;
          }

          // Strict binding verification: reject cross-task, cross-contract, or cross-scope observations fail-closed
          if (mathAssetResult.binding) {
            const b = mathAssetResult.binding;
            if (
              b.taskId !== running.taskId ||
              b.contractVersion !== contract.contractVersion ||
              (b.goalId && b.goalId !== running.goalId) ||
              (b.scopeId && b.scopeId !== running.scopeId)
            ) {
              stop = "CONTROL_REJECTED";
              break;
            }
          }

          // Strict item-level observation verification
          let hasInvalidObservation = false;
          for (const obs of mathAssetResult.observations) {
            if (
              obs.taskId !== running.taskId ||
              obs.contractVersion !== contract.contractVersion ||
              (mathAssetResult.inputHash && obs.sourceInputHash && obs.sourceInputHash !== mathAssetResult.inputHash)
            ) {
              hasInvalidObservation = true;
              break;
            }
          }
          if (hasInvalidObservation) {
            stop = "CONTROL_REJECTED";
            break;
          }

          // Propagate method guidance / knowledge across subsequent model turns
          if (Array.isArray(mathAssetResult.guidance) && mathAssetResult.guidance.length > 0) {
            assetGuidanceNotes.push({
              assetId: mathAssetResult.assetId,
              guidance: mathAssetResult.guidance,
            });
          }
          sessionLog.append("TOOL_OBSERVATION", {
            toolName: `math_asset:${mathAssetResult.assetId}`,
            assetId: mathAssetResult.assetId,
            status: mathAssetResult.status,
            resultHash: mathAssetResult.resultHash,
            observationsCount: mathAssetResult.observations.length,
          });
          const hostReceipts = Array.isArray((mathAssetResult as any).receipts)
            ? ((mathAssetResult as any).receipts as readonly P3EffectReceipt[])
            : [];
          for (let i = 0; i < mathAssetResult.observations.length; i++) {
            const obs = mathAssetResult.observations[i];
            if (!obs) {
              continue;
            }
            mathAssetObservations.push(obs);
            const obsStr = JSON.stringify({ result: obs.value, operation: obs.quantity, target: obs.quantity });
            const effectId = reservedEffect;
            const hostReceipt = hostReceipts[i];
            const receipt: P3EffectReceipt = (hostReceipt && hostReceipt.effectId) ? hostReceipt : {
              effectId,
              binding: {
                sessionId: session,
                problemHash,
                contractVersion: contract.contractVersion,
                taskId: running.taskId,
                scopeId: running.scopeId,
                sourceRequestId: outcome.requestId,
              },
              source: "PROGRAM_OBSERVATION",
              level: "PROVISIONAL",
              status: "COMPLETE",
              observation: obsStr,
              observationHash: p4Hash(obsStr),
              checkResult: "UNKNOWN",
            };
            observations.push(receipt);
            calls.effects.push({
              request: {
                effectId: receipt.effectId,
                binding: receipt.binding,
                action: {
                  action: "math_asset",
                  assetId: action.assetId,
                  ...(action.target ? { target: action.target } : {}),
                  input: action.input,
                },
                remainingMs: root.remainingMs(),
              },
              receipt,
            });
            toolObservationViews.push({
              name: (action.target || obs.quantity || action.assetId) as string,
              operation: (obs.quantity || action.target || null) as string | null,
              result: obs.value,
            });
            if (typeof obs.quantity === "string" && obs.quantity.length > 0) {
              const exactView: ExactObservationView = {
                operation: obs.quantity.toUpperCase(),
                value: obs.value,
                result: obs.value,
                ...((typeof obs.value === "object" && obs.value !== null) ? (obs.value as Record<string, unknown>) : {}),
              };
              exactObservations.set(obs.quantity, exactView);
              exactObservations.set(obs.quantity.toLowerCase(), exactView);
              exactObservations.set(obs.quantity.toUpperCase(), exactView);
              if (
                (obs.quantity === "DENSITY_CHECK" || obs.quantity === "density_check") &&
                typeof obs.value === "object" &&
                obs.value !== null
              ) {
                const rec = obs.value as Record<string, unknown>;
                if (rec["integrates_to_one"] === false) {
                  densityCheckFailure = typeof rec["integral"] === "string" ? rec["integral"] : "a value other than 1";
                }
              }
            }
          }
          // Late observation check (§5.5): if a candidate is already protected, check whether
          // newly arrived observations contradict it and initiate a bounded revision turn.
          const unconsumed = observations.filter(
            (o) => !consumedObservationHashes.has(o.observationHash),
          );
          if (protectedOrigin !== null && unconsumed.length > 0) {
            const protectedCandidate = projectProtectedFinal(ledger.snapshot(), target);
            if (protectedCandidate !== null) {
              const defects = answerClosureDefects({
                problemText,
                candidate: protectedCandidate.answer,
                packet: { candidateProposal: protectedCandidate.answer } as any,
                exactObservations,
                toolObservations: toolObservationViews,
                expectedSolutionKeys: null,
                requiresExhaustive: false,
              });
              if (defects.length > 0) {
                if (
                  opts.maxConsensus >= 1 &&
                  answerClosureTurns < 2 &&
                  callsLeft() >= 2 + opts.maxReviews
                ) {
                  answerClosureTurns += 1;
                  const closureId = root.nextModelId();
                  if (closureId !== null) {
                    const closureContext = buildConsensusContext(
                      closureId,
                      answerClosureNote(defects),
                    );
                    const closureOutcome = await calls.model({
                      task: running,
                      phase: "WORK",
                      messages: closureContext.messages,
                      contextHash: closureContext.contextHash,
                      contextBytes: closureContext.contextBytes,
                      requestId: closureId,
                    });
                    let nextCandidate = "";
                    let packetObj: Record<string, unknown> = {};
                    try {
                      packetObj = JSON.parse(closureOutcome.receipt.text) as Record<string, unknown>;
                      if (typeof packetObj["candidateProposal"] === "string") {
                        nextCandidate = packetObj["candidateProposal"];
                      }
                    } catch {
                      // unparseable text cannot revise candidate
                    }
                    if (nextCandidate.length > 0) {
                      const remaining = answerClosureDefects({
                        problemText,
                        candidate: nextCandidate,
                        packet: packetObj as any,
                        exactObservations,
                        toolObservations: toolObservationViews,
                        expectedSolutionKeys: null,
                        requiresExhaustive: false,
                      });
                      if (remaining.length < defects.length) {
                        const revisedTarget = p2Snapshot({
                          ...protectedOrigin,
                          answer: nextCandidate,
                        }) as P4Target;
                        target = revisedTarget;
                        protectedOrigin = revisedTarget;
                        const decisionCoverage: readonly P4CoverageRow[] = Object.freeze(
                          contract.obligations.map((obligation) =>
                            Object.freeze({
                              obligationId: obligation.obligationId,
                              kind: obligation.kind,
                              deliveryCovered: true,
                              reviewMentioned: false,
                              checkResult: "UNKNOWN" as const,
                            }),
                          ),
                        );
                        revisedDecision = p2Snapshot({
                          mode: "MOCK_ONLY" as const,
                          targetEnvironment: "TARGET_UNVERIFIED" as const,
                          stage: "S3" as const,
                          policy: "BEST_EFFORT" as const,
                          status: "candidate" as const,
                          finalResponse: nextCandidate,
                          candidateVerified: false as const,
                          strictAcceptance: "NOT_PERFORMED" as const,
                          submissionEligibility: "BEST_EFFORT" as const,
                          protectedCandidate: protectedOrigin.binding,
                          targetHash: protectedOrigin.targetHash,
                          unresolvedChallenges: 0,
                          openObligations: contract.obligations.length,
                          coverage: decisionCoverage,
                          reason: "REVISED_CANDIDATE" as const,
                        }) as P4FinalDecision;
                        sessionLog.append("CONSENSUS", {
                          stage: "LATE_OBSERVATION_DEFECT",
                          requestId: closureId,
                          defects: defects.map((d) => d.kind),
                          revised: true,
                          nextCandidate,
                        });
                      }
                    }
                  }
                } else {
                  sessionLog.append("CONSENSUS", {
                    stage: "LATE_OBSERVATION_DEFECT",
                    requestId: null,
                    defects: defects.map((d) => d.kind),
                    unresolvedContradiction: true,
                  });
                }
              }
            }
            for (const o of unconsumed) {
              consumedObservationHashes.add(o.observationHash);
            }
          }
          if (mathAssetResult.status === "UNKNOWN" || root.remainingMs() <= MIN_MS) {
            stop = mathAssetResult.status === "UNKNOWN" ? "STOPPED" : "DEADLINE_EXCEEDED";
            break;
          }
          continue;
        }
        if (action !== null && (action.action === "tool" || action.action === "method")) {
          const isMethod = action.action === "method";
          const methodId = action.action === "method" ? action.id : null;
          // A third distinct body is never requested: the loop-side asset cap
          // turns that demand into one answer-with-what-we-have retry instead
          // of a quota breach or a failed run. A single-card run keeps the
          // historical control rejection for an unsolicited second id.
          const distinctMethodRequested =
            isMethod &&
            methodId !== null &&
            !methodAssets.some((asset) => asset.id === methodId);
          const secondLoadPermitted =
            methodLoads === 1 &&
            secondMethodRouteEligible &&
            methodId !== null &&
            routedMethodCandidates.includes(methodId);
          // A first load is always permitted by the forced selection path. Any
          // later distinct load must be exactly the routed second-card offer;
          // this also makes a one-candidate run structurally one-card-only.
          const methodLoadNotPermitted =
            distinctMethodRequested &&
            methodLoads > 0 &&
            !secondLoadPermitted;
          const optionalMethodRefusal = isMethod && (secondMethodOfferShown || methodLoadNotPermitted);
          if (methodLoadNotPermitted) {
            // A one-card run preserves the historical control rejection for an
            // unsolicited second id. Once the two-card offer exists, an
            // over-cap or off-route demand degrades to one
            // answer-with-what-we-have turn.
            if (
              methodLoadCapacity < AGENT_MAX_METHOD_ASSETS ||
              methodLoadRefusalUsed
            ) {
              stop = "CONTROL_REJECTED";
              break;
            }
            methodLoadRefusalUsed = true;
            secondMethodOfferPending = false;
            methodLoadRefusalNotice =
              "METHOD LOAD REFUSED. The bounded two-card method budget is already spent. " +
              "Use the loaded method bodies already in methodAssets and answer with exactly one complete WorkPacket now.";
            continue;
          }
          // DSH monotonic tool-guard pipeline: pre -> guards, irreversible.
          const guard = monotonicToolGuard({
            action,
            allowTools,
            allowMethods,
            methodId,
            catalogIds: catalog === null ? [] : catalog.entries.map((entry) => entry.id),
            callsLeft: callsLeft(),
            maxReviews: opts.maxReviews,
          });
          if (!guard.admitted || subGate === null || (isMethod && catalog === null)) {
            if (optionalMethodRefusal && !methodLoadRefusalUsed) {
              methodLoadRefusalUsed = true;
              secondMethodOfferPending = false;
              methodLoadRefusalNotice =
                "METHOD LOAD REFUSED. This optional second card is not admissible in the remaining budget. " +
                "Use the loaded method bodies already in methodAssets and answer with exactly one complete WorkPacket now.";
              continue;
            }
            stop = "CONTROL_REJECTED";
            break;
          }
          const effectsBefore = root.effectCalls();
          let receipt: P3EffectReceipt;
          try {
            receipt = await calls.effect(
              running,
              outcome.requestId,
              action,
              subGate,
              callsLeft(),
              catalog ?? undefined,
            );
          } catch (error) {
            // A kind-quota/total-capacity refusal is a fail-closed control
            // rejection, not a transport outcome and not a fabricated receipt.
            if (!(error instanceof P2Error)) {
              throw error;
            }
            if (optionalMethodRefusal && !methodLoadRefusalUsed) {
              methodLoadRefusalUsed = true;
              secondMethodOfferPending = false;
              methodLoadRefusalNotice =
                "METHOD LOAD REFUSED by the Host quota. Use the loaded method bodies already in methodAssets " +
                "and answer with exactly one complete WorkPacket now.";
              continue;
            }
            stop = "CONTROL_REJECTED";
            break;
          }
          // G7/PR7 Slice 7e: bind the loaded method card to the Host registry with
          // one scoped `methodCards` call within the current scope. The card body
          // still reaches WORK through `method.catalog -> method.load`; a refused
          // descriptor is recorded as absent (never fabricated), and it never
          // replaces the real method body or counts as evidence.
          let methodCardSha: string | null = null;
          if (isMethod && methodId !== null && captured.asset !== null && root.effectCalls() > effectsBefore) {
            const scopeHash = p4Hash(JSON.stringify({ scope: running.scopeId, card: methodId }));
            try {
              const descriptor = (await captured.asset.call({
                group: "methodCards",
                assetId: methodId,
                scopeId: scopeHash,
                contractVersion: contract.contractVersion,
              })) as { assetId: string; scopeId: string; sha256: string };
              if (descriptor.assetId === methodId && descriptor.scopeId === scopeHash) {
                methodCardSha = descriptor.sha256;
              }
            } catch {
              methodCardSha = null;
            }
          }
          forcedMethodSelection = false;
          forcedMethodCandidates = [];
          forcedEnumerationSelection = false;
          forcedExactCheckSelection = false;
          forcedSemanticToolSelection = false;
          forcedMathAssetSelection = false;
          forcedExactCheckOperation = null;
          forcedSemanticToolRoute = null;
          forcedMathAssetRoute = null;
          forcedVerdictClosure = false;
          forcedDensityClosure = false;
          const usedEffect = root.effectCalls() > effectsBefore;
          if (usedEffect && isMethod) {
            methodLoads += 1;
          }
          if (usedEffect && !isMethod) {
            toolEffects += 1;
          }
          // The ordinal is the run-local load number (1 or 2). A cached repeat
          // of an already loaded id reuses its previous ordinal and does not
          // spend a new effect id.
          const methodLoadOrdinal = isMethod ? Math.max(1, methodLoads) : null;
          const toolOperation =
            action.action === "tool"
              ? toolOperationFor(action.name, action.args, forcedRouteAtAction)
              : null;
          sessionLog.append(isMethod ? "METHOD_LOAD" : "TOOL_OBSERVATION", {
            effectId: receipt.effectId,
            source: receipt.source,
            level: receipt.level,
            checkResult: receipt.checkResult,
            ...(isMethod
              ? { methodCardSha, methodId, ordinal: methodLoadOrdinal }
              : {
                  toolName: action.action === "tool" ? action.name : "",
                  operation: toolOperation,
                  forced: obeyedRouteAtAction,
                  routeId: obeyedRouteAtAction ? forcedRouteAtAction?.id ?? null : null,
                }),
          });
          if (action.action === "tool" && receipt.status === "COMPLETE") {
            try {
              const observation = JSON.parse(receipt.observation) as {
                result?: unknown;
              };
              const result = observation.result;
              if (result !== undefined) {
                toolObservationViews.push({
                  name: action.name,
                  operation: toolOperation,
                  result,
                });
                if (
                  action.name === "exact_check_expr" &&
                  typeof result === "object" &&
                  result !== null &&
                  !Array.isArray(result)
                ) {
                  const exact = result as ExactObservationView;
                  // Keyed by operation: one slot per exact operation, never
                  // "latest result wins". A result without a usable operation
                  // label is not stored (it could satisfy no diagnostic).
                  if (typeof exact.operation === "string" && exact.operation.length > 0) {
                    exactObservations.set(exact.operation, exact);
                  }
                  if (exact.operation === "DENSITY_CHECK") {
                    densityCheckFailure =
                      exact.normalized === false
                        ? typeof exact.numeric_integral === "string"
                          ? exact.numeric_integral
                          : "a value other than 1"
                        : null;
                  }
                }
              }
            } catch {
              // An unparsable observation is not an exact certificate.
            }
          }
          if (receipt.status === "UNKNOWN" || root.remainingMs() <= MIN_MS) {
            stop = receipt.status === "UNKNOWN" ? "STOPPED" : "DEADLINE_EXCEEDED";
            break;
          }
          const cached = root.effectCalls() === effectsBefore;
          let repeated = false;
          try {
            repeated = progress.observeEffect(
              running.taskId,
              outcome.requestId,
              p3EffectKey(action),
              cached,
            );
          } catch (error) {
            if (!(error instanceof P2Error)) {
              throw error;
            }
            stop = "CONTROL_REJECTED";
            break;
          }
          if (!observations.some((item) => item.effectId === receipt.effectId)) {
            observations.push(receipt);
          }
          if (
            isMethod &&
            methodId !== null &&
            receipt.status === "COMPLETE" &&
            receipt.source === "METHOD_REFERENCE" &&
            catalog !== null &&
            !methodAssets.some((asset) => asset.id === methodId)
          ) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(receipt.observation);
            } catch {
              parsed = null;
            }
            const title = catalog.entries.find((entry) => entry.id === methodId)?.title;
            if (parsed !== null && title !== undefined) {
              try {
                const asset = readAsset(
                  (parsed as Record<string, unknown>)["asset"],
                  methodId,
                  title,
                );
                methodAssets = [...methodAssets, asset];
                methodToolCoPromptCardId = asset.id;
              } catch {
                stop = "CONTROL_REJECTED";
                break;
              }
            }
          }
          if (
            isMethod &&
            methodId !== null &&
            receipt.status === "COMPLETE" &&
            receipt.source === "METHOD_REFERENCE"
          ) {
            const onlyLoadedMethodId =
              methodAssets.length === 1 ? methodAssets[0]!.id : null;
            secondMethodRouteEligible =
              onlyLoadedMethodId !== null &&
              routedMethodCandidates.length >= 2 &&
              onlyLoadedMethodId !== routedMethodCandidates[1];
            secondMethodOfferPending =
              secondMethodRouteEligible &&
              methodLoads < methodLoadCapacity &&
              subGate !== null &&
              captured.catalog !== null &&
              root.effectCalls() < totalEffectCapacity &&
              callsLeft() >= 2 + opts.maxReviews;
          }
          if (repeated && revision.pendingTaskId() === null) {
            try {
              ledger.validateYieldTask(running.taskId, outcome.requestId, "REPEATED_EFFECT");
              progress.validateRecordYield(running.taskId, outcome.requestId, "REPEATED_EFFECT");
              ledger.yieldTask(running.taskId, outcome.requestId, "REPEATED_EFFECT");
              progress.recordYield(running.taskId, outcome.requestId, "REPEATED_EFFECT");
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              stop = "CONTROL_REJECTED";
              break;
            }
            yielded = true;
            stop = "NO_CANDIDATE";
            break;
          }
          continue;
        }
        if (action !== null && action.action === "explore") {
          // Stage D+ controlled exploration. This is a protocol gate, not
          // advice: the Host must have advertised `AVAILABLE_BOUNDED`, one
          // tool-kind effect slot must still be free and the tool reserve must
          // keep the follow-up work packet. A refusal is one fixed control
          // rejection; nothing is executed and no observation is invented.
          const exploreGuard = monotonicToolGuard({
            action,
            allowTools: false,
            allowMethods: false,
            allowExplorations: allowExplore,
            methodId: null,
            catalogIds: [],
            callsLeft: callsLeft(),
            maxReviews: opts.maxReviews,
          });
          if (!exploreGuard.admitted || subGate === null) {
            stop = "CONTROL_REJECTED";
            break;
          }
          const exploreEffectsBefore = root.effectCalls();
          let receipt: P3EffectReceipt;
          try {
            receipt = await calls.effect(
              running,
              outcome.requestId,
              action,
              subGate,
              callsLeft(),
            );
          } catch (error) {
            // A quota/capacity refusal is a fail-closed control rejection, not
            // a transport outcome and not a fabricated receipt.
            if (!(error instanceof P2Error)) {
              throw error;
            }
            stop = "CONTROL_REJECTED";
            break;
          }
          // An admitted exploration spends exactly one tool-kind effect id, so
          // the `maxEffects` / total-capacity math never widens. A cached
          // repeat of the same source spends no new id.
          if (root.effectCalls() > exploreEffectsBefore) {
            toolEffects += 1;
          }
          sessionLog.append("TOOL_OBSERVATION", {
            effectId: receipt.effectId,
            source: receipt.source,
            level: receipt.level,
            checkResult: receipt.checkResult,
            toolName: EXPLORATION_TOOL_NAME,
            operation: null,
            forced: false,
            routeId: null,
          });
          // The observation view keeps the exploration visible to the model
          // and to telemetry. Its name is not a registered tool, so no closure
          // lookup can ever match it: it grounds no defect, satisfies no
          // obligation and is never treated as a certificate.
          if (receipt.status === "COMPLETE") {
            try {
              const observed = JSON.parse(receipt.observation) as { result?: unknown };
              toolObservationViews.push({
                name: EXPLORATION_TOOL_NAME,
                operation: null,
                result: observed.result ?? null,
              });
            } catch {
              // An unparsable observation is never evidence.
            }
          }
          if (receipt.status === "UNKNOWN" || root.remainingMs() <= MIN_MS) {
            stop = receipt.status === "UNKNOWN" ? "STOPPED" : "DEADLINE_EXCEEDED";
            break;
          }
          let exploreRepeated = false;
          try {
            exploreRepeated = progress.observeEffect(
              running.taskId,
              outcome.requestId,
              p3EffectKey(action),
              root.effectCalls() === exploreEffectsBefore,
            );
          } catch (error) {
            if (!(error instanceof P2Error)) {
              throw error;
            }
            stop = "CONTROL_REJECTED";
            break;
          }
          if (!observations.some((item) => item.effectId === receipt.effectId)) {
            observations.push(receipt);
          }
          if (exploreRepeated && revision.pendingTaskId() === null) {
            try {
              ledger.validateYieldTask(running.taskId, outcome.requestId, "REPEATED_EFFECT");
              progress.validateRecordYield(running.taskId, outcome.requestId, "REPEATED_EFFECT");
              ledger.yieldTask(running.taskId, outcome.requestId, "REPEATED_EFFECT");
              progress.recordYield(running.taskId, outcome.requestId, "REPEATED_EFFECT");
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              stop = "CONTROL_REJECTED";
              break;
            }
            yielded = true;
            stop = "NO_CANDIDATE";
            break;
          }
          continue;
        }
        if (action !== null && action.action === "unsolved") {
          if (revision.pendingTaskId() === null) {
            try {
              ledger.validateYieldTask(running.taskId, outcome.requestId, "UNSOLVED");
              progress.validateRecordYield(running.taskId, outcome.requestId, "UNSOLVED");
              ledger.yieldTask(running.taskId, outcome.requestId, "UNSOLVED");
              progress.recordYield(running.taskId, outcome.requestId, "UNSOLVED");
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              stop = "CONTROL_REJECTED";
              break;
            }
            yielded = true;
            stop = "NO_CANDIDATE";
            break;
          }
          stop = "NO_CANDIDATE";
          break;
        }
        if (action !== null && action.action === "final") {
          if (
            exposedCandidate === null ||
            !allowFinal ||
            !validateAgentFinal(
              action,
              exposedCandidate,
              ledger.snapshot(),
              running.scopeId,
              outcome.requestId,
            )
          ) {
            root.stop("CONTROL_REJECTED");
            stop = "CONTROL_REJECTED";
            break;
          }
          stop = "WORK_UNITS_COMPLETE";
          break;
        }
        let accepted: P2Artifact;
        let ref: P2ArtifactRef;
        if (revision.pendingTaskId() === running.taskId) {
          const origin = revision.provenanceFor(running.taskId);
          if (origin === null) {
            root.stop("CONTROL_REJECTED");
            stop = "CONTROL_REJECTED";
            break;
          }
          const settled = revision.settle(running, {
            artifactId: origin.targetArtifactRef.artifactId,
            routeId: route.routeId,
            sourceRequestId: outcome.requestId,
            transportStatus: outcome.receipt.transportStatus,
            text: outcome.receipt.text,
            eventSeq: ledger.nextEventSeq(),
            supersedes: origin.targetArtifactRef,
          });
          if (settled === null) {
            root.stop("CONTROL_REJECTED");
            stop = "CONTROL_REJECTED";
            break;
          }
          accepted = settled;
          ref = {
            artifactId: settled.artifactId,
            artifactVersion: settled.envelope.artifactVersion ?? 1,
          };
          workUnits += 1;
          // Refresh the protected origin's current availability immediately:
          // a later WORK context must never expose a stale candidate as ACTIVE.
          if (protectedOrigin !== null) {
            const originRef: P2ArtifactRef = {
              artifactId: protectedOrigin.binding.artifactId,
              artifactVersion: protectedOrigin.binding.artifactVersion,
            };
            let originEntry;
            try {
              originEntry = store.get(originRef);
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              originEntry = null;
            }
            if (originEntry !== null && originEntry.availability === "STALE") {
              target = p2Snapshot({ ...protectedOrigin, availability: "STALE" as const }) as P4Target;
            }
          }
          if (accepted.deliveryStatus !== "COMPLETE") {
            stop = "NO_CANDIDATE";
            break;
          }
          // A committed replacement ends the WORK phase of this profile: the
          // loop exits to the R2/finalization stage instead of admitting more
          // work, matching the Host-side finished-redo projection.
          stop = "WORK_UNITS_COMPLETE";
          break;
        } else {
          const receiptInput = {
            artifactId: `artifact-${workUnits + 1}`,
            routeId: route.routeId,
            sourceRequestId: outcome.requestId,
            transportStatus: outcome.receipt.transportStatus,
            text: outcome.receipt.text,
            eventSeq: ledger.nextEventSeq(),
            supersedes: null,
          };
          // Pre-check the acceptance and, when the v5 packet carries a
          // scopeProposal, validate that declaration BEFORE the artifact write
          // or the delivery record. An out-of-scope proposal is therefore a
          // fixed rejection with no side effect on the store, the ledger or the
          // scheduling sequence.
          let prepared: P2Artifact | null = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              prepared = store.validateAccept(running, receiptInput);
              break;
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              if (
                attempt === 0 &&
                opts.maxRepairs >= 1 &&
                schemaRepairs < 2 &&
                SCHEMA_REPAIR_CODES.has(error.code) &&
                callsLeft() > reserve() &&
                root.remainingMs() > MIN_MS
              ) {
                const repairId = root.nextModelId();
                if (repairId !== null) {
                  const repair = buildSchemaRepairMessages(
                    context.messages,
                    outcome.receipt.text,
                    error.code,
                    repairId,
                  );
                  const repaired = await calls.model({
                    task: running,
                    phase: "WORK",
                    messages: repair.messages,
                    contextHash: repair.contextHash,
                    contextBytes: repair.contextBytes,
                    requestId: repairId,
                  });
                  schemaRepairs += 1;
                  if (repaired.receipt.transportStatus === "COMPLETE") {
                    outcome = repaired;
                    receiptInput.sourceRequestId = repaired.requestId;
                    receiptInput.text = repaired.receipt.text;
                    continue;
                  }
                }
              }
              stop = "PACKET_REJECTED";
              break;
            }
          }
          let recoveryUsed = false;
          if (prepared === null) {
            // A malformed first packet (and an equally malformed schema repair)
            // is not a reason to discard the whole answer-bearing task. With
            // bounded consensus enabled, one blind CONSENSUS re-solve is a
            // separate, Host-authorized attempt; only a valid COMPLETE packet
            // is accepted and the invalid raw text never becomes an artifact.
            if (
              opts.maxConsensus >= 1 &&
              answerBearingTask &&
              target === null &&
              revision.pendingTaskId() === null &&
              callsLeft() >= 1 + opts.maxReviews
            ) {
              const recoveryId = root.nextModelId();
              if (recoveryId !== null) {
                const upstreamTaskIds = new Set(running.dependencyTaskIds);
                const declaredCoverage = store
                  .scopeCoverageSnapshot()
                  .filter(
                    (row) =>
                      row.taskId === running.taskId || upstreamTaskIds.has(row.taskId),
                  );
                const built = buildAgentWorkContext({
                  contract: ledger.snapshot(),
                  task: running,
                  route,
                  requestId: recoveryId,
                  inputs,
                  toolObservations: observations,
                  allowTools,
                  allowMethods,
                  allowFinal: false,
                  protectedCandidate: exposedCandidate,
                  catalog,
                  methodAssets,
                  allowRouteProposal,
                  allowTaskContinuation,
                  allowArtifactRedo,
                  routeProvenance: null,
                  dependencyProvenance: null,
                  revisionProvenance: null,
                  revisionTarget: null,
                  scopeCoverage: declaredCoverage,
                  refutationRequired: false,
                });
                const messages = [
                  {
                    role: "system" as const,
                    content:
                      built.messages[0]!.content +
                      "\n\nSCHEMA RECOVERY. The previous turn did not produce a parseable WorkPacket. " +
                      "Solve the same problem again and return exactly one JSON WorkPacket and nothing else, " +
                      "with the exact p2a-work-v1 fields and a non-empty answer string in candidateProposal. " +
                      "Do not call a tool in this turn. Keep claim, derivation and candidateProposal within 4096 Unicode code points each.",
                  },
                  built.messages[1]!,
                ];
                const recovered = await calls.model({
                  task: running,
                  phase: "CONSENSUS",
                  messages,
                  contextHash: p4Hash(JSON.stringify(messages)),
                  contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
                  requestId: recoveryId,
                });
                if (
                  recovered.receipt.transportStatus === "COMPLETE" &&
                  (recovered.code === "WORK" || recovered.code === "CONSENSUS")
                ) {
                  try {
                    const artifact = store.validateAccept(running, {
                      artifactId: `artifact-${workUnits + 1}`,
                      routeId: route.routeId,
                      sourceRequestId: recovered.requestId,
                      transportStatus: recovered.receipt.transportStatus,
                      text: recovered.receipt.text,
                      eventSeq: ledger.nextEventSeq(),
                      supersedes: null,
                    });
                    if (
                      artifact.packet !== null &&
                      artifact.packet.deliveryStatus === "COMPLETE" &&
                      typeof artifact.packet.candidateProposal === "string" &&
                      artifact.packet.candidateProposal.trim().length > 0 &&
                      [...artifact.packet.claim].length <= 4096 &&
                      [...artifact.packet.derivation].length <= 4096 &&
                      [...artifact.packet.candidateProposal].length <= 4096
                    ) {
                      prepared = artifact;
                      outcome = recovered;
                      recoveryUsed = true;
                      receiptInput.sourceRequestId = recovered.requestId;
                      receiptInput.text = recovered.receipt.text;
                    }
                  } catch (error) {
                    if (!(error instanceof P2Error)) {
                      throw error;
                    }
                  }
                }
              }
            }
            if (prepared === null) {
              break;
            }
          }
          let firstPacketOverlong = false;
          if (prepared.packet !== null) {
            const packet = prepared.packet;
            firstPacketOverlong =
              [...packet.claim].length > 4096 ||
              [...packet.derivation].length > 4096 ||
              (typeof packet.candidateProposal === "string" &&
                [...packet.candidateProposal].length > 4096);
          }
          if (firstPacketOverlong && opts.maxConsensus < 1) {
            stop = "PACKET_REJECTED";
            break;
          }
          // One forced method-consultation turn before a candidate is
          // delivered. The model must choose a real catalog card; the normal
          // effect path loads it and the next WORK turn sees the card body.
          if (
            !forcedTurnFailedOpen &&
            opts.maxConsensus >= 1 &&
            opts.maxMethodLoads >= 1 &&
            prepared.packet !== null &&
            prepared.packet.deliveryStatus === "COMPLETE" &&
            answerBearingTask &&
            !methodSelectionAttempted &&
            catalog !== null &&
            catalog.entries.length > 0 &&
            subGate !== null &&
            allowMethods &&
            root.effectCalls() < totalEffectCapacity &&
            methodLoads < methodLoadCapacity &&
            !observations.some((item) => item.source === "METHOD_REFERENCE") &&
            callsLeft() >= 2 + opts.maxReviews
          ) {
            methodSelectionAttempted = true;
            forcedMethodSelection = true;
            routedMethodCandidates = semanticMethodRoute(problemText, catalog.entries);
            forcedMethodCandidates = routedMethodCandidates;
            if (forcedMethodCandidates.length > 0) {
              sessionLog.append("REPAIR", {
                kind: "METHOD_ROUTE",
                candidates: [...forcedMethodCandidates],
                taskId: running.taskId,
              });
            }
            forcedSemanticToolRoute = null;
            forcedRetryUsed = false;
            continue;
          }
          forcedMethodSelection = false;
          forcedMethodCandidates = [];
          if (captured.mathAsset !== null && captured.mathAsset !== undefined) {
            const mathRoute = semanticMathAssetRoute(problemText);
            if (
              !forcedTurnFailedOpen &&
              opts.maxConsensus >= 1 &&
              mathRoute !== null &&
              !mathAssetAttempted &&
              !observations.some((item) => item.source === "PROGRAM_OBSERVATION") &&
              allowTools &&
              toolEffects < opts.maxEffects &&
              root.effectCalls() < totalEffectCapacity &&
              callsLeft() >= 2 + opts.maxReviews
            ) {
              mathAssetAttempted = true;
              forcedMathAssetSelection = true;
              forcedMathAssetRoute = mathRoute;
              forcedRetryUsed = false;
              sessionLog.append("REPAIR", {
                kind: "MATH_ASSET_ROUTE",
                assetId: mathRoute.assetId,
                target: mathRoute.target,
                forced: true,
                routeId: mathRoute.id,
                taskId: running.taskId,
              });
              continue;
            }
          }
          // Expanded deterministic semantic routing. The first matching family
          // wins. No item id, reference answer or hidden table is consulted.
          // A tool route consumes the tool quota only; method cards have their
          // own quota and share only the total effect-id capacity.
          const toolRoute = semanticToolRoute(problemText);
          const routeAlreadyAttempted =
            toolRoute === null
              ? false
              : toolRoute.toolName === "bounded_enumeration"
                ? enumerationAttempted
                : toolRoute.toolName === "exact_check_expr"
                  ? exactCheckAttempted
                  : semanticToolAttempted;
          if (
            !forcedTurnFailedOpen &&
            opts.maxConsensus >= 1 &&
            toolRoute !== null &&
            !routeAlreadyAttempted &&
            !observations.some((item) => item.source === "PROGRAM_OBSERVATION") &&
            allowTools &&
            toolEffects < opts.maxEffects &&
            subGate !== null &&
            root.effectCalls() < totalEffectCapacity &&
            callsLeft() >= 2 + opts.maxReviews
          ) {
            if (toolRoute.toolName === "bounded_enumeration") {
              enumerationAttempted = true;
            } else if (toolRoute.toolName === "exact_check_expr") {
              exactCheckAttempted = true;
            } else {
              semanticToolAttempted = true;
            }
            forcedEnumerationSelection = toolRoute.toolName === "bounded_enumeration";
            forcedExactCheckSelection = toolRoute.toolName === "exact_check_expr";
            forcedSemanticToolSelection =
              toolRoute.toolName !== "bounded_enumeration" &&
              toolRoute.toolName !== "exact_check_expr";
            forcedExactCheckOperation =
              toolRoute.toolName === "exact_check_expr" ? toolRoute.operation : null;
            forcedSemanticToolRoute = toolRoute;
            forcedRetryUsed = false;
            sessionLog.append("REPAIR", {
              kind: "TOOL_ROUTE",
              toolName: toolRoute.toolName,
              operation: toolRoute.operation,
              forced: true,
              routeId: toolRoute.id,
              taskId: running.taskId,
            });
            continue;
          }
          forcedEnumerationSelection = false;
          forcedExactCheckSelection = false;
          forcedSemanticToolSelection = false;
          forcedMathAssetSelection = false;
          forcedExactCheckOperation = null;
          forcedSemanticToolRoute = null;
          forcedMathAssetRoute = null;
          forcedRetryUsed = false;
          if (
            opts.maxConsensus >= 1 &&
            densityCheckFailure !== null &&
            !densityClosureAttempted &&
            callsLeft() >= 2 + opts.maxReviews
          ) {
            densityClosureAttempted = true;
            forcedDensityClosure = true;
            continue;
          }
          forcedDensityClosure = false;
          // Generic verdict consistency: an affirmative answer that itself
          // says the universal proposition is "not always" true contradicts
          // its own quantifier analysis. Close that contradiction with one
          // bounded COMPLETE packet carrying a machine-readable FALSE verdict.
          const binaryProblem =
            /(判断|是否正确|对错|true\s+or\s+false)/iu.test(problemText);
          const verdictText = prepared.packet?.candidateProposal ?? "";
          const affirmativeVerdict =
            /^(正确|是|√|true|yes)/iu.test(verdictText.trim());
          const hedgedVerdict =
            /(并非|不一定|通常|not\s+always|not\s+necessarily|需限定|但需)/iu.test(verdictText);
          if (
            opts.maxConsensus >= 1 &&
            binaryProblem &&
            affirmativeVerdict &&
            hedgedVerdict &&
            !verdictClosureAttempted &&
            callsLeft() >= 2 + opts.maxReviews
          ) {
            verdictClosureAttempted = true;
            forcedVerdictClosure = true;
            continue;
          }
          forcedVerdictClosure = false;
          // Bounded answer consensus (opt-in with `maxConsensus >= 1`). The first
          // complete WorkPacket is not delivered immediately on the
          // answer-bearing task. Instead, one blind independent re-solve is
          // performed on the SAME still-RUNNING task; if its candidate differs,
          // one adjudication turn sees both candidates. This adds real model
          // work before delivery and never promotes a model claim to verified
          // evidence. With `maxConsensus=0` the block is dead and the run is
          // byte-identical.
          if (
            opts.maxConsensus >= 1 &&
            !recoveryUsed &&
            answerBearingTask &&
            target === null &&
            revision.pendingTaskId() === null &&
            prepared.packet !== null &&
            callsLeft() >= 2 + opts.maxReviews
          ) {
            const firstCandidate = firstPacketOverlong
              ? ""
              : prepared.packet.candidateProposal ?? "";
            const choiceProblem = problemChoiceLetters(problemText).length >= 2;
            const consensusAttempts: {
              prepared: P2Artifact;
              outcome: typeof outcome;
              candidate: string;
              certified: boolean;
            }[] = [{
              prepared,
              outcome,
              candidate: firstCandidate,
              certified: isCertifiedPacket(prepared.packet ?? {}),
            }];
            const buildConsensusContext = (nextId: string, note: string) => {
              const upstreamTaskIds = new Set(running.dependencyTaskIds);
              const declaredCoverage = store
                .scopeCoverageSnapshot()
                .filter(
                  (row) =>
                    row.taskId === running.taskId || upstreamTaskIds.has(row.taskId),
                );
              const built = buildAgentWorkContext({
                contract: ledger.snapshot(),
                task: running,
                route,
                requestId: nextId,
                inputs,
                toolObservations: observations,
                allowTools,
                allowMethods,
                allowFinal: false,
                protectedCandidate: exposedCandidate,
                catalog,
                methodAssets,
                allowRouteProposal,
                allowTaskContinuation,
                allowArtifactRedo,
                routeProvenance: null,
                dependencyProvenance: null,
                revisionProvenance: null,
                revisionTarget: null,
                scopeCoverage: declaredCoverage,
                refutationRequired: false,
              });
              const messages = [
                {
                  role: "system" as const,
                  content: built.messages[0]!.content + "\n\n" + note,
                },
                built.messages[1]!,
              ];
              return {
                messages,
                contextHash: p4Hash(JSON.stringify(messages)),
                contextBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
              };
            };
            const evaluateConsensus = (candidateOutcome: typeof outcome) => {
              if (
                candidateOutcome.receipt.transportStatus !== "COMPLETE" ||
                (candidateOutcome.code !== "WORK" && candidateOutcome.code !== "CONSENSUS")
              ) {
                return null;
              }
              try {
                const artifact = store.validateAccept(running, {
                  artifactId: `artifact-${workUnits + 1}`,
                  routeId: route.routeId,
                  sourceRequestId: candidateOutcome.requestId,
                  transportStatus: candidateOutcome.receipt.transportStatus,
                  text: candidateOutcome.receipt.text,
                  eventSeq: receiptInput.eventSeq,
                  supersedes: null,
                });
                if (
                  artifact.packet === null ||
                  artifact.packet.deliveryStatus !== "COMPLETE" ||
                  typeof artifact.packet.candidateProposal !== "string" ||
                  artifact.packet.candidateProposal.trim().length === 0
                ) {
                  return null;
                }
                // The Host's strict WorkPacket text bound is 4096 code points;
                // a long consensus derivation is not projected as the same
                // artifact and would make the Host fail a later context.
                if (
                  [...artifact.packet.claim].length > 4096 ||
                  [...artifact.packet.derivation].length > 4096 ||
                  [...artifact.packet.candidateProposal].length > 4096
                ) {
                  return null;
                }
                return { outcome: candidateOutcome, prepared: artifact };
              } catch (error) {
                if (!(error instanceof P2Error)) {
                  throw error;
                }
                return null;
              }
            };
            let lastObservedCandidate = firstCandidate;
            for (let round = 0; round < opts.maxConsensus; round += 1) {
              if (callsLeft() < 2 + opts.maxReviews) break;
              const isBlind = round === 0 && opts.maxConsensus >= 2;
              const isCertificate =
                !isBlind && (opts.maxConsensus === 1 || round === opts.maxConsensus - 1);
              const nextId = root.nextModelId();
              if (nextId === null) break;
              let note: string;
              if (isBlind) {
                note =
                  "INDEPENDENT RECHECK. Return exactly one JSON WorkPacket and nothing else. " +
                  "Solve the same problem independently from scratch. Do not copy any earlier answer and do not call a tool in this turn. " +
                  "Keep claim, derivation and candidateProposal within 4096 Unicode code points each; be concise.";
              } else if (isCertificate) {
                note =
                  "CERTIFICATE SELF-CHECK. This is the final independent check. The current candidate answer is supplied below; " +
                  "its earlier reasoning is deliberately withheld. Audit it against the problem, do not assume it is correct. " +
                  "Return exactly one complete WorkPacket and nothing else. In suggestedChecks include at least two rows of the form " +
                  "`CERT1|CHECK|<id>|<kind>|<explicit computation> => PASS` (or FAIL), and at least one marker row " +
                  "`CERT1|FINAL|OK` (if the exact final answer fits in 200 code points, use `CERT1|FINAL|<answer>` instead). " +
                  "Each suggestedChecks row must be at most 200 Unicode code points; keep derivation under 3500 code points and do not paste long computations into it. " +
                  (choiceProblem
                    ? "Also include one row `CERT1|OPTIONS|A=TRUE,B=FALSE,...` covering every option exactly once, and set candidateProposal to exactly the options marked TRUE. "
                    : "") +
                  "For a true/false statement also include `CERT1|VERDICT|TRUE` or `CERT1|VERDICT|FALSE`, and make candidateProposal the canonical verdict token alone. " +
                  "Checks must be explicit computations, not words such as verified or correct: substitute into every defining equation, initial condition, boundary condition, normalization and quantifier; " +
                  "for a field list every root and check containment and degree; for a CDF/density check endpoints, nonnegativity, total mass and F'=f; " +
                  "for finite counting enumerate the sample space and every favorable case; for a determinant or expansion recompute it exactly; for a limit identify the scaling and a dominating function. " +
                  "A statement of the form 'if P, then X is called Y' or '则称' is definitional: accept it when it agrees with the stated definition and no counterexample exists; do not demand a theorem proof. " +
                  "For a universal statement, one concrete counterexample makes the verdict FALSE; a statement that is only typical or needs an extra condition is FALSE, never TRUE with a qualification. " +
                  "If a check fails or is inconclusive, correct candidateProposal; otherwise return the same answer. " +
                  "CURRENT CANDIDATE: " + lastObservedCandidate.slice(0, 1200) +
                  "\nReturn exactly one JSON WorkPacket and nothing else; keep claim, derivation and candidateProposal within 4096 Unicode code points each.";
              } else {
                const latest = consensusAttempts[consensusAttempts.length - 1]!;
                const latestPacket = latest.prepared.packet;
                const other = [...consensusAttempts]
                  .reverse()
                  .find((attempt) => attempt.candidate.length > 0 && attempt.candidate !== lastObservedCandidate);
                const otherPacket = other?.prepared.packet ?? null;
                const auditMode = round % 4;
                const auditHead =
                  auditMode === 0
                    ? "COUNTEREXAMPLE AUDIT. Try to construct a concrete counterexample to the current candidate. A false counterexample invalidates the attempt; if none exists, verify the candidate. "
                    : auditMode === 1
                      ? "PROOF AUDIT. Audit every definition, hypothesis, inference and stated counterexample. A false counterexample invalidates the whole attempt. "
                      : auditMode === 2
                        ? "EXACT RECOMPUTATION. Independently recompute every numerical coefficient, matrix entry, probability, limit or formula from the problem statement. Do not repeat the candidate's algebra; compare the exact recomputation with the candidate. "
                        : "BOUNDARY AND COMPLETENESS AUDIT. Check every quantifier, branch, support endpoint, boundary/initial condition, normalization, multiplicity, requested sub-part and option. Construct the complete object and verify that no case or witness is missing. ";
                note =
                  "ADVERSARIAL AUDIT. A candidate solution is supplied below. Audit it; do not assume it is correct. " +
                  auditHead +
                  (choiceProblem
                    ? "MULTIPLE-CHOICE COVERAGE: independently decide every option A, B, C, D (and E when present) as true or false. " +
                      "The final candidateProposal must list every correct option and must not omit an option that is also correct. "
                    : "") +
                  "If the candidate is correct, return the same candidate with a short verification; if it is wrong, return one corrected WorkPacket. " +
                  "Return exactly one JSON WorkPacket and nothing else. " +
                  "CURRENT CANDIDATE: " + lastObservedCandidate.slice(0, 500) +
                  "\nCURRENT CLAIM: " + (latestPacket?.claim ?? "").slice(0, 1500) +
                  "\nCURRENT DERIVATION: " + (latestPacket?.derivation ?? "").slice(0, 2500) +
                  (otherPacket === null
                    ? ""
                    : "\nOTHER CANDIDATE: " + (other?.candidate ?? "").slice(0, 500) +
                      "\nOTHER CLAIM: " + otherPacket.claim.slice(0, 1500) +
                      "\nOTHER DERIVATION: " + otherPacket.derivation.slice(0, 2500)) +
                  "\nKeep claim, derivation and candidateProposal within 4096 Unicode code points each; be concise.";
              }
              const built = buildConsensusContext(nextId, note);
              const nextOutcome = await calls.model({
                task: running,
                phase: "CONSENSUS",
                messages: built.messages,
                contextHash: built.contextHash,
                contextBytes: built.contextBytes,
                requestId: nextId,
              });
              const evaluatedNext = evaluateConsensus(nextOutcome);
              const nextCandidate = evaluatedNext?.prepared.packet?.candidateProposal ?? "";
              const nextCertificate =
                evaluatedNext === null
                  ? null
                  : summarizeCertificate(evaluatedNext.prepared.packet ?? {});
              sessionLog.append("CONSENSUS", {
                stage: isCertificate ? "CERTIFICATE" : isBlind ? "INDEPENDENT" : "AUDIT",
                requestId: nextId,
                previousCandidate: lastObservedCandidate,
                nextCandidate: evaluatedNext === null ? null : nextCandidate,
                agreement:
                  evaluatedNext !== null && nextCandidate === lastObservedCandidate,
                ...(nextCertificate === null
                  ? {}
                  : {
                      certificateChecks: nextCertificate.checkCount,
                      certificateCertified: nextCertificate.certified,
                    }),
              });
              if (evaluatedNext === null) {
                // A malformed audit never replaces a valid earlier attempt.
                // Spend another bounded consensus round instead of stopping
                // early: the retained first packet remains the fallback.
                continue;
              }
              consensusAttempts.push({
                prepared: evaluatedNext.prepared,
                outcome: evaluatedNext.outcome,
                candidate: nextCandidate,
                certified: isCertifiedPacket(evaluatedNext.prepared.packet ?? {}),
              });
              lastObservedCandidate = nextCandidate;
            }
            // If the model's own certificate exposes a contradiction between
            // its final answer and its structured options/verdict rows, spend
            // one bounded call to close that contradiction. This is a
            // consistency repair, not a new mathematical oracle: the target is
            // derived only from the model's own certificate data.
            const latestCertified = [...consensusAttempts]
              .reverse()
              .find((attempt) => attempt.certified && attempt.candidate.length > 0);
            if (
              latestCertified !== undefined &&
              callsLeft() >= 2 + opts.maxReviews
            ) {
              const correction = certificateCorrection(
                latestCertified.prepared.packet ?? {},
              );
              // A presentation-only difference (`1/2` versus `\frac12`) is not a
              // contradiction: compare canonical answer keys so that a bounded
              // closure turn is spent only on a genuinely different answer.
              if (
                correction !== null &&
                !sameAnswerKey(correction, latestCertified.candidate)
              ) {
                const closureId = root.nextModelId();
                if (closureId !== null) {
                  const closureNote =
                    "CERTIFICATE CLOSURE. Your own certificate rows imply the final answer " +
                    JSON.stringify(correction) +
                    ", but candidateProposal is " +
                    JSON.stringify(latestCertified.candidate) +
                    ". Return exactly one complete WorkPacket with candidateProposal exactly " +
                    JSON.stringify(correction) +
                    " and retain the CERT1 rows. Do not change the mathematics or re-solve; this turn only closes the contradiction. " +
                    "Keep claim, derivation and candidateProposal within 4096 Unicode code points each.";
                  const closureContext = buildConsensusContext(closureId, closureNote);
                  const closureOutcome = await calls.model({
                    task: running,
                    // WORK is not consensus-budgeted by the Host; the closure
                    // turn is a consistency repair of the same undelivered
                    // answer task, not an extra adversarial ballot.
                    phase: "WORK",
                    messages: closureContext.messages,
                    contextHash: closureContext.contextHash,
                    contextBytes: closureContext.contextBytes,
                    requestId: closureId,
                  });
                  const closure = evaluateConsensus(closureOutcome);
                  if (closure !== null) {
                    const closureCandidate =
                      closure.prepared.packet?.candidateProposal ?? "";
                    if (closureCandidate.length > 0) {
                      consensusAttempts.push({
                        prepared: closure.prepared,
                        outcome: closure.outcome,
                        candidate: closureCandidate,
                        certified: isCertifiedPacket(closure.prepared.packet ?? {}),
                      });
                    }
                  }
                }
              }
            }
            const candidateAttempts = consensusAttempts.filter(
              (attempt) => attempt.candidate.length > 0,
            );
            if (candidateAttempts.length === 0 && firstPacketOverlong) {
              stop = "PACKET_REJECTED";
              break;
            }
            // A candidate carrying a machine-readable CERT1|FINAL row is the
            // final independent check and wins over correlated audit repeats.
            // The Host projection applies the same rule. Without a certificate
            // row, keep the exact-support majority with the latest tie-break.
            const certifiedAttempts = candidateAttempts.filter(
              (attempt) => attempt.certified,
            );
            // Votes are grouped by canonical mathematical key, while every
            // stored/displayed candidate remains the model's original text.
            const counts = new Map<string, number>();
            for (const attempt of candidateAttempts) {
              const key = canonicalAnswerKey(attempt.candidate);
              counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            let chosen =
              candidateAttempts[candidateAttempts.length - 1] ?? consensusAttempts[0]!;
            if (certifiedAttempts.length > 0) {
              chosen = certifiedAttempts[certifiedAttempts.length - 1]!;
            } else if (candidateAttempts.length > 0) {
              let bestCount = 0;
              for (const count of counts.values()) {
                bestCount = Math.max(bestCount, count);
              }
              for (let index = candidateAttempts.length - 1; index >= 0; index -= 1) {
                const attempt = candidateAttempts[index]!;
                if ((counts.get(canonicalAnswerKey(attempt.candidate)) ?? 0) === bestCount) {
                  chosen = attempt;
                  break;
                }
              }
            }
            prepared = chosen.prepared;
            outcome = chosen.outcome;
            receiptInput.sourceRequestId = chosen.outcome.requestId;
            receiptInput.text = chosen.outcome.receipt.text;

            // Generic answer closures (degree conservation, density
            // normalization, option coverage, solution completeness). These
            // checks use only the problem's stated objects, the packet's own
            // certificate rows and an input-relative exact observation. They
            // never turn a model claim into verification and never change the
            // candidate on their own: one bounded model turn must deliver the
            // corrected complete packet.
            if (
              opts.maxConsensus >= 1 &&
              answerBearingTask &&
              prepared.packet !== null &&
              (answerClosureTurns < 2 || observations.some((o) => !consumedObservationHashes.has(o.observationHash))) &&
              callsLeft() >= 2 + opts.maxReviews
            ) {
              for (const o of observations) {
                consumedObservationHashes.add(o.observationHash);
              }
              const closureCandidate = prepared.packet.candidateProposal ?? "";
              const requiresExhaustive =
                /(所有解|全部解|一切解|解集|所有根|全部根|complete\s+solution\s+set|all\s+solutions)/iu.test(
                  problemText,
                );
              const defects = answerClosureDefects({
                problemText,
                candidate: closureCandidate,
                packet: prepared.packet,
                exactObservations,
                toolObservations: toolObservationViews,
                // Do not infer a complete solution set from an unanchored
                // `lhs=rhs` regex match in prose. Until a dedicated trusted
                // solver supplies the set, completeness is closed only by an
                // explicit CERT1|COMPLETENESS marker.
                expectedSolutionKeys: null,
                requiresExhaustive,
              });
              // One session-log row per closure EVALUATION, defects or not: an
              // operator must be able to tell "closure ran and found nothing"
              // apart from "closure never ran" (the reason the
              // `observation_used` metric previously read 0 on real runs).
              let closureRequestId: string | null = null;
              let closureNextCandidate: string | null = null;
              let candidateChanged = false;
              let remaining: readonly AnswerClosureDefect[] = defects;
              if (defects.length > 0) {
                const closureId = root.nextModelId();
                if (closureId !== null) {
                  answerClosureTurns += 1;
                  closureRequestId = closureId;
                  const closureContext = buildConsensusContext(
                    closureId,
                    answerClosureNote(defects),
                  );
                  const closureOutcome = await calls.model({
                    task: running,
                    // WORK is not consensus-budgeted by the Host; this is a
                    // consistency closure of the same undelivered answer task.
                    phase: "WORK",
                    messages: closureContext.messages,
                    contextHash: closureContext.contextHash,
                    contextBytes: closureContext.contextBytes,
                    requestId: closureId,
                  });
                  const closure = evaluateConsensus(closureOutcome);
                  if (closure !== null) {
                    const nextCandidate =
                      closure.prepared.packet?.candidateProposal ?? "";
                    if (nextCandidate.length > 0) {
                      closureNextCandidate = nextCandidate;
                      remaining = answerClosureDefects({
                        problemText,
                        candidate: nextCandidate,
                        packet: closure.prepared.packet ?? {},
                        exactObservations,
                        toolObservations: toolObservationViews,
                        expectedSolutionKeys: null,
                        requiresExhaustive,
                      });
                      // Adopt a closure correction when the OBSERVATION-grounded
                      // defect count falls. A certificate-only defect introduced
                      // by the correction must not discard a corrected exact
                      // answer (the original #35 failure mode). If observation
                      // defects are unchanged, require the total defect count to
                      // fall, so a different answer with the same unresolved
                      // defect is still not an improvement.
                      const initialObservationDefects = defects.filter(
                        (defect) => defect.evidence === "OBSERVATION",
                      ).length;
                      const remainingObservationDefects = remaining.filter(
                        (defect) => defect.evidence === "OBSERVATION",
                      ).length;
                      const improved =
                        remainingObservationDefects < initialObservationDefects ||
                        (remainingObservationDefects === initialObservationDefects &&
                          remaining.length < defects.length);
                      if (improved) {
                        candidateChanged = nextCandidate !== closureCandidate;
                        prepared = closure.prepared;
                        outcome = closure.outcome;
                        receiptInput.sourceRequestId = closure.outcome.requestId;
                        receiptInput.text = closure.outcome.receipt.text;
                      }
                    }
                  }
                }
              }
              sessionLog.append("CONSENSUS", {
                stage: "ANSWER_CLOSURE",
                requestId: closureRequestId,
                defects: defects.map((defect) => defect.kind),
                observationViews: toolObservationViews.length,
                // Provenance, not a kind allow-list: a defect counts as
                // observation-grounded only when the closure itself recorded
                // that a completed tool observation grounded it. With no view
                // in the run this is always false.
                observationUsed:
                  toolObservationViews.length > 0 &&
                  defects.some((defect) => defect.evidence === "OBSERVATION"),
                closureRequested: closureRequestId !== null,
                candidateChanged,
                remainingDefects: remaining.map((defect) => defect.kind),
                ...(closureNextCandidate === null
                  ? {}
                  : {
                      previousCandidate: closureCandidate,
                      nextCandidate: closureNextCandidate,
                      agreement: closureNextCandidate === closureCandidate,
                    }),
              });
            }
          }
          if (prepared.packet !== null && prepared.packet.schemaVersion === "p2a-work-v5") {
            const proposed = prepared.packet.scopeProposal;
            if (proposed !== null) {
              try {
                store.validateScopeCoverage(running, {
                  quantifiers: proposed.quantifiers,
                  branchConditions: proposed.branchConditions,
                  boundaryCases: proposed.boundaryCases,
                  goalExhaustion: proposed.goalExhaustion,
                });
              } catch (error) {
                if (!(error instanceof P2Error)) {
                  throw error;
                }
                // A control-violating v5 scope proposal is fail-closed: stop the
                // whole run so a later R2 can never overwrite the reason, and
                // never release an earlier candidate. No artifact and no
                // delivery record were written for this turn.
                root.stop("CONTROL_REJECTED");
                stop = "CONTROL_REJECTED";
                target = null;
                protectedOrigin = null;
                break;
              }
            }
          }
          receiptInput.artifactId = prepared.artifactId;
          try {
            accepted = store.accept(running, receiptInput);
          } catch (error) {
            if (!(error instanceof P2Error)) {
              throw error;
            }
            stop = "PACKET_REJECTED";
            break;
          }
          ref = {
            artifactId: accepted.artifactId,
            artifactVersion: accepted.envelope.artifactVersion ?? 1,
          };
          ledger.recordDelivery(
            running.taskId,
            ref,
            accepted.deliveryStatus === "COMPLETE" ? "DELIVERED" : "PARTIAL",
            accepted.envelope.eventSeq,
          );
          sessionLog.append("WORKUNIT", {
            taskId: running.taskId,
            goalId: running.goalId,
            scopeId: running.scopeId,
            artifactId: ref.artifactId,
            artifactVersion: ref.artifactVersion,
            deliveryStatus: accepted.deliveryStatus,
            sourceRequestId: outcome.requestId,
            // Defect 3: the delivered candidate text is recorded in the private
            // log so a checkpoint/resume can rebuild the artifact and candidate,
            // and the ReplayRunner can re-derive the final answer.
            candidateProposal: accepted.packet?.candidateProposal ?? null,
            workReceipt: p2Snapshot(receiptInput),
            routeInput: p2Snapshot({ routeId: route.routeId, representation: route.representation, operation: route.operation, lemmas: route.lemmas, construction: route.construction }),
          });
          workUnits += 1;
          if (accepted.deliveryStatus !== "COMPLETE") {
            if (revision.pendingTaskId() === null) {
              try {
                ledger.validateYieldTask(running.taskId, outcome.requestId, "PARTIAL");
                progress.validateRecordYield(running.taskId, outcome.requestId, "PARTIAL");
                ledger.yieldTask(running.taskId, outcome.requestId, "PARTIAL");
                progress.recordYield(running.taskId, outcome.requestId, "PARTIAL");
              } catch (error) {
                if (!(error instanceof P2Error)) {
                  throw error;
                }
                stop = "CONTROL_REJECTED";
                break;
              }
              yielded = true;
            }
            stop = "NO_CANDIDATE";
            break;
          }
          if (target === null && store.candidate(ref) !== null) {
            const snapshot = ledger.snapshot();
            const obligation = snapshot.obligations.find(
              (row) => row.obligationId === running.obligationId,
            );
            // The whole-problem candidate may only come from a ROOT goal's
            // answer obligation. A task of a sub-goal (e.g. a MULTIPART child
            // goal-1-a) is a local step: it is a real task and can be consumed,
            // but its COMPLETE packet is never the whole-problem candidate.
            const rootGoal = snapshot.goals.some((goal) => goal.goalId === running.goalId);
            if (
              obligation !== undefined &&
              rootGoal &&
              p2IsAnswerObligationKindForGoal(
                goalKindOf(snapshot.goals, running.goalId),
                obligation.kind,
              )
            ) {
              try {
                target = p4Target(snapshot, accepted, "ACTIVE");
                protectedOrigin = target;
                candidateTask = running;
              } catch (error) {
                if (!(error instanceof P2Error)) {
                  throw error;
                }
                stop = "CONTROL_REJECTED";
                break;
              }
            }
          }
        }
        // Only a WORK whose context actually allowed a proposal may admit one.
        // A rejected proposal returns false and leaves the accepted artifact,
        // the ledger, the store and the protected candidate untouched.
        if (allowRouteProposal) {
          workflow.admit(
            accepted,
            callsLeft(),
            opts.maxReviews,
            opts.maxWorkUnits - workUnits,
            root.remainingMs(),
          );
        }
        if (allowTaskContinuation) {
          workflow.admitDependency(
            accepted,
            callsLeft(),
            opts.maxReviews,
            opts.maxWorkUnits - workUnits,
            root.remainingMs(),
          );
        }
        if (allowArtifactRedo) {
          revision.admit(
            accepted,
            callsLeft(),
            opts.maxReviews,
            opts.maxWorkUnits - workUnits,
            root.remainingMs(),
          );
        }
        // A real v5 SCOPE_REFINEMENT proposal is registered as declared data
        // only. It never closes an obligation, never changes the ready set and
        // is never a coverage proof; an out-of-scope item is a fixed
        // SCOPE_MISMATCH rejection that leaves the accepted artifact, the
        // ledger and the store untouched.
        const scopeProposal =
          accepted.packet !== null &&
          accepted.packet.schemaVersion === "p2a-work-v5"
            ? accepted.packet.scopeProposal
            : null;
        if (scopeProposal !== null) {
          // Explicit six-field -> four-field projection of the untrusted v5
          // scope proposal. `kind` and `rationale` are dropped here; only the
          // four declared list fields reach the store. The projection and its
          // validation happen before any write, so a tampered, missing or
          // extra field is a fixed rejection with no side effect on the store,
          // the ledger or the scheduling sequence.
          const projected = {
            quantifiers: scopeProposal.quantifiers,
            branchConditions: scopeProposal.branchConditions,
            boundaryCases: scopeProposal.boundaryCases,
            goalExhaustion: scopeProposal.goalExhaustion,
          };
          try {
            store.declareScopeCoverage(running, projected);
          } catch (error) {
            if (!(error instanceof P2Error)) {
              throw error;
            }
            stop = "CONTROL_REJECTED";
            break;
          }
        }
        advanced = true;
        break;
      }
      if (stop !== "NO_CANDIDATE" && stop !== "WORK_UNITS_COMPLETE") {
        break;
      }
      if (yielded) {
        continue;
      }
      if (!advanced) {
        break;
      }
    }

    if (stop === "NO_CANDIDATE" && target !== null) {
      stop = "WORK_UNITS_COMPLETE";
    }

    if (revision.pendingTaskId() !== null) {
      revision.abort();
    }

    if (protectedOrigin !== null) {
      const originRef: P2ArtifactRef = {
        artifactId: protectedOrigin.binding.artifactId,
        artifactVersion: protectedOrigin.binding.artifactVersion,
      };
      let originEntry;
      try {
        originEntry = store.get(originRef);
      } catch (error) {
        if (!(error instanceof P2Error)) {
          throw error;
        }
        originEntry = null;
      }
      if (originEntry !== null && originEntry.availability === "STALE") {
        target = p2Snapshot({ ...protectedOrigin, availability: "STALE" as const }) as P4Target;
      }
    }

    const runReviewRound = async (
      candidate: P4Target,
      stage: "R2" | "R4",
    ): Promise<P4ReviewSession | null> => {
      if (root.nextModelId() === null || root.remainingMs() <= MIN_MS) {
        stop = root.remainingMs() <= MIN_MS ? "DEADLINE_EXCEEDED" : "NO_REVIEW";
        return null;
      }
      const reviewTask = ledger
        .snapshot()
        .tasks.find((row) => row.taskId === candidate.binding.taskId);
      if (reviewTask === undefined || reviewTask.delivery !== "DELIVERED") {
        stop = "CONTROL_REJECTED";
        return null;
      }
      const ordinal = root.modelCalls() + 1;
      let session: P4ReviewSession;
      try {
        session = new P4ReviewSession(ledger.snapshot(), candidate, 1, ordinal, stage);
      } catch (error) {
        if (!(error instanceof P2Error)) {
          throw error;
        }
        stop = "CONTROL_REJECTED";
        return null;
      }
      if (stage === "R2" && protectedReview === null) {
        protectedReview = session;
        firstReviewOrdinal = ordinal;
      }
      const requestId = root.nextModelId();
      if (requestId === null) {
        stop = "NO_REVIEW";
        return null;
      }
      let admitted: ReturnType<P4ReviewSession["admit"]> | null = null;
      try {
        admitted = session.admit(requestId, root.remainingMs());
      } catch (error) {
        if (!(error instanceof P2Error)) {
          throw error;
        }
        stop = "CONTROL_REJECTED";
        return null;
      }
      if (admitted === null) {
        return null;
      }
      const before = root.modelCalls();
      const outcome = await calls.model({
        task: reviewTask,
        phase: stage,
        messages: admitted.context.messages,
        contextHash: admitted.context.contextHash,
        contextBytes: admitted.context.contextBytes,
        onDispatch: (id) => session.markDispatched(id),
      });
      if (root.modelCalls() > before) {
        reviewCalls += 1;
      }
      if (root.modelCalls() <= before) {
        stop = outcome.code;
        return session;
      }
      try {
        const settled = session.settle(
          outcome.requestId,
          outcome.receipt.transportStatus,
          outcome.receipt.text,
          root.remainingMs(),
        );
        stop =
          settled.code === "OK" &&
          settled.report !== null &&
          settled.report.conclusion !== "UNKNOWN"
            ? "REVIEWS_COMPLETE"
            : "REVIEW_STOP";
      } catch (error) {
        if (!(error instanceof P2Error)) {
          throw error;
        }
        stop = "CONTROL_REJECTED";
      }
      return session;
    };

    const attemptRevision = async (
      candidate: P4Target,
      roundReview: P4ReviewSession,
      challenges: readonly P4Challenge[],
    ): Promise<{
      readonly accepted: boolean;
      readonly decision: ReturnType<typeof reviseCandidate>["decision"];
      readonly child: P4Target;
    } | null> => {
      if (
        candidateTask === null ||
        opts.maxRepairs < 1 ||
        repairCalls >= opts.maxRepairs ||
        schemaRepairs > 0 ||
        callsLeft() < 1 ||
        root.remainingMs() <= MIN_MS
      ) {
        return null;
      }
      const checker = calls.effects.find(
        (item) =>
          item.receipt.status === "COMPLETE" &&
          item.receipt.source === "PROGRAM_OBSERVATION" &&
          item.receipt.binding.scopeId === candidate.binding.scopeId,
      );
      const snapshot = ledger.snapshot();
      const goalKind = goalKindOf(
        snapshot.goals as readonly {
          readonly goalId: string;
          readonly kind: P2GoalKind;
          readonly subgoals: readonly unknown[];
        }[],
        candidate.binding.goalId,
      );
      const answerKind = p2AnswerObligationForGoal(goalKind);
      const answerObligation = snapshot.obligations.find(
        (row) => row.goalId === candidate.binding.goalId && row.kind === answerKind,
      );
      // G3/PR4 Slice 3a: M5 S1 original-problem mapping gate. A
      // PROGRAM_OBSERVATION receipt may be promoted to a CHECKED_SCOPE/PASS
      // P4ReviseBasis ONLY after the S1 structural mapping check passes against
      // the trusted target: the checker's tool/checked-property, scope,
      // assumptions and challenged obligations must all be the target's own.
      // An E07 wrong mapping (unknown checker tool, foreign obligation, scope or
      // assumption mismatch) is refused, so the receipt can never ground a
      // revision and can never upgrade the candidate.
      const challenge0 = challenges[0];
      if (challenge0 !== undefined && checker !== undefined && answerObligation !== undefined) {
        try {
          s1Assessment = new P4DiagnosticLedger(ledger.snapshot(), candidate, 1).precheck({
            checkId: `check-${Math.min(2, repairCalls + 1)}`,
            target: candidate.binding,
            targetHash: candidate.targetHash,
            scope: candidate.artifact.scope,
            assumptions: candidate.artifact.packet?.assumptions ?? [],
            checkedProperty:
              checker.request.action.action === "tool"
                ? p4CheckedPropertyForTool(checker.request.action.name) ??
                  "SUPPLIED_POLYNOMIAL_COEFFICIENTS"
                : "SUPPLIED_POLYNOMIAL_COEFFICIENTS",
            methodOrToolVersion: "tool-registry-v1",
            obligationIds: challenge0.issue.obligationIds,
            request: checker.request,
          });
        } catch (error) {
          if (!(error instanceof P2Error)) {
            throw error;
          }
          s1Assessment = null;
        }
      }
      let s1Ok =
        s1Assessment !== null &&
        s1Assessment.structuralMatch &&
        s1Assessment.reason === "STRUCTURAL_MATCH_ONLY";
      // Step 1 hard gate 1: a structural match + variable domain is never enough.
      // The checker must substantively support the challenged obligation; any
      // UNKNOWN / unrelated relation is fail-closed for EVERY policy.
      if (s1Ok && checker !== undefined && !checkerSupportsObligation(checker.request.action, problemText)) {
        s1Ok = false;
      }
      if (s1Ok && captured.asset !== null && checker !== undefined) {
        // G7/PR7 Slice 7e: bind the S1 checker to the Host registry through one
        // scoped asset call within the current scope + contract version. A
        // refused descriptor is fail-closed (never promote the checker).
        const toolName = checker.request.action.action === "tool" ? checker.request.action.name : "";
        const assetKey = S1_CHECKER_ASSET[toolName];
        if (assetKey !== undefined) {
          const scopeHash = p4Hash(JSON.stringify({ scope: candidate.binding.scopeId, check: assetKey }));
          try {
            const descriptor = (await captured.asset.call({
              group: "outputCheckers",
              assetId: assetKey,
              scopeId: scopeHash,
              contractVersion: contract.contractVersion,
            })) as { assetId: string; scopeId: string; sha256: string };
            if (descriptor.assetId !== assetKey || descriptor.scopeId !== scopeHash) {
              s1Ok = false;
            } else {
              s1AssetDescriptor = descriptor.sha256;
            }
          } catch {
            s1Ok = false;
          }
        }
      }
      // Step 1 hard gate 1: a checker present but NOT substantively supporting
      // the challenged obligation is a fail-closed REVISE_REJECTED for EVERY
      // policy (BEST_EFFORT included); the protected parent candidate is kept.
      if (!s1Ok && checker !== undefined && challenges.length > 0) {
        stop = "REVISE_REJECTED";
        return null;
      }
      if (!(challenges.length > 0 && checker !== undefined && answerObligation !== undefined && s1Ok)) {
        return null;
      }
      const challenge = challenges[0]!;
      const repairTask = candidateTask;
      const route = workflow.forTask(repairTask);
      const requestId = root.nextModelId();
      if (requestId === null) {
        return null;
      }
      const body = {
        schemaVersion: "p4-repair-context-v1" as const,
        sessionId: session,
        problemHash,
        contractVersion: contract.contractVersion,
        problemFullText: problemText,
        stage: "REPAIR" as const,
        requestId,
        task: p2Snapshot({
          taskId: repairTask.taskId,
          goalId: repairTask.goalId,
          scopeId: repairTask.scopeId,
          inputArtifactRefs: repairTask.inputArtifactRefs,
        }),
        route: { routeId: route.routeId },
        sourceRequestId: requestId,
        answerObligationId: answerObligation.obligationId,
        challenge,
        parentCandidate: candidate.artifact.packet?.candidateProposal ?? null,
      };
      const messages = [
        {
          role: "system" as const,
          content:
            "You are a strict single revision reviser. Reply with exactly one JSON work packet and nothing else. You cannot declare anything verified.",
        },
        { role: "user" as const, content: JSON.stringify(body) },
      ];
      const contextBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      const before = root.modelCalls();
      const outcome = await calls.model({
        task: repairTask,
        phase: "REPAIR",
        messages,
        contextHash: p4Hash(JSON.stringify(messages)),
        contextBytes,
      });
      if (!(root.modelCalls() > before && outcome.receipt.transportStatus === "COMPLETE")) {
        stop = outcome.receipt.transportStatus === "COMPLETE" ? outcome.code : "PACKET_REJECTED";
        return null;
      }
      repairCalls += 1;
      try {
        const childArtifact = store.accept(repairTask, {
          // Match the Host projection's artifact identity for a REPAIR row:
          // it names the next projected artifact in the real history.
          artifactId: `repair-${store.snapshot().length + 1}`,
          routeId: route.routeId,
          sourceRequestId: requestId,
          transportStatus: outcome.receipt.transportStatus,
          text: outcome.receipt.text,
          eventSeq: ledger.nextEventSeq(),
          supersedes: null,
        });
        const child = p4Target(ledger.snapshot(), childArtifact, "ACTIVE");
        // B3 (DECISION-0150): for a PARAMETER goal the trusted parameter
        // branches are the required gap set (the bounded "PARAMETER two
        // gaps" flagship); the revised child must restate every branch or
        // the revision fails closed (REVISE_REJECTED).
        const gapSet =
          goalKind === "PARAMETER"
            ? parameterGapsOf(ledger.snapshot().goals, candidateTask.goalId)
            : [];
        const answerText = child.artifact.packet?.candidateProposal ?? "";
        // Step 1 hard gate 2 (completeness): when the protected parent is a
        // numeric solution set of a solvable relation, the revision must be a
        // well-formed, NON-empty numeric set that (a) keeps every valid parent
        // root, (b) contains only genuine roots of the relation, and (c) is
        // strictly larger (it must cover the checker-verified missing roots).
        // Any other format (e.g. `999`, `x = 999`) or a degenerate set (`{}`,
        // `{0}`) is fail-closed; reviseCandidate is never called.
        const relation = problemRelationPolynomial(problemText);
        const trueRoots = solutionSetOf(relation);
        // P0-1: for a problem with an independently determinable finite
        // single-variable solution set, a revision is accepted ONLY when the
        // revised answer is a well-formed, deduplicated set EXACTLY equal to
        // the independently solved set (exact rational arithmetic). Any
        // other case — unparseable/unsupported representation, empty set,
        // stale/extra/missing elements, or an undeterminable relation — is
        // fail-closed: reviseCandidate is never called and the parent
        // candidate is kept. A model claim of "fixed" is never a basis.
        let basisSupported = true;
        if (relation !== null && trueRoots !== null) {
          const childRats = rationalSetElements(answerText);
          if (trueRoots.length === 0 || childRats === null || !sameRationalSet(childRats, trueRoots)) {
            basisSupported = false;
          }
        } else if (goalKind === "ALL_SOLUTIONS") {
          // An ALL-SOLUTIONS goal whose real solution set is not
          // independently determinable (multi-variable, non-integer
          // coefficients, zero polynomial, or a real set that is not
          // exactly the rational set — e.g. irrational roots) can never
          // ground a revision: "unable to verify completeness" must never
          // become an evidence-grounded repair. Fail closed for this goal
          // class only; other classes such as PARAMETER ground their
          // revision on the trusted branch/gap coverage.
          basisSupported = false;
        }
        const basis: P4ReviseBasis | null = basisSupported
          ? {
              source: "CHECKER_COUNTEREXAMPLE",
              level: "CHECKED_SCOPE",
              checkResult: "PASS",
              scopeId: candidate.binding.scopeId,
              witness: checker.receipt.observation.slice(0, 2048),
              obligatedObligationIds: [answerObligation.obligationId],
              childCoverage: [answerObligation.obligationId],
              ...(gapSet.length > 0
                ? {
                    requiredGaps: gapSet,
                    coveredGaps: gapSet.filter((gap) => answerText.includes(gap)),
                  }
                : {}),
            }
          : null;
        const revision =
          basis === null
            ? null
            : reviseCandidate(
                ledger.snapshot(),
                { parent: candidate, child, challenge, basis },
                root.remainingMs(),
              );
        if (revision === null) {
          stop = "REVISE_REJECTED";
          return null;
        }
        revisedDecision = revision.decision;
        if (revision !== null) {
          sessionLog.append("REPAIR", {
            accepted: revision.accepted,
            reason: revision.decision.reason,
            sourceRequestId: requestId,
            // Defect 3: record the revised candidate so resume/replay can
            // rebuild the current candidate and re-derive the final answer.
            candidateProposal: child.artifact.packet?.candidateProposal ?? null,
            finalResponse: revision.decision.finalResponse,
          });
        }
        if (revision !== null && revision.accepted) {
          // B1c (DECISION-0150): sync the M1 ledger to the local update of
          // the affected (challenged) answer obligation's task; every other
          // obligation/task keeps its prior state.
          ledger.recordLocalRevision(
            repairTask.taskId,
            {
              artifactId: childArtifact.artifactId,
              artifactVersion: childArtifact.envelope.artifactVersion ?? 1,
            },
            childArtifact.envelope.eventSeq,
          );
        }
        if (revision !== null) {
          s2Transaction = {
            supersededObligationIds: revision.supersededObligationIds,
            preservedObligationIds: revision.preservedObligationIds,
            preservedParentArtifactId: revision.preservedParentArtifactId,
          };
        }
        return {
          accepted: revision.accepted,
          decision: revision.decision,
          child,
        };
      } catch (error) {
        if (!(error instanceof P2Error)) {
          throw error;
        }
        stop = "CONTROL_REJECTED";
        return null;
      }
    };

    reviewTarget = target;
    if (target !== null && target.availability === "ACTIVE" && !root.stopped()) {
      if (opts.maxReviews === 0) {
        stop = "NO_REVIEW";
      } else {
        for (let round = 0; round < opts.maxReviews; round += 1) {
          if (reviewTarget === null || reviewTarget.availability !== "ACTIVE" || root.stopped()) {
            break;
          }
          if (root.nextModelId() === null || root.remainingMs() <= MIN_MS) {
            stop = root.remainingMs() <= MIN_MS ? "DEADLINE_EXCEEDED" : "NO_REVIEW";
            break;
          }
          const stage: "R2" | "R4" = round === 0 ? "R2" : "R4";
          const roundReview = await runReviewRound(reviewTarget, stage);
          if (roundReview === null) {
            break;
          }
          review = roundReview;
          const reviewSnapshotForLog = roundReview.snapshot();
          sessionLog.append("REVIEW_CHALLENGE", {
            reviewCalls,
            challenges: reviewSnapshotForLog.challenges.length,
            records: reviewSnapshotForLog.records.length,
          });
          if (stop === "REVIEW_STOP" || stop === "CONTROL_REJECTED" || stop === "DEADLINE_EXCEEDED") {
            break;
          }
          const challenges: readonly P4Challenge[] = reviewSnapshotForLog.challenges.filter(
            (item) => item.status === "CHALLENGED" && item.availability === "ACTIVE",
          );
          if (challenges.length === 0) {
            if (lastRevisionAccepted) {
              stop = "REVISED_CANDIDATE";
            }
            break;
          }
          if (opts.maxRepairs < 1 || repairCalls >= opts.maxRepairs) {
            if (lastRevisionAccepted) {
              stop = "REVISED_CANDIDATE";
            }
            break;
          }
          const revision = await attemptRevision(reviewTarget, roundReview, challenges);
          if (revision === null) {
            if (lastRevisionAccepted) {
              stop = "REVISED_CANDIDATE";
            }
            break;
          }
          if (!revision.accepted) {
            stop = "REVISE_REJECTED";
            break;
          }
          lastRevisionAccepted = true;
          reviewTarget = revision.child;
          stop = "REVISED_CANDIDATE";
          if (reviewCalls >= opts.maxReviews) {
            break;
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    {
      const code = (error as { code?: string }).code;
      const stack = new Error("trace").stack ?? "";
    }
    stop = "CONTROL_REJECTED";
  }

  // A pending redo that never settled must not leave its task READY/PENDING.
  if (revision.pendingTaskId() !== null) {
    revision.abort();
  }

  const policy: P4DeliveryPolicy = opts.policy;
  const candidateGate = new P4CandidateGate(
    ledger.snapshot(),
    policy,
    protectedReview === null ? 2 : firstReviewOrdinal,
  );
  if (target !== null) {
    try {
      candidateGate.protect(protectedOrigin === null ? target : protectedOrigin);
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      root.stop("CONTROL_REJECTED");
      stop = "CONTROL_REJECTED";
    }
  }
  // Defect 2(b): a REPAIR-produced revision must pass through exactly the same
  // final acceptance policy gate as the initial candidate. Under STRICT
  // (REQUIRE_SCOPE_CHECKS) an unverified revision (candidateVerified is always
  // false) can never be returned as a passing answer: the STRICT gate runs and
  // returns the honest UNSOLVED / STRICT_NOT_VERIFIED decision instead.
  let decision = candidateGate.finalize(
    ledger.snapshot(),
    target,
    protectedReview === null ? null : protectedReview.snapshot(),
    root.remainingMs(),
  );
  if (revisedDecision !== null && policy !== "STRICT") {
    decision = revisedDecision;
  }
  if (!root.stopped()) {
    root.stop(stop);
  }
  const unresolvedObligations: readonly string[] = Object.freeze(
    ledger
      .snapshot()
      .obligations.filter(
        (row) => AUX_OBLIGATION_KINDS.includes(row.kind) && row.status !== "SATISFIED",
      )
      .map((row) => row.obligationId),
  );
  sessionLog.append("FINAL", {
    status: decision.status,
    reason: decision.reason,
    finalResponse: decision.finalResponse,
    candidateVerified: false,
    unresolvedObligations,
  });
  // G7/PR7 Slice 7e: bind the S3 decision scope to the Host registry through one
  // scoped asset call, gated to evidence/repair profiles (maxRepairs>=1) so the
  // default and redo/preview paths stay byte-identical. A refusal just leaves the
  // descriptor unset; no evidence is fabricated.
  if (captured.asset !== null && target !== null && (opts.maxRepairs ?? 0) >= 1) {
    const scopeHash = p4Hash(JSON.stringify({ scope: target.binding.scopeId, stage: "S3" }));
    try {
      const descriptor = (await captured.asset.call({
        group: "outputCheckers",
        assetId: "computation.py",
        scopeId: scopeHash,
        contractVersion: contract.contractVersion,
      })) as { assetId: string; scopeId: string; sha256: string };
      if (descriptor.assetId === "computation.py" && descriptor.scopeId === scopeHash) {
        s3AssetDescriptor = descriptor.sha256;
      }
    } catch {
      s3AssetDescriptor = null;
    }
  }
  const summary: AgentLoopSummary = p2Snapshot({
    mode: "TS_PREVIEW" as const,
    targetEnvironment: "TARGET_UNVERIFIED" as const,
    sessionId: session,
    status: decision.status,
    finalResponse: decision.finalResponse,
    candidateVerified: false as const,
    strictAcceptance: "NOT_PERFORMED" as const,
    policy,
    reason: decision.reason,
    modelCalls: root.modelCalls(),
    effectCalls: root.effectCalls(),
    workUnits,
    reviewCalls,
    repairCalls,
    catalogCalls,
    methodLoads,
    stopReason: stop,
    unresolvedObligations,
  }, true) as AgentLoopSummary;
  const privateState = p2Snapshot({
    contract: ledger.snapshot(),
    events: ledger.eventsSnapshot(),
    artifacts: store.snapshot(),
    requests: calls.requests,
    effects: calls.effects,
    modelGate: gate.snapshot(),
    review: review === null ? null : review.snapshot(),
    decision,
    session: root.snapshot(),
    catalog,
    routes: workflow.snapshot().routes,
    taskRoutes: workflow.snapshot().taskRoutes,
    routeAdmissions: workflow.snapshot().routeAdmissions,
    dependencyAdmissions: workflow.snapshot().dependencyAdmissions,
    revisions: revision.snapshot(),
    s1Assessment,
    s1AssetDescriptor,
    s3AssetDescriptor,
    s2Transaction,
    readyTasks: ledger.readyTasks(),
    progressEvents: progress.snapshot(),
    sessionLog: sessionLog.snapshot(),
  }, true);
  return p2Snapshot({ summary, privateState }, true) as AgentLoopResult;
}
