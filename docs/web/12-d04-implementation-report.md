下面是 `reduceRun.ts` 与 `playback.ts` 的完整实现。

---

## `apps/web-demo/src/domain/reduceRun.ts`

```ts
/**
 * reduceRun —— 运行事件到视图状态的纯函数 reducer。
 *
 * 红线约束（不可违反）：
 *   无论收到什么事件（包括 RESULT / FINAL / run.finished），
 *   state.candidateVerified 恒为 false，绝不展示"已验证 / 证明完成"。
 *
 * 保证：
 *   1. 幂等：同 seq 同 payload 自动去重（返回同一个 state 引用）。
 *   2. 冲突：同 seq 不同 payload 记入 conflicts，不覆盖原事件。
 *   3. 乱序/缺序：events 始终按 seq 有序，允许任意顺序到达。
 *   4. 未知事件类型：记入 unknownEvents 并标记 degraded / capabilityGaps。
 */

export type RunStatus = 'idle' | 'running' | 'finished' | 'error';

export interface RunEventEnvelope<T = unknown> {
  /** 单调递增的序列号，由服务端或本地生成器保证唯一 */
  seq: number;
  /** 事件类型字符串，未知类型会被安全降级处理 */
  type: string;
  /** 事件负载，做幂等比较时使用稳定序列化 */
  payload?: T;
  runId?: string;
  /** 事件发生时间戳（毫秒） */
  ts?: number;
}

export interface ConflictRecord {
  seq: number;
  existing: string;
  incoming: string;
  reason: 'seq-conflict';
  at: number;
}

export interface UnknownEventRecord {
  seq: number;
  type: string;
  payload?: unknown;
  reason: 'unknown-event-type' | 'malformed-envelope';
}

export interface LogEntry {
  seq: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  at?: number;
}

export interface StepView {
  stepId: string;
  name?: string;
  status: 'pending' | 'running' | 'finished' | 'error';
  startedAt?: number;
  finishedAt?: number;
  detail?: string;
}

export interface ToolCallView {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: 'pending' | 'done' | 'error';
}

export interface RunViewState {
  runId: string;
  status: RunStatus;
  /** 已接收事件中的最大 seq */
  lastSeq: number;
  /** 始终按 seq 升序排列 */
  events: RunEventEnvelope[];
  /** seq -> 事件，用于 O(1) 幂等/冲突检测 */
  seqIndex: Record<number, RunEventEnvelope>;
  steps: StepView[];
  logs: LogEntry[];
  /** 完整消息（message 事件） */
  messages: string[];
  /** message.delta 累积流 */
  streamBuffer: string;
  toolCalls: ToolCallView[];
  conflicts: ConflictRecord[];
  unknownEvents: UnknownEventRecord[];
  /** 能力缺口清单，UI 据此显示"能力不足"提示 */
  capabilityGaps: string[];
  /** 收到过 result / final 事件（但不代表已验证） */
  resultSeen: boolean;
  /** 出现过未知事件或 malformed 事件 */
  degraded: boolean;

  /**
   * 红线字段。类型即字面量 false，编译期禁止任何地方写成 true。
   */
  readonly candidateVerified: false;
}

export interface RunEventEnvelopeInput {
  seq: number;
  type: string;
  payload?: unknown;
  runId?: string;
  ts?: number;
}

export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'run.started',
  'run.finished',
  'step.started',
  'step.finished',
  'tool.call',
  'tool.result',
  'message.delta',
  'message',
  'log',
  'error',
  'result',
  'final',
]);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 稳定序列化：对象键排序后输出，用于 payload 等价比较。
 * 相同语义、不同键顺序的 payload 会被判为相等。
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
  }
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** 判断两个事件是否"同 seq 同 payload 同 type"，用于幂等去重。 */
export function isRedundantEvent(a: RunEventEnvelope, b: RunEventEnvelope): boolean {
  return (
    a.seq === b.seq &&
    a.type === b.type &&
    stableStringify(a.payload) === stableStringify(b.payload)
  );
}

/** 事件指纹（用于冲突记录中可读展示）。 */
function fingerprint(ev: RunEventEnvelope): string {
  return `${ev.type}:${stableStringify(ev.payload)}`;
}

/** 按 seq 升序把事件插入数组（返回新数组，不修改入参）。 */
export function insertSorted(
  events: RunEventEnvelope[],
  ev: RunEventEnvelope,
): RunEventEnvelope[] {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].seq <= ev.seq) lo = mid + 1;
    else hi = mid;
  }
  if (lo === events.length) return events.concat(ev);
  const out = events.slice();
  out.splice(lo, 0, ev);
  return out;
}

function isValidEnvelope(ev: unknown): ev is RunEventEnvelope {
  return (
    isObject(ev) &&
    typeof (ev as { seq?: unknown }).seq === 'number' &&
    Number.isFinite((ev as { seq: number }).seq) &&
    typeof (ev as { type?: unknown }).type === 'string' &&
    (ev as { type: string }).type.length > 0
  );
}

function asText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (isObject(payload)) {
    const t = payload.text ?? payload.delta ?? payload.content ?? payload.message;
    if (typeof t === 'string') return t;
  }
  return '';
}

function upsertStep(steps: StepView[], next: StepView): StepView[] {
  const idx = steps.findIndex((s) => s.stepId === next.stepId);
  if (idx < 0) return steps.concat(next);
  const merged: StepView = { ...steps[idx] };
  (Object.keys(next) as (keyof StepView)[]).forEach((k) => {
    const v = next[k];
    if (v !== undefined) (merged as Record<string, unknown>)[k as string] = v;
  });
  return steps.map((s, i) => (i === idx ? merged : s));
}

function pushGap(gaps: string[], gap: string): string[] {
  return gaps.indexOf(gap) >= 0 ? gaps : gaps.concat(gap);
}

// ---------------------------------------------------------------------------
// 初始状态
// ---------------------------------------------------------------------------

export function createInitialRunViewState(runId = ''): RunViewState {
  return {
    runId,
    status: 'idle',
    lastSeq: 0,
    events: [],
    seqIndex: {},
    steps: [],
    logs: [],
    messages: [],
    streamBuffer: '',
    toolCalls: [],
    conflicts: [],
    unknownEvents: [],
    capabilityGaps: [],
    resultSeen: false,
    degraded: false,
    candidateVerified: false,
  };
}

// ---------------------------------------------------------------------------
// 主 reducer
// ---------------------------------------------------------------------------

export function reduceRun(state: RunViewState, ev: RunEventEnvelope): RunViewState {
  const next = reduceRunInternal(state, ev);
  // 红线守卫：任何路径都不得让 candidateVerified 变为非 false。
  if (next.candidateVerified !== false) {
    return { ...next, candidateVerified: false };
  }
  return next;
}

function reduceRunInternal(state: RunViewState, ev: RunEventEnvelope): RunViewState {
  // ---- 0. malformed 事件：安全降级，不崩溃、不污染 seqIndex ----
  if (!isValidEnvelope(ev)) {
    const seq = isObject(ev) && typeof (ev as { seq?: unknown }).seq === 'number'
      ? (ev as { seq: number }).seq
      : NaN;
    const type = isObject(ev) && typeof (ev as { type?: unknown }).type === 'string'
      ? (ev as { type: string }).type
      : '?';
    return {
      ...state,
      degraded: true,
      unknownEvents: state.unknownEvents.concat({
        seq,
        type,
        payload: isObject(ev) ? (ev as { payload?: unknown }).payload : ev,
        reason: 'malformed-envelope',
      }),
      capabilityGaps: pushGap(state.capabilityGaps, 'malformed-envelope'),
      // candidateVerified 保持 false
    };
  }

  // ---- 1. 幂等 / 冲突检测 ----
  const existing = state.seqIndex[ev.seq] as RunEventEnvelope | undefined;
  if (existing) {
    if (isRedundantEvent(existing, ev)) {
      // 同 seq 同 payload → 完全去重，返回原引用
      return state;
    }
    // 同 seq 不同 payload → 记录冲突，不覆盖、不改状态
    return {
      ...state,
      conflicts: state.conflicts.concat({
        seq: ev.seq,
        existing: fingerprint(existing),
        incoming: fingerprint(ev),
        reason: 'seq-conflict',
        at: Date.now(),
      }),
      // candidateVerified 保持 false
    };
  }

  // ---- 2. 登记事件（乱序安全：按 seq 插入） ----
  const events = insertSorted(state.events, ev);
  const seqIndex: Record<number, RunEventEnvelope> = { ...state.seqIndex, [ev.seq]: ev };
  const base: RunViewState = {
    ...state,
    events,
    seqIndex,
    lastSeq: Math.max(state.lastSeq, ev.seq),
    // candidateVerified 保持 false
  };

  // ---- 3. 未知事件类型：安全记录 + 能力不足标记 ----
  if (!KNOWN_EVENT_TYPES.has(ev.type)) {
    return {
      ...base,
      degraded: true,
      unknownEvents: base.unknownEvents.concat({
        seq: ev.seq,
        type: ev.type,
        payload: ev.payload,
        reason: 'unknown-event-type',
      }),
      capabilityGaps: pushGap(base.capabilityGaps, `unknown-event:${ev.type}`),
      // candidateVerified 保持 false
    };
  }

  // ---- 4. 已知事件分发 ----
  return applyKnownEvent(base, ev);
}

// ---------------------------------------------------------------------------
// 已知事件处理
// ---------------------------------------------------------------------------

function applyKnownEvent(state: RunViewState, ev: RunEventEnvelope): RunViewState {
  const p = isObject(ev.payload) ? ev.payload : {};
  const str = (k: string): string | undefined =>
    typeof p[k] === 'string' ? (p[k] as string) : undefined;

  switch (ev.type) {
    case 'run.started': {
      return {
        ...state,
        runId: str('runId') ?? state.runId,
        status: 'running',
      };
    }

    case 'run.finished': {
      // 注意：即便 run 正常结束，也绝不置 candidateVerified = true
      return { ...state, status: 'finished' };
    }

    case 'step.started': {
      const stepId = str('stepId') ?? str('id') ?? `step-${ev.seq}`;
      return {
        ...state,
        steps: upsertStep(state.steps, {
          stepId,
          name: str('name'),
          status: 'running',
          startedAt: ev.ts,
          detail: str('detail'),
        }),
      };
    }

    case 'step.finished': {
      const stepId = str('stepId') ?? str('id') ?? `step-${ev.seq}`;
      const prev = state.steps.find((s) => s.stepId === stepId);
      const nextStatus: StepView['status'] =
        p.status === 'error' ? 'error' : 'finished';
      return {
        ...state,
        steps: upsertStep(state.steps, {
          stepId,
          name: prev?.name ?? str('name'),
          status: nextStatus,
          startedAt: prev?.startedAt,
          finishedAt: ev.ts,
          detail: str('detail') ?? prev?.detail,
        }),
      };
    }

    case 'tool.call': {
      const id = str('id') ?? str('callId') ?? `tool-${ev.seq}`;
      const name = str('name') ?? str('tool') ?? 'unknown';
      const call: ToolCallView = {
        id,
        name,
        args: p.args ?? p.arguments,
        status: 'pending',
      };
      return { ...state, toolCalls: state.toolCalls.concat(call) };
    }

    case 'tool.result': {
      const id = str('id') ?? str('callId') ?? '';
      const idx = state.toolCalls.findIndex((c) => c.id === id);
      if (idx < 0) return state;
      const isError = p.status === 'error' || p.error != null;
      const updated: ToolCallView = {
        ...state.toolCalls[idx],
        result: p.result ?? p.output ?? p.error,
        status: isError ? 'error' : 'done',
      };
      const toolCalls = state.toolCalls.slice();
      toolCalls[idx] = updated;
      return { ...state, toolCalls };
    }

    case 'message.delta': {
      const text = asText(ev.payload);
      if (!text) return state;
      return { ...state, streamBuffer: state.streamBuffer + text };
    }

    case 'message': {
      const text = asText(ev.payload);
      if (!text) return state;
      return {
        ...state,
        messages: state.messages.concat(text),
        streamBuffer: '',
      };
    }

    case 'log': {
      const level: LogEntry['level'] =
        p.level === 'warn' || p.level === 'error' ? (p.level as LogEntry['level']) : 'info';
      const message = asText(ev.payload) || String(p.message ?? p.msg ?? '');
      return {
        ...state,
        logs: state.logs.concat({ seq: ev.seq, level, message, at: ev.ts }),
      };
    }

    case 'error': {
      const message = asText(ev.payload) || String(p.message ?? p.reason ?? 'unknown error');
      return {
        ...state,
        status: 'error',
        logs: state.logs.concat({
          seq: ev.seq,
          level: 'error',
          message,
          at: ev.ts,
        }),
      };
    }

    case 'result':
    case 'final': {
      // ★ 红线：收到 RESULT / FINAL 也只做"已收到"记录，
      //   绝不将 candidateVerified 置为 true，绝不展示"已验证 / 证明完成"。
      return {
        ...state,
        resultSeen: true,
        logs: state.logs.concat({
          seq: ev.seq,
          level: 'info',
          message: `event:${ev.type} received (not verified)`,
          at: ev.ts,
        }),
      };
    }

    default:
      // 理论上不可达；即使到达也按未知事件处理
      return state;
  }
}

// ---------------------------------------------------------------------------
// 批量便利函数
// ---------------------------------------------------------------------------

/** 批量折叠事件。乱序安全，幂等安全。 */
export function reduceRunAll(
  state: RunViewState,
  events: Iterable<RunEventEnvelope>,
): RunViewState {
  let acc = state;
  for (const ev of events) acc = reduceRun(acc, ev);
  return acc;
}
```

---

## `apps/web-demo/src/domain/playback.ts`

```ts
/**
 * PlaybackController —— 运行事件回放控制器。
 *
 * 特性：
 *   - play / pause / stepForward / stepBackward / jumpTo(seq) / setSpeed(0.5|1|2|5)
 *   - 历史游标独立于事件流：新事件到达不会强制跳到最新
 *   - 分段快照缓存：每 20 条事件保留一份 RunViewState 快照，
 *     任意跳转最多回放 < snapshotInterval 条事件，无需从 0 重算
 */

import {
  type RunEventEnvelope,
  type RunViewState,
  createInitialRunViewState,
  isRedundantEvent,
  reduceRun,
} from './reduceRun';

export type PlaybackSpeed = 0.5 | 1 | 2 | 5;

export const ALLOWED_SPEEDS: ReadonlyArray<PlaybackSpeed> = [0.5, 1, 2, 5];

export const DEFAULT_SNAPSHOT_INTERVAL = 20;
export const DEFAULT_BASE_INTERVAL_MS = 240;

export interface PlaybackSnapshot {
  /** events 数组中的索引（已应用 events[index] 之后的状态） */
  index: number;
  /** 该索引对应事件的 seq */
  seq: number;
  state: RunViewState;
}

export interface PlaybackControllerOptions {
  /** 初始状态（通常来自 createInitialRunViewState） */
  initial?: RunViewState;
