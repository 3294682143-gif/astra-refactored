/**
 * Regression test for §5.5 (late observation handling):
 * A candidate is established and protected first. A subsequent observation arrives
 * from a math asset execution, contradicting the protected candidate.
 * The loop detects the defect, prompts for a bounded revision, and adopts the revised candidate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Hash, type AgentModelRequest, type MathAssetResult } from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import { reactivePorts, reactiveWork } from "./agent-loop-test-support.js";

const PROBLEM = "Compute the rank of the binary matrix over GF(2).";

test("§5.5 late observation contradicts protected candidate and triggers revision", async () => {
  let turn = 0;
  let mathAssetCalled = false;

  const ports = reactivePorts({
    work: (request: AgentModelRequest) => {
      turn += 1;
      const body = JSON.parse(request.messages[1]!.content);
      const taskId = body.task?.taskId ?? "";

      // Task 1 (DOMAIN_VALIDITY): return standard work packet without candidate
      if (taskId.endsWith("DOMAIN_VALIDITY")) {
        return reactiveWork(request, { candidate: null });
      }

      // Task 2 (CANDIDATE_VALIDITY): deliver initial candidate stating rank is 3.
      // This establishes and protects candidate "3".
      if (taskId.endsWith("CANDIDATE_VALIDITY")) {
        return reactiveWork(request, { candidate: "The GF(2) rank is 3" });
      }

      // Late observation revision turn (phase === "WORK" but triggered by late observation closure)
      // When prompted with late observation defect note, revise candidate to 2.
      const promptText = request.messages[1]?.content ?? "";
      if (promptText.includes("CLOSURE_NOTE") || promptText.includes("DEFECT") || promptText.includes("gf2_rank")) {
        return JSON.stringify({
          candidateProposal: "The GF(2) rank is 2",
          claim: "The GF(2) rank is 2",
          derivation: "Exact verification yields 2",
        });
      }

      // In task 3 (INDEPENDENT_DERIVATION), turn 1 calls math_asset to verify rank.
      if (!mathAssetCalled) {
        return JSON.stringify({
          action: "math_asset",
          assetId: "math.linear-algebra",
          input: { target: "gf2_rank", rows: [1, 2] },
        });
      }

      // Subsequent turns return work packet with revised candidate.
      return reactiveWork(request, { candidate: "The GF(2) rank is 2" });
    },
  });

  const mathAssetPort = {
    execute: async (req: { readonly binding: any; readonly input: any }): Promise<MathAssetResult> => {
      mathAssetCalled = true;
      const result: MathAssetResult = {
        schemaVersion: "math-assets-v1",
        assetId: "math.linear-algebra",
        assetVersion: "1.0.0",
        catalogDigest: "7ba616ecd21f791f4187512207efe05d29e32a769956a2d61a4f84f18a377233",
        requestId: "node-math-asset-late-obs",
        binding: req.binding ?? {
          taskId: "task-1",
          goalId: "goal-1",
          scopeId: "scope-1",
          contractVersion: 1,
        },
        normalizedInput: req.input ?? { rows: [1, 2] },
        inputHash: p4Hash("rows"),
        status: "COMPLETE",
        resultHash: p4Hash("rank-2"),
        observations: [
          {
            quantity: "gf2_rank",
            value: 2,
            domain: "GF(2)",
            exactness: "EXACT_FOR_INPUT",
            coverage: "EXHAUSTIVE",
            sourceInputHash: p4Hash("rows"),
            taskId: "task-1",
            contractVersion: 1,
          },
        ],
        checks: [],
        guidance: ["Exact rank over GF(2)"],
        usage: { durationMs: 1, computationType: "EXACT" },
        limitations: [],
      };
      return result;
    },
  };

  const result = await runAgentLoop(
    PROBLEM,
    "sess-late-obs",
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 4,
      maxReviews: 0,
      maxEffects: 2,
      maxRepairs: 1,
      maxConsensus: 1,
      now: () => 0,
    },
    {
      model: ports.model,
      effect: ports.effect,
      catalog: null,
      asset: null,
      mathAsset: mathAssetPort,
    },
  );

  assert.ok(mathAssetCalled, "math_asset must have been executed");
  assert.equal(result.summary.finalResponse, "The GF(2) rank is 2", "Protected candidate must be revised to rank 2");

  const events = result.privateState.sessionLog?.events ?? [];
  const lateObsEvents = events.filter(
    (event: { readonly kind: string; readonly data: Record<string, unknown> }) =>
      event.kind === "CONSENSUS" && event.data["stage"] === "LATE_OBSERVATION_DEFECT",
  );

  assert.ok(lateObsEvents.length >= 1, "Must record LATE_OBSERVATION_DEFECT in session log");
  const event = lateObsEvents[0]!;
  assert.equal(event.data["revised"], true, "Late observation defect must be recorded as revised");
});
