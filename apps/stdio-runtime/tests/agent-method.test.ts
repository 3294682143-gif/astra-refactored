import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_HOST_LEGACY_VERSION,
  AGENT_HOST_VERSION,
  agentHostPayload,
  p4Hash,
  validateAgentHostManifest,
  validateLegacyAgentHostManifest,
  type AgentModelRequest,
  type AgentHostManifest,
  type P2MethodCatalog,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import { AgentHostFlow, type AgentHostIo } from "../src/agent-host-flow.js";
import {
  methodEffect,
  reactivePorts,
  reactiveWork,
  syntheticCatalog,
} from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";
const SESSION = "s";
const CATALOG = syntheticCatalog();
const METHOD_ID = "method-0";

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  const user = request.messages[1];
  assert.ok(user !== undefined);
  return JSON.parse(user.content) as Record<string, unknown>;
}

function methodReply(id = METHOD_ID): string {
  return JSON.stringify({ action: "method", id });
}

interface MethodRun {
  readonly catalogReads: number;
  readonly result: Awaited<ReturnType<typeof runAgentLoop>>;
  readonly requests: AgentModelRequest[];
  readonly effects: P3EffectRequest[];
}

async function runMethod(options: {
  readonly work?: (request: AgentModelRequest) => string;
  readonly effect?: (request: P3EffectRequest) => P3EffectReceipt;
  readonly catalog?: () => Promise<P2MethodCatalog>;
  readonly maxMethodLoads?: number;
  readonly maxEffects?: number;
  readonly maxModelCalls?: number;
  readonly maxWorkUnits?: number;
  readonly maxReviews?: number;
} = {}): Promise<MethodRun> {
  let catalogReads = 0;
  const ports = reactivePorts({
    work: options.work ?? ((request) => (request.requestId === "model-1" ? methodReply() : reactiveWork(request))),
    effect: options.effect ?? ((request) => methodEffect(request, CATALOG)),
  });
  const read = options.catalog ?? (async () => CATALOG);
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: options.maxModelCalls ?? 4,
      maxWorkUnits: options.maxWorkUnits ?? 2,
      maxEffects: options.maxEffects ?? 1,
      maxReviews: options.maxReviews ?? 1,
      maxMethodLoads: options.maxMethodLoads ?? 1,
      now: () => 0,
    },
    {
      model: ports.model,
      effect: ports.effect,
      catalog: {
        async read(remainingMs: number): Promise<P2MethodCatalog> {
          catalogReads += 1;
          return read();
        },
      },
    },
  );
  return { catalogReads, result, requests: ports.requests, effects: ports.effects };
}

test("enabled method load reaches WORK, second WORK and R2 with one shared effect", async () => {
  const run = await runMethod();
  assert.equal(run.catalogReads, 1);
  assert.equal(run.result.summary.modelCalls, 4);
  assert.equal(run.result.summary.effectCalls, 1);
  assert.equal(run.result.summary.workUnits, 2);
  assert.equal(run.result.summary.reviewCalls, 1);
  assert.equal(run.result.summary.catalogCalls, 1);
  assert.equal(run.result.summary.methodLoads, 1);
  assert.equal(run.result.summary.candidateVerified, false);
  assert.equal(run.result.summary.strictAcceptance, "NOT_PERFORMED");
  assert.deepEqual(
    run.requests.map((request) => request.requestId),
    ["model-1", "model-2", "model-3", "model-4"],
  );
  assert.equal(run.effects.length, 1);
  assert.equal(run.effects[0]!.action.action, "method");
  const second = bodyOf(run.requests[1]!);
  assert.equal(second["allowMethods"], true);
  const assets = second["methodAssets"] as readonly { readonly id: string }[];
  assert.equal(assets.length, 1);
  assert.equal(assets[0]!.id, METHOD_ID);
  const third = bodyOf(run.requests[2]!);
  assert.equal((third["methodAssets"] as readonly unknown[]).length, 1);
  assert.equal((third["toolObservations"] as readonly unknown[]).length, 0);
  assert.equal(run.result.privateState.session.pendingModel, null);
  assert.equal(run.result.privateState.session.pendingEffect, null);
});

test("defaults without a catalog port never read a catalog or load a method", async () => {
  const ports = reactivePorts({ work: () => methodReply() });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 1, now: () => 0 },
    { model: ports.model, effect: ports.effect },
  );
  assert.equal(result.summary.catalogCalls, 0);
  assert.equal(result.summary.methodLoads, 0);
  assert.equal(ports.effects.length, 0);
  assert.equal(result.summary.stopReason, "CONTROL_REJECTED");
});

test("a low effect cap disables the catalog read and the method load", async () => {
  const run = await runMethod({ maxEffects: 0 });
  assert.equal(run.catalogReads, 0);
  assert.equal(run.result.summary.catalogCalls, 0);
  assert.equal(run.result.summary.methodLoads, 0);
  assert.equal(run.effects.length, 0);
});

test("a repeated method id reuses the receipt without a second load", async () => {
  let work = 0;
  const run = await runMethod({
    work: (request) => {
      work += 1;
      return work <= 2 ? methodReply() : reactiveWork(request);
    },
    maxReviews: 0,
    maxWorkUnits: 1,
  });
  assert.equal(run.result.summary.methodLoads, 1);
  assert.equal(run.effects.length, 1);
  assert.equal(run.result.summary.modelCalls, 3);
  assert.equal(run.result.summary.workUnits, 1);
  assert.equal(run.result.summary.effectCalls, 1);
  assert.equal(run.result.summary.status, "candidate");
  const third = bodyOf(run.requests[2]!);
  const observations = third["toolObservations"] as readonly {
    readonly binding: { readonly sourceRequestId: string };
  }[];
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.binding.sourceRequestId, "model-1");
});

test("a second different method id is refused", async () => {
  let work = 0;
  const run = await runMethod({
    work: (request) => {
      work += 1;
      return work === 1 ? methodReply("method-0") : methodReply("method-1");
    },
  });
  assert.equal(run.result.summary.methodLoads, 1);
  assert.equal(run.effects.length, 1);
  assert.equal(run.result.summary.stopReason, "CONTROL_REJECTED");
});

test("a missing catalog degrades to an empty catalog and keeps working", async () => {
  const run = await runMethod({ catalog: async () => ({ version: "1.1.0", entries: [] }) });
  assert.equal(run.catalogReads, 1);
  assert.equal(run.result.summary.catalogCalls, 1);
  assert.equal(run.result.summary.methodLoads, 0);
  assert.equal(run.effects.length, 0);
  assert.equal(run.requests.length > 0, true);
});

test("a throwing catalog read degrades without a retry", async () => {
  const run = await runMethod({
    catalog: async () => {
      throw new Error("catalog unavailable");
    },
  });
  assert.equal(run.catalogReads, 1);
  assert.equal(run.result.summary.catalogCalls, 1);
  assert.equal(run.result.summary.methodLoads, 0);
  assert.equal(run.effects.length, 0);
});

for (const mode of ["hash", "title", "extra"] as const) {
  test(`a corrupted method asset (${mode}) is refused by the TS guard`, async () => {
    const run = await runMethod({
      effect: (request) => {
        const receipt = methodEffect(request, CATALOG);
        const parsed = JSON.parse(receipt.observation) as Record<string, unknown>;
        const asset = parsed["asset"] as Record<string, unknown>;
        if (mode === "hash") {
          asset["bodySha256"] = "0".repeat(64);
        } else if (mode === "title") {
          asset["title"] = "Forged title";
        } else {
          parsed["extra"] = true;
        }
        const observation = JSON.stringify(parsed);
        return { ...receipt, observation, observationHash: p4Hash(observation) };
      },
    });
    assert.equal(run.result.summary.modelCalls, 1);
    assert.equal(run.result.summary.effectCalls, 1);
    assert.equal(run.result.summary.methodLoads, 1);
    assert.equal(run.result.summary.stopReason, "STOPPED");
    assert.equal(run.result.privateState.session.pendingModel, null);
    assert.equal(run.result.privateState.session.pendingEffect, null);
  });
}

test("a legal method asset still completes after the corrupted controls", async () => {
  const run = await runMethod();
  assert.equal(run.result.summary.methodLoads, 1);
  assert.equal(run.result.summary.stopReason, "REVIEWS_COMPLETE");
  assert.equal(run.result.summary.status, "candidate");
});

test("a catalog read that spends the clock stops before any model call", async () => {
  let clock = 0;
  const ports = reactivePorts({
    work: (request) => (request.requestId === "model-1" ? methodReply() : reactiveWork(request)),
    effect: (request) => methodEffect(request, CATALOG),
  });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: 4,
      maxWorkUnits: 2,
      maxEffects: 1,
      maxReviews: 1,
      maxMethodLoads: 1,
      now: () => clock,
    },
    {
      model: ports.model,
      effect: ports.effect,
      catalog: {
        async read(): Promise<P2MethodCatalog> {
          clock = 5000;
          return CATALOG;
        },
      },
    },
  );
  assert.equal(result.summary.catalogCalls, 1);
  assert.equal(result.summary.modelCalls, 0);
  assert.equal(result.summary.methodLoads, 0);
  assert.equal(ports.requests.length, 0);
});

test("the frozen 1.2 manifest stays read-only and the live 1.3 profile is active", () => {
  const legacyPath = new URL(
    "../../../../packages/protocol/schema/agent-host.schema.json",
    import.meta.url,
  );
  const activePath = new URL(
    "../../../../packages/protocol/schema/agent-host-v13.schema.json",
    import.meta.url,
  );
  const legacy = validateLegacyAgentHostManifest(
    JSON.parse(readFileSync(legacyPath, "utf8")) as unknown,
  );
  assert.equal(legacy.protocolVersion, AGENT_HOST_LEGACY_VERSION);
  agentHostPayload(
    legacy,
    "session.stop",
    "result",
    {
      protocolVersion: AGENT_HOST_LEGACY_VERSION,
      sessionId: "s",
      stopped: true,
    },
    "s",
  );
  assert.throws(
    () => agentHostPayload(legacy, "method.load", "result", {}, "s"),
    (error: unknown) => error instanceof Error && error.message === "UNKNOWN_METHOD",
  );
  assert.throws(
    () => validateAgentHostManifest(legacy),
    (error: unknown) => error instanceof Error && error.message === "VERSION_MISMATCH",
  );
  const active = validateAgentHostManifest(
    JSON.parse(readFileSync(activePath, "utf8")) as unknown,
  );
  assert.equal(active.protocolVersion, AGENT_HOST_VERSION);
  assert.equal(AGENT_HOST_VERSION, "1.3-agent-loop-preview");
  assert.equal(AGENT_HOST_LEGACY_VERSION, "1.2-agent-loop-preview");
  assert.throws(
    () =>
      new AgentHostFlow(legacy as unknown as AgentHostManifest, {} as AgentHostIo),
    (error: unknown) => error instanceof Error && error.message === "FIELD_VALUE",
  );
});
