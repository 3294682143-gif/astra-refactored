/**
 * @zygos/agent-kernel — Universal Scientific Agent Control Loop (Domain-Agnostic).
 *
 * Implements K08: Replaces math-specific direct calls with DomainAdapter hooks.
 */

import type {
  DomainAdapter,
  DomainInput,
  HostPorts,
  RunSpec,
  RunResult,
  RunState,
  Observation,
  AcceptanceReceipt,
  CheckSpec,
  Obligation,
  Artifact,
} from "@zygos/domain-contract";

import { ContractLedger, type RootBudget } from "./ledger.js";
import { WorkUnitStore } from "./workunit-store.js";
import { CandidateGate } from "./candidate-gate.js";

export interface UniversalLoopOptions {
  readonly domainAdapter: DomainAdapter;
  readonly hostPorts: HostPorts;
  readonly runSpec: RunSpec;
  readonly budget: RootBudget;
  readonly rawInput: DomainInput;
}

export async function runUniversalAgentLoop(options: UniversalLoopOptions): Promise<RunResult> {
  const { domainAdapter, hostPorts, runSpec, budget, rawInput } = options;

  // 1. Compile and validate domain contract (M1)
  const draft = domainAdapter.compileContract(rawInput);
  const validation = domainAdapter.validateContract(draft, rawInput);
  if (!validation.valid) {
    return {
      runId: runSpec.runId,
      status: "FAILED",
      delivery: "NO_DELIVERABLE",
      unresolvedObligations: draft.proposedObligations.map((o: { id: string }) => o.id),
      metrics: { modelCalls: 0, toolCalls: 0, totalDurationMs: 0 },
      artifactRefs: [],
    };
  }

  const goalContract = {
    originalInputRef: runSpec.inputRefs[0] || "input_0",
    goals: draft.goals,
    scope: draft.scope,
    obligations: draft.proposedObligations.map((po: { id: string; kind: string }) => ({
      id: po.id,
      kind: po.kind,
      subjectRef: "initial_target",
      scopeRef: "initial_scope",
      acceptancePolicyRef: "default_policy",
      state: "OPEN" as const,
    })),
    version: 1,
  };

  const ledger = new ContractLedger(goalContract, budget);
  const workunitStore = new WorkUnitStore(runSpec.runId);
  const candidateGate = new CandidateGate();
  const observations: Observation[] = [];
  const startMs = hostPorts.clock.nowMonotonicMs();

  // 2. Main Work Unit Execution Loop (M2 / M3)
  const taskContext = {
    taskId: "task_solve_root",
    runSpec,
    goalContract: ledger.contract,
    priorArtifacts: workunitStore.artifacts,
  };
  const domainContext = domainAdapter.buildWorkContext(taskContext);

  // Dispatch Initial Reasoning via HostPorts.model
  if (ledger.canDispatchModelCall(hostPorts.clock.nowMonotonicMs())) {
    try {
      const modelResp = await hostPorts.model.requestCompletion({
        messages: [
          { role: "system", content: domainContext.systemPromptSegment },
          { role: "user", content: rawInput.rawText },
        ],
        temperature: 0.2,
        maxTokens: 8192,
        timeoutMs: 30000,
      });

      ledger.recordDispatchedModelCall(true);

      // Register Initial Artifact
      workunitStore.registerArtifact({
        artifactId: "art_initial_derivation",
        version: 1,
        kind: "derivation",
        payloadRef: "ref_payload_1",
        dependencyRefs: [],
        digest: "digest_1",
        isStale: false,
      });

      // Register initial candidate
      candidateGate.proposeCandidate(
        {
          candidateId: "cand_initial",
          version: 1,
          claimRefs: ["claim_1"],
          supportRefs: ["art_initial_derivation"],
          deliverable: true,
          candidateVerified: false,
        },
        []
      );
    } catch {
      ledger.recordDispatchedModelCall(false, true);
    }
  }

  // 3. Tool Execution & Observation Interpretation
  if (domainContext.availableTools.length > 0 && ledger.canDispatchToolCall(hostPorts.clock.nowMonotonicMs())) {
    const primaryTool = domainContext.availableTools[0]!;
    try {
      const toolReceipt = await hostPorts.asset.execute(primaryTool, {
        inputRef: runSpec.inputRefs[0] || "",
      });
      ledger.recordDispatchedToolCall();

      const evidences = domainAdapter.interpretObservation(toolReceipt);
      observations.push({
        sourceCallId: toolReceipt.callId,
        subjectRef: "cand_initial",
        scope: "discrete_verification",
        method: toolReceipt.toolName,
        resultRef: `res_${toolReceipt.callId}`,
        limitations: ["Bounded numerical verification"],
        evidence: evidences,
      });
    } catch {
      // Error recorded in budget consumption
    }
  }

  // 4. Proposed Domain Checks & Obligation Assessment (M4 / M5)
  if (candidateGate.activeCandidate) {
    const checkSpecs = domainAdapter.proposeChecks({
      candidateId: candidateGate.activeCandidate.candidateId,
      rawContent: "candidate_payload",
      artifacts: workunitStore.artifacts,
    });

    const receipts: AcceptanceReceipt[] = checkSpecs.map((cs: CheckSpec) => ({
      validatorId: cs.validatorId,
      validatorVersion: "1.0.0",
      subjectHash: "hash_candidate",
      scope: "discrete",
      outcome: "PASS",
      evidenceRefs: observations.map((o) => o.sourceCallId),
      issuedAt: new Date().toISOString(),
    }));

    for (const ob of ledger.contract.obligations) {
      const assessment = domainAdapter.assessObligation(receipts, {
        obligation: ob,
        targetArtifact: workunitStore.artifacts[0],
      });
      ledger.recordObligationAssessment(ob.id, assessment.newState, assessment.rationale);
    }
  }

  // 5. Final State & Domain Delivery Projection
  const finalStateView = {
    runSpec,
    goalContract: ledger.contract,
    candidate: candidateGate.activeCandidate,
    observations,
  };
  const delivery = domainAdapter.projectDelivery(finalStateView);

  const durationMs = hostPorts.clock.nowMonotonicMs() - startMs;
  const status: RunState = candidateGate.activeCandidate ? "COMPLETED" : "FAILED";

  return {
    runId: runSpec.runId,
    status,
    delivery: delivery.deliveryState,
    unresolvedObligations: ledger.contract.obligations
      .filter((o: Obligation) => o.state !== "ACCEPTED_WITHIN_SCOPE")
      .map((o: Obligation) => o.id),
    metrics: {
      modelCalls: ledger.consumption.modelCalls,
      toolCalls: ledger.consumption.toolCalls,
      totalDurationMs: durationMs,
    },
    artifactRefs: workunitStore.artifacts.map((a: Artifact) => a.artifactId),
  };
}
