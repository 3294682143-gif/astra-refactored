import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileP2Contract } from "@astra/math-contract";
import { P2MethodSession } from "@astra/runtime-core";
import type { P2MethodAsset, P2MethodCatalog, P2MethodLoad, P2MethodPort } from "@astra/protocol";
import { runP2Fixture } from "../src/p2-fixture.js";
import type { P2FixtureUnit } from "../src/p2-fixture.js";
import type { P2RouteInput } from "@astra/math-workunit";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const VERSION = "1.1.0" as const;

function pythonPort(): { port: P2MethodPort; calls: () => number; loads: () => number } {
  let calls = 0;
  let loads = 0;
  const run = (id: string | null): unknown => {
    calls += 1;
    if (id !== null) {
      loads += 1;
    }
    const args = ["-m", "python.astra_bridge.p2_methods", ...(id === null ? [] : ["--method", id])];
    const result = spawnSync("python", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 65536,
      env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout) as unknown;
  };
  return {
    port: { catalog: () => run(null) as P2MethodCatalog, load: (id: string) => run(id) as P2MethodLoad },
    calls: () => calls,
    loads: () => loads,
  };
}

test("real python adapter serves the catalog and one verified body", () => {
  const adapter = pythonPort();
  const session = new P2MethodSession(adapter.port);
  assert.equal(session.catalog().entries.length, 20);
  assert.equal(adapter.loads(), 0);
  const first = session.load("linearization-spectral", 65536);
  assert.equal(first.status, "loaded");
  assert.equal(first.code, "OK");
  const asset = session.assetsSnapshot()[0]!;
  assert.equal(asset.version, VERSION);
  assert.equal(asset.bodyChars, [...asset.body].length);
  assert.equal(asset.bodySha256, createHash("sha256").update(asset.body, "utf8").digest("hex"));
  const again = session.load("linearization-spectral", 65536);
  assert.equal(again.status, "already_loaded");
  assert.equal(session.loadAttempts(), 1);
  assert.equal(session.assetsSnapshot().length, 1);
  assert.equal(adapter.loads(), 1);
  assert.equal(session.load("../etc/passwd", 65536).code, "NOT_FOUND");
  assert.equal(session.load("no-such-method", 65536).code, "NOT_FOUND");
  assert.equal(adapter.loads(), 1);
  assert.equal(Object.isFrozen(session.catalog()), true);
  assert.equal(Object.isFrozen(session.catalog().entries), true);
  assert.equal(Object.isFrozen(session.assetsSnapshot()[0]), true);
});

function syntheticPort(): { port: P2MethodPort; calls: () => number } {
  let calls = 0;
  const entries = Array.from({ length: 20 }, (_, index) => ({ id: `m-${index}`, title: `t-${index}` }));
  const body = "abc";
  const asset = (id: string): P2MethodAsset => ({
    id,
    title: `t-${id.slice(2)}`,
    version: VERSION,
    body,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    bodyChars: 3,
  });
  return {
    port: {
      catalog: () => ({ version: VERSION, entries }),
      load: (id: string) => {
        calls += 1;
        return { status: "loaded", asset: asset(id) } as P2MethodLoad;
      },
    },
    calls: () => calls,
  };
}

test("synthetic port enforces integrity, budgets and attempt bounds", () => {
  const adapter = syntheticPort();
  const session = new P2MethodSession(adapter.port);
  const bad = { ...adapter.port, load: (id: string) => ({ status: "loaded", asset: { ...(adapter.port.load(id).asset as P2MethodAsset), bodySha256: "0".repeat(64) } }) as P2MethodLoad };
  const broken = new P2MethodSession(bad);
  assert.equal(broken.load("m-0", 65536).code, "INTEGRITY_FAILED");
  assert.equal(broken.load("m-0", 65536).code, "INTEGRITY_FAILED");
  assert.equal(broken.loadAttempts(), 1);
  assert.equal(broken.assetsSnapshot().length, 0);
  assert.equal(new P2MethodSession(adapter.port, 2, 2).load("m-0", 65536).code, "BUDGET_EXHAUSTED");
  assert.equal(new P2MethodSession(adapter.port, 2, 12000).load("m-0", 0).code, "CONTEXT_FULL");
  const disabled = new P2MethodSession(adapter.port, 0, 12000);
  assert.equal(disabled.load("m-0", 65536).code, "DISABLED");
  assert.equal(disabled.loadAttempts(), 0);
  const fresh = syntheticPort();
  const freshBad = { ...fresh.port, load: (id: string) => ({ status: "loaded", asset: { ...(fresh.port.load(id).asset as P2MethodAsset), bodySha256: "0".repeat(64) } }) as P2MethodLoad };
  const bounded = new P2MethodSession(freshBad, 2, 12000);
  assert.equal(bounded.load("m-0", 65536).code, "INTEGRITY_FAILED");
  assert.equal(bounded.load("m-1", 65536).code, "INTEGRITY_FAILED");
  assert.equal(bounded.load("m-2", 65536).code, "BUDGET_EXHAUSTED");
  assert.equal(bounded.loadAttempts(), 2);
  assert.equal(fresh.calls(), 2);
  const dupEntries = Array.from({ length: 20 }, (_, index) => ({ id: index === 1 ? "m-0" : `m-${index}`, title: `t-${index}` }));
  const dup = new P2MethodSession({ catalog: () => ({ version: VERSION, entries: dupEntries }), load: adapter.port.load });
  assert.equal(dup.catalog().entries.length, 0);
  assert.equal(dup.load("m-0", 65536).code, "DISABLED");
});

const METHOD_PROBLEM = "PRIVATE_METHOD_PROBLEM";
const methodContract = compileP2Contract(METHOD_PROBLEM, "method-session");
const methodTask = methodContract.tasks[0]!;
const methodRoute: P2RouteInput = {
  routeId: "r",
  representation: "rep",
  operation: "op",
  lemmas: ["l"],
  construction: "con",
};

function methodUnit(index: number, deliveryStatus: "COMPLETE" | "INCOMPLETE"): P2FixtureUnit {
  const packet = {
    schemaVersion: "p2a-work-v1",
    sessionId: methodContract.envelope.sessionId,
    problemHash: methodContract.problemHash,
    contractVersion: methodContract.contractVersion,
    taskId: methodTask.taskId,
    goalId: methodTask.goalId,
    scopeId: methodTask.scopeId,
    routeId: "r",
    sourceRequestId: `fixture-${index}`,
    claim: "c",
    derivation: "d",
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus,
    candidateProposal: "candidate",
  };
  return {
    taskId: methodTask.taskId,
    routeId: "r",
    methodIds: ["linearization-spectral"],
    transportStatus: "COMPLETE",
    text: JSON.stringify(packet),
  };
}

test("real python method card flows through the full M1/M3 fixture", () => {
  const adapter = pythonPort();
  const result = runP2Fixture(methodContract, [methodUnit(1, "INCOMPLETE"), methodUnit(2, "COMPLETE")], {
    routes: [methodRoute],
    maxWorkUnits: 3,
    remainingMs: 5000,
    maxMethods: 2,
    maxMethodChars: 12000,
    methodPort: adapter.port,
    now: () => 0,
  });
  assert.equal(result.summary.fixtureReceiptsConsumed, 2);
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.candidateProposal, "candidate");
  assert.equal(result.summary.methodLoadAttempts, 1);
  assert.equal(adapter.loads(), 1);
  assert.equal(adapter.calls(), 2);
  const first = result.privateState.requests[0]!;
  const second = result.privateState.requests[1]!;
  const firstUser = JSON.parse(first.messages[1]!.content) as Record<string, unknown>;
  const secondUser = JSON.parse(second.messages[1]!.content) as Record<string, unknown>;
  const firstAssets = firstUser.methodAssets as readonly P2MethodAsset[];
  const secondAssets = secondUser.methodAssets as readonly P2MethodAsset[];
  assert.equal(firstAssets.length, 1);
  assert.equal(secondAssets.length, 1);
  assert.equal(firstAssets[0]!.id, "linearization-spectral");
  assert.equal(firstAssets[0]!.bodySha256, createHash("sha256").update(firstAssets[0]!.body, "utf8").digest("hex"));
  assert.equal(secondAssets[0]!.bodySha256, createHash("sha256").update(secondAssets[0]!.body, "utf8").digest("hex"));
  assert.equal(first.methodUses[0]!.status, "loaded");
  assert.equal(second.methodUses[0]!.status, "already_loaded");
  const summaryText = JSON.stringify(result.summary);
  assert.equal(summaryText.includes(METHOD_PROBLEM), false);
  assert.equal(summaryText.includes(firstAssets[0]!.body), false);
});
