/**
 * @astra/runtime-core — unified AgentSession root clock and global counters.
 *
 * One session owns the single root deadline, the global model/effect counters
 * and the append-only fixed-code trace for a whole AgentLoop run (work units,
 * tools, R2 review and S3). It performs no I/O, owns no timer, dispatches
 * nothing and never refreshes the budget: a rejected reservation has no side
 * effect, and an invalid clock permanently pins the remaining time to zero.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  type AgentModelPhase,
  type AgentSessionSnapshot,
  type AgentTraceCode,
  type AgentTraceEvent,
  type AgentTraceKind,
  type AgentTraceState,
  type P2TransportStatus,
} from "@astra/protocol";

export const AGENT_SESSION_VERSION = "0.0.0-agent" as const;

/** Below this remaining time no model call or effect is admitted. */
export const AGENT_MIN_REMAINING_MS = 25 as const;
export const AGENT_MAX_REMAINING_MS = 3_600_000 as const;
export const AGENT_MAX_MODEL_CALLS = 256 as const;
/**
 * Effect id capacity of one root session: six ids exist so up to four method
 * cards and two tool effects can coexist in one window. This is the size of
 * the id table only; it is not a widened caller tool budget.
 */
export const AGENT_MAX_EFFECTS = 6 as const;
/**
 * Hard ceiling of the public `maxEffects` option, unchanged at two: the extra
 * ids are reserved for the bounded method-card quota and are never grantable
 * through the tool option (`python/astra_bridge/agent_runtime.py` also accepts
 * only 0..2).
 */
export const AGENT_MAX_EFFECT_OPTION = 2 as const;
/** Host ceiling for method-card loads in one root session. */
export const AGENT_MAX_METHOD_LOADS = 4 as const;
/**
 * AgentLoop ceiling for distinct method-card bodies in one run. The Host can
 * admit up to {@link AGENT_MAX_METHOD_LOADS}, but one work path only offers a
 * second card when the routed set genuinely has one; a third body is never
 * requested.
 */
export const AGENT_MAX_METHOD_ASSETS = 2 as const;
export const AGENT_MAX_TRACE_EVENTS = 128 as const;

// Root model request ids are generated up to the hard cap; the preview profile
// just uses a smaller budget. No fixed four-id table any more.
const modelIdFor = (index: number): string => `model-${index + 1}`;
const EFFECT_IDS = [
  "effect-1",
  "effect-2",
  "effect-3",
  "effect-4",
  "effect-5",
  "effect-6",
] as const;
const PHASES = ["WORK", "CONSENSUS", "R2", "R4", "REPAIR", "R0"] as const;
const TRANSPORTS = ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const;
const TRACE_KINDS = ["MODEL", "EFFECT", "CONTROL"] as const;
const TRACE_STATES = ["DISPATCHED", "RETURNED", "OUTCOME_UNKNOWN", "RECORDED"] as const;
const TRACE_CODES = [
  "WORK",
  "CONSENSUS",
  "R2",
  "R4",
  "REPAIR",
  "R0",
  "COMPLETE",
  "TRUNCATED",
  "ERROR",
  "UNKNOWN",
  "ADMITTED",
  "BUDGET_EXHAUSTED",
  "DEADLINE_EXCEEDED",
  "ILLEGAL_TRANSITION",
  "NO_CANDIDATE",
  "NO_REVIEW",
  "CONTROL_REJECTED",
  "PACKET_REJECTED",
  "CONTEXT_REJECTED",
  "REVIEW_STOP",
  "REVIEWS_COMPLETE",
  "WORK_UNITS_COMPLETE",
  "REVISED_CANDIDATE",
  "REVISE_REJECTED",
  "PORT_REJECTED",
  "STOPPED",
] as const;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_SESSION_CHARS = 128;

export interface AgentSessionOptions {
  readonly sessionId: string;
  readonly problemHash: string;
  readonly maxModelCalls: number;
  readonly maxEffects: number;
  readonly remainingMs: number;
  readonly now?: () => number;
}

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function boundedInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function boundedId(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectLoneSurrogates(value).ok) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if ([...value].length > maxChars) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function enumOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value as T;
}

/**
 * One unified root session. All mutable state is private; `snapshot()` returns
 * a deep-frozen clone with no raw text, so an external mutation of a returned
 * value can never rewrite the session.
 */
export class AgentSession {
  readonly #sessionId: string;
  readonly #problemHash: string;
  readonly #maxModelCalls: number;
  readonly #maxEffects: number;
  readonly #now: () => number;
  readonly #initialBudgetMs: number;
  #deadline: number;
  #clockInvalid = false;
  #lastNow: number;
  #modelCalls = 0;
  #effectCalls = 0;
  #stopped = false;
  #pendingModel: string | null = null;
  #pendingEffect: string | null = null;
  #seq = 0;
  #events: AgentTraceEvent[] = [];

  constructor(options: AgentSessionOptions) {
    if (typeof options !== "object" || options === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const sessionId = boundedId(options.sessionId, MAX_SESSION_CHARS);
    const problemHash = options.problemHash;
    if (typeof problemHash !== "string" || !HASH.test(problemHash)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const maxModelCalls = boundedInt(options.maxModelCalls, 0, AGENT_MAX_MODEL_CALLS);
    const maxEffects = boundedInt(options.maxEffects, 0, AGENT_MAX_EFFECTS);
    const budgetMs = boundedInt(options.remainingMs, 1, AGENT_MAX_REMAINING_MS);
    const clock = options.now ?? (() => performance.now());
    if (typeof clock !== "function") {
      fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
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
    this.#sessionId = sessionId;
    this.#problemHash = problemHash;
    this.#maxModelCalls = maxModelCalls;
    this.#maxEffects = maxEffects;
    this.#now = clock;
    this.#lastNow = started;
    this.#initialBudgetMs = budgetMs;
    const deadline = Math.floor(started) + budgetMs;
    if (!Number.isSafeInteger(deadline)) {
      fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    const difference = deadline - started;
    if (difference < 0 || difference > budgetMs) {
      fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    this.#deadline = deadline;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get problemHash(): string {
    return this.#problemHash;
  }

  /**
   * Remaining root budget in ms. A throwing, non-finite or rewinding clock
   * permanently pins the view to zero; the value never exceeds the initial
   * budget and never grows.
   */
  remainingMs(): number {
    if (this.#clockInvalid) {
      return 0;
    }
    let value: number;
    try {
      value = this.#now();
    } catch {
      this.#clockInvalid = true;
      return 0;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < this.#lastNow) {
      this.#clockInvalid = true;
      return 0;
    }
    this.#lastNow = value;
    const left = Math.floor(this.#deadline - value);
    if (left <= 0) {
      return 0;
    }
    const ceiling = Math.min(AGENT_MAX_REMAINING_MS, this.#initialBudgetMs);
    return left > ceiling ? ceiling : left;
  }

  modelCalls(): number {
    return this.#modelCalls;
  }

  /**
   * Tighten the root deadline to at most `ms` from the last observed clock
   * value. The budget can only shrink: a larger value is ignored, an invalid
   * value is refused without any state change, and an already pinned clock
   * stays pinned at zero. Returns the resulting remaining view.
   */
  tightenRemaining(ms: number): number {
    if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0 || ms > AGENT_MAX_REMAINING_MS) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (this.#clockInvalid) {
      return 0;
    }
    let value: number;
    try {
      value = this.#now();
    } catch {
      this.#clockInvalid = true;
      return 0;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < this.#lastNow) {
      this.#clockInvalid = true;
      return 0;
    }
    this.#lastNow = value;
    const left = Math.floor(this.#deadline - value);
    const current = left <= 0 ? 0 : left;
    if (this.#clockInvalid) {
      return 0;
    }
    if (ms > current) {
      return current;
    }
    const candidate = Math.floor(this.#lastNow) + ms;
    if (candidate < this.#deadline) {
      this.#deadline = candidate;
    }
    const next = Math.floor(this.#deadline - this.#lastNow);
    return next <= 0 ? 0 : next;
  }

  effectCalls(): number {
    return this.#effectCalls;
  }

  /** The next root model ordinal, or null when the ceiling is reached. */
  nextModelId(): string | null {
    if (this.#modelCalls >= this.#maxModelCalls || this.#modelCalls >= AGENT_MAX_MODEL_CALLS) {
      return null;
    }
    return modelIdFor(this.#modelCalls);
  }

  /**
   * Reserve the next root model call. Guards run before any mutation, so a
   * rejection never increments a counter and never refreshes the budget.
   */
  reserveModel(phase: AgentModelPhase): string {
    const checkedPhase = enumOf(phase, PHASES);
    if (this.#stopped) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.#pendingModel !== null || this.#pendingEffect !== null) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.#modelCalls >= this.#maxModelCalls) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    if (this.remainingMs() <= AGENT_MIN_REMAINING_MS) {
      fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    const requestId =
      this.#modelCalls < AGENT_MAX_MODEL_CALLS ? modelIdFor(this.#modelCalls) : undefined;
    if (requestId === undefined) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    this.#modelCalls += 1;
    this.#pendingModel = requestId;
    this.append("MODEL", requestId, "DISPATCHED", checkedPhase);
    return requestId;
  }

  /**
   * Settle the pending model call. Only an UNKNOWN outcome stops the session
   * permanently: a TRUNCATED or ERROR receipt is a known, determinate terminal
   * state (the provider answered), so the stage logic above may retry it or
   * skip it instead of aborting the whole run. A repeated settle of the same
   * id is refused.
   */
  settleModel(requestId: string, transport: P2TransportStatus): void {
    const id = boundedId(requestId, 256);
    const status = enumOf(transport, TRANSPORTS);
    if (this.#pendingModel === null || this.#pendingModel !== id) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    this.#pendingModel = null;
    if (status === "UNKNOWN") {
      this.#stopped = true;
      this.append("MODEL", id, "OUTCOME_UNKNOWN", "UNKNOWN");
      return;
    }
    this.append("MODEL", id, "RETURNED", status);
  }

  /**
   * Reserve one root effect. A tool must leave at least one model call for the
   * follow-up work unit, so the reservation is refused when no model call
   * remains. Guards run before any mutation.
   */
  reserveEffect(effectId: string): string {
    const id = boundedId(effectId, 256);
    if (this.#stopped) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.#pendingModel !== null || this.#pendingEffect !== null) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.#effectCalls >= this.#maxEffects) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    if (this.#modelCalls >= this.#maxModelCalls) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    if (this.remainingMs() <= AGENT_MIN_REMAINING_MS) {
      fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    const expected = EFFECT_IDS[this.#effectCalls];
    if (expected === undefined || expected !== id) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    this.#effectCalls += 1;
    this.#pendingEffect = id;
    this.append("EFFECT", id, "DISPATCHED", "ADMITTED");
    return id;
  }

  /**
   * Settle the pending effect. An UNKNOWN receipt stops the session
   * permanently; a repeated settle of the same id is refused.
   */
  settleEffect(effectId: string, status: "COMPLETE" | "ERROR" | "UNKNOWN"): void {
    const id = boundedId(effectId, 256);
    const checked = enumOf(status, ["COMPLETE", "ERROR", "UNKNOWN"] as const);
    if (this.#pendingEffect === null || this.#pendingEffect !== id) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    this.#pendingEffect = null;
    if (checked === "UNKNOWN") {
      this.#stopped = true;
      this.append("EFFECT", id, "OUTCOME_UNKNOWN", "UNKNOWN");
      return;
    }
    this.append("EFFECT", id, "RETURNED", checked);
  }

  /**
   * Stop the session with a fixed control code. A pending call must be settled
   * first, so a stop can never hide an in-flight request.
   */
  stop(code: AgentTraceCode): void {
    const checked = enumOf(code, TRACE_CODES);
    if (this.#pendingModel !== null || this.#pendingEffect !== null) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.append("CONTROL", "control", "RECORDED", checked);
  }

  stopped(): boolean {
    return this.#stopped;
  }

  /** Deep-frozen public projection. No raw text and no live reference. */
  snapshot(): AgentSessionSnapshot {
    return p2Snapshot({
      sessionId: this.#sessionId,
      problemHash: this.#problemHash,
      modelCalls: this.#modelCalls,
      effectCalls: this.#effectCalls,
      stopped: this.#stopped,
      pendingModel: this.#pendingModel,
      pendingEffect: this.#pendingEffect,
      events: this.#events.map((event) => ({ ...event })),
    }) as AgentSessionSnapshot;
  }

  private append(
    kind: AgentTraceKind,
    id: string,
    state: AgentTraceState,
    code: AgentTraceCode,
  ): void {
    if (!(TRACE_KINDS as readonly string[]).includes(kind)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!(TRACE_STATES as readonly string[]).includes(state)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!(TRACE_CODES as readonly string[]).includes(code)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (this.#events.length >= AGENT_MAX_TRACE_EVENTS) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    this.#seq += 1;
    this.#events.push(Object.freeze({ seq: this.#seq, kind, id, state, code }));
  }
}
