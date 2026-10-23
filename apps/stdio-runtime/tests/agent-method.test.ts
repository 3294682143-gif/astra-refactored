import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_HOST_LEGACY_VERSION,
  AGENT_HOST_VERSION,
  agentHostPayload,
  checkedP2MethodRoutingMetadata,
  p4Hash,
  validateAgentHostManifest,
  validateLegacyAgentHostManifest,
  type AgentModelRequest,
  type AgentHostManifest,
  type P2MethodCatalog,
  type P2MethodEntry,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { p3MethodCatalog } from "@astra/runtime-core";
import { runAgentLoop } from "../src/agent-loop.js";
import { semanticMethodRoute } from "../src/agent-semantics.js";
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
  readonly activeCatalog?: P2MethodCatalog;
  readonly problem?: string;
  readonly maxMethodLoads?: number;
  readonly maxEffects?: number;
  readonly maxModelCalls?: number;
  readonly maxWorkUnits?: number;
  readonly maxReviews?: number;
  readonly maxConsensus?: number;
} = {}): Promise<MethodRun> {
  let catalogReads = 0;
  const activeCatalog = options.activeCatalog ?? CATALOG;
  const ports = reactivePorts({
    work: options.work ?? ((request) => (request.requestId === "model-1" ? methodReply() : reactiveWork(request))),
    effect: options.effect ?? ((request) => methodEffect(request, activeCatalog)),
  });
  const read = options.catalog ?? (async () => activeCatalog);
  const result = await runAgentLoop(
    options.problem ?? PROBLEM,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: options.maxModelCalls ?? 4,
      maxWorkUnits: options.maxWorkUnits ?? 2,
      maxEffects: options.maxEffects ?? 1,
      maxReviews: options.maxReviews ?? 1,
      maxMethodLoads: options.maxMethodLoads ?? 1,
      maxConsensus: options.maxConsensus ?? 0,
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

test("G7/PR7 7e: a loaded method card is bound through one scoped methodCards call", async () => {
  const ports = reactivePorts({
    work: (request: AgentModelRequest) =>
      request.requestId === "model-1" ? methodReply() : reactiveWork(request),
    effect: (request: P3EffectRequest) => methodEffect(request, CATALOG),
  });
  const assetCalls: Record<string, unknown>[] = [];
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
      now: () => 0,
    },
    {
      model: ports.model,
      effect: ports.effect,
      catalog: {
        async read(): Promise<P2MethodCatalog> {
          return CATALOG;
        },
      },
      asset: {
        async call(request: unknown) {
          const row = request as Record<string, unknown>;
          assetCalls.push(row);
          return {
            group: row["group"],
            assetId: row["assetId"],
            scopeId: row["scopeId"],
            contractVersion: row["contractVersion"],
            sha256: "a".repeat(64),
          };
        },
      },
    } as never,
  );
  // Exactly one scoped methodCards call, addressed by the loaded method id, and
  // the method body still reaches WORK via method.catalog -> method.load.
  assert.equal(result.summary.methodLoads, 1);
  const cards = assetCalls.filter((row) => row["group"] === "methodCards");
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!["assetId"], METHOD_ID);
  assert.equal(typeof cards[0]!["scopeId"], "string");
  assert.equal((cards[0]!["scopeId"] as string).length, 64);
});


function metadataCatalog(): P2MethodCatalog {
  const base = syntheticCatalog();
  const metadata: Readonly<Record<string, Partial<P2MethodEntry>>> = {
    "method-0": { tasks: ["solve"], objects: ["matrix"], structures: ["rank"], role: "method" },
    "method-1": {
      tasks: ["prove"],
      objects: ["group"],
      structures: ["homomorphism"],
      role: "decision",
    },
    "method-2": {
      tasks: ["compute"],
      objects: ["distribution"],
      structures: ["conditional_probability"],
      role: "method",
    },
    "method-3": {
      tasks: ["solve"],
      objects: ["differential_equation"],
      structures: ["boundary_value"],
      role: "decision",
    },
  };
  return {
    version: "1.1.0",
    entries: base.entries.map((entry) => ({ ...entry, ...(metadata[entry.id] ?? {}) })),
  };
}

function repairRows(result: Awaited<ReturnType<typeof runAgentLoop>>, kind: string) {
  return (result.privateState.sessionLog?.events ?? [])
    .filter((event) => event.kind === "REPAIR")
    .map((event) => event.data)
    .filter((row) => row["kind"] === kind);
}

function methodLoadRows(result: Awaited<ReturnType<typeof runAgentLoop>>) {
  return (result.privateState.sessionLog?.events ?? [])
    .filter((event) => event.kind === "METHOD_LOAD")
    .map((event) => event.data);
}

function selectionPrompt(requests: readonly AgentModelRequest[]): string {
  const request = requests.find((item) =>
    item.messages[0]!.content.includes("METHOD SELECTION TURN"),
  );
  assert.ok(request !== undefined);
  return request.messages[0]!.content;
}

test("out-of-bound routing metadata is refused, never silently accepted", () => {
  assert.equal(checkedP2MethodRoutingMetadata({ tasks: ["ok", "x".repeat(25)] }), null);
  assert.equal(checkedP2MethodRoutingMetadata({ objects: ["Bad Token"] }), null);
  assert.equal(checkedP2MethodRoutingMetadata({ role: "ADMIN" }), null);
  assert.equal(checkedP2MethodRoutingMetadata({ structures: ["rank", "det"] }) !== null, true);
  const bad = {
    version: "1.1.0",
    entries: metadataCatalog().entries.map((entry, index) =>
      index === 0 ? { ...entry, structures: ["x".repeat(25)] } : entry,
    ),
  };
  assert.throws(() => p3MethodCatalog(bad));
});

test("semanticMethodRoute is bounded, deterministic and catalog-only", () => {
  const entries = metadataCatalog().entries;
  const problem = "matrix determinant rank, group homomorphism, density distribution, PDE boundary condition";
  const first = semanticMethodRoute(problem, entries);
  const repeated = semanticMethodRoute(problem, entries);
  const reversed = semanticMethodRoute(problem, [...entries].reverse());
  assert.ok(first.length <= 3);
  assert.deepEqual(first, repeated);
  assert.deepEqual(first, reversed);
  const known = new Set(entries.map((entry) => entry.id));
  assert.equal(first.every((id) => known.has(id)), true);
});

test("semanticMethodRoute returns no candidate when wording does not overlap", () => {
  assert.deepEqual(semanticMethodRoute("zzzz qqqq", metadataCatalog().entries), []);
});

test("the method-selection turn lists routed metadata and all remaining ids", async () => {
  const catalog = metadataCatalog();
  const run = await runMethod({
    activeCatalog: catalog,
    problem: "Compute the determinant of a matrix and its rank.",
    maxConsensus: 1,
    work: (request) =>
      request.messages[0]!.content.includes("METHOD SELECTION TURN")
        ? methodReply("method-0")
        : reactiveWork(request),
  });
  const prompt = selectionPrompt(run.requests);
  assert.match(prompt, /Routed method candidates \(metadata only; bodies are not loaded\):/u);
  assert.match(prompt, /method-0 — Method 0 — matrix/u);
  assert.match(prompt, /Other available method ids: .*method-19/u);
  assert.doesNotMatch(prompt, /asset advisory/u);
  const routes = repairRows(run.result, "METHOD_ROUTE");
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0]?.["candidates"], ["method-0"]);
  assert.equal(typeof routes[0]?.["taskId"], "string");
  assert.equal(run.result.summary.methodLoads, 1);
});

test("a routed second candidate is loaded once and both bodies reach the answer turn", async () => {
  const catalog = metadataCatalog();
  const run = await runMethod({
    activeCatalog: catalog,
    problem: "matrix rank, group homomorphism, conditional probability",
    maxMethodLoads: 2,
    maxEffects: 1,
    maxModelCalls: 5,
    maxReviews: 1,
    maxConsensus: 1,
    work: (request) => {
      const system = request.messages[0]!.content;
      if (system.includes("SECOND METHOD SELECTION TURN")) {
        return methodReply("method-1");
      }
      if (system.includes("METHOD SELECTION TURN")) {
        return methodReply("method-0");
      }
      return reactiveWork(request);
    },
  });

  assert.equal(run.result.summary.status, "candidate");
  assert.equal(run.result.summary.methodLoads, 2);
  assert.equal(run.result.summary.effectCalls, 2);
  assert.equal(run.effects.length, 2);
  assert.deepEqual(
    run.effects.map((effect) => effect.action.action === "method" ? effect.action.id : null),
    ["method-0", "method-1"],
  );

  const secondSelection = run.requests.find((request) =>
    request.messages[0]!.content.includes("SECOND METHOD SELECTION TURN"),
  );
  assert.ok(secondSelection !== undefined);
  const offeredBody = bodyOf(secondSelection);
  assert.deepEqual(
    (offeredBody["methodAssets"] as readonly { readonly id: string }[]).map((asset) => asset.id),
    ["method-0"],
  );
  assert.match(secondSelection.messages[0]!.content, /method-0/u);
  assert.match(secondSelection.messages[0]!.content, /method-1 — Method 1/u);
  assert.match(secondSelection.messages[0]!.content, /method-2 — Method 2/u);
  assert.doesNotMatch(secondSelection.messages[0]!.content, /asset advisory/u);

  const twoAssetRequests = run.requests.filter((request) => {
    const body = bodyOf(request);
    return Array.isArray(body["methodAssets"]) && body["methodAssets"].length === 2;
  });
  assert.equal(twoAssetRequests.length > 0, true);
  for (const request of twoAssetRequests) {
    const assets = bodyOf(request)["methodAssets"] as readonly {
      readonly id: string;
      readonly body: string;
    }[];
    assert.deepEqual(assets.map((asset) => asset.id), ["method-0", "method-1"]);
    assert.equal(assets.every((asset) => asset.body.length > 0), true);
  }

  const loads = methodLoadRows(run.result);
  assert.equal(loads.length, 2);
  assert.deepEqual(loads.map((row) => row["ordinal"]), [1, 2]);
  const routes = repairRows(run.result, "METHOD_ROUTE");
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0]?.["candidates"], ["method-0", "method-1", "method-2"]);
});

test("answering immediately after the first load accepts one card", async () => {
  const catalog = metadataCatalog();
  const run = await runMethod({
    activeCatalog: catalog,
    problem: "matrix rank, group homomorphism, conditional probability",
    maxMethodLoads: 2,
    maxEffects: 1,
    maxModelCalls: 5,
    maxReviews: 1,
    maxConsensus: 1,
    work: (request) => {
      const system = request.messages[0]!.content;
      if (system.includes("SECOND METHOD SELECTION TURN")) {
        return reactiveWork(request);
      }
      if (system.includes("METHOD SELECTION TURN")) {
        return methodReply("method-0");
      }
      return reactiveWork(request);
    },
  });

  assert.equal(run.result.summary.status, "candidate");
  assert.equal(run.result.summary.methodLoads, 1);
  assert.equal(run.result.summary.effectCalls, 1);
  assert.equal(run.effects.length, 1);
  const loads = methodLoadRows(run.result);
  assert.equal(loads.length, 1);
  assert.deepEqual(loads.map((row) => row["ordinal"]), [1]);
  assert.equal(
    run.requests.some((request) =>
      request.messages[0]!.content.includes("SECOND METHOD SELECTION TURN"),
    ),
    true,
  );
});

test("a single routed candidate never offers a second load", async () => {
  const catalog = metadataCatalog();
  const run = await runMethod({
    activeCatalog: catalog,
    problem: "Compute the determinant of a matrix and its rank.",
    maxMethodLoads: 2,
    maxEffects: 1,
    maxModelCalls: 5,
    maxReviews: 1,
    maxConsensus: 1,
    work: (request) =>
      request.messages[0]!.content.includes("METHOD SELECTION TURN")
        ? methodReply("method-0")
        : reactiveWork(request),
  });

  assert.equal(run.result.summary.status, "candidate");
  assert.equal(run.result.summary.methodLoads, 1);
  assert.equal(
    run.requests.some((request) =>
      request.messages[0]!.content.includes("SECOND METHOD SELECTION TURN"),
    ),
    false,
  );
});

test("a third card is refused and the run still delivers a candidate", async () => {
  const catalog = metadataCatalog();
  let secondSelection = 0;
  let thirdDemand = false;
  const run = await runMethod({
    activeCatalog: catalog,
    problem: "matrix rank, group homomorphism, conditional probability",
    maxMethodLoads: 2,
    maxEffects: 1,
    maxModelCalls: 7,
    maxReviews: 1,
    maxConsensus: 1,
    work: (request) => {
      const system = request.messages[0]!.content;
      if (system.includes("SECOND METHOD SELECTION TURN")) {
        secondSelection += 1;
        return methodReply("method-1");
      }
      if (system.includes("METHOD CONTEXT") && !thirdDemand) {
        thirdDemand = true;
        return methodReply("method-2");
      }
      if (system.includes("METHOD SELECTION TURN")) {
        return methodReply("method-0");
      }
      return reactiveWork(request);
    },
  });

  assert.equal(run.result.summary.status, "candidate");
  assert.equal(run.result.summary.methodLoads, 2);
  assert.equal(run.result.summary.effectCalls, 2);
  assert.equal(run.effects.length, 2);
  const loads = methodLoadRows(run.result);
  assert.equal(loads.length, 2);
  assert.deepEqual(loads.map((row) => row["ordinal"]), [1, 2]);
  assert.equal(
    run.requests.some((request) =>
      request.messages[0]!.content.includes("METHOD LOAD REFUSED"),
    ),
    true,
  );
});

test("a metadata-free catalog leaves the method-selection prompt unchanged", async () => {
  const run = await runMethod({
    maxConsensus: 1,
    work: (request) =>
      request.messages[0]!.content.includes("METHOD SELECTION TURN")
        ? methodReply("method-0")
        : reactiveWork(request),
  });
  const prompt = selectionPrompt(run.requests);
  assert.equal(
    prompt.endsWith(
      "\n\nMETHOD SELECTION TURN. Before delivering a WorkPacket, choose exactly one method id from methodCatalog. " +
        "Return exactly one JSON action {\"action\":\"method\",\"id\":\"<one id from methodCatalog>\"} and nothing else. " +
        "Do not return a WorkPacket in this turn.",
    ),
    true,
  );
  assert.doesNotMatch(prompt, /Routed method candidates/u);
  assert.deepEqual(repairRows(run.result, "METHOD_ROUTE"), []);
});
