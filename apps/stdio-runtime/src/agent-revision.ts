/**
 * @astra/stdio-runtime — unified AgentLoop artifact-redo admission (pure).
 *
 * One untrusted v4 WorkPacket may carry a REDO_ARTIFACT suggestion. This
 * helper re-checks that suggestion against the trusted ledger/store, derives
 * the target ref, provenance and ticket itself, and schedules one
 * task-specific redo. Nothing here is mathematical verification: a redo is a
 * work reopen, never a refutation, and no artifact is invalidated on
 * admission.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  canonicalScope,
  p2Snapshot,
  p4JsonEqual,
  p4Hash,
  type AgentRevisionProvenance,
  type AgentRevisionRecord,
  type P2Artifact,
  type P2ArtifactRef,
  type P2RouteSpec,
  type P2Task,
  type P2WorkPacketV4,
} from "@astra/protocol";
import type { ContractLedger, P2RedoTicket } from "@astra/math-contract";
import type { P2WorkReceipt, P2WorkunitStore } from "@astra/math-workunit";

const MAX_REMAINING_MS = 5000;
const MIN_REMAINING_MS = 25;
import { AGENT_MAX_MODEL_CALLS } from "@astra/runtime-core";

const MAX_WORK_UNITS = 32;
const MAX_REVIEWS = 1;

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

function boundedInt(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

function sameRef(left: P2ArtifactRef, right: P2ArtifactRef): boolean {
  return left.artifactId === right.artifactId && left.artifactVersion === right.artifactVersion;
}

/**
 * Control-side admission of one artifact redo for a unified AgentLoop run.
 *
 * At most one redo is pending per session. Admission only schedules work: it
 * never invalidates an artifact, never rewrites a version and never touches a
 * candidate. The model supplies no task id, route, scope, version or
 * supersedes field; the control side derives all of those itself.
 */
export class AgentRevisionAdmission {
  private readonly ledger: ContractLedger;
  private readonly store: P2WorkunitStore;
  private readonly routeOfTask: (task: P2Task) => P2RouteSpec;
  private readonly records: AgentRevisionRecord[] = [];
  private pending: AgentRevisionRecord | null = null;
  private ticket: P2RedoTicket | null = null;
  private used = false;

  constructor(
    ledger: ContractLedger,
    store: P2WorkunitStore,
    routeOfTask: (task: P2Task) => P2RouteSpec,
  ) {
    this.ledger = ledger;
    this.store = store;
    this.routeOfTask = routeOfTask;
  }

  /** Whether one redo has already been admitted in this session. */
  hasUsed(): boolean {
    return this.used;
  }

  /** Task id of the pending redo, or null when none is pending. */
  pendingTaskId(): string | null {
    return this.pending === null ? null : this.pending.taskId;
  }

  /** Provenance of the pending redo, or null when none is pending. */
  provenanceFor(taskId: string): AgentRevisionProvenance | null {
    if (this.pending === null || this.pending.taskId !== taskId) {
      return null;
    }
    return p2Snapshot(this.pending.provenance) as AgentRevisionProvenance;
  }

  /**
   * Frozen copy of the real target artifact of the pending redo, or null when
   * none is pending or the target is no longer a real ACTIVE latest entry.
   */
  targetFor(taskId: string): P2Artifact | null {
    if (this.pending === null || this.pending.taskId !== taskId) {
      return null;
    }
    const entry = this.actual(this.pending.provenance.targetArtifactRef);
    if (entry === null) {
      return null;
    }
    return p2Snapshot(entry.artifact) as P2Artifact;
  }

  /** Plain-array snapshot for the private state; no Map escapes. */
  snapshot(): readonly AgentRevisionRecord[] {
    return p2Snapshot(this.records) as readonly AgentRevisionRecord[];
  }

  /**
   * Whether one redo may even be considered. Strict integer bounds only; a
   * model can never widen them. Shared by `admit` and the loop.
   */
  canRedo(
    remainingCalls: number,
    maxReviews: number,
    remainingWorkUnits: number,
    remainingMs: number,
  ): boolean {
    const calls = boundedInt(remainingCalls, AGENT_MAX_MODEL_CALLS);
    const reviews = boundedInt(maxReviews, MAX_REVIEWS);
    const units = boundedInt(remainingWorkUnits, MAX_WORK_UNITS);
    const ms = boundedInt(remainingMs, MAX_REMAINING_MS);
    if (this.used || this.pending !== null) {
      return false;
    }
    if (calls < 1 + reviews) {
      return false;
    }
    if (units < 1) {
      return false;
    }
    return ms > MIN_REMAINING_MS;
  }

  /**
   * Admit one task-specific redo from a real COMPLETE v4 artifact.
   *
   * Every check runs before the first mutation. A rejected proposal returns
   * `false` and leaves the ledger, store, routes and mappings untouched; the
   * already accepted artifact and candidate are preserved. Admission never
   * invalidates an artifact and never makes the target STALE.
   */
  admit(
    artifact: P2Artifact,
    remainingCalls: number,
    maxReviews: number,
    remainingWorkUnits: number,
    remainingMs: number,
  ): boolean {
    if (this.used || this.pending !== null) {
      return false;
    }
    if (!this.canRedo(remainingCalls, maxReviews, remainingWorkUnits, remainingMs)) {
      return false;
    }
    if (!isPlainObject(artifact)) {
      return false;
    }
    const frozen = p2Snapshot(artifact) as P2Artifact;
    if (frozen.transportStatus !== "COMPLETE" || frozen.deliveryStatus !== "COMPLETE") {
      return false;
    }
    const packet = frozen.packet;
    if (
      packet === null ||
      (packet.schemaVersion !== "p2a-work-v4" && packet.schemaVersion !== "p2a-work-v5")
    ) {
      return false;
    }
    const proposal = (packet as P2WorkPacketV4).workflowProposal;
    if (proposal === null || !isPlainObject(proposal)) {
      return false;
    }
    if (proposal.kind !== "REDO_ARTIFACT") {
      return false;
    }
    if (typeof proposal.rationale !== "string" || proposal.rationale.trim().length === 0) {
      return false;
    }

    // The source artifact must be the real ACTIVE latest entry of the store.
    const sourceRef: P2ArtifactRef = {
      artifactId: frozen.artifactId,
      artifactVersion: frozen.envelope.artifactVersion ?? 0,
    };
    const sourceEntry = this.actual(sourceRef);
    if (sourceEntry === null) {
      return false;
    }
    if (JSON.stringify(sourceEntry.artifact) !== JSON.stringify(frozen)) {
      return false;
    }

    const contract = this.ledger.snapshot();
    const sourceTask = contract.tasks.find((task) => task.taskId === frozen.envelope.taskId);
    if (sourceTask === undefined || sourceTask.delivery !== "DELIVERED") {
      return false;
    }
    const sourceObligation = contract.obligations.find(
      (row) => row.obligationId === sourceTask.obligationId,
    );
    if (sourceObligation === undefined) {
      return false;
    }
    if (sourceObligation.status === "BLOCKED" || sourceObligation.status === "SATISFIED") {
      return false;
    }
    if (!packet.pendingObligations.includes(sourceTask.obligationId)) {
      return false;
    }
    const sourceRoute = this.routeOfTask(sourceTask);
    if (sourceRoute.routeId !== frozen.routeId) {
      return false;
    }
    if (!this.store.routesSnapshot().some((route) => route.routeId === sourceRoute.routeId)) {
      return false;
    }

    // A null target asks to redo the work that just delivered this packet; a
    // non-null target must be a real input ref of the current accepted work.
    const declared = proposal.targetArtifactRef;
    let targetRef: P2ArtifactRef;
    if (declared === null) {
      targetRef = sourceRef;
    } else {
      if (!isPlainObject(declared)) {
        return false;
      }
      const candidate: P2ArtifactRef = {
        artifactId: declared.artifactId as string,
        artifactVersion: declared.artifactVersion as number,
      };
      if (!sourceTask.inputArtifactRefs.some((ref) => sameRef(ref, candidate))) {
        return false;
      }
      targetRef = candidate;
    }
    const targetEntry = this.actual(targetRef);
    if (targetEntry === null) {
      return false;
    }
    const target = targetEntry.artifact;
    if (target.transportStatus !== "COMPLETE" || target.packet === null) {
      return false;
    }
    if (target.envelope.sessionId !== contract.envelope.sessionId) {
      return false;
    }
    if (target.envelope.problemHash !== contract.problemHash) {
      return false;
    }
    if (target.envelope.contractVersion !== contract.contractVersion) {
      return false;
    }
    if (target.routeId !== sourceRoute.routeId) {
      return false;
    }
    if (canonicalScope(target.scope) !== canonicalScope(sourceEntry.artifact.scope)) {
      return false;
    }
    const targetTask = contract.tasks.find((task) => task.taskId === target.envelope.taskId);
    if (targetTask === undefined || targetTask.delivery !== "DELIVERED") {
      return false;
    }
    const targetObligation = contract.obligations.find(
      (row) => row.obligationId === targetTask.obligationId,
    );
    if (targetObligation === undefined) {
      return false;
    }
    if (targetObligation.status === "BLOCKED" || targetObligation.status === "SATISFIED") {
      return false;
    }
    if (!packet.pendingObligations.includes(targetTask.obligationId)) {
      return false;
    }
    if (this.routeOfTask(targetTask).routeId !== target.routeId) {
      return false;
    }

    const provenance: AgentRevisionProvenance = p2Snapshot({
      sourceRequestId: frozen.sourceRequestId,
      sourceArtifactRef: sourceRef,
      targetArtifactRef: targetRef,
      targetSourceRequestId: target.sourceRequestId,
      targetHash: p4Hash(target.rawResponseText),
    }) as AgentRevisionProvenance;

    // Pure pre-checks only: the ledger ticket and the exact invalidation
    // closure of the target. Nothing is mutated by either call.
    try {
      this.ledger.validateRedoTicket(targetTask.taskId, targetRef);
      this.store.previewInvalidation(targetRef);
    } catch (error) {
      if (error instanceof P2Error) {
        return false;
      }
      throw error;
    }

    // No asynchronous gap: the ticket below uses the already validated frozen
    // values and cannot fail. No artifact availability is changed here.
    const ticket = this.ledger.prepareRedo(targetTask.taskId, targetRef);
    const record: AgentRevisionRecord = p2Snapshot({
      provenance,
      taskId: targetTask.taskId,
      status: "PENDING",
      newRef: null,
      staleRefs: [],
    }) as AgentRevisionRecord;
    this.ticket = ticket;
    this.pending = record;
    this.records.push(record);
    this.used = true;
    return true;
  }

  /**
   * Abort the pending redo and restore the exact backed-up ledger state. The
   * record is kept with status ABORTED and no new ref; `hasUsed` stays true so
   * no second redo can be admitted in this session.
   */
  abort(): boolean {
    if (this.pending === null || this.ticket === null) {
      return false;
    }
    this.ledger.abortRedo(this.ticket);
    const aborted: AgentRevisionRecord = p2Snapshot({
      provenance: this.pending.provenance,
      taskId: this.pending.taskId,
      status: "ABORTED",
      newRef: null,
      staleRefs: [],
    }) as AgentRevisionRecord;
    this.records[this.records.length - 1] = aborted;
    this.pending = null;
    this.ticket = null;
    return true;
  }

  /**
   * Settle one real redo delivery. Every pure pre-check runs first; a rejected
   * or no-op delivery restores the exact backed-up ledger state and returns
   * null. Only a real, non-no-op replacement commits a new version and the
   * exact stale closure. Nothing here is mathematical verification.
   */
  settle(task: P2Task, input: P2WorkReceipt): P2Artifact | null {
    if (this.pending === null || this.ticket === null) {
      return null;
    }
    const pending = this.pending;
    const ticket = this.ticket;
    if (task.taskId !== pending.taskId) {
      this.abort();
      return null;
    }
    const frozenTask = p2Snapshot(task) as P2Task;
    const frozenInput = p2Snapshot(input) as P2WorkReceipt;
    const targetRef = pending.provenance.targetArtifactRef;
    if (frozenInput.artifactId !== targetRef.artifactId) {
      this.abort();
      return null;
    }
    if (frozenInput.supersedes === null || !sameRef(frozenInput.supersedes, targetRef)) {
      this.abort();
      return null;
    }
    if (frozenInput.eventSeq !== this.ledger.nextEventSeq()) {
      this.abort();
      return null;
    }
    if (frozenInput.sourceRequestId === pending.provenance.targetSourceRequestId) {
      this.abort();
      return null;
    }
    if (frozenInput.transportStatus !== "COMPLETE") {
      this.abort();
      return null;
    }
    const targetEntry = this.actual(targetRef);
    if (targetEntry === null) {
      this.abort();
      return null;
    }
    const oldTarget = targetEntry.artifact;
    if (oldTarget.envelope.taskId !== frozenTask.taskId) {
      this.abort();
      return null;
    }
    if (oldTarget.routeId !== this.routeOfTask(frozenTask).routeId) {
      this.abort();
      return null;
    }

    let prepared: P2Artifact;
    try {
      prepared = this.store.validateReplacement(frozenTask, frozenInput, oldTarget);
    } catch (error) {
      if (error instanceof P2Error) {
        this.abort();
        return null;
      }
      throw error;
    }
    if (prepared.deliveryStatus !== "COMPLETE" || prepared.packet === null) {
      this.abort();
      return null;
    }
    if (oldTarget.packet === null) {
      this.abort();
      return null;
    }
    if (this.isNoOp(oldTarget, prepared)) {
      this.abort();
      return null;
    }

    const closure = this.store.previewInvalidation(targetRef);
    const newRef: P2ArtifactRef = {
      artifactId: prepared.artifactId,
      artifactVersion: prepared.envelope.artifactVersion as number,
    };
    try {
      this.ledger.validateRedoDelivery(ticket, newRef, closure, frozenInput.eventSeq);
    } catch (error) {
      if (error instanceof P2Error) {
        this.abort();
        return null;
      }
      throw error;
    }

    const accepted = this.store.accept(frozenTask, frozenInput);
    this.ledger.commitRedoDelivery(ticket, newRef, closure, frozenInput.eventSeq);
    const committed: AgentRevisionRecord = p2Snapshot({
      provenance: pending.provenance,
      taskId: pending.taskId,
      status: "COMMITTED",
      newRef,
      staleRefs: closure,
    }) as AgentRevisionRecord;
    this.records[this.records.length - 1] = committed;
    this.pending = null;
    this.ticket = null;
    return p2Snapshot(accepted) as P2Artifact;
  }

  /**
   * Material comparison of the old and new packet. Only the mathematical
   * material is compared; control metadata (schema version, source request id,
   * workflow proposal, pending obligations, suggested checks) is ignored. This
   * is a data comparison, never a claim of mathematical equivalence.
   */
  private isNoOp(oldTarget: P2Artifact, prepared: P2Artifact): boolean {
    const oldPacket = oldTarget.packet;
    const newPacket = prepared.packet;
    if (oldPacket === null || newPacket === null) {
      return false;
    }
    const material = (packet: {
      readonly claim: string;
      readonly derivation: string;
      readonly assumptions: readonly string[];
      readonly dependencies: readonly P2ArtifactRef[];
      readonly candidateProposal: string | null;
    }): readonly unknown[] => [
        packet.claim,
        packet.derivation,
        packet.assumptions,
        packet.dependencies,
        packet.candidateProposal,
      ];
    return p4JsonEqual(material(oldPacket), material(newPacket));
  }

  /**
   * The real ACTIVE latest entry of one ref, or null when the ref is unknown,
   * not ACTIVE or not the latest version of its artifactId. A forged version
   * can never resolve to an entry.
   */
  private actual(ref: P2ArtifactRef): { readonly artifact: P2Artifact } | null {
    let entry;
    try {
      entry = this.store.get(ref);
    } catch (error) {
      if (error instanceof P2Error) {
        return null;
      }
      throw error;
    }
    if (entry.availability !== "ACTIVE") {
      return null;
    }
    const artifact = entry.artifact;
    if (artifact.artifactId !== ref.artifactId) {
      return null;
    }
    if (artifact.envelope.artifactVersion !== ref.artifactVersion) {
      return null;
    }
    if (
      this.store
        .snapshot()
        .some(
          (row) =>
            row.artifact.artifactId === ref.artifactId &&
            (row.artifact.envelope.artifactVersion ?? 0) > ref.artifactVersion,
        )
    ) {
      return null;
    }
    return { artifact };
  }
}
