/**
 * P3 finite-action offline fixture runner. Pure fixture composition of the
 * existing M1/M2/M3 modules; no network, no real ModelPort, no verification.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  P2_TRANSPORT_STATUS,
  detectLoneSurrogates,
  p2Snapshot,
  type P2Contract,
  type P2Task,
  type P2TransportStatus,
  type P3Action,
  type P3EffectPort,
  type P3EffectReceipt,
} from "@astra/protocol";
import { compileP2Contract } from "@astra/math-contract";
import { ContractLedger } from "@astra/math-contract";
import { P2ModelGate, P3EffectGate, chooseP2ReadyTask } from "@astra/math-gateway";
import { parseP3Action } from "@astra/math-gateway";
import { p3EffectFailure, p3EffectReceipt } from "@astra/math-gateway";
import { prepareP3Context, type P3ContextHistoryEntry } from "@astra/math-workunit";

export const P3_FIXTURE_MODE = "MOCK_ONLY" as const;
export const P3_FIXTURE_TARGET = "TARGET_UNVERIFIED" as const;
export const P3_FIXTURE_STRICT_ACCEPTANCE = "NOT_PERFORMED" as const;
export const P3_FIXTURE_MAX_TEXT_CHARS = 20000 as const;
export const P3_FIXTURE_MAX_TEXT_BYTES = 65536 as const;

export interface P3FixtureReceipt {
  readonly transportStatus: P2TransportStatus;
  readonly text: string;
}

export interface P3FixtureOptions {
  readonly maxTurns: number;
  readonly maxEffects: number;
  readonly remainingMs: number;
  readonly effectPort: P3EffectPort | null;
  readonly now?: () => number;
}

export interface P3FixtureTraceEntry {
  readonly turn: number;
  readonly requestId: string;
  readonly event: "PROPOSED" | "ADMITTED" | "DISPATCHED" | "OBSERVED" | "CACHED" | "UNKNOWN";
  readonly code: string;
}

export interface P3FixturePublic {
  readonly mode: typeof P3_FIXTURE_MODE;
  readonly target: typeof P3_FIXTURE_TARGET;
  readonly strictAcceptance: typeof P3_FIXTURE_STRICT_ACCEPTANCE;
  readonly candidateVerified: false;
  readonly status: "candidate" | "unsolved";
  readonly codes: readonly string[];
  readonly counts: {
    readonly turns: number;
    readonly effects: number;
    readonly cached: number;
    readonly unknown: number;
  };
  readonly trace: readonly P3FixtureTraceEntry[];
  readonly candidate: string | null;
}

export interface P3FixturePrivate {
  readonly contract: P2Contract;
  readonly task: P2Task;
  readonly requests: readonly {
    readonly requestId: string;
    readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
    readonly contextHash: string;
    readonly contextBytes: number;
    readonly receipt: P3FixtureReceipt | null;
  }[];
  readonly receipts: readonly P3EffectReceipt[];
  readonly modelGate: readonly unknown[];
  readonly effectGate: readonly unknown[];
}

export interface P3FixtureResult {
  readonly public: P3FixturePublic;
  readonly private: P3FixturePrivate;
}

const REQUEST_IDS = ["model-1", "model-2", "model-3"] as const;
const CANDIDATE_OBLIGATIONS = ["CANDIDATE_VALIDITY", "ANSWER_REQUEST"] as const;
const MIN_REMAINING_MS = 25;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function boundedInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function checkReceipts(receipts: readonly P3FixtureReceipt[]): readonly P3FixtureReceipt[] {
  const source = p2Snapshot(receipts);
  if (!Array.isArray(source) || source.length > 3) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const out: P3FixtureReceipt[] = [];
  for (const receipt of source) {
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const keys = Object.keys(receipt);
    if (keys.length !== 2 || !keys.includes("transportStatus") || !keys.includes("text")) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!(P2_TRANSPORT_STATUS as readonly string[]).includes(receipt.transportStatus)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const text = receipt.text;
    if (typeof text !== "string" || !detectLoneSurrogates(text).ok) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if ([...text].length > P3_FIXTURE_MAX_TEXT_CHARS || Buffer.byteLength(text, "utf8") > P3_FIXTURE_MAX_TEXT_BYTES) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    out.push(p2Snapshot({ transportStatus: receipt.transportStatus, text }) as P3FixtureReceipt);
  }
  return p2Snapshot(out) as readonly P3FixtureReceipt[];
}

function pickTask(contract: P2Contract, ready: readonly P2Task[]): P2Task {
  const chosen = chooseP2ReadyTask(contract, ready);
  if (chosen === null) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const obligation = contract.obligations.find((item) => item.obligationId === chosen.obligationId);
  if (obligation === undefined || !(CANDIDATE_OBLIGATIONS as readonly string[]).includes(obligation.kind)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return chosen;
}

export function runP3Fixture(
  problem: string,
  sessionId: string,
  receipts: readonly P3FixtureReceipt[],
  options: P3FixtureOptions,
): P3FixtureResult {
  const maxTurns = boundedInt(options.maxTurns, 0, 3);
  const maxEffects = boundedInt(options.maxEffects, 0, 2);
  const remainingMs = boundedInt(options.remainingMs, 1, 5000);
  const rawPort = options.effectPort;
  const port: P3EffectPort | null =
    rawPort === null || rawPort === undefined
      ? null
      : (Object.freeze({ execute: rawPort.execute.bind(rawPort) }) as P3EffectPort);
  const clock = options.now ?? (() => performance.now());
  const readClock = (): number => {
    let value: unknown;
    try {
      value = clock();
    } catch {
      fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    return value;
  };
  const started = readClock();
  const deadline = started + remainingMs;
  let lastNow = started;
  const remaining = (): number => {
    let now: unknown;
    try {
      now = clock();
    } catch {
      return 0;
    }
    if (typeof now !== "number" || !Number.isFinite(now) || now < lastNow) {
      return 0;
    }
    lastNow = now;
    return Math.floor(deadline - now);
  };
  const checked = checkReceipts(receipts);
  const contract = compileP2Contract(problem, sessionId);
  const ledger = new ContractLedger(contract);
  const task = ledger.startTask(pickTask(contract, ledger.readyTasks()).taskId);
  const modelGate = new P2ModelGate(sessionId, contract.problemHash, contract.contractVersion, maxTurns);
  const effectGate = new P3EffectGate(
    {
      sessionId,
      problemHash: contract.problemHash,
      contractVersion: contract.contractVersion,
      taskId: task.taskId,
      scopeId: task.scopeId,
    },
    maxEffects,
  );
  const trace: P3FixtureTraceEntry[] = [];
  const codes: string[] = [];
  const requests: {
    requestId: string;
    messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
    contextHash: string;
    contextBytes: number;
    receipt: P3FixtureReceipt | null;
  }[] = [];
  const effects: P3EffectReceipt[] = [];
  const history: P3ContextHistoryEntry[] = [];
  let candidate: string | null = null;
  let cached = 0;
  let unknown = 0;
  let turns = 0;
  let stopped = false;

  for (let index = 0; index < maxTurns && !stopped; index += 1) {
    const requestId = REQUEST_IDS[index]!;
    const left = remaining();
    if (left <= MIN_REMAINING_MS) {
      codes.push("DEADLINE_EXCEEDED");
      break;
    }
    const receipt = checked[index];
    if (receipt === undefined) {
      codes.push("FIXTURE_EXHAUSTED");
      break;
    }
    const allowed = effectGate.allowedActionIds(maxTurns - index, left);
    let context;
    try {
      context = prepareP3Context(contract, task, requestId, allowed, effects, history);
    } catch {
      codes.push("CONTEXT_REJECTED");
      break;
    }
    requests.push({
      requestId,
      messages: context.messages,
      contextHash: context.contextHash,
      contextBytes: context.contextBytes,
      receipt: null,
    });
    const slot = requests[requests.length - 1]!;
    const afterContext = remaining();
    if (afterContext <= MIN_REMAINING_MS) {
      codes.push("DEADLINE_EXCEEDED");
      break;
    }
    let permit;
    try {
      permit = modelGate.admit(task, requestId, afterContext);
    } catch {
      codes.push("BUDGET_EXHAUSTED");
      break;
    }
    modelGate.markDispatched(permit.requestId);
    slot.receipt = receipt;
    modelGate.settle(permit.requestId, receipt.transportStatus);
    turns += 1;
    if (receipt.transportStatus !== "COMPLETE") {
      codes.push("TRANSPORT_INCOMPLETE");
      break;
    }
    if (remaining() <= MIN_REMAINING_MS) {
      codes.push("DEADLINE_EXCEEDED");
      break;
    }
    let action: P3Action;
    try {
      action = parseP3Action(receipt.text);
    } catch {
      codes.push("PACKET_SCHEMA");
      break;
    }
    trace.push({ turn: index + 1, requestId, event: "PROPOSED", code: action.action });
    if (action.action === "final") {
      if (remaining() <= MIN_REMAINING_MS) {
        codes.push("DEADLINE_EXCEEDED");
        break;
      }
      if (action.complete && action.unresolved.length === 0) {
        candidate = action.answer;
      }
      codes.push("FINAL");
      break;
    }
    if (action.action === "unsolved") {
      codes.push("UNSOLVED");
      break;
    }
    const effectMs = remaining();
    if (effectMs <= MIN_REMAINING_MS) {
      codes.push("DEADLINE_EXCEEDED");
      break;
    }
    let admitted;
    try {
      admitted = effectGate.admit(
        action,
        {
          sessionId,
          problemHash: contract.problemHash,
          contractVersion: contract.contractVersion,
          taskId: task.taskId,
          scopeId: task.scopeId,
          sourceRequestId: requestId,
        },
        maxTurns - index,
        effectMs,
      );
    } catch {
      codes.push("BUDGET_EXHAUSTED");
      break;
    }
    if (admitted.status === "CACHED") {
      cached += 1;
      trace.push({ turn: index + 1, requestId, event: "CACHED", code: "CACHED" });
      history.push({ requestId, transportStatus: "COMPLETE", text: receipt.text });
      continue;
    }
    trace.push({ turn: index + 1, requestId, event: "ADMITTED", code: admitted.request.effectId });
    if (port === null) {
      codes.push("EFFECT_UNAVAILABLE");
      break;
    }
    if (remaining() <= MIN_REMAINING_MS) {
      codes.push("DEADLINE_EXCEEDED");
      break;
    }
    effectGate.markDispatched(admitted.request.effectId);
    trace.push({ turn: index + 1, requestId, event: "DISPATCHED", code: admitted.request.effectId });
    let raw: unknown;
    try {
      raw = port.execute(admitted.request);
    } catch {
      raw = p3EffectFailure(admitted.request, "UNKNOWN");
    }
    let settled: P3EffectReceipt;
    try {
      settled = p3EffectReceipt(raw, admitted.request);
    } catch {
      settled = p3EffectFailure(admitted.request, "UNKNOWN");
    }
    const afterEffect = remaining();
    if (afterEffect <= MIN_REMAINING_MS && settled.status !== "UNKNOWN") {
      settled = p3EffectFailure(admitted.request, "ERROR");
      codes.push("DEADLINE_EXCEEDED");
      stopped = true;
    }
    let record;
    try {
      record = effectGate.settle(settled);
    } catch {
      record = effectGate.settle(p3EffectFailure(admitted.request, "UNKNOWN"));
    }
    const finalReceipt = record.receipt;
    if (finalReceipt === null) {
      codes.push("EFFECT_FAILED");
      break;
    }
    if (record.state === "OUTCOME_UNKNOWN") {
      unknown += 1;
      trace.push({ turn: index + 1, requestId, event: "UNKNOWN", code: "UNKNOWN" });
      codes.push("OUTCOME_UNKNOWN");
      stopped = true;
      break;
    }
    if (stopped) {
      trace.push({ turn: index + 1, requestId, event: "OBSERVED", code: "DEADLINE_EXCEEDED" });
      break;
    }
    effects.push(finalReceipt);
    trace.push({ turn: index + 1, requestId, event: "OBSERVED", code: finalReceipt.status });
    history.push({ requestId, transportStatus: "COMPLETE", text: receipt.text });
  }

  if (codes.length === 0) {
    codes.push("BUDGET_EXHAUSTED");
  }

  return p2Snapshot({
    public: {
      mode: P3_FIXTURE_MODE,
      target: P3_FIXTURE_TARGET,
      strictAcceptance: P3_FIXTURE_STRICT_ACCEPTANCE,
      candidateVerified: false,
      status: candidate === null ? "unsolved" : "candidate",
      codes,
      counts: { turns, effects: effectGate.snapshot().length, cached, unknown },
      trace,
      candidate,
    },
    private: {
      contract: ledger.snapshot(),
      task,
      requests,
      receipts: effects,
      modelGate: modelGate.snapshot(),
      effectGate: effectGate.snapshot(),
    },
  }) as P3FixtureResult;
}
