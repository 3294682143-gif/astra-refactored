/**
 * @astra/math-review — P4 R0 trusted M1 precheck input validation (pure).
 *
 * Validates one `P4R0Preparation` handed over by trusted M1. It does not
 * authenticate arbitrary external objects, does not import the M1 contract
 * module and does not re-derive the template: M1 owns template coverage.
 * A structural match is never a mathematical result.
 */

import {
  P2_LIMITS,
  P2_OBLIGATION_KIND,
  P2Error,
  P2_ERROR_CODES,
  P4_R0_ACTION,
  P4_R0_MAX_ROOT_CALLS,
  P4_R0_RISK_CODES,
  canonicalScope,
  detectLoneSurrogates,
  p2Snapshot,
  p4Hash,
  validateP2GoalSpecs,
  type P2Contract,
  type P2GoalSpec,
  type P2Obligation,
  type P2Task,
  type P4R0Preparation,
  type P4R0RiskCode,
} from "@astra/protocol";

const MAX_PLAN_BYTES = 65536;
const MAX_RECORD_ID_CHARS = 4096;
const MAX_TEXT_CHARS = 4096;

function need(condition: unknown): asserts condition {
  if (!condition) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}

const isObj = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  need(isObj(value));
  const source = value as Record<string, unknown>;
  need(Object.keys(source).length === keys.length);
  for (const key of keys) {
    need(Object.prototype.hasOwnProperty.call(source, key));
  }
  return source;
};

const num = (value: unknown, min: number, max: number): number => {
  need(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max);
  return value as number;
};

const id = (value: unknown, max = 256): string => {
  need(typeof value === "string" && value.length > 0 && [...value].length <= max);
  need(detectLoneSurrogates(value).ok);
  return value as string;
};

const text = (value: unknown, max: number): string => {
  need(typeof value === "string" && value.trim().length > 0);
  need([...value].length <= max);
  need(detectLoneSurrogates(value).ok);
  return value as string;
};

const positiveInt = (value: unknown): number => {
  need(typeof value === "number" && Number.isSafeInteger(value) && value >= 1);
  return value as number;
};

const PREP = [
  "target",
  "action",
  "riskCodes",
  "structuralMatch",
  "semanticResult",
  "canSupportObligation",
  "planningModelCalls",
  "remainingRootCalls",
  "remainingMs",
] as const;
const TARGET = ["binding", "contract", "planText"] as const;
const BINDING = ["sessionId", "problemHash", "contractVersion", "planHash"] as const;
const CONTRACT = [
  "envelope",
  "problemFullText",
  "problemHash",
  "contractVersion",
  "semanticStatus",
  "riskHints",
  "goals",
  "obligations",
  "tasks",
] as const;
const ENVELOPE = [
  "recordId",
  "sessionId",
  "problemHash",
  "sourceModule",
  "contractVersion",
  "artifactVersion",
  "eventSeq",
] as const;
const CHILD_ENVELOPE = [
  "recordId",
  "sessionId",
  "problemHash",
  "sourceModule",
  "taskId",
  "contractVersion",
  "artifactVersion",
  "scopeId",
  "eventSeq",
] as const;
const OBLIGATION = [
  "envelope",
  "obligationId",
  "goalId",
  "kind",
  "status",
  "acceptance",
] as const;
const TASK = [
  "envelope",
  "taskId",
  "goalId",
  "obligationId",
  "scopeId",
  "inputArtifactRefs",
  "dependencyTaskIds",
  "expectedResult",
  "acceptanceCriteria",
  "delivery",
] as const;

/** Depth-first goal walk in declared order; a repeated node is visited once. */
function walkGoals(goals: readonly P2GoalSpec[], visit: (goal: P2GoalSpec) => void): void {
  const seen = new Set<object>();
  const walk = (goal: P2GoalSpec): void => {
    if (seen.has(goal)) {
      return;
    }
    seen.add(goal);
    visit(goal);
    for (const child of goal.subgoals) {
      walk(child);
    }
  };
  for (const goal of goals) {
    walk(goal);
  }
}

/** Reject a dependency cycle over task ids; a self edge is a cycle. */
function rejectCycle(tasks: readonly P2Task[]): void {
  const deps = new Map<string, readonly string[]>();
  for (const task of tasks) {
    deps.set(task.taskId, task.dependencyTaskIds);
  }
  const state = new Map<string, number>();
  const visit = (taskId: string): void => {
    const mark = state.get(taskId) ?? 0;
    need(mark !== 1);
    if (mark === 2) {
      return;
    }
    state.set(taskId, 1);
    for (const next of deps.get(taskId) ?? []) {
      visit(next);
    }
    state.set(taskId, 2);
  };
  for (const task of tasks) {
    visit(task.taskId);
  }
}

function checkEnvelope(
  value: unknown,
  keys: readonly string[],
  contract: P2Contract,
  scopeId: string | null,
): void {
  const envelope = exact(value, keys);
  need(envelope.sessionId === contract.envelope.sessionId);
  need(envelope.problemHash === contract.problemHash);
  need(envelope.contractVersion === contract.contractVersion);
  need(envelope.artifactVersion === 1);
  need(envelope.eventSeq === contract.envelope.eventSeq);
  need(envelope.sourceModule === "M1");
  id(envelope.recordId, MAX_RECORD_ID_CHARS);
  if (scopeId !== null) {
    need(envelope.scopeId === scopeId);
    id(envelope.taskId);
  }
}

/**
 * Validate one trusted M1 R0 preparation.
 *
 * The whole input is deep-frozen once. The contract is checked against its own
 * material (problem hash, version, envelope binding, goal specs, scope hashes,
 * initial obligation/task state, id uniqueness, references and acyclicity) and
 * the plan hash/plan text are recomputed. M1 already rebuilt the template, so
 * no template algorithm is duplicated here.
 */
export function validateP4R0Input(preparation: P4R0Preparation): P4R0Preparation {
  try {
    const frozen = p2Snapshot(preparation);
    need(detectLoneSurrogates(frozen).ok);
    const prep = exact(frozen, PREP);
    const target = exact(prep.target, TARGET);
    const binding = exact(target.binding, BINDING);
    const contract = exact(target.contract, CONTRACT) as unknown as P2Contract;

    need(typeof contract.problemFullText === "string" && contract.problemFullText.length > 0);
    need([...contract.problemFullText].length <= P2_LIMITS.maxProblemChars);
    need(typeof contract.envelope.sessionId === "string" && contract.envelope.sessionId.length > 0);
    need([...contract.envelope.sessionId].length <= 128);
    positiveInt(contract.contractVersion);
    positiveInt(contract.envelope.eventSeq);
    need(binding.sessionId === contract.envelope.sessionId);
    need(binding.problemHash === contract.problemHash);
    need(binding.contractVersion === contract.contractVersion);
    need(binding.problemHash === p4Hash(contract.problemFullText));
    need(contract.semanticStatus === "UNKNOWN");
    need(Array.isArray(contract.riskHints));
    need(contract.riskHints.length <= P2_LIMITS.maxArrayItems);
    need(contract.riskHints.every((hint) => typeof hint === "string" && hint.length > 0));

    checkEnvelope(contract.envelope, ENVELOPE, contract, null);
    const goals = validateP2GoalSpecs(contract.goals);
    const scopeIds = new Set<string>();
    const goalScopeIds = new Map<string, string>();
    walkGoals(goals, (goal) => {
      need(goal.scope.scopeId === p4Hash(canonicalScope(goal.scope)));
      scopeIds.add(goal.scope.scopeId);
      goalScopeIds.set(goal.goalId, goal.scope.scopeId);
    });

    need(Array.isArray(contract.obligations) && contract.obligations.length > 0);
    need(contract.obligations.length <= P2_LIMITS.maxObligations);
    need(Array.isArray(contract.tasks) && contract.tasks.length > 0);
    need(contract.tasks.length <= P2_LIMITS.maxTasks);
    const obligationIds = new Set<string>();
    for (const item of contract.obligations) {
      const obligation = exact(item, OBLIGATION) as unknown as P2Obligation;
      id(obligation.obligationId);
      need(!obligationIds.has(obligation.obligationId));
      obligationIds.add(obligation.obligationId);
      need(goalScopeIds.has(obligation.goalId));
      need(goalScopeIds.get(obligation.goalId) === obligation.envelope.scopeId);
      need(obligation.envelope.taskId === obligation.obligationId);
      need((P2_OBLIGATION_KIND as readonly string[]).includes(obligation.kind as string));
      need(obligation.status === "OPEN");
      need(obligation.acceptance === null);
      need(scopeIds.has(obligation.envelope.scopeId ?? ""));
      checkEnvelope(obligation.envelope, CHILD_ENVELOPE, contract, obligation.envelope.scopeId ?? null);
    }
    const taskIds = new Set<string>();
    const covered = new Set<string>();
    for (const item of contract.tasks) {
      const task = exact(item, TASK) as unknown as P2Task;
      id(task.taskId);
      need(!taskIds.has(task.taskId));
      taskIds.add(task.taskId);
      need(task.delivery === "READY");
      need(Array.isArray(task.inputArtifactRefs) && task.inputArtifactRefs.length === 0);
      need(Array.isArray(task.dependencyTaskIds));
      need(task.dependencyTaskIds.length <= P2_LIMITS.maxArrayItems);
      const depSeen = new Set<string>();
      for (const dep of task.dependencyTaskIds) {
        id(dep);
        need(!depSeen.has(dep));
        depSeen.add(dep);
      }
      need(obligationIds.has(task.obligationId));
      need(goalScopeIds.has(task.goalId));
      need(goalScopeIds.get(task.goalId) === task.scopeId);
      const owner = contract.obligations.find((entry) => entry.obligationId === task.obligationId);
      need(owner !== undefined);
      need(owner.goalId === task.goalId);
      need(owner.envelope.scopeId === task.scopeId);
      need(task.envelope.taskId === task.taskId);
      need(scopeIds.has(task.scopeId));
      need(task.envelope.scopeId === task.scopeId);
      text(task.expectedResult, MAX_TEXT_CHARS);
      text(task.acceptanceCriteria, MAX_TEXT_CHARS);
      checkEnvelope(task.envelope, CHILD_ENVELOPE, contract, task.scopeId);
      covered.add(task.obligationId);
    }
    for (const task of contract.tasks) {
      for (const dep of task.dependencyTaskIds) {
        need(taskIds.has(dep));
      }
    }
    rejectCycle(contract.tasks);
    for (const obligationId of obligationIds) {
      need(covered.has(obligationId));
    }

    const planText = JSON.stringify({
      goals: contract.goals,
      obligations: contract.obligations,
      tasks: contract.tasks,
      riskHints: contract.riskHints,
    });
    need(Buffer.byteLength(planText, "utf8") <= MAX_PLAN_BYTES);
    need(target.planText === planText);
    need(binding.planHash === p4Hash(JSON.stringify(contract)));

    need(Array.isArray(prep.riskCodes));
    const riskCodes: P4R0RiskCode[] = [];
    for (const code of prep.riskCodes) {
      need((P4_R0_RISK_CODES as readonly string[]).includes(code as string));
      need(!riskCodes.includes(code as P4R0RiskCode));
      riskCodes.push(code as P4R0RiskCode);
    }
    need(
      riskCodes.every(
        (code, index) =>
          index === 0 ||
          P4_R0_RISK_CODES.indexOf(code) > P4_R0_RISK_CODES.indexOf(riskCodes[index - 1] as P4R0RiskCode),
      ),
    );

    need(prep.structuralMatch === true);
    need(prep.semanticResult === "UNKNOWN");
    need(prep.canSupportObligation === false);
    const planningModelCalls = num(prep.planningModelCalls, 0, 1);
    const remainingRootCalls = num(prep.remainingRootCalls, 0, P4_R0_MAX_ROOT_CALLS);
    const remainingMs = num(prep.remainingMs, 0, 5000);
    need((P4_R0_ACTION as readonly string[]).includes(prep.action as string));
    if (prep.action === "REQUEST_REVIEW") {
      need(riskCodes.length > 0);
      need(planningModelCalls === 1);
      need(remainingRootCalls >= P4_R0_MAX_ROOT_CALLS);
      need(remainingMs >= 26);
    } else if (prep.action === "INSUFFICIENT_BUDGET") {
      need(riskCodes.length > 0);
      need(
        planningModelCalls === 0 ||
          remainingRootCalls < P4_R0_MAX_ROOT_CALLS ||
          remainingMs <= 25,
      );
    }

    return frozen;
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}
