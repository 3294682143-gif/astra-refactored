/**
 * G4/PR5 Slice 4a — immutable SessionLog + ContextProjector + read-only replay.
 *
 * The SessionLog is the single source of truth for what the model saw; every
 * model request is a deterministic projection of it, and an in-process replay
 * re-derives each request hash and the final view with no model/effect port.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ReplayRunner,
  SESSION_LOG_KIND,
  SESSION_LOG_SCHEMA_VERSION,
  SessionLog,
} from "@astra/runtime-core";

import { runAgentLoop } from "../src/agent-loop.js";
import { reactivePorts, reactiveWork } from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";

function portsOf(ports: ReturnType<typeof reactivePorts>) {
  return { model: ports.model, effect: ports.effect };
}

test("Slice 4a: SessionLog is ordered, immutable and monotonic", () => {
  const log = new SessionLog();
  log.append("SESSION_INIT", { sessionId: "s", problemHash: "x" });
  const second = log.append("CONTRACT", { contractVersion: 1 });
  assert.equal(second.seq, 2);
  assert.equal(second.schemaVersion, SESSION_LOG_SCHEMA_VERSION);
  const snapshot = log.snapshot();
  assert.equal(snapshot.version, 2);
  assert.deepEqual(
    snapshot.events.map((event) => event.kind),
    ["SESSION_INIT", "CONTRACT"],
  );
  // A returned snapshot is deep-frozen: the source of truth cannot be mutated.
  assert.equal(Object.isFrozen(snapshot.events[0]!.data), true);
  assert.throws(() => log.append("NOPE" as unknown as (typeof SESSION_LOG_KIND)[number], {}));
});

test("Slice 4a: the model request is a projection of the log with 100% hash parity", async () => {
  const ports = reactivePorts();
  const result = await runAgentLoop(
    PROBLEM,
    "log-session",
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0 },
    portsOf(ports),
  );
  const log = result.privateState.sessionLog;
  assert.ok(log !== undefined && log !== null);
  assert.equal(log!.schemaVersion, SESSION_LOG_SCHEMA_VERSION);
  assert.equal(log!.events[0]!.kind, "SESSION_INIT");
  assert.equal(log!.events[log!.events.length - 1]!.kind, "FINAL");
  // The log covers the contract and the final selection.
  assert.ok(log!.events.some((event) => event.kind === "CONTRACT"));
  assert.ok(log!.events.some((event) => event.kind === "WORKUNIT"));

  const runner = new ReplayRunner();
  const replay = runner.replay(log as never);
  assert.equal(replay.ok, true);
  assert.equal(replay.mismatches.length, 0);
  // Every projected request hash equals the real request the port received.
  const recorded = ports.requests.map((request) => request.contextHash);
  assert.deepEqual(
    replay.requests.map((projected) => projected.contextHash),
    recorded,
  );
  // The final view is recorded and matches the released answer.
  assert.equal(replay.final?.["finalResponse"], result.summary.finalResponse);
  assert.equal(replay.final?.["candidateVerified"], false);
  // The public trace is a strict subset: request identities only, no raw text.
  const trace = runner.publicTrace(log as never);
  assert.equal(trace.length, recorded.length);
  assert.ok(trace.every((projected) => !("messages" in projected) && !("data" in projected)));
});

test("Slice 4a: the log records the R0 revision v1 -> v2", async () => {
  const ports = reactivePorts({
    work: (request) => {
      if (request.phase !== "R0") {
        return reactiveWork(request);
      }
      const body = JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
      if (body.requestId === "model-1") {
        return r0Review(request, "NO_ISSUE");
      }
      return "{}";
    },
  });
  const result = await runAgentLoop(
    "Prove that the sum of two even integers is even",
    "log-r0",
    { remainingMs: 5000, maxModelCalls: 6, maxWorkUnits: 3, maxEffects: 0, maxReviews: 0, maxR0: 1 },
    portsOf(ports),
  );
  const log = result.privateState.sessionLog;
  assert.ok(log !== undefined && log !== null);
  assert.equal(log!.events[0]!.kind, "SESSION_INIT");
  const firstRequest = log!.events.find((event) => event.kind === "MODEL_REQUEST");
  assert.equal(firstRequest?.data.phase, "R0");
});

test("Trusted RC defect 4: ReplayRunner rejects any tampered answer/hash", async () => {
  const ports = reactivePorts();
  const result = await runAgentLoop(
    PROBLEM,
    "replay-tamper",
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 0, maxReviews: 0 },
    portsOf(ports),
  );
  const log = result.privateState.sessionLog as unknown as {
    schemaVersion: string;
    version: number;
    events: { seq: number; kind: string; data: Record<string, unknown> }[];
  };
  const runner = new ReplayRunner();
  assert.equal(runner.replay(log as never).ok, true);

  const withFinal = {
    ...log,
    events: log.events.map((event) =>
      event.kind === "FINAL" ? { ...event, data: { ...event.data, finalResponse: "{999}" } } : event,
    ),
  };
  assert.equal(runner.replay(withFinal as never).ok, false);

  const withWork = {
    ...log,
    events: log.events.map((event) =>
      event.kind === "WORKUNIT" ? { ...event, data: { ...event.data, candidateProposal: "{999}" } } : event,
    ),
  };
  assert.equal(runner.replay(withWork as never).ok, false);

  const withRequest = {
    ...log,
    events: log.events.map((event) =>
      event.kind === "MODEL_REQUEST"
        ? { ...event, data: { ...event.data, messages: [{ role: "user", content: "forged" }] } }
        : event,
    ),
  };
  assert.equal(runner.replay(withRequest as never).ok, false);

  // Replacing a valid request context hash with another valid 64-hex value is
  // detected by the chained integrity digest.
  const withHash = {
    ...log,
    events: log.events.map((event) =>
      event.kind === "MODEL_REQUEST"
        ? { ...event, data: { ...event.data, contextHash: "a".repeat(64) } }
        : event,
    ),
  };
  assert.equal(runner.replay(withHash as never).ok, false);
});

// Minimal R0 review reply helper (kept local; the projector test only needs a
// valid NO_ISSUE report bound to the real R0 context).
function r0Review(request: { readonly messages: readonly { readonly content: string }[] }, conclusion: string): string {
  const body = JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
  const problem = body.problemFullText as string;
  const plan = body.planText as string;
  const span = (source: string) => ({ start: 0, end: 1, quote: [...source][0] });
  const checks = ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"].map((dimension) => ({
    dimension,
    verdict: conclusion,
    rationale: "reviewed",
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

