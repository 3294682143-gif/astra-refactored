import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATH_ASSET_CATALOG_DIGEST,
  type AgentPorts,
  type AgentModelRequest,
  type MathAssetPort,
  type MathAssetPortRequest,
  type MathAssetResult,
} from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import { reactivePorts, reactiveWork } from "./agent-loop-test-support.js";

/**
 * The `math_asset` path must feed answer closure exactly like the legacy tool
 * path does.
 *
 * Item 34 is the motivating case: the model called a math asset on the
 * Alexander matrix, the asset returned the correct invariant polynomial, and the
 * loop still delivered a degree-2 guess. The legacy `exact_check_expr` tool path
 * is already covered by `agent-answer-closure-loop.test.ts`; this file covers the
 * unified `math_asset` path, which builds its observation view from
 * `MathAssetResult.observations[].value` instead of from a raw receipt.
 *
 * Nothing here is a proof: the observation is a program observation and the
 * closure turn is one bounded model call.
 */

const PROBLEM = "计算给定矩阵的亚历山大多项式 P(t)。";
const INVARIANT = "t**6 - 5*t**5 + 10*t**4 - 13*t**3 + 10*t**2 - 5*t + 1";
const WRONG_CANDIDATE = "2t^2-5t+2";

function mathAssetAction(): string {
  return JSON.stringify({
    action: "math_asset",
    assetId: "math.linear-algebra",
    target: "maximal_minors",
    input: {
      variable: "t",
      matrix: [
        ["-t^2+2t-1", "-t"],
        ["t^2-2t+1", "-t^2+2t-1"],
      ],
    },
  });
}

function mathAssetResult(request: MathAssetPortRequest): MathAssetResult {
  const value = {
    schema: "exact-maximal-minors-v1",
    shape: [4, 4],
    minor_size: 3,
    raw_minors: [INVARIANT],
    normalized_minors: [{ polynomial: INVARIANT, multiplicity: 16 }],
    zero_minors: 0,
  };
  return {
    schemaVersion: "math-assets-v1",
    assetId: request.assetId,
    assetVersion: "1.0.0",
    catalogDigest: MATH_ASSET_CATALOG_DIGEST,
    requestId: "node-math-asset-1",
    binding: request.binding,
    normalizedInput: request.input,
    inputHash: "0" + "a".repeat(63),
    status: "COMPLETE",
    guidance: ["Computed every maximal minor exactly"],
    observations: [
      {
        quantity: "maximal_minors",
        value,
        domain: "EXACT",
        exactness: "EXACT_FOR_INPUT",
        coverage: "EXACT_FOR_INPUT",
        sourceInputHash: "0" + "a".repeat(63),
        taskId: request.binding.taskId,
        contractVersion: request.binding.contractVersion,
      },
    ],
    checks: [
      {
        checkerId: "checker.maximal_minors.v1",
        version: "1.0.0",
        scope: "EXACT",
        inputHash: "0" + "a".repeat(63),
        resultHash: "0" + "b".repeat(63),
        status: "VERIFIED_FOR_INPUT",
      },
    ],
    usage: { durationMs: 7, computationType: "NATIVE_PYTHON" },
    limitations: [],
    resultHash: "0" + "c".repeat(63),
  };
}

async function runAssetClosure(options: { readonly closureCandidate: string }) {
  let turn = 0;
  const modelPort = {
    async generate(request: AgentModelRequest) {
      turn += 1;
      if (turn === 1) {
        return { transportStatus: "COMPLETE" as const, text: mathAssetAction() };
      }
      // Every ordinary turn keeps the wrong degree, including the certificate
      // turn: the point of the test is that the OBSERVATION-driven closure is
      // what repairs the candidate, not a lucky self-check.
      if (turn === 2 || turn === 3) {
        return {
          transportStatus: "COMPLETE" as const,
          text: reactiveWork(request, { candidate: WRONG_CANDIDATE }),
        };
      }
      const candidate = options.closureCandidate || WRONG_CANDIDATE;
      return {
        transportStatus: "COMPLETE" as const,
        text: reactiveWork(request, { candidate }),
      };
    },
  };
  const mathAssetPort: MathAssetPort = {
    execute: async (request: MathAssetPortRequest): Promise<MathAssetResult> => {
      assert.equal(request.action, "math_asset");
      assert.equal(request.target, "maximal_minors");
      return mathAssetResult(request);
    },
  };
  const ports: AgentPorts = {
    model: modelPort as never,
    effect: null,
    catalog: null,
    mathAsset: mathAssetPort,
  };
  const result = await runAgentLoop(
    PROBLEM,
    "s",
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 1,
      maxConsensus: 1,
      now: () => 0,
    },
    ports,
  );
  const rows = (result.privateState.sessionLog?.events ?? [])
    .filter((event) => event.kind === "CONSENSUS" && event.data["stage"] === "ANSWER_CLOSURE")
    .map((event) => event.data);
  return { result, rows, turn };
}

test("a math_asset maximal-minor observation closes a wrong-degree candidate", async () => {
  const run = await runAssetClosure({ closureCandidate: INVARIANT });
  assert.equal(run.rows.length, 1, "exactly one closure evaluation row");
  assert.deepEqual(run.rows[0]!["defects"], ["DEGREE_CONSERVATION"]);
  assert.equal(run.rows[0]!["observationUsed"], true);
  assert.equal(run.rows[0]!["closureRequested"], true);
  assert.equal(run.rows[0]!["candidateChanged"], true);
  assert.deepEqual(run.rows[0]!["remainingDefects"], []);
  // The invariant the asset actually computed is delivered, not the degree-2 guess.
  assert.equal(run.result.summary.finalResponse, INVARIANT);
});

test("a closure turn that keeps the wrong degree leaves the candidate alone", async () => {
  const run = await runAssetClosure({ closureCandidate: "" });
  assert.deepEqual(run.rows[0]!["defects"], ["DEGREE_CONSERVATION"]);
  assert.equal(run.rows[0]!["closureRequested"], true);
  assert.equal(run.rows[0]!["candidateChanged"], false);
  assert.deepEqual(run.rows[0]!["remainingDefects"], ["DEGREE_CONSERVATION"]);
  // An unusable closure reply never replaces the delivered candidate.
  assert.equal(run.result.summary.finalResponse, WRONG_CANDIDATE);
});


test("an abstention triggers one forced asset turn before it is accepted", async () => {
  // Item 34 abandons the task before any packet exists, so the forced asset turn
  // (which normally runs after a candidate packet) was never reached even though
  // the problem text routes deterministically to a math asset. The abstention now
  // triggers that one observation turn, and the answer is delivered afterwards.
  let workTurns = 0;
  const seen: string[] = [];
  const ports = reactivePorts({
    work: (request: AgentModelRequest) => {
      const system = request.messages[0]?.content ?? "";
      seen.push(system);
      if (system.includes("MATH ASSET TURN")) return mathAssetAction();
      workTurns += 1;
      if (workTurns === 1) {
        return JSON.stringify({ action: "unsolved", reason: "cannot read the presentation" });
      }
      return reactiveWork(request, { candidate: INVARIANT });
    },
  });
  const mathAssetPort: MathAssetPort = {
    execute: async (request: MathAssetPortRequest) => mathAssetResult(request),
  };
  const result = await runAgentLoop(
    PROBLEM,
    "s",
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 2,
      maxConsensus: 1,
      now: () => 0,
    },
    {
      model: ports.model,
      effect: ports.effect,
      catalog: null,
      mathAsset: mathAssetPort,
    },
  );
  const early = (result.privateState.sessionLog?.events ?? []).filter(
    (event) => event.kind === "REPAIR" && event.data["kind"] === "MATH_ASSET_EARLY",
  );
  assert.equal(early.length, 1, "the evidence turn must be taken exactly once");
  assert.equal(early[0]!.data["target"], "maximal_minors");
  // The evidence turn is now the FIRST model turn, before any answer attempt, so
  // a long problem cannot spend its whole budget on answer turns and audits and
  // then time out without ever running the computation it needs.
  assert.equal(
    seen[0]?.includes("MATH ASSET TURN"),
    true,
    "the asset turn must come first",
  );
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.finalResponse, INVARIANT);
});
