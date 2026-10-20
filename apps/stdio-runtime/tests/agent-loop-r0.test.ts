/**
 * G3/PR4 B1b — bounded R0 planning review at the real `runAgentLoop` level.
 *
 * DECISION-0150 ruling B1: with `maxR0=1` one R0 review runs before any WORK
 * (phase `R0`, no work task, shared root budget). A recorded `NO_ISSUE`
 * conclusion leaves the contract at version 1 and the run proceeds unchanged; a
 * recorded `ISSUES` conclusion attempts exactly one `reviseGoals` revision and,
 * if that revision is not certified (here an unparseable reply), falls back to
 * the fixed deterministic template — still sharing the same root budget, never
 * a second bump. Only the injected ports are fake; the real loop runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentModelRequest } from "@astra/protocol";

import { runAgentLoop } from "../src/agent-loop.js";
import { reactivePorts, reactiveWork, type ReactivePorts } from "./agent-loop-test-support.js";

const PROBLEM = "Prove that the sum of two even integers is even";

function portsOf(ports: ReactivePorts) {
  return { model: ports.model, effect: ports.effect };
}

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  return JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
}

function span(source: string) {
  return { start: 0, end: 1, quote: [...source][0] };
}

/** One literal `p4-r0-review-v1` report bound to the real R0 context. */
function r0ReviewReply(request: AgentModelRequest, conclusion: "NO_ISSUE" | "ISSUES"): string {
  const body = bodyOf(request);
  const problem = body.problemFullText as string;
  const plan = body.planText as string;
  const checks = ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"].map((dimension) => ({
    dimension,
    verdict: conclusion,
    rationale: "reviewed the initial template against the problem",
    problemSpan: span(problem),
    planSpan: span(plan),
  }));
  return JSON.stringify({
    schemaVersion: "p4-r0-review-v1",
    requestId: "model-1",
    stage: "R0",
    target: body.target,
    planHash: body.planHash,
    conclusion,
    reviewCoverage: body.reviewCoverage,
    checks,
  });
}

function r0Ports(conclusion: "NO_ISSUE" | "ISSUES", revisionReply?: string) {
  return reactivePorts({
    work: (request) => {
      if (request.phase !== "R0") {
        return reactiveWork(request);
      }
      const body = bodyOf(request);
      if (body.requestId === "model-1") {
        return r0ReviewReply(request, conclusion);
      }
      return revisionReply ?? "{ not a revision report";
    },
  });
}

test("B1 R0 NO_ISSUE runs before WORK and the run proceeds unchanged", async () => {
  const ports = r0Ports("NO_ISSUE");
  const result = await runAgentLoop(
    PROBLEM,
    "r0-no-issue",
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  assert.equal(ports.requests[0]?.phase, "R0");
  assert.equal(ports.requests[0]?.taskId, "r0");
  // The R0 review consumed model-1; the next call is the ordinary WORK.
  assert.equal(ports.requests[1]?.phase, "WORK");
  assert.ok(result.summary.status === "candidate" || result.summary.status === "unsolved");
});

test("B1 R0 ISSUES with an uncertified revision falls back to the fixed template", async () => {
  const ports = r0Ports("ISSUES");
  const result = await runAgentLoop(
    PROBLEM,
    "r0-issues-fallback",
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  // Both R0 model calls happened: the review (model-1) and the one revision
  // attempt (model-2). The uncertified revision did not crash the run.
  assert.equal(ports.requests[0]?.phase, "R0");
  assert.equal(ports.requests[1]?.phase, "R0");
  assert.ok(result.summary.status === "candidate" || result.summary.status === "unsolved");
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

/** One literal `p4-r0-plan-revision-v1` report bound to the real revision context. */
function r0RevisionReply(request: AgentModelRequest): string {
  const body = bodyOf(request);
  const leaves = body.allowedLeaves as readonly {
    readonly goalId: string;
    readonly kind: string;
    readonly goalJson: string;
  }[];
  const issueRows = body.issueRows as readonly { readonly dimension: string }[];
  const problem = body.problemFullText as string;
  const planText = body.planText as string;
  const leaf = leaves[0]!;
  const toKind = leaf.kind === "VALUE" ? "PROOF" : "VALUE";
  // The plan span must quote exactly the JSON of the old leaf goal, as a real
  // slice of the template plan text.
  const planSpanStart = planText.indexOf(leaf.goalJson);
  const planSpan = {
    start: planSpanStart,
    end: planSpanStart + [...leaf.goalJson].length,
    quote: leaf.goalJson,
  };
  return JSON.stringify({
    schemaVersion: "p4-r0-plan-revision-v1",
    requestId: "model-2",
    parent: body.parent,
    reviewHash: body.reviewHash,
    changes: [
      {
        goalId: leaf.goalId,
        fromKind: leaf.kind,
        toKind,
        issueDimension: issueRows[0]?.dimension ?? "PROBLEM_ALIGNMENT",
        rationale: "the initial template class is too narrow for the problem",
        problemSpan: { start: 0, end: 1, quote: [...problem][0] },
        planSpan,
      },
    ],
  });
}

test("B1 R0 ISSUES with a certified revision raises the contract to version 2", async () => {
  const ports = reactivePorts({
    work: (request) => {
      if (request.phase !== "R0") {
        return reactiveWork(request);
      }
      const body = bodyOf(request);
      return body.requestId === "model-1" ? r0ReviewReply(request, "ISSUES") : r0RevisionReply(request);
    },
  });
  const result = await runAgentLoop(
    PROBLEM,
    "r0-revision-v2",
    { remainingMs: 5000, maxModelCalls: 6, maxWorkUnits: 3, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  // The single bounded revision was certified: the contract advanced to v2 and
  // the run continued on it.
  assert.equal(ports.requests[0]?.phase, "R0");
  assert.equal(ports.requests[1]?.phase, "R0");
  assert.equal(result.privateState.contract.contractVersion, 2);
});
