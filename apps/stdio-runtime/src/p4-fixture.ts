/**
 * @astra/stdio-runtime — P4 offline fixture composition root (pure, no I/O).
 *
 * Composes the real M1 contract/ledger, M2 model gate, M3 workunit store and
 * context preparation, M4 R2 review session and M5 S3 candidate gate over one
 * dependency-free complete candidate artifact. No client, no network, no tool
 * execution. Every candidate stays unverified.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  type P2Artifact,
  type P2ArtifactRef,
  type P2Contract,
  type P4DeliveryPolicy,
  type P4FinalDecision,
  type P2Task,
  type P2TransportStatus,
} from "@astra/protocol";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2ModelGate, chooseP2ReadyTask } from "@astra/math-gateway";
import { P2WorkunitStore, prepareP2Context } from "@astra/math-workunit";
import { P4ReviewSession } from "@astra/math-review";
import { P4CandidateGate } from "@astra/math-audit";
import { p4Target } from "@astra/protocol";

const RESERVE_MS = 25;
const MAX_RECEIPTS = 3;
const MAX_BYTES = 65536;
const CANDIDATE_KINDS = ["CANDIDATE_VALIDITY", "ANSWER_REQUEST"];
const ROUTE = {
  routeId: "route-1",
  representation: "equation",
  operation: "derive",
  lemmas: [],
  construction: "offline",
} as const;

export interface P4FixtureReceipt {
  readonly transportStatus: P2TransportStatus;
  readonly text: string;
}

export interface P4FixtureOptions {
  readonly maxModelCalls: number;
  readonly maxReviews: number;
  readonly remainingMs: number;
  readonly policy: P4DeliveryPolicy;
  readonly now?: () => number;
}

export interface P4FixtureResult {
  readonly summary: {
    readonly mode: "MOCK_ONLY";
    readonly targetEnvironment: "TARGET_UNVERIFIED";
    readonly status: "candidate" | "unsolved";
    readonly finalResponse: string;
    readonly candidateVerified: false;
    readonly strictAcceptance: "NOT_PERFORMED";
    readonly policy: P4DeliveryPolicy;
    readonly reason: string;
    readonly modelCalls: number;
    readonly reviewCalls: number;
    readonly unresolvedChallenges: number;
    readonly openObligations: number;
    readonly stopReason: string;
  };
  readonly privateState: {
    readonly contract: P2Contract;
    readonly artifacts: readonly unknown[];
    readonly requests: readonly unknown[];
    readonly modelGate: readonly unknown[];
    readonly review: unknown;
    readonly decision: P4FinalDecision;
  };
}

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function bounded(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > max) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return value;
}

const RECEIPT_FIELDS = ["transportStatus", "text"] as const;
const TRANSPORTS = ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const;
const MAX_RECEIPT_BYTES = 65536;
const MAX_REVIEW_CHARS = 20000;
const MIN_REMAINING_MS = 26;
const MAX_REMAINING_MS = 5000;
const LATE_MS = 25;

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
  if (Buffer.byteLength(value, "utf8") > MAX_RECEIPT_BYTES) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

export function runP4Fixture(
  problem: string,
  sessionId: string,
  receipts: readonly P4FixtureReceipt[],
  options: P4FixtureOptions,
): P4FixtureResult {
  const problemText = bounded(problem, 8192);
  const session = bounded(sessionId, 128);
  if (!isPlainObject(options)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const maxModelCalls = safeInt(options.maxModelCalls, 0, 3);
  const maxReviews = safeInt(options.maxReviews, 0, 2);
  const budgetMs = safeInt(options.remainingMs, 1, MAX_REMAINING_MS);
  const policy = options.policy;
  if (policy !== "BEST_EFFORT" && policy !== "STRICT") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const clock = options.now ?? (() => performance.now());
  if (typeof clock !== "function") {
    fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
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

  if (!Array.isArray(receipts) || receipts.length > MAX_RECEIPTS) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const frozenReceipts: P4FixtureReceipt[] = [];
  for (let index = 0; index < receipts.length; index += 1) {
    const row = exact(p2Snapshot(receipts[index]), RECEIPT_FIELDS);
    const transportStatus = transportOf(row.transportStatus);
    const text = receiptText(row.text, index > 0 ? MAX_REVIEW_CHARS : MAX_RECEIPT_BYTES);
    frozenReceipts.push(Object.freeze({ transportStatus, text }));
  }

  const contract = compileP2Contract(problemText, session);
  const ledger = new ContractLedger(contract);
  const store = new P2WorkunitStore(ledger.snapshot());
  const route = store.registerRoute(ROUTE);
  const gate = new P2ModelGate(session, contract.problemHash, contract.contractVersion, maxModelCalls);
  const candidateGate = new P4CandidateGate(contract, policy);

  const requests: unknown[] = [];
  let task: P2Task | null = null;
  let target: ReturnType<typeof p4Target> | null = null;
  let artifact: P2Artifact | null = null;
  let review: P4ReviewSession | null = null;
  let modelCalls = 0;
  let reviewCalls = 0;
  let stop: string = "NO_CANDIDATE";
  let finished = false;

  const finish = (): P4FixtureResult => {
    if (!finished) {
      finished = true;
      if (artifact !== null) {
        const ref: P2ArtifactRef = {
          artifactId: artifact.artifactId,
          artifactVersion: artifact.envelope.artifactVersion ?? 1,
        };
        ledger.recordDelivery(
          artifact.envelope.taskId ?? "",
          ref,
          artifact.deliveryStatus === "COMPLETE" ? "DELIVERED" : "PARTIAL",
          artifact.envelope.eventSeq,
        );
      }
    }
    const decision = candidateGate.finalize(
      ledger.snapshot(),
      target,
      review === null ? null : review.snapshot(),
      remaining(),
    );
    const summary = p2Snapshot({
      mode: "MOCK_ONLY" as const,
      targetEnvironment: "TARGET_UNVERIFIED" as const,
      status: decision.status,
      finalResponse: decision.finalResponse,
      candidateVerified: false as const,
      strictAcceptance: "NOT_PERFORMED" as const,
      policy,
      reason: decision.reason,
      modelCalls,
      reviewCalls,
      unresolvedChallenges: decision.unresolvedChallenges,
      openObligations: decision.openObligations,
      stopReason: stop,
    });
    const privateState = p2Snapshot({
      contract: ledger.snapshot(),
      artifacts: store.snapshot(),
      requests,
      modelGate: gate.snapshot(),
      review: review === null ? null : review.snapshot(),
      decision,
    });
    return p2Snapshot({ summary, privateState }) as P4FixtureResult;
  };

  if (maxModelCalls === 0 || frozenReceipts.length === 0 || remaining() <= LATE_MS) {
    stop = remaining() <= LATE_MS ? "DEADLINE_EXCEEDED" : "NO_CANDIDATE";
    return finish();
  }

  const ready = ledger.readyTasks();
  const chosen = chooseP2ReadyTask(ledger.snapshot(), ready);
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
  try {
    running = ledger.startTask(chosen.taskId);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  task = running;

  let prepared: ReturnType<typeof prepareP2Context>;
  try {
    prepared = prepareP2Context(ledger.snapshot(), running, route, "model-1", [], [], []);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTEXT_REJECTED";
    return finish();
  }
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
  artifact = accepted;

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
  let built: ReturnType<typeof p4Target>;
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
  target = built;

  const cap = Math.min(maxReviews, maxModelCalls - 1);
  if (cap <= 0) {
    stop = "NO_REVIEW";
    return finish();
  }
  review = new P4ReviewSession(ledger.snapshot(), built, cap);
  for (let index = 0; index < cap; index += 1) {
    const receipt = frozenReceipts[index + 1];
    if (receipt === undefined) {
      stop = "FIXTURE_EXHAUSTED";
      return finish();
    }
    if (remaining() <= LATE_MS) {
      stop = "DEADLINE_EXCEEDED";
      return finish();
    }
    const requestId = `model-${index + 2}`;
    let admitted: ReturnType<P4ReviewSession["admit"]>;
    try {
      admitted = review.admit(requestId, remaining());
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      stop = "CONTROL_REJECTED";
      return finish();
    }
    requests.push(
      p2Snapshot({
        requestId,
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
    try {
      gate.admit(running, requestId, remaining());
      gate.markDispatched(requestId);
      review.markDispatched(requestId);
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      stop = "CONTROL_REJECTED";
      return finish();
    }
    requests[requests.length - 1] = p2Snapshot({
      requestId,
      taskId: running.taskId,
      messages: admitted.context.messages,
      contextHash: admitted.context.contextHash,
      contextBytes: admitted.context.contextBytes,
      receipt,
    });
    modelCalls += 1;
    reviewCalls += 1;
    try {
      gate.settle(requestId, receipt.transportStatus);
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      stop = "CONTROL_REJECTED";
      return finish();
    }
    let settled: ReturnType<P4ReviewSession["settle"]>;
    try {
      settled = review.settle(requestId, receipt.transportStatus, receipt.text, remaining());
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      stop = "CONTROL_REJECTED";
      return finish();
    }
    if (settled.code !== "OK" || settled.report === null || settled.report.conclusion === "UNKNOWN") {
      stop = "REVIEW_STOP";
      return finish();
    }
  }
  stop = "REVIEWS_COMPLETE";
  return finish();
}
