/**
 * @astra/stdio-runtime — P4 R0/WORK shared-root fixture composition root (pure, no I/O).
 *
 * Composes the real M1 contract/ledger, the shared M2 R0/WORK model gate, the
 * real M4 R0 review session, the M3 workunit store/context and the M5 S3
 * candidate gate over one dependency-free complete candidate artifact. R0 runs
 * before any task is started, so the R0 plan binding is the pristine initial
 * plan and the WORK admission needs a real RUNNING M1 task. No client, no
 * network, no tool execution, no nested legacy runner and no root refresh.
 * Every candidate stays unverified and no obligation is ever satisfied.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  p4Hash,
  p4Target,
  type P2Artifact,
  type P2ArtifactRef,
  type P2Contract,
  type P2Task,
  type P2TransportStatus,
  type P4DeliveryPolicy,
  type P4FinalDecision,
  type P4R0Preparation,
} from "@astra/protocol";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P4R0ModelGate, chooseP2ReadyTask } from "@astra/math-gateway";
import { P2WorkunitStore, prepareP2Context } from "@astra/math-workunit";
import { P4R0ReviewSession } from "@astra/math-review";
import { P4CandidateGate } from "@astra/math-audit";
import { prepareP4R0 } from "@astra/math-contract";

const MAX_RECEIPTS = 2;
const MAX_BYTES = 65536;
const MAX_REVIEW_CHARS = 20000;
const MAX_REMAINING_MS = 5000;
const LATE_MS = 25;
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

export interface P4R0FixtureOptions {
  readonly maxModelCalls?: number;
  readonly r0Enabled?: boolean;
  readonly planningPercent?: number;
  readonly remainingMs: number;
  readonly policy: P4DeliveryPolicy;
  readonly now?: () => number;
}

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
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

function safeInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function bounded(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > max) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return value;
}

function transportOf(value: unknown): P2TransportStatus {
  if (value !== "COMPLETE" && value !== "TRUNCATED" && value !== "ERROR" && value !== "UNKNOWN") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

function receiptText(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || !detectLoneSurrogates(value).ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if ([...value].length > maxChars || Buffer.byteLength(value, "utf8") > MAX_BYTES) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

/** Read one keyed receipt slot; a missing slot stays `null` and is never reused. */
function readReceipt(value: unknown, maxChars: number): P4FixtureReceipt | null {
  if (value === undefined) {
    return null;
  }
  const row = exact(p2Snapshot(value), ["transportStatus", "text"]);
  return Object.freeze({
    transportStatus: transportOf(row.transportStatus),
    text: receiptText(row.text, maxChars),
  });
}

const OPTION_KEYS = [
  "maxModelCalls",
  "r0Enabled",
  "planningPercent",
  "remainingMs",
  "policy",
  "now",
] as const;

const RECEIPT_KEYS = ["r0", "work"] as const;

export function runP4R0Fixture(
  problem: string,
  sessionId: string,
  receipts: { readonly r0?: P4FixtureReceipt; readonly work?: P4FixtureReceipt },
  options: P4R0FixtureOptions,
) {
  const problemText = bounded(problem, 8192);
  const session = bounded(sessionId, 128);
  if (!isPlainObject(options)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const optionSource = options as Record<string, unknown>;
  for (const key of Object.keys(optionSource)) {
    if (!(OPTION_KEYS as readonly string[]).includes(key)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  const requestedCalls = optionSource.maxModelCalls;
  const requestedEnabled = optionSource.r0Enabled;
  const requestedPercent = optionSource.planningPercent;
  const requestedClock = optionSource.now;
  const requestedMs = optionSource.remainingMs;
  const requestedPolicy = optionSource.policy;
  const maxModelCalls = requestedCalls === undefined ? 1 : safeInt(requestedCalls, 0, 4);
  const r0Enabled = requestedEnabled === undefined ? false : requestedEnabled;
  if (typeof r0Enabled !== "boolean") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const planningPercent =
    requestedPercent === undefined ? 25 : safeInt(requestedPercent, 0, 100);
  const budgetMs = safeInt(requestedMs, 1, MAX_REMAINING_MS);
  const policy = requestedPolicy;
  if (policy !== "BEST_EFFORT" && policy !== "STRICT") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const clock = requestedClock === undefined ? () => performance.now() : requestedClock;
  if (typeof clock !== "function") {
    fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }

  if (!isPlainObject(receipts)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const receiptSource = receipts as Record<string, unknown>;
  for (const key of Object.keys(receiptSource)) {
    if (!(RECEIPT_KEYS as readonly string[]).includes(key)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  const r0Receipt = readReceipt(receiptSource.r0, MAX_REVIEW_CHARS);
  const workReceipt = readReceipt(receiptSource.work, MAX_BYTES);

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
    return left > MAX_REMAINING_MS ? MAX_REMAINING_MS : left;
  };

  const initialContract = compileP2Contract(problemText, session);
  const ledger = new ContractLedger(initialContract);
  const store = new P2WorkunitStore(ledger.snapshot());
  const route = store.registerRoute(ROUTE);
  const gate = new P4R0ModelGate(
    {
      sessionId: initialContract.envelope.sessionId,
      problemHash: initialContract.problemHash,
      contractVersion: initialContract.contractVersion,
      planHash: p4Hash(JSON.stringify(initialContract)),
    },
    maxModelCalls,
    planningPercent,
  );
  const candidateGate = new P4CandidateGate(initialContract, policy);

  const requests: unknown[] = [];
  let preparation: P4R0Preparation | null = null;
  let r0: P4R0ReviewSession | null = null;
  let task: P2Task | null = null;
  let target: ReturnType<typeof p4Target> | null = null;
  let artifact: P2Artifact | null = null;
  let modelCalls = 0;
  let r0Calls = 0;
  let workCalls = 0;
  let r0Action = "NONE";
  let r0Conclusion = "NONE";
  let stop = "NO_CANDIDATE";
  let finished = false;

  const finish = () => {
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
    const decision: P4FinalDecision = candidateGate.finalize(
      ledger.snapshot(),
      target,
      null,
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
      r0Calls,
      workCalls,
      rootMaxModelCalls: maxModelCalls,
      planningPercent,
      planningAllowance: gate.planningAllowance(),
      r0Action,
      r0Conclusion,
      parentProtected: candidateGate.snapshot().protectedTarget !== null,
      unresolvedChallenges: decision.unresolvedChallenges,
      openObligations: decision.openObligations,
      stopReason: stop,
    });
    const privateState = p2Snapshot({
      initialContract,
      contract: ledger.snapshot(),
      preparation,
      r0: r0 === null ? null : r0.snapshot(),
      requests,
      events: ledger.eventsSnapshot(),
      artifacts: store.snapshot(),
      modelGate: gate.snapshot(),
      decision,
    });
    return p2Snapshot({ summary, privateState });
  };

  try {
    if (remaining() <= LATE_MS) {
      stop = "DEADLINE_EXCEEDED";
      return finish();
    }

    const prep = prepareP4R0(ledger.snapshot(), {
      enabled: r0Enabled,
      planningModelCalls: gate.planningAllowance(),
      remainingRootCalls: maxModelCalls,
      remainingMs: remaining(),
    });
    preparation = prep;
    r0Action = prep.action;

    if (prep.action === "REQUEST_REVIEW") {
      if (r0Receipt === null) {
        stop = "FIXTURE_EXHAUSTED";
        return finish();
      }
      const review = new P4R0ReviewSession(prep, 1);
      r0 = review;
      const admitted = review.admit(remaining(), maxModelCalls);
      requests.push(
        p2Snapshot({
          requestId: "model-1",
          phase: "R0",
          taskId: null,
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
      gate.admitR0(prep, remaining());
      gate.markDispatched("model-1");
      review.markDispatched();
      requests[requests.length - 1] = p2Snapshot({
        requestId: "model-1",
        phase: "R0",
        taskId: null,
        messages: admitted.context.messages,
        contextHash: admitted.context.contextHash,
        contextBytes: admitted.context.contextBytes,
        receipt: r0Receipt,
      });
      modelCalls += 1;
      r0Calls += 1;
      gate.settle("model-1", r0Receipt.transportStatus);
      const settled = review.settle(r0Receipt.transportStatus, r0Receipt.text, remaining());
      r0Conclusion = settled.report === null ? "NONE" : settled.report.conclusion;
      if (
        settled.code !== "OK" ||
        settled.report === null ||
        settled.report.conclusion !== "NO_ISSUE"
      ) {
        stop = "R0_STOP";
        return finish();
      }
    }

    if (remaining() <= LATE_MS) {
      stop = "DEADLINE_EXCEEDED";
      return finish();
    }
    if (workReceipt === null) {
      stop = "FIXTURE_EXHAUSTED";
      return finish();
    }
    if (maxModelCalls - (r0Calls === 0 ? 0 : 1) < 1) {
      stop = "BUDGET_EXHAUSTED";
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

    const running = ledger.startTask(chosen.taskId);
    task = running;
    const requestId = r0Calls === 0 ? "model-1" : "model-2";

    const prepared = prepareP2Context(ledger.snapshot(), running, route, requestId, [], [], []);
    requests.push(
      p2Snapshot({
        requestId,
        phase: "WORK",
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
    gate.admitWork(running, remaining());
    gate.markDispatched(requestId);
    requests[requests.length - 1] = p2Snapshot({
      requestId,
      phase: "WORK",
      taskId: running.taskId,
      messages: prepared.messages,
      contextHash: prepared.contextHash,
      contextBytes: prepared.contextBytes,
      receipt: workReceipt,
    });
    modelCalls += 1;
    workCalls += 1;
    gate.settle(requestId, workReceipt.transportStatus);

    const accepted = store.accept(running, {
      artifactId: "artifact-1",
      routeId: "route-1",
      sourceRequestId: requestId,
      transportStatus: workReceipt.transportStatus,
      text: workReceipt.text,
      eventSeq: ledger.nextEventSeq(),
      supersedes: null,
    });
    artifact = accepted;

    if (
      accepted.deliveryStatus !== "COMPLETE" ||
      store.candidate({
        artifactId: accepted.artifactId,
        artifactVersion: accepted.envelope.artifactVersion ?? 1,
      }) === null
    ) {
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
    const built = p4Target(ledger.snapshot(), accepted, "ACTIVE");
    candidateGate.protect(built);
    target = built;
    stop = "CANDIDATE_PROTECTED";
    return finish();
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = error.code;
    return finish();
  }
}
