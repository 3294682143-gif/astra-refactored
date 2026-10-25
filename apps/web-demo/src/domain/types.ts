import type { StatusCode, StopReason, RunEventEnvelope } from "@astra/web-contract";

export interface TaskState {
  readonly id: string;
  readonly kind: string;
  readonly status: "PENDING" | "RUNNING" | "COMPLETE" | "FAILED" | "STALE";
  readonly payload?: unknown;
}

export interface ArtifactState {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly status: "ACTIVE" | "STALE" | "REPLACED";
  readonly data?: unknown;
}

export interface ToolObservationState {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly output?: unknown;
  readonly status: "SUCCESS" | "FAILED";
}

export interface RunConflict {
  readonly seq: number;
  readonly existingPayload: unknown;
  readonly incomingPayload: unknown;
}

export interface RunMetrics {
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly elapsedMs: number;
  readonly workUnits: number;
}

export interface RunViewState {
  readonly runId: string;
  readonly status: StatusCode | "idle" | "running";
  readonly stopReason: StopReason | null;
  readonly candidateVerified: false; // 红线铁律：严格恒为 false
  readonly events: readonly RunEventEnvelope[];
  readonly lastSeq: number;
  readonly conflicts: readonly RunConflict[];
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly artifacts: Readonly<Record<string, ArtifactState>>;
  readonly tools: Readonly<Record<string, ToolObservationState>>;
  readonly reviews: readonly unknown[];
  readonly candidate: string | null;
  readonly metrics: RunMetrics;
  readonly unknownEvents: readonly RunEventEnvelope[];
}

export function createEmptyRunViewState(runId = "default-run"): RunViewState {
  return {
    runId,
    status: "idle",
    stopReason: null,
    candidateVerified: false,
    events: [],
    lastSeq: 0,
    conflicts: [],
    tasks: {},
    artifacts: {},
    tools: {},
    reviews: [],
    candidate: null,
    metrics: {
      modelCalls: 0,
      toolCalls: 0,
      elapsedMs: 0,
      workUnits: 0,
    },
    unknownEvents: [],
  };
}
