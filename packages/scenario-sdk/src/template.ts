import type { ScenarioPlugin } from "./types.ts";
import type { DomainAdapter, DomainInput, ContractDraft, ValidationResult, TaskContextView, DomainContext, TrustedBinding, WorkValidation, RouteProposal, RouteSummary, RouteAssessment, CandidateView, CheckSpec, TrustedToolReceipt, ScopedEvidence, CandidateComparison, ObligationView, AcceptanceReceipt, Assessment, FinalStateView, DomainDelivery } from "@zygos/domain-contract";

/**
 * Minimal DomainAdapter stub for scenario templates.
 */
class TemplateDomainAdapter implements DomainAdapter {
  readonly id = "template.scenario";
  readonly version = "1.0.0";
  readonly schemas = {
    inputSchema: { type: "object" },
    contractSchema: { type: "object" },
    workPacketSchema: { type: "object" },
    candidateSchema: { type: "object" },
  };

  compileContract(input: DomainInput): ContractDraft {
    return {
      goals: ["TEMPLATE_RESEARCH_GOAL"],
      scope: { domain: "template" },
      proposedObligations: [
        { id: "ob_template_check", kind: "SMOKE_VERIFICATION", description: "Template obligation verification" },
      ],
    };
  }

  validateContract(draft: ContractDraft, source: DomainInput): ValidationResult {
    return { valid: true, errors: [] };
  }

  buildWorkContext(view: TaskContextView): DomainContext {
    return {
      systemPromptSegment: "You are a domain research assistant.",
      availableTools: ["template.tool"],
      promptPayload: {},
    };
  }

  validateWorkPacket(packet: unknown, binding: TrustedBinding): WorkValidation {
    return { accepted: true };
  }

  classifyRoute(proposal: RouteProposal, prior: readonly RouteSummary[]): RouteAssessment {
    return { isSubstantive: true, score: 1.0 };
  }

  proposeChecks(candidate: CandidateView): readonly CheckSpec[] {
    return [
      {
        checkId: "chk_template",
        validatorId: "template_validator",
        parameters: {},
        timeoutMs: 3000,
      },
    ];
  }

  interpretObservation(receipt: TrustedToolReceipt): readonly ScopedEvidence[] {
    return [
      {
        evidenceId: "ev_template_1",
        method: receipt.toolName,
        conditions: {},
        scope: "TEMPLATE_SCOPE",
        limitation: "Template demonstration",
        verified: receipt.status === "SUCCESS",
      },
    ];
  }

  compareCandidates(a: CandidateView, b: CandidateView): CandidateComparison {
    return { result: "EQUIVALENT", method: "template_match" };
  }

  assessObligation(receipts: readonly AcceptanceReceipt[], target: ObligationView): Assessment {
    const passed = receipts.some((r) => r.outcome === "PASS");
    return {
      newState: passed ? "ACCEPTED_WITHIN_SCOPE" : "INCONCLUSIVE",
      rationale: passed ? "Template validator confirmed" : "Pending",
    };
  }

  projectDelivery(view: FinalStateView): DomainDelivery {
    return {
      formattedSummary: "Template scenario run complete",
      exportedFiles: [{ name: "template_report.txt", content: "Success" }],
      deliveryState: "DELIVERABLE",
    };
  }
}

/**
 * Creates a prototype ScenarioPlugin from minimal parameters.
 * Useful for authoring new scenario packages or fifth-scenario extension tests.
 */
export function createScenarioTemplate(params: {
  scenarioId: string;
  name: string;
  description: string;
  domainAdapter?: DomainAdapter;
  requiresIsolation?: boolean;
}): ScenarioPlugin {
  return {
    manifest: {
      scenarioId: params.scenarioId,
      version: "1.0.0",
      name: params.name,
      domainType: "custom_science",
      description: params.description,
      goals: ["CUSTOM_RESEARCH_DISCOVERY"],
      requiredModelCapabilities: ["scientific_reasoning"],
      requiresCodeIsolation: params.requiresIsolation ?? false,
    },
    domain: params.domainAdapter || new TemplateDomainAdapter(),
    execution: {
      bindingKind: "KERNEL_WORKFLOW",
      engineTarget: "universal-agent-loop",
      entrypoint: "packages/agent-kernel/src/generic-loop.ts",
      allowedEngines: ["node"],
      defaultEngine: "node",
      supportsCheckpointResume: false,
      minEngineVersion: "1.0.0",
      supportedCapabilities: ["scientific_reasoning"],
    },
    inputs: {
      inputKind: "PROBLEM_STATEMENT",
      supportedExtensions: [".txt", ".json"],
      requiredFields: ["problemStatement"],
      optionalFields: ["contextParameters"],
      dataIsolationPolicy: "NONE",
    },
    team: {
      teamId: `${params.scenarioId}_team`,
      scenarioId: params.scenarioId,
      roles: [
        {
          roleId: `${params.scenarioId}_analyst`,
          name: "领域分析 Agent",
          roleCategory: "PLANNER",
          ownedDimension: "PROBLEM_ANALYSIS",
          description: "分析科研问题与约束",
          triggerCondition: "STAGE_START",
          contextVisibility: "FULL",
          maxModelCallsPerTask: 1,
        },
        {
          roleId: `${params.scenarioId}_worker`,
          name: "推导与实验 Agent",
          roleCategory: "WORKER",
          ownedDimension: "EXECUTION",
          description: "生成实验方案与结果",
          triggerCondition: "PLAN_ADMITTED",
          contextVisibility: "GOAL_AND_TOOLS",
          maxModelCallsPerTask: 2,
        },
        {
          roleId: `${params.scenarioId}_reviewer`,
          name: "独立审查 Agent",
          roleCategory: "REVIEWER",
          ownedDimension: "VALIDATION",
          description: "独立复核结果前提与边界",
          triggerCondition: "CANDIDATE_PROPOSED",
          contextVisibility: "CANDIDATE_ONLY",
          maxModelCallsPerTask: 1,
        },
      ],
      defaultRoute: "default_scientific_workflow",
      enableParallelReview: true,
      enableBoundedRepair: true,
      maxRepairs: 1,
    },
    policy: {
      maxRounds: 3,
      timeoutMs: 60000,
      allowParallelReview: false,
      enableBoundedRepair: true,
      maxRepairs: 1,
      failureHandling: "FAIL_EXPLICIT_UNSOLVED",
    },
    tools: [],
    checks: [],
    results: {
      primaryArtifactKind: "CUSTOM_RESEARCH_REPORT",
      exportedFileNames: ["research_report.json"],
      requiredMetrics: ["obligationsMet"],
      visualizerComponent: "CustomResearchView",
    },
  };
}
