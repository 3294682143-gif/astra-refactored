/**
 * @astra/math-review — P4 S2 post-repair re-review input validation (pure).
 *
 * Structural material validation only: it rebuilds the parent/child targets,
 * replays the recorded M4 R2 review snapshot and checks the recorded S2 repair
 * snapshot against it. It parses no re-review report, performs no model call,
 * consumes no budget and promotes no evidence. A structural match is not a
 * mathematical check and a hash confirms identity of the same data only.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
  p2Snapshot,
  p4Hash,
  p4JsonEqual,
  p4SameBinding,
  p4Target,
  type P2Contract,
  type P4Binding,
  type P4Challenge,
  type P4RepairChangedField,
  type P4RepairLineage,
  type P4RepairRecord,
  type P4RepairSnapshot,
  type P4ReviewSnapshot,
  type P4Target,
} from "@astra/protocol";
import { P4ReviewSession } from "./p4-session.js";

const MAX_CONTEXT_BYTES = 65536;
const REPLAY_MS = 1000;
const CONTEXT_SCHEMA = "p4-repair-context-v1";
const CHANGED_FIELDS: readonly P4RepairChangedField[] = ["claim", "derivation", "candidateProposal"];
const TARGET_FIELDS = ["binding", "targetHash", "artifact", "availability"] as const;
const REVIEW_FIELDS = ["target", "targetHash", "availability", "records", "challenges", "evidence"] as const;
const REPAIR_FIELDS = ["parent", "parentHash", "availability", "record", "repairAttempts"] as const;
const RECORD_FIELDS = [
  "requestId",
  "parent",
  "parentHash",
  "challenge",
  "state",
  "context",
  "transportStatus",
  "rawResponseText",
  "lineage",
  "code",
] as const;
const CONTEXT_FIELDS = ["messages", "contextHash", "contextBytes"] as const;
const LINEAGE_FIELDS = [
  "parent",
  "parentHash",
  "child",
  "childHash",
  "challengeId",
  "requestId",
  "stage",
  "checkResult",
  "requiresRecheck",
  "canReplaceProtected",
  "changedFields",
] as const;
const PAYLOAD_FIELDS = [
  "schemaVersion",
  "requestId",
  "parent",
  "parentHash",
  "problemFullText",
  "scope",
  "parentClaim",
  "parentDerivation",
  "parentAssumptions",
  "parentCandidate",
  "routeId",
  "challenge",
  "obligations",
] as const;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) {
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

function frozenTarget(value: unknown): P4Target {
  const source = exact(value, TARGET_FIELDS);
  if (source.availability !== "ACTIVE") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value as P4Target;
}

function sameCommon(left: P4Binding, right: P4Binding): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.problemHash === right.problemHash &&
    left.contractVersion === right.contractVersion &&
    left.taskId === right.taskId &&
    left.goalId === right.goalId &&
    left.scopeId === right.scopeId
  );
}

function changedFieldsOf(parent: P4Target, child: P4Target): readonly P4RepairChangedField[] {
  const parentPacket = parent.artifact.packet;
  const childPacket = child.artifact.packet;
  if (parentPacket === null || childPacket === null) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const changed: P4RepairChangedField[] = [];
  if (childPacket.claim !== parentPacket.claim) {
    changed.push("claim");
  }
  if (childPacket.derivation !== parentPacket.derivation) {
    changed.push("derivation");
  }
  if (childPacket.candidateProposal !== parentPacket.candidateProposal) {
    changed.push("candidateProposal");
  }
  if (changed.length === 0) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return Object.freeze(changed);
}

/** Replay the recorded R2 review from its own raw text; no network, no budget. */
function replayReview(contract: P2Contract, parent: P4Target, review: P4ReviewSnapshot): P4ReviewSnapshot {
  const source = exact(review, REVIEW_FIELDS);
  if (source.availability !== "ACTIVE") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!p4SameBinding(source.target, parent.binding) || source.targetHash !== parent.targetHash) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!Array.isArray(source.records) || source.records.length !== 1) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const record = exact(source.records[0], [
    "requestId",
    "target",
    "targetHash",
    "state",
    "transportStatus",
    "context",
    "rawResponseText",
    "report",
    "code",
  ]);
  if (record.requestId !== "model-2" || record.state !== "RETURNED" || record.code !== "OK") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (record.transportStatus !== "COMPLETE" || typeof record.rawResponseText !== "string") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!plain(record.report) || record.report.conclusion !== "ISSUES") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const session = new P4ReviewSession(contract, parent, 1);
  session.admit("model-2", REPLAY_MS);
  session.markDispatched("model-2");
  session.settle("model-2", "COMPLETE", record.rawResponseText, REPLAY_MS);
  const replayed = session.snapshot();
  if (!p4JsonEqual(replayed, review)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return replayed;
}

function requireChallenge(replayed: P4ReviewSnapshot, challengeId: string): P4Challenge {
  const found = replayed.challenges.find((item) => item.challengeId === challengeId);
  if (found === undefined) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (found.status !== "CHALLENGED" || found.availability !== "ACTIVE") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return found;
}

function requireContext(record: P4RepairRecord, contract: P2Contract, parent: P4Target, challenge: P4Challenge): void {
  const context = exact(record.context, CONTEXT_FIELDS);
  if (!Array.isArray(context.messages) || context.messages.length !== 2) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const roles = ["system", "user"] as const;
  for (let index = 0; index < 2; index += 1) {
    const message = exact(context.messages[index], ["role", "content"]);
    if (message.role !== roles[index] || typeof message.content !== "string" || message.content.trim().length === 0) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!detectLoneSurrogates(message.content).ok) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  const serialized = JSON.stringify(context.messages);
  if (context.contextHash !== p4Hash(serialized)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (context.contextBytes !== bytes || bytes > MAX_CONTEXT_BYTES) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const userText = (context.messages[1] as Record<string, unknown>).content as string;
  if (!detectLoneSurrogates(userText).ok) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectDuplicateKeys(userText).ok) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectNonFiniteTokens(userText).ok) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectUnsafeNumbers(userText).ok) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(userText);
  } catch {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const payload = exact(parsed, PAYLOAD_FIELDS);
  const packet = parent.artifact.packet;
  if (packet === null) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const obligations = contract.obligations
    .filter(
      (item) =>
        item.goalId === parent.binding.goalId &&
        item.envelope.scopeId === parent.binding.scopeId,
    )
    .map((item) => ({ obligationId: item.obligationId, kind: item.kind }));
  const expected = {
    schemaVersion: CONTEXT_SCHEMA,
    requestId: "model-3",
    parent: parent.binding,
    parentHash: parent.targetHash,
    problemFullText: contract.problemFullText,
    scope: parent.artifact.scope,
    parentClaim: packet.claim,
    parentDerivation: packet.derivation,
    parentAssumptions: packet.assumptions,
    parentCandidate: packet.candidateProposal,
    routeId: parent.artifact.routeId,
    challenge,
    obligations,
  };
  if (!p4JsonEqual(payload, expected)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
}

function requireLineage(
  lineage: unknown,
  parent: P4Target,
  child: P4Target,
  challenge: P4Challenge,
  changed: readonly P4RepairChangedField[],
): void {
  const source = exact(lineage, LINEAGE_FIELDS);
  const expected: P4RepairLineage = {
    parent: parent.binding,
    parentHash: parent.targetHash,
    child: child.binding,
    childHash: child.targetHash,
    challengeId: challenge.challengeId,
    requestId: "model-3",
    stage: "S2",
    checkResult: "UNKNOWN",
    requiresRecheck: true,
    canReplaceProtected: false,
    changedFields: changed,
  };
  if (!p4JsonEqual(source, expected)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
}

/**
 * Validate the structural material of one S2 post-repair re-review.
 *
 * Rebuilds the parent/child targets from the trusted contract, replays the
 * recorded M4 R2 review snapshot from its own raw text and checks the recorded
 * S2 repair snapshot, its context payload and its lineage against them. The
 * caller is the trusted control side; this is not an authenticator for
 * arbitrary external JSON. Nothing here is a mathematical check.
 */
export function validateP4RecheckInput(
  contract: P2Contract,
  parent: P4Target,
  child: P4Target,
  parentReview: P4ReviewSnapshot,
  repair: P4RepairSnapshot,
): {
  readonly contract: P2Contract;
  readonly parent: P4Target;
  readonly child: P4Target;
  readonly challenge: P4Challenge;
  readonly repair: P4RepairSnapshot;
  readonly repairHash: string;
} {
  try {
    const frozenContract = p2Snapshot(contract);
    const frozenParent = frozenTarget(p2Snapshot(parent));
    const frozenChild = frozenTarget(p2Snapshot(child));
    const rebuiltParent = p4Target(frozenContract, frozenParent.artifact, "ACTIVE");
    if (!p4SameBinding(rebuiltParent.binding, frozenParent.binding) || rebuiltParent.targetHash !== frozenParent.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const rebuiltChild = p4Target(frozenContract, frozenChild.artifact, "ACTIVE");
    if (!p4SameBinding(rebuiltChild.binding, frozenChild.binding) || rebuiltChild.targetHash !== frozenChild.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rebuiltParent.binding.sourceRequestId !== "model-1") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rebuiltChild.binding.sourceRequestId !== "model-3") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rebuiltChild.binding.artifactId !== "repair-1" || rebuiltChild.binding.artifactVersion !== 1) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rebuiltChild.binding.artifactId === rebuiltParent.binding.artifactId) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!sameCommon(rebuiltChild.binding, rebuiltParent.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rebuiltChild.artifact.routeId !== rebuiltParent.artifact.routeId) {
      fail(P2_ERROR_CODES.ROUTE_MISMATCH);
    }
    if (!p4JsonEqual(rebuiltChild.artifact.scope, rebuiltParent.artifact.scope)) {
      fail(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    const parentPacket = rebuiltParent.artifact.packet;
    const childPacket = rebuiltChild.artifact.packet;
    if (parentPacket === null || childPacket === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (parentPacket.candidateProposal === null || childPacket.candidateProposal === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!p4JsonEqual(childPacket.assumptions, parentPacket.assumptions)) {
      fail(P2_ERROR_CODES.PACKET_SCOPE_VIOLATION);
    }
    const changed = changedFieldsOf(rebuiltParent, rebuiltChild);
    const replayed = replayReview(frozenContract, rebuiltParent, p2Snapshot(parentReview));
    const frozenRepair = exact(p2Snapshot(repair), REPAIR_FIELDS);
    if (frozenRepair.availability !== "ACTIVE" || frozenRepair.repairAttempts !== 1) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!p4SameBinding(frozenRepair.parent, rebuiltParent.binding) || frozenRepair.parentHash !== rebuiltParent.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const record = exact(frozenRepair.record, RECORD_FIELDS);
    if (record.requestId !== "model-3" || record.state !== "RETURNED" || record.code !== "PROPOSAL_RECORDED") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (record.transportStatus !== "COMPLETE") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!p4SameBinding(record.parent, rebuiltParent.binding) || record.parentHash !== rebuiltParent.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (record.rawResponseText !== rebuiltChild.artifact.rawResponseText) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const challenge = requireChallenge(replayed, (exact(record.challenge, [
      "challengeId",
      "target",
      "targetHash",
      "issue",
      "requestIds",
      "status",
      "availability",
    ]).challengeId as string));
    if (!p4JsonEqual(record.challenge, challenge)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    requireContext(record as unknown as P4RepairRecord, frozenContract, rebuiltParent, challenge);
    requireLineage(record.lineage, rebuiltParent, rebuiltChild, challenge, changed);
    const frozenRepairSnapshot = frozenRepair as unknown as P4RepairSnapshot;
    return Object.freeze({
      contract: frozenContract,
      parent: rebuiltParent,
      child: rebuiltChild,
      challenge,
      repair: frozenRepairSnapshot,
      repairHash: p4Hash(JSON.stringify(frozenRepairSnapshot)),
    });
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
}
