/**
 * @zygos/domain-control - Control & Dynamics Domain Adapter (PR K11).
 *
 * Implements the second domain required by Section 15 to prove kernel replicability.
 * Focuses on forced damped oscillator parameter identification & independent validation:
 *   m * x''(t) + c * x'(t) + k * x(t) = u(t)
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

export const CONTROL_DOMAIN_ID = "control.identification" as const;
export const CONTROL_DOMAIN_VERSION = "1.0.0" as const;

export interface ControlParameters {
  readonly mass: number;      // m > 0 (kg)
  readonly damping: number;   // c > 0 (N*s/m)
  readonly stiffness: number; // k > 0 (N/m)
  readonly rmseHoldout: number;
}

export class ControlDomainAdapter implements DomainAdapter {
  readonly id = CONTROL_DOMAIN_ID;
  readonly version = CONTROL_DOMAIN_VERSION;

  readonly schemas: DomainSchemas = {
    inputSchema: { type: "object", required: ["rawText"] },
    contractSchema: { type: "object", required: ["goals", "scope", "proposedObligations"] },
    workPacketSchema: { type: "object", required: ["modelType"] },
    candidateSchema: {
      type: "object",
      required: ["mass", "damping", "stiffness", "rmseHoldout"],
    },
  };

  compileContract(input: DomainInput): ContractDraft {
    const raw = input.rawText.trim();
    const problemHash = createHash("sha256").update(raw, "utf8").digest("hex");

    return {
      goals: ["SYSTEM_IDENTIFICATION", "INDEPENDENT_PREDICTION"],
      scope: {
        domainType: "engineering_control",
        problemHash,
        targetSystem: "forced_damped_oscillator",
        validationSplitRatio: 0.2, // 20% validation split reserved
      },
      proposedObligations: [
        {
          id: "ob_leak_prevention",
          kind: "DATA_LEAK_PREVENTION",
          description: "Strict isolation: verification data must not be touched during parameter estimation",
        },
        {
          id: "ob_physics_bounds",
          kind: "PHYSICAL_BOUNDS_CHECK",
          description: "Identified parameters must strictly satisfy m > 0, c > 0, k > 0",
        },
        {
          id: "ob_aliasing_guard",
          kind: "SAMPLING_ALIASING_GUARD",
          description: "Sampling frequency must satisfy fs >= 10 * system_bandwidth to prevent aliasing",
        },
        {
          id: "ob_residual_whiteness",
          kind: "RESIDUAL_WHITENESS_CHECK",
          description: "Residual autocorrelation must pass whiteness test; non-white residuals trigger structure underdetermined",
        },
        {
          id: "ob_independent_rmse",
          kind: "INDEPENDENT_ERROR_BOUND",
          description: "Forward simulation on hold-out validation set must yield RMSE <= 0.05",
        },
      ],
    };
  }

  validateContract(draft: ContractDraft, source: DomainInput): ValidationResult {
    if (!draft.goals.includes("SYSTEM_IDENTIFICATION")) {
      return { valid: false, errors: ["Missing SYSTEM_IDENTIFICATION goal"] };
    }
    return { valid: true, errors: [] };
  }

  buildWorkContext(view: TaskContextView): DomainContext {
    return {
      systemPromptSegment:
        "You are an engineering control and dynamics identification specialist. " +
        "You must fit parameters m, c, k on the training split, verify physical stability, " +
        "and test forward prediction strictly on the hold-out validation split. Never leak validation data into training.",
      availableTools: [
        "control.timeseries_loader",
        "control.parameter_estimator",
        "control.forward_simulator",
      ],
      promptPayload: {
        systemEquation: "m*x''(t) + c*x'(t) + k*x(t) = u(t)",
        activeObligations: view.goalContract.obligations.map((o: { id: string }) => o.id),
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
      isSubstantive: !isDuplicate,
      duplicateOf: isDuplicate ? proposal.routeId : undefined,
      score: 1.0,
    };
  }

  proposeChecks(candidate: CandidateView): readonly CheckSpec[] {
    return [
      {
        checkId: `chk_leak_${candidate.candidateId}`,
        validatorId: "control_leak_detector",
        parameters: { target: candidate.candidateId, validationSplitRatio: 0.2 },
        timeoutMs: 3000,
      },
      {
        checkId: `chk_stability_${candidate.candidateId}`,
        validatorId: "control_eigenvalue_stability",
        parameters: { target: candidate.candidateId },
        timeoutMs: 3000,
      },
      {
        checkId: `chk_aliasing_${candidate.candidateId}`,
        validatorId: "control_aliasing_guard",
        parameters: { target: candidate.candidateId },
        timeoutMs: 3000,
      },
      {
        checkId: `chk_whiteness_${candidate.candidateId}`,
        validatorId: "control_whiteness_evaluator",
        parameters: { target: candidate.candidateId },
        timeoutMs: 3000,
      },
      {
        checkId: `chk_rmse_${candidate.candidateId}`,
        validatorId: "control_rmse_evaluator",
        parameters: { target: candidate.candidateId, maxRmse: 0.05 },
        timeoutMs: 5000,
      },
    ];
  }

  interpretObservation(receipt: TrustedToolReceipt): readonly ScopedEvidence[] {
    if (receipt.status !== "SUCCESS") {
      return [
        {
          evidenceId: `ev_ctl_err_${receipt.callId}`,
          method: receipt.toolName,
          conditions: { error: receipt.errorSnippet },
          scope: "IDENTIFICATION_FAILURE",
          limitation: receipt.errorSnippet || "Tool failed",
          verified: false,
        },
      ];
    }

    return [
      {
        evidenceId: `ev_ctl_ok_${receipt.callId}`,
        method: receipt.toolName,
        conditions: { output: receipt.output },
        scope: "DYNAMICS_IDENTIFICATION_ESTIMATE",
        limitation: "Valid on specified excitation bandwidth",
        verified: true,
      },
    ];
  }

  compareCandidates(a: CandidateView, b: CandidateView): CandidateComparison {
    const rawA = a.rawContent as Partial<ControlParameters>;
    const rawB = b.rawContent as Partial<ControlParameters>;

    if (
      typeof rawA.mass === "number" &&
      typeof rawB.mass === "number" &&
      Math.abs(rawA.mass - rawB.mass) < 1e-4 &&
      typeof rawA.damping === "number" &&
      typeof rawB.damping === "number" &&
      Math.abs(rawA.damping - rawB.damping) < 1e-4 &&
      typeof rawA.stiffness === "number" &&
      typeof rawB.stiffness === "number" &&
      Math.abs(rawA.stiffness - rawB.stiffness) < 1e-4
    ) {
      return { result: "EQUIVALENT", method: "parametric_relative_tolerance" };
    }

    return {
      result: "DIFFERENT",
      method: "parametric_relative_tolerance",
      divergenceSummary: `Parameters differ: A=[${rawA.mass}, ${rawA.damping}, ${rawA.stiffness}] vs B=[${rawB.mass}, ${rawB.damping}, ${rawB.stiffness}]`,
    };
  }

  assessObligation(receipts: readonly AcceptanceReceipt[], target: ObligationView): Assessment {
    const obId = target.obligation.id;

    if (obId === "ob_leak_prevention") {
      const leakReceipt = receipts.find((r) => r.validatorId === "control_leak_detector");
      if (leakReceipt && leakReceipt.outcome === "PASS") {
        return { newState: "ACCEPTED_WITHIN_SCOPE", rationale: "No data leakage into training split" };
      }
      return { newState: "REFUTED", rationale: "Data leakage detected into validation set" };
    }

    if (obId === "ob_physics_bounds") {
      const stabReceipt = receipts.find((r) => r.validatorId === "control_eigenvalue_stability");
      if (stabReceipt && stabReceipt.outcome === "PASS") {
        return { newState: "ACCEPTED_WITHIN_SCOPE", rationale: "Physical parameters m, c, k strictly positive" };
      }
      return { newState: "REFUTED", rationale: "Negative mass/damping or unstable eigenvalues" };
    }

    if (obId === "ob_aliasing_guard") {
      const aliasReceipt = receipts.find((r) => r.validatorId === "control_aliasing_guard");
      if (aliasReceipt && aliasReceipt.outcome === "PASS") {
        return { newState: "ACCEPTED_WITHIN_SCOPE", rationale: "Sampling rate fs >= 10x system bandwidth verified" };
      }
      return { newState: "REFUTED", rationale: "欠采样混叠违规：采样率低于 10x 系统带宽，义务不可关闭" };
    }

    if (obId === "ob_residual_whiteness") {
      const whiteReceipt = receipts.find((r) => r.validatorId === "control_whiteness_evaluator");
      if (whiteReceipt && whiteReceipt.outcome === "PASS") {
        return { newState: "ACCEPTED_WITHIN_SCOPE", rationale: "Residual whiteness verified, no significant autocorrelation" };
      }
      return { newState: "REFUTED", rationale: "结构欠定：残差自相关显著，表明存在未建模动态或结构失配，禁止输出参数可信" };
    }

    if (obId === "ob_independent_rmse") {
      const rmseReceipt = receipts.find((r) => r.validatorId === "control_rmse_evaluator");
      if (rmseReceipt && rmseReceipt.outcome === "PASS") {
        return { newState: "ACCEPTED_WITHIN_SCOPE", rationale: "Hold-out validation RMSE <= 0.05" };
      }
      return { newState: "INCONCLUSIVE", rationale: "Hold-out error not yet validated within threshold" };
    }

    return { newState: "OPEN", rationale: "Pending verification" };
  }

  projectDelivery(view: FinalStateView): DomainDelivery {
    const report: string[] = [
      "=== DYNAMICS PARAMETER IDENTIFICATION & PREDICTION REPORT ===",
      `Domain: ${this.id}@${this.version}`,
      `RunID: ${view.runSpec.runId}`,
      "TargetSystem: Forced Damped Oscillator (m*x'' + c*x' + k*x = u)",
    ];

    if (view.candidate) {
      const c = (view.candidate.rawContent as Partial<ControlParameters>) || {};
      report.push(`IdentifiedMass (kg): ${c.mass ?? "N/A"}`);
      report.push(`IdentifiedDamping (N*s/m): ${c.damping ?? "N/A"}`);
      report.push(`IdentifiedStiffness (N/m): ${c.stiffness ?? "N/A"}`);
      report.push(`HoldoutRMSE: ${c.rmseHoldout ?? "N/A"}`);
      report.push(`CandidateVerified: false (Scientific Baseline Contract)`);
    } else {
      report.push("IdentifiedParameters: NONE (Failed to converge)");
    }

    report.push("=== END REPORT ===");

    return {
      formattedSummary: report.join("\n"),
      exportedFiles: [
        {
          name: "system_identification_report.txt",
          content: report.join("\n"),
        },
      ],
      deliveryState: view.candidate ? "CANDIDATE_AVAILABLE" : "NO_DELIVERABLE",
    };
  }
}
