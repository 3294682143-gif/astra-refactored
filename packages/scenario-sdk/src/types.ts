import type {
  DomainAdapter,
  ScenarioManifest,
  TeamProfile,
  ScenarioInputContract,
  ScenarioResultContract,
} from "@zygos/domain-contract";

export interface ScenarioExecutionBinding {
  readonly bindingKind: "DELEGATED_ENGINE" | "KERNEL_WORKFLOW" | "STANDALONE_WORKER" | "CONTAINER_WORKER";
  readonly engineTarget: string;
  readonly entrypoint?: string;
  readonly allowedEngines?: readonly string[];
  readonly defaultEngine?: string;
  readonly supportsCheckpointResume?: boolean;
  readonly minEngineVersion?: string;
  readonly supportedCapabilities?: readonly string[];
  readonly executionPort?: string;
}

export interface ResearchWorkflowPolicy {
  readonly maxRounds: number;
  readonly timeoutMs: number;
  readonly allowParallelReview: boolean;
  readonly enableBoundedRepair: boolean;
  readonly maxRepairs: number;
  readonly failureHandling: "FAIL_EXPLICIT_UNSOLVED";
}

export interface RegisteredToolDefinition {
  readonly toolName: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly evidenceType: string;
  readonly timeoutSeconds: number;
}

export interface DomainCheckDefinition {
  readonly checkName: string;
  readonly validatorId: string;
  readonly targetObligationId: string;
  readonly evidenceScope: string;
  readonly timeoutMs: number;
}

export interface ScenarioUIModule {
  readonly routePath: string;
  readonly formComponent: string;
  readonly resultComponent: string;
  readonly visualizerComponent: string;
  readonly customIcon?: string;
}

export interface CollaborationContract {
  readonly supportedSubtasks: readonly string[];
  readonly inputPayloadSchema: Record<string, unknown>;
  readonly outputPayloadSchema: Record<string, unknown>;
  readonly maxDelegatedBudgetMs: number;
}

export interface CollaborationTask {
  readonly taskId: string;
  readonly parentRunId: string;
  readonly initiatingScenarioId: string;
  readonly targetScenarioId: string;
  readonly taskKind: string;
  readonly inputArtifacts: readonly Record<string, unknown>[];
  readonly inheritedBudget: {
    readonly maxModelCalls: number;
    readonly maxToolCalls: number;
    readonly remainingDeadlineMs: number;
  };
  readonly recursionDepth: number;
}

export interface CollaborationResult {
  readonly taskId: string;
  readonly parentRunId: string;
  readonly targetScenarioId: string;
  readonly status: "COMPLETED" | "FAILED" | "CANCELLED" | "OUTCOME_UNKNOWN";
  readonly consumedBudget: {
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly durationMs: number;
  };
  readonly returnedArtifacts: readonly Record<string, unknown>[];
  readonly candidateVerified: false;
}

export interface ScenarioPlugin {
  readonly manifest: ScenarioManifest;
  readonly domain: DomainAdapter;
  readonly execution: ScenarioExecutionBinding;
  readonly inputs: ScenarioInputContract;
  readonly team: TeamProfile;
  readonly policy: ResearchWorkflowPolicy;
  readonly tools: readonly RegisteredToolDefinition[];
  readonly checks: readonly DomainCheckDefinition[];
  readonly results: ScenarioResultContract;
  readonly ui?: ScenarioUIModule;
  readonly collaboration?: CollaborationContract;
}

export interface ScenarioReadinessStatus {
  readonly scenarioId: string;
  readonly isReady: boolean;
  readonly status: "READY" | "NOT_READY" | "DEGRADED";
  readonly missingCapabilities: readonly string[];
  readonly reasons: readonly string[];
}

export interface ImmutableScenarioSnapshot {
  readonly scenarioId: string;
  readonly version: string;
  readonly snapshotTimestamp: string;
  readonly plugin: ScenarioPlugin;
}
