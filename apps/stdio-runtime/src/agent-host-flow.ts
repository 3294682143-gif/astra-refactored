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
  type AgentAssetDescriptor,
  type AgentAssetRequest,
  type AgentPorts,
  type JsonRpcMessage,
  type P2MethodCatalog,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { p3EffectReceipt } from "@astra/math-gateway";
import { p3MethodCatalog } from "@astra/runtime-core";
import { runAgentLoop } from "./agent-loop.js";

const MIN_REMAINING_MS = 25;
const HOST_INIT_ID = "host-1";
const HOST_SOLVE_ID = "host-2";
const HOST_STOP_ID = "host-3";
const PROFILE_ID = "math-agent-preview-v2";
// Hard caps for the explicit root budget. The budget is derived from the
// compiled task graph (one work unit per task, plus the review and slack) and
// clamped to these caps; they are upper bounds, not a per-problem default.
const MAX_MODEL_CALLS = 256;
const MAX_WORK_UNITS = 64;
const MAX_EFFECTS = 2;
const MAX_REVIEWS = 3;
const MAX_METHOD_LOADS = 1;
const MAX_REMAINING_MS = 3600000;
const HASH = /^[0-9a-f]{64}$/u;
const CATALOG_FRAME_ID = "node-catalog-1";

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
  readonly method: "model.generate" | "tool.execute" | "method.catalog" | "method.load" | "asset.scoped";
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
  readonly maxMethodLoads: number;
  readonly maxRepairs: number;
  readonly maxConsensus: number;
  readonly maxR0: number;
  readonly policy: "BEST_EFFORT" | "STRICT";
  readonly deriveBudget: boolean;
}

/** G7/PR7 Slice 7d: one authenticated resume SessionLog row (fixed shape). */
interface ResumeLogRow {
  readonly seq: number;
  readonly kind: string;
  readonly data: Readonly<Record<string, unknown>>;
}

const MAX_RESUME_EVENTS = 512;
const MAX_RESUME_KIND_CHARS = 64;

/**
 * Bounded shape check of the optional resume prefix. Absent stays `null`, so
 * the default path is byte-identical; a malformed prefix is a fixed failure.
 */
function checkedResumeLog(value: unknown): readonly ResumeLogRow[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length > MAX_RESUME_EVENTS) {
    fail(ERROR_CODES.FIELD_VALUE);
  }
  const out: ResumeLogRow[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    if (!isPlainObject(row)) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const keys = Object.keys(row);
    if (keys.length !== 3 || !keys.includes("seq") || !keys.includes("kind") || !keys.includes("data")) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (row["seq"] !== index + 1) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const kind = row["kind"];
    if (typeof kind !== "string" || kind.length === 0 || kind.length > MAX_RESUME_KIND_CHARS) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (!isPlainObject(row["data"])) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    out.push({
      seq: index + 1,
      kind,
      data: p2Snapshot(row["data"]) as Readonly<Record<string, unknown>>,
    });
  }
  return Object.freeze(out);
}

/** Declared contract version of a resume checkpoint (1 or 2), or `null`. */
function checkedResumeVersion(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (value !== 1 && value !== 2)) {
    fail(ERROR_CODES.FIELD_VALUE);
  }
  return value;
}

export class AgentHostFlow {
  private readonly manifest: AgentHostManifest;
  private readonly io: AgentHostIo;
  private phase: Phase = "INIT";
  private sessionId: string | null = null;
  private pending: Pending | null = null;
  private effectAvailable = false;
  private methodAvailable = false;
  private solveStarted = false;
  private stopSent = false;
  private catalogRead = false;
  private modelStarted = false;
  private options: FrozenOptions | null = null;
  private resumeSessionLog: readonly ResumeLogRow[] | null = null;
  private resumeContractVersion: number | null = null;

  constructor(manifest: AgentHostManifest, io: AgentHostIo) {
    if (manifest.protocolVersion !== AGENT_HOST_VERSION) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
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
    if (pending.method === "method.catalog") {
      this.settleCatalog(pending, result);
      return;
    }
    if (pending.method === "asset.scoped") {
      this.settleAsset(pending, result);
      return;
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
    const maxMethodLoads = safeInt(params["maxMethodLoads"], 0, MAX_METHOD_LOADS);
    const maxRepairs = params["maxRepairs"] === undefined ? 0 : safeInt(params["maxRepairs"], 0, 3);
    const maxConsensus =
      params["maxConsensus"] === undefined ? 0 : safeInt(params["maxConsensus"], 0, 8);
    const maxR0 = params["maxR0"] === undefined ? 0 : safeInt(params["maxR0"], 0, 1);
    const remainingMs = safeInt(params["remainingMs"], 1, MAX_REMAINING_MS);
    if (params["profileId"] !== PROFILE_ID) {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (capabilities["modelGenerate"] !== "AVAILABLE") {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    if (capabilities["generatedPython"] !== "UNAVAILABLE") {
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
    const methodLoad = capabilities["methodLoad"];
    if (methodLoad !== "AVAILABLE" && methodLoad !== "UNAVAILABLE") {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const policy = params["policy"];
    if (policy !== "BEST_EFFORT" && policy !== "STRICT") {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    this.effectAvailable = toolExecute === "AVAILABLE" && maxEffects > 0;
    this.methodAvailable =
      methodLoad === "AVAILABLE" && maxMethodLoads === 1 && this.effectAvailable;
    const deriveBudget = params["deriveBudget"] === true;
    this.options = Object.freeze({
      maxModelCalls,
      maxWorkUnits,
      maxEffects: this.effectAvailable ? maxEffects : 0,
      maxReviews,
      maxMethodLoads: this.methodAvailable ? maxMethodLoads : 0,
      maxRepairs,
      maxConsensus,
      maxR0,
      policy,
      deriveBudget,
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
    // G7/PR7 Slice 7d: optional authenticated resume prefix; absent keys keep
    // the default path byte-identical.
    this.resumeSessionLog = checkedResumeLog(params["resumeSessionLog"]);
    this.resumeContractVersion = checkedResumeVersion(params["resumeContractVersion"]);
    if (this.resumeSessionLog !== null && this.resumeContractVersion === null) {
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
      catalog: this.methodAvailable ? { read: (remainingMs: number) => this.callCatalog(remainingMs) } : null,
      asset: { call: (request: AgentAssetRequest) => this.callAsset(request) },
    };
    let result: Awaited<ReturnType<typeof runAgentLoop>>;
    try {
      result = await runAgentLoop(problem, sessionId, {
        maxModelCalls: options.maxModelCalls,
        maxWorkUnits: options.maxWorkUnits,
        maxEffects: options.maxEffects,
        maxReviews: options.maxReviews,
        maxMethodLoads: options.maxMethodLoads,
        maxRepairs: options.maxRepairs,
        maxConsensus: options.maxConsensus,
        maxR0: options.maxR0,
        remainingMs: budget,
        policy: options.policy,
        deriveBudget: options.deriveBudget,
        now,
        ...(this.resumeSessionLog === null
          ? {}
          : {
              resumeSessionLog: this.resumeSessionLog,
              resumeContractVersion: this.resumeContractVersion,
            }),
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
    // Defect 3: hand the immutable SessionLog back to the Host so a checkpoint
    // can export the real event sequence instead of an empty prefix. The bulky
    // model-visible `messages` are replaced by their recorded context hash so the
    // frame stays within the fixed IPC frame bound while every event identity
    // (seq/kind/hash/size) is preserved.
    const sessionLog = (result.privateState.sessionLog?.events ?? []).map((event) => {
      if (event.kind === "MODEL_REQUEST") {
        const { phase, requestId, contextHash, contextBytes } = event.data as {
          phase?: unknown;
          requestId?: unknown;
          contextHash?: unknown;
          contextBytes?: unknown;
        };
        return { seq: event.seq, kind: event.kind, data: { phase, requestId, contextHash, contextBytes, __chain: (event.data as Record<string, unknown>)["__chain"] } };
      }
      return { seq: event.seq, kind: event.kind, data: event.data };
    });
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
          sessionLog: p2Snapshot(sessionLog),
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

  private callAsset(request: AgentAssetRequest): Promise<AgentAssetDescriptor> {
    if (this.pending !== null) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    if (this.io.remainingMs() <= MIN_REMAINING_MS) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    const id = `node-asset-${request.assetId}`;
    return new Promise<AgentAssetDescriptor>((resolve, reject) => {
      this.pending = { id, method: "asset.scoped", resolve: resolve as (value: unknown) => void, reject };
      try {
        this.io.send(
          {
            jsonrpc: "2.0",
            id,
            method: "asset.scoped",
            params: {
              protocolVersion: AGENT_HOST_VERSION,
              sessionId: this.sessionId,
              assetGroup: request.group,
              assetId: request.assetId,
              scopeId: request.scopeId,
              contractVersion: request.contractVersion,
            },
          },
          "asset.scoped",
        );
      } catch (error) {
        this.pending = null;
        reject(error);
      }
    });
  }

  private settleAsset(pending: Pending, result: Record<string, unknown>): void {
    agentHostPayload(this.manifest, "asset.scoped", "result", result, this.sessionId ?? undefined);
    const descriptor = result["descriptor"];
    if (!isPlainObject(descriptor)) {
      this.pending = null;
      pending.reject(new Error(ERROR_CODES.FIELD_VALUE));
      return;
    }
    this.pending = null;
    pending.resolve(p2Snapshot(descriptor));
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
    this.modelStarted = true;
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
    const isMethod = request.action.action === "method";
    const id = `node-${request.effectId}`;
    const method = isMethod ? "method.load" : "tool.execute";
    const remainingMs = Math.min(request.remainingMs, this.io.remainingMs());
    if (remainingMs <= MIN_REMAINING_MS) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    const sent = p2Snapshot({ ...request, remainingMs }) as P3EffectRequest;
    return new Promise<P3EffectReceipt>((resolve, reject) => {
      this.pending = {
        id,
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        effectRequest: sent,
      };
      try {
        this.io.send(
          {
            jsonrpc: "2.0",
            id,
            method,
            params: {
              protocolVersion: AGENT_HOST_VERSION,
              sessionId: this.sessionId,
              request: sent,
            },
          },
          method,
        );
      } catch (error) {
        this.pending = null;
        reject(error);
      }
    });
  }

  private callCatalog(remainingMs: number): Promise<P2MethodCatalog> {
    if (this.pending !== null) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    if (!this.methodAvailable || this.catalogRead || this.modelStarted || this.phase !== "SOLVING") {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    if (this.io.remainingMs() <= MIN_REMAINING_MS) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    const window = Math.min(remainingMs, this.io.remainingMs());
    if (window <= MIN_REMAINING_MS) {
      return Promise.reject(new Error(ERROR_CODES.FIELD_VALUE));
    }
    this.catalogRead = true;
    return new Promise<P2MethodCatalog>((resolve, reject) => {
      this.pending = {
        id: CATALOG_FRAME_ID,
        method: "method.catalog",
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      try {
        this.io.send(
          {
            jsonrpc: "2.0",
            id: CATALOG_FRAME_ID,
            method: "method.catalog",
            params: {
              protocolVersion: AGENT_HOST_VERSION,
              sessionId: this.sessionId,
              remainingMs: window,
            },
          },
          "method.catalog",
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
    agentHostPayload(this.manifest, pending.method, "result", result, this.sessionId ?? undefined);
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

  private settleCatalog(pending: Pending, result: Record<string, unknown>): void {
    agentHostPayload(this.manifest, "method.catalog", "result", result, this.sessionId ?? undefined);
    const catalog = result["catalog"];
    let checked: P2MethodCatalog;
    try {
      checked = p3MethodCatalog(catalog);
    } catch {
      fail(ERROR_CODES.FIELD_VALUE);
    }
    const remainingMs = safeInt(result["remainingMs"], 0, MAX_REMAINING_MS);
    this.pending = null;
    this.io.tighten(remainingMs);
    pending.resolve(checked);
  }
}
