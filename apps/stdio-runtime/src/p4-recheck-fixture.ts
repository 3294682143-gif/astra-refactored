/**
 * @astra/stdio-runtime — P4 S2 offline recheck fixture composition root.
 *
 * Composes the real M1 contract/ledger, M2 recheck model gate, M3 workunit
 * store and context preparation, M4 R2 review session, M5 S2 repair session and
 * M5 S3 candidate gate over one dependency-free candidate artifact plus at most
 * one repair proposal. No client, no network, no tool execution. The parent
 * stays the protected candidate; a repair child is never verified and never
 * replaces it.
 *
 * The opt-in four-step shape (work1 -> review2 -> repair3 -> recheck4) shares
 * one root deadline and one M2 ledger: options and receipts are captured before
 * the first clock read, the M2 gate is the new P4RecheckModelGate, and the
 * fourth step runs only when the caller explicitly asks for maxModelCalls 4 and
 * maxRechecks 1 with a recorded repair, an ACTIVE child and enough remaining
 * time. A model re-review is never a verification, never resolves the original
 * challenge and never replaces the protected parent.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  p4Target,
  type P2Artifact,
  type P2ArtifactRef,
  type P2Contract,
  type P2Task,
  type P2TransportStatus,
  type P4Challenge,
  type P4DeliveryPolicy,
  type P4FinalDecision,
  type P4RecheckSnapshot,
  type P4RepairSnapshot,
  type P4ReviewSnapshot,
  type P4Target,
} from "@astra/protocol";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P4RecheckModelGate, chooseP2ReadyTask } from "@astra/math-gateway";
import { P2WorkunitStore, prepareP2Context } from "@astra/math-workunit";
import { P4RecheckSession, P4ReviewSession } from "@astra/math-review";
import { P4CandidateGate, P4RepairSession } from "@astra/math-audit";
import type { P4FixtureReceipt } from "./p4-fixture.js";

const RESERVE_MS = 25;
const MAX_RECEIPTS = 4;
const MAX_BYTES = 65536;
const MAX_REVIEW_CHARS = 20000;
const MIN_REMAINING_MS = 26;
const MAX_REMAINING_MS = 5000;
const LATE_MS = 25;
const DEFAULT_MAX_MODEL_CALLS = 3;
const DEFAULT_MAX_RECHECKS = 0;
const CANDIDATE_KINDS = ["CANDIDATE_VALIDITY", "ANSWER_REQUEST"];
const TRANSPORTS = ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const;
const ROUTE = {
  routeId: "route-1",
  representation: "equation",
  operation: "derive",
  lemmas: [],
  construction: "offline",
} as const;

export interface P4RecheckFixtureOptions {
  readonly maxModelCalls?: number;
  readonly maxRechecks?: number;
  readonly maxRepairs: number;
  readonly remainingMs: number;
  readonly policy: P4DeliveryPolicy;
  readonly now?: () => number;
}

export interface P4RecheckFixtureResult {
  readonly summary: {
    readonly mode: "MOCK_ONLY";
    readonly targetEnvironment: "TARGET_UNVERIFIED";
    readonly status: "candidate" | "unsolved";
    readonly finalResponse: string;
    readonly candidateVerified: false;
    readonly strictAcceptance: "NOT_PERFORMED";
    readonly policy: P4DeliveryPolicy;
    readonly modelCalls: number;
    readonly reviewCalls: number;
    readonly repairCalls: number;
    readonly repairRecorded: boolean;
    readonly recheckCalls: number;
    readonly recheckRecorded: boolean;
    readonly recheckConclusion: "NO_ISSUE" | "ISSUES" | "UNKNOWN" | "NONE";
    readonly parentProtected: boolean;
    readonly unresolvedChallenges: number;
    readonly stopReason: string;
  };
  readonly privateState: {
    readonly contract: P2Contract;
    readonly artifacts: readonly unknown[];
    readonly requests: readonly unknown[];
    readonly modelGate: readonly unknown[];
    readonly review: P4ReviewSnapshot | null;
    readonly repair: P4RepairSnapshot | null;
    readonly recheck: P4RecheckSnapshot | null;
    readonly decision: P4FinalDecision;
  };
}

type Code = (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES];

function fail(code: Code): never {
  throw new P2Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
  }
  return source;
}

function bounded(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > max) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return value;
}

function safeInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function transportOf(value: unknown): P2TransportStatus {
  if (typeof value !== "string" || !(TRANSPORTS as readonly string[]).includes(value)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value as P2TransportStatus;
}

function receiptText(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || !detectLoneSurrogates(value).ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if ([...value].length > maxChars) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_BYTES) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

export function runP4RecheckFixture(
  problem: string,
  sessionId: string,
  receipts: readonly P4FixtureReceipt[],
  options: P4RecheckFixtureOptions,
): P4RecheckFixtureResult {
  const problemText = bounded(problem, 8192);
  const session = bounded(sessionId, 128);
  if (!isPlainObject(options)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const requestedCalls = options.maxModelCalls;
  const requestedRechecks = options.maxRechecks;
  const maxModelCalls =
    requestedCalls === undefined ? DEFAULT_MAX_MODEL_CALLS : safeInt(requestedCalls, 0, 4);
  const maxRechecks =
    requestedRechecks === undefined ? DEFAULT_MAX_RECHECKS : safeInt(requestedRechecks, 0, 1);
  const maxRepairs = safeInt(options.maxRepairs, 0, 1);
  const budgetMs = safeInt(options.remainingMs, 1, MAX_REMAINING_MS);
  const policy = options.policy;
  if (policy !== "BEST_EFFORT" && policy !== "STRICT") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const clock = options.now ?? (() => performance.now());
  if (typeof clock !== "function") {
    fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }

  if (!Array.isArray(receipts) || receipts.length > MAX_RECEIPTS) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const frozenReceipts: P4FixtureReceipt[] = [];
  for (let index = 0; index < receipts.length; index += 1) {
    const row = exact(p2Snapshot(receipts[index]), ["transportStatus", "text"]);
    const transportStatus = transportOf(row.transportStatus);
    const text = receiptText(
      row.text,
      index === 1 || index === 3 ? MAX_REVIEW_CHARS : MAX_BYTES,
    );
    frozenReceipts.push(Object.freeze({ transportStatus, text }));
  }

  let started: number;
  try {
    started = clock();
  } catch {
    fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }
  if (typeof started !== "number" || !Number.isFinite(started)) {
    fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }
  const deadline = started + budgetMs;
  let lastNow = started;
  let clockInvalid = false;
  const remaining = (): number => {
    if (clockInvalid) {
      return 0;
    }
    let value: number;
    try {
      value = clock();
    } catch {
      clockInvalid = true;
      return 0;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < lastNow) {
      clockInvalid = true;
      return 0;
    }
    lastNow = value;
    const left = Math.floor(deadline - value);
    if (left < 0) {
      return 0;
    }
    if (left > MAX_REMAINING_MS) {
      return MAX_REMAINING_MS;
    }
    return left;
  };

  const contract = compileP2Contract(problemText, session);
  const ledger = new ContractLedger(contract);
  const store = new P2WorkunitStore(ledger.snapshot());
  const route = store.registerRoute(ROUTE);
  const gate = new P4RecheckModelGate(
    session,
    contract.problemHash,
    contract.contractVersion,
    maxModelCalls,
  );
  const candidateGate = new P4CandidateGate(contract, policy);

  const requests: unknown[] = [];
  let task: P2Task | null = null;
  let parent: P4Target | null = null;
  let parentArtifact: P2Artifact | null = null;
  let review: P4ReviewSession | null = null;
  let repair: P4RepairSession | null = null;
  let recheck: P4RecheckSession | null = null;
  let modelCalls = 0;
  let reviewCalls = 0;
  let repairCalls = 0;
  let recheckCalls = 0;
  let stop: string = "NO_CANDIDATE";
  let finished = false;

  const finish = (): P4RecheckFixtureResult => {
    if (!finished) {
      finished = true;
      if (parentArtifact !== null) {
        const ref: P2ArtifactRef = {
          artifactId: parentArtifact.artifactId,
          artifactVersion: parentArtifact.envelope.artifactVersion ?? 1,
        };
        ledger.recordDelivery(
          parentArtifact.envelope.taskId ?? "",
          ref,
          parentArtifact.deliveryStatus === "COMPLETE" ? "DELIVERED" : "PARTIAL",
          parentArtifact.envelope.eventSeq,
        );
      }
    }
    const reviewSnapshot = review === null ? null : review.snapshot();
    const repairSnapshot = repair === null ? null : repair.snapshot();
    const recheckSnapshot = recheck === null ? null : recheck.snapshot();
    const decision = candidateGate.finalize(ledger.snapshot(), parent, reviewSnapshot, remaining());
    const summary = p2Snapshot({
      mode: "MOCK_ONLY" as const,
      targetEnvironment: "TARGET_UNVERIFIED" as const,
      status: decision.status,
      finalResponse: decision.finalResponse,
      candidateVerified: false as const,
      strictAcceptance: "NOT_PERFORMED" as const,
      policy,
      modelCalls,
      reviewCalls,
      repairCalls,
      repairRecorded: repairSnapshot?.record?.code === "PROPOSAL_RECORDED",
      recheckCalls,
      recheckRecorded:
        recheckSnapshot?.record?.code === "OK" && recheckSnapshot.record.report !== null,
      recheckConclusion: recheckSnapshot?.record?.report?.conclusion ?? "NONE",
      parentProtected: candidateGate.snapshot().protectedTarget !== null,
      unresolvedChallenges: decision.unresolvedChallenges,
      stopReason: stop,
    });
    const privateState = p2Snapshot({
      contract: ledger.snapshot(),
      artifacts: store.snapshot(),
      requests,
      modelGate: gate.snapshot(),
      review: reviewSnapshot,
      repair: repairSnapshot,
      recheck: recheckSnapshot,
      decision,
    });
    return p2Snapshot({ summary, privateState }) as P4RecheckFixtureResult;
  };

  if (maxModelCalls === 0 || frozenReceipts.length === 0 || remaining() <= LATE_MS) {
    stop = remaining() <= LATE_MS ? "DEADLINE_EXCEEDED" : "NO_CANDIDATE";
    return finish();
  }

  const chosen = chooseP2ReadyTask(ledger.snapshot(), ledger.readyTasks());
  if (chosen === null) {
    stop = "NO_CANDIDATE";
    return finish();
  }
  const obligation = ledger
    .snapshot()
    .obligations.find((row) => row.obligationId === chosen.obligationId);
  if (
    obligation === undefined ||
    !(CANDIDATE_KINDS as readonly string[]).includes(obligation.kind) ||
    chosen.dependencyTaskIds.length !== 0 ||
    chosen.inputArtifactRefs.length !== 0
  ) {
    stop = "NO_CANDIDATE";
    return finish();
  }

  let running: P2Task;
  let prepared: ReturnType<typeof prepareP2Context>;
  try {
    running = ledger.startTask(chosen.taskId);
    prepared = prepareP2Context(ledger.snapshot(), running, route, "model-1", [], [], []);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  task = running;
  requests.push(
    p2Snapshot({
      requestId: "model-1",
      taskId: running.taskId,
      messages: prepared.messages,
      contextHash: prepared.contextHash,
      contextBytes: prepared.contextBytes,
      receipt: null,
    }),
  );

  if (remaining() <= LATE_MS) {
    stop = "DEADLINE_EXCEEDED";
    return finish();
  }
  const first = frozenReceipts[0];
  if (first === undefined) {
    stop = "FIXTURE_EXHAUSTED";
    return finish();
  }
  try {
    gate.admit(running, "model-1", remaining());
    gate.markDispatched("model-1");
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  requests[requests.length - 1] = p2Snapshot({
    requestId: "model-1",
    taskId: running.taskId,
    messages: prepared.messages,
    contextHash: prepared.contextHash,
    contextBytes: prepared.contextBytes,
    receipt: first,
  });
  modelCalls += 1;
  try {
    gate.settle("model-1", first.transportStatus);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }

  let accepted: P2Artifact;
  try {
    accepted = store.accept(running, {
      artifactId: "artifact-1",
      routeId: "route-1",
      sourceRequestId: "model-1",
      transportStatus: first.transportStatus,
      text: first.text,
      eventSeq: ledger.nextEventSeq(),
      supersedes: null,
    });
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "PACKET_REJECTED";
    return finish();
  }
  parentArtifact = accepted;

  if (accepted.deliveryStatus !== "COMPLETE" || store.candidate({
    artifactId: accepted.artifactId,
    artifactVersion: accepted.envelope.artifactVersion ?? 1,
  }) === null) {
    stop = "NO_CANDIDATE";
    return finish();
  }
  if (remaining() <= LATE_MS) {
    store.invalidate({
      artifactId: accepted.artifactId,
      artifactVersion: accepted.envelope.artifactVersion ?? 1,
    });
    stop = "DEADLINE_EXCEEDED";
    return finish();
  }
  let built: P4Target;
  try {
    built = p4Target(ledger.snapshot(), accepted, "ACTIVE");
    candidateGate.protect(built);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  parent = built;

  if (maxModelCalls < 2 || frozenReceipts.length < 2) {
    stop = "NO_REVIEW";
    return finish();
  }
  review = new P4ReviewSession(ledger.snapshot(), built, 1);
  if (remaining() <= LATE_MS) {
    stop = "DEADLINE_EXCEEDED";
    return finish();
  }
  let admitted: ReturnType<P4ReviewSession["admit"]>;
  try {
    admitted = review.admit("model-2", remaining());
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  requests.push(
    p2Snapshot({
      requestId: "model-2",
      taskId: running.taskId,
      messages: admitted.context.messages,
      contextHash: admitted.context.contextHash,
      contextBytes: admitted.context.contextBytes,
      receipt: null,
    }),
  );
  if (remaining() <= LATE_MS) {
    stop = "DEADLINE_EXCEEDED";
    return finish();
  }
  const second = frozenReceipts[1];
  if (second === undefined) {
    stop = "FIXTURE_EXHAUSTED";
    return finish();
  }
  try {
    gate.admit(running, "model-2", remaining());
    gate.markDispatched("model-2");
    review.markDispatched("model-2");
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  requests[requests.length - 1] = p2Snapshot({
    requestId: "model-2",
    taskId: running.taskId,
    messages: admitted.context.messages,
    contextHash: admitted.context.contextHash,
    contextBytes: admitted.context.contextBytes,
    receipt: second,
  });
  modelCalls += 1;
  reviewCalls += 1;
  try {
    gate.settle("model-2", second.transportStatus);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  let settled: ReturnType<P4ReviewSession["settle"]>;
  try {
    settled = review.settle("model-2", second.transportStatus, second.text, remaining());
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  if (settled.code !== "OK" || settled.report === null || settled.report.conclusion !== "ISSUES") {
    stop = "REVIEW_STOP";
    return finish();
  }
  const challenge: P4Challenge | undefined = review.snapshot().challenges[0];
  if (
    challenge === undefined ||
    challenge.status !== "CHALLENGED" ||
    challenge.availability !== "ACTIVE"
  ) {
    stop = "NO_CHALLENGE";
    return finish();
  }

  if (
    maxRepairs === 0 ||
    maxModelCalls < 3 ||
    frozenReceipts.length < 3 ||
    remaining() <= LATE_MS
  ) {
    stop = remaining() <= LATE_MS ? "DEADLINE_EXCEEDED" : "NO_REPAIR";
    return finish();
  }
  const third = frozenReceipts[2];
  if (third === undefined) {
    stop = "FIXTURE_EXHAUSTED";
    return finish();
  }
  try {
    repair = new P4RepairSession(ledger.snapshot(), built, challenge, 1);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  let repairAdmitted: ReturnType<P4RepairSession["admit"]>;
  try {
    repairAdmitted = repair.admit(remaining());
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  requests.push(
    p2Snapshot({
      requestId: "model-3",
      taskId: running.taskId,
      messages: repairAdmitted.context.messages,
      contextHash: repairAdmitted.context.contextHash,
      contextBytes: repairAdmitted.context.contextBytes,
      receipt: null,
    }),
  );
  if (remaining() <= LATE_MS) {
    stop = "DEADLINE_EXCEEDED";
    return finish();
  }
  try {
    gate.admit(running, "model-3", remaining());
    gate.markDispatched("model-3");
    repair.markDispatched();
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  requests[requests.length - 1] = p2Snapshot({
    requestId: "model-3",
    taskId: running.taskId,
    messages: repairAdmitted.context.messages,
    contextHash: repairAdmitted.context.contextHash,
    contextBytes: repairAdmitted.context.contextBytes,
    receipt: third,
  });
  modelCalls += 1;
  repairCalls += 1;
  try {
    gate.settle("model-3", third.transportStatus);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }

  let child: P4Target | null = null;
  let childRef: P2ArtifactRef | null = null;
  if (third.transportStatus === "COMPLETE" && remaining() > LATE_MS) {
    try {
      const childArtifact = store.accept(running, {
        artifactId: "repair-1",
        routeId: "route-1",
        sourceRequestId: "model-3",
        transportStatus: third.transportStatus,
        text: third.text,
        eventSeq: (accepted.envelope.eventSeq ?? 0) + 1,
        supersedes: null,
      });
      childRef = {
        artifactId: childArtifact.artifactId,
        artifactVersion: childArtifact.envelope.artifactVersion ?? 1,
      };
      child = p4Target(ledger.snapshot(), childArtifact, "ACTIVE");
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      child = null;
    }
  }
  let repairSettled: ReturnType<P4RepairSession["settle"]>;
  try {
    repairSettled = repair.settle(third.transportStatus, third.text, child, remaining());
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  if (repairSettled.code !== "PROPOSAL_RECORDED") {
    if (childRef !== null) {
      store.invalidate(childRef);
    }
    stop = "REPAIR_STOP";
    return finish();
  }
  stop = "REPAIR_RECORDED";

  if (maxRechecks === 0 || maxModelCalls < 4 || frozenReceipts.length < 4) {
    return finish();
  }
  if (child === null || child.availability !== "ACTIVE") {
    return finish();
  }
  const fourth = frozenReceipts[3];
  if (fourth === undefined) {
    stop = "FIXTURE_EXHAUSTED";
    return finish();
  }
  const rootQuota = maxModelCalls - gate.snapshot().length;
  if (rootQuota < 1 || remaining() <= LATE_MS) {
    stop = remaining() <= LATE_MS ? "DEADLINE_EXCEEDED" : "RECHECK_STOP";
    return finish();
  }
  try {
    recheck = new P4RecheckSession(
      ledger.snapshot(),
      built,
      child,
      review.snapshot(),
      repair.snapshot(),
      1,
    );
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  let recheckAdmitted: ReturnType<P4RecheckSession["admit"]>;
  try {
    recheckAdmitted = recheck.admit(remaining(), rootQuota);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  requests.push(
    p2Snapshot({
      requestId: "model-4",
      taskId: running.taskId,
      messages: recheckAdmitted.context.messages,
      contextHash: recheckAdmitted.context.contextHash,
      contextBytes: recheckAdmitted.context.contextBytes,
      receipt: null,
    }),
  );
  if (remaining() <= LATE_MS) {
    stop = "DEADLINE_EXCEEDED";
    return finish();
  }
  try {
    gate.admit(running, "model-4", remaining());
    gate.markDispatched("model-4");
    recheck.markDispatched();
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  requests[requests.length - 1] = p2Snapshot({
    requestId: "model-4",
    taskId: running.taskId,
    messages: recheckAdmitted.context.messages,
    contextHash: recheckAdmitted.context.contextHash,
    contextBytes: recheckAdmitted.context.contextBytes,
    receipt: fourth,
  });
  modelCalls += 1;
  recheckCalls += 1;
  try {
    gate.settle("model-4", fourth.transportStatus);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  let recheckSettled: ReturnType<P4RecheckSession["settle"]>;
  try {
    recheckSettled = recheck.settle(fourth.transportStatus, fourth.text, remaining());
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  stop = recheckSettled.code === "OK" ? "RECHECK_RECORDED" : "RECHECK_STOP";
  return finish();
}
