/**
 * @astra/stdio-runtime — unified AgentLoop local Host flow (Node side).
 *
 * One synchronous frame handler drives the fixed phase machine
 * INIT -> READY -> SOLVING -> DONE/STOP. The three Host requests
 * (`host-1`/runtime.initialize, `host-2`/session.solve, `host-3`/session.stop)
 * are each accepted exactly once and only in the correct direction. While
 * `session.solve` is pending, the single `pending` slot serves the Node-to-Host
 * callbacks `model.generate`/`tool.execute`; a duplicate, mismatched or
 * out-of-phase frame fails closed. `runAgentLoop` is invoked exactly once and
 * its ports are the only model/effect entry points. No second parser, no
 * stdout logging, no private state on the wire.
 */

import {
  AGENT_HOST_VERSION,
  ERROR_CODES,
  agentHostPayload,
  p2Snapshot,
  p4Hash,
  type AgentHostManifest,
  type AgentHostMethod,
  type AgentModelReceipt,
  type AgentModelRequest,
  type AgentPorts,
  type JsonRpcMessage,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { p3EffectReceipt } from "@astra/math-gateway";
import { runAgentLoop } from "./agent-loop.js";

const MIN_REMAINING_MS = 25;
const HOST_INIT_ID = "host-1";
const HOST_SOLVE_ID = "host-2";
const HOST_STOP_ID = "host-3";
const PROFILE_ID = "math-agent-preview-v1";
const MAX_MODEL_CALLS = 4;
const MAX_WORK_UNITS = 3;
const MAX_EFFECTS = 2;
const MAX_REVIEWS = 1;
const MAX_REMAINING_MS = 5000;
const HASH = /^[0-9a-f]{64}$/u;

type Phase = "INIT" | "READY" | "SOLVING" | "DONE" | "STOP";

/** Transport surface injected by the entry point; no I/O lives in this file. */
export interface AgentHostIo {
  remainingMs(): number;
  tighten(ms: number): void;
  send(message: JsonRpcMessage, method: AgentHostMethod): void;
  stop(message: JsonRpcMessage): void;
  fail(error: unknown): never;
}

interface Pending {
  readonly id: string;
  readonly method: "model.generate" | "tool.execute";
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly requestId?: string;
  readonly effectRequest?: P3EffectRequest;
}

function fail(code: string): never {
  throw new Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(ERROR_CODES.FIELD_VALUE);
  }
  return value;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > max) {
    fail(ERROR_CODES.FIELD_VALUE);
  }
  return value;
}

interface FrozenOptions {
  readonly maxModelCalls: number;
  readonly maxWorkUnits: number;
  readonly maxEffects: number;
  readonly maxReviews: number;
  readonly policy: "BEST_EFFORT" | "STRICT";
}

export class AgentHostFlow {
  private readonly manifest: AgentHostManifest;
  private readonly io: AgentHostIo;
  private phase: Phase = "INIT";
  private sessionId: string | null = null;
  private pending: Pending | null = null;
  private effectAvailable = false;
  private solveStarted = false;
  private stopSent = false;
  private options: FrozenOptions | null = null;

  constructor(manifest: AgentHostManifest, io: AgentHostIo) {
    this.manifest = manifest;
    this.io = io;
  }

  /** Synchronous frame entry point. Every rejection is a fixed code. */
  handle(message: JsonRpcMessage): void {
    try {
      if ("method" in message) {
        this.onRequest(message.id, message.method, message.params);
        return;
      }
      if ("result" in message) {
        this.onResult(message.id, message.result);
        return;
      }
      fail(ERROR_CODES.FIELD_VALUE);
    } catch (error) {
      this.io.fail(error);
    }
  }

  private onRequest(id: string, method: string, params: Record<string, unknown>): void {
    if (this.pending !== null) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (method === "runtime.initialize") {
      if (this.phase !== "INIT" || id !== HOST_INIT_ID) {
        fail(ERROR_CODES.FIELD_VALUE);
      }
      this.handleInitialize(id, params);
      return;
    }
    if (method === "session.solve") {
      if (this.phase !== "READY" || id !== HOST_SOLVE_ID) {
        fail(ERROR_CODES.FIELD_VALUE);
      }
      this.handleSolve(id, params);
      return;
    }
    if (method === "session.stop") {
      if (this.phase !== "DONE" || id !== HOST_STOP_ID) {
        fail(ERROR_CODES.FIELD_VALUE);
      }
      this.handleStop(id, params);
      return;
    }
    fail(ERROR_CODES.UNKNOWN_METHOD);
  }

  private onResult(id: string, result: Record<string, unknown>): void {
    const pending = this.pending;
    if (pending === null || id !== pending.id) {
      fail(ERROR_CODES.ID_MISMATCH);
    }
    if (pending.method === "model.generate") {
      if (this.phase !== "SOLVING") {
        fail(ERROR_CODES.FIELD_VALUE);
      }
      this.settleModel(pending, result);
      return;
    }
    if (this.phase !== "SOLVING") {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    this.settleEffect(pending, result);
  }

  private handleInitialize(id: string, params: Record<string, unknown>): void {
    agentHostPayload(this.manifest, "runtime.initialize", "params", params);
    const sessionId = boundedString(params["sessionId"], 128);
    const capabilities = params["capabilities"];
    if (!isPlainObject(capabilities)) {
      fail(ERROR_CODES.FIELD_TYPE);
    }
    const maxEffects = safeInt(params["maxEffects"], 0, MAX_EFFECTS);
    const maxModelCalls = safeInt(params["maxModelCalls"], 0, MAX_MODEL_CALLS);
    const maxWorkUnits = safeInt(params["maxWorkUnits"], 1, MAX_WORK_UNITS);
    const maxReviews = safeInt(params["maxReviews"], 0, MAX_REVIEWS);
    const remainingMs = safeInt(params["remainingMs"], 1, MAX_REMAINING_MS);
    if (params["profileId"] !== PROFILE_ID) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (capabilities["modelGenerate"] !== "AVAILABLE") {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (capabilities["methodLoad"] !== "UNAVAILABLE" || capabilities["generatedPython"] !== "UNAVAILABLE") {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (capabilities["maxTokens"] !== 8192 || capabilities["maxTokensVerified"] !== false) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (capabilities["journal"] !== "IN_MEMORY_ONLY") {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (capabilities["requireExplicitFinishForTools"] !== true) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const toolExecute = capabilities["toolExecute"];
    if (toolExecute !== "AVAILABLE" && toolExecute !== "UNAVAILABLE") {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const policy = params["policy"];
    if (policy !== "BEST_EFFORT" && policy !== "STRICT") {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    this.effectAvailable = toolExecute === "AVAILABLE" && maxEffects > 0;
    this.options = Object.freeze({
      maxModelCalls,
      maxWorkUnits,
      maxEffects: this.effectAvailable ? maxEffects : 0,
      maxReviews,
      policy,
    });
    this.sessionId = sessionId;
    this.io.tighten(remainingMs);
    this.phase = "READY";
    this.io.send(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: AGENT_HOST_VERSION,
          sessionId,
          engine: "ts",
          mode: "TS_PREVIEW",
        },
      },
      "runtime.initialize",
    );
  }

  private handleSolve(id: string, params: Record<string, unknown>): void {
    agentHostPayload(this.manifest, "session.solve", "params", params, this.sessionId ?? undefined);
    const problem = boundedString(params["problem"], 8192);
    const problemHash = params["problemHash"];
    if (typeof problemHash !== "string" || !HASH.test(problemHash)) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (problemHash !== p4Hash(problem)) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const remainingMs = safeInt(params["remainingMs"], 1, MAX_REMAINING_MS);
    this.io.tighten(remainingMs);
    if (this.io.remainingMs() <= MIN_REMAINING_MS) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    this.phase = "SOLVING";
    this.solveStarted = true;
    this.runSolve(id, problem).catch(() => {
      this.io.fail(new Error(ERROR_CODES.FIELD_VALUE));
    });
  }

  private async runSolve(id: string, problem: string): Promise<void> {
    const sessionId = this.sessionId;
    const options = this.options;
    if (sessionId === null || options === null) {
      this.io.fail(new Error(ERROR_CODES.FIELD_VALUE));
      return;
    }
    const budget = this.io.remainingMs();
    const origin = performance.now();
    const now = (): number => origin + Math.max(0, budget - this.io.remainingMs());
    const ports: AgentPorts = {
      model: { generate: (request: AgentModelRequest) => this.callModel(request) },
      effect: this.effectAvailable
        ? { execute: (request: P3EffectRequest) => this.callEffect(request) }
        : null,
    };
    let result: Awaited<ReturnType<typeof runAgentLoop>>;
    try {
      result = await runAgentLoop(problem, sessionId, {
        maxModelCalls: options.maxModelCalls,
        maxWorkUnits: options.maxWorkUnits,
        maxEffects: options.maxEffects,
        maxReviews: options.maxReviews,
        remainingMs: budget,
        policy: options.policy,
        now,
      }, ports);
    } catch (error) {
      this.io.fail(error);
      return;
    }
    if (this.pending !== null) {
      this.io.fail(new Error(ERROR_CODES.FIELD_VALUE));
      return;
    }
    const summary = result.summary;
    const candidateRequestId =
      summary.status === "candidate"
        ? result.privateState.decision.protectedCandidate?.sourceRequestId ?? null
        : null;
    this.phase = "DONE";
    this.io.send(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: AGENT_HOST_VERSION,
          sessionId,
          summary: p2Snapshot(summary),
          candidateRequestId,
          trace: p2Snapshot(result.privateState.session.events),
        },
      },
      "session.solve",
    );
  }

  private handleStop(id: string, params: Record<string, unknown>): void {
    agentHostPayload(this.manifest, "session.stop", "params", params, this.sessionId ?? undefined);
    if (this.stopSent) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    this.stopSent = true;
    this.phase = "STOP";
    this.io.stop({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: AGENT_HOST_VERSION,
        sessionId: this.sessionId,
        stopped: true,
      },
    });
  }

  private callModel(request: AgentModelRequest): Promise<AgentModelReceipt> {
    if (this.pending !== null) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    if (this.io.remainingMs() <= MIN_REMAINING_MS) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    const id = `node-${request.requestId}`;
    const remainingMs = Math.min(request.remainingMs, this.io.remainingMs());
    if (remainingMs <= MIN_REMAINING_MS) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    return new Promise<AgentModelReceipt>((resolve, reject) => {
      this.pending = { id, method: "model.generate", resolve: resolve as (value: unknown) => void, reject, requestId: request.requestId };
      try {
        this.io.send(
          {
            jsonrpc: "2.0",
            id,
            method: "model.generate",
            params: {
              protocolVersion: AGENT_HOST_VERSION,
              sessionId: this.sessionId,
              request: p2Snapshot({ ...request, remainingMs }),
            },
          },
          "model.generate",
        );
      } catch (error) {
        this.pending = null;
        reject(error);
      }
    });
  }

  private callEffect(request: P3EffectRequest): Promise<P3EffectReceipt> {
    if (this.pending !== null) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    if (this.io.remainingMs() <= MIN_REMAINING_MS) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    const id = `node-${request.effectId}`;
    const remainingMs = Math.min(request.remainingMs, this.io.remainingMs());
    if (remainingMs <= MIN_REMAINING_MS) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    const sent = p2Snapshot({ ...request, remainingMs }) as P3EffectRequest;
    return new Promise<P3EffectReceipt>((resolve, reject) => {
      this.pending = {
        id,
        method: "tool.execute",
        resolve: resolve as (value: unknown) => void,
        reject,
        effectRequest: sent,
      };
      try {
        this.io.send(
          {
            jsonrpc: "2.0",
            id,
            method: "tool.execute",
            params: {
              protocolVersion: AGENT_HOST_VERSION,
              sessionId: this.sessionId,
              request: sent,
            },
          },
          "tool.execute",
        );
      } catch (error) {
        this.pending = null;
        reject(error);
      }
    });
  }

  private settleModel(pending: Pending, result: Record<string, unknown>): void {
    agentHostPayload(this.manifest, "model.generate", "result", result, this.sessionId ?? undefined);
    if (result["requestId"] !== pending.requestId) {
      fail(ERROR_CODES.ID_MISMATCH);
    }
    const receipt = result["receipt"];
    if (!isPlainObject(receipt)) {
      fail(ERROR_CODES.FIELD_TYPE);
    }
    const transportStatus = receipt["transportStatus"];
    if (
      transportStatus !== "COMPLETE" &&
      transportStatus !== "TRUNCATED" &&
      transportStatus !== "ERROR" &&
      transportStatus !== "UNKNOWN"
    ) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const text = receipt["text"];
    if (typeof text !== "string" || [...text].length > 20000) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const remainingMs = safeInt(receipt["remainingMs"], 0, MAX_REMAINING_MS);
    this.pending = null;
    this.io.tighten(remainingMs);
    pending.resolve(
      p2Snapshot({ transportStatus, text, remainingMs }) as AgentModelReceipt,
    );
  }

  private settleEffect(pending: Pending, result: Record<string, unknown>): void {
    agentHostPayload(this.manifest, "tool.execute", "result", result, this.sessionId ?? undefined);
    const receipt = result["receipt"];
    if (!isPlainObject(receipt)) {
      fail(ERROR_CODES.FIELD_TYPE);
    }
    const effectRequest = pending.effectRequest;
    if (effectRequest === undefined) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    let checked: P3EffectReceipt;
    try {
      checked = p3EffectReceipt(receipt, effectRequest);
    } catch {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const remainingMs = safeInt(result["remainingMs"], 0, MAX_REMAINING_MS);
    this.pending = null;
    this.io.tighten(remainingMs);
    pending.resolve(checked);
  }
}
