/**
 * P1 offline Node controller.
 *
 * Owns the P1 session state machine (init -> solve -> model callback -> stop)
 * and the NDJSON transport. It composes the six P1 packages; no mathematical
 * decision lives here. stdout carries NDJSON only, stderr carries fixed codes
 * only, and no private content is ever echoed.
 */

import { readFileSync } from "node:fs";

import {
  ERROR_CODES,
  LIMITS,
  P1_MAX_MODEL_CALLS,
  P1_MAX_REMAINING_MS,
  P1_MODE,
  P1_MODEL_REQUEST_ID,
  P1_PROTOCOL_VERSION,
  P1_TARGET_ENVIRONMENT,
  checkP1Binding,
  classifyP1Method,
  parseP1Frame,
  validateP1Manifest,
  validateP1Payload,
  type ErrorCode,
  type JsonRpcMessage,
  type P1Manifest,
  type P1Method,
  type ParseResult,
} from "@astra/protocol";
import { Session } from "@astra/runtime-core";
import { compileContract, problemHashOf } from "@astra/math-contract";
import { admitModelCall } from "@astra/math-gateway";
import { acceptModelResult, prepareMessages } from "@astra/math-workunit";
import { reviewSkipped } from "@astra/math-review";
import { finalize } from "@astra/math-audit";

const DEADLINE_MS = 5000;
const MAX_FRAMES = LIMITS.maxFramesPerSession;
const MAX_FRAME_BYTES = LIMITS.maxFrameBytes;
const HOST_IDS = ["host-1", "host-2", "host-3"] as const;
const CALLBACK_ID = "node-model-1";

type Phase = "init" | "solve" | "callback" | "stop" | "stopping";

export function loadP1Manifest(): P1Manifest {
  const url = import.meta.resolve("@astra/protocol/schema/p1.schema.json");
  const raw: unknown = JSON.parse(readFileSync(new URL(url), "utf8"));
  const checked = validateP1Manifest(raw);
  if (!checked.ok) {
    throw new Error(checked.code);
  }
  return checked.value;
}

export class P1Controller {
  private readonly manifest: P1Manifest;
  private readonly startedAt: number;
  private timer: NodeJS.Timeout;
  private buffer: Buffer = Buffer.alloc(0);
  private frames = 0;
  private phase: Phase = "init";
  private sessionId: string | null = null;
  private deadline: number;
  private maxCalls = 0;
  private session: Session | null = null;
  private hostIdIndex = 0;
  private callbackId: string | null = null;
  private pendingSolveId: string | null = null;
  private stopped = false;
  private contract: import("@astra/protocol").P1Contract | null = null;

  constructor(manifest: P1Manifest, startedAt: number) {
    this.manifest = manifest;
    this.startedAt = startedAt;
    this.deadline = startedAt + DEADLINE_MS;
    const left = this.deadline - performance.now();
    this.timer = setTimeout(() => this.fail("DEADLINE_EXCEEDED"), left > 0 ? left : 0);
  }

  start(): void {
    process.stdin.on("data", (chunk: Buffer) => this.onData(chunk));
    process.stdin.on("end", () => this.fail(ERROR_CODES.EOF));
    process.stdin.on("error", () => this.fail(ERROR_CODES.EOF));
    process.stdout.on("error", () => this.fail(ERROR_CODES.EOF));
    process.stderr.on("error", () => process.exit(1));
    process.stdin.resume();
  }

  private expired(): boolean {
    return performance.now() >= this.deadline;
  }

  /** Re-arm the single timer against the current absolute deadline. */
  private armDeadline(): void {
    clearTimeout(this.timer);
    const left = this.deadline - performance.now();
    this.timer = setTimeout(() => this.fail("DEADLINE_EXCEEDED"), left > 0 ? left : 0);
  }

  private onData(chunk: Buffer): void {
    if (this.expired()) {
      this.fail("DEADLINE_EXCEEDED");
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const index = this.buffer.indexOf(0x0a);
      if (index < 0) {
        if (this.buffer.byteLength > MAX_FRAME_BYTES) {
          this.fail(ERROR_CODES.FRAME_TOO_LARGE);
        }
        return;
      }
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (line.byteLength > MAX_FRAME_BYTES) {
        this.fail(ERROR_CODES.FRAME_TOO_LARGE);
        return;
      }
      this.frames += 1;
      if (this.frames > MAX_FRAMES) {
        this.fail(ERROR_CODES.FRAME_LIMIT_EXCEEDED);
        return;
      }
      if (line.byteLength === 0) {
        this.fail(ERROR_CODES.INVALID_JSON);
        return;
      }
      const parsed = parseP1Frame(line, this.manifest);
      if (!parsed.ok) {
        this.fail(parsed.code);
        return;
      }
      try {
        this.dispatch(parsed.value);
      } catch {
        this.fail("P1_INVALID");
        return;
      }
      if (this.phase === "stopping") {
        if (this.buffer.byteLength > 0) {
          this.fail(ERROR_CODES.FIELD_VALUE);
        }
        return;
      }
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if ("method" in message) {
      this.onRequest(message.id, message.method, message.params);
      return;
    }
    if ("result" in message) {
      this.onResult(message.id, message.result);
      return;
    }
    this.fail(ERROR_CODES.FIELD_VALUE);
  }

  private onRequest(id: string, method: string, params: Record<string, unknown>): void {
    if (id.startsWith("node-") || id !== HOST_IDS[this.hostIdIndex]) {
      this.fail(ERROR_CODES.ID_MISMATCH);
      return;
    }
    const classified = classifyP1Method(method);
    if (!classified.ok) {
      this.fail(classified.code);
      return;
    }
    const expected = this.expectedMethod();
    if (expected === null || classified.value !== expected) {
      this.fail("P1_STATE_INVALID");
      return;
    }
    this.hostIdIndex += 1;
    if (classified.value === "runtime.initialize") {
      this.handleInitialize(id, params);
      return;
    }
    if (classified.value === "session.solve") {
      this.handleSolve(id, params);
      return;
    }
    this.handleStop(id, params);
  }

  private expectedMethod(): P1Method | null {
    if (this.phase === "init") {
      return "runtime.initialize";
    }
    if (this.phase === "solve") {
      return "session.solve";
    }
    if (this.phase === "stop") {
      return "session.stop";
    }
    return null;
  }

  private checkParams(method: P1Method, params: Record<string, unknown>): ParseResult<null> {
    const checked = validateP1Payload(method, "params", params, this.manifest);
    if (!checked.ok) {
      return checked;
    }
    if (method === "runtime.initialize") {
      return { ok: true, value: null };
    }
    return checkP1Binding(params, this.sessionId ?? "");
  }

  private handleInitialize(id: string, params: Record<string, unknown>): void {
    const checked = this.checkParams("runtime.initialize", params);
    if (!checked.ok) {
      this.fail(checked.code);
      return;
    }
    const sessionId = params["sessionId"];
    const remainingMs = params["remainingMs"];
    const maxModelCalls = params["maxModelCalls"];
    if (
      typeof sessionId !== "string" ||
      typeof remainingMs !== "number" ||
      typeof maxModelCalls !== "number"
    ) {
      this.fail(ERROR_CODES.FIELD_TYPE);
      return;
    }
    const rootLeft = Math.floor(this.deadline - performance.now());
    const window = Math.min(rootLeft, remainingMs);
    if (!Number.isSafeInteger(window) || window < 1) {
      this.fail("DEADLINE_EXCEEDED");
      return;
    }
    this.sessionId = sessionId;
    this.maxCalls = maxModelCalls;
    const candidate = performance.now() + window;
    if (candidate < this.deadline) {
      this.deadline = candidate;
    }
    this.armDeadline();
    this.phase = "solve";
    this.send(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: P1_PROTOCOL_VERSION,
          sessionId,
          mode: P1_MODE,
          targetEnvironment: P1_TARGET_ENVIRONMENT,
        },
      },
      "runtime.initialize",
    );
  }

  private handleSolve(id: string, params: Record<string, unknown>): void {
    const checked = this.checkParams("session.solve", params);
    if (!checked.ok) {
      this.fail(checked.code);
      return;
    }
    const problem = params["problem"];
    const problemHash = params["problemHash"];
    if (typeof problem !== "string" || typeof problemHash !== "string") {
      this.fail(ERROR_CODES.FIELD_TYPE);
      return;
    }
    if (problemHashOf(problem) !== problemHash) {
      this.fail(ERROR_CODES.FIELD_VALUE);
      return;
    }
    const sessionId = this.sessionId ?? "";
    const remaining = this.remainingMs();
    if (remaining < 1) {
      this.fail("DEADLINE_EXCEEDED");
      return;
    }
    const session = new Session({
      sessionId,
      problemHash,
      remainingMs: remaining,
      maxCalls: this.maxCalls,
    });
    this.session = session;
    session.append("SESSION_INITIALIZED", "HOST", "START");
    const contractEvent = session.append("CONTRACT_CREATED", "M1", "CONTRACT_CREATED");
    const contract = compileContract(problem, sessionId, problemHash, contractEvent.seq);
    this.contract = contract;
    const admission = admitModelCall(session.remainingMs(), this.maxCalls - session.modelCalls());
    if (!admission.admitted) {
      session.append("MODEL_BUDGET_EXHAUSTED", "M2", "BUDGET_EXHAUSTED");
      this.finishSolve(id, session, contract, null);
      return;
    }
    const reserved = session.reserveModelCall();
    if (!reserved.admitted) {
      session.append("MODEL_BUDGET_EXHAUSTED", "M2", "BUDGET_EXHAUSTED");
      this.finishSolve(id, session, contract, null);
      return;
    }
    const admitted = session.append("MODEL_ADMITTED", "M2", "ADMITTED");
    const messages = prepareMessages(contract);
    session.recordContext(messages, admitted.seq);
    const context = session.projectContext();
    if (context === null) {
      this.fail("P1_INVALID");
      return;
    }
    this.pendingSolveId = id;
    this.callbackId = CALLBACK_ID;
    this.phase = "callback";
    this.send(
      {
        jsonrpc: "2.0",
        id: CALLBACK_ID,
        method: "model.generate",
        params: {
          protocolVersion: P1_PROTOCOL_VERSION,
          sessionId,
          requestId: P1_MODEL_REQUEST_ID,
          problemHash,
          contractVersion: contract.contractVersion,
          maxTokens: this.manifest.methods["model.generate"] === undefined ? 0 : 8192,
          messages: context.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        },
      },
      "model.generate",
    );
  }

  private onResult(id: string, result: Record<string, unknown>): void {
    if (this.phase !== "callback" || this.callbackId === null || id !== this.callbackId) {
      this.fail(ERROR_CODES.ID_MISMATCH);
      return;
    }
    const checked = validateP1Payload("model.generate", "result", result, this.manifest);
    if (!checked.ok) {
      this.fail(checked.code);
      return;
    }
    const bound = checkP1Binding(result, this.sessionId ?? "");
    if (!bound.ok) {
      this.fail(bound.code);
      return;
    }
    if (result["requestId"] !== P1_MODEL_REQUEST_ID) {
      this.fail(ERROR_CODES.ID_MISMATCH);
      return;
    }
    const session = this.session;
    const solveId = this.pendingSolveId;
    const deliveryStatus = result["deliveryStatus"];
    const text = result["text"];
    const remainingMs = result["remainingMs"];
    if (
      session === null ||
      solveId === null ||
      typeof deliveryStatus !== "string" ||
      typeof text !== "string" ||
      typeof remainingMs !== "number"
    ) {
      this.fail("P1_INVALID");
      return;
    }
    this.callbackId = null;
    this.pendingSolveId = null;
    session.tightenRemaining(remainingMs);
    const tightened = performance.now() + session.remainingMs();
    if (tightened < this.deadline) {
      this.deadline = tightened;
    }
    this.armDeadline();
    if (this.remainingMs() < 1) {
      this.fail("DEADLINE_EXCEEDED");
      return;
    }
    const contract = this.contract;
    if (contract === null) {
      this.fail("P1_INVALID");
      return;
    }
    const work = acceptModelResult(
      contract,
      deliveryStatus as never,
      text,
      P1_MODEL_REQUEST_ID,
      session.snapshot().length + 1,
    );
    if (deliveryStatus === "COMPLETE") {
      session.append("MODEL_RETURNED", "M3", "MODEL_RETURNED");
    } else if (deliveryStatus === "TRUNCATED") {
      session.append("MODEL_TRUNCATED", "M3", "MODEL_TRUNCATED");
    } else if (deliveryStatus === "ERROR") {
      session.append("MODEL_ERROR", "M3", "MODEL_ERROR");
    } else {
      session.append("MODEL_UNKNOWN", "M3", "MODEL_UNKNOWN");
    }
    this.finishSolve(solveId, session, contract, work);
  }

  private finishSolve(
    solveId: string,
    session: Session,
    contract: import("@astra/protocol").P1Contract,
    work: import("@astra/protocol").P1WorkResult | null,
  ): void {
    const reviewEvent = session.append("REVIEW_SKIPPED", "M4", "REVIEW_SKIPPED");
    const review = reviewSkipped(contract, reviewEvent.seq);
    const decision = finalize(contract, work, review);
    if (decision.status === "candidate") {
      session.append("BEST_EFFORT", "M5", "BEST_EFFORT");
    } else {
      session.append("NO_CANDIDATE", "M5", "NO_CANDIDATE");
    }
    session.append("FINALIZED", "M5", "FINALIZED");
    this.phase = "stop";
    this.send(
      {
        jsonrpc: "2.0",
        id: solveId,
        result: {
          protocolVersion: P1_PROTOCOL_VERSION,
          sessionId: session.sessionId,
          status: decision.status,
          finalResponse: decision.finalResponse,
          candidateVerified: false,
          strictAcceptance: decision.strictAcceptance,
          mode: P1_MODE,
          trace: session.snapshot().map((event) => ({
            seq: event.seq,
            eventType: event.eventType,
            sourceModule: event.sourceModule,
            reason: event.reason,
          })),
          modelCalls: session.modelCalls(),
        },
      },
      "session.solve",
    );
  }

  private handleStop(id: string, params: Record<string, unknown>): void {
    const checked = this.checkParams("session.stop", params);
    if (!checked.ok) {
      this.fail(checked.code);
      return;
    }
    this.phase = "stopping";
    this.send(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: P1_PROTOCOL_VERSION,
          sessionId: this.sessionId,
          stopped: true,
        },
      },
      "session.stop",
      () => {
        this.stopped = true;
        clearTimeout(this.timer);
        process.exit(0);
      },
    );
  }

  private remainingMs(): number {
    const left = Math.floor(this.deadline - performance.now());
    return left > 0 ? left : 0;
  }

  private send(message: JsonRpcMessage, method: P1Method, onFlushed?: () => void): void {
    if (this.expired()) {
      this.fail("DEADLINE_EXCEEDED");
      return;
    }
    const spec = this.manifest.methods[method];
    if (spec === undefined) {
      this.fail(ERROR_CODES.MANIFEST_INVALID);
      return;
    }
    if ("error" in message) {
      this.fail(ERROR_CODES.FIELD_VALUE);
      return;
    }
    const payload = "method" in message ? message.params : message.result;
    const node = "method" in message ? spec.params : spec.result;
    const checked = validateP1Payload(method, "method" in message ? "params" : "result", payload, this.manifest);
    if (!checked.ok) {
      this.fail(checked.code);
      return;
    }
    void node;
    const line = `${JSON.stringify(message)}\n`;
    const envelope = parseP1Frame(Buffer.from(line.slice(0, -1), "utf8"), this.manifest);
    if (!envelope.ok) {
      this.fail(envelope.code);
      return;
    }
    this.frames += 1;
    if (this.frames > MAX_FRAMES) {
      this.fail(ERROR_CODES.FRAME_LIMIT_EXCEEDED);
      return;
    }
    if (Buffer.byteLength(line, "utf8") - 1 > MAX_FRAME_BYTES) {
      this.fail(ERROR_CODES.FRAME_TOO_LARGE);
      return;
    }
    process.stdout.write(line, (error) => {
      if (error) {
        this.fail(ERROR_CODES.EOF);
        return;
      }
      if (this.expired()) {
        this.fail("DEADLINE_EXCEEDED");
        return;
      }
      if (onFlushed !== undefined) {
        onFlushed();
      }
    });
  }

  private fail(code: ErrorCode | string): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearTimeout(this.timer);
    process.stderr.write(`${code}\n`);
    process.exit(1);
  }
}

export function runP1(): void {
  const startedAt = performance.now();
  let manifest: P1Manifest;
  try {
    manifest = loadP1Manifest();
  } catch {
    process.stderr.write(`${ERROR_CODES.MANIFEST_INVALID}\n`);
    process.exit(1);
    return;
  }
  try {
    const controller = new P1Controller(manifest, startedAt);
    controller.start();
  } catch {
    process.stderr.write(`${ERROR_CODES.MANIFEST_INVALID}\n`);
    process.exit(1);
  }
}
