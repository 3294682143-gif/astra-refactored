/**
 * @file types.ts
 * Browser-safe TypeScript types corresponding to Python Pydantic DTO models.
 * Zero Node built-in dependencies.
 */

export type StatusCode = "candidate" | "unsolved" | "aborted" | "error" | "solved";

export type StopReason =
  | "SOLVED"
  | "REVIEWS_COMPLETE"
  | "REVISE_REJECTED"
  | "NO_CANDIDATE"
  | "MAX_ITER"
  | "TIMEOUT"
  | "DEADLINE_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "BUDGET_EXHAUSTED"
  | "CANCELLED"
  | "ERROR"
  | "SPAWN_FAILED"
  | "CHILD_FAILED"
  | "FIELD_VALUE"
  | "TRANSPORT_STOP";

export interface ErrorDto {
  readonly code: string;
  readonly message: string;
  readonly category?: "validation" | "provider" | "timeout" | "budget" | "internal";
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown> | null;
}

export interface MetricsDto {
  readonly client_method_calls: number | null;
  readonly logical_model_calls: number | null;
  readonly effect_calls: number | null;
  readonly review_calls: number | null;
  readonly catalog_calls: number | null;
  readonly method_loads: number | null;
  readonly asset_calls: number | null;
  readonly tool_effect_calls: number | null;
  readonly method_effect_calls: number | null;
  readonly work_units: number | null;
  readonly frames: number | null;
  readonly remote_outcome_unknown: boolean | null;
  readonly known_http_attempts: number | null;
  readonly reported_tokens: number | null;
  readonly unknown_usage_requests: number | null;
  readonly tool_names: readonly string[] | null;
  readonly method_ids: readonly string[] | null;
}

export interface TraceRowDto {
  readonly seq: number;
  readonly kind: "MODEL" | "EFFECT" | "CONTROL" | string;
  readonly id: string;
  readonly state: "ACTIVE" | "COMPLETE" | "STALE" | "FAILED" | string;
  readonly code: string;
  readonly ts_ms?: number | null;
}

export interface SolveResultDto {
  readonly run_id?: string;
  readonly engine: "ts" | string;
  readonly status: "candidate" | "unsolved" | string;
  readonly executed?: boolean;
  readonly final_response: string;
  readonly candidate_verified: false;
  readonly strictAcceptance: "NOT_PERFORMED" | "PASSED" | "FAILED" | string;
  readonly mode: "TS_PREVIEW" | string;
  readonly targetEnvironment: "TARGET_UNVERIFIED" | string;
  readonly stopReason: StopReason | string;
  readonly reason: string;
  readonly unresolvedObligations: readonly string[];
  readonly carrier: string;
  readonly sessionId: string;
  readonly trace: readonly TraceRowDto[];
  readonly metrics: MetricsDto | null;
  readonly finishReason?: string | null;
  readonly childReaped: boolean | null;
  readonly elapsedMs: number | null;
  readonly code?: string | null;
  readonly protocolVersion?: string | null;
  readonly catalogVersion?: string | null;
  readonly catalogDigest?: string | null;
}

/**
 * 真实 Host 观测事件名（`python/astra_bridge/agent_host.py` 的 observer 原样下发，
 * BFF 只补传输信封字段，不改名、不合成）。
 *
 * 前端必须按这些真实名字监听；只监听旧的 `MODEL_REQUEST` / `TOOL_OBSERVATION`
 * 会让整条真实事件流落入 unknownEvents，界面永远停在 idle。
 */
export type ObserverEventKind =
  | "model_dispatched"
  | "model_returned"
  | "effect_returned";

/** `model_dispatched`：Host 在真正派发一次模型请求的那一刻发出。 */
export interface ModelDispatchedPayload {
  readonly requestId: string;
  readonly phase: string;
  readonly modelCalls: number;
  readonly remainingMs: number;
}

/** `model_returned`：Host 收到该次请求的传输结果（COMPLETE / TRUNCATED / UNKNOWN ...）。 */
export interface ModelReturnedPayload {
  readonly requestId: string;
  readonly phase: string;
  readonly transportStatus: string;
  readonly modelCalls: number;
  readonly remainingMs: number;
}

/** `effect_returned`：一次真实 effect（统一数学资产 / 工具）调用返回观测。 */
export interface EffectReturnedPayload {
  readonly effectId: string | null;
  readonly action: string;
  readonly name: string | null;
  readonly status: string | null;
  readonly source: string | null;
  readonly checkResult: string | null;
}

export interface RunEventEnvelope<T = Record<string, unknown>> {
  readonly runId: string;
  readonly seq: number;
  readonly kind: string;
  readonly at: number;
  readonly sourceKind: "demo_fixture" | "official_result" | "observed_archive";
  readonly detailLevel: "summary_only" | "partial_observed" | "full_observed";
  readonly payload: T;
}

export interface RunRequestDto {
  readonly problem: string;
  readonly engine?: "ts";
  readonly metadata?: Record<string, unknown>;
  readonly idempotency_key?: string;
  readonly max_model_calls?: number;
  readonly max_work_units?: number;
  readonly max_effects?: number;
  readonly max_reviews?: number;
  readonly max_method_loads?: 0;
  readonly max_repairs?: number;
  readonly max_consensus?: number;
  readonly max_r0?: 0 | 1;
  readonly problem_seconds?: number;
  readonly policy?: "BEST_EFFORT" | "STRICT";
}

export interface CapabilitiesDto {
  readonly schema_version: string;
  readonly server_version: string;
  readonly supported_engines: readonly string[];
  readonly max_concurrent_runs: number;
  readonly supports_cancellation: boolean;
  readonly default_budget: Record<string, unknown>;
  readonly protocol_version?: string | null;
  readonly catalog_version?: string | null;
  readonly catalog_digest?: string | null;
}
