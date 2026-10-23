/**
 * G3/PR4 B1b + HANDOFF §5 item 5 — the bounded R0 three-review stage at the
 * real `runAgentLoop` level.
 *
 * With `maxR0=1` three *independent* role reviews run before any WORK (phase
 * `R0`, no work task, shared root budget), one per role and each under its own
 * root request id, and a pure controller aggregates them. An aggregate
 * `NO_ISSUE` or `UNKNOWN` leaves the contract at version 1 and the run proceeds
 * unchanged; an aggregate `ISSUES` records exactly one revision proposal and
 * spends exactly one targeted recheck of the revised plan, applying the single
 * version bump only when that recheck is a usable `NO_ISSUE`. Every
 * inconclusive, unparseable or illegal path falls back to the fixed
 * deterministic template under the same root budget — never a second bump.
 * Only the injected ports are fake; the real loop runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentModelRequest, P4R0Role } from "@astra/protocol";

import { runAgentLoop } from "../src/agent-loop.js";
import { reactivePorts, reactiveWork, type ReactivePorts } from "./agent-loop-test-support.js";

const PROBLEM = "Prove that the sum of two even integers is even";
const ROLE_DIMENSION = {
  MEANING: "PROBLEM_ALIGNMENT",
  METHOD: "SCOPE",
  TASK_TOOL: "TASK_COVERAGE",
} as const;

function portsOf(ports: ReactivePorts) {
  return { model: ports.model, effect: ports.effect };
}

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  return JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
}

function span(source: string) {
  return { start: 0, end: 1, quote: [...source][0] };
}

/** Which R0 sub-stage one request payload belongs to, from its own schema. */
function r0StageOf(request: AgentModelRequest): "REVIEW" | "REVISION" | "RECHECK" | "WORK" {
  if (request.phase === "WORK") {
    return "WORK";
  }
  const schema = bodyOf(request).schemaVersion;
  if (schema === "p4-r0-review-context-v1") {
    return "REVIEW";
  }
  if (schema === "p4-r0-revision-context-v1") {
    return "REVISION";
  }
  if (schema === "p4-r0-recheck-context-v1") {
    return "RECHECK";
  }
  return "WORK";
}

/** One literal role-scoped `p4-r0-review-v1` report bound to the real context. */
function r0ReviewReply(
  request: AgentModelRequest,
  verdict: "NO_ISSUE" | "ISSUES" | "UNKNOWN",
): string {
  const body = bodyOf(request);
  const problem = body.problemFullText as string;
  const plan = body.planText as string;
  const role = body.role as P4R0Role;
  const dimension = (body.dimensions as readonly string[])[0]!;
  assert.equal(dimension, ROLE_DIMENSION[role]);
  return JSON.stringify({
    schemaVersion: "p4-r0-review-v1",
    requestId: body.requestId,
    stage: "R0",
    role,
    target: body.target,
    planHash: body.planHash,
    conclusion: verdict,
    reviewCoverage: body.reviewCoverage,
    checks: [
      {
        dimension,
        verdict,
        rationale: `reviewed ${role} against the problem`,
        problemSpan: span(problem),
        planSpan: span(plan),
      },
    ],
  });
}

/** One literal `p4-r0-recheck-v1` reply bound to the real recheck context. */
function r0RecheckReply(
  request: AgentModelRequest,
  conclusion: "NO_ISSUE" | "ISSUES",
): string {
  const body = bodyOf(request);
  const problem = body.problemFullText as string;
  const plan = body.planText as string;
  return JSON.stringify({
    schemaVersion: "p4-r0-recheck-v1",
    requestId: "model-3",
    stage: "R0_RECHECK",
    parent: body.parent,
    target: body.target,
    reviewHash: body.reviewHash,
    revisionHash: body.revisionHash,
    conclusion,
    reviewCoverage: body.reviewCoverage,
    checks: ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"].map((dimension) => ({
      dimension,
      verdict: conclusion,
      rationale: "rechecked the revised plan",
      problemSpan: span(problem),
      planSpan: span(plan),
    })),
  });
}

/** One literal certified `p4-r0-plan-revision-v1` reply for the real context. */
function r0RevisionReply(request: AgentModelRequest): string {
  const body = bodyOf(request);
  const leaf = (body.allowedLeaves as readonly {
    readonly goalId: string;
    readonly kind: string;
    readonly goalJson: string;
  }[])[0]!;
  const planText = body.planText as string;
  const planStart = planText.indexOf(leaf.goalJson);
  return JSON.stringify({
    schemaVersion: "p4-r0-plan-revision-v1",
    requestId: "model-2",
    parent: body.parent,
    reviewHash: body.reviewHash,
    changes: [
      {
        goalId: leaf.goalId,
        fromKind: leaf.kind,
        toKind: leaf.kind === "VALUE" ? "PROOF" : "VALUE",
        issueDimension: (body.issueRows as readonly { readonly dimension: string }[])[0]!.dimension,
        rationale: "the initial template class is too narrow for the problem",
        problemSpan: span(body.problemFullText as string),
        planSpan: {
          start: planStart,
          end: planStart + [...leaf.goalJson].length,
          quote: leaf.goalJson,
        },
      },
    ],
  });
}

/** Per-role verdicts and recheck conclusion of one scripted run. */
interface Script {
  readonly verdicts: Readonly<Record<P4R0Role, "NO_ISSUE" | "ISSUES" | "UNKNOWN">>;
  readonly recheck?: "NO_ISSUE" | "ISSUES";
  readonly revision?: "CERTIFIED" | "UNUSABLE";
}

function r0Ports(script: Script) {
  return reactivePorts({
    work: (request) => {
      const stage = r0StageOf(request);
      if (stage === "WORK") {
        return reactiveWork(request);
      }
      if (stage === "REVIEW") {
        const role = bodyOf(request).role as P4R0Role;
        return r0ReviewReply(request, script.verdicts[role]);
      }
      if (stage === "REVISION") {
        return script.revision === "CERTIFIED" ? r0RevisionReply(request) : "{ not a revision report";
      }
      return r0RecheckReply(request, script.recheck ?? "NO_ISSUE");
    },
  });
}

const NO_ISSUE_ALL: Script = {
  verdicts: { MEANING: "NO_ISSUE", METHOD: "NO_ISSUE", TASK_TOOL: "NO_ISSUE" },
};

test("B1 three role reviews run in fixed order before WORK under distinct ids", async () => {
  const ports = r0Ports(NO_ISSUE_ALL);
  const result = await runAgentLoop(
    PROBLEM,
    "r0-three-roles",
    { remainingMs: 5000, maxModelCalls: 5, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  const r0Requests = ports.requests.filter((request) => request.phase === "R0");
  assert.equal(r0Requests.length, 3);
  // Fixed order, three separate calls, three different root request ids.
  assert.deepEqual(
    r0Requests.map((request) => bodyOf(request).role),
    ["MEANING", "METHOD", "TASK_TOOL"],
  );
  assert.deepEqual(
    r0Requests.map((request) => request.requestId),
    ["model-1", "model-2", "model-3"],
  );
  assert.equal(new Set(r0Requests.map((request) => request.contextHash)).size, 3);
  // Role-scoped prompts: each reviewer sees only its own dimension.
  for (const request of r0Requests) {
    const body = bodyOf(request);
    const role = body.role as P4R0Role;
    assert.deepEqual(body.dimensions, [ROLE_DIMENSION[role]]);
    for (const [otherRole, dimension] of Object.entries(ROLE_DIMENSION)) {
      if (otherRole === role) {
        assert.match(request.messages[0]!.content, new RegExp(dimension));
      } else {
        assert.doesNotMatch(request.messages[0]!.content, new RegExp(dimension));
      }
    }
  }
  // A NO_ISSUE aggregate leaves the contract at version 1 and runs WORK next.
  assert.equal(ports.requests[3]?.phase, "WORK");
  assert.equal(result.privateState.contract.contractVersion, 1);
  assert.ok(result.summary.status === "candidate" || result.summary.status === "unsolved");
});

test("B1 the stage is auditable: one R0_REVIEW row per role and one aggregate", async () => {
  const ports = r0Ports({
    verdicts: { MEANING: "NO_ISSUE", METHOD: "ISSUES", TASK_TOOL: "UNKNOWN" },
    revision: "UNUSABLE",
  });
  const result = await runAgentLoop(
    PROBLEM,
    "r0-audit-rows",
    { remainingMs: 5000, maxModelCalls: 5, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  const rows = (result.privateState.sessionLog?.events ?? []).filter(
    (event) => event.kind === "R0_REVIEW",
  );
  assert.equal(rows.length, 4);
  const roleRows = rows.slice(0, 3);
  assert.deepEqual(
    roleRows.map((row) => row.data.role),
    ["MEANING", "METHOD", "TASK_TOOL"],
  );
  assert.deepEqual(
    roleRows.map((row) => row.data.requestId),
    ["model-1", "model-2", "model-3"],
  );
  assert.deepEqual(
    roleRows.map((row) => row.data.dimension),
    ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"],
  );
  assert.deepEqual(
    roleRows.map((row) => row.data.verdict),
    ["NO_ISSUE", "ISSUES", "UNKNOWN"],
  );
  assert.deepEqual(
    roleRows.map((row) => row.data.issueCount),
    [0, 1, 0],
  );
  const aggregate = rows[3]!;
  assert.equal(aggregate.data.role, "AGGREGATE");
  assert.equal(aggregate.data.conclusion, "ISSUES");
  assert.deepEqual(aggregate.data.issueDimensions, ["SCOPE"]);
  assert.deepEqual(aggregate.data.dissents, [
    { role: "MEANING", dimension: "PROBLEM_ALIGNMENT", verdict: "NO_ISSUE" },
    { role: "TASK_TOOL", dimension: "TASK_COVERAGE", verdict: "UNKNOWN" },
  ]);
  // No raw model text is ever copied into the stage audit rows.
  for (const row of rows) {
    assert.equal(JSON.stringify(row.data).includes("reviewed"), false);
    assert.equal(JSON.stringify(row.data).includes("rationale"), false);
  }
});

test("B1 an UNKNOWN role blocks the aggregate without any recheck", async () => {
  const ports = r0Ports({
    verdicts: { MEANING: "NO_ISSUE", METHOD: "UNKNOWN", TASK_TOOL: "NO_ISSUE" },
  });
  await runAgentLoop(
    PROBLEM,
    "r0-unknown-role",
    { remainingMs: 5000, maxModelCalls: 5, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  const stages = ports.requests.map((request) => r0StageOf(request));
  assert.equal(stages.filter((stage) => stage === "REVIEW").length, 3);
  // No revision and no recheck on an inconclusive aggregate.
  assert.equal(stages.includes("REVISION"), false);
  assert.equal(stages.includes("RECHECK"), false);
});

test("B1 ISSUES spends one recheck; an uncertified revision still falls back", async () => {
  const ports = r0Ports({
    verdicts: { MEANING: "ISSUES", METHOD: "NO_ISSUE", TASK_TOOL: "NO_ISSUE" },
    revision: "UNUSABLE",
  });
  const result = await runAgentLoop(
    PROBLEM,
    "r0-issues-fallback",
    { remainingMs: 5000, maxModelCalls: 5, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  const stages = ports.requests.map((request) => r0StageOf(request));
  assert.equal(stages.filter((stage) => stage === "REVIEW").length, 3);
  // Exactly one revision proposal; an unusable proposal is never rechecked.
  assert.equal(stages.filter((stage) => stage === "REVISION").length, 1);
  assert.equal(stages.filter((stage) => stage === "RECHECK").length, 0);
  assert.equal(result.privateState.contract.contractVersion, 1);
  assert.ok(result.summary.status === "candidate" || result.summary.status === "unsolved");
});

test("B1 a certified revision is applied only after a NO_ISSUE recheck", async () => {
  const ports = r0Ports({
    verdicts: { MEANING: "ISSUES", METHOD: "NO_ISSUE", TASK_TOOL: "NO_ISSUE" },
    revision: "CERTIFIED",
    recheck: "NO_ISSUE",
  });
  const result = await runAgentLoop(
    PROBLEM,
    "r0-revision-v2",
    // A budget larger than the bare stage minimum, so the recheck preparation
    // is not accidentally exercised only at its pinned two-call view.
    { remainingMs: 5000, maxModelCalls: 8, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  const stages = ports.requests.map((request) => r0StageOf(request));
  assert.deepEqual(stages.slice(0, 5), ["REVIEW", "REVIEW", "REVIEW", "REVISION", "RECHECK"]);
  // Exactly one recheck and exactly one revision, ever.
  assert.equal(stages.filter((stage) => stage === "RECHECK").length, 1);
  assert.equal(stages.filter((stage) => stage === "REVISION").length, 1);
  // The recheck dispatched under the recheck phase and its own root id.
  const recheckRequest = ports.requests.find((request) => r0StageOf(request) === "RECHECK")!;
  assert.equal(recheckRequest.phase, "R0_RECHECK");
  assert.equal(recheckRequest.requestId, "model-5");
  assert.equal(bodyOf(recheckRequest).stage, "R0_RECHECK");
  // The single bounded revision was certified by the recheck: contract v2.
  assert.equal(result.privateState.contract.contractVersion, 2);
});

test("B1 a recheck that still reports ISSUES never applies the revision", async () => {
  const ports = r0Ports({
    verdicts: { MEANING: "ISSUES", METHOD: "NO_ISSUE", TASK_TOOL: "NO_ISSUE" },
    revision: "CERTIFIED",
    recheck: "ISSUES",
  });
  const result = await runAgentLoop(
    PROBLEM,
    "r0-recheck-issues",
    { remainingMs: 5000, maxModelCalls: 5, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  const stages = ports.requests.map((request) => r0StageOf(request));
  assert.equal(stages.filter((stage) => stage === "RECHECK").length, 1);
  assert.equal(stages.filter((stage) => stage === "REVISION").length, 1);
  assert.equal(result.privateState.contract.contractVersion, 1);
});

test("B1 a root budget below the five-call stage spends zero model calls", async () => {
  for (const maxModelCalls of [1, 2, 3, 4]) {
    const ports = r0Ports(NO_ISSUE_ALL);
    const result = await runAgentLoop(
      PROBLEM,
      `r0-budget-${maxModelCalls}`,
      {
        remainingMs: 5000,
        maxModelCalls,
        maxWorkUnits: 2,
        maxEffects: 0,
        maxReviews: 0,
        maxR0: 1,
      },
      portsOf(ports),
    );
    // No R0 call at all: the stage is refused before the first dispatch.
    assert.equal(ports.requests.filter((request) => request.phase === "R0").length, 0);
    assert.equal(ports.requests.filter((request) => request.phase === "R0_RECHECK").length, 0);
    assert.equal(result.privateState.contract.contractVersion, 1);
  }
});

test("B1 R0 is inert by default (maxR0 omitted)", async () => {
  const ports = reactivePorts();
  const result = await runAgentLoop(
    PROBLEM,
    "r0-off",
    { remainingMs: 5000, maxModelCalls: 5, maxWorkUnits: 4, maxEffects: 0, maxReviews: 0 },
    portsOf(ports),
  );
  assert.equal(ports.requests[0]?.phase, "WORK");
  assert.equal(result.summary.status, "candidate");
});

test("B1 R0 is inert with maxR0=0 and the run matches the plain path", async () => {
  const off = reactivePorts();
  const offResult = await runAgentLoop(
    PROBLEM,
    "r0-zero",
    { remainingMs: 5000, maxModelCalls: 5, maxWorkUnits: 4, maxEffects: 0, maxReviews: 0, maxR0: 0 },
    portsOf(off),
  );
  const plain = reactivePorts();
  const plainResult = await runAgentLoop(
    PROBLEM,
    "r0-zero",
    { remainingMs: 5000, maxModelCalls: 5, maxWorkUnits: 4, maxEffects: 0, maxReviews: 0 },
    portsOf(plain),
  );
  assert.deepEqual(
    off.requests.map((request) => request.requestId),
    plain.requests.map((request) => request.requestId),
  );
  assert.equal(off.requests.some((request) => request.phase === "R0"), false);
  assert.equal(offResult.summary.status, plainResult.summary.status);
  assert.deepEqual(
    offResult.privateState.session.events.map((row) => row.code),
    plainResult.privateState.session.events.map((row) => row.code),
  );
});

test("B1 an unusable review is never fabricated into a verdict", async () => {
  // The second review reply is unusable: that role settles UNKNOWN and the
  // aggregate stays inconclusive without any revision or recheck.
  let reviewCalls = 0;
  const ports = reactivePorts({
    work: (request) => {
      const stage = r0StageOf(request);
      if (stage === "WORK") {
        return reactiveWork(request);
      }
      reviewCalls += 1;
      return reviewCalls === 2
        ? "{ not a review report"
        : r0ReviewReply(request, "NO_ISSUE");
    },
  });
  const result = await runAgentLoop(
    PROBLEM,
    "r0-unusable-review",
    { remainingMs: 5000, maxModelCalls: 5, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  const stages = ports.requests.map((request) => r0StageOf(request));
  assert.equal(stages.filter((stage) => stage === "REVIEW").length, 3);
  assert.equal(stages.includes("REVISION"), false);
  assert.equal(stages.includes("RECHECK"), false);
  assert.equal(result.privateState.contract.contractVersion, 1);
});
