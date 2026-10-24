/**
 * Tests for unified math_asset action execution through AgentLoop.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type AgentModelPort,
  type AgentPorts,
  type MathAssetPort,
  type MathAssetPortRequest,
  type MathAssetResult,
} from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import { reactiveWork } from "./agent-loop-test-support.js";

test("math_asset action is executed via mathAsset port and flows into loop observations", async () => {
  let modelCallCount = 0;
  let mathAssetExecuted = false;

  const modelPort: AgentModelPort = {
    generate: async (req) => {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        // First turn: model requests math_asset
        return {
          transportStatus: "COMPLETE",
          text: JSON.stringify({
            action: "math_asset",
            assetId: "math.linear-algebra",
            input: {
              target: "rank",
              field: "GF2",
              rows: [1, 2, 3],
            },
          }),
        };
      }
      // Second turn: model concludes with work packet
      return {
        transportStatus: "COMPLETE",
        text: reactiveWork(req),
      };
    },
  };

  const mathAssetPort: MathAssetPort = {
    execute: async (req: MathAssetPortRequest): Promise<MathAssetResult> => {
      mathAssetExecuted = true;
      assert.equal(req.action, "math_asset");
      assert.equal(req.assetId, "math.linear-algebra");
      assert.deepEqual(req.input, { target: "rank", field: "GF2", rows: [1, 2, 3] });
      return {
        schemaVersion: "math-assets-v1",
        assetId: "math.linear-algebra",
        assetVersion: "1.0.0",
        catalogDigest: "7ba616ecd21f791f4187512207efe05d29e32a769956a2d61a4f84f18a377233",
        requestId: "node-math-asset-1",
        binding: req.binding,
        normalizedInput: req.input,
        inputHash: "0" + "a".repeat(63),
        status: "COMPLETE",
        guidance: ["Calculated GF(2) rank"],
        observations: [
          {
            quantity: "gf2_rank",
            value: 2,
            domain: "GF(2)",
            exactness: "EXACT_FOR_INPUT",
            coverage: "EXACT_FOR_INPUT",
            sourceInputHash: "0" + "a".repeat(63),
            taskId: req.binding.taskId,
            contractVersion: req.binding.contractVersion,
          },
        ],
        checks: [
          {
            checkerId: "checker.gf2_rank.v1",
            version: "1.0.0",
            scope: "GF(2)",
            inputHash: "0" + "a".repeat(63),
            resultHash: "0" + "b".repeat(63),
            status: "VERIFIED_FOR_INPUT",
          },
        ],
        usage: { durationMs: 5, computationType: "NATIVE_PYTHON" },
        limitations: [],
        resultHash: "0" + "c".repeat(63),
      };
    },
  };

  const ports: AgentPorts = {
    model: modelPort,
    effect: null,
    catalog: null,
    mathAsset: mathAssetPort,
  };

  const res = await runAgentLoop(
    "Find the rank of binary vectors 1, 2, 3 over GF(2).",
    "test-math-asset-session-1",
    {
      maxModelCalls: 8,
      maxWorkUnits: 4,
      maxEffects: 2,
      maxReviews: 0,
      remainingMs: 10000,
    },
    ports,
  );

  assert.equal(mathAssetExecuted, true, "mathAsset port must have been called");
  assert.ok(modelCallCount >= 2, `Expected at least 2 model turns, got ${modelCallCount}`);
  assert.equal(res.summary.status, "candidate");
});
