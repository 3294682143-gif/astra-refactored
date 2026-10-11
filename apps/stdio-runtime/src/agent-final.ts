/**
 * @astra/stdio-runtime — unified AgentLoop final-action helper (pure).
 *
 * Projects the already protected P4 candidate into the minimal, exact
 * three-field shape the WORK context may expose, and validates one parsed
 * `final` action against that projection. Nothing here is mathematical
 * acceptance: the projection only re-confirms the identity of the same
 * artifact through `p4Target`, and a matching `final` action is a control-side
 * confirmation of an existing candidate, never a new candidate and never a
 * verification.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  P4_BINDING_FIELDS,
  p2Snapshot,
  p4SameBinding,
  p4Target,
  type P2Contract,
  type P3Action,
  type P4Binding,
  type P4Target,
} from "@astra/protocol";

/** Exact three-field projection of one protected candidate. */
export interface AgentFinalCandidate {
  readonly binding: P4Binding;
  readonly targetHash: string;
  readonly answer: string;
}

const PROJECTION_FIELDS = ["binding", "targetHash", "answer"] as const;
const HASH = /^[0-9a-f]{64}$/u;
const REQUEST_ORDINAL = /^model-([1-4])$/u;
const MAX_ANSWER_CHARS = 4096;
const MAX_ID_CHARS = 256;
const MAX_SESSION_CHARS = 128;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  return source;
}

function ordinalOf(requestId: unknown): number {
  if (typeof requestId !== "string") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const match = REQUEST_ORDINAL.exec(requestId);
  if (match === null) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return Number.parseInt(match[1] as string, 10);
}

/**
 * Rebuild the exact three-field projection of one protected candidate.
 *
 * The target must be present and ACTIVE, its artifact must rebuild through
 * `p4Target` against the current contract with an identical binding and target
 * hash, and the packet must carry a non-empty candidate proposal. No new
 * target is created and no raw text is re-parsed by a second algorithm.
 */
export function projectProtectedFinal(
  contract: P2Contract,
  target: P4Target | null,
): AgentFinalCandidate | null {
  if (target === null) {
    return null;
  }
  const frozen = p2Snapshot(target) as P4Target;
  if (frozen.availability !== "ACTIVE") {
    return null;
  }
  let rebuilt: P4Target;
  try {
    rebuilt = p4Target(contract, frozen.artifact, "ACTIVE");
  } catch {
    return null;
  }
  if (!p4SameBinding(rebuilt.binding, frozen.binding)) {
    return null;
  }
  if (rebuilt.targetHash !== frozen.targetHash) {
    return null;
  }
  const packet = rebuilt.artifact.packet;
  if (packet === null) {
    return null;
  }
  const answer = packet.candidateProposal;
  if (typeof answer !== "string" || answer.trim().length === 0) {
    return null;
  }
  return p2Snapshot({
    binding: rebuilt.binding,
    targetHash: rebuilt.targetHash,
    answer,
  }) as AgentFinalCandidate;
}

/**
 * Strict shape check of one projection. The binding must carry exactly the
 * canonical P4 binding fields, the hash must be well formed and the answer
 * must be a bounded non-empty string. An unverified shape is never trusted.
 */
export function checkProtectedCandidate(value: unknown): AgentFinalCandidate {
  let frozen: unknown;
  try {
    frozen = p2Snapshot(value);
  } catch {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const row = exact(frozen, PROJECTION_FIELDS);
  const binding = exact(row.binding, P4_BINDING_FIELDS);
  if (
    typeof binding.sessionId !== "string" ||
    binding.sessionId.trim().length === 0 ||
    [...binding.sessionId].length > MAX_SESSION_CHARS
  ) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (typeof binding.problemHash !== "string" || !HASH.test(binding.problemHash)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (
    typeof binding.contractVersion !== "number" ||
    !Number.isSafeInteger(binding.contractVersion) ||
    binding.contractVersion < 1
  ) {
    fail(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (
    typeof binding.artifactId !== "string" ||
    binding.artifactId.trim().length === 0 ||
    [...binding.artifactId].length > MAX_ID_CHARS
  ) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (
    typeof binding.artifactVersion !== "number" ||
    !Number.isSafeInteger(binding.artifactVersion) ||
    binding.artifactVersion < 1
  ) {
    fail(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (
    typeof binding.taskId !== "string" ||
    binding.taskId.trim().length === 0 ||
    [...binding.taskId].length > MAX_ID_CHARS
  ) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (
    typeof binding.goalId !== "string" ||
    binding.goalId.trim().length === 0 ||
    [...binding.goalId].length > MAX_ID_CHARS
  ) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (typeof binding.scopeId !== "string" || !HASH.test(binding.scopeId)) {
    fail(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  ordinalOf(binding.sourceRequestId);
  if (typeof row.targetHash !== "string" || !HASH.test(row.targetHash)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const answer = row.answer;
  if (typeof answer !== "string" || answer.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if ([...answer].length > MAX_ANSWER_CHARS) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return p2Snapshot({
    binding: {
      sessionId: binding.sessionId,
      problemHash: binding.problemHash,
      contractVersion: binding.contractVersion,
      artifactId: binding.artifactId,
      artifactVersion: binding.artifactVersion,
      taskId: binding.taskId,
      goalId: binding.goalId,
      scopeId: binding.scopeId,
      sourceRequestId: binding.sourceRequestId,
    },
    targetHash: row.targetHash,
    answer,
  }) as AgentFinalCandidate;
}

/**
 * Validate one parsed `final` action against the protected projection.
 *
 * The action must be exactly `final`, its answer must equal the protected
 * candidate proposal byte for byte, `complete` must be true and `unresolved`
 * must be empty. The projection must be bound to the current session, problem
 * hash, contract version and task scope, and its source request ordinal must
 * precede the current request ordinal. A mismatch is a control rejection, not
 * a mathematical judgement.
 */
export function validateAgentFinal(
  action: P3Action,
  candidate: AgentFinalCandidate,
  contract: P2Contract,
  scopeId: string,
  requestId: string,
): boolean {
  if (action.action !== "final") {
    return false;
  }
  const checked = checkProtectedCandidate(p2Snapshot(candidate));
  if (checked.binding.sessionId !== contract.envelope.sessionId) {
    return false;
  }
  if (checked.binding.problemHash !== contract.problemHash) {
    return false;
  }
  if (checked.binding.contractVersion !== contract.contractVersion) {
    return false;
  }
  if (checked.binding.scopeId !== scopeId) {
    return false;
  }
  if (ordinalOf(checked.binding.sourceRequestId) >= ordinalOf(requestId)) {
    return false;
  }
  if (action.complete !== true) {
    return false;
  }
  if (action.unresolved.length !== 0) {
    return false;
  }
  return action.answer === checked.answer;
}
