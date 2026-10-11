/**
 * @astra/stdio-runtime — P4 S1 mapping-review fixture composition root (pure, no I/O).
 *
 * Composes the real M1 contract/ledger, M2 model gate, M3 workunit store and
 * context preparation, M4 mapping review session, the terminal diagnostic
 * effect gate and the M5 diagnostic ledger over one dependency-free complete
 * candidate artifact. The check representation is an explicit fixture input,
 * not a model-selected action. No client, no network, no new tool. Every
 * candidate stays unverified and no obligation is ever satisfied.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  p4JsonEqual,
  p4Target,
  type P2Artifact,
  type P2ArtifactRef,
  type P2Contract,
  type P2Task,
  type P2TransportStatus,
  type P3Action,
  type P3EffectPort,
  type P3EffectReceipt,
  type P3EffectRequest,
  type P4CheckPlan,
  type P4DeliveryPolicy,
  type P4FinalDecision,
} from "@astra/protocol";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import {
  P2ModelGate,
  P4DiagnosticEffectGate,
  chooseP2ReadyTask,
  parseP3Action,
} from "@astra/math-gateway";
import { P2WorkunitStore, prepareP2Context } from "@astra/math-workunit";
import { P4MappingReviewSession } from "@astra/math-review";
import { P4CandidateGate, P4DiagnosticLedger } from "@astra/math-audit";
import { p3EffectFailure } from "@astra/math-gateway";

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

export interface P4MappingFixtureOptions {
  readonly maxModelCalls: number;
  readonly maxChecks: number;
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

/** The explicit fixture check action: one existing tool representation only. */
function checkActionOf(value: unknown): Extract<P3Action, { action: "tool" }> {
  const frozen = p2Snapshot(value);
  let parsed: P3Action;
  try {
    parsed = parseP3Action(JSON.stringify(frozen));
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (parsed.action !== "tool") {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return p2Snapshot(parsed) as Extract<P3Action, { action: "tool" }>;
}

export function runP4MappingFixture(
  problem: string,
  sessionId: string,
  receipts: readonly P4FixtureReceipt[],
  checkAction: Extract<P3Action, { action: "tool" }>,
  port: P3EffectPort,
  options: P4MappingFixtureOptions,
) {
  const problemText = bounded(problem, 8192);
  const session = bounded(sessionId, 128);
  if (!isPlainObject(options)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const maxModelCalls = safeInt(options.maxModelCalls, 0, 2);
  const maxChecks = safeInt(options.maxChecks, 0, 1);
  const budgetMs = safeInt(options.remainingMs, 1, MAX_REMAINING_MS);
  const policy = options.policy;
  if (policy !== "BEST_EFFORT" && policy !== "STRICT") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const clock = options.now ?? (() => performance.now());
  if (typeof clock !== "function") {
    fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }
  if (!isPlainObject(port) || typeof port.execute !== "function") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const execute = port.execute.bind(port);
  const action = checkActionOf(checkAction);

  if (!Array.isArray(receipts) || receipts.length > MAX_RECEIPTS) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const frozenReceipts: P4FixtureReceipt[] = [];
  for (let index = 0; index < receipts.length; index += 1) {
    const row = exact(p2Snapshot(receipts[index]), ["transportStatus", "text"]);
    frozenReceipts.push(
      Object.freeze({
        transportStatus: transportOf(row.transportStatus),
        text: receiptText(row.text, index > 0 ? MAX_REVIEW_CHARS : MAX_BYTES),
      }),
    );
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
    return left > MAX_REMAINING_MS ? MAX_REMAINING_MS : left;
  };

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
  let mapping: P4MappingReviewSession | null = null;
  let diagnostic: P4DiagnosticLedger | null = null;
  let effectGate: P4DiagnosticEffectGate | null = null;
  let plan: P4CheckPlan | null = null;
  let modelCalls = 0;
  let reviewCalls = 0;
  let checkCalls = 0;
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
    const mappingSnapshot = mapping === null ? null : mapping.snapshot();
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
      checkCalls,
      mappingConclusion: mappingSnapshot?.record?.report?.conclusion ?? "NONE",
      parentProtected: candidateGate.snapshot().protectedTarget !== null,
      unresolvedChallenges: decision.unresolvedChallenges,
      openObligations: decision.openObligations,
      stopReason: stop,
    });
    const privateState = p2Snapshot({
      contract: ledger.snapshot(),
      artifacts: store.snapshot(),
      requests,
      modelGate: gate.snapshot(),
      mapping: mappingSnapshot,
      diagnostic: diagnostic === null ? null : diagnostic.snapshot(),
      effectGate: effectGate === null ? null : effectGate.snapshot(),
      decision,
    });
    return p2Snapshot({ summary, privateState });
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

  if (maxModelCalls < 2 || maxChecks < 1) {
    stop = "NO_REVIEW";
    return finish();
  }
  const second = frozenReceipts[1];
  if (second === undefined) {
    stop = "FIXTURE_EXHAUSTED";
    return finish();
  }

  const boundPlan: P4CheckPlan = p2Snapshot({
    checkId: "check-1",
    target: built.binding,
    targetHash: built.targetHash,
    scope: built.artifact.scope,
    assumptions: built.artifact.packet?.assumptions ?? [],
    checkedProperty:
      action.name === "polynomial_expand_coefficients"
        ? ("SUPPLIED_POLYNOMIAL_COEFFICIENTS" as const)
        : ("SUPPLIED_LINEAR_SOLUTION_SET" as const),
    methodOrToolVersion: "tool-registry-v1" as const,
    obligationIds: [obligation.obligationId],
    request: {
      effectId: "effect-1",
      binding: {
        sessionId: built.binding.sessionId,
        problemHash: built.binding.problemHash,
        contractVersion: built.binding.contractVersion,
        taskId: built.binding.taskId,
        scopeId: built.binding.scopeId,
        sourceRequestId: "model-1",
      },
      action,
      remainingMs: budgetMs,
    },
  }) as P4CheckPlan;
  plan = boundPlan;

  try {
    diagnostic = new P4DiagnosticLedger(ledger.snapshot(), built, 1);
    const precheck = diagnostic.precheck(boundPlan);
    if (!precheck.structuralMatch) {
      stop = "STRUCTURE_REJECTED";
      return finish();
    }
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "STRUCTURE_REJECTED";
    return finish();
  }

  try {
    mapping = new P4MappingReviewSession(ledger.snapshot(), built, boundPlan, 1);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }

  if (remaining() <= LATE_MS) {
    stop = "DEADLINE_EXCEEDED";
    return finish();
  }
  let admitted: ReturnType<P4MappingReviewSession["admit"]>;
  try {
    admitted = mapping.admit(remaining());
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
  try {
    gate.admit(running, "model-2", remaining());
    gate.markDispatched("model-2");
    mapping.markDispatched();
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
  let settled: ReturnType<P4MappingReviewSession["settle"]>;
  try {
    settled = mapping.settle(second.transportStatus, second.text, remaining());
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  if (settled.code !== "OK" || settled.report === null) {
    stop = "MAPPING_STOP";
    return finish();
  }
  if (settled.report.conclusion !== "MATCH") {
    stop = "MAPPING_NOT_MATCH";
    return finish();
  }
  for (const row of settled.report.dimensions) {
    if (row.verdict !== "MATCH") {
      stop = "MAPPING_NOT_MATCH";
      return finish();
    }
  }

  const checkRemaining = remaining();
  if (checkRemaining <= LATE_MS) {
    stop = "DEADLINE_EXCEEDED";
    return finish();
  }
  try {
    effectGate = new P4DiagnosticEffectGate(boundPlan.request, 1);
    effectGate.admit(checkRemaining);
    diagnostic.admit(boundPlan, checkRemaining);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  const effectRequest = effectGate.snapshot()!.request;
  const diagnosticRequest = diagnostic.snapshot()[0]!.plan.request;
  if (!p4JsonEqual(effectRequest, diagnosticRequest)) {
    stop = "CONTROL_REJECTED";
    return finish();
  }
  const dispatchRemaining = remaining();
  if (dispatchRemaining <= LATE_MS) {
    stop = "DEADLINE_EXCEEDED";
    return finish();
  }
  const executionRequest = p2Snapshot({
    ...effectRequest,
    remainingMs: Math.min(effectRequest.remainingMs, dispatchRemaining),
  }) as P3EffectRequest;
  try {
    effectGate.markDispatched();
    diagnostic.markDispatched("check-1");
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  checkCalls += 1;
  requests.push(
    p2Snapshot({
      requestId: "effect-1",
      taskId: running.taskId,
      admittedEffectRequest: effectRequest,
      effectRequest: executionRequest,
      receipt: null,
      receiptCode: "PENDING",
    }),
  );
  let returned: unknown;
  try {
    returned = execute(executionRequest);
  } catch {
    returned = p3EffectFailure(executionRequest, "UNKNOWN");
  }
  let rawReceipt: unknown;
  try {
    rawReceipt = p2Snapshot(returned);
  } catch {
    requests[requests.length - 1] = p2Snapshot({
      requestId: "effect-1",
      taskId: running.taskId,
      admittedEffectRequest: effectRequest,
      effectRequest: executionRequest,
      receipt: null,
      receiptCode: "UNSERIALIZABLE_RECEIPT",
    });
    stop = "CONTROL_REJECTED";
    return finish();
  }
  requests[requests.length - 1] = p2Snapshot({
    requestId: "effect-1",
    taskId: running.taskId,
    admittedEffectRequest: effectRequest,
    effectRequest: executionRequest,
    receipt: rawReceipt,
    receiptCode: "RECEIVED",
  });
  const left = remaining();
  let settledEffect: ReturnType<P4DiagnosticEffectGate["settle"]>;
  try {
    settledEffect = effectGate.settle(rawReceipt, left);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  try {
    diagnostic.settle("check-1", settledEffect.receipt!, left);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
    return finish();
  }
  const effectCode = effectGate.snapshot()!.code;
  stop =
    effectCode === "OBSERVED"
      ? "DIAGNOSTIC_COMPLETE"
      : effectCode === "DEADLINE_EXCEEDED"
        ? "DEADLINE_EXCEEDED"
        : effectCode === "OUTCOME_UNKNOWN"
          ? "OUTCOME_UNKNOWN"
          : "DIAGNOSTIC_ERROR";
  return finish();
}
