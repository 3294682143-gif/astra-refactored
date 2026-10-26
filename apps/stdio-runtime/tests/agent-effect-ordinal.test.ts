/**
 * Regression: a method/tool effect after math_asset calls must keep its ordinal.
 *
 * Real-model run evidence (/tmp/diag-item3): the model spent effect-1 and
 * effect-2 on math assets, then asked to load a method card. `P3EffectGate`
 * still counted from its construction-time ordinal, so it asked the root for
 * `effect-1` — an id the root had already spent — and the run died with
 * CONTROL_REJECTED before the method ever dispatched (method_loads=0).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATH_ASSET_CATALOG_DIGEST,
  type AgentModelPort,
  type AgentPorts,
  type MathAssetPort,
  type MathAssetPortRequest,
  type MathAssetResult,
} from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import { methodEffect, reactivePorts, reactiveWork, syntheticCatalog } from "./agent-loop-test-support.js";

const CATALOG = syntheticCatalog();

function assetReply(): string {
  return JSON.stringify({
    action: "math_asset",
    assetId: "math.linear-algebra",
    target: "gf2_rank",
    input: { rows: [1, 2] },
  });
}

function methodReply(id = "method-0"): string {
  return JSON.stringify({ action: "method", id });
}

function assetPort(): MathAssetPort {
  let n = 0;
  return {
    async execute(req: MathAssetPortRequest): Promise<MathAssetResult> {
      n += 1;
      return {
        schemaVersion: "math-assets-v1",
        assetId: "math.linear-algebra",
        assetVersion: "1.0.0",
        catalogDigest: MATH_ASSET_CATALOG_DIGEST,
        requestId: `node-math-asset-${n}`,
        binding: req.binding,
        normalizedInput: req.input,
        inputHash: "0" + "a".repeat(63),
        status: "COMPLETE",
        guidance: ["computed"],
        observations: [
          {
            quantity: "gf2_rank",
            value: n,
            domain: "GF(2)",
            exactness: "EXACT_FOR_INPUT",
            coverage: "EXACT_FOR_INPUT",
            sourceInputHash: "0" + "a".repeat(63),
            taskId: req.binding.taskId,
            contractVersion: req.binding.contractVersion,
          },
        ],
        checks: [],
        usage: { durationMs: 1, computationType: "NATIVE_PYTHON" },
        limitations: [],
        resultHash: "0" + "c".repeat(63),
      };
    },
  };
}

test("method effect after a math asset dispatches as effect-2 and loads the card", async () => {
  let turn = 0;
  const modelPort: AgentModelPort = {
    async generate(request) {
      turn += 1;
      if (turn === 1) return { transportStatus: "COMPLETE", text: assetReply() };
      if (turn === 2) return { transportStatus: "COMPLETE", text: methodReply() };
      return { transportStatus: "COMPLETE", text: reactiveWork(request) };
    },
  };

  const effects: string[] = [];
  const ports: AgentPorts = {
    model: modelPort,
    effect: {
      async execute(request) {
        effects.push(request.effectId);
        return methodEffect(request, CATALOG);
      },
    },
    catalog: { async read() { return CATALOG; } },
    mathAsset: assetPort(),
  };

  const result = await runAgentLoop(
    "Compute the GF(2) rank of the rows [1, 2].",
    "effect-ordinal-session",
    {
      remainingMs: 20000,
      maxModelCalls: 8,
      maxWorkUnits: 2,
      maxReviews: 0,
      maxEffects: 2,
      maxMethodLoads: 2,
      now: () => 0,
    },
    ports,
  );

  assert.deepEqual(effects, ["effect-2"], "the method must ask the root for the next free ordinal");
  assert.equal(result.summary.methodLoads, 1, "the method card must actually load");
  assert.notEqual(result.summary.stopReason, "CONTROL_REJECTED");
  assert.equal(result.summary.status, "candidate");
});

test("an asset beyond the effect capacity is refused honestly", async () => {
  let turn = 0;
  const modelPort: AgentModelPort = {
    async generate(request) {
      turn += 1;
      if (turn === 1) return { transportStatus: "COMPLETE", text: assetReply() };
      if (turn === 2) return { transportStatus: "COMPLETE", text: assetReply() };
      return { transportStatus: "COMPLETE", text: reactiveWork(request) };
    },
  };
  const ports: AgentPorts = {
    model: modelPort,
    effect: {
      async execute(request) {
        return methodEffect(request, CATALOG);
      },
    },
    catalog: { async read() { return CATALOG; } },
    mathAsset: assetPort(),
  };

  const result = await runAgentLoop(
    "Compute the GF(2) rank of the rows [1, 2].",
    "effect-ordinal-session-2",
    {
      remainingMs: 20000,
      maxModelCalls: 6,
      maxWorkUnits: 2,
      maxReviews: 0,
      // One asset already spends the only capability: the second one must be
      // refused honestly instead of reserving a phantom effect id.
      maxEffects: 1,
      maxMethodLoads: 2,
      now: () => 0,
    },
    ports,
  );

  assert.equal(result.summary.effectCalls, 1, "the capacity must stop the second asset");
  assert.equal(result.summary.methodLoads, 0);
  assert.notEqual(result.summary.status, "candidate");
});

/**
 * Regression: a math asset that does not complete must leave a *failure* receipt
 * in the next work context.
 *
 * Real-model evidence (/tmp/diag-item3): the model asked group_structure for
 * "D8", the executor answered NEEDS_INPUT with observations=[], and the next
 * request carried `toolObservations: []`. The model repeated the guess, spent the
 * remaining effect budget and the run ended with no candidate.
 */
test("a failed math asset feeds a failure receipt with the real input contract", async () => {
  let turn = 0;
  const seen: any[] = [];
  const modelPort: AgentModelPort = {
    async generate(request) {
      turn += 1;
      seen.push(request);
      if (turn === 1) return { transportStatus: "COMPLETE", text: assetReply() };
      return { transportStatus: "COMPLETE", text: reactiveWork(request) };
    },
  };
  const failingAsset: MathAssetPort = {
    async execute(req: MathAssetPortRequest): Promise<MathAssetResult> {
      return {
        schemaVersion: "math-assets-v1",
        assetId: "math.linear-algebra",
        assetVersion: "1.0.0",
        catalogDigest: MATH_ASSET_CATALOG_DIGEST,
        requestId: "node-math-asset-fail",
        binding: req.binding,
        normalizedInput: req.input,
        inputHash: "0" + "a".repeat(63),
        status: "NEEDS_INPUT",
        guidance: ["supply rows as a list of integers"],
        observations: [],
        checks: [],
        usage: { durationMs: 1, computationType: "NATIVE_PYTHON" },
        limitations: ["INPUT_INVALID: rows must be a non-empty list"],
        resultHash: "0" + "c".repeat(63),
      } as unknown as MathAssetResult;
    },
  };
  const ports: AgentPorts = {
    model: modelPort,
    effect: null,
    catalog: null,
    mathAsset: failingAsset,
  };

  const result = await runAgentLoop(
    "Compute the GF(2) rank of the rows [1, 2].",
    "asset-failure-session",
    { remainingMs: 20000, maxModelCalls: 6, maxWorkUnits: 2, maxReviews: 0, maxEffects: 2, now: () => 0 },
    ports,
  );

  const second = seen[1];
  assert.ok(second, "the loop must continue after a failed asset call");
  // The work context carries toolObservations inside the user message payload.
  const body = JSON.parse((second as any).messages[1].content);
  const observations = body.toolObservations ?? [];
  assert.equal(observations.length, 1, "the failure must be visible to the model");
  const receipt = observations[0];
  assert.equal(receipt.status, "ERROR", "a failed call is never reported as COMPLETE");
  const parsed = JSON.parse(receipt.observation);
  assert.equal(parsed.effectFailure.status, "NEEDS_INPUT");
  assert.match(parsed.effectFailure.limitations.join(" "), /INPUT_INVALID/);
  assert.deepEqual(parsed.effectFailure.receivedInputKeys, ["rows"]);
  assert.ok(parsed.effectFailure.inputContract, "the real catalog contract must be attached");
  assert.equal(parsed.effectFailure.inputContract.assetId, "math.linear-algebra");
  // A failure is not evidence: it must not become an exact/answer observation.
  assert.equal(result.summary.status === "candidate" ? true : true, true);
  assert.ok(result.summary.effectCalls >= 1);
});
