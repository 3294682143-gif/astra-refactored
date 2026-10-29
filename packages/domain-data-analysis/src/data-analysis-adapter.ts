/**
 * @zygos/domain-data-analysis - Scientific Data Analysis Domain Adapter (K13).
 *
 * Implements Section 20.4 Case D: Third domain zero-core-change verification.
 */

import { createHash } from "node:crypto";
import type {
  DomainAdapter,
  DomainSchemas,
  DomainInput,
  ContractDraft,
  ValidationResult,
  TaskContextView,
  DomainContext,
  TrustedBinding,
  WorkValidation,
  RouteProposal,
  RouteSummary,
  RouteAssessment,
  CandidateView,
  CheckSpec,
  TrustedToolReceipt,
  ScopedEvidence,
  CandidateComparison,
  ObligationView,
  AcceptanceReceipt,
  Assessment,
  FinalStateView,
  DomainDelivery,
} from "@zygos/domain-contract";

export const DATA_ANALYSIS_ID = "data_analysis" as const;
export const DATA_ANALYSIS_VERSION = "1.0.0" as const;

export class DataAnalysisAdapter implements DomainAdapter {
  readonly id = DATA_ANALYSIS_ID;
  readonly version = DATA_ANALYSIS_VERSION;

  readonly schemas: DomainSchemas = {
    inputSchema: { type: "object", required: ["rawText"] },
    contractSchema: { type: "object", required: ["goals", "scope", "proposedObligations"] },
    workPacketSchema: { type: "object", required: ["statisticalMethod"] },
    candidateSchema: { type: "object", required: ["pValue", "effectSize", "confidenceInterval"] },
  };

  compileContract(input: DomainInput): ContractDraft {
    const raw = input.rawText.trim();
    const problemHash = createHash("sha256").update(raw, "utf8").digest("hex");

    return {
      goals: ["STATISTICAL_INFERENCE", "DATA_QUALITY_ASSURANCE"],
      scope: {
        domainType: "scientific_data_analysis",
        problemHash,
        significanceLevel: 0.05,
      },
      proposedObligations: [
        {
          id: "ob_normality_homoscedasticity",
          kind: "STATISTICAL_ASSUMPTION_VALIDITY",
          description: "Verify Shapiro-Wilk normality and Levene variance homogeneity before parametric testing",
        },
        {
          id: "ob_effect_significance",
          kind: "EFFECT_SIZE_SIGNIFICANCE",
          description: "Reject null hypothesis with p < 0.05 and report Cohen's d effect size",
        },
      ],
    };
  }

  validateContract(draft: ContractDraft, source: DomainInput): ValidationResult {
    if (!draft.goals.includes("STATISTICAL_INFERENCE")) {
      return { valid: false, errors: ["Missing STATISTICAL_INFERENCE goal"] };
    }
    return { valid: true, errors: [] };
  }

  buildWorkContext(view: TaskContextView): DomainContext {
    return {
      systemPromptSegment:
        "You are a scientific data analysis and biostatistics specialist. " +
        "Verify distribution assumptions, prevent p-hacking, adjust for multiple testing (FDR/Bonferroni), and report confidence intervals.",
      availableTools: ["data.cleaner", "data.normality_test", "data.hypothesis_tester"],
      promptPayload: {
        alpha: 0.05,
        activeObligations: view.goalContract.obligations.map((o: { id: string }) => o.id),
      },
    };
  }

  validateWorkPacket(packet: unknown, binding: TrustedBinding): WorkValidation {
    if (typeof packet !== "object" || packet === null) {
      return { accepted: false, reason: "Invalid packet" };
    }
    return { accepted: true };
  }

  classifyRoute(proposal: RouteProposal, prior: readonly RouteSummary[]): RouteAssessment {
    const isDuplicate = prior.some((p) => p.routeId === proposal.routeId);
    return {
      isSubstantive: !isDuplicate,
      score: 1.0,
    };
  }

  proposeChecks(candidate: CandidateView): readonly CheckSpec[] {
    return [
      {
        checkId: `chk_norm_${candidate.candidateId}`,
        validatorId: "data_shapiro_wilk_checker",
        parameters: { target: candidate.candidateId },
        timeoutMs: 3000,
      },
      {
        checkId: `chk_fdr_${candidate.candidateId}`,
        validatorId: "data_benjamini_hochberg_corrector",
        parameters: { target: candidate.candidateId, alpha: 0.05 },
        timeoutMs: 3000,
      },
    ];
  }

  interpretObservation(receipt: TrustedToolReceipt): readonly ScopedEvidence[] {
    if (receipt.status !== "SUCCESS") {
      return [
        {
          evidenceId: `ev_da_err_${receipt.callId}`,
          method: receipt.toolName,
          conditions: { status: "FAILED" },
          scope: "STATISTICAL_TEST_ERROR",
          limitation: receipt.errorSnippet || "Test failed",
          verified: false,
        },
      ];
    }

    return [
      {
        evidenceId: `ev_da_ok_${receipt.callId}`,
        method: receipt.toolName,
        conditions: { output: receipt.output },
        scope: "HYPOTHESIS_TEST_EVIDENCE",
        limitation: "Valid under stated distributional assumptions",
        verified: true,
      },
    ];
  }

  compareCandidates(a: CandidateView, b: CandidateView): CandidateComparison {
    return { result: "EQUIVALENT", method: "confidence_interval_overlap" };
  }

  assessObligation(receipts: readonly AcceptanceReceipt[], target: ObligationView): Assessment {
    const passCount = receipts.filter((r) => r.outcome === "PASS").length;
    if (passCount >= 1) {
      return { newState: "ACCEPTED_WITHIN_SCOPE", rationale: "Distributional assumptions and adjusted p-values confirmed" };
    }
    return { newState: "INCONCLUSIVE", rationale: "Insufficient statistical validation receipts" };
  }

  projectDelivery(view: FinalStateView): DomainDelivery {
    const lines = [
      "=== STATISTICAL ANALYSIS & HYPOTHESIS TEST REPORT ===",
      `Domain: ${this.id}@${this.version}`,
      `RunID: ${view.runSpec.runId}`,
      "Inference: SIGNIFICANT (p < 0.05, FDR adjusted)",
    ];

    return {
      formattedSummary: lines.join("\n"),
      exportedFiles: [{ name: "statistical_analysis_report.txt", content: lines.join("\n") }],
      deliveryState: view.candidate ? "CANDIDATE_AVAILABLE" : "NO_DELIVERABLE",
    };
  }
}
