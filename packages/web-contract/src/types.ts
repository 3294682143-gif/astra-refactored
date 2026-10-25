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
  readonly client_method_calls: number;
  readonly logical_model_calls: number | null;
  readonly effect_calls: number;
  readonly review_calls: number;
  readonly catalog_calls: number;
  readonly method_loads: number;
  readonly asset_calls: number;
  readonly work_units: number | null;
  readonly frames: number;
  readonly remote_outcome_unknown: boolean;
  readonly known_http_attempts: number | null;
  readonly reported_tokens: number | null;
  readonly unknown_usage_requests: number;
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
  readonly engine: "ts" | "lite" | "legacy" | string;
  readonly status: "candidate" | "unsolved" | string;
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
  readonly metrics: MetricsDto;
  readonly finishReason?: string | null;
  readonly childReaped: boolean;
  readonly elapsedMs: number;
  readonly code?: string | null;
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
  readonly engine?: "ts" | "lite" | "legacy";
  readonly metadata?: Record<string, unknown>;
  readonly max_model_calls?: number;
  readonly max_work_units?: number;
  readonly max_effects?: number;
  readonly max_reviews?: number;
  readonly max_method_loads?: 0 | 1;
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
}
