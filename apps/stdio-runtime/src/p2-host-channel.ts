/**
 * @astra/stdio-runtime — P2 local Host<->Node NDJSON channel (transport only).
 *
 * One stdin reader, one stdout writer. No mathematical state, no model call,
 * no method read: the channel only frames, validates and forwards messages.
 */
import {
  ERROR_CODES,
  LIMITS,
  P2_ERROR_CODES,
  parseP2HostFrame,
  p2HostPayload,
  type JsonRpcMessage,
  type P2HostManifest,
  type P2HostMethod,
} from "@astra/protocol";
import type { ManifestEnvelopes } from "@astra/protocol";

const MAX_DEADLINE_MS = 5000;
const FIXED_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(ERROR_CODES),
  ...Object.values(P2_ERROR_CODES),
  "TIMEOUT",
  "CHILD_FAILED",
]);

function fixedCode(error: unknown): string {
  if (error instanceof Error && FIXED_CODES.has(error.message)) return error.message;
  return "FIELD_VALUE";
}

/**
 * Minimal codec injection point. `parse` decodes one NDJSON frame and
 * `payload` validates one params/result payload against the same manifest.
 * The default codec binds the P2 manifest; a P3 caller passes its own pair.
 */
export interface HostChannelCodec<M extends string> {
  parse(bytes: Uint8Array): JsonRpcMessage;
  payload(method: M, side: "params" | "result", value: unknown): void;
}

export class P2HostChannel<
  M extends string = P2HostMethod,
  Manifest extends { readonly envelopes: ManifestEnvelopes } = P2HostManifest,
> {
  private readonly manifest: Manifest;
  private readonly codec: HostChannelCodec<M>;
  private readonly startedAt: number;
  private deadline: number;
  private timer: NodeJS.Timeout | null = null;
  private buffer = Buffer.alloc(0);
  private frames = 0;
  private handler: ((message: JsonRpcMessage) => void) | null = null;
  private stopping = false;
  private stopFlushed = false;
  private failed = false;

  constructor(
    manifest: Manifest,
    startedAt: number = performance.now(),
    codec?: HostChannelCodec<M>,
  ) {
    this.manifest = manifest;
    this.startedAt = startedAt;
    this.deadline = startedAt + MAX_DEADLINE_MS;
    this.codec = codec ?? {
      parse: (bytes: Uint8Array) => parseP2HostFrame(bytes, manifest as unknown as P2HostManifest),
      payload: (method: M, side: "params" | "result", value: unknown) =>
        p2HostPayload(manifest as unknown as P2HostManifest, method as unknown as P2HostMethod, side, value),
    };
  }

  remainingMs(): number {
    const left = this.deadline - performance.now();
    return left > 0 ? Math.floor(left) : 0;
  }

  tighten(ms: number): void {
    if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0 || ms > MAX_DEADLINE_MS) {
      this.fail(new Error("FIELD_VALUE"));
    }
    const candidate = performance.now() + ms;
    this.deadline = Math.min(this.deadline, candidate);
    this.rearm();
  }

  start(handler: (message: JsonRpcMessage) => void): void {
    this.handler = handler;
    this.rearm();
    process.stdin.on("data", (chunk: Buffer) => {
      try {
        this.onData(chunk);
      } catch (error) {
        this.fail(error);
      }
    });
    process.stdin.on("error", (error: Error) => {
      this.fail(error);
    });
    process.stdout.on("error", (error: Error) => {
      this.fail(error);
    });
    process.stdin.on("end", () => {
      try {
        if (!this.stopping) throw new Error("EOF");
        if (this.buffer.length !== 0) throw new Error("INVALID_JSON");
      } catch (error) {
        this.fail(error);
      }
    });
  }

  send(message: JsonRpcMessage, method: M): void {
    if (this.stopping) this.fail(new Error("FIELD_VALUE"));
    if (this.remainingMs() <= 0) this.fail(new Error("TIMEOUT"));
    if ("error" in message) this.fail(new Error("FIELD_VALUE"));
    if ("method" in message) {
      this.codec.payload(method, "params", message.params);
    } else if ("result" in message) {
      this.codec.payload(method, "result", message.result);
    } else {
      this.fail(new Error("FIELD_VALUE"));
    }
    this.write(message, null);
  }

  stop(message: JsonRpcMessage): void {
    if (this.stopping) this.fail(new Error("FIELD_VALUE"));
    if (this.buffer.length !== 0) this.fail(new Error("INVALID_JSON"));
    if (this.remainingMs() <= 0) this.fail(new Error("TIMEOUT"));
    if (!("result" in message)) this.fail(new Error("FIELD_VALUE"));
    this.codec.payload("session.stop" as M, "result", message.result);
    this.stopping = true;
    this.write(message, () => {
      if (this.remainingMs() <= 0) this.fail(new Error("TIMEOUT"));
      this.stopFlushed = true;
      this.clearTimer();
      process.exit(0);
    });
  }

  fail(error: unknown): never {
    if (this.failed) process.exit(1);
    this.failed = true;
    this.clearTimer();
    const code = fixedCode(error);
    try {
      process.stderr.write(`${code}\n`);
    } catch {
      // stderr is best-effort; the fixed code is the only output.
    }
    process.exit(1);
  }

  private rearm(): void {
    this.clearTimer();
    const left = this.deadline - performance.now();
    const delay = left > 0 ? Math.floor(left) : 0;
    this.timer = setTimeout(() => {
      this.fail(new Error("TIMEOUT"));
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private onData(chunk: Buffer): void {
    if (this.stopping) throw new Error("FIELD_VALUE");
    if (this.remainingMs() <= 0) throw new Error("TIMEOUT");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const index = this.buffer.indexOf(0x0a);
      if (index < 0) {
        if (this.buffer.length > LIMITS.maxFrameBytes) throw new Error("FRAME_TOO_LARGE");
        return;
      }
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (line.length === 0) throw new Error("INVALID_JSON");
      if (line.length > LIMITS.maxFrameBytes) throw new Error("FRAME_TOO_LARGE");
      this.frames += 1;
      if (this.frames > LIMITS.maxFramesPerSession) throw new Error("FRAME_LIMIT_EXCEEDED");
      const message = this.codec.parse(line);
      if (this.handler === null) throw new Error("FIELD_VALUE");
      this.handler(message);
      if (this.stopping) {
        if (this.buffer.length !== 0) throw new Error("INVALID_JSON");
        return;
      }
    }
  }

  private write(message: JsonRpcMessage, onFlushed: (() => void) | null): void {
    const line = `${JSON.stringify(message)}\n`;
    const data = Buffer.from(line, "utf8");
    if (data.length - 1 > LIMITS.maxFrameBytes) this.fail(new Error("FRAME_TOO_LARGE"));
    this.frames += 1;
    if (this.frames > LIMITS.maxFramesPerSession) this.fail(new Error("FRAME_LIMIT_EXCEEDED"));
    const parsed = this.codec.parse(data.subarray(0, data.length - 1));
    if (parsed === null) this.fail(new Error("FIELD_VALUE"));
    try {
      process.stdout.write(data, (error?: Error | null) => {
        if (error) this.fail(error);
        if (this.remainingMs() <= 0) this.fail(new Error("TIMEOUT"));
        if (onFlushed !== null) onFlushed();
      });
    } catch (error) {
      this.fail(error);
    }
  }
}
