import assert from "node:assert/strict";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2WorkunitStore } from "@astra/math-workunit";
import {
  p2Snapshot,
  p4Hash,
  p4Target,
  type P2Artifact,
  type P2Contract,
  type P2Task,
  type P3Action,
  type P4Binding,
  type P4CheckPlan,
  type P4Target,
} from "@astra/protocol";

export const MAPPING_PROBLEM = "Find all real solutions x(x-1)=0 \u{1F600}";
export const MAPPING_SESSION = "s";
export const MAPPING_ROUTE = {
  routeId: "route-1",
  representation: "equation",
  operation: "derive",
  lemmas: [],
  construction: "offline",
} as const;

export interface MappingBuilt {
  readonly workRaw: string;
  readonly contract: P2Contract;
  readonly task: P2Task;
  readonly artifact: P2Artifact;
  readonly target: P4Target;
  readonly binding: P4Binding;
  readonly plan: P4CheckPlan;
  readonly action: Extract<P3Action, { action: "tool" }>;
}

export function polyAction(): Extract<P3Action, { action: "tool" }> {
  return {
    action: "tool",
    name: "polynomial_expand_coefficients",
    args: { expression: "x*(x-1)", variables: ["x"], parameters: [] },
    scope: "expand",
  };
}

export function buildMapping(
  action: Extract<P3Action, { action: "tool" }> = polyAction(),
  problem: string = MAPPING_PROBLEM,
): MappingBuilt {
  const contract = compileP2Contract(problem, MAPPING_SESSION);
  const ledger = new ContractLedger(contract);
  const task = ledger.readyTasks().find((row) => {
    const obligation = contract.obligations.find((item) => item.obligationId === row.obligationId);
    return obligation !== undefined && obligation.kind === "CANDIDATE_VALIDITY";
  });
  assert.ok(task !== undefined);
  const running = ledger.startTask(task.taskId);
  const store = new P2WorkunitStore(ledger.snapshot());
  store.registerRoute(MAPPING_ROUTE);
  const packet = {
    schemaVersion: "p2a-work-v1",
    sessionId: contract.envelope.sessionId,
    problemHash: contract.problemHash,
    contractVersion: contract.contractVersion,
    taskId: running.taskId,
    goalId: running.goalId,
    scopeId: running.scopeId,
    routeId: "route-1",
    sourceRequestId: "model-1",
    claim: "x=1 only",
    derivation: "Divide by x. Then x=1.",
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: "x=1",
  };
  const workRaw = JSON.stringify(packet);
  const artifact = store.accept(running, {
    artifactId: "artifact-1",
    routeId: "route-1",
    sourceRequestId: "model-1",
    transportStatus: "COMPLETE",
    text: workRaw,
    eventSeq: ledger.nextEventSeq(),
    supersedes: null,
  });
  const target = p4Target(ledger.snapshot(), artifact, "ACTIVE");
  const plan = p2Snapshot({
    checkId: "check-1",
    target: target.binding,
    targetHash: target.targetHash,
    scope: target.artifact.scope,
    assumptions: [],
    checkedProperty:
      action.name === "polynomial_expand_coefficients"
        ? ("SUPPLIED_POLYNOMIAL_COEFFICIENTS" as const)
        : ("SUPPLIED_LINEAR_SOLUTION_SET" as const),
    methodOrToolVersion: "tool-registry-v1" as const,
    obligationIds: [running.obligationId],
    request: {
      effectId: "effect-1",
      binding: {
        sessionId: target.binding.sessionId,
        problemHash: target.binding.problemHash,
        contractVersion: target.binding.contractVersion,
        taskId: target.binding.taskId,
        scopeId: target.binding.scopeId,
        sourceRequestId: "model-1",
      },
      action,
      remainingMs: 5000,
    },
  }) as P4CheckPlan;
  return { workRaw, contract, task: running, artifact, target, binding: target.binding, plan, action };
}

export function reportMapping(
  built: MappingBuilt,
  verdict: "MATCH" | "MISMATCH" | "UNKNOWN" = "MATCH",
): string {
  const problem = built.contract.problemFullText;
  const representation = JSON.stringify(built.plan.request.action);
  const problemQuote = [...problem].slice(0, 4).join("");
  const representationQuote = [...representation].slice(0, 4).join("");
  const span = (quote: string) => ({ start: 0, end: [...quote].length, quote });
  const dimensions = ["VARIABLES", "DOMAIN", "QUANTIFIERS", "CONDITIONS", "COVERAGE"].map((dimension) => ({
    dimension,
    verdict,
    rationale: `synthetic fixture row for ${dimension}; not a mathematical verification`,
    problemSpan: verdict === "UNKNOWN" ? null : span(problemQuote),
    representationSpan: verdict === "UNKNOWN" ? null : span(representationQuote),
  }));
  return JSON.stringify({
    schemaVersion: "p4-mapping-review-v1",
    requestId: "model-2",
    stage: "S1",
    target: built.binding,
    targetHash: built.target.targetHash,
    planHash: p4Hash(JSON.stringify(built.plan)),
    conclusion: verdict,
    dimensions,
  });
}
