/**
 * @zygos/domain-data-analysis - Scientific Data Analysis Domain Adapter (K13).
 *
 * Implements Section 20.4 Case D: Third domain zero-core-change verification.
 * Adheres to DomainAdapter protocol from @zygos/domain-contract.
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

export const DATA_ANALYSIS_TOOLS = [
  "data.cleaner",
  "data.normality_test",
  "data.welch_t_test",
  "data.residual_whiteness",
] as const;

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
    const raw = (input.rawText || "").trim();
    if (!raw) {
      return {
        goals: [],
        scope: { domainType: "scientific_data_analysis", problemHash: "" },
        proposedObligations: [],
      };
    }

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
          description: "Verify normality and variance homogeneity before parametric inference",
        },
        {
          id: "ob_effect_significance",
          kind: "EFFECT_SIZE_SIGNIFICANCE",
          description: "Reject null hypothesis with p < 0.05 and report Cohen's d effect size",
        },
        {
          id: "ob_residual_whiteness",
          kind: "RESIDUAL_INDEPENDENCE_CHECK",
          description: "Diagnose standardized residuals for independence and lack of serial autocorrelation",
        },
      ],
    };
  }

  validateContract(draft: ContractDraft, source: DomainInput): ValidationResult {
    const errors: string[] = [];
    if (!draft.goals || draft.goals.length === 0) {
      errors.push("Data analysis contract requires at least one goal");
    }
    if (!draft.goals.includes("STATISTICAL_INFERENCE")) {
      errors.push("Missing STATISTICAL_INFERENCE goal in contract");
    }
    if (!draft.scope || !draft.scope["problemHash"]) {
      errors.push("Missing problemHash in contract scope");
    }
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  buildWorkContext(view: TaskContextView): DomainContext {
    return {
      systemPromptSegment:
        "You are a scientific data analysis and biostatistics specialist. " +
        "Verify distribution assumptions, prevent p-hacking, adjust for multiple testing (FDR/Bonferroni), and report confidence intervals.",
      availableTools: [...DATA_ANALYSIS_TOOLS],
      promptPayload: {
        alpha: 0.05,
        activeObligations: view.goalContract.obligations.map((o: { id: string }) => o.id),
      },
    };
  }

  validateWorkPacket(packet: unknown, binding: TrustedBinding): WorkValidation {
    if (typeof packet !== "object" || packet === null) {
      return { accepted: false, reason: "Invalid packet: non-object" };
    }
    return { accepted: true };
  }

  classifyRoute(proposal: RouteProposal, prior: readonly RouteSummary[]): RouteAssessment {
    const isDuplicate = prior.some((p) => p.routeId === proposal.routeId);
    return {
      isSubstantive: !isDuplicate && proposal.proposedSteps.length > 0,
      duplicateOf: isDuplicate ? proposal.routeId : undefined,
      score: proposal.proposedSteps.length >= 2 ? 1.0 : 0.6,
    };
  }

  proposeChecks(candidate: CandidateView): readonly CheckSpec[] {
    return [
      {
        checkId: `chk_norm_${candidate.candidateId}`,
        validatorId: "data_normality_checker",
        parameters: { target: candidate.candidateId },
        timeoutMs: 3000,
      },
      {
        checkId: `chk_welch_${candidate.candidateId}`,
        validatorId: "data_welch_t_evaluator",
        parameters: { target: candidate.candidateId, alpha: 0.05 },
        timeoutMs: 3000,
      },
      {
        checkId: `chk_white_${candidate.candidateId}`,
        validatorId: "data_residual_whiteness_checker",
        parameters: { target: candidate.candidateId },
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
          limitation: receipt.errorSnippet || "Statistical tool execution failed",
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
        limitation: "Valid under verified distributional assumptions",
        verified: true,
      },
    ];
  }

  compareCandidates(a: CandidateView, b: CandidateView): CandidateComparison {
    const strA = JSON.stringify(a.rawContent);
    const strB = JSON.stringify(b.rawContent);
    if (strA === strB) {
      return { result: "EQUIVALENT", method: "structural_exact_match" };
    }
    return {
      result: "DIFFERENT",
      method: "confidence_interval_divergence",
      divergenceSummary: `Candidate ${a.candidateId} differs from ${b.candidateId}`,
    };
  }

  assessObligation(receipts: readonly AcceptanceReceipt[], target: ObligationView): Assessment {
    const relevantFail = receipts.some((r) => r.outcome === "FAIL");
    if (relevantFail) {
      const failedReceipt = receipts.find((r) => r.outcome === "FAIL");
      if (failedReceipt?.validatorId === "data_normality_checker") {
        return {
          newState: "REFUTED",
          rationale: "正态性假设检验拒绝：样本偏度或峰度超标，禁止作为标准正态参数推断交付",
        };
      }
      if (failedReceipt?.validatorId === "data_residual_whiteness_checker") {
        return {
          newState: "REFUTED",
          rationale: "残差自相关显著 (|r1| >= 0.25)，存在未建模结构效应，判定'结构欠定'",
        };
      }
      return {
        newState: "REFUTED",
        rationale: "统计推断检验未通过或效应量不显著",
      };
    }

    const passCount = receipts.filter((r) => r.outcome === "PASS").length;
    if (passCount >= 1) {
      return {
        newState: "ACCEPTED_WITHIN_SCOPE",
        rationale: "分布假设验证与假设检验回执满足，推断结论在指定置信度下闭环",
      };
    }

    return {
      newState: "INCONCLUSIVE",
      rationale: "缺乏有效的统计验证回执",
    };
  }

  projectDelivery(view: FinalStateView): DomainDelivery {
    const certLines: string[] = [
      "=== STATISTICAL ANALYSIS & HYPOTHESIS TEST REPORT ===",
      `Domain: ${this.id}@${this.version}`,
      `RunID: ${view.runSpec.runId}`,
      `Goals: ${view.goalContract.goals.join(", ")}`,
      `CandidateVerified: false (Honest Baseline Contract: candidate_verified is always false)`,
      `StrictAcceptance: NOT_PERFORMED`,
    ];

    if (view.candidate) {
      certLines.push(`CandidateID: ${view.candidate.candidateId}`);
      certLines.push(`Payload: ${JSON.stringify(view.candidate.rawContent)}`);
    } else {
      certLines.push("CandidateID: NONE");
    }

    certLines.push(`TotalObservations: ${view.observations.length}`);
    certLines.push("=== END REPORT ===");

    const content = certLines.join("\n");
    return {
      formattedSummary: content,
      exportedFiles: [{ name: "statistical_analysis_report.txt", content }],
      deliveryState: view.candidate ? "CANDIDATE_AVAILABLE" : "NO_DELIVERABLE",
    };
  }
}
