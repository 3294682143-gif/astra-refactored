/**
 * G3/PR4 S2 online closure in the unique main loop (`runAgentLoop`).
 *
 * One ALL_SOLUTIONS problem `x(x-1)=0`: the model first answers the answer
 * (EXHAUSTIVENESS) obligation with `{1}`, an independent R2 review raises a
 * missing-case challenge, and one evidence-triggered REPAIR call re-states the
 * answer. The protected candidate is replaced by `{0,1}` ONLY because a
 * Host-accepted checker observation (bound to the original problem) grounds the
 * revision; the valid `x=1` material is retained on the parent artifact.
 *
 * The injected ports are the only fake; the real contract/ledger/store, the R2
 * review session, the S2 repair call and the S3 `reviseCandidate` gate all run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Hash, type AgentModelRequest } from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  reactivePorts,
  reactiveTool,
  reactiveWork,
  type ReactivePortsOptions,
} from "./agent-loop-test-support.js";

const PROBLEM = "Find all real solutions x(x-1)=0";
const SESSION = "s";
const ANSWER_TASK = "goal-1:EXHAUSTIVENESS";

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  return JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
}

/** A review report that raises one missing-case challenge on the answer task. */
function issuesReview(request: AgentModelRequest): string {
  const body = bodyOf(request);
  const obligations = body.obligations as readonly { readonly obligationId: string }[];
  const answer = obligations.find((row) => row.obligationId === ANSWER_TASK);
  assert.ok(answer !== undefined, "the answer obligation must be reviewed");
  return JSON.stringify({
    schemaVersion: "p4-review-v1",
    requestId: request.requestId,
    target: body.target,
    targetHash: body.targetHash,
    stage: "R2",
    conclusion: "ISSUES",
    reviewCoverage: [answer.obligationId],
    issues: [
      {
        stepLocator: { start: 0, end: 4, quote: "Take" },
        suspectedIssue: "MISSING_CASE",
        rationale: "x=0 satisfies the zero product and was not reported",
        requestedCheck: "substitute x=0 into the original equation",
        obligationIds: [answer.obligationId],
      },
    ],
  });
}

interface Scenario {
  readonly firstCandidate: string;
  readonly revisedCandidate: string;
  readonly tool: boolean;
  /** Where the checker runs: on the candidate task, or on a foreign task. */
  readonly toolOnCandidateTask?: boolean;
}
function portsFor(scenario: Scenario) {
  let toolDone = false;
  const toolOnCandidate = scenario.toolOnCandidateTask ?? true;
  const options: ReactivePortsOptions = {
    effect: (request) => {
      const observation = JSON.stringify({ checked: "x=0 gives 0*(0-1)=0" });
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
    },
    work: (request) => {
      const body = bodyOf(request);
      if (request.phase === "REPAIR") {
        return reactiveWork(request, {
          candidate: scenario.revisedCandidate,
          claim: "the real solution set is {0,1}",
          derivation: "Split the zero product: x=0 or x=1.",
        });
      }
      const taskId = (body.task as Record<string, unknown>).taskId;
      const onAnswer = taskId === ANSWER_TASK;
      if (scenario.tool && !toolDone && onAnswer === toolOnCandidate) {
        toolDone = true;
        return reactiveTool();
      }
      if (onAnswer) {
        return reactiveWork(request, {
          candidate: scenario.firstCandidate,
          claim: "x=1 only",
          derivation: "Take the root x=1.",
        });
      }
      return reactiveWork(request, { candidate: null });
    },
    review: issuesReview,
  };
  return reactivePorts(options);
}

function portsOf(ports: ReturnType<typeof portsFor>) {
  return { model: ports.model, effect: ports.effect };
}

test("flagship: R2 challenge + Host checker evidence revises {1} -> {0,1} in the loop", async () => {
  const ports = portsFor({ firstCandidate: "{1}", revisedCandidate: "{0,1}", tool: true });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 8,
      maxEffects: 1,
      maxReviews: 1,
      maxRepairs: 1,
      now: () => 0,
    },
    portsOf(ports),
  );
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.finalResponse, "{0,1}");
  assert.equal(result.summary.reason, "REVISED_CANDIDATE");
  assert.equal(result.summary.stopReason, "REVISED_CANDIDATE");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
  assert.equal(result.summary.reviewCalls, 1);
  // The repair call really happened, as phase REPAIR.
  assert.equal(ports.requests.some((request) => request.phase === "REPAIR"), true);
  // The valid local `x=1` material is retained on the replaced parent artifact.
  const artifacts = result.privateState.artifacts as readonly {
    readonly artifact: {
      readonly artifactId: string;
      readonly envelope: { readonly taskId: string | null };
      readonly packet: { readonly candidateProposal: string | null } | null;
    };
  }[];
  const parent = artifacts.find((row) => row.artifact.envelope.taskId === ANSWER_TASK);
  assert.ok(parent !== undefined);
  assert.equal(parent.artifact.packet?.candidateProposal, "{1}");
  // S2 local repair transaction recorded on the private state.
  const tx = result.privateState.s2Transaction;
  assert.ok(tx !== null && tx !== undefined);
  assert.equal(tx!.supersededObligationIds.includes("goal-1:EXHAUSTIVENESS"), true);
  assert.equal(tx!.preservedObligationIds.includes("goal-1:EXHAUSTIVENESS"), false);
  assert.match(String(tx!.preservedParentArtifactId), /^artifact-\d+$/);
  // B1c: the M1 ledger records the local update of the affected answer task's
  // obligation as a truthful ARTIFACT_ACCEPTED structural event (no other
  // obligation/task is touched and nothing is accepted as a theorem).
  const events = result.privateState.events as readonly {
    readonly eventType: string;
    readonly taskId?: string;
    readonly obligationId?: string;
    readonly artifactId?: string;
  }[];
  const localRevision = events.find(
    (row) => row.eventType === "ARTIFACT_ACCEPTED" && row.taskId === ANSWER_TASK,
  );
  assert.ok(localRevision !== undefined);
  assert.equal(localRevision!.obligationId, "goal-1:EXHAUSTIVENESS");
  assert.equal(
    events.filter((row) => row.eventType === "ARTIFACT_ACCEPTED").length,
    1,
  );
});

test("no checker grounding means no replacement: the parent candidate stays", async () => {
  const ports = portsFor({ firstCandidate: "{1}", revisedCandidate: "{0,1}", tool: false });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 8,
      maxEffects: 1,
      maxReviews: 1,
      maxRepairs: 1,
      now: () => 0,
    },
    portsOf(ports),
  );
  // Without a Host-accepted checker observation there is no grounded basis, so
  // the R2 challenge never upgrades or replaces the protected candidate.
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.finalResponse, "{1}");
  assert.equal(result.summary.reason, "BEST_EFFORT_CANDIDATE");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
  assert.equal(ports.requests.some((request) => request.phase === "REPAIR"), false);
});

test("the revision path is opt-in: maxRepairs=0 keeps the pre-G3 behaviour", async () => {
  const ports = portsFor({ firstCandidate: "{1}", revisedCandidate: "{0,1}", tool: true });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 8,
      maxEffects: 1,
      maxReviews: 1,
      maxRepairs: 0,
      now: () => 0,
    },
    portsOf(ports),
  );
  assert.equal(result.summary.finalResponse, "{1}");
  assert.equal(result.summary.reason, "BEST_EFFORT_CANDIDATE");
  assert.equal(ports.requests.some((request) => request.phase === "REPAIR"), false);
});

test("E07: a checker bound to a foreign task cannot ground a revision (S1 refuses)", async () => {
  // The checker runs on a different task of the same goal scope. The M5 S1
  // original-problem mapping gate refuses it (the effect binding is not the
  // candidate task), so the challenge can never replace the candidate.
  const ports = portsFor({
    firstCandidate: "{1}",
    revisedCandidate: "{0,1}",
    tool: true,
    toolOnCandidateTask: false,
  });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 8,
      maxEffects: 1,
      maxReviews: 1,
      maxRepairs: 1,
      now: () => 0,
    },
    portsOf(ports),
  );
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.finalResponse, "{1}");
  assert.equal(result.summary.reason, "BEST_EFFORT_CANDIDATE");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(ports.requests.some((request) => request.phase === "REPAIR"), false);
  // The S1 gate did not record a structural match for the foreign checker.
  assert.equal(result.privateState.s1Assessment, null);
});

test("incomplete all-solutions completeness fails closed: {0} is never a grounded revision", async () => {
  // x(x^2-2)=0 has irrational roots, so its real solution set is not independently
  // determinable by the rational-only oracle: the completeness gate fails closed and
  // the incomplete {0} can never ground a REVISED_CANDIDATE (the parent is kept).
  const problem = "Find all real solutions x(x^2-2)=0";
  const ports = portsFor({ firstCandidate: "{0}", revisedCandidate: "{0}", tool: true });
  const result = await runAgentLoop(
    problem,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 8,
      maxEffects: 1,
      maxReviews: 1,
      maxRepairs: 1,
      now: () => 0,
    },
    portsOf(ports),
  );
  // The incomplete set never becomes a grounded revision: no REVISED_CANDIDATE, and the
  // released candidate stays unverified (BEST_EFFORT).
  assert.notEqual(result.summary.reason, "REVISED_CANDIDATE");
  assert.equal(result.summary.candidateVerified, false);
});
