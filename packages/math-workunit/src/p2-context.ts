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
