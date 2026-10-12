/**
 * @astra/stdio-runtime — pure AgentProgressPolicy helper.
 *
 * No clock, no I/O, no model call, no session and no mathematical judgement.
 * It only counts consecutive cached repeats of one task-local effect key and
 * records task-level yields. The real M1 TASK_YIELDED event is appended by the
 * composition root, never by this helper.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  P2_TASK_YIELD_REASON,
  detectLoneSurrogates,
  p2Snapshot,
  type P2TaskYieldReason,
} from "@astra/protocol";
import {
  AGENT_PROGRESS_EVENT_SCHEMA_VERSION,
  type AgentProgressEvent,
} from "@astra/protocol";

export const AGENT_PROGRESS_POLICY_SCHEMA_VERSION = "agent-progress-policy-v1" as const;

/** Fixed progress policy; exactly four fields, never modified by a model. */
export interface AgentProgressPolicyConfig {
  readonly schemaVersion: typeof AGENT_PROGRESS_POLICY_SCHEMA_VERSION;
  readonly cachedRepeatLimit: 2;
  readonly taskLocalUnsolved: true;
  readonly partialYield: true;
}

export const AGENT_PROGRESS_POLICY: AgentProgressPolicyConfig = Object.freeze({
  schemaVersion: AGENT_PROGRESS_POLICY_SCHEMA_VERSION,
  cachedRepeatLimit: 2 as const,
  taskLocalUnsolved: true as const,
  partialYield: true as const,
});

const MAX_TASKS = 4;
const MAX_RECORDS = 4;
const REQUEST_ORDINAL = /^model-([1-4])$/u;

interface TaskProgress {
  readonly key: string;
  readonly cacheHits: number;
}

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function boundedId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > 256) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectLoneSurrogates(value).ok) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

/**
 * Per-task consecutive cached-repeat counter and the yield records of one run.
 * A fresh real effect or a new key resets the counter; only a second
 * consecutive cached repeat of the same key reports a yield.
 */
export class AgentProgressPolicy {
  private readonly tasks = new Map<string, TaskProgress>();
  private readonly records: AgentProgressEvent[] = [];

  /**
   * Observe one effect outcome of the current task. `key` is the runtime
   * effect key of the action and `cached` is the real before/after effect-call
   * observation. Returns true only when the same key has now been cached
   * `cachedRepeatLimit` times in a row.
   */
  observeEffect(taskId: string, requestId: string, key: string, cached: boolean): boolean {
    const task = boundedId(taskId);
    const request = boundedId(requestId);
    if (REQUEST_ORDINAL.exec(request) === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const effectKey = boundedId(key);
    if (typeof cached !== "boolean") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const previous = this.tasks.get(task);
    if (!cached) {
      if (previous === undefined && this.tasks.size >= MAX_TASKS) {
        fail(P2_ERROR_CODES.BOUND_EXCEEDED);
      }
      this.tasks.set(task, { key: effectKey, cacheHits: 0 });
      return false;
    }
    if (previous === undefined || previous.key !== effectKey) {
      if (previous === undefined && this.tasks.size >= MAX_TASKS) {
        fail(P2_ERROR_CODES.BOUND_EXCEEDED);
      }
      this.tasks.set(task, { key: effectKey, cacheHits: 1 });
      return false;
    }
    const hits = previous.cacheHits + 1;
    this.tasks.set(task, { key: effectKey, cacheHits: hits });
    return hits >= AGENT_PROGRESS_POLICY.cachedRepeatLimit;
  }

  /**
   * Pure pre-check of one task-level yield record. Nothing is mutated: the
   * task must not already be recorded, the request must be a real WORK
   * ordinal, the reason must be one fixed value and the record budget must
   * allow one more entry. The real M1 pre-check runs before this one.
   */
  validateRecordYield(taskId: string, requestId: string, reason: P2TaskYieldReason): void {
    const task = boundedId(taskId);
    const request = boundedId(requestId);
    if (REQUEST_ORDINAL.exec(request) === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!(P2_TASK_YIELD_REASON as readonly string[]).includes(reason)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (this.records.some((row) => row.taskId === task)) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.records.length >= MAX_RECORDS) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
  }

  /** Record one task-level yield after the full pure pre-check. */
  recordYield(taskId: string, requestId: string, reason: P2TaskYieldReason): void {
    this.validateRecordYield(taskId, requestId, reason);
    const task = boundedId(taskId);
    const request = boundedId(requestId);
    this.records.push(p2Snapshot({
      schemaVersion: AGENT_PROGRESS_EVENT_SCHEMA_VERSION,
      taskId: task,
      sourceRequestId: request,
      reason,
    }) as AgentProgressEvent);
  }

  /** Deep-frozen copy of the yield records; never a model-visible trace. */
  snapshot(): readonly AgentProgressEvent[] {
    return p2Snapshot(this.records);
  }
}
