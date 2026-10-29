/**
 * @zygos/domain-contract - Core Domain-Agnostic Types and Adapter Contracts.
 *
 * Implements data contracts specified in Section 5 and DomainAdapter interface
 * specified in Section 6 of the Zygos Kernel Extraction Specification.
 */

// ============================================================================
// 1. Orthogonal Three-Dimensional State Model (§5.2)
// ============================================================================

/** Lifecycle execution status of a run. */
export type RunState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "RECOVERY_REQUIRED";

/** Deliverability status of final candidates and research packs. */
export type DeliveryState =
  | "CANDIDATE_AVAILABLE"
  | "DELIVERABLE"
  | "NO_DELIVERABLE";

/** Scientific obligation acceptance state (evidence-driven). */
export type ObligationState =
  | "OPEN"
  | "SUPPORTED"
  | "ACCEPTED_WITHIN_SCOPE"
  | "REFUTED"
  | "INCONCLUSIVE"
  | "STALE";

// ============================================================================
// 2. Kernel Core Domain Objects (§5.1)
// ============================================================================

export interface RunSpec {
  readonly runId: string;
  readonly domainId: string;
  readonly domainVersion: string;
  readonly inputRefs: readonly string[];
  readonly profileId: string;
  readonly parentRunId?: string;
  readonly createdAt: string;
}

export interface Obligation {
  readonly id: string;
  readonly kind: string;
  readonly subjectRef: string;
  readonly scopeRef: string;
  readonly acceptancePolicyRef: string;
  readonly state: ObligationState;
  readonly failureReason?: string | undefined;
}

export interface GoalContract {
  readonly originalInputRef: string;
  readonly goals: readonly string[];
  readonly scope: Record<string, unknown>;
  readonly obligations: readonly Obligation[];
  readonly version: number;
}

export interface WorkUnit {
  readonly taskId: string;
  readonly goalRefs: readonly string[];
  readonly dependencies: readonly string[];
  readonly routeId: string;
  readonly state: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "STALE";
}

export interface Artifact {
  readonly artifactId: string;
  readonly version: number;
  readonly kind: string;
  readonly payloadRef: string;
  readonly dependencyRefs: readonly string[];
  readonly digest: string;
  readonly isStale: boolean;
}

export interface ScopedEvidence {
  readonly evidenceId: string;
  readonly method: string;
  readonly conditions: Record<string, unknown>;
  readonly scope: string;
  readonly limitation: string;
  readonly verified: boolean;
}

export interface Observation {
  readonly sourceCallId: string;
  readonly subjectRef: string;
  readonly scope: string;
  readonly method: string;
  readonly resultRef: string;
  readonly limitations: readonly string[];
  readonly evidence: readonly ScopedEvidence[];
}

export interface Challenge {
  readonly challengeId: string;
  readonly targetRef: string;
  readonly issueKind: string;
  readonly evidenceRefs: readonly string[];
  readonly requiredResolution: string;
  readonly state: "OPEN" | "RESOLVED" | "IGNORED_UNFOUNDED" | "PERSISTED_UNRESOLVED";
}

export interface Candidate {
  readonly candidateId: string;
  readonly version: number;
  readonly claimRefs: readonly string[];
  readonly supportRefs: readonly string[];
  readonly parentRef?: string | undefined;
  readonly deliverable: boolean;
  readonly rawContent?: unknown;
  readonly candidateVerified: false; // Invariant I15: candidate_verified is always false
}

export interface AcceptanceReceipt {
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly subjectHash: string;
  readonly scope: string;
  readonly outcome: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly evidenceRefs: readonly string[];
  readonly issuedAt: string;
}

export interface RunResult {
  readonly runId: string;
  readonly status: RunState;
  readonly delivery: DeliveryState;
  readonly unresolvedObligations: readonly string[];
  readonly metrics: {
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly totalDurationMs: number;
    readonly tokensConsumed?: number;
  };
  readonly artifactRefs: readonly string[];
}

// ============================================================================
// 3. DomainAdapter Interface (§6.1)
// ============================================================================

export interface DomainSchemas {
  readonly inputSchema: Record<string, unknown>;
  readonly contractSchema: Record<string, unknown>;
  readonly workPacketSchema: Record<string, unknown>;
  readonly candidateSchema: Record<string, unknown>;
}

export interface DomainInput {
  readonly rawText: string;
  readonly metadata?: Record<string, unknown>;
  readonly attachments?: readonly string[];
}

export interface ContractDraft {
  readonly goals: readonly string[];
  readonly scope: Record<string, unknown>;
  readonly proposedObligations: readonly {
    readonly id: string;
    readonly kind: string;
    readonly description: string;
  }[];
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface TaskContextView {
  readonly taskId: string;
  readonly runSpec: RunSpec;
  readonly goalContract: GoalContract;
  readonly priorArtifacts: readonly Artifact[];
}

export interface DomainContext {
  readonly systemPromptSegment: string;
  readonly availableTools: readonly string[];
  readonly promptPayload: Record<string, unknown>;
}

export interface TrustedBinding {
  readonly runId: string;
  readonly taskId: string;
  readonly callerId: string;
}

export interface WorkValidation {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly proposedActions?: readonly unknown[];
}

export interface RouteProposal {
  readonly routeId: string;
  readonly rationale: string;
  readonly proposedSteps: readonly string[];
}

export interface RouteSummary {
  readonly routeId: string;
  readonly status: string;
  readonly stepsExecuted: number;
}

export interface RouteAssessment {
  readonly isSubstantive: boolean;
  readonly duplicateOf?: string | undefined;
  readonly score: number;
}

export interface CandidateView {
  readonly candidateId: string;
  readonly rawContent: unknown;
  readonly artifacts: readonly Artifact[];
}

export interface CheckSpec {
  readonly checkId: string;
  readonly validatorId: string;
  readonly parameters: Record<string, unknown>;
  readonly timeoutMs: number;
}

export interface TrustedToolReceipt {
  readonly callId: string;
  readonly toolName: string;
  readonly status: "SUCCESS" | "ERROR" | "TIMEOUT";
  readonly output: unknown;
  readonly errorSnippet?: string;
}

export type CandidateComparisonResult = "EQUIVALENT" | "DIFFERENT" | "INCOMPARABLE";

export interface CandidateComparison {
  readonly result: CandidateComparisonResult;
  readonly method: string;
  readonly divergenceSummary?: string;
}

export interface ObligationView {
  readonly obligation: Obligation;
  readonly targetArtifact?: Artifact | undefined;
}

export interface Assessment {
  readonly newState: ObligationState;
  readonly rationale: string;
}

export interface FinalStateView {
  readonly runSpec: RunSpec;
  readonly goalContract: GoalContract;
  readonly candidate?: Candidate | undefined;
  readonly observations: readonly Observation[];
}

export interface DomainDelivery {
  readonly formattedSummary: string;
  readonly exportedFiles: readonly { readonly name: string; readonly content: string }[];
  readonly deliveryState: DeliveryState;
}

/**
 * Universal interface that all domain extensions must implement to run on Zygos Kernel.
 */
export interface DomainAdapter {
  readonly id: string;
  readonly version: string;
  readonly schemas: DomainSchemas;

  compileContract(input: DomainInput): ContractDraft;
  validateContract(draft: ContractDraft, source: DomainInput): ValidationResult;
  buildWorkContext(view: TaskContextView): DomainContext;
  validateWorkPacket(packet: unknown, binding: TrustedBinding): WorkValidation;
  classifyRoute(proposal: RouteProposal, prior: readonly RouteSummary[]): RouteAssessment;
  proposeChecks(candidate: CandidateView): readonly CheckSpec[];
  interpretObservation(receipt: TrustedToolReceipt): readonly ScopedEvidence[];
  compareCandidates(a: CandidateView, b: CandidateView): CandidateComparison;
  assessObligation(receipts: readonly AcceptanceReceipt[], target: ObligationView): Assessment;
  projectDelivery(view: FinalStateView): DomainDelivery;
}

// ============================================================================
// 4. Host Ports Interface (§6.2)
// ============================================================================

export interface HostPorts {
  readonly model: {
    readonly requestCompletion: (params: {
      readonly messages: readonly { readonly role: string; readonly content: string }[];
      readonly temperature: number;
      readonly maxTokens: number;
      readonly timeoutMs: number;
    }) => Promise<{
      readonly content: string | null;
      readonly finishReason: string;
      readonly usage?: {
        readonly promptTokens?: number;
        readonly completionTokens?: number;
        readonly totalTokens?: number;
      };
    }>;
  };
  readonly asset: {
    readonly execute: (toolName: string, params: Record<string, unknown>) => Promise<TrustedToolReceipt>;
  };
  readonly clock: {
    readonly nowMonotonicMs: () => number;
    readonly remainingBudgetMs: () => number;
  };
}
