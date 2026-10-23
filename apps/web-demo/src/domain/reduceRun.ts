/**
 * reduceRun —— 纯函数事件流归约器。
 *
 * 红线约束（不可违背）：
 *   无论收到什么事件（包括 RESULT / FINAL / run.finished），
 *   state.candidateVerified 严格恒为 false，绝不展示“已验证 / 证明完成”。
 *
 * 保证：
 *   1. 幂等：同 seq 同 payload 自动去重（返回同一 state 引用）。
 *   2. 冲突：同 seq 不同 payload 记入 conflicts，不覆盖原事件。
 *   3. 乱序/缺序：events 始终按 seq 升序有序，支持任意顺序到达。
 *   4. 双源兼容：同时兼容 Astra 引擎日志 (kind, data) 与 Web 信封 (type/kind, payload)。
 *   5. 未知事件：安全记入 unknownEvents 并标记 capabilityGaps 与 degraded: true。
 */

import type { StatusCode, StopReason } from "@astra/web-contract";

export type RunStatus = "idle" | "running" | "candidate" | "unsolved" | "aborted" | "error" | "finished";

export interface RunEventEnvelope<T = unknown> {
  readonly seq: number;
  readonly kind?: string;
  readonly type?: string;
  readonly payload?: T;
  readonly data?: T;
  readonly runId?: string;
  readonly at?: number;
  readonly ts?: number;
  readonly sourceKind?: "demo_fixture" | "official_result" | "observed_archive";
  readonly detailLevel?: "summary_only" | "partial_observed" | "full_observed";
}

export interface ConflictRecord {
  readonly seq: number;
  readonly existing: string;
  readonly incoming: string;
  readonly reason: "seq-conflict";
  readonly at: number;
}

export interface UnknownEventRecord {
  readonly seq: number;
  readonly kind: string;
  readonly payload?: unknown;
  readonly reason: "unknown-event-type" | "malformed-envelope";
}

export interface LogEntry {
  readonly seq: number;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly at?: number;
}

export interface StepView {
  readonly stepId: string;
  readonly name?: string;
  readonly status: "pending" | "running" | "finished" | "error";
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly detail?: string;
}

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly args?: unknown;
  readonly output?: unknown;
  readonly status: "pending" | "done" | "error";
}

export interface TaskView {
  readonly id: string;
  readonly goalId?: string;
  readonly status: "PENDING" | "RUNNING" | "COMPLETE" | "INCOMPLETE" | "ERROR";
  readonly proposal?: string | null;
}

export interface RunViewState {
  readonly runId: string;
  readonly status: RunStatus;
  readonly stopReason: StopReason | null;
  readonly lastSeq: number;
  readonly events: readonly RunEventEnvelope[];
  readonly seqIndex: Readonly<Record<number, RunEventEnvelope>>;
  readonly steps: readonly StepView[];
  readonly tasks: Readonly<Record<string, TaskView>>;
  readonly logs: readonly LogEntry[];
  readonly messages: readonly string[];
  readonly streamBuffer: string;
  readonly toolCalls: readonly ToolCallView[];
  readonly conflicts: readonly ConflictRecord[];
  readonly unknownEvents: readonly UnknownEventRecord[];
  readonly capabilityGaps: readonly string[];
  readonly resultSeen: boolean;
  readonly degraded: boolean;
  readonly candidateProposal: string | null;

  /**
   * 红线字段。严格恒为 false，编译期与运行时双重保障。
   */
  readonly candidateVerified: false;
}

export const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set<string>([
  // Astra 原生引擎事件
  "SESSION_INIT",
  "CONTRACT",
  "CONTRACT_REVISED",
  "TASK_STARTED",
  "MODEL_REQUEST",
  "WORKUNIT",
  "TOOL_OBSERVATION",
  "REVIEW_CHALLENGE",
  "METHOD_LOAD",
  "REPAIR",
  "CONSENSUS",
  "TRUNCATION",
  "FINAL",
  "RESULT",

  // Web / Runner 标准事件
  "run.started",
  "run.finished",
  "step.started",
  "step.finished",
  "tool.call",
  "tool.result",
  "message.delta",
  "message",
  "log",
  "error",
]);

// ---------------------------------------------------------------------------
// 辅助与工具函数
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function getEventKind(ev: RunEventEnvelope): string {
  return ev.kind ?? ev.type ?? "UNKNOWN";
}

export function getEventPayload(ev: RunEventEnvelope): unknown {
  return ev.payload !== undefined ? ev.payload : ev.data;
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
  }
  if (typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function isRedundantEvent(a: RunEventEnvelope, b: RunEventEnvelope): boolean {
  return (
    a.seq === b.seq &&
    getEventKind(a) === getEventKind(b) &&
    stableStringify(getEventPayload(a)) === stableStringify(getEventPayload(b))
  );
}

function fingerprint(ev: RunEventEnvelope): string {
  return `${getEventKind(ev)}:${stableStringify(getEventPayload(ev))}`;
}

export function insertSorted(
  events: readonly RunEventEnvelope[],
  ev: RunEventEnvelope,
): RunEventEnvelope[] {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].seq <= ev.seq) lo = mid + 1;
    else hi = mid;
  }
  const out = events.slice();
  out.splice(lo, 0, ev);
  return out;
}

function isValidEnvelope(ev: unknown): ev is RunEventEnvelope {
  return (
    isObject(ev) &&
    typeof (ev as { seq?: unknown }).seq === "number" &&
    Number.isFinite((ev as { seq: number }).seq)
  );
}

function asText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (isObject(payload)) {
    const t = payload.text ?? payload.delta ?? payload.content ?? payload.message ?? payload.answer;
    if (typeof t === "string") return t;
  }
  return "";
}

function upsertStep(steps: readonly StepView[], next: StepView): StepView[] {
  const idx = steps.findIndex((s) => s.stepId === next.stepId);
  if (idx < 0) return [...steps, next];
  const merged: StepView = { ...steps[idx], ...next };
  return steps.map((s, i) => (i === idx ? merged : s));
}

function pushGap(gaps: readonly string[], gap: string): string[] {
  return gaps.includes(gap) ? gaps.slice() : [...gaps, gap];
}

// ---------------------------------------------------------------------------
// 初始状态生成
// ---------------------------------------------------------------------------

export function createInitialRunViewState(runId = "default-run"): RunViewState {
  return {
    runId,
    status: "idle",
    stopReason: null,
    lastSeq: 0,
    events: [],
    seqIndex: {},
    steps: [],
    tasks: {},
    logs: [],
    messages: [],
    streamBuffer: "",
    toolCalls: [],
    conflicts: [],
    unknownEvents: [],
    capabilityGaps: [],
    resultSeen: false,
    degraded: false,
    candidateProposal: null,
    candidateVerified: false, // 绝对恒为 false
  };
}

// ---------------------------------------------------------------------------
// 主 Reducer
// ---------------------------------------------------------------------------

export function reduceRun(state: RunViewState, ev: RunEventEnvelope): RunViewState {
  const next = reduceRunInternal(state, ev);
  // 红线硬性拦截：任何途径都不允许 candidateVerified 变为 true
  if (next.candidateVerified !== false) {
    return { ...next, candidateVerified: false };
  }
  return next;
}

function reduceRunInternal(state: RunViewState, ev: RunEventEnvelope): RunViewState {
  // 0. 格式畸变防护
  if (!isValidEnvelope(ev)) {
    const seq = isObject(ev) && typeof (ev as { seq?: unknown }).seq === "number"
      ? (ev as { seq: number }).seq
      : NaN;
    const kind = isObject(ev) ? getEventKind(ev as RunEventEnvelope) : "?";
    return {
      ...state,
      degraded: true,
      unknownEvents: [
        ...state.unknownEvents,
        {
          seq,
          kind,
          payload: isObject(ev) ? getEventPayload(ev as RunEventEnvelope) : ev,
          reason: "malformed-envelope",
        },
      ],
      capabilityGaps: pushGap(state.capabilityGaps, "malformed-envelope"),
      candidateVerified: false,
    };
  }

  // 1. 幂等与冲突检测
  const existing = state.seqIndex[ev.seq];
  if (existing) {
    if (isRedundantEvent(existing, ev)) {
      // 相同 seq + 相同 payload，幂等无害，返回原引用
      return state;
    }
    // 相同 seq + 不同 payload，记录冲突，不破坏已存状态
    return {
      ...state,
      conflicts: [
        ...state.conflicts,
        {
          seq: ev.seq,
          existing: fingerprint(existing),
          incoming: fingerprint(ev),
          reason: "seq-conflict",
          at: Date.now(),
        },
      ],
      candidateVerified: false,
    };
  }

  // 2. 有序登记新事件
  const events = insertSorted(state.events, ev);
  const seqIndex = { ...state.seqIndex, [ev.seq]: ev };
  const base: RunViewState = {
    ...state,
    events,
    seqIndex,
    lastSeq: Math.max(state.lastSeq, ev.seq),
    candidateVerified: false,
  };

  // 3. 未知事件类型
  const kind = getEventKind(ev);
  if (!KNOWN_EVENT_KINDS.has(kind)) {
    return {
      ...base,
      degraded: true,
      unknownEvents: [
        ...base.unknownEvents,
        {
          seq: ev.seq,
          kind,
          payload: getEventPayload(ev),
          reason: "unknown-event-type",
        },
      ],
      capabilityGaps: pushGap(base.capabilityGaps, `unknown-event:${kind}`),
      candidateVerified: false,
    };
  }

  // 4. 已知事件分支处理
  return applyKnownEvent(base, ev);
}

function applyKnownEvent(state: RunViewState, ev: RunEventEnvelope): RunViewState {
  const kind = getEventKind(ev);
  const payloadRaw = getEventPayload(ev);
  const p = isObject(payloadRaw) ? payloadRaw : {};
  const str = (k: string): string | undefined =>
    typeof p[k] === "string" ? (p[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof p[k] === "number" ? (p[k] as number) : undefined;

  switch (kind) {
    // ---------------------- Astra 原生引擎事件 ----------------------
    case "SESSION_INIT": {
      const sessionId = str("sessionId") ?? state.runId;
      return {
        ...state,
        runId: sessionId,
        status: "running",
        logs: [
          ...state.logs,
          { seq: ev.seq, level: "info", message: `Session initialized: ${sessionId}`, at: ev.at ?? ev.ts },
        ],
      };
    }

    case "CONTRACT":
    case "CONTRACT_REVISED": {
      const tasks = num("tasks") ?? 0;
      const obligations = num("obligations") ?? 0;
      return {
        ...state,
        logs: [
          ...state.logs,
          { seq: ev.seq, level: "info", message: `Contract v${p.contractVersion ?? 1}: ${tasks} tasks, ${obligations} obligations`, at: ev.at ?? ev.ts },
        ],
      };
    }

    case "TASK_STARTED": {
      const taskId = str("taskId") ?? `task-${ev.seq}`;
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [taskId]: {
            id: taskId,
            goalId: str("goalId"),
            status: "RUNNING",
          },
        },
        steps: upsertStep(state.steps, {
          stepId: taskId,
          name: str("goalId") ?? taskId,
          status: "running",
          startedAt: ev.at ?? ev.ts,
        }),
      };
    }

    case "MODEL_REQUEST": {
      return {
        ...state,
        logs: [
          ...state.logs,
          { seq: ev.seq, level: "info", message: `Model request ${str("requestId") ?? ""} (phase: ${str("phase") ?? "WORK"})`, at: ev.at ?? ev.ts },
        ],
      };
    }

    case "WORKUNIT": {
      const taskId = str("taskId") ?? `task-${ev.seq}`;
      const deliveryStatus = (str("deliveryStatus") ?? "COMPLETE") as TaskView["status"];
      const candidateProposal = str("candidateProposal") ?? state.candidateProposal;
      return {
        ...state,
        candidateProposal,
        tasks: {
          ...state.tasks,
          [taskId]: {
            id: taskId,
            status: deliveryStatus,
            proposal: str("candidateProposal"),
          },
        },
        steps: upsertStep(state.steps, {
          stepId: taskId,
          status: deliveryStatus === "COMPLETE" ? "finished" : "running",
          finishedAt: ev.at ?? ev.ts,
        }),
      };
    }

    case "TOOL_OBSERVATION": {
      const toolName = str("tool") ?? str("name") ?? "tool";
      const call: ToolCallView = {
        id: str("id") ?? `tool-${ev.seq}`,
        name: toolName,
        args: p.args,
        output: p.observation ?? p.output,
        status: p.error ? "error" : "done",
      };
      return {
        ...state,
        toolCalls: [...state.toolCalls, call],
      };
    }

    case "REVIEW_CHALLENGE": {
      return {
        ...state,
        logs: [
          ...state.logs,
          { seq: ev.seq, level: "warn", message: `Review challenge: ${str("rationale") ?? "Challenge issued"}`, at: ev.at ?? ev.ts },
        ],
      };
    }

    case "FINAL":
    case "RESULT": {
      // ★ 红线规则：收到 FINAL / RESULT 时，记录候选状态，但 candidateVerified 严格保持 false！
      const stopReason = (str("stopReason") ?? "REVIEWS_COMPLETE") as StopReason;
      const status: StatusCode = stopReason === "NO_CANDIDATE" || stopReason === "BUDGET_EXHAUSTED" ? "unsolved" : "candidate";
      return {
        ...state,
        status,
        stopReason,
        resultSeen: true,
        candidateVerified: false, // 严格保持 false
        candidateProposal: str("answer") ?? str("candidateProposal") ?? state.candidateProposal,
        logs: [
          ...state.logs,
          { seq: ev.seq, level: "info", message: `Run finished with stopReason=${stopReason} (candidate_verified=false)`, at: ev.at ?? ev.ts },
        ],
      };
    }

    // ---------------------- Runner / Web 标准事件 ----------------------
    case "run.started": {
      return {
        ...state,
        runId: str("runId") ?? state.runId,
        status: "running",
      };
    }

    case "run.finished": {
      return {
        ...state,
        status: state.status === "candidate" ? "candidate" : "finished",
        candidateVerified: false,
      };
    }

    case "step.started": {
      const stepId = str("stepId") ?? str("id") ?? `step-${ev.seq}`;
      return {
        ...state,
        steps: upsertStep(state.steps, {
          stepId,
          name: str("name"),
          status: "running",
          startedAt: ev.at ?? ev.ts,
          detail: str("detail"),
        }),
      };
    }

    case "step.finished": {
      const stepId = str("stepId") ?? str("id") ?? `step-${ev.seq}`;
      const prev = state.steps.find((s) => s.stepId === stepId);
      const nextStatus: StepView["status"] = p.status === "error" ? "error" : "finished";
      return {
        ...state,
        steps: upsertStep(state.steps, {
          stepId,
          name: prev?.name ?? str("name"),
          status: nextStatus,
          startedAt: prev?.startedAt,
          finishedAt: ev.at ?? ev.ts,
          detail: str("detail") ?? prev?.detail,
        }),
      };
    }

    case "tool.call": {
      const id = str("id") ?? str("callId") ?? `tool-${ev.seq}`;
      const name = str("name") ?? str("tool") ?? "unknown";
      return {
        ...state,
        toolCalls: [
          ...state.toolCalls,
          { id, name, args: p.args ?? p.arguments, status: "pending" },
        ],
      };
    }

    case "tool.result": {
      const id = str("id") ?? str("callId") ?? "";
      const idx = state.toolCalls.findIndex((c) => c.id === id);
      if (idx < 0) return state;
      const isError = p.status === "error" || p.error != null;
      const updated: ToolCallView = {
        ...state.toolCalls[idx],
        output: p.result ?? p.output ?? p.error,
        status: isError ? "error" : "done",
      };
      const toolCalls = state.toolCalls.slice();
      toolCalls[idx] = updated;
      return { ...state, toolCalls };
    }

    case "message.delta": {
      const text = asText(payloadRaw);
      if (!text) return state;
      return { ...state, streamBuffer: state.streamBuffer + text };
    }

    case "message": {
      const text = asText(payloadRaw);
      if (!text) return state;
      return {
        ...state,
        messages: [...state.messages, text],
        streamBuffer: "",
      };
    }

    case "log": {
      const level: LogEntry["level"] =
        p.level === "warn" || p.level === "error" ? (p.level as LogEntry["level"]) : "info";
      const message = asText(payloadRaw) || String(p.message ?? p.msg ?? "");
      return {
        ...state,
        logs: [...state.logs, { seq: ev.seq, level, message, at: ev.at ?? ev.ts }],
      };
    }

    case "error": {
      const message = asText(payloadRaw) || String(p.message ?? p.reason ?? "unknown error");
      return {
        ...state,
        status: "error",
        logs: [...state.logs, { seq: ev.seq, level: "error", message, at: ev.at ?? ev.ts }],
      };
    }

    default:
      return state;
  }
}

/**
 * 批量折叠所有事件。
 */
export function reduceRunAll(
  state: RunViewState,
  events: Iterable<RunEventEnvelope>,
): RunViewState {
  let acc = state;
  for (const ev of events) {
    acc = reduceRun(acc, ev);
  }
  return acc;
}
