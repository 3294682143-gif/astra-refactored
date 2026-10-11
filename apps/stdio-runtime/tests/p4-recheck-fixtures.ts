/**
 * Shared real-material builder for the P4 S2 post-repair re-review tests.
 *
 * Everything here is built through the real M1 ledger, the real M3 store and
 * the real M4/M5 sessions; no binding, hash or raw text is fabricated. The
 * returned material is structural only: it proves nothing and resolves no
 * challenge.
 */

import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2WorkunitStore } from "@astra/math-workunit";
import { P4ReviewSession } from "@astra/math-review";
import { P4RepairSession } from "@astra/math-audit";
import {
  p4Hash,
  p4Target,
  type P2Artifact,
  type P2Contract,
  type P2Task,
  type P4Challenge,
  type P4RepairSnapshot,
  type P4ReviewSnapshot,
  type P4Target,
} from "@astra/protocol";
import { P4RecheckSession } from "@astra/math-review";

export const RECHECK_PROBLEM = "Find all real solutions x(x-1)=0";
export const RECHECK_SESSION = "s";
export const PARENT_DERIVATION = "😀 Divide by x. Then x=1.";
export const CHILD_DERIVATION = "😀 Split the zero product: x=0 or x=1.";
export const PARENT_QUOTE = "Divide by x.";
export const CHILD_QUOTE = "Split the zero product:";

const ROUTE = {
  routeId: "route-1",
  representation: "equation",
  operation: "derive",
  lemmas: [],
  construction: "offline",
} as const;

export interface RecheckMaterial {
  readonly contract: P2Contract;
  readonly task: P2Task;
  readonly parent: P4Target;
  readonly child: P4Target;
  readonly parentReview: P4ReviewSnapshot;
  readonly repair: P4RepairSnapshot;
  readonly challenge: P4Challenge;
  readonly parentRaw: string;
  readonly reviewRaw: string;
  readonly childRaw: string;
  readonly store: P2WorkunitStore;
}

function packetOf(
  contract: P2Contract,
  task: P2Task,
  sourceRequestId: string,
  claim: string,
  derivation: string,
  candidate: string,
): string {
  return JSON.stringify({
    schemaVersion: "p2a-work-v1",
    sessionId: contract.envelope.sessionId,
    problemHash: contract.problemHash,
    contractVersion: contract.contractVersion,
    taskId: task.taskId,
    goalId: task.goalId,
    scopeId: task.scopeId,
    routeId: "route-1",
    sourceRequestId,
    claim,
    derivation,
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: candidate,
  });
}

/** Half-open codepoint span of `quote` inside `source`. */
export function spanOf(source: string, quote: string): { start: number; end: number; quote: string } {
  const points = [...source];
  const width = [...quote].length;
  for (let start = 0; start + width <= points.length; start += 1) {
    if (points.slice(start, start + width).join("") === quote) {
      return { start, end: start + width, quote };
    }
  }
  throw new Error("quote not found");
}

/** Build the real parent/child/review/repair material for one re-review. */
export function buildRecheck(declaredAssumptions: readonly string[] = []): RecheckMaterial {
  const base = compileP2Contract(RECHECK_PROBLEM, RECHECK_SESSION);
  const contract =
    declaredAssumptions.length === 0
      ? base
      : compileP2Contract(RECHECK_PROBLEM, RECHECK_SESSION, [
          {
            ...base.goals[0]!,
            scope: { ...base.goals[0]!.scope, localAssumptions: declaredAssumptions },
          },
        ]);
  const ledger = new ContractLedger(contract);
  const task = ledger.readyTasks().find((row) => {
    const obligation = contract.obligations.find((item) => item.obligationId === row.obligationId);
    return obligation !== undefined && obligation.kind === "CANDIDATE_VALIDITY";
  });
  if (task === undefined) {
    throw new Error("no candidate task");
  }
  const running = ledger.startTask(task.taskId);
  const store = new P2WorkunitStore(ledger.snapshot());
  store.registerRoute(ROUTE);
  const parentRaw = packetOf(contract, running, "model-1", "x=1 only", PARENT_DERIVATION, "x=1");
  const parentArtifact = store.accept(running, {
    artifactId: "artifact-1",
    routeId: "route-1",
    sourceRequestId: "model-1",
    transportStatus: "COMPLETE",
    text: parentRaw,
    eventSeq: ledger.nextEventSeq(),
    supersedes: null,
  });
  const parent = p4Target(ledger.snapshot(), parentArtifact, "ACTIVE");
  const obligationIds = contract.obligations
    .filter(
      (item) => item.goalId === parent.binding.goalId && item.envelope.scopeId === parent.binding.scopeId,
    )
    .map((item) => item.obligationId);
  const reviewRaw = JSON.stringify({
    schemaVersion: "p4-review-v1",
    requestId: "model-2",
    target: parent.binding,
    targetHash: parent.targetHash,
    stage: "R2",
    conclusion: "ISSUES",
    reviewCoverage: obligationIds,
    issues: [
      {
        stepLocator: spanOf(PARENT_DERIVATION, PARENT_QUOTE),
        suspectedIssue: "ZERO_DIVISOR",
        rationale: "division by a possibly zero factor",
        requestedCheck: "check the zero branch",
        obligationIds,
      },
    ],
  });
  const review = new P4ReviewSession(contract, parent, 1);
  review.admit("model-2", 1000);
  review.markDispatched("model-2");
  if (review.settle("model-2", "COMPLETE", reviewRaw, 1000).code !== "OK") {
    throw new Error("review not recorded");
  }
  const parentReview = review.snapshot();
  const challenge = parentReview.challenges[0];
  if (challenge === undefined) {
    throw new Error("no challenge");
  }
  const childRaw = packetOf(contract, running, "model-3", "x=0 or x=1", CHILD_DERIVATION, "x=0 or x=1");
  const childArtifact = store.accept(running, {
    artifactId: "repair-1",
    routeId: "route-1",
    sourceRequestId: "model-3",
    transportStatus: "COMPLETE",
    text: childRaw,
    eventSeq: (parentArtifact.envelope.eventSeq ?? 0) + 1,
    supersedes: null,
  });
  const child = p4Target(ledger.snapshot(), childArtifact, "ACTIVE");
  const repairSession = new P4RepairSession(contract, parent, challenge, 1);
  repairSession.admit(1000);
  repairSession.markDispatched();
  if (repairSession.settle("COMPLETE", childRaw, child, 1000).code !== "PROPOSAL_RECORDED") {
    throw new Error("repair not recorded");
  }
  return {
    contract,
    task: running,
    parent,
    child,
    parentReview,
    repair: repairSession.snapshot(),
    challenge,
    parentRaw,
    reviewRaw,
    childRaw,
    store,
  };
}

/** A real M3-accepted variant child of the same task, for negative cases. */
export function acceptedChild(
  material: RecheckMaterial,
  changes: Record<string, unknown>,
): { readonly child: P4Target; readonly raw: string } {
  const store = new P2WorkunitStore(material.contract);
  store.registerRoute(ROUTE);
  const raw = JSON.stringify({ ...(JSON.parse(material.childRaw) as Record<string, unknown>), ...changes });
  const artifact: P2Artifact = store.accept(material.task, {
    artifactId: "repair-1",
    routeId: "route-1",
    sourceRequestId: "model-3",
    transportStatus: "COMPLETE",
    text: raw,
    eventSeq: (material.parent.artifact.envelope.eventSeq ?? 0) + 1,
    supersedes: null,
  });
  return { child: p4Target(material.contract, artifact, "ACTIVE"), raw };
}

/** Exact p4-recheck-v1 report text for the built material. */
export function reportRecheck(
  material: RecheckMaterial,
  verdict: "NO_ISSUE" | "ISSUES" | "UNKNOWN" = "NO_ISSUE",
): string {
  const locator = spanOf(CHILD_DERIVATION, CHILD_QUOTE);
  const rows = ["ISSUE_RESPONSE", "PREMISES", "DEPENDENCIES"].map((dimension) => ({
    dimension,
    verdict,
    rationale: `model opinion for ${dimension}`,
    childStepLocator: verdict === "UNKNOWN" ? null : locator,
  }));
  return JSON.stringify({
    schemaVersion: "p4-recheck-v1",
    requestId: "model-4",
    stage: "S2",
    parent: material.parent.binding,
    parentHash: material.parent.targetHash,
    child: material.child.binding,
    childHash: material.child.targetHash,
    challengeId: material.challenge.challengeId,
    repairHash: p4Hash(JSON.stringify(material.repair)),
    conclusion: verdict,
    reviewCoverage: material.challenge.issue.obligationIds,
    checks: rows,
  });
}

/** Open one re-review session over the built material. */
export function makeRecheck(material: RecheckMaterial, maxReviews = 1): P4RecheckSession {
  return new P4RecheckSession(
    material.contract,
    material.parent,
    material.child,
    material.parentReview,
    material.repair,
    maxReviews,
  );
}
