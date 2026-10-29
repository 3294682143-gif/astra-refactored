/**
 * @astra/math-review — P4 R0 revised-contract structural validation (pure).
 *
 * Validates one real revised child contract against its parent contract and
 * the recorded revision delta. It never normalizes a real `REOPENED` status
 * back to `OPEN` and never projects the child into a pristine shape to satisfy
 * an older validator. A structural pass is not a mathematical result.
 */

import {
  P2_LIMITS,
  P2_OBLIGATION_KIND,
  P2Error,
  P2_ERROR_CODES,
  canonicalScope,
  detectLoneSurrogates,
  p4Hash,
  validateP2GoalSpecs,
  type P2Contract,
  type P2GoalSpec,
  type P2Obligation,
  type P2Task,
  type P4R0RevisionDelta,
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
const DELTA = [
  "fromVersion",
  "toVersion",
  "changedGoalIds",
  "affectedTaskIds",
  "preservedTaskIds",
  "removedTaskIds",
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

/** Old obligation ids whose goal was retyped or whose task was affected. */
function reopenedObligationIds(
  parent: P2Contract,
  delta: P4R0RevisionDelta | null,
): ReadonlySet<string> {
  const reopened = new Set<string>();
  if (delta === null) {
    return reopened;
  }
  const changedGoals = new Set(delta.changedGoalIds);
  const affectedTasks = new Set(delta.affectedTaskIds);
  for (const obligation of parent.obligations) {
    if (changedGoals.has(obligation.goalId)) {
      reopened.add(obligation.obligationId);
    }
  }
  for (const task of parent.tasks) {
    if (affectedTasks.has(task.taskId)) {
      reopened.add(task.obligationId);
    }
  }
  return reopened;
}

/**
 * Validate one real revised child contract.
 *
 * When `parent` is omitted the value is checked as a pristine contract whose
 * obligations are all `OPEN`; that is a pristine check only, not a default
 * child. A delta is accepted only together with a parent, and a caller that
 * supplies a delta without a parent is rejected. When a parent and a delta are
 * supplied, every obligation that already existed in the parent must be
 * `REOPENED` exactly when its goal was retyped or its task was affected, and
 * `OPEN` otherwise; a genuinely new obligation must be `OPEN`. The recorded
 * status is never rewritten and no compiler is invoked.
 */
export function validateRecheckContract(
  value: P2Contract,
  parent?: P2Contract,
  delta?: P4R0RevisionDelta,
): void {
  try {
    need((parent === undefined) === (delta === undefined));
    need(detectLoneSurrogates(value).ok);
    const contract = exact(value, CONTRACT) as unknown as P2Contract;

    need(typeof contract.problemFullText === "string" && contract.problemFullText.length > 0);
    need([...contract.problemFullText].length <= P2_LIMITS.maxProblemChars);
    need(typeof contract.envelope.sessionId === "string" && contract.envelope.sessionId.length > 0);
    need([...contract.envelope.sessionId].length <= 128);
    positiveInt(contract.contractVersion);
    positiveInt(contract.envelope.eventSeq);
    need(contract.semanticStatus === "UNKNOWN");
    need(contract.problemHash === p4Hash(contract.problemFullText));
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

    let parentContract: P2Contract | null = null;
    let reopened: ReadonlySet<string> = new Set<string>();
    if (parent !== undefined) {
      need(detectLoneSurrogates(parent).ok);
      parentContract = exact(parent, CONTRACT) as unknown as P2Contract;
      need(parentContract.envelope.sessionId === contract.envelope.sessionId);
      need(parentContract.problemHash === contract.problemHash);
      need(parentContract.problemFullText === contract.problemFullText);
      need(parentContract.contractVersion < contract.contractVersion);
      if (delta !== undefined) {
        const row = exact(delta, DELTA) as unknown as P4R0RevisionDelta;
        need(row.fromVersion === parentContract.contractVersion);
        need(row.toVersion === contract.contractVersion);
        need(Array.isArray(row.changedGoalIds));
        need(Array.isArray(row.affectedTaskIds));
        need(Array.isArray(row.preservedTaskIds));
        need(Array.isArray(row.removedTaskIds));
        reopened = reopenedObligationIds(parentContract, row);
      }
    }

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
      need(obligation.acceptance === null);
      need(scopeIds.has(obligation.envelope.scopeId ?? ""));
      checkEnvelope(obligation.envelope, CHILD_ENVELOPE, contract, obligation.envelope.scopeId ?? null);
      if (parentContract === null) {
        need(obligation.status === "OPEN");
      } else {
        const existed = parentContract.obligations.some(
          (entry) => entry.obligationId === obligation.obligationId,
        );
        if (!existed) {
          need(obligation.status === "OPEN");
        } else if (reopened.has(obligation.obligationId)) {
          need(obligation.status === "REOPENED");
        } else {
          need(obligation.status === "OPEN");
        }
      }
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
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}
