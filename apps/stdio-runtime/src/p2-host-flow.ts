/**
 * @astra/stdio-runtime — P2 local Host single-work-unit flow controller.
 *
 * One callback in, at most one message out. No async wait loop, no retry, no
 * network, no tool. Every candidate stays a proposal: nothing here is
 * mathematical acceptance and no M4/M5 verification is claimed.
 */
import {
  P2Error,
  p2HostPayload,
  type JsonRpcMessage,
  type P2HostManifest,
  type P2HostMethod,
  type P2MethodCatalog,
  type P2MethodLoad,
} from "@astra/protocol";
import { P2HostWork } from "./p2-host-work.js";

const INIT_ID = "host-1";
const SOLVE_ID = "host-2";
const STOP_ID = "host-3";
const CATALOG_ID = "node-catalog-1";
const METHOD_ID = "node-method-1";
const MODEL_ID = "node-model-1";
const REQUEST_ID = "model-1";
const RESERVE_MS = 25;
const MAX_TOKENS = 8192;
const TEMPERATURE = "0.2";
const METHOD_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface P2HostIO {
  remainingMs(): number;
  tighten(ms: number): void;
  send(message: JsonRpcMessage, method: P2HostMethod): void;
  stop(message: JsonRpcMessage): void;
}

type Phase = "init" | "solve" | "catalog" | "load" | "model" | "stop" | "done";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
  throw new Error(code);
}

export class P2HostFlow {
  private readonly manifest: P2HostManifest;
  private readonly io: P2HostIO;
  private phase: Phase = "init";
  private sessionId: string | null = null;
  private maxModelCalls = 0;
  private maxMethodLoads = 0;
  private methodId: string | null = null;
  private work: P2HostWork | null = null;
  private modelCalls = 0;
  private methodLoads = 0;

  constructor(manifest: P2HostManifest, io: P2HostIO) {
    this.manifest = manifest;
    this.io = io;
  }

  handle(message: JsonRpcMessage): void {
    if ("error" in message) fail("FIELD_VALUE");
    if ("method" in message) {
      const params = message.params;
      if (!isPlainObject(params)) fail("FIELD_VALUE");
      switch (message.method) {
        case "runtime.initialize":
          this.onInitialize(message.id, params);
          return;
        case "session.solve":
          this.onSolve(message.id, params);
          return;
        case "session.stop":
          this.onStop(message.id, params);
          return;
        default:
          fail("UNKNOWN_METHOD");
      }
    }
    if ("result" in message) {
      const result = message.result;
      if (!isPlainObject(result)) fail("FIELD_VALUE");
      switch (this.phase) {
        case "catalog":
          this.onCatalog(message.id, result);
          return;
        case "load":
          this.onLoad(message.id, result);
          return;
        case "model":
          this.onModel(message.id, result);
          return;
        default:
          fail("ID_MISMATCH");
      }
    }
    fail("FIELD_VALUE");
  }

  private requirePhase(expected: Phase, id: string): void {
    if (this.phase !== expected) fail("ID_MISMATCH");
    if (id !== this.expectedId(expected)) fail("ID_MISMATCH");
  }

  private expectedId(phase: Phase): string {
    switch (phase) {
      case "init":
        return INIT_ID;
      case "solve":
        return SOLVE_ID;
      case "catalog":
        return CATALOG_ID;
      case "load":
        return METHOD_ID;
      case "model":
        return MODEL_ID;
      default:
        return STOP_ID;
    }
  }

  private bound(method: P2HostMethod, side: "params" | "result", value: unknown): void {
    p2HostPayload(this.manifest, method, side, value, this.sessionId ?? undefined);
  }

  private onInitialize(id: string, params: Record<string, unknown>): void {
    this.requirePhase("init", id);
    this.bound("runtime.initialize", "params", params);
    const sessionId = params["sessionId"];
    const remainingMs = params["remainingMs"];
    const maxModelCalls = params["maxModelCalls"];
    const maxMethodLoads = params["maxMethodLoads"];
    if (typeof sessionId !== "string") fail("FIELD_VALUE");
    if (typeof remainingMs !== "number" || typeof maxModelCalls !== "number") fail("FIELD_VALUE");
    if (typeof maxMethodLoads !== "number") fail("FIELD_VALUE");
    this.sessionId = sessionId;
    this.maxModelCalls = maxModelCalls;
    this.maxMethodLoads = maxMethodLoads;
    this.io.tighten(remainingMs);
    this.phase = "solve";
    this.io.send(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "1.0-p2-host-local",
          sessionId,
          mode: "MOCK_ONLY",
          targetEnvironment: "TARGET_UNVERIFIED",
        },
      },
      "runtime.initialize",
    );
  }

  private onSolve(id: string, params: Record<string, unknown>): void {
    this.requirePhase("solve", id);
    this.bound("session.solve", "params", params);
    const sessionId = params["sessionId"];
    const problem = params["problem"];
    const problemHash = params["problemHash"];
    const methodId = params["methodId"];
    if (typeof sessionId !== "string" || typeof problem !== "string") fail("FIELD_VALUE");
    if (typeof problemHash !== "string") fail("FIELD_VALUE");
    if (methodId !== null && typeof methodId !== "string") fail("FIELD_VALUE");
    if (typeof methodId === "string") {
      if (methodId.length > 64 || !METHOD_ID_PATTERN.test(methodId)) fail("FIELD_VALUE");
    }
    this.methodId = methodId;
    this.work = new P2HostWork(problem, sessionId, problemHash);
    if (this.io.remainingMs() <= RESERVE_MS || this.maxModelCalls === 0) {
      this.finish(id);
      return;
    }
    if (methodId !== null && this.maxMethodLoads === 1) {
      this.phase = "catalog";
      this.io.send(
        {
          jsonrpc: "2.0",
          id: CATALOG_ID,
          method: "method.catalog",
          params: { protocolVersion: "1.0-p2-host-local", sessionId },
        },
        "method.catalog",
      );
      return;
    }
    if (methodId !== null) this.work.refuseMethod();
    this.model();
  }

  private onCatalog(id: string, params: Record<string, unknown>): void {
    this.requirePhase("catalog", id);
    this.bound("method.catalog", "result", params);
    const work = this.work;
    if (work === null) fail("FIELD_VALUE");
    const remainingMs = params["remainingMs"];
    const catalog = params["catalog"];
    if (typeof remainingMs !== "number" || !isPlainObject(catalog)) fail("FIELD_VALUE");
    this.io.tighten(remainingMs);
    if (this.io.remainingMs() <= RESERVE_MS) {
      this.finish(SOLVE_ID);
      return;
    }
    work.setCatalog(catalog as unknown as P2MethodCatalog);
    const methodId = this.methodId;
    if (methodId !== null && work.canLoad(methodId)) {
      this.methodLoads += 1;
      this.phase = "load";
      this.io.send(
        {
          jsonrpc: "2.0",
          id: METHOD_ID,
          method: "method.load",
          params: {
            protocolVersion: "1.0-p2-host-local",
            sessionId: this.sessionId,
            methodId,
          },
        },
        "method.load",
      );
      return;
    }
    work.refuseMethod();
    this.model();
  }

  private onLoad(id: string, params: Record<string, unknown>): void {
    this.requirePhase("load", id);
    this.bound("method.load", "result", params);
    const work = this.work;
    const methodId = this.methodId;
    if (work === null || methodId === null) fail("FIELD_VALUE");
    const remainingMs = params["remainingMs"];
    const loadedId = params["methodId"];
    const status = params["status"];
    const asset = params["asset"];
    if (typeof remainingMs !== "number" || typeof loadedId !== "string") fail("FIELD_VALUE");
    if (typeof status !== "string") fail("FIELD_VALUE");
    if (loadedId !== methodId) fail("ID_MISMATCH");
    this.io.tighten(remainingMs);
    if (this.io.remainingMs() <= RESERVE_MS) {
      this.finish(SOLVE_ID);
      return;
    }
    work.acceptMethod(methodId, { status, asset } as unknown as P2MethodLoad);
    this.model();
  }

  private model(): void {
    const work = this.work;
    if (work === null) fail("FIELD_VALUE");
    if (this.io.remainingMs() <= RESERVE_MS || this.modelCalls >= this.maxModelCalls) {
      this.finish(SOLVE_ID);
      return;
    }
    let prepared;
    try {
      prepared = work.prepare();
    } catch (error) {
      if (error instanceof P2Error) {
        this.finish(SOLVE_ID);
        return;
      }
      throw error;
    }
    if (this.io.remainingMs() <= RESERVE_MS) {
      this.finish(SOLVE_ID);
      return;
    }
    this.modelCalls += 1;
    this.phase = "model";
    this.io.send(
      {
        jsonrpc: "2.0",
        id: MODEL_ID,
        method: "model.generate",
        params: {
          protocolVersion: "1.0-p2-host-local",
          sessionId: this.sessionId,
          requestId: REQUEST_ID,
          problemHash: work.contract.problemHash,
          contractVersion: work.contract.contractVersion,
          taskId: work.task.taskId,
          scopeId: work.task.scopeId,
          contextHash: prepared.contextHash,
          maxTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          messages: prepared.messages,
        },
      },
      "model.generate",
    );
  }

  private onModel(id: string, params: Record<string, unknown>): void {
    this.requirePhase("model", id);
    this.bound("model.generate", "result", params);
    const work = this.work;
    if (work === null) fail("FIELD_VALUE");
    const remainingMs = params["remainingMs"];
    const deliveryStatus = params["deliveryStatus"];
    const text = params["text"];
    if (typeof remainingMs !== "number" || typeof deliveryStatus !== "string") fail("FIELD_VALUE");
    if (typeof text !== "string") fail("FIELD_VALUE");
    this.io.tighten(remainingMs);
    if (this.io.remainingMs() <= RESERVE_MS) {
      this.finish(SOLVE_ID);
      return;
    }
    try {
      work.accept(deliveryStatus as never, text);
    } catch (error) {
      if (error instanceof P2Error) {
        this.finish(SOLVE_ID);
        return;
      }
      throw error;
    }
    if (this.io.remainingMs() <= RESERVE_MS) work.invalidateLatest();
    this.finish(SOLVE_ID);
  }

  private finish(id: string): void {
    const work = this.work;
    if (work === null) fail("FIELD_VALUE");
    this.phase = "stop";
    this.io.send(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "1.0-p2-host-local",
          sessionId: this.sessionId,
          ...work.summary(this.modelCalls, this.methodLoads),
        },
      },
      "session.solve",
    );
  }

  private onStop(id: string, params: Record<string, unknown>): void {
    this.requirePhase("stop", id);
    this.bound("session.stop", "params", params);
    this.phase = "done";
    this.io.stop({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: "1.0-p2-host-local", sessionId: this.sessionId, stopped: true },
    });
  }
}
