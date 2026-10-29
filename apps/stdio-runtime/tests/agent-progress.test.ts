import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type AgentModelRequest,
  type P2Task,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  reactivePorts,
  reactiveTool,
  reactiveWork,
} from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";
const SESSION = "s";

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  const user = request.messages[1];
  assert.ok(user !== undefined);
  return JSON.parse(user.content) as Record<string, unknown>;
}

function taskOf(request: AgentModelRequest): P2Task {
  return bodyOf(request)["task"] as P2Task;
}

function unsolvedReply(): string {
  return JSON.stringify({ action: "unsolved", reason: "no route" });
}

interface ProgressRun {
  readonly result: Awaited<ReturnType<typeof runAgentLoop>>;
  readonly requests: AgentModelRequest[];
  readonly effects: P3EffectRequest[];
}

async function runProgress(options: {
  readonly work: (request: AgentModelRequest) => string;
  readonly effect?: (request: P3EffectRequest) => P3EffectReceipt;
}): Promise<ProgressRun> {
  const ports = reactivePorts(
    options.effect === undefined
      ? { work: options.work }
      : { work: options.work, effect: options.effect },
  );
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: 8,
      maxWorkUnits: 4,
      maxEffects: 1,
      maxReviews: 0,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  return { result, requests: ports.requests, effects: ports.effects };
}

function workRequests(requests: readonly AgentModelRequest[]): AgentModelRequest[] {
  return requests.filter((request) => request.phase === "WORK");
}

function assertYielded(
  run: ProgressRun,
  reason: string,
  sourceRequestId: string,
): void {
  const events = run.result.privateState.events;
  const yielded = events.filter((row) => row.eventType === "TASK_YIELDED");
  assert.equal(yielded.length, 1);
  assert.equal(yielded[0]!.eventSchemaVersion, "p2-task-progress-v1");
  assert.equal(yielded[0]!.yieldReason, reason);
  assert.equal(yielded[0]!.sourceRequestId, sourceRequestId);
  const progress = run.result.privateState.progressEvents ?? [];
  assert.equal(progress.length, 1);
  assert.equal(progress[0]!.reason, reason);
  assert.equal(progress[0]!.sourceRequestId, sourceRequestId);
  assert.equal(progress[0]!.taskId, yielded[0]!.taskId);
  const tasks = run.result.privateState.contract.tasks;
  const first = tasks.find((row) => row.taskId === yielded[0]!.taskId);
  assert.ok(first !== undefined);
  assert.equal(first.delivery, "BLOCKED");
  const others = tasks.filter((row) => row.taskId !== yielded[0]!.taskId);
  assert.ok(others.some((row) => row.delivery === "DELIVERED"));
  for (const row of others) {
    assert.notEqual(row.delivery, "BLOCKED");
  }
  const obligation = run.result.privateState.contract.obligations.find(
    (row) => row.obligationId === first.obligationId,
  );
  assert.ok(obligation !== undefined);
  assert.notEqual(obligation.status, "BLOCKED");
  assert.notEqual(obligation.status, "SATISFIED");
}

test("an unsolved action is refused once and the retry delivers", async () => {
  const run = await runProgress({
    work: (request) =>
      request.requestId === "model-1" ? unsolvedReply() : reactiveWork(request),
  });
  // An abstention on a readable task is strictly worse than a wrong
  // best-effort candidate, so the first unsolved action is refused with one
  // extra WORK turn and the retry's answer is delivered. Nothing is yielded.
  const refused = (run.result.privateState.sessionLog?.events ?? []).filter(
    (event) => event.kind === "CONSENSUS" && event.data["stage"] === "UNSOLVED_REFUSAL",
  );
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.data["requestId"], "model-1");
  assert.equal(refused[0]!.data["accepted"], false);
  const yielded = run.result.privateState.events.filter(
    (row) => row.eventType === "TASK_YIELDED",
  );
  assert.equal(yielded.length, 0, "a refused abstention never yields the task");
  // The retry really saw the refusal note and the same user payload.
  const retry = run.requests.find((request) => request.requestId === "model-2");
  assert.ok(retry !== undefined);
  assert.equal(retry.messages[0]!.content.includes("UNSOLVED REFUSED"), true);
  const first = run.requests.find((request) => request.requestId === "model-1");
  assert.ok(first !== undefined);
  // Only the request id that binds each turn differs; the recorded user payload
  // is otherwise byte-identical, so the Host context check is unaffected.
  const payloadOf = (request: AgentModelRequest): Record<string, unknown> => {
    const body = bodyOf(request);
    delete body["sourceRequestId"];
    return body;
  };
  assert.deepEqual(payloadOf(retry), payloadOf(first));
});

test("a second unsolved action is accepted and yields the task", async () => {
  let unsolveds = 0;
  const run = await runProgress({
    work: (request) => {
      if (unsolveds < 2) {
        const current = request.requestId;
        // The first answer of each task abstains; the refusal retry does too.
        if (current === "model-1" || current === "model-2") {
          unsolveds += 1;
          return unsolvedReply();
        }
      }
      return reactiveWork(request);
    },
  });
  // The refusal is bounded: after it, the next unsolved action is honoured.
  const refused = (run.result.privateState.sessionLog?.events ?? []).filter(
    (event) => event.kind === "CONSENSUS" && event.data["stage"] === "UNSOLVED_REFUSAL",
  );
  assert.ok(refused.length >= 1);
  const yielded = run.result.privateState.events.filter(
    (row) => row.eventType === "TASK_YIELDED",
  );
  assert.ok(yielded.length >= 1, "the second abstention is accepted");
  assert.equal(yielded[0]!.yieldReason, "UNSOLVED");
});

test("a legal partial packet yields and keeps its own artifact", async () => {
  const run = await runProgress({
    work: (request) => {
      if (request.requestId !== "model-1") {
        return reactiveWork(request);
      }
      const packet = JSON.parse(reactiveWork(request)) as Record<string, unknown>;
      packet["deliveryStatus"] = "INCOMPLETE";
      return JSON.stringify(packet);
    },
  });
  assert.equal(run.result.summary.modelCalls, 3);
  assert.equal(run.result.summary.workUnits, 3);
  assert.equal(run.result.summary.effectCalls, 0);
  const works = workRequests(run.requests);
  assert.equal(works.length, 3);
  assert.notEqual(taskOf(works[0]!).taskId, taskOf(works[1]!).taskId);
  const artifacts = run.result.privateState.artifacts as readonly {
    readonly artifact: {
      readonly artifactId: string;
      readonly deliveryStatus: string;
    };
  }[];
  const partial = artifacts.find((row) => row.artifact.artifactId === "artifact-1");
  assert.ok(partial !== undefined);
  assert.equal(partial.artifact.deliveryStatus, "INCOMPLETE");
  const next = taskOf(works[1]!);
  assert.equal(
    next.inputArtifactRefs.some((ref) => ref.artifactId === "artifact-1"),
    false,
  );
  assertYielded(run, "PARTIAL", "model-1");
});

test("a second consecutive cached repeat yields and the next task works", async () => {
  // The single effect is spent by model-1, so every later tool reply is served
  // from the cache; the second identical cached request yields the task, and the
  // remaining ready tasks keep working after it.
  const run = await runProgress({
    work: (request) =>
      ["model-1", "model-2", "model-3"].includes(request.requestId)
        ? reactiveTool()
        : reactiveWork(request),
  });
  assert.equal(run.result.summary.modelCalls, 5);
  assert.equal(run.result.summary.workUnits, 2);
  assert.equal(run.result.summary.effectCalls, 1);
  const works = workRequests(run.requests);
  assert.equal(works.length, 5);
  assert.notEqual(taskOf(works[2]!).taskId, taskOf(works[3]!).taskId);
  assert.deepEqual(bodyOf(works[3]!)["toolObservations"], []);
  assertYielded(run, "REPEATED_EFFECT", "model-3");
});
