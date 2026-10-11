/**
 * @astra/runtime-core — P1 offline runtime core.
 *
 * Owns the monotonic event sequence, the bounded append-only event log, the
 * root deadline and model-call admission, and the private context record with
 * its read-only public projection. It performs no I/O, reads no environment
 * variable, persists nothing and never retries a model call.
 */

import {
  P1_EVENT_TYPE,
  P1_MAX_MODEL_CALLS,
  P1_MAX_REMAINING_MS,
  P1_MAX_TRACE_EVENTS,
  P1_MAX_MESSAGE_CHARS,
  P1_MESSAGE_ROLE,
  P1_REASON,
  type P1EventType,
  type P1ModelMessage,
  type P1Reason,
  type P1TraceEvent,
  type RecordEnvelope,
} from "@astra/protocol";

export const RUNTIME_CORE_VERSION = "0.0.0-p1" as const;
export * from "./p2-methods.js";
export * from "./p3-methods.js";
export * from "./p2-a2-replay.js";
export * from "./agent-session.js";

/** Fixed admission reasons. Arbitrary text is never a reason. */
export const ADMISSION_REASON = ["ADMITTED", "BUDGET_EXHAUSTED"] as const;
export type AdmissionReason = (typeof ADMISSION_REASON)[number];

export type AdmissionDecision = import("@astra/protocol").P1AdmissionDecision;

/** Below this remaining time a model call is refused rather than started. */
export const MIN_REMAINING_MS = 25 as const;

const SOURCE_MODULES = ["M1", "M2", "M3", "M4", "M5", "HOST"] as const;

export interface SessionOptions {
  readonly sessionId: string;
  readonly problemHash: string;
  readonly remainingMs: number;
  readonly maxCalls: number;
  readonly now?: () => number;
}

function isSafeIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function cloneMessages(messages: readonly P1ModelMessage[]): readonly P1ModelMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * One P1 session. All mutable state is private; `snapshot()` and
 * `projectContext()` return deep-frozen clones, so an external mutation of a
 * returned value can never rewrite the session.
 */
export class Session {
  readonly #sessionId: string;
  readonly #problemHash: string;
  readonly #maxCalls: number;
  readonly #now: () => number;
  #deadline: number;
  #modelCalls = 0;
  #seq = 0;
  #events: P1TraceEvent[] = [];
  #context: readonly P1ModelMessage[] | null = null;
  #contextEventSeq: number | null = null;

  constructor(options: SessionOptions) {
    const { sessionId, problemHash, remainingMs, maxCalls } = options;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new RangeError("sessionId");
    }
    if (typeof problemHash !== "string" || problemHash.length !== 64) {
      throw new RangeError("problemHash");
    }
    if (!isSafeIntegerInRange(remainingMs, 1, P1_MAX_REMAINING_MS)) {
      throw new RangeError("remainingMs");
    }
    if (!isSafeIntegerInRange(maxCalls, 0, P1_MAX_MODEL_CALLS)) {
      throw new RangeError("maxCalls");
    }
    const now = options.now ?? (() => performance.now());
    const started = now();
    if (!Number.isFinite(started)) {
      throw new RangeError("now");
    }
    this.#sessionId = sessionId;
    this.#problemHash = problemHash;
    this.#maxCalls = maxCalls;
    this.#now = now;
    this.#deadline = started + remainingMs;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get problemHash(): string {
    return this.#problemHash;
  }

  /** Remaining budget in ms, never negative and never above the initial value. */
  remainingMs(): number {
    const now = this.#now();
    if (!Number.isFinite(now)) {
      return 0;
    }
    const left = Math.floor(this.#deadline - now);
    return left > 0 ? left : 0;
  }

  modelCalls(): number {
    return this.#modelCalls;
  }

  /**
   * Append one trace event. The event type and reason must be on the fixed
   * allowlist and the log is capped at `P1_MAX_TRACE_EVENTS`; the sequence
   * number is assigned here and never by the caller.
   */
  append(eventType: P1EventType, sourceModule: RecordEnvelope["sourceModule"], reason: P1Reason): P1TraceEvent {
    if (!(P1_EVENT_TYPE as readonly string[]).includes(eventType)) {
      throw new RangeError("eventType");
    }
    if (!(P1_REASON as readonly string[]).includes(reason)) {
      throw new RangeError("reason");
    }
    if (!(SOURCE_MODULES as readonly string[]).includes(sourceModule)) {
      throw new RangeError("sourceModule");
    }
    if (this.#events.length >= P1_MAX_TRACE_EVENTS) {
      throw new RangeError("trace");
    }
    this.#seq += 1;
    const event: P1TraceEvent = Object.freeze({ seq: this.#seq, eventType, sourceModule, reason });
    this.#events.push(event);
    return Object.freeze({ ...event });
  }

  /** Deep-frozen clone of the public trace. No private content is included. */
  snapshot(): readonly P1TraceEvent[] {
    return deepFreeze(this.#events.map((event) => ({ ...event })));
  }

  /**
   * Record the exact messages handed to the model in the private log. The
   * clone is stored, so later mutation of the caller's array has no effect.
   */
  recordContext(messages: readonly P1ModelMessage[], eventSeq: number): void {
    if (this.#context !== null) {
      throw new RangeError("context");
    }
    if (!isSafeIntegerInRange(eventSeq, 1, this.#seq)) {
      throw new RangeError("eventSeq");
    }
    if (!Array.isArray(messages) || messages.length !== 2) {
      throw new RangeError("messages");
    }
    const roles = messages.map((message) => message.role);
    if (roles[0] !== P1_MESSAGE_ROLE[0] || roles[1] !== P1_MESSAGE_ROLE[1]) {
      throw new RangeError("messages");
    }
    for (const message of messages) {
      if (typeof message.content !== "string" || message.content.length === 0) {
        throw new RangeError("messages");
      }
      if ([...message.content].length > P1_MAX_MESSAGE_CHARS) {
        throw new RangeError("messages");
      }
    }
    this.#context = cloneMessages(messages);
    this.#contextEventSeq = eventSeq;
  }

  /**
   * Rebuild the private context from the stored record. Returns a deep-frozen
   * clone; the original problem and the model messages never enter the public
   * trace.
   */
  projectContext(): { readonly eventSeq: number; readonly messages: readonly P1ModelMessage[] } | null {
    if (this.#context === null || this.#contextEventSeq === null) {
      return null;
    }
    return deepFreeze({
      eventSeq: this.#contextEventSeq,
      messages: cloneMessages(this.#context),
    });
  }

  /**
   * Reserve the single model call. A rejection never refreshes the budget and
   * never increments the counter; a replay therefore has no side effect.
   */
  reserveModelCall(): AdmissionDecision {
    if (this.#modelCalls >= this.#maxCalls) {
      return { admitted: false, reason: "BUDGET_EXHAUSTED" };
    }
    if (this.remainingMs() <= MIN_REMAINING_MS) {
      return { admitted: false, reason: "BUDGET_EXHAUSTED" };
    }
    this.#modelCalls += 1;
    return { admitted: true, reason: "ADMITTED" };
  }

  /** Tighten the remaining budget. It can only shrink, never grow. */
  tightenRemaining(ms: number): number {
    if (!isSafeIntegerInRange(ms, 0, P1_MAX_REMAINING_MS)) {
      throw new RangeError("ms");
    }
    const now = this.#now();
    if (!Number.isFinite(now)) {
      throw new RangeError("now");
    }
    const candidate = now + ms;
    if (candidate < this.#deadline) {
      this.#deadline = candidate;
    }
    return this.remainingMs();
  }
}
