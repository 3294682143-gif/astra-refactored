/**
 * Tests for unified math_asset action execution through AgentLoop.
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
import { reactiveWork } from "./agent-loop-test-support.js";

test("math_asset action is executed via mathAsset port, enters effect budget and flows into loop observations", async () => {
  let modelCallCount = 0;
  let mathAssetExecuted = false;

  const modelPort: AgentModelPort = {
    generate: async (req) => {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        // First turn: model requests math_asset with top-level target
        return {
          transportStatus: "COMPLETE",
          text: JSON.stringify({
            action: "math_asset",
            assetId: "math.linear-algebra",
            target: "gf2_rank",
            input: {
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
      assert.equal(req.target, "gf2_rank");
      assert.deepEqual(req.input, { rows: [1, 2, 3] });
      return {
        schemaVersion: "math-assets-v1",
        assetId: "math.linear-algebra",
        assetVersion: "1.0.0",
        catalogDigest: MATH_ASSET_CATALOG_DIGEST,
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
  assert.equal(res.summary.effectCalls, 1, "math_asset execution must increment effectCalls to 1");
  assert.equal(res.summary.status, "candidate");
});

test("root effect budget enforcement: maxEffects=1 bounds math_asset calls", async () => {
  let assetCalls = 0;

  const modelPort: AgentModelPort = {
    generate: async (req) => {
      // Keep requesting math_asset repeatedly
      return {
        transportStatus: "COMPLETE",
        text: JSON.stringify({
          action: "math_asset",
          assetId: "math.linear-algebra",
          target: "gf2_rank",
          input: { rows: [1, 2] },
        }),
      };
    },
  };

  const mathAssetPort: MathAssetPort = {
    execute: async (req: MathAssetPortRequest): Promise<MathAssetResult> => {
      assetCalls += 1;
      return {
        schemaVersion: "math-assets-v1",
        assetId: "math.linear-algebra",
        assetVersion: "1.0.0",
        catalogDigest: MATH_ASSET_CATALOG_DIGEST,
        requestId: `node-math-asset-${assetCalls}`,
        binding: req.binding,
        normalizedInput: req.input,
        inputHash: "0" + "a".repeat(63),
        status: "COMPLETE",
        guidance: [],
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
        checks: [],
        usage: { durationMs: 2, computationType: "NATIVE_PYTHON" },
        limitations: [],
        resultHash: "0" + "c".repeat(63),
      };
    },
  };

  const res = await runAgentLoop(
    "Test budget enforcement.",
    "test-math-asset-session-budget",
    {
      maxModelCalls: 8,
      maxWorkUnits: 4,
      maxEffects: 1, // Only 1 effect allowed!
      maxReviews: 0,
      remainingMs: 10000,
    },
    {
      model: modelPort,
      effect: null,
      catalog: null,
      mathAsset: mathAssetPort,
    },
  );

  // Exactly 1 asset execution must succeed, then second attempt is refused with CONTROL_REJECTED
  assert.equal(assetCalls, 1, "math_asset should only be called once when maxEffects=1");
  assert.equal(res.summary.effectCalls, 1, "effectCalls must equal maxEffects (1)");
  assert.equal(res.summary.stopReason, "CONTROL_REJECTED");
});

test("strict observation binding verification: mismatched contractVersion or taskId is rejected fail-closed", async () => {
  const modelPort: AgentModelPort = {
    generate: async () => ({
      transportStatus: "COMPLETE",
      text: JSON.stringify({
        action: "math_asset",
        assetId: "math.linear-algebra",
        target: "gf2_rank",
        input: { rows: [1, 2] },
      }),
    }),
  };

  const mathAssetPort: MathAssetPort = {
    execute: async (req: MathAssetPortRequest): Promise<MathAssetResult> => {
      // Simulate foreign observation from another task with contractVersion=99
      return {
        schemaVersion: "math-assets-v1",
        assetId: "math.linear-algebra",
        assetVersion: "1.0.0",
        catalogDigest: MATH_ASSET_CATALOG_DIGEST,
        requestId: "node-math-asset-fake",
        binding: {
          taskId: "foreign-task-999",
          goalId: req.binding.goalId,
          scopeId: req.binding.scopeId,
          contractVersion: 99, // Mismatched contract version!
        },
        normalizedInput: req.input,
        inputHash: "0" + "a".repeat(63),
        status: "COMPLETE",
        guidance: [],
        observations: [
          {
            quantity: "gf2_rank",
            value: 2,
            domain: "GF(2)",
            exactness: "EXACT_FOR_INPUT",
            coverage: "EXACT_FOR_INPUT",
            sourceInputHash: "0" + "a".repeat(63),
            taskId: "foreign-task-999",
            contractVersion: 99,
          },
        ],
        checks: [],
        usage: { durationMs: 2, computationType: "NATIVE_PYTHON" },
        limitations: [],
        resultHash: "0" + "c".repeat(63),
      };
    },
  };

  const res = await runAgentLoop(
    "Test foreign binding rejection.",
    "test-math-asset-session-foreign",
    {
      maxModelCalls: 4,
      maxWorkUnits: 2,
      maxEffects: 2,
      maxReviews: 0,
      remainingMs: 10000,
    },
    {
      model: modelPort,
      effect: null,
      catalog: null,
      mathAsset: mathAssetPort,
    },
  );

  // Must reject fail-closed with CONTROL_REJECTED due to binding mismatch
  assert.equal(res.summary.stopReason, "CONTROL_REJECTED");
});

test("guidance propagation: analyze guidance is surfaced into subsequent model context", async () => {
  let secondTurnMessages: any = null;

  const modelPort: AgentModelPort = {
    generate: async (req) => {
      if (req.messages.length > 0 && secondTurnMessages === null && req.phase === "WORK") {
        const text = req.messages[0]?.content ?? "";
        if (text.includes("[MATH ASSET GUIDANCE")) {
          secondTurnMessages = req.messages;
          return {
            transportStatus: "COMPLETE",
            text: reactiveWork(req),
          };
        }
      }
      // First turn: call analyze on math.equations
      return {
        transportStatus: "COMPLETE",
        text: JSON.stringify({
          action: "math_asset",
          assetId: "math.equations",
          target: "analyze",
          input: {},
        }),
      };
    },
  };

  const mathAssetPort: MathAssetPort = {
    execute: async (req: MathAssetPortRequest): Promise<MathAssetResult> => {
      return {
        schemaVersion: "math-assets-v1",
        assetId: "math.equations",
        assetVersion: "1.0.0",
        catalogDigest: MATH_ASSET_CATALOG_DIGEST,
        requestId: "node-math-asset-guidance",
        binding: req.binding,
        normalizedInput: {},
        inputHash: "0" + "a".repeat(63),
        status: "COMPLETE",
        guidance: [
          "Check univariate polynomial degree before Sturm count",
          "Ensure real root isolation interval is bounded",
        ],
        observations: [],
        checks: [],
        usage: { durationMs: 2, computationType: "METADATA_INSPECTION" },
        limitations: [],
        resultHash: "0" + "c".repeat(63),
      };
    },
  };

  const res = await runAgentLoop(
    "Test guidance propagation.",
    "test-math-asset-session-guidance",
    {
      maxModelCalls: 6,
      maxWorkUnits: 3,
      maxEffects: 2,
      maxReviews: 0,
      remainingMs: 10000,
    },
    {
      model: modelPort,
      effect: null,
      catalog: null,
      mathAsset: mathAssetPort,
    },
  );

  assert.notEqual(secondTurnMessages, null, "Second turn must have received guidance in context");
  assert.ok(
    secondTurnMessages[0].content.includes("Check univariate polynomial degree before Sturm count"),
    "System message must include the exact guidance text",
  );
  assert.equal(res.summary.status, "candidate");
});
