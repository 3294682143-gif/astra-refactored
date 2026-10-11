/**
 * @astra/math-workunit — P2-A model receipt reader.
 *
 * Reads one raw model receipt against a trusted M1 contract/task snapshot and
 * returns the raw text plus, when the text parses, the strict WorkPacket. The
 * transport status always dominates the model's own delivery self-assessment,
 * and a truncated or errored receipt keeps its raw material with `packet:null`
 * instead of a fabricated complete packet. Nothing here is mathematical
 * acceptance: the result stays PROVISIONAL/UNKNOWN and no artifact is stored.
 */

import {
  P2_ERROR_CODES,
  P2_LIMITS,
  P2_PACKET_DELIVERY,
  P2_TRANSPORT_STATUS,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  parseP2WorkPacketAny,
  type P2AcceptedWorkPacket,
  type P2ArtifactRef,
  type P2Contract,
  type P2PacketDelivery,
  type P2Task,
  type P2TransportStatus,
  type Scope,
} from "@astra/protocol";
import { workHash, workRefKey, workSeq, workShort } from "./p2-context.js";

/** Raw model receipt as handed in by the transport layer. */
export interface P2WorkReceipt {
  readonly artifactId: string;
  readonly routeId: string;
  readonly sourceRequestId: string;
  readonly transportStatus: P2TransportStatus;
  readonly text: string;
  readonly eventSeq: number;
  readonly supersedes: P2ArtifactRef | null;
}

/** Result of reading one receipt; `packet` is null when the text did not parse. */
export interface P2WorkReceiptRead {
  readonly receipt: P2WorkReceipt;
  readonly packet: P2AcceptedWorkPacket | null;
  readonly deliveryStatus: P2PacketDelivery;
  readonly dependencies: readonly P2ArtifactRef[];
}

const RECEIPT_FIELDS = [
  "artifactId",
  "routeId",
  "sourceRequestId",
  "transportStatus",
  "text",
  "eventSeq",
  "supersedes",
] as const;

const MAX_RECEIPT_BYTES = 65536;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Exactly the declared receipt keys, no extra and no missing field. */
function requireReceiptShape(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const keys = Object.keys(input);
  if (keys.length !== RECEIPT_FIELDS.length) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  for (const field of RECEIPT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  return input;
}

function requireTransportStatus(value: unknown): P2TransportStatus {
  if (typeof value !== "string" || !(P2_TRANSPORT_STATUS as readonly string[]).includes(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value as P2TransportStatus;
}

function requireSupersedes(value: unknown): P2ArtifactRef | null {
  if (value === null) {
    return null;
  }
  workRefKey(value as P2ArtifactRef);
  return p2Snapshot(value) as P2ArtifactRef;
}

/** Bounded, duplicate-free trusted input refs of the running task. */
function trustedInputRefs(task: P2Task): readonly P2ArtifactRef[] {
  const refs = task.inputArtifactRefs;
  if (!Array.isArray(refs) || refs.length > P2_LIMITS.maxArtifacts) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const keys = new Set<string>();
  const frozen: P2ArtifactRef[] = [];
  for (const ref of refs) {
    const key = workRefKey(ref);
    if (keys.has(key)) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    keys.add(key);
    frozen.push(p2Snapshot(ref) as P2ArtifactRef);
  }
  return p2Snapshot(frozen) as readonly P2ArtifactRef[];
}

/**
 * Packet dependencies must be a duplicate-free subset of the trusted task
 * input refs. A ref outside that set is `UNKNOWN_DEPENDENCY`; a repeated ref
 * is `DUPLICATE_ID`. Existence and store availability are not checked here.
 */
function packetDependencies(packet: P2AcceptedWorkPacket, trusted: readonly P2ArtifactRef[]): readonly P2ArtifactRef[] {
  const allowed = new Set(trusted.map((ref) => workRefKey(ref)));
  const seen = new Set<string>();
  const collected: P2ArtifactRef[] = [];
  for (const ref of packet.dependencies) {
    const key = workRefKey(ref);
    if (seen.has(key)) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    if (!allowed.has(key)) {
      throw new P2Error(P2_ERROR_CODES.UNKNOWN_DEPENDENCY);
    }
    seen.add(key);
    collected.push(p2Snapshot(ref) as P2ArtifactRef);
  }
  return p2Snapshot(collected) as readonly P2ArtifactRef[];
}

/** Every packet assumption must already be a declared scope assumption. */
function checkAssumptions(packet: P2AcceptedWorkPacket, scope: Scope): void {
  const declared = new Set(scope.localAssumptions);
  for (const assumption of packet.assumptions) {
    if (!declared.has(assumption)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCOPE_VIOLATION);
    }
  }
}

/** Re-check every identity field of a parsed packet against the trusted side. */
function checkPacketBinding(
  packet: P2AcceptedWorkPacket,
  contract: P2Contract,
  task: P2Task,
  scope: Scope,
  routeId: string,
  sourceRequestId: string,
): void {
  const sessionId = workShort(contract.envelope.sessionId);
  const problemHash = workHash(contract.problemFullText);
  const contractVersion = workSeq(contract.contractVersion);
  const taskId = workShort(task.taskId);
  const goalId = workShort(task.goalId);
  const scopeId = workShort(scope.scopeId);

  if (workShort(packet.sessionId) !== sessionId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (workShort(packet.problemHash) !== problemHash) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (workSeq(packet.contractVersion) !== contractVersion) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (workShort(packet.taskId) !== taskId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (workShort(packet.goalId) !== goalId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (workShort(packet.scopeId) !== scopeId) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (workShort(packet.routeId) !== routeId) {
    throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
  }
  if (workShort(packet.sourceRequestId) !== sourceRequestId) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}

/** Transport status dominates the model's own delivery self-assessment. */
function effectiveDelivery(transportStatus: P2TransportStatus, packet: P2AcceptedWorkPacket | null): P2PacketDelivery {
  if (transportStatus === "TRUNCATED") {
    return "TRUNCATED";
  }
  if (transportStatus === "ERROR") {
    return "ERROR";
  }
  if (transportStatus === "UNKNOWN") {
    return "INCOMPLETE";
  }
  if (packet === null) {
    throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
  }
  if (packet.claim.trim().length === 0 || packet.derivation.trim().length === 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
  }
  if (!(P2_PACKET_DELIVERY as readonly string[]).includes(packet.deliveryStatus)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
  }
  return packet.deliveryStatus;
}

/**
 * Read one raw receipt. The input is snapshotted first, so only plain JSON
 * data is accepted. A COMPLETE transport whose text does not parse is a hard
 * rejection; a non-COMPLETE transport keeps the raw text with `packet:null`.
 */
export function readWorkReceipt(
  contract: P2Contract,
  task: P2Task,
  scope: Scope,
  input: P2WorkReceipt,
): P2WorkReceiptRead {
  const raw = requireReceiptShape(p2Snapshot(input));
  const artifactId = workShort(raw.artifactId);
  const routeId = workShort(raw.routeId);
  const sourceRequestId = workShort(raw.sourceRequestId);
  const transportStatus = requireTransportStatus(raw.transportStatus);
  const eventSeq = workSeq(raw.eventSeq);
  if (eventSeq <= workSeq(task.envelope.eventSeq)) {
    throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
  }
  if (typeof raw.text !== "string" || !detectLoneSurrogates(raw.text).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (Buffer.byteLength(raw.text, "utf8") > MAX_RECEIPT_BYTES) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (transportStatus === "COMPLETE" && raw.text.trim().length === 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
  }
  const supersedes = requireSupersedes(raw.supersedes);

  const trusted = trustedInputRefs(task);

  let packet: P2AcceptedWorkPacket | null = null;
  try {
    packet = parseP2WorkPacketAny(raw.text);
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    if (transportStatus === "COMPLETE") {
      throw error;
    }
    packet = null;
  }

  let dependencies: readonly P2ArtifactRef[];
  if (packet === null) {
    dependencies = trusted;
  } else {
    checkPacketBinding(packet, contract, task, scope, routeId, sourceRequestId);
    checkAssumptions(packet, scope);
    dependencies = packetDependencies(packet, trusted);
  }

  const deliveryStatus = effectiveDelivery(transportStatus, packet);

  const receipt = p2Snapshot({
    artifactId,
    routeId,
    sourceRequestId,
    transportStatus,
    text: raw.text,
    eventSeq,
    supersedes,
  }) as P2WorkReceipt;

  return p2Snapshot({
    receipt,
    packet,
    deliveryStatus,
    dependencies,
  }) as P2WorkReceiptRead;
}
