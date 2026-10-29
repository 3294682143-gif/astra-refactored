/**
 * @zygos/domain-math - Mathematics Domain Adapter.
 *
 * Implements DomainAdapter for mathematics, bridging math-contract,
 * use_math_asset tool integration, closed-answer checking, and CERT1
 * delivery projection while keeping candidate_verified=false.
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

export const MATH_DOMAIN_ID = "math" as const;
export const MATH_DOMAIN_VERSION = "1.4.0" as const;

export const MATH_ASSET_NAMES = [
  "math.linear-algebra",
  "math.polynomials",
  "math.number-theory",
  "math.combinatorics",
  "math.calculus",
  "math.algebraic-geometry",
] as const;

export class MathDomainAdapter implements DomainAdapter {
  readonly id = MATH_DOMAIN_ID;
  readonly version = MATH_DOMAIN_VERSION;

  readonly schemas: DomainSchemas = {
    inputSchema: { type: "object", required: ["rawText"] },
    contractSchema: { type: "object", required: ["goals", "scope", "proposedObligations"] },
    workPacketSchema: { type: "object", required: ["steps"] },
    candidateSchema: { type: "object", required: ["answer"] },
  };

  compileContract(input: DomainInput): ContractDraft {
    const raw = input.rawText.trim();
    const isProof = /证明|求证|prove|show that/i.test(raw);
    const isAllSolutions = /所有解|全部解|all solutions|find all/i.test(raw);
    const isMinMax = /最大值|最小值|极值|maximum|minimum/i.test(raw);

    const goalKind = isProof
      ? "PROOF"
      : isAllSolutions
      ? "ALL_SOLUTIONS"
      : isMinMax
      ? "EXTREMUM"
      : "VALUE";

    const proposedObligations = [
      { id: "ob_domain", kind: "DOMAIN_VALIDITY", description: "验证定义域与约束范围无矛盾" },
      { id: "ob_candidate", kind: "CANDIDATE_VALIDITY", description: "验证候选值代入原问题条件满足" },
      { id: "ob_derivation", kind: "INDEPENDENT_DERIVATION", description: "提供独立代数推导或严格逻辑证明步骤" },
      { id: "ob_coverage", kind: "OUTPUT_COVERAGE", description: "确认解集不漏解且覆盖全称条件" },
    ];

    return {
      goals: [goalKind],
      scope: {
        domainType: "mathematics",
        problemHash: createHash("sha256").update(raw, "utf8").digest("hex"),
      },
      proposedObligations,
    };
  }

  validateContract(draft: ContractDraft, source: DomainInput): ValidationResult {
    if (!draft.goals || draft.goals.length === 0) {
      return { valid: false, errors: ["Math contract requires at least one goal"] };
    }
    if (!draft.scope || !draft.scope["problemHash"]) {
      return { valid: false, errors: ["Missing problemHash in scope"] };
    }
    return { valid: true, errors: [] };
  }

  buildWorkContext(view: TaskContextView): DomainContext {
    return {
      systemPromptSegment:
        "You are an expert mathematical reasoning agent. Always derive exact formulas, " +
        "invoke deterministic math assets via use_math_asset for verification, and never guess solutions.",
      availableTools: [...MATH_ASSET_NAMES],
      promptPayload: {
        problemInputRef: view.runSpec.inputRefs[0] || "",
        activeGoals: view.goalContract.goals,
      },
    };
  }

  validateWorkPacket(packet: unknown, binding: TrustedBinding): WorkValidation {
    if (typeof packet !== "object" || packet === null) {
      return { accepted: false, reason: "Work packet must be a non-null object" };
    }
    return { accepted: true };
  }

  classifyRoute(proposal: RouteProposal, prior: readonly RouteSummary[]): RouteAssessment {
    const isDuplicate = prior.some((p) => p.routeId === proposal.routeId);
    return {
      isSubstantive: !isDuplicate && proposal.proposedSteps.length > 0,
      duplicateOf: isDuplicate ? proposal.routeId : undefined,
      score: proposal.proposedSteps.length >= 2 ? 1.0 : 0.5,
    };
  }

  proposeChecks(candidate: CandidateView): readonly CheckSpec[] {
    return [
      {
        checkId: `chk_eval_${candidate.candidateId}`,
        validatorId: "math_algebraic_evaluator",
        parameters: { target: candidate.candidateId },
        timeoutMs: 5000,
      },
      {
        checkId: `chk_boundary_${candidate.candidateId}`,
        validatorId: "math_boundary_verifier",
        parameters: { target: candidate.candidateId },
        timeoutMs: 5000,
      },
    ];
  }

  interpretObservation(receipt: TrustedToolReceipt): readonly ScopedEvidence[] {
    if (receipt.status !== "SUCCESS") {
      return [
        {
          evidenceId: `ev_err_${receipt.callId}`,
          method: receipt.toolName,
          conditions: { status: receipt.status },
          scope: "TOOL_ERROR",
          limitation: receipt.errorSnippet || "Tool execution failed",
          verified: false,
        },
      ];
    }

    return [
      {
        evidenceId: `ev_ok_${receipt.callId}`,
        method: receipt.toolName,
        conditions: { toolOutput: receipt.output },
        scope: "EXACT_NUMERICAL_COMPUTATION",
        limitation: "Valid only on specified discrete input values",
        verified: true,
      },
    ];
  }

  compareCandidates(a: CandidateView, b: CandidateView): CandidateComparison {
    const strA = JSON.stringify(a.rawContent);
    const strB = JSON.stringify(b.rawContent);
    if (strA === strB) {
      return { result: "EQUIVALENT", method: "exact_structural_match" };
    }
    return {
      result: "DIFFERENT",
      method: "canonical_answer_divergence",
      divergenceSummary: `Candidate ${a.candidateId} differs from ${b.candidateId}`,
    };
  }

  assessObligation(receipts: readonly AcceptanceReceipt[], target: ObligationView): Assessment {
    const passCount = receipts.filter((r) => r.outcome === "PASS").length;
    const failCount = receipts.filter((r) => r.outcome === "FAIL").length;

    if (failCount > 0) {
      return { newState: "REFUTED", rationale: "At least one mathematical validator failed" };
    }
    if (passCount >= 2) {
      return {
        newState: "ACCEPTED_WITHIN_SCOPE",
        rationale: "Validated against algebraic evaluator and boundary verifier within discrete scope",
      };
    }
    if (passCount > 0) {
      return { newState: "SUPPORTED", rationale: "Partial support from math tool verification" };
    }
    return { newState: "INCONCLUSIVE", rationale: "Insufficient verification receipts" };
  }

  projectDelivery(view: FinalStateView): DomainDelivery {
    const certLines: string[] = [
      "=== CERT1 MATHEMATICAL AUDIT CERTIFICATE ===",
      `Domain: ${this.id}@${this.version}`,
      `RunID: ${view.runSpec.runId}`,
      `Goals: ${view.goalContract.goals.join(", ")}`,
      `CandidateVerified: false (Honest Baseline Contract: candidate_verified is always false)`,
    ];

    if (view.candidate) {
      certLines.push(`CandidateID: ${view.candidate.candidateId}`);
      certLines.push(`RawAnswer: ${JSON.stringify(view.candidate.rawContent)}`);
    } else {
      certLines.push("CandidateID: NONE");
    }

    certLines.push(`TotalObservations: ${view.observations.length}`);
    certLines.push("=== END CERTIFICATE ===");

    return {
      formattedSummary: certLines.join("\n"),
      exportedFiles: [
        {
          name: "CERT1.txt",
          content: certLines.join("\n"),
        },
      ],
      deliveryState: view.candidate ? "CANDIDATE_AVAILABLE" : "NO_DELIVERABLE",
    };
  }
}
