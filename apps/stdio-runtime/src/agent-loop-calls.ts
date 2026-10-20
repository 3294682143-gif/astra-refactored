/**
 * @astra/stdio-runtime — unified AgentLoop model/effect call helper.
 *
 * One root AgentSession and one P4RecheckModelGate are shared by every work
 * unit, tool and R2 review of a run. A dispatched call that fails locally is
 * always settled as UNKNOWN on both the gate and the root session, so no
 * pending or dispatched record can be left dangling. No retry, no cancel
 * claim, no raw provider error text.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  p4Hash,
  type AgentModelReceipt,
  type AgentModelRequest,
  type AgentTraceCode,
  type P2MethodCatalog,
  type P2Task,
  type P3Action,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import {
  P3EffectGate,
  p3EffectFailure,
  p3EffectReceipt,
  p3EffectRequest,
} from "@astra/math-gateway";
import type { P4RecheckModelGate } from "@astra/math-gateway";
import { SessionLog, p3MethodCatalog, p3MethodObservation } from "@astra/runtime-core";
import type { AgentSession } from "@astra/runtime-core";
import {
  AGENT_IO_MIN_REMAINING_MS,
  boundedAwait,
  checkedAgentReceipt,
  type CapturedAgentPorts,
} from "./agent-loop-io.js";

export interface AgentModelCallRecord {
  readonly request: AgentModelRequest;
  readonly receipt: AgentModelReceipt | null;
}

export interface AgentEffectCallRecord {
  readonly request: P3EffectRequest;
  readonly receipt: P3EffectReceipt;
}

export interface AgentModelCallOutcome {
  readonly requestId: string;
  readonly receipt: AgentModelReceipt;
  readonly code: AgentTraceCode;
}

export interface AgentModelCallInput {
  readonly task: P2Task;
  readonly phase: "WORK" | "CONSENSUS" | "R2" | "R4" | "REPAIR";
  readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
  readonly contextHash: string;
  readonly contextBytes: number;
  /** Optional already-reserved ordinal for a bounded schema-repair call. */
  readonly requestId?: string;
  readonly onDispatch?: (requestId: string) => void;
}

const MAX_CONTEXT_BYTES = 65536;
const HASH = /^[0-9a-f]{64}$/u;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function unknownReceipt(): AgentModelReceipt {
  return Object.freeze({ transportStatus: "UNKNOWN" as const, text: "" });
}

/**
 * Model and effect calls of one root run. The root session owns the global
 * ordinals and counters; the gate owns the sequential admission ledger.
 */
export class AgentCalls {
  public readonly requests: AgentModelCallRecord[] = [];
  public readonly effects: AgentEffectCallRecord[] = [];

  private readonly root: AgentSession;
  private readonly gate: P4RecheckModelGate;
  private readonly ports: CapturedAgentPorts;
  private readonly sessionLog: SessionLog | null;

  constructor(
    root: AgentSession,
    gate: P4RecheckModelGate,
    ports: CapturedAgentPorts,
    sessionLog: SessionLog | null = null,
  ) {
    this.root = root;
    this.gate = gate;
    this.ports = ports;
    this.sessionLog = sessionLog;
  }

  /**
   * Admit, dispatch and settle one model call. Admission failures throw before
   * any dispatch; every failure after dispatch settles the gate and the root
   * as UNKNOWN and returns a fallback receipt instead of rethrowing.
   */
  async model(input: AgentModelCallInput): Promise<AgentModelCallOutcome> {
    const task = p2Snapshot(input.task) as P2Task;
    const phase = input.phase;
    if (phase !== "WORK" && phase !== "CONSENSUS" && phase !== "R2" && phase !== "R4" && phase !== "REPAIR") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const messages = p2Snapshot(input.messages) as readonly {
      readonly role: "system" | "user";
      readonly content: string;
    }[];
    const contextHash = input.contextHash;
    const contextBytes = input.contextBytes;
    const onDispatch = input.onDispatch;
    if (!Array.isArray(messages) || messages.length !== 2) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const roles = ["system", "user"] as const;
    for (let index = 0; index < 2; index += 1) {
      const message = messages[index];
      if (message === undefined || message.role !== roles[index]) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (typeof message.content !== "string" || message.content.length === 0) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (!detectLoneSurrogates(message.content).ok) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    const serialized = JSON.stringify(messages);
    const actualBytes = Buffer.byteLength(serialized, "utf8");
    if (actualBytes > MAX_CONTEXT_BYTES) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (typeof contextHash !== "string" || !HASH.test(contextHash)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (contextHash !== p4Hash(serialized)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (typeof contextBytes !== "number" || !Number.isSafeInteger(contextBytes) || contextBytes !== actualBytes) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (onDispatch !== undefined && typeof onDispatch !== "function") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }

    const admitRemaining = this.root.remainingMs();
    if (admitRemaining <= AGENT_IO_MIN_REMAINING_MS) {
      fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    const requestId = input.requestId ?? this.nextRequestId();
    const permit = this.gate.admit(task, requestId, admitRemaining, phase);
    // G4/PR5 Slice 4a: the request identity is projected from the SessionLog;
    // the log records the exact model-visible context and its hash.
    this.sessionLog?.append("MODEL_REQUEST", {
      phase,
      requestId,
      contextHash,
      contextBytes,
      messages,
    });
    const baseRequest = p2Snapshot({
      sessionId: this.root.sessionId,
      problemHash: this.root.problemHash,
      requestId,
      phase,
      taskId: task.taskId,
      scopeId: task.scopeId,
      messages,
      contextHash,
      contextBytes,
      remainingMs: admitRemaining,
      maxTokens: 8192 as const,
    }) as AgentModelRequest;
    const record: AgentModelCallRecord = { request: baseRequest, receipt: null };
    this.requests.push(record);

    this.root.reserveModel(phase);
    this.gate.markDispatched(requestId);
    try {
      if (onDispatch !== undefined) {
        onDispatch(requestId);
      }
    } catch {
      return this.settleUnknown({ request: baseRequest, receipt: null }, requestId);
    }

    const freshRemaining = this.root.remainingMs();
    if (freshRemaining <= AGENT_IO_MIN_REMAINING_MS) {
      return this.settleUnknown(record, requestId);
    }
    const request: AgentModelRequest = p2Snapshot({
      ...baseRequest,
      remainingMs: freshRemaining,
    }) as AgentModelRequest;
    this.requests[this.requests.length - 1] = { request, receipt: null };

    let raw: unknown;
    try {
      raw = await boundedAwait(() => this.ports.model.generate(request), freshRemaining);
    } catch {
      return this.settleUnknown({ request, receipt: null }, requestId);
    }
    let receipt: AgentModelReceipt;
    try {
      receipt = checkedAgentReceipt(raw);
    } catch {
      return this.settleUnknown({ request, receipt: null }, requestId);
    }
    if (receipt.remainingMs !== undefined) {
      this.root.tightenRemaining(receipt.remainingMs);
    }
    this.gate.settle(requestId, receipt.transportStatus);
    this.root.settleModel(requestId, receipt.transportStatus);
    this.requests[this.requests.length - 1] = { request, receipt };
    if (receipt.transportStatus !== "COMPLETE") {
      return { requestId, receipt, code: "STOPPED" };
    }
    if (this.root.remainingMs() <= AGENT_IO_MIN_REMAINING_MS) {
      return { requestId, receipt, code: "DEADLINE_EXCEEDED" };
    }
    return { requestId, receipt, code: phase };
  }

  /**
   * Admit, dispatch and settle one tool effect. A cached action returns the
   * stored receipt without a new global effect call. Every failure after
   * dispatch settles both the effect gate and the root as UNKNOWN.
   */
  async effect(
    task: P2Task,
    sourceRequestId: string,
    action: Extract<P3Action, { action: "tool" | "method" }>,
    effectGate: P3EffectGate,
    remainingModelCalls: number,
    catalog?: P2MethodCatalog,
  ): Promise<P3EffectReceipt> {
    const frozenTask = p2Snapshot(task) as P2Task;
    const port = this.ports.effect;
    if (port === null) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    let frozenCatalog: P2MethodCatalog | null = null;
    if (action.action === "method") {
      if (catalog === undefined) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      try {
        frozenCatalog = p3MethodCatalog(p2Snapshot(catalog));
      } catch {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (!frozenCatalog.entries.some((entry) => entry.id === action.id)) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    const turns = Math.min(3, Math.max(1, remainingModelCalls + 1));
    const admitted = effectGate.admit(
      action,
      {
        sessionId: this.root.sessionId,
        problemHash: this.root.problemHash,
        contractVersion: frozenTask.envelope.contractVersion,
        taskId: frozenTask.taskId,
        scopeId: frozenTask.scopeId,
        sourceRequestId,
      },
      turns,
      this.root.remainingMs(),
    );
    if (admitted.status === "CACHED") {
      return admitted.receipt;
    }
    const admittedRequest = admitted.request;
    this.root.reserveEffect(admittedRequest.effectId);
    effectGate.markDispatched(admittedRequest.effectId);
    const freshRemaining = this.root.remainingMs();
    if (freshRemaining <= AGENT_IO_MIN_REMAINING_MS) {
      return this.settleEffectUnknown(admittedRequest, effectGate);
    }
    const request = p3EffectRequest({
      ...admittedRequest,
      remainingMs: Math.min(admittedRequest.remainingMs, freshRemaining),
    });
    let raw: unknown;
    try {
      raw = await boundedAwait(() => port.execute(request), request.remainingMs);
    } catch {
      return this.settleEffectUnknown(request, effectGate);
    }
    let receipt: P3EffectReceipt;
    try {
      receipt = p3EffectReceipt(raw, request);
    } catch {
      return this.settleEffectUnknown(request, effectGate);
    }
    if (request.action.action === "method" && frozenCatalog !== null) {
      try {
        p3MethodObservation(receipt, request, frozenCatalog);
      } catch {
        return this.settleEffectUnknown(request, effectGate);
      }
    }
    effectGate.settle(receipt);
    this.root.settleEffect(request.effectId, receipt.status);
    this.effects.push({ request, receipt });
    return receipt;
  }

  private nextRequestId(): string {
    const id = this.root.nextModelId();
    if (id === null) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    return id;
  }

  private settleUnknown(record: AgentModelCallRecord, requestId: string): AgentModelCallOutcome {
    const receipt = unknownReceipt();
    try {
      this.gate.settle(requestId, "UNKNOWN");
    } catch {
      // The gate already stopped; the root still records the unknown outcome.
    }
    try {
      this.root.settleModel(requestId, "UNKNOWN");
    } catch {
      // The root already stopped; no pending record may be left behind.
    }
    this.requests[this.requests.length - 1] = { request: record.request, receipt };
    return { requestId, receipt, code: "PORT_REJECTED" };
  }

  private settleEffectUnknown(request: P3EffectRequest, effectGate: P3EffectGate): P3EffectReceipt {
    const receipt = p3EffectFailure(request, "UNKNOWN");
    try {
      effectGate.settle(receipt);
    } catch {
      // The gate already stopped; the root still records the unknown outcome.
    }
    try {
      this.root.settleEffect(request.effectId, "UNKNOWN");
    } catch {
      // The root already stopped; no pending record may be left behind.
    }
    this.effects.push({ request, receipt });
    return receipt;
  }
}
