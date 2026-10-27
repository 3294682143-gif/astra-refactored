import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentModelRequest } from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  answerComponents,
  componentAgreementScores,
  componentValue,
  frontRunnerIndex,
} from "../src/agent-answer-key.js";
import { CONSENSUS_BALLOT_LENSES, buildAgentWorkContext } from "../src/agent-loop-context.js";
import { reactivePorts, reactiveWork } from "./agent-loop-test-support.js";

/**
 * Independent consensus ballots.
 *
 * A large consensus budget has to buy DECORRELATED samples, because a majority
 * can only repair a single arithmetic slip if the ballots are not all anchored
 * to the answer under test. These tests pin the three properties that makes
 * that true:
 *
 *  - an independent ballot leaves the candidate out of its payload and uses the
 *    compact solve prompt, so it is a real second solve and not a replay;
 *  - the audits and the certificate keep the full prompt and are anchored to
 *    the exact-support front-runner, not to whichever ballot answered last;
 *  - the delivered candidate is the front-runner, so a wrong first answer can
 *    still be outvoted.
 *
 * Nothing here is a proof: every reply is literal data from the mock ports.
 */

const PROBLEM = "计算 12×13+9 的值。";
const WRONG_FIRST = "156";
const CORRECT = "165";

interface RunOptions {
  /** Answers of the independent ballots, in order. */
  readonly ballots: readonly string[];
  /** Answer the anchored audits and the certificate reply with. */
  readonly anchored: string;
}

function isBallot(request: AgentModelRequest): boolean {
  return request.messages[0]?.content.startsWith("Independent solve turn.") === true;
}

async function runConsensus(options: RunOptions) {
  let ballots = 0;
  const ports = reactivePorts({
    work: (request) => {
      if (request.phase !== "CONSENSUS") return reactiveWork(request, { candidate: WRONG_FIRST });
      if (isBallot(request)) {
        const answer = options.ballots[ballots] ?? options.ballots.at(-1) ?? CORRECT;
        ballots += 1;
        return reactiveWork(request, { candidate: answer });
      }
      return reactiveWork(request, { candidate: options.anchored });
    },
  });
  const result = await runAgentLoop(
    PROBLEM,
    "s",
    {
      remainingMs: 5000,
      maxModelCalls: 20,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 0,
      maxConsensus: 8,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  const consensusRows = (result.privateState.sessionLog?.events ?? [])
    .filter((event) => event.kind === "CONSENSUS")
    .map((event) => event.data);
  return { result, requests: ports.requests, consensusRows, ballots };
}

function payloadOf(request: AgentModelRequest): Record<string, unknown> {
  return JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
}

test("a large consensus budget spends most rounds on independent ballots", async () => {
  const run = await runConsensus({ ballots: [CORRECT, CORRECT, CORRECT, WRONG_FIRST, "151"], anchored: CORRECT });
  const stages = run.consensusRows
    .map((row) => row["stage"])
    // The answer-closure evaluation logs its own row after the ballots; it is
    // asserted separately below.
    .filter((stage) => stage !== "ANSWER_CLOSURE");
  // Eight rounds: five independent ballots, two anchored audits, one certificate.
  assert.deepEqual(stages, [
    "INDEPENDENT",
    "INDEPENDENT",
    "INDEPENDENT",
    "INDEPENDENT",
    "INDEPENDENT",
    "AUDIT",
    "AUDIT",
    "CERTIFICATE",
  ]);
  assert.equal(run.ballots, 5);
  const closure = run.consensusRows.filter((row) => row["stage"] === "ANSWER_CLOSURE");
  assert.equal(closure.length, 1);
  assert.deepEqual(closure[0]!["defects"], []);
  assert.equal(closure[0]!["closureRequested"], false);
});

test("an independent ballot is a real second solve: no protected candidate, compact prompt", async () => {
  const run = await runConsensus({ ballots: [CORRECT, CORRECT, CORRECT, WRONG_FIRST, "151"], anchored: CORRECT });
  const consensusRequests = run.requests.filter((request) => request.phase === "CONSENSUS");
  const ballotRequests = consensusRequests.filter((request) => isBallot(request));
  assert.equal(ballotRequests.length, 5);
  for (const request of ballotRequests) {
    // The answer under test must not leak into the ballot payload.
    assert.equal(payloadOf(request)["protectedCandidate"], null);
    assert.equal(payloadOf(request)["allowFinal"], false);
    const system = request.messages[0]!.content;
    // The compact prompt keeps the packet contract ...
    for (const field of [
      "schemaVersion",
      "sessionId",
      "problemHash",
      "contractVersion",
      "taskId",
      "goalId",
      "scopeId",
      "routeId",
      "sourceRequestId",
      "claim",
      "derivation",
      "assumptions",
      "dependencies",
      "pendingObligations",
      "suggestedChecks",
      "deliveryStatus",
      "candidateProposal",
    ]) {
      assert.ok(system.includes(field), `compact prompt must still name ${field}`);
    }
    assert.ok(system.includes("4096"));
    assert.ok(system.includes("COMPLETE"));
    // ... and drops the policy text that has nothing to do with the answer.
    assert.equal(system.includes("workflowProposal"), false);
    assert.equal(system.includes("SCOPE_REFINEMENT"), false);
    assert.equal(system.includes("progressPolicy"), false);
    assert.equal(system.includes("math.algebraic-structures"), false);
  }
  // Every lens is used at most once per run, so the ballots are not one replay.
  const lenses = ballotRequests.map((request) =>
    CONSENSUS_BALLOT_LENSES.findIndex((lens) => request.messages[0]!.content.includes(lens)),
  );
  assert.deepEqual(lenses, [0, 1, 2, 3, 4]);
});

test("the anchored audits keep the full prompt and audit the front-runner", async () => {
  const run = await runConsensus({ ballots: [CORRECT, CORRECT, CORRECT, WRONG_FIRST, "151"], anchored: CORRECT });
  const stageById = new Map(
    run.consensusRows
      .filter((row) => typeof row["requestId"] === "string")
      .map((row) => [row["requestId"] as string, row["stage"]]),
  );
  const consensusRequests = run.requests.filter((request) => request.phase === "CONSENSUS");
  const anchoredRequests = consensusRequests.filter((request) => !isBallot(request));
  assert.equal(anchoredRequests.length, 3);
  const stages = anchoredRequests.map((request) => stageById.get(request.requestId));
  assert.deepEqual(stages, ["AUDIT", "AUDIT", "CERTIFICATE"]);
  for (const request of anchoredRequests) {
    const system = request.messages[0]!.content;
    assert.equal(system.startsWith("Offline unified AgentLoop work unit."), true);
    // The front-runner is the exact-support winner, never the last ballot.
    assert.equal(system.includes(`CURRENT CANDIDATE: ${CORRECT}`), true);
    assert.equal(system.includes("CURRENT CANDIDATE: 151"), false);
    if (stageById.get(request.requestId) === "AUDIT") {
      // The best-supported rival answer is offered as the answer to beat.
      assert.equal(system.includes(`OTHER CANDIDATE: ${WRONG_FIRST}`), true);
    } else {
      // The certificate audits one answer only; a second one would be a hint.
      assert.equal(system.includes("OTHER CANDIDATE"), false);
    }
  }
});

test("a wrong first answer is outvoted by the independent ballots", async () => {
  const run = await runConsensus({ ballots: [CORRECT, CORRECT, CORRECT, WRONG_FIRST, "151"], anchored: CORRECT });
  assert.equal(run.result.summary.finalResponse, CORRECT);
});

test("a small consensus budget keeps the original shape", async () => {
  // Two rounds stay one independent ballot plus the certificate: the cheaper
  // budget must not silently start spending five samples per answer.
  const ballots = 0;
  const ports = reactivePorts({
    work: (request) => {
      if (request.phase !== "CONSENSUS") return reactiveWork(request, { candidate: WRONG_FIRST });
      return reactiveWork(request, { candidate: CORRECT });
    },
  });
  const result = await runAgentLoop(
    PROBLEM,
    "s",
    {
      remainingMs: 5000,
      maxModelCalls: 8,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: 0,
      maxConsensus: 2,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  const stages = (result.privateState.sessionLog?.events ?? [])
    .filter((event) => event.kind === "CONSENSUS")
    .map((event) => event.data["stage"]);
  assert.deepEqual(stages.filter((stage) => stage !== "ANSWER_CLOSURE"), [
    "INDEPENDENT",
    "CERTIFICATE",
  ]);
  assert.equal(ballots, 0);
  const ballotsSent = ports.requests.filter((request) => isBallot(request));
  assert.equal(ballotsSent.length, 1);
  // The certificate is a full-prompt turn even at the small budget.
  const certificate = ports.requests.filter(
    (request) =>
      request.phase === "CONSENSUS" && !isBallot(request),
  );
  assert.equal(certificate.length, 1);
  assert.equal(
    certificate[0]!.messages[0]!.content.includes("CERTIFICATE SELF-CHECK"),
    true,
  );
  assert.equal(result.summary.finalResponse, CORRECT);
});

test("the ballot prompt never changes the recorded user payload", async () => {
  // The Host re-derives the user body and refuses any mismatch, so the compact
  // prompt may only ever replace the system message.
  const run = await runConsensus({
    ballots: [CORRECT, CORRECT, CORRECT, WRONG_FIRST, "151"],
    anchored: CORRECT,
  });
  const consensusRequests = run.requests.filter((request) => request.phase === "CONSENSUS");
  const ballot = consensusRequests.find((request) => isBallot(request))!;
  const anchored = consensusRequests.find((request) => !isBallot(request))!;
  const ballotPayload = JSON.parse(ballot.messages[1]!.content) as Record<string, unknown>;
  const anchoredPayload = JSON.parse(anchored.messages[1]!.content) as Record<string, unknown>;
  // The only legal difference is the request id that binds the turn itself.
  assert.notEqual(ballotPayload["sourceRequestId"], anchoredPayload["sourceRequestId"]);
  delete ballotPayload["sourceRequestId"];
  delete anchoredPayload["sourceRequestId"];
  assert.deepEqual(ballotPayload, anchoredPayload);
  // Only the source request id and the system prompt differ between the turns.
  assert.notEqual(ballot.messages[0]!.content, anchored.messages[0]!.content);
  assert.notEqual(ballot.contextHash, anchored.contextHash);
  assert.equal(ballotPayload["protectedCandidate"], null);
});


// ---------------------------------------------------------------------------
// Multi-part ballots. These cases are duplicated verbatim in
// tests/bridge/test_answer_semantics.py: the Host copies this rule exactly, so
// both languages must return the same winner for the same input.
// ---------------------------------------------------------------------------

test("a multi-part answer only splits outside brackets", () => {
  assert.deepEqual(answerComponents("(14253),(165)"), ["(14253)", "(165)"]);
  assert.deepEqual(answerComponents("(a,b)"), ["(a,b)"]);
  assert.deepEqual(answerComponents("\\{1,2,3\\}"), ["\\{1,2,3\\}"]);
  assert.deepEqual(answerComponents("x=1, y=2"), ["x=1", "y=2"]);
  assert.deepEqual(answerComponents("42"), ["42"]);
});

test("component scores pick the ballot that matches each part", () => {
  const ballots = ["(14253),(165)", "(14253),(136)", "(13524), (165)"];
  assert.deepEqual(componentAgreementScores(ballots), [2, 1, 1]);
  // Every whole answer differs, so the whole-answer vote has no majority. The
  // last ballot is wrong on one part and the first ballot is right on both.
  assert.equal(frontRunnerIndex(ballots), 0);
});

test("component scores stay out of the way for single-part answers", () => {
  const ballots = ["5117", "5129", "5000"];
  assert.deepEqual(componentAgreementScores(ballots), [0, 0, 0]);
  // No component structure: the previous latest tie-break is preserved.
  assert.equal(frontRunnerIndex(ballots), 2);
});

test("ballots with different component counts are not compared", () => {
  assert.deepEqual(componentAgreementScores(["x=1, y=2", "x=1", "x=1, y=2"]), [0, 0, 0]);
});

test("a whole-answer majority always beats component agreement", () => {
  const ballots = ["x=1, y=9", "x=1, y=9", "x=1, y=2"];
  assert.equal(frontRunnerIndex(ballots), 1);
});

test("an empty ballot list has no front-runner", () => {
  assert.equal(frontRunnerIndex([]), -1);
});


test("a labelled component and a bare component compare as the same blank", () => {
  // Item 5: one ballot answered "σ^{-2}=(14253), σ^{-1}(126)σ=(165)" while
  // another answered "(14253),(165)". Comparing raw component text would split
  // those two identical answers into two minorities.
  const ballots = [
    "σ^{-2}=(14253), σ^{-1}(126)σ=(165)",
    "(15432), (236)",
    "(15432),(236)",
    "(14253),(165)",
  ];
  assert.deepEqual(componentAgreementScores(ballots), [2, 0, 0, 2]);
  // The two wrong ballots are byte-different but canonically identical, so they
  // form a whole-answer majority of two and still win. Component agreement must
  // never overrule a real majority; on this item only the anchored audit saves
  // the answer. This records the limit deliberately.
  assert.equal(frontRunnerIndex(ballots), 2);
});

test("component values drop a short left-hand tag", () => {
  assert.equal(componentValue("σ^{-2}=(14253)"), "(14253)");
  assert.equal(componentValue("x=1"), "1");
  assert.equal(componentValue("A: 3"), "3");
  // A real equation is never read as a tag plus a value.
  assert.equal(componentValue("240 - 190·(5/6)^{3/2} = 95.46"), "95.46");
});
