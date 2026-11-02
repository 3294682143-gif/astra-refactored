import { createHash } from "node:crypto";
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
  RouteSummary,
  TrustedToolReceipt,
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

function digest(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function runUniversalAgentLoop(options: UniversalLoopOptions): Promise<RunResult> {
  const { domainAdapter, hostPorts, runSpec, budget, rawInput } = options;
  const draft = domainAdapter.compileContract(rawInput);
  const validation = domainAdapter.validateContract(draft, rawInput);
  if (!validation.valid) {
    return {
      runId: runSpec.runId,
      status: "FAILED",
      delivery: "NO_DELIVERABLE",
      unresolvedObligations: draft.proposedObligations.map((obligation) => obligation.id),
      metrics: { modelCalls: 0, toolCalls: 0, totalDurationMs: 0 },
      artifactRefs: [],
    };
  }

  const goalContract = {
    originalInputRef: runSpec.inputRefs[0] || "input_0",
    goals: draft.goals,
    scope: draft.scope,
    obligations: draft.proposedObligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
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
  const routeSummaries: RouteSummary[] = [];
  const startMs = hostPorts.clock.nowMonotonicMs();
  const taskContext = {
    taskId: `task_solve_${runSpec.runId}`,
    runSpec,
    goalContract: ledger.contract,
    priorArtifacts: workunitStore.artifacts,
  };
  const domainContext = domainAdapter.buildWorkContext(taskContext);
  let lastToolReceipt: TrustedToolReceipt | null = null;
  let toolWasRequested = false;
  let tokensConsumed = 0;
  const maxRounds = Math.min(8, Math.max(1, budget.maxModelCalls));

  const executeTool = async (toolName: string, args: Record<string, unknown>): Promise<TrustedToolReceipt | null> => {
    if (!domainContext.availableTools.includes(toolName) || !ledger.canDispatchToolCall(hostPorts.clock.nowMonotonicMs())) {
      return null;
    }
    try {
      const receipt = await hostPorts.asset.execute(toolName, {
        inputRef: runSpec.inputRefs[0] || "",
        ...args,
      });
      ledger.recordDispatchedToolCall();
      const artifactId = `art_tool_${runSpec.runId}_${ledger.consumption.toolCalls}`;
      workunitStore.registerArtifact({
        artifactId,
        version: 1,
        kind: "tool_receipt",
        payloadRef: JSON.stringify(receipt.output) ?? receipt.errorSnippet ?? "",
        dependencyRefs: [],
        digest: digest(receipt.output),
        isStale: false,
        runId: runSpec.runId,
      });
      const evidence = domainAdapter.interpretObservation(receipt);
      observations.push({
        sourceCallId: receipt.callId,
        subjectRef: candidateGate.activeCandidate?.candidateId || `target_${runSpec.runId}`,
        scope: "discrete_verification",
        method: receipt.toolName,
        resultRef: `res_${receipt.callId}`,
        limitations: ["Bounded numerical verification"],
        evidence,
      });
      return receipt;
    } catch {
      return null;
    }
  };

  for (let round = 0; round < maxRounds && !candidateGate.activeCandidate; round += 1) {
    if (!ledger.canDispatchModelCall(hostPorts.clock.nowMonotonicMs())) break;
    try {
      const userContent = lastToolReceipt
        ? JSON.stringify({ rawInput: rawInput.rawText, toolReceipt: lastToolReceipt })
        : rawInput.rawText;
      const modelResp = await hostPorts.model.requestCompletion({
        messages: [
          { role: "system", content: domainContext.systemPromptSegment },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        maxTokens: 8192,
        timeoutMs: Math.min(30000, Math.max(1, hostPorts.clock.remainingBudgetMs())),
      });
      ledger.recordDispatchedModelCall(true);
      tokensConsumed += modelResp.usage?.totalTokens ?? 0;
      const content = modelResp.content?.trim() || "";
      if (!content) break;
      const parsed = parseObject(content);
      const packet = parsed ?? { content };
      const workValidation = domainAdapter.validateWorkPacket(packet, {
        runId: runSpec.runId,
        taskId: taskContext.taskId,
        callerId: "universal_kernel",
      });
      if (!workValidation.accepted) break;
      const action = typeof parsed?.action === "string" ? parsed.action : "CANDIDATE";
      if (action === "ABSTAIN") break;
      if (action === "TOOL_CALL") {
        const toolName = parsed?.toolName;
        const args = parsed?.arguments;
        if (typeof toolName !== "string" || !args || typeof args !== "object" || Array.isArray(args)) break;
        lastToolReceipt = await executeTool(toolName, args as Record<string, unknown>);
        toolWasRequested = true;
        if (!lastToolReceipt) break;
        continue;
      }
      const routeId = typeof parsed?.routeId === "string" ? parsed.routeId : `route_${runSpec.runId}_${round}`;
      const routeAssessment = domainAdapter.classifyRoute({
        routeId,
        rationale: content,
        proposedSteps: stringArray(parsed?.proposedSteps).length > 0 ? stringArray(parsed?.proposedSteps) : [action],
      }, routeSummaries);
      if (!routeAssessment.isSubstantive) break;
      routeSummaries.push({ routeId, status: "EXECUTED", stepsExecuted: 1 });
      const artifactId = `art_derivation_${runSpec.runId}_${round}`;
      workunitStore.registerArtifact({
        artifactId,
        version: 1,
        kind: action === "REPAIR" ? "repair" : "derivation",
        payloadRef: content,
        dependencyRefs: lastToolReceipt ? [`art_tool_${runSpec.runId}_${ledger.consumption.toolCalls}`] : [],
        digest: digest(content),
        isStale: false,
        runId: runSpec.runId,
      });
      let candidateRaw: unknown = content;
      if (parsed) {
        candidateRaw = parsed.candidateProposal ?? parsed.candidate ?? parsed.answer ?? parsed;
      }
      const truncated = !["stop", "STOP", "complete", "COMPLETE"].includes(modelResp.finishReason);
      candidateGate.proposeCandidate({
        candidateId: `cand_${runSpec.runId}_${candidateGate.candidateHistory.length}`,
        version: candidateGate.candidateHistory.length + 1,
        claimRefs: stringArray(parsed?.claimRefs).length > 0 ? stringArray(parsed?.claimRefs) : [`claim_${runSpec.runId}`],
        supportRefs: workunitStore.artifacts.map((artifact) => artifact.artifactId),
        deliverable: true,
        candidateVerified: false,
        rawContent: candidateRaw,
      }, stringArray(parsed?.resolvedChallengeIds), truncated);
    } catch {
      ledger.recordDispatchedModelCall(false, true);
      break;
    }
  }

  if (candidateGate.activeCandidate && !toolWasRequested && domainContext.availableTools.length > 0) {
    const primaryTool = domainContext.availableTools[0]!;
    await executeTool(primaryTool, {});
  }

  const activeCandidate = candidateGate.activeCandidate;
  if (activeCandidate) {
    const candidateText = typeof activeCandidate.rawContent === "string"
      ? activeCandidate.rawContent
      : JSON.stringify(activeCandidate.rawContent ?? {});
    const candidateHash = digest(candidateText);
    const checkSpecs = domainAdapter.proposeChecks({
      candidateId: activeCandidate.candidateId,
      rawContent: activeCandidate.rawContent ?? "candidate_payload",
      artifacts: workunitStore.artifacts,
    });
    const receipts: AcceptanceReceipt[] = [];
    for (const check of checkSpecs) {
      if (hostPorts.validator) {
        let receipt: AcceptanceReceipt = {
          validatorId: check.validatorId,
          validatorVersion: "1.0.0",
          subjectHash: candidateHash,
          scope: "discrete",
          outcome: "INCONCLUSIVE",
          evidenceRefs: [],
          issuedAt: new Date().toISOString(),
        };
        if (ledger.canDispatchToolCall(hostPorts.clock.nowMonotonicMs())) {
          try {
            const candidateView = {
              candidateId: activeCandidate.candidateId,
              rawContent: activeCandidate.rawContent,
              artifacts: workunitStore.artifacts,
            };
            const dispatched = await hostPorts.validator.execute(check, candidateView);
            ledger.recordDispatchedToolCall();
            if (dispatched.validatorId === check.validatorId && dispatched.subjectHash === candidateHash) {
              receipt = dispatched;
            }
          } catch {
            ledger.recordDispatchedToolCall();
          }
        }
        receipts.push(receipt);
        continue;
      }
      const primaryTool = domainContext.availableTools[0];
      const matching = observations.filter((observation) =>
        observation.method === check.validatorId
        || observation.sourceCallId === check.checkId
        || (primaryTool && observation.method === primaryTool)
      );
      let outcome: "PASS" | "FAIL" | "INCONCLUSIVE" = "INCONCLUSIVE";
      if (matching.length > 0) {
        const failed = matching.some((observation) => observation.evidence.some((item) => !item.verified || item.scope === "TOOL_ERROR"));
        const passed = matching.some((observation) => observation.evidence.some((item) => item.verified));
        outcome = failed ? "FAIL" : passed ? "PASS" : "INCONCLUSIVE";
      }
      receipts.push({
        validatorId: check.validatorId,
        validatorVersion: "1.0.0",
        subjectHash: candidateHash,
        scope: "discrete",
        outcome,
        evidenceRefs: matching.map((observation) => observation.sourceCallId),
        issuedAt: new Date().toISOString(),
      });
    }
    for (const receipt of receipts) {
      if (receipt.outcome === "FAIL") candidateGate.recordRefutation(activeCandidate.candidateId, receipt);
    }
    for (const obligation of ledger.contract.obligations) {
      const assessment = domainAdapter.assessObligation(receipts, {
        obligation,
        targetArtifact: workunitStore.artifacts[0],
      });
      ledger.recordObligationAssessment(obligation.id, assessment.newState, assessment.rationale);
    }
  }

  const finalCandidate = candidateGate.activeCandidate;
  const delivery = domainAdapter.projectDelivery({
    runSpec,
    goalContract: ledger.contract,
    candidate: finalCandidate,
    observations,
  });
  const unresolvedObligations = ledger.contract.obligations
    .filter((obligation: Obligation) => obligation.state !== "ACCEPTED_WITHIN_SCOPE")
    .map((obligation: Obligation) => obligation.id);
  const status: RunState = finalCandidate && ledger.allObligationsAccepted() && delivery.deliveryState !== "NO_DELIVERABLE"
    ? "COMPLETED"
    : finalCandidate ? "WAITING" : "FAILED";
  return {
    runId: runSpec.runId,
    status,
    delivery: delivery.deliveryState,
    unresolvedObligations,
    metrics: {
      modelCalls: ledger.consumption.modelCalls,
      toolCalls: ledger.consumption.toolCalls,
      totalDurationMs: hostPorts.clock.nowMonotonicMs() - startMs,
      tokensConsumed,
    },
    artifactRefs: workunitStore.artifacts.map((artifact: Artifact) => artifact.artifactId),
    obligationStates: Object.fromEntries(ledger.contract.obligations.map((obligation) => [obligation.id, obligation.state])),
    deliverySummary: delivery.formattedSummary,
    candidateVerified: false,
  };
}
