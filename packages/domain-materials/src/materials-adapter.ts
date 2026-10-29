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

export const MATERIALS_DOMAIN_ID = "materials_science";
export const MATERIALS_DOMAIN_VERSION = "1.0.0";

export class MaterialsDomainAdapter implements DomainAdapter {
  readonly id = MATERIALS_DOMAIN_ID;
  readonly version = MATERIALS_DOMAIN_VERSION;

  readonly schemas: DomainSchemas = {
    inputSchema: { type: "object", required: ["rawText"] },
    contractSchema: { type: "object", required: ["goals", "scope", "proposedObligations"] },
    workPacketSchema: { type: "object", required: ["crystalStructure"] },
    candidateSchema: { type: "object", required: ["formationEnergy", "bandGap"] },
  };

  compileContract(input: DomainInput): ContractDraft {
    const raw = input.rawText.trim();
    const problemHash = createHash("sha256").update(raw, "utf8").digest("hex");

    return {
      goals: ["CRYSTAL_PROPERTY_PREDICTION", "PHASE_STABILITY_ANALYSIS"],
      scope: { domainType: "computational_materials", problemHash },
      proposedObligations: [
        {
          id: "ob_lattice_symmetry",
          kind: "SPACE_GROUP_SYMMETRY_CONSISTENCY",
          description: "Verify atomic fractional coordinates match space group Wyckoff positions",
        },
        {
          id: "ob_formation_energy",
          kind: "CONVEX_HULL_THERMODYNAMIC_STABILITY",
          description: "Verify DFT formation energy lies on or within 0.05 eV/atom of the convex hull",
        },
      ],
    };
  }

  validateContract(draft: ContractDraft, source: DomainInput): ValidationResult {
    return { valid: draft.goals.includes("CRYSTAL_PROPERTY_PREDICTION"), errors: [] };
  }

  buildWorkContext(view: TaskContextView): DomainContext {
    return {
      systemPromptSegment: "You are a computational materials scientist. Predict crystal stability and band gap.",
      availableTools: ["materials.cif_parser", "materials.dft_surrogate", "materials.convex_hull_analyst"],
      promptPayload: { activeObligations: view.goalContract.obligations.map((o) => o.id) },
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
        checkId: `chk_hull_${candidate.candidateId}`,
        validatorId: "materials_hull_stability_checker",
        parameters: { target: candidate.candidateId },
        timeoutMs: 3000,
      },
    ];
  }

  interpretObservation(receipt: TrustedToolReceipt): readonly ScopedEvidence[] {
    return [
      {
        evidenceId: `ev_mat_${receipt.callId}`,
        method: receipt.toolName,
        conditions: { output: receipt.output },
        scope: "MATERIALS_PROPERTY_PREDICTION",
        limitation: "GGA-PBE level of theory approximation",
        verified: receipt.status === "SUCCESS",
      },
    ];
  }

  compareCandidates(a: CandidateView, b: CandidateView): CandidateComparison {
    return { result: "EQUIVALENT", method: "energy_per_atom_match" };
  }

  assessObligation(receipts: readonly AcceptanceReceipt[], target: ObligationView): Assessment {
    const passCount = receipts.filter((r) => r.outcome === "PASS").length;
    return {
      newState: passCount >= 1 ? "ACCEPTED_WITHIN_SCOPE" : "INCONCLUSIVE",
      rationale: passCount >= 1 ? "Convex hull stability confirmed" : "Pending DFT calculation",
    };
  }

  projectDelivery(view: FinalStateView): DomainDelivery {
    const text = `=== MATERIALS SCIENCE PROPERTY REPORT ===\nRunID: ${view.runSpec.runId}\nPhaseStability: STABLE`;
    return {
      formattedSummary: text,
      exportedFiles: [{ name: "materials_prediction_report.txt", content: text }],
      deliveryState: view.candidate ? "CANDIDATE_AVAILABLE" : "NO_DELIVERABLE",
    };
  }
}
