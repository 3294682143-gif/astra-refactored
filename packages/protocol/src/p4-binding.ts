/**
 * @astra/protocol — P4 structural binding guard (pure, no I/O).
 *
 * This module only checks structural relationships between an M1 contract, an
 * M3 artifact and the task it belongs to. It performs no mathematical check,
 * promotes no evidence level and never claims acceptance. A hash confirms
 * identity of the same data, not mathematical equivalence.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  canonicalScope,
  p2Snapshot,
  parseP2WorkPacketAny,
  validateP2GoalSpecs,
  validateP2Scope,
  type P2AcceptedWorkPacket,
  type P2Artifact,
  type P2ArtifactAvailability,
  type P2Contract,
  type P2GoalSpec,
  type P2Task,
} from "./p2.js";
import { detectLoneSurrogates } from "./index.js";
import { createHash } from "node:crypto";

/** Fixed field order of a P4 binding; used for hashing and comparison. */
export const P4_BINDING_FIELDS = Object.freeze([
  "sessionId",
  "problemHash",
  "contractVersion",
  "artifactId",
  "artifactVersion",
  "taskId",
  "goalId",
  "scopeId",
  "sourceRequestId",
] as const);

import type { P4Binding, P4Target } from "./p4.js";

const MAX_RAW_BYTES = 65536;
const MAX_PROBLEM_CHARS = 8192;
const MAX_ID_CHARS = 128;
const MAX_SHORT_CHARS = 256;
const MAX_TEXT_CHARS = 4096;

/** sha256 lowercase hex of the exact UTF-8 bytes of `text`. */
export function p4Hash(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= maxChars &&
    detectLoneSurrogates(value).ok
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Structural equality of JSON-shaped data; key order is irrelevant. */
export function p4JsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!p4JsonEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) {
      return false;
    }
    if (!p4JsonEqual(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

/** Every goal node of the tree, including MULTIPART children. */
function flattenGoals(specs: readonly P2GoalSpec[]): readonly P2GoalSpec[] {
  const collected: P2GoalSpec[] = [];
  const walk = (nodes: readonly P2GoalSpec[]): void => {
    for (const node of nodes) {
      collected.push(node);
      if (node.subgoals.length > 0) {
        walk(node.subgoals);
      }
    }
  };
  walk(specs);
  return collected;
}

function requireContract(contract: P2Contract): P2Contract {
  if (!isPlainObject(contract)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const envelope = contract.envelope;
  if (!isPlainObject(envelope) || envelope.sourceModule !== "M1") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!isBoundedString(envelope.sessionId, MAX_ID_CHARS)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!isBoundedString(contract.problemFullText, MAX_PROBLEM_CHARS)) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const problemHash = p4Hash(contract.problemFullText);
  if (contract.problemHash !== problemHash || envelope.problemHash !== problemHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!isPositiveSafeInteger(contract.contractVersion)) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (envelope.contractVersion !== contract.contractVersion) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  validateP2GoalSpecs(contract.goals);
  return contract;
}

function requireTask(contract: P2Contract, taskId: string): P2Task {
  const found = contract.tasks.find((task) => task.taskId === taskId);
  if (found === undefined) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const envelope = found.envelope;
  if (!isPlainObject(envelope) || envelope.sourceModule !== "M1") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (envelope.sessionId !== contract.envelope.sessionId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (envelope.problemHash !== contract.problemHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (envelope.contractVersion !== contract.contractVersion) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (envelope.taskId !== found.taskId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (envelope.scopeId !== found.scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  const goals = flattenGoals(contract.goals);
  const goal = goals.find((node) => node.goalId === found.goalId);
  if (goal === undefined) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (goal.scope.scopeId !== found.scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  const obligation = contract.obligations.find(
    (item) => item.obligationId === found.obligationId,
  );
  if (obligation === undefined) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (obligation.goalId !== found.goalId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (obligation.envelope.sourceModule !== "M1") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (obligation.envelope.sessionId !== contract.envelope.sessionId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (obligation.envelope.problemHash !== contract.problemHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (obligation.envelope.contractVersion !== contract.contractVersion) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (obligation.envelope.scopeId !== found.scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  // A task that legitimately depends on earlier tasks is accepted only when
  // every dependency task id is a real task of this same contract; a foreign
  // or unknown dependency task is still a fixed rejection.
  for (const dependencyTaskId of found.dependencyTaskIds) {
    if (!contract.tasks.some((task) => task.taskId === dependencyTaskId)) {
      throw new P2Error(P2_ERROR_CODES.UNKNOWN_DEPENDENCY);
    }
  }
  return found;
}

function requireArtifact(contract: P2Contract, task: P2Task, artifact: P2Artifact): P2Artifact {
  if (!isPlainObject(artifact)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const envelope = artifact.envelope;
  if (!isPlainObject(envelope) || envelope.sourceModule !== "M3") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (artifact.level !== "PROVISIONAL" || artifact.checkResult !== "UNKNOWN") {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (artifact.transportStatus !== "COMPLETE" || artifact.deliveryStatus !== "COMPLETE") {
    throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
  }
  if (artifact.packet === null) {
    throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
  }
  // Unified dependency-admission contract. An artifact that carries its task's
  // real declared input refs is admitted; the flag must truthfully report that
  // dependency state (it is never itself grounds for rejection, and it is not a
  // way to smuggle a foreign dependency in -- the exact input-ref equality and
  // the real-task check above/below stay the fixed rejections). This matches the
  // Host-side invariant `provisionalDependency == bool(task.inputArtifactRefs)`.
  if (artifact.provisionalDependency !== (task.inputArtifactRefs.length > 0)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!isBoundedString(artifact.artifactId, MAX_SHORT_CHARS)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (envelope.artifactId !== artifact.artifactId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (envelope.taskId !== task.taskId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!isPositiveSafeInteger(envelope.artifactVersion)) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (envelope.sessionId !== contract.envelope.sessionId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (envelope.problemHash !== contract.problemHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (envelope.contractVersion !== contract.contractVersion) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (!isBoundedString(artifact.sourceRequestId, MAX_SHORT_CHARS)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!isBoundedString(artifact.routeId, MAX_SHORT_CHARS)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  // Declared dependencies are accepted only when they are exactly this task's
  // own declared input refs; a foreign, unknown or tampered ref is refused.
  if (!p4JsonEqual(artifact.dependencies, task.inputArtifactRefs)) {
    throw new P2Error(P2_ERROR_CODES.UNKNOWN_DEPENDENCY);
  }
  const scope = validateP2Scope(artifact.scope);
  const scopeId = p4Hash(canonicalScope(scope));
  if (scope.scopeId !== scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (envelope.scopeId !== scope.scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (task.scopeId !== scope.scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (typeof artifact.rawResponseText !== "string" || !detectLoneSurrogates(artifact.rawResponseText).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (Buffer.byteLength(artifact.rawResponseText, "utf8") > MAX_RAW_BYTES) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (p4Hash(artifact.rawResponseText) !== artifact.rawResponseHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (artifact.rawResponseRef !== `${contract.envelope.sessionId}:raw:${artifact.sourceRequestId}`) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  let parsed: P2AcceptedWorkPacket;
  try {
    parsed = parseP2WorkPacketAny(artifact.rawResponseText);
  } catch (error) {
    if (error instanceof P2Error) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    throw error;
  }
  if (!p4JsonEqual(parsed, artifact.packet)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const packet = artifact.packet;
  if (!p4JsonEqual(packet.dependencies, task.inputArtifactRefs)) {
    throw new P2Error(P2_ERROR_CODES.UNKNOWN_DEPENDENCY);
  }
  if (packet.sessionId !== contract.envelope.sessionId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (packet.problemHash !== contract.problemHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (packet.contractVersion !== contract.contractVersion) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (packet.taskId !== task.taskId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (packet.goalId !== task.goalId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (packet.scopeId !== scope.scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (packet.routeId !== artifact.routeId) {
    throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
  }
  if (packet.sourceRequestId !== artifact.sourceRequestId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (packet.deliveryStatus !== "COMPLETE") {
    throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
  }
  if (packet.claim.trim().length === 0 || packet.derivation.trim().length === 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
  }
  if ([...packet.claim].length > MAX_TEXT_CHARS || [...packet.derivation].length > MAX_TEXT_CHARS) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const declaredAssumptions = new Set(scope.localAssumptions);
  for (const assumption of packet.assumptions) {
    if (!declaredAssumptions.has(assumption)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCOPE_VIOLATION);
    }
  }
  if (packet.candidateProposal !== null) {
    if (
      !isBoundedString(packet.candidateProposal, MAX_TEXT_CHARS) ||
      packet.candidateProposal.trim().length === 0
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  return artifact;
}

/**
 * Build the structural P4 target of one M3 artifact.
 *
 * Only structural relationships are checked; no mathematical claim is made
 * and no evidence level is promoted. `availability` is a separate axis and
 * never changes the identity.
 */
export function p4Target(
  contract: P2Contract,
  artifact: P2Artifact,
  availability: P2ArtifactAvailability = "ACTIVE",
): P4Target {
  try {
    if (availability !== "ACTIVE" && availability !== "STALE") {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const frozenContract = p2Snapshot(contract);
    const frozenArtifact = p2Snapshot(artifact);
    const checkedContract = requireContract(frozenContract);
    const task = requireTask(checkedContract, frozenArtifact.envelope.taskId ?? "");
    requireArtifact(checkedContract, task, frozenArtifact);
    const goal = flattenGoals(checkedContract.goals).find((node) => node.goalId === task.goalId);
    if (goal === undefined) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!p4JsonEqual(goal.scope, frozenArtifact.scope)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    const binding: P4Binding = Object.freeze({
      sessionId: checkedContract.envelope.sessionId,
      problemHash: checkedContract.problemHash,
      contractVersion: checkedContract.contractVersion,
      artifactId: frozenArtifact.artifactId,
      artifactVersion: frozenArtifact.envelope.artifactVersion as number,
      taskId: task.taskId,
      goalId: task.goalId,
      scopeId: frozenArtifact.scope.scopeId,
      sourceRequestId: frozenArtifact.sourceRequestId,
    });
    const targetHash = p4Hash(JSON.stringify([binding, frozenArtifact.rawResponseHash]));
    return Object.freeze({
      binding,
      targetHash,
      artifact: frozenArtifact,
      availability,
    });
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}

/**
 * Exact structural comparison of two bindings. Values are compared as raw
 * strings and safe integers; nothing is trimmed or coerced. An invalid input
 * returns `false` rather than throwing, so callers can use it as a guard.
 */
export function p4SameBinding(left: unknown, right: unknown): boolean {
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== P4_BINDING_FIELDS.length || rightKeys.length !== P4_BINDING_FIELDS.length) {
    return false;
  }
  for (const field of P4_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(left, field)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(right, field)) {
      return false;
    }
    const a = left[field];
    const b = right[field];
    if (field === "contractVersion" || field === "artifactVersion") {
      if (!isPositiveSafeInteger(a) || !isPositiveSafeInteger(b) || a !== b) {
        return false;
      }
      continue;
    }
    if (typeof a !== "string" || typeof b !== "string" || a !== b) {
      return false;
    }
  }
  return true;
}
