/**
 * @astra/math-workunit — P2-A trusted control-side binding guards.
 *
 * These helpers only re-check the binding of a trusted M1 contract/task
 * snapshot. They do not authenticate the graph, do not verify mathematics and
 * never promote a record. Rejections use fixed P2Error codes.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  canonicalScope,
  detectLoneSurrogates,
  p2Snapshot,
  validateP2GoalSpecs,
  validateP2Scope,
  type P2ArtifactRef,
  type P2Contract,
  type P2GoalSpec,
  type P2Task,
  type Scope,
} from "@astra/protocol";
import { createHash } from "node:crypto";

const MAX_SHORT = 256;
const MAX_TEXT = 8192;
const MAX_COVERAGE_ITEMS = 32;
const MAX_COVERAGE_CHARS = 256;

/** The four declared scope-coverage lists of one v5 scope proposal. */
export const P2_SCOPE_COVERAGE_FIELDS = [
  "quantifiers",
  "branchConditions",
  "boundaryCases",
  "goalExhaustion",
] as const;

/**
 * One task's declared scope coverage. Every list is normalized declared data:
 * trimming is only an emptiness check and never rewrites the raw item, and the
 * hash is an identity of the same bytes, never a coverage proof.
 */
export interface P2ScopeCoverage {
  readonly quantifiers: readonly string[];
  readonly branchConditions: readonly string[];
  readonly boundaryCases: readonly string[];
  readonly goalExhaustion: readonly string[];
  readonly coverageHash: string;
}

/**
 * One task's declared scope coverage together with the trusted scope identity
 * it was declared against. The `scopeId` is the canonical scope hash of the
 * task's own goal scope at declaration time; it is an identity of declared
 * data, never a coverage proof and never a readiness decision.
 */
export interface P2TaskScopeCoverage {
  readonly taskId: string;
  readonly scopeId: string;
  readonly coverage: P2ScopeCoverage;
}

/** Exact own-key set of one stored task-coverage row; extra keys rejected. */
const TASK_SCOPE_COVERAGE_FIELDS = ["taskId", "scopeId", "coverage"] as const;

/**
 * Re-check one stored task-coverage row: exact keys, a bounded task id, a
 * 64-hex scope id and a coverage record whose own hash matches its declared
 * lists. Nothing here derives coverage or closes an obligation.
 */
export function checkTaskScopeCoverage(value: unknown): P2TaskScopeCoverage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== TASK_SCOPE_COVERAGE_FIELDS.length) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  for (const field of TASK_SCOPE_COVERAGE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  const taskId = workShort(source.taskId);
  const scopeId = requireHash(source.scopeId);
  const coverage = checkScopeCoverage(source.coverage);
  return p2Snapshot({ taskId, scopeId, coverage }) as P2TaskScopeCoverage;
}

const SCOPE_COVERAGE_FIELDS = [
  ...P2_SCOPE_COVERAGE_FIELDS,
  "coverageHash",
] as const;

function coverageItem(value: unknown): string {
  if (typeof value !== "string") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectLoneSurrogates(value).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (value.trim().length === 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if ([...value].length > MAX_COVERAGE_CHARS) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function coverageList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_COVERAGE_ITEMS) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const item = coverageItem(value[index]);
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return p2Snapshot(out) as readonly string[];
}

/**
 * Normalize one untrusted v5 scope proposal into declared coverage data.
 *
 * Exactly the four declared list fields are accepted; a missing field, an
 * extra field or a non-list value is a fixed rejection. Items are trimmed only
 * to reject an empty one, deduplicated by exact bytes and hashed as declared
 * data. Nothing here derives a taskId, route, scopeId, obligationId, budget or
 * authority, and nothing here marks any obligation covered.
 */
export function p2ScopeCoverage(value: unknown): P2ScopeCoverage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== P2_SCOPE_COVERAGE_FIELDS.length) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  for (const field of P2_SCOPE_COVERAGE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  const quantifiers = coverageList(source.quantifiers);
  const branchConditions = coverageList(source.branchConditions);
  const boundaryCases = coverageList(source.boundaryCases);
  const goalExhaustion = coverageList(source.goalExhaustion);
  const coverageHash = createHash("sha256")
    .update(
      JSON.stringify([quantifiers, branchConditions, boundaryCases, goalExhaustion]),
      "utf8",
    )
    .digest("hex");
  return p2Snapshot({
    quantifiers,
    branchConditions,
    boundaryCases,
    goalExhaustion,
    coverageHash,
  }) as P2ScopeCoverage;
}

/**
 * Reject a declared coverage item that is not already part of the trusted
 * scope of the current task. A quantifier must be a declared scope quantifier
 * and a branch condition must be a declared scope branch condition; the two
 * other lists have no trusted counterpart and are carried as declared data.
 */
export function checkScopeCoverageAgainstScope(
  coverage: P2ScopeCoverage,
  scope: Scope,
  goalKind?: string,
): void {
  const trusted = validateP2Scope(scope);
  const quantifiers = new Set(trusted.quantifiers);
  for (const item of coverage.quantifiers) {
    if (!quantifiers.has(item)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
  }
  const branches = new Set(trusted.branchConditions);
  for (const item of coverage.branchConditions) {
    if (!branches.has(item)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
  }
  // A PARAMETER goal's declared boundaryCases must name exactly the trusted
  // parameter branches (ordinary + special value). A missing, forged, extra or
  // duplicated boundary case is a fixed rejection: the model's own claim never
  // establishes parameter coverage.
  if (goalKind === "PARAMETER") {
    const declared = coverage.boundaryCases;
    const declaredSet = new Set(declared);
    if (declared.length !== declaredSet.size) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    if (declaredSet.size !== branches.size) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    for (const item of branches) {
      if (!declaredSet.has(item)) {
        throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
      }
    }
  }
}

/**
 * Reject a declared `goalExhaustion` that does not exactly match the trusted
 * subgoal set of the declaring goal.
 *
 * A goal that carries subgoals (a MULTIPART root) has a trusted child goal id
 * set. A declaration that claims the goal is exhausted must name exactly that
 * set: a missing child id, an extra foreign id or a duplicate is a fixed
 * `SCOPE_MISMATCH` rejection. Order is irrelevant because the comparison is by
 * set. A goal without subgoals has no trusted counterpart for this list, so
 * the declaration is carried as declared data and nothing is rejected here.
 *
 * This is a comparison against the trusted task graph only. It never closes an
 * obligation, never changes the ready set and never promotes a declaration to
 * a coverage proof.
 */
export function checkGoalExhaustionAgainstGoal(
  coverage: P2ScopeCoverage,
  goal: P2GoalSpec,
): void {
  if (typeof goal !== "object" || goal === null || Array.isArray(goal)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const subgoals = goal.subgoals;
  if (!Array.isArray(subgoals) || subgoals.length === 0) {
    return;
  }
  const trusted = new Set<string>();
  for (const child of subgoals) {
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const childGoalId = (child as P2GoalSpec).goalId;
    if (typeof childGoalId !== "string" || childGoalId.length === 0) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    trusted.add(childGoalId);
  }
  const declared = new Set<string>();
  for (const item of coverage.goalExhaustion) {
    if (declared.has(item)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    declared.add(item);
  }
  if (declared.size !== trusted.size) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  for (const goalId of trusted) {
    if (!declared.has(goalId)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
  }
}

/** Exact own-key set of one stored coverage record; extra keys are rejected. */
export function checkScopeCoverage(value: unknown): P2ScopeCoverage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== SCOPE_COVERAGE_FIELDS.length) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  for (const field of SCOPE_COVERAGE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  const rebuilt = p2ScopeCoverage({
    quantifiers: source.quantifiers,
    branchConditions: source.branchConditions,
    boundaryCases: source.boundaryCases,
    goalExhaustion: source.goalExhaustion,
  });
  if (source.coverageHash !== rebuilt.coverageHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  return rebuilt;
}

/** SHA256 of the exact UTF-8 bytes, lowercase hex. */
export function workHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Non-empty after trimming, at most 256 Unicode chars of the original value,
 * no lone surrogate. The original value is returned unchanged: trimming is
 * only an emptiness check, never an identity rewrite.
 */
export function workShort(value: unknown): string {
  if (typeof value !== "string") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectLoneSurrogates(value).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (value.trim().length === 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if ([...value].length > MAX_SHORT) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

/** Positive safe integer. */
export function workSeq(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

/** Unambiguous internal key of one artifact ref; never a string concat. */
export function workRefKey(ref: P2ArtifactRef): string {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const keys = Object.keys(ref);
  if (keys.length !== 2) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!Object.prototype.hasOwnProperty.call(ref, "artifactId") || !Object.prototype.hasOwnProperty.call(ref, "artifactVersion")) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const artifactId = workShort(ref.artifactId);
  const artifactVersion = workSeq(ref.artifactVersion);
  return JSON.stringify([artifactId, artifactVersion]);
}

function requireHash(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

function findGoal(specs: readonly P2GoalSpec[], goalId: string): P2GoalSpec | null {
  for (const spec of specs) {
    if (spec.goalId === goalId) {
      return spec;
    }
    const nested = findGoal(spec.subgoals, goalId);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Re-check that `task` is the trusted RUNNING task of `contract` and return
 * the frozen scope of its goal. Any session/hash/version/scope/id mismatch is
 * a fixed rejection; the whole graph is not re-validated here.
 */
export function workScope(contract: P2Contract, task: P2Task): Scope {
  if (typeof contract !== "object" || contract === null || typeof task !== "object" || task === null) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const contractVersion = workSeq(contract.contractVersion);
  const contractEnvelope = contract.envelope;
  if (contractEnvelope.sourceModule !== "M1") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const sessionId = workShort(contractEnvelope.sessionId);
  if (workSeq(contractEnvelope.contractVersion) !== contractVersion) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  workSeq(contractEnvelope.eventSeq);
  const problemHash = requireHash(contractEnvelope.problemHash);
  if (typeof contract.problemFullText !== "string") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if ([...contract.problemFullText].length > MAX_TEXT) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (!detectLoneSurrogates(contract.problemFullText).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (requireHash(contract.problemHash) !== problemHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (workHash(contract.problemFullText) !== problemHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }

  const goals = validateP2GoalSpecs(contract.goals);
  const goalId = workShort(task.goalId);
  const goal = findGoal(goals, goalId);
  if (goal === null) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const scope = validateP2Scope(goal.scope);
  const scopeId = workShort(task.scopeId);
  if (scope.scopeId !== scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (workHash(canonicalScope(scope)) !== scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }

  const taskId = workShort(task.taskId);
  const declared = contract.tasks.find((candidate) => candidate.taskId === taskId);
  if (declared === undefined) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (declared.goalId !== goalId || declared.obligationId !== task.obligationId || declared.scopeId !== scopeId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!sameStringList(declared.dependencyTaskIds, task.dependencyTaskIds)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (declared.expectedResult !== task.expectedResult || declared.acceptanceCriteria !== task.acceptanceCriteria) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }

  if (task.delivery !== "RUNNING") {
    throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
  }
  const taskEnvelope = task.envelope;
  if (taskEnvelope.sourceModule !== "M1") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (workShort(taskEnvelope.sessionId) !== sessionId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (requireHash(taskEnvelope.problemHash) !== problemHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (workSeq(taskEnvelope.contractVersion) !== contractVersion) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (workShort(taskEnvelope.taskId) !== taskId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (workShort(taskEnvelope.scopeId) !== scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  workSeq(taskEnvelope.eventSeq);

  const obligationId = workShort(task.obligationId);
  const obligation = contract.obligations.find((candidate) => candidate.obligationId === obligationId);
  if (obligation === undefined) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (obligation.goalId !== goalId || obligation.envelope.scopeId !== scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }

  return p2Snapshot(scope) as Scope;
}
