/**
 * @astra/stdio-runtime — P3 local Host flow controller (Node side only).
 *
 * Owns the init -> solve -> model|effect -> stop -> done state machine, the
 * trusted bindings, the M1 contract/ledger, the M2 model gate, the P3 effect
 * gate and the M3 context preparation. It performs no I/O of its own: every
 * frame goes through the injected `P3HostIO`, which the caller binds to the
 * existing single-reader channel. No parser, gate or context builder is
 * re-implemented here.
 */
import {
  P2_ERROR_CODES,
  P2Error,
  P3_TOOL_NAMES,
  p2Snapshot,
  p3HostPayload,
  P3_EMPTY_METHOD_CATALOG,
  type JsonRpcMessage,
  type P2Contract,
  type P2MethodCatalog,
  type P2Task,
  type P3Action,
  type P3Binding,
  type P3EffectReceipt,
  type P3EffectRequest,
  type P3HostManifest,
  type P3HostMethod,
} from "@astra/protocol";
import { compileP2Contract, p2ProblemHashOf } from "@astra/math-contract";
import { ContractLedger } from "@astra/math-contract";
import { P2ModelGate, chooseP2ReadyTask } from "@astra/math-gateway";
import { P3EffectGate, p3EffectFailure, p3EffectReceipt, parseP3Action } from "@astra/math-gateway";
import { p3MethodCatalog, p3MethodObservation } from "@astra/runtime-core";
import { prepareP3Context, type P3ContextHistoryEntry } from "@astra/math-workunit";

const MAX_DEADLINE_MS = 5000;
const MIN_REMAINING_MS = 25;
const MAX_FRAME_BYTES = 65536;
const MAX_TOKENS = 8192;
const TEMPERATURE = "0.2";
const REQUEST_IDS = ["model-1", "model-2", "model-3"] as const;
const EFFECT_IDS = ["effect-1", "effect-2"] as const;
const STOP_REASONS = [
  "FINAL", "UNSOLVED", "FIXTURE_EXHAUSTED", "BUDGET_EXHAUSTED", "TRANSPORT_STOP",
  "ACTION_REJECTED", "EFFECT_UNAVAILABLE", "EFFECT_UNKNOWN", "DEADLINE_EXCEEDED",
  "CONTEXT_REJECTED",
] as const;
type StopReason = (typeof STOP_REASONS)[number];

/** Transport surface injected by the caller; the flow never touches stdio. */
export interface P3HostIO {
  remainingMs(): number;
  tighten(ms: number): void;
  send(message: JsonRpcMessage, method: P3HostMethod): void;
  stop(message: JsonRpcMessage): void;
}

interface PrivateModelRequest {
  readonly requestId: string;
  readonly params: Record<string, unknown>;
  readonly contextHash: string;
  receipt: { readonly deliveryStatus: string; readonly text: string } | null;
}

interface PrivateEffectRequest {
  readonly effectId: string;
  readonly request: P3EffectRequest;
}

function fail(code: string): never {
  throw new Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wireBytes(message: JsonRpcMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

export class P3HostFlow {
  private readonly manifest: P3HostManifest;
  private readonly io: P3HostIO;
  private phase: "init" | "solve" | "catalog" | "model" | "effect" | "stop" | "done" = "init";
  private sessionId = "";
  private problem = "";
  private problemHash = "";
  private contract: P2Contract | null = null;
  private ledger: ContractLedger | null = null;
  private task: P2Task | null = null;
  private modelGate: P2ModelGate | null = null;
  private effectGate: P3EffectGate | null = null;
  private maxCalls = 0;
  private maxEffects = 0;
  private maxMethodLoads = 0;
  private modelCalls = 0;
  private effectCalls = 0;
  private cachedEffects = 0;
  private catalogCalls = 0;
  private methodLoads = 0;
  private catalog: P2MethodCatalog = P3_EMPTY_METHOD_CATALOG;
  private history: P3ContextHistoryEntry[] = [];
  private effects: P3EffectReceipt[] = [];
  private privateRequests: PrivateModelRequest[] = [];
  private pendingEffect: PrivateEffectRequest | null = null;
  private lastContextHash: string | null = null;
  private candidateRequestId: string | null = null;
  private finalResponse = "Unsolved.";
  private stopReason: StopReason = "FIXTURE_EXHAUSTED";
  private stopped = false;

  constructor(manifest: P3HostManifest, io: P3HostIO) {
    this.manifest = manifest;
    this.io = io;
  }

  /** Private debug view; never triggers I/O and never leaves this process. */
  snapshot(): Record<string, unknown> {
    return p2Snapshot({
      phase: this.phase,
      sessionId: this.sessionId,
      problemHash: this.problemHash,
      contract: this.ledger?.snapshot() ?? null,
      task: this.task,
      modelGate: this.modelGate?.snapshot() ?? null,
      effectGate: this.effectGate?.snapshot() ?? null,
      modelCalls: this.modelCalls,
      effectCalls: this.effectCalls,
      cachedEffects: this.cachedEffects,
      catalogCalls: this.catalogCalls,
      methodLoads: this.methodLoads,
      catalog: this.catalog,
      history: this.history,
      effects: this.effects,
      privateRequests: this.privateRequests,
      pendingEffect: this.pendingEffect,
      lastContextHash: this.lastContextHash,
      candidateRequestId: this.candidateRequestId,
      stopReason: this.stopReason,
    }) as Record<string, unknown>;
  }

  handle(message: JsonRpcMessage): void {
    if (this.phase === "done") fail("FIELD_VALUE");
    if ("error" in message) fail("FIELD_VALUE");
    if ("method" in message) {
      const method = message.method;
      const params = message.params;
      if (!isPlainObject(params)) fail("FIELD_VALUE");
      if (method === "runtime.initialize") {
        if (this.phase !== "init" || message.id !== "host-1") fail("ID_MISMATCH");
        p3HostPayload(this.manifest, "runtime.initialize", "params", params);
        this.onInitialize(message.id, params);
        return;
      }
      if (method === "session.solve") {
        if (this.phase !== "solve" || message.id !== "host-2") fail("ID_MISMATCH");
        p3HostPayload(this.manifest, "session.solve", "params", params, this.sessionId);
        this.onSolve(message.id, params);
        return;
      }
      if (method === "session.stop") {
        if (this.phase !== "stop" || message.id !== "host-3") fail("ID_MISMATCH");
        p3HostPayload(this.manifest, "session.stop", "params", params, this.sessionId);
        this.onStop(message.id, params);
        return;
      }
      fail("UNKNOWN_METHOD");
    }
    if (!("result" in message)) fail("FIELD_VALUE");
    const result = message.result;
    if (!isPlainObject(result)) fail("FIELD_VALUE");
    if (this.phase === "model") {
      p3HostPayload(this.manifest, "model.generate", "result", result, this.sessionId);
      this.onModel(message.id, result);
      return;
    }
    if (this.phase === "catalog") {
      p3HostPayload(this.manifest, "method.catalog", "result", result, this.sessionId);
      this.onCatalog(message.id, result);
      return;
    }
    if (this.phase === "effect") {
      const pending = this.pendingEffect;
      if (pending === null) fail("FIELD_VALUE");
      const wire = pending.request.action.action === "method" ? "method.load" : "tool.execute";
      p3HostPayload(this.manifest, wire, "result", result, this.sessionId);
      this.onEffect(message.id, result);
      return;
    }
    fail("ID_MISMATCH");
  }

  private onInitialize(id: string, params: Record<string, unknown>): void {
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) fail("FIELD_VALUE");
    const remainingMs = params["remainingMs"];
    const maxCalls = params["maxModelCalls"];
    const maxEffects = params["maxEffects"];
    const maxMethodLoads = params["maxMethodLoads"];
    if (typeof remainingMs !== "number" || !Number.isSafeInteger(remainingMs) || remainingMs < 1) fail("FIELD_VALUE");
    if (typeof maxCalls !== "number" || !Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 3) fail("FIELD_VALUE");
    if (typeof maxEffects !== "number" || !Number.isSafeInteger(maxEffects) || maxEffects < 0 || maxEffects > 2) fail("FIELD_VALUE");
    if (typeof maxMethodLoads !== "number" || !Number.isSafeInteger(maxMethodLoads) || maxMethodLoads < 0 || maxMethodLoads > 1) fail("FIELD_VALUE");
    if (params["maxTokens"] !== MAX_TOKENS) fail("FIELD_VALUE");
    if (params["mode"] !== "MOCK_ONLY") fail("FIELD_VALUE");
    this.sessionId = sessionId;
    this.maxCalls = maxCalls;
    this.maxEffects = maxEffects;
    this.maxMethodLoads = maxMethodLoads;
    this.io.tighten(remainingMs);
    this.phase = "solve";
    this.io.send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: this.manifest.protocolVersion,
        sessionId,
        mode: "MOCK_ONLY",
        targetEnvironment: "TARGET_UNVERIFIED",
      },
    }, "runtime.initialize");
  }

  private onSolve(id: string, params: Record<string, unknown>): void {
    const sessionId = params["sessionId"];
    const problem = params["problem"];
    const problemHash = params["problemHash"];
    if (sessionId !== this.sessionId) fail("SESSION_MISMATCH");
    if (typeof problem !== "string" || problem.length === 0) fail("FIELD_VALUE");
    if (typeof problemHash !== "string") fail("FIELD_VALUE");
    const contract = compileP2Contract(problem, this.sessionId);
    if (contract.problemHash !== problemHash || p2ProblemHashOf(problem) !== problemHash) {
      fail("FIELD_VALUE");
    }
    const ledger = new ContractLedger(contract);
    const candidateObligations = new Set(
      contract.obligations
        .filter((entry) => entry.kind === "CANDIDATE_VALIDITY" || entry.kind === "ANSWER_REQUEST")
        .map((entry) => entry.obligationId),
    );
    const ready = ledger.readyTasks().filter((entry) => candidateObligations.has(entry.obligationId));
    const chosen = chooseP2ReadyTask(contract, ready);
    if (chosen === null) fail("FIELD_VALUE");
    const started = ledger.startTask(chosen.taskId);
    this.problem = problem;
    this.problemHash = problemHash;
    this.contract = contract;
    this.ledger = ledger;
    this.task = started;
    this.modelGate = new P2ModelGate(this.sessionId, problemHash, contract.contractVersion, this.maxCalls);
    this.effectGate = new P3EffectGate({
      sessionId: this.sessionId,
      problemHash,
      contractVersion: contract.contractVersion,
      taskId: started.taskId,
      scopeId: started.scopeId,
    }, this.maxEffects);
    if (this.maxMethodLoads === 1 && this.maxCalls > 1 && this.maxEffects > 0 && this.io.remainingMs() > MIN_REMAINING_MS) {
      this.phase = "catalog";
      this.catalogCalls += 1;
      this.io.send({
        jsonrpc: "2.0",
        id: "node-catalog-1",
        method: "method.catalog",
        params: {
          protocolVersion: this.manifest.protocolVersion,
          sessionId: this.sessionId,
        },
      }, "method.catalog");
      return;
    }
    this.phase = "model";
    this.model();
  }

  private onCatalog(id: string, params: Record<string, unknown>): void {
    if (id !== "node-catalog-1") fail("ID_MISMATCH");
    if (params["sessionId"] !== this.sessionId) fail("SESSION_MISMATCH");
    const remainingMs = params["remainingMs"];
    if (typeof remainingMs !== "number" || !Number.isSafeInteger(remainingMs) || remainingMs < 0) fail("FIELD_VALUE");
    const catalog: P2MethodCatalog = p3MethodCatalog(params["catalog"]);
    this.io.tighten(remainingMs);
    this.catalog = catalog;
    if (this.io.remainingMs() <= MIN_REMAINING_MS) {
      this.finish("DEADLINE_EXCEEDED");
      return;
    }
    this.phase = "model";
    this.model();
  }

  private binding(): P3Binding {
    const task = this.task;
    if (task === null) fail("FIELD_VALUE");
    return {
      sessionId: this.sessionId,
      problemHash: this.problemHash,
      contractVersion: 1,
      taskId: task.taskId,
      scopeId: task.scopeId,
      sourceRequestId: REQUEST_IDS[this.modelCalls - 1] ?? "model-1",
    };
  }

  private model(): void {
    const contract = this.contract;
    const task = this.task;
    const gate = this.modelGate;
    const effectGate = this.effectGate;
    if (contract === null || task === null || gate === null || effectGate === null) fail("FIELD_VALUE");
    if (this.modelCalls >= this.maxCalls) {
      this.finish("BUDGET_EXHAUSTED");
      return;
    }
    const remaining = this.io.remainingMs();
    if (remaining <= MIN_REMAINING_MS) {
      this.finish("DEADLINE_EXCEEDED");
      return;
    }
    const requestId = REQUEST_IDS[this.modelCalls];
    if (requestId === undefined) {
      this.finish("BUDGET_EXHAUSTED");
      return;
    }
    const remainingTurns = this.maxCalls - this.modelCalls;
    const allowed = effectGate
      .allowedActionIds(remainingTurns, remaining)
      .filter((actionId) => actionId !== "LOAD_METHOD" || (this.maxMethodLoads === 1 && this.catalog.entries.length > 0));
    let context;
    try {
      context = prepareP3Context(contract, task, requestId, allowed, this.effects, this.history, this.catalog.entries);
    } catch (error) {
      if (error instanceof P2Error) {
        this.finish("CONTEXT_REJECTED");
        return;
      }
      throw error;
    }
    const params: Record<string, unknown> = {
      protocolVersion: this.manifest.protocolVersion,
      sessionId: this.sessionId,
      requestId,
      problemHash: this.problemHash,
      contractVersion: 1,
      taskId: task.taskId,
      scopeId: task.scopeId,
      messages: context.messages,
      contextHash: context.contextHash,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    };
    const message: JsonRpcMessage = { jsonrpc: "2.0", id: `node-model-${this.modelCalls + 1}`, method: "model.generate", params };
    if (wireBytes(message) > MAX_FRAME_BYTES) {
      this.finish("CONTEXT_REJECTED");
      return;
    }
    const nowRemaining = this.io.remainingMs();
    if (nowRemaining <= MIN_REMAINING_MS) {
      this.finish("DEADLINE_EXCEEDED");
      return;
    }
    gate.admit(task, requestId, nowRemaining);
    gate.markDispatched(requestId);
    this.privateRequests.push({
      requestId,
      params: p2Snapshot(params) as Record<string, unknown>,
      contextHash: context.contextHash,
      receipt: null,
    });
    this.modelCalls += 1;
    this.lastContextHash = context.contextHash;
    this.phase = "model";
    this.io.send(message, "model.generate");
  }

  private onModel(id: string, params: Record<string, unknown>): void {
    const gate = this.modelGate;
    if (gate === null) fail("FIELD_VALUE");
    const requestId = params["requestId"];
    if (typeof requestId !== "string" || !(REQUEST_IDS as readonly string[]).includes(requestId)) fail("FIELD_VALUE");
    if (params["sessionId"] !== this.sessionId) fail("SESSION_MISMATCH");
    if (requestId !== REQUEST_IDS[this.modelCalls - 1]) fail("ID_MISMATCH");
    const expectedId = `node-${requestId}`;
    if (id !== expectedId) fail("ID_MISMATCH");
    const deliveryStatus = params["deliveryStatus"];
    const text = params["text"];
    if (typeof deliveryStatus !== "string" || typeof text !== "string") fail("FIELD_VALUE");
    const remainingMs = params["remainingMs"];
    if (typeof remainingMs !== "number" || !Number.isSafeInteger(remainingMs) || remainingMs < 0) fail("FIELD_VALUE");
    const record = this.privateRequests[this.privateRequests.length - 1];
    if (record === undefined || record.requestId !== requestId) fail("ID_MISMATCH");
    record.receipt = { deliveryStatus, text };
    this.io.tighten(remainingMs);
    gate.settle(requestId, deliveryStatus as never);
    if (deliveryStatus !== "COMPLETE") {
      this.finish("TRANSPORT_STOP");
      return;
    }
    if (this.io.remainingMs() <= MIN_REMAINING_MS) {
      this.finish("DEADLINE_EXCEEDED");
      return;
    }
    let action: P3Action;
    try {
      action = parseP3Action(text);
    } catch {
      this.finish("ACTION_REJECTED");
      return;
    }
    this.history.push({ requestId, transportStatus: "COMPLETE", text });
    if (action.action === "final") {
      if (action.complete && action.unresolved.length === 0) {
        if (this.io.remainingMs() <= MIN_REMAINING_MS) {
          this.finish("DEADLINE_EXCEEDED");
          return;
        }
        this.candidateRequestId = requestId;
        this.finalResponse = action.answer;
        this.finish("FINAL");
        return;
      }
      this.finish("FINAL");
      return;
    }
    if (action.action === "unsolved") {
      this.finish("UNSOLVED");
      return;
    }
    if (action.action === "method") {
      if (this.maxMethodLoads === 0 || this.catalog.entries.length === 0) {
        this.finish("EFFECT_UNAVAILABLE");
        return;
      }
      let known = false;
      for (const entry of this.catalog.entries) {
        if (entry.id === action.id) {
          known = true;
          break;
        }
      }
      if (!known) {
        this.finish("EFFECT_UNAVAILABLE");
        return;
      }
    }
    this.onEffectAction(action);
  }

  private onEffectAction(action: Extract<P3Action, { action: "tool" | "method" }>): void {
    const effectGate = this.effectGate;
    if (effectGate === null) fail("FIELD_VALUE");
    const remainingTurns = this.maxCalls - this.modelCalls + 1;
    const remaining = this.io.remainingMs();
    let admitted;
    try {
      admitted = effectGate.admit(action, this.binding(), remainingTurns, remaining);
    } catch (error) {
      if (error instanceof P2Error) {
        this.finish(error.code === P2_ERROR_CODES.BUDGET_EXHAUSTED ? "BUDGET_EXHAUSTED" : "ACTION_REJECTED");
        return;
      }
      throw error;
    }
    if (admitted.status === "CACHED") {
      this.cachedEffects += 1;
      this.model();
      return;
    }
    const request = admitted.request;
    const wire = request.action.action === "method" ? "method.load" : "tool.execute";
    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: `node-effect-${this.effectCalls + 1}`,
      method: wire,
      params: {
        protocolVersion: this.manifest.protocolVersion,
        sessionId: this.sessionId,
        request,
      },
    };
    if (wireBytes(message) > MAX_FRAME_BYTES) {
      this.finish("ACTION_REJECTED");
      return;
    }
    if (this.io.remainingMs() <= MIN_REMAINING_MS) {
      this.finish("DEADLINE_EXCEEDED");
      return;
    }
    effectGate.markDispatched(request.effectId);
    this.pendingEffect = { effectId: request.effectId, request };
    this.effectCalls += 1;
    if (request.action.action === "method") {
      this.methodLoads += 1;
    }
    this.phase = "effect";
    this.io.send(message, wire);
  }

  private onEffect(id: string, params: Record<string, unknown>): void {
    const effectGate = this.effectGate;
    const pending = this.pendingEffect;
    if (effectGate === null || pending === null) fail("FIELD_VALUE");
    if (params["sessionId"] !== this.sessionId) fail("SESSION_MISMATCH");
    const expectedId = `node-effect-${this.effectCalls}`;
    if (id !== expectedId) fail("ID_MISMATCH");
    const remainingMs = params["remainingMs"];
    if (typeof remainingMs !== "number" || !Number.isSafeInteger(remainingMs) || remainingMs < 0) fail("FIELD_VALUE");
    let receipt: P3EffectReceipt;
    try {
      receipt = p3EffectReceipt(params["receipt"], pending.request);
    } catch {
      effectGate.settle(p3EffectFailure(pending.request, "UNKNOWN"));
      this.pendingEffect = null;
      this.finish("EFFECT_UNKNOWN");
      return;
    }
    if (pending.request.action.action === "method") {
      try {
        p3MethodObservation(receipt, pending.request, this.catalog);
      } catch {
        effectGate.settle(p3EffectFailure(pending.request, "UNKNOWN"));
        this.pendingEffect = null;
        this.finish("EFFECT_UNKNOWN");
        return;
      }
    }
    this.io.tighten(remainingMs);
    effectGate.settle(receipt);
    this.pendingEffect = null;
    if (receipt.status === "UNKNOWN") {
      this.finish("EFFECT_UNKNOWN");
      return;
    }
    if (this.io.remainingMs() <= MIN_REMAINING_MS) {
      this.finish("DEADLINE_EXCEEDED");
      return;
    }
    this.effects.push(receipt);
    this.model();
  }

  private finish(reason: StopReason): void {
    if (this.phase === "stop" || this.phase === "done") return;
    this.stopReason = reason;
    this.phase = "stop";
    const candidate = this.candidateRequestId !== null;
    this.io.send({
      jsonrpc: "2.0",
      id: "host-2",
      result: {
        protocolVersion: this.manifest.protocolVersion,
        sessionId: this.sessionId,
        mode: "MOCK_ONLY",
        targetEnvironment: "TARGET_UNVERIFIED",
        status: candidate ? "candidate" : "unsolved",
        finalResponse: candidate ? this.finalResponse : "Unsolved.",
        candidateVerified: false,
        strictAcceptance: "NOT_PERFORMED",
        modelCalls: this.modelCalls,
        effectCalls: this.effectCalls,
        cachedEffects: this.cachedEffects,
        catalogCalls: this.catalogCalls,
        methodLoads: this.methodLoads,
        candidateRequestId: this.candidateRequestId,
        contextHash: this.lastContextHash,
        stopReason: reason,
      },
    }, "session.solve");
  }

  private onStop(id: string, params: Record<string, unknown>): void {
    if (params["sessionId"] !== this.sessionId) fail("SESSION_MISMATCH");
    if (id !== "host-3") fail("ID_MISMATCH");
    if (this.stopped) fail("FIELD_VALUE");
    this.stopped = true;
    this.phase = "done";
    this.io.stop({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: this.manifest.protocolVersion,
        sessionId: this.sessionId,
        stopped: true,
      },
    });
  }
}

export { P3_TOOL_NAMES, EFFECT_IDS, MAX_DEADLINE_MS };
