import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Hash, type AgentModelRequest, type P3EffectReceipt, type P3EffectRequest } from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import { reactivePorts, reactiveWork } from "./agent-loop-test-support.js";

/**
 * Loop-level coverage of the ANSWER_CLOSURE session-log row: the row must be
 * written on EVERY closure evaluation, so an operator can tell "closure ran and
 * found nothing" apart from "closure never ran".
 *
 * The problem is a maximal-minor (Alexander polynomial) task, so the loop's
 * deterministic exact-check route grounds DEGREE_CONSERVATION in a real tool
 * observation. Nothing here is a proof: the candidate stays unverified.
 */

const PROBLEM = "计算给定矩阵的亚历山大多项式 P(t)。";
const OBSERVED_MINOR = "t⁶-5t⁵+10t⁴-13t³+10t²-5t+1";

function exactCheckReply(): string {
  return JSON.stringify({
    action: "tool",
    name: "exact_check_expr",
    args: {
      operation: "MAXIMAL_MINORS",
      matrix: [
        ["t", "0"],
        ["0", "t-1"],
      ],
      variable: "t",
    },
    scope: "maximal minors of the supplied matrix",
  });
}

/** One COMPLETE exact-check receipt carrying a real multi-minor payload. */
function maximalMinorEffect(request: P3EffectRequest): P3EffectReceipt {
  const observation = JSON.stringify({
    result: {
      schema: "exact-check-v1",
      operation: "MAXIMAL_MINORS",
      shape: [2, 2],
      minor_size: 1,
      raw_minors: [OBSERVED_MINOR, "0", "0", "t-1"],
      normalized_minors: [
        { polynomial: OBSERVED_MINOR, multiplicity: 16 },
        { polynomial: "2*" + OBSERVED_MINOR, multiplicity: 1 },
      ],
      zero_minors: 2,
    },
  });
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "PROGRAM_OBSERVATION",
    observation,
    observationHash: p4Hash(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  };
}

async function runClosure(options: {
  readonly candidate: string;
  readonly closureCandidate: string;
  readonly problem?: string;
  readonly initialChecks?: readonly string[];
  readonly closureChecks?: readonly string[];
}) {
  let turn = 0;
  const workWithChecks = (
    request: AgentModelRequest,
    candidate: string,
    checks: readonly string[],
  ): string => {
    const packet = JSON.parse(reactiveWork(request, { candidate })) as Record<string, unknown>;
    packet["suggestedChecks"] = [...checks];
    return JSON.stringify(packet);
  };
  const ports = reactivePorts({
    work: (request: AgentModelRequest) => {
      turn += 1;
      // Turn 1 calls the exact tool; every later turn delivers a WorkPacket. The
      // bounded closure turn is the last WORK call of the answer task.
      if (turn === 1) return exactCheckReply();
      if (turn === 2) {
        return workWithChecks(request, options.candidate, options.initialChecks ?? []);
      }
      if (turn === 3) {
        return workWithChecks(request, options.candidate, options.initialChecks ?? []);
      }
      if (options.closureCandidate === "") return "not a work packet";
      return workWithChecks(
        request,
        options.closureCandidate,
        options.closureChecks ?? [],
      );
    },
    effect: maximalMinorEffect,
  });
  const result = await runAgentLoop(
    options.problem ?? PROBLEM,
    "s",
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 1,
      maxConsensus: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  const closureRows = (result.privateState.sessionLog?.events ?? [])
    .filter((event) => event.kind === "CONSENSUS" && event.data["stage"] === "ANSWER_CLOSURE")
    .map((event) => event.data);
  return { result, requests: ports.requests, closureRows, turn };
}

test("an observation-grounded degree defect writes one ANSWER_CLOSURE row and adopts the repair", async () => {
  const run = await runClosure({
    candidate: "t²-t+1",
    closureCandidate: OBSERVED_MINOR,
  });
  assert.equal(run.closureRows.length, 1, "exactly one row per closure evaluation");
  const row = run.closureRows[0]!;
  assert.equal(row["stage"], "ANSWER_CLOSURE");
  assert.equal(row["requestId"], "model-4");
  assert.deepEqual(row["defects"], ["DEGREE_CONSERVATION"]);
  assert.equal(row["observationViews"], 1);
  assert.equal(row["observationUsed"], true);
  assert.equal(row["closureRequested"], true);
  assert.equal(row["candidateChanged"], true);
  assert.deepEqual(row["remainingDefects"], []);
  assert.equal(row["previousCandidate"], "t²-t+1");
  assert.equal(row["nextCandidate"], OBSERVED_MINOR);
  assert.equal(row["agreement"], false);
  assert.equal(run.result.summary.finalResponse, OBSERVED_MINOR);
  assert.equal(run.result.summary.candidateVerified, false);
  // The unicode superscript candidate was read, so the closure turn was really
  // driven by the observation and not skipped.
  assert.equal(run.requests.length, 4);
});

test("an ANSWER_CLOSURE row with no defects and no turn is written for a correct candidate", async () => {
  const run = await runClosure({
    candidate: OBSERVED_MINOR,
    closureCandidate: OBSERVED_MINOR,
  });
  assert.equal(run.closureRows.length, 1, "the evaluation is logged even with no defect");
  const row = run.closureRows[0]!;
  assert.equal(row["stage"], "ANSWER_CLOSURE");
  assert.equal(row["requestId"], null);
  assert.deepEqual(row["defects"], []);
  assert.equal(row["observationViews"], 1);
  assert.equal(row["observationUsed"], false);
  assert.equal(row["closureRequested"], false);
  assert.equal(row["candidateChanged"], false);
  assert.deepEqual(row["remainingDefects"], []);
  // No bounded closure turn was spent and no raw model text is logged.
  assert.equal(run.requests.length, 3);
  assert.equal("previousCandidate" in row, false);
  assert.equal("nextCandidate" in row, false);
  assert.equal(run.result.summary.finalResponse, OBSERVED_MINOR);
});

test("a spent closure turn that repairs nothing keeps the candidate and the defect row", async () => {
  const run = await runClosure({ candidate: "t²-t+1", closureCandidate: "" });
  assert.equal(run.closureRows.length, 1);
  const row = run.closureRows[0]!;
  assert.equal(row["requestId"], "model-4");
  assert.deepEqual(row["defects"], ["DEGREE_CONSERVATION"]);
  assert.equal(row["observationUsed"], true);
  assert.equal(row["closureRequested"], true, "the bounded turn was really spent");
  assert.equal(row["candidateChanged"], false);
  assert.deepEqual(row["remainingDefects"], ["DEGREE_CONSERVATION"]);
  // The unusable closure reply never replaces the delivered candidate.
  assert.equal(run.result.summary.finalResponse, "t²-t+1");
});

test("a corrected observation is adopted even when the closure packet drops a certificate marker", async () => {
  const run = await runClosure({
    // `所有解` makes the packet require a completeness marker. The initial
    // packet carries the marker, while the closure packet forgets it.
    problem: "计算亚历山大多项式 P(t)，并给出所有解。",
    candidate: "t²-t+1",
    closureCandidate: OBSERVED_MINOR,
    initialChecks: ["CERT1|COMPLETENESS|all cases covered => PASS"],
    closureChecks: [],
  });
  const row = run.closureRows[0]!;
  assert.deepEqual(row["defects"], ["DEGREE_CONSERVATION"]);
  assert.deepEqual(row["remainingDefects"], ["SOLUTION_COMPLETENESS"]);
  assert.equal(row["candidateChanged"], true);
  assert.equal(row["observationUsed"], true);
  // The mathematical correction wins even though the total defect count did
  // not fall: one observation defect disappeared and one certificate defect
  // appeared. The old `remaining.length < defects.length` rule would keep the
  // wrong polynomial here.
  assert.equal(run.result.summary.finalResponse, OBSERVED_MINOR);
});

// ---------------------------------------------------------------------------
// R1/R2/R3: evidence must be run-scoped and keyed by operation, and
// `observationUsed` must reflect real provenance instead of a kind allow-list.
// ---------------------------------------------------------------------------

/** A literal WorkPacket bound to the request it answers. */
function packet(request: AgentModelRequest, options: {
  readonly candidate: string;
  readonly suggestedChecks?: readonly string[];
}): string {
  const body = JSON.parse(request.messages[1]!.content) as {
    sessionId: string;
    problemHash: string;
    contractVersion: number;
    task: {
      taskId: string;
      goalId: string;
      scopeId: string;
      inputArtifactRefs: readonly { readonly artifactId: string; readonly artifactVersion: number }[];
    };
    route: { readonly routeId: string };
    sourceRequestId: string;
  };
  return JSON.stringify({
    schemaVersion: "p2a-work-v1",
    sessionId: body.sessionId,
    problemHash: body.problemHash,
    contractVersion: body.contractVersion,
    taskId: body.task.taskId,
    goalId: body.task.goalId,
    scopeId: body.task.scopeId,
    routeId: body.route.routeId,
    sourceRequestId: body.sourceRequestId,
    claim: "claim",
    derivation: "derivation",
    assumptions: [],
    dependencies: body.task.inputArtifactRefs.map((ref) => ({
      artifactId: ref.artifactId,
      artifactVersion: ref.artifactVersion,
    })),
    pendingObligations: [],
    suggestedChecks: options.suggestedChecks ?? [],
    deliveryStatus: "COMPLETE",
    candidateProposal: options.candidate,
  });
}

/** One exact-check tool action for a named operation. */
function toolAction(operation: string): string {
  const args =
    operation === "MAXIMAL_MINORS"
      ? {
          operation,
          matrix: [
            ["t", "0"],
            ["0", "t-1"],
          ],
          variable: "t",
        }
      : { operation, expression: "t^2-t+1", variable: "t", point: 1 };
  return JSON.stringify({
    action: "tool",
    name: "exact_check_expr",
    args,
    scope: operation + " of the supplied input",
  });
}

/** One COMPLETE exact-check receipt whose result names its own operation. */
function exactEffect(request: P3EffectRequest): P3EffectReceipt {
  const operation = request.action.action === "tool" ? request.action.args.operation : "";
  const result =
    operation === "MAXIMAL_MINORS"
      ? {
          operation,
          shape: [2, 2],
          minor_size: 1,
          normalized_minors: [
            { polynomial: OBSERVED_MINOR, multiplicity: 16 },
            { polynomial: "2*" + OBSERVED_MINOR, multiplicity: 1 },
          ],
          zero_minors: 2,
        }
      : { operation, value: 1 };
  const observation = JSON.stringify({ result });
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "PROGRAM_OBSERVATION",
    observation,
    observationHash: p4Hash(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  };
}

function closureRowsOf(result: Awaited<ReturnType<typeof runAgentLoop>>) {
  return (result.privateState.sessionLog?.events ?? []).filter(
    (event) => event.kind === "CONSENSUS" && event.data["stage"] === "ANSWER_CLOSURE",
  );
}

test("R1: an observation from an earlier task still grounds the later answer task", async () => {
  // A proof-shaped problem is compiled into several obligations and the routed
  // exact tool fires on the FIRST task, while the candidate-bearing task comes
  // later. The observation must survive that task transition.
  const problem = "证明给定矩阵的亚历山大多项式 P(t) 满足 P(1)=1。";
  const toolQueue: string[] = ["MAXIMAL_MINORS"];
  const ports = reactivePorts({
    work: (request: AgentModelRequest) => {
      const system = request.messages[0]!.content;
      if (system.includes("ANSWER CLOSURE")) {
        return packet(request, { candidate: OBSERVED_MINOR });
      }
      const next = toolQueue.shift();
      if (next !== undefined) return toolAction(next);
      return packet(request, { candidate: "t²-t+1" });
    },
    effect: exactEffect,
  });
  const result = await runAgentLoop(
    problem,
    "s",
    {
      remainingMs: 8000,
      maxModelCalls: 14,
      maxWorkUnits: 3,
      maxReviews: 0,
      maxEffects: 1,
      maxConsensus: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  const rows = closureRowsOf(result);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.deepEqual(row.data["defects"], ["DEGREE_CONSERVATION"]);
  assert.ok(
    (row.data["observationViews"] as number) >= 1,
    "the earlier task's observation survived the task transition",
  );
  assert.equal(row.data["observationUsed"], true);
  assert.equal(row.data["closureRequested"], true);
  assert.equal(row.data["candidateChanged"], true);
  assert.deepEqual(row.data["remainingDefects"], []);
  assert.equal(result.summary.finalResponse, OBSERVED_MINOR);
  // Proof that the grounding observation came from a DIFFERENT task: the tool
  // ran before the first delivery and the closure ran after two deliveries.
  const events = result.privateState.sessionLog?.events ?? [];
  const toolSeq = events.find((event) => event.kind === "TOOL_OBSERVATION")?.seq ?? -1;
  const firstUnitSeq = events.find((event) => event.kind === "WORKUNIT")?.seq ?? -1;
  const unitsBeforeClosure = events.filter(
    (event) => event.kind === "WORKUNIT" && event.seq < row.seq,
  ).length;
  assert.ok(toolSeq > 0 && firstUnitSeq > 0 && toolSeq < firstUnitSeq);
  assert.ok(unitsBeforeClosure >= 2, "the answer task was not the task that ran the tool");
});

test("R2: the degree diagnostic reads MAXIMAL_MINORS after an unrelated exact operation", async () => {
  // LIMIT and MAXIMAL_MINORS both run in one task, in both orders. A single
  // "latest exact result wins" slot would let LIMIT displace the minors result.
  const problem = "计算给定矩阵的亚历山大多项式 P(t)。";
  for (const order of [
    ["LIMIT", "MAXIMAL_MINORS"],
    ["MAXIMAL_MINORS", "LIMIT"],
  ] as const) {
    const toolQueue: string[] = [...order];
    const ports = reactivePorts({
      work: (request: AgentModelRequest) => {
        const next = toolQueue.shift();
        if (next !== undefined) return toolAction(next);
        return reactiveWork(request, { candidate: "t²-t+1" });
      },
      effect: exactEffect,
    });
    const result = await runAgentLoop(
      problem,
      "s",
      {
        remainingMs: 8000,
        maxModelCalls: 14,
        maxWorkUnits: 1,
        maxReviews: 0,
        maxEffects: 2,
        maxConsensus: 1,
        now: () => 0,
      },
      { model: ports.model, effect: ports.effect },
    );
    const rows = closureRowsOf(result);
    assert.equal(rows.length, 1, "one evaluation row per run for order " + order.join("->"));
    const row = rows[0]!;
    assert.deepEqual(
      row.data["defects"],
      ["DEGREE_CONSERVATION"],
      "the MAXIMAL_MINORS result grounded the degree defect for order " + order.join("->"),
    );
    assert.equal(row.data["observationViews"], 2);
    assert.equal(row.data["observationUsed"], true);
  }
});

test("R3: an OPTION_COVERAGE defect is certificate-based, not observation-grounded", async () => {
  const problem = [
    "计算给定矩阵的亚历山大多项式 P(t)。",
    "A. P(t)=t-1",
    "B. P(t)=t+1",
    "C. P(t)=t",
    "D. P(t)=1",
  ].join("\n");
  const options = ["CERT1|OPTIONS|A=TRUE,B=TRUE"];
  const toolQueue: string[] = ["LIMIT"];
  const ports = reactivePorts({
    work: (request: AgentModelRequest) => {
      const next = toolQueue.shift();
      if (next !== undefined) return toolAction(next);
      return packet(request, { candidate: "A、B", suggestedChecks: options });
    },
    effect: exactEffect,
  });
  const result = await runAgentLoop(
    problem,
    "s",
    {
      remainingMs: 8000,
      maxModelCalls: 14,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 1,
      maxConsensus: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  const rows = closureRowsOf(result);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.deepEqual(row.data["defects"], ["OPTION_COVERAGE"]);
  assert.ok((row.data["observationViews"] as number) >= 1, "a tool view was available");
  assert.equal(row.data["observationUsed"], false, "a certificate defect is not observation-grounded");
});

test("R3: a run without any tool view never reports observationUsed", async () => {
  const problem = ["计算多项式的次数。", "A. 1", "B. 2", "C. 3", "D. 4"].join("\n");
  const ports = reactivePorts({
    work: (request: AgentModelRequest) =>
      packet(request, {
        candidate: "A、B",
        suggestedChecks: ["CERT1|OPTIONS|A=TRUE,B=TRUE"],
      }),
  });
  const result = await runAgentLoop(
    problem,
    "s",
    {
      remainingMs: 8000,
      maxModelCalls: 10,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 0,
      maxConsensus: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  const rows = closureRowsOf(result);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.deepEqual(row.data["defects"], ["OPTION_COVERAGE"]);
  assert.equal(row.data["observationViews"], 0);
  assert.equal(row.data["observationUsed"], false);
});

// ---------------------------------------------------------------------------
// The interpolation observation family grounds `observationUsed` exactly like
// the maximal-minor family: a non-zero residual list opens one bounded closure
// turn, and a clean residual list never does.
// ---------------------------------------------------------------------------

const INTERPOLATION_PROBLEM = "求过点 (0,1)、(1,2)、(2,5) 的插值多项式 P(x)。";
const INTERPOLATING_POLYNOMIAL = "x**2 + 1";

/** One literal `interpolation_fit_check` action for the stated points. */
function interpolationAction(): string {
  return JSON.stringify({
    action: "tool",
    name: "interpolation_fit_check",
    args: {
      points: [
        { x: "0", y: "1" },
        { x: "1", y: "2" },
        { x: "2", y: "5" },
      ],
      expression: "x^2+2",
      variable: "x",
    },
    scope: "residuals of the claimed polynomial at the stated points",
  });
}

/** One COMPLETE observation carrying the producer's interpolation payload. */
function interpolationEffect(allZero: boolean): (request: P3EffectRequest) => P3EffectReceipt {
  return (request) => {
    const observation = JSON.stringify({
      result: {
        schema: "interpolation-fit-check-v1",
        operation: "INTERPOLATION_FIT",
        variable: "x",
        point_count: 3,
        residuals: allZero ? ["0", "0", "0"] : ["1/1", "1/1", "4/1"],
        all_zero: allZero,
        degree: 2,
        interpolating_polynomial: INTERPOLATING_POLYNOMIAL,
      },
    });
    return {
      effectId: request.effectId,
      binding: request.binding,
      status: "COMPLETE",
      source: "PROGRAM_OBSERVATION",
      observation,
      observationHash: p4Hash(observation),
      level: "PROVISIONAL",
      checkResult: "UNKNOWN",
    };
  };
}

async function runInterpolation(options: {
  readonly allZero: boolean;
  readonly candidate: string;
  readonly closureCandidate: string;
}) {
  let turn = 0;
  const ports = reactivePorts({
    work: (request: AgentModelRequest) => {
      turn += 1;
      if (request.messages[0]!.content.includes("ANSWER CLOSURE")) {
        return reactiveWork(request, { candidate: options.closureCandidate });
      }
      // The routed semantic tool turn comes first; every later turn delivers a
      // WorkPacket for the answer task.
      if (turn === 1) return interpolationAction();
      return reactiveWork(request, { candidate: options.candidate });
    },
    effect: interpolationEffect(options.allZero),
  });
  const result = await runAgentLoop(
    INTERPOLATION_PROBLEM,
    "s",
    {
      remainingMs: 8000,
      maxModelCalls: 12,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 1,
      maxConsensus: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  return { result, requests: ports.requests, rows: closureRowsOf(result) };
}

test("an interpolation residual observation grounds observationUsed exactly when it is non-zero", async () => {
  // Non-zero residuals: the candidate does not pass through the stated points,
  // so the observation grounds a defect and one bounded closure turn repairs it.
  const grounded = await runInterpolation({
    allZero: false,
    candidate: "x^2 + 2",
    closureCandidate: "x^2 + 1",
  });
  assert.equal(grounded.rows.length, 1, "one evaluation row per run");
  const row = grounded.rows[0]!;
  assert.equal(row.data["stage"], "ANSWER_CLOSURE");
  assert.deepEqual(row.data["defects"], ["INTERPOLATION_RESIDUAL"]);
  assert.equal(row.data["observationViews"], 1);
  assert.equal(row.data["observationUsed"], true);
  assert.equal(row.data["closureRequested"], true);
  assert.equal(row.data["candidateChanged"], true);
  assert.deepEqual(row.data["remainingDefects"], []);
  assert.equal(grounded.result.summary.finalResponse, "x^2 + 1");
  assert.equal(grounded.result.summary.candidateVerified, false);

  // Clean residuals: the same observation is recorded but grounds nothing, so
  // no closure turn is spent and `observationUsed` stays false.
  const clean = await runInterpolation({
    allZero: true,
    candidate: "x^2 + 1",
    closureCandidate: "x^2 + 1",
  });
  assert.equal(clean.rows.length, 1, "the evaluation is logged even with no defect");
  const cleanRow = clean.rows[0]!;
  assert.equal(cleanRow.data["stage"], "ANSWER_CLOSURE");
  assert.deepEqual(cleanRow.data["defects"], []);
  assert.equal(
    cleanRow.data["observationViews"],
    1,
    "the observation really was recorded",
  );
  assert.equal(cleanRow.data["observationUsed"], false);
  assert.equal(cleanRow.data["closureRequested"], false);
  assert.equal(cleanRow.data["candidateChanged"], false);
  assert.equal(clean.result.summary.finalResponse, "x^2 + 1");
});

// ---------------------------------------------------------------------------
// Option-level diagnostics: the chosen option's own text is where a verdict
// answer hides its contradiction. Selecting the matching option must spend no
// turn and must not claim `observationUsed`.
// ---------------------------------------------------------------------------

const OPTION_GROUP_PROBLEM = [
  "关于由 (12) 与 (123) 生成的置换群，选择正确的选项：",
  "A. 该群的阶为 6",
  "B. 该群的阶为 8",
  "C. 该群有 4 个共轭类",
  "D. 该群是循环群",
].join("\n");

/** One literal `finite_group_structure` action for the stated generators. */
function groupAction(): string {
  return JSON.stringify({
    action: "tool",
    name: "finite_group_structure",
    args: { generators: ["(12)", "(123)"], degree: 3 },
    scope: "order and conjugacy classes of the explicitly generated subgroup",
  });
}

/** One COMPLETE group enumeration: order 6, three classes, neither property. */
function groupEffect(request: P3EffectRequest): P3EffectReceipt {
  const observation = JSON.stringify({
    result: {
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
    },
  });
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "PROGRAM_OBSERVATION",
    observation,
    observationHash: p4Hash(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  };
}

/** A CERT1|OPTIONS row marking exactly one option TRUE. */
function singleOptionRow(letter: string): string {
  return (
    "CERT1|OPTIONS|" +
    ["A", "B", "C", "D"]
      .map((option) => option + "=" + (option === letter ? "TRUE" : "FALSE"))
      .join(",")
  );
}

async function runOptionSelection(options: {
  readonly candidate: string;
  readonly closureCandidate: string;
}) {
  const ports = reactivePorts({
    work: (request: AgentModelRequest) => {
      if (request.messages[0]!.content.includes("ANSWER CLOSURE")) {
        return packet(request, {
          candidate: options.closureCandidate,
          suggestedChecks: [singleOptionRow("A")],
        });
      }
      // The routed group tool runs once; every later turn delivers a packet.
      const body = JSON.parse(request.messages[1]!.content) as {
        toolObservations?: readonly unknown[];
      };
      if ((body.toolObservations ?? []).length === 0) return groupAction();
      return packet(request, {
        candidate: options.candidate,
        suggestedChecks: [singleOptionRow(options.candidate)],
      });
    },
    effect: groupEffect,
  });
  const result = await runAgentLoop(
    OPTION_GROUP_PROBLEM,
    "s",
    {
      remainingMs: 8000,
      maxModelCalls: 12,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 1,
      maxConsensus: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  return { result, requests: ports.requests, rows: closureRowsOf(result) };
}

test("an option-level group-order contradiction grounds observationUsed and is repaired", async () => {
  const run = await runOptionSelection({ candidate: "B", closureCandidate: "A" });
  assert.equal(run.rows.length, 1, "exactly one closure evaluation");
  const row = run.rows[0]!;
  assert.equal(row.data["stage"], "ANSWER_CLOSURE");
  assert.deepEqual(row.data["defects"], ["OPTION_NUMERIC_CONTRADICTION"]);
  assert.equal(row.data["observationViews"], 1);
  assert.equal(row.data["observationUsed"], true);
  assert.equal(row.data["closureRequested"], true, "one bounded closure turn was spent");
  assert.equal(row.data["candidateChanged"], true);
  assert.deepEqual(row.data["remainingDefects"], []);
  assert.equal(run.result.summary.finalResponse, "A");
  assert.equal(run.result.summary.candidateVerified, false);
});

test("selecting the option that matches the observation spends no closure turn", async () => {
  const run = await runOptionSelection({ candidate: "A", closureCandidate: "A" });
  assert.equal(run.rows.length, 1, "the evaluation is logged even with no defect");
  const row = run.rows[0]!;
  assert.equal(row.data["stage"], "ANSWER_CLOSURE");
  assert.deepEqual(row.data["defects"], []);
  assert.equal(row.data["observationViews"], 1, "the observation really was recorded");
  assert.equal(row.data["observationUsed"], false);
  assert.equal(row.data["closureRequested"], false);
  assert.equal(row.data["candidateChanged"], false);
  assert.equal(run.result.summary.finalResponse, "A");
});

// ---------------------------------------------------------------------------
// The GF(2) rank observation family grounds `observationUsed` exactly like the
// maximal-minor family: a labelled GF(2)-rank claim that contradicts the exact
// elimination opens one bounded closure turn, and a matching claim never does.
// ---------------------------------------------------------------------------

const GF2_RANK_PROBLEM = "求给定二元矩阵 M 在 GF(2) 上的秩。";

/** One literal `gf2_rank` action for the explicit bit-packed rows. */
function gf2RankAction(): string {
  return JSON.stringify({
    action: "tool",
    name: "gf2_rank",
    args: { rows: [1, 2, 4] },
    scope: "rank over GF(2) of the explicit bit-packed rows",
  });
}

/** One COMPLETE `gf2_rank` receipt: the payload is the bare integer rank 3. */
function gf2RankEffect(request: P3EffectRequest): P3EffectReceipt {
  const observation = JSON.stringify({
    tool: "gf2_rank",
    result: 3,
    interpretation: "OBSERVATION_NOT_PROOF",
  });
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "PROGRAM_OBSERVATION",
    observation,
    observationHash: p4Hash(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  };
}

async function runGf2Rank(options: {
  readonly candidate: string;
  readonly closureCandidate: string;
}) {
  let turn = 0;
  const ports = reactivePorts({
    work: (request: AgentModelRequest) => {
      turn += 1;
      if (request.messages[0]!.content.includes("ANSWER CLOSURE")) {
        return reactiveWork(request, { candidate: options.closureCandidate });
      }
      // The routed tool turn comes first; every later turn delivers a packet.
      if (turn === 1) return gf2RankAction();
      return reactiveWork(request, { candidate: options.candidate });
    },
    effect: gf2RankEffect,
  });
  const result = await runAgentLoop(
    GF2_RANK_PROBLEM,
    "s",
    {
      remainingMs: 8000,
      maxModelCalls: 12,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 1,
      maxConsensus: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  return { result, requests: ports.requests, rows: closureRowsOf(result) };
}

test("a GF(2) rank observation grounds observationUsed and is repaired", async () => {
  const run = await runGf2Rank({
    candidate: "该矩阵在 GF(2) 上的秩为 2",
    closureCandidate: "该矩阵在 GF(2) 上的秩为 3",
  });
  assert.equal(run.rows.length, 1, "exactly one closure evaluation");
  const row = run.rows[0]!;
  assert.equal(row.data["stage"], "ANSWER_CLOSURE");
  assert.deepEqual(row.data["defects"], ["GF2_RANK_MISMATCH"]);
  assert.equal(row.data["observationViews"], 1);
  assert.equal(row.data["observationUsed"], true, "the bare integer rank grounded it");
  assert.equal(row.data["closureRequested"], true, "one bounded closure turn was spent");
  assert.equal(row.data["candidateChanged"], true);
  assert.deepEqual(row.data["remainingDefects"], []);
  assert.equal(run.result.summary.finalResponse, "该矩阵在 GF(2) 上的秩为 3");
  assert.equal(run.result.summary.candidateVerified, false);
});

test("a GF(2) rank claim that matches the observed rank never grounds a defect", async () => {
  const run = await runGf2Rank({
    candidate: "该矩阵在 GF(2) 上的秩为 3",
    closureCandidate: "该矩阵在 GF(2) 上的秩为 3",
  });
  assert.equal(run.rows.length, 1, "the evaluation is logged even with no defect");
  const row = run.rows[0]!;
  assert.equal(row.data["stage"], "ANSWER_CLOSURE");
  assert.deepEqual(row.data["defects"], []);
  assert.equal(row.data["observationViews"], 1, "the observation really was recorded");
  assert.equal(row.data["observationUsed"], false);
  assert.equal(row.data["closureRequested"], false);
  assert.equal(row.data["candidateChanged"], false);
  assert.equal(run.result.summary.finalResponse, "该矩阵在 GF(2) 上的秩为 3");
});
