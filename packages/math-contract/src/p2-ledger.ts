/**
 * @astra/math-contract — P2-A M1 contract ledger.
 *
 * Append-only event log plus a frozen current projection. Every mutation
 * validates its full argument set, the task graph and the event budget before
 * any map is touched, so a rejected call leaves no partial state. Delivery
 * completion is never mathematical satisfaction: only a trusted M5 mock
 * receipt can move an obligation to SATISFIED.
 */

import {
  P2_LIMITS,
  P2Error,
  P2_ERROR_CODES,
  P2_TASK_DELIVERY,
  P2_TASK_PROGRESS_EVENT_SCHEMA_VERSION,
  P2_TASK_YIELD_REASON,
  p2Snapshot,
  validateP2GoalSpecs,
  type P2AcceptanceReceipt,
  type P2ArtifactRef,
  type P2Contract,
  type P2Event,
  type P2EventType,
  type P2GoalSpec,
  type P2Obligation,
  type P2Task,
  type P2TaskDelivery,
  type P2TaskYieldReason,
} from "@astra/protocol";

import { compileP2Contract, p2ProblemHashOf, p2ScopeIdOf } from "./p2-compiler.js";
import { detectLoneSurrogates } from "@astra/protocol";

export const P2_LEDGER_VERSION = "0.0.0-p2a" as const;

/** Delivery statuses a caller may record; packet COMPLETE is not one of them. */
export const P2_RECORDABLE_DELIVERY = ["DELIVERED", "PARTIAL", "BLOCKED"] as const;
export type P2RecordableDelivery = (typeof P2_RECORDABLE_DELIVERY)[number];

export interface P2RevisionDelta {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changedGoalIds: readonly string[];
  readonly affectedTaskIds: readonly string[];
  readonly preservedTaskIds: readonly string[];
  readonly removedTaskIds: readonly string[];
}

/**
 * Control-side ticket of one task-specific redo scheduling. It is a private
 * bookkeeping handle, never a mathematical claim: it only records that one
 * delivered task was put back to READY so its work can be redone. The state
 * backup stays inside the ledger and cannot be injected by a caller.
 */
export interface P2RedoTicket {
  readonly sessionId: string;
  readonly problemHash: string;
  readonly contractVersion: number;
  readonly taskId: string;
  readonly targetRef: P2ArtifactRef;
  readonly preparedEventSeq: number;
}

interface TaskState {
  readonly task: P2Task;
  readonly delivery: P2TaskDelivery;
  readonly deliveredRefs: readonly P2ArtifactRef[];
}

interface ObligationState {
  readonly obligation: P2Obligation;
  readonly status: P2Obligation["status"];
  readonly acceptance: P2AcceptanceReceipt | null;
}

interface RedoBackup {
  readonly ticket: P2RedoTicket;
  readonly task: TaskState;
  readonly obligation: ObligationState;
}

/**
 * Fully pre-validated commit plan of one redo delivery. It is built by the
 * shared pure helper and applied by `commitRedoDelivery` without any further
 * check, so a rejected pre-check can never leave partial state.
 */
interface RedoCommitPlan {
  readonly ticket: P2RedoTicket;
  readonly newRef: P2ArtifactRef;
  readonly staleRefs: readonly P2ArtifactRef[];
  readonly eventSeq: number;
  readonly events: readonly P2Event[];
  readonly affectedTaskIds: readonly string[];
  readonly affectedObligationIds: readonly string[];
  readonly reopenedObligationIds: readonly string[];
}

function refKey(ref: P2ArtifactRef): string {
  return `${ref.artifactId}@${ref.artifactVersion}`;
}

function sameRef(left: P2ArtifactRef, right: P2ArtifactRef): boolean {
  return left.artifactId === right.artifactId && left.artifactVersion === right.artifactVersion;
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= maxChars &&
    detectLoneSurrogates(value).ok
  );
}

function isBoundedStringList(value: unknown, maxChars: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= P2_LIMITS.maxArrayItems &&
    value.every((item) => isBoundedString(item, maxChars))
  );
}

function isArtifactRef(value: unknown): value is P2ArtifactRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== 2) {
    return false;
  }
  return (
    isBoundedString(source.artifactId, P2_LIMITS.maxShortStringChars) &&
    Number.isSafeInteger(source.artifactVersion) &&
    (source.artifactVersion as number) >= 1
  );
}

/** A real earlier WORK request ordinal; no other request id is accepted. */
const YIELD_REQUEST_ORDINAL = /^model-([1-9][0-9]{0,2})$/u;

/**
 * Validate one task batch against the contract and against itself: envelope
 * binding, obligation/goal/scope agreement, duplicate ids, dangling
 * dependencies and cycles. Returns the batch in input order.
 */
export function validateGraph(
  contract: P2Contract,
  tasks: readonly P2Task[],
): readonly P2Task[] {
  if (!Array.isArray(tasks) || tasks.length > P2_LIMITS.maxTasks) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const obligations = new Map(contract.obligations.map((item) => [item.obligationId, item]));
  const goals = new Map<string, P2GoalSpec>();
  const collect = (goal: P2GoalSpec): void => {
    goals.set(goal.goalId, goal);
    for (const child of goal.subgoals) {
      collect(child);
    }
  };
  for (const goal of contract.goals) {
    collect(goal);
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (typeof task !== "object" || task === null || Array.isArray(task)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (!isBoundedString(task.taskId, P2_LIMITS.maxShortStringChars)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (seen.has(task.taskId)) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    seen.add(task.taskId);
    const envelope = task.envelope;
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (
      !isBoundedString(envelope.recordId, P2_LIMITS.maxStringChars) ||
      !Number.isSafeInteger(envelope.eventSeq) ||
      envelope.eventSeq < 1
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (envelope.taskId !== task.taskId || envelope.scopeId !== task.scopeId) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      envelope.sessionId !== contract.envelope.sessionId ||
      envelope.problemHash !== contract.problemHash ||
      envelope.contractVersion !== contract.contractVersion ||
      envelope.sourceModule !== "M1"
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!(P2_TASK_DELIVERY as readonly string[]).includes(task.delivery)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
    }
    const obligation = obligations.get(task.obligationId);
    if (obligation === undefined) {
      throw new P2Error(P2_ERROR_CODES.DANGLING_REFERENCE);
    }
    if (obligation.goalId !== task.goalId) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    const goal = goals.get(task.goalId);
    if (goal === undefined) {
      throw new P2Error(P2_ERROR_CODES.DANGLING_REFERENCE);
    }
    if (task.scopeId !== goal.scope.scopeId || obligation.envelope.scopeId !== task.scopeId) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    if (!isBoundedStringList(task.dependencyTaskIds, P2_LIMITS.maxShortStringChars)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (new Set(task.dependencyTaskIds).size !== task.dependencyTaskIds.length) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    if (
      !Array.isArray(task.inputArtifactRefs) ||
      task.inputArtifactRefs.length > P2_LIMITS.maxArrayItems ||
      !task.inputArtifactRefs.every(isArtifactRef)
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
  }
  for (const task of tasks) {
    for (const dependency of task.dependencyTaskIds) {
      if (!seen.has(dependency)) {
        throw new P2Error(P2_ERROR_CODES.DANGLING_REFERENCE);
      }
      if (dependency === task.taskId) {
        throw new P2Error(P2_ERROR_CODES.DEPENDENCY_CYCLE);
      }
    }
  }
  const state = new Map<string, number>();
  const visit = (taskId: string): void => {
    const mark = state.get(taskId) ?? 0;
    if (mark === 1) {
      throw new P2Error(P2_ERROR_CODES.DEPENDENCY_CYCLE);
    }
    if (mark === 2) {
      return;
    }
    state.set(taskId, 1);
    const task = tasks.find((item) => item.taskId === taskId);
    for (const dependency of task?.dependencyTaskIds ?? []) {
      visit(dependency);
    }
    state.set(taskId, 2);
  };
  for (const task of tasks) {
    visit(task.taskId);
  }
  return tasks;
}

export class ContractLedger {
  private readonly sessionId: string;
  private readonly problemHash: string;
  private contract: P2Contract;
  private readonly events: P2Event[] = [];
  private readonly tasks = new Map<string, TaskState>();
  private readonly obligations = new Map<string, ObligationState>();
  private readonly redoBackups = new Map<string, RedoBackup>();
  private nextSeq: number;

  constructor(contract: P2Contract) {
    const frozen = p2Snapshot(contract);
    if (typeof frozen !== "object" || frozen === null || Array.isArray(frozen)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const envelope = frozen.envelope;
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (
      !Array.isArray(frozen.goals) ||
      !Array.isArray(frozen.obligations) ||
      !Array.isArray(frozen.tasks) ||
      frozen.goals.length > P2_LIMITS.maxGoals ||
      frozen.obligations.length > P2_LIMITS.maxObligations ||
      frozen.tasks.length > P2_LIMITS.maxTasks
    ) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (frozen.semanticStatus !== "UNKNOWN") {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (envelope.sourceModule !== "M1") {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      !Number.isSafeInteger(envelope.contractVersion) ||
      envelope.contractVersion < 1 ||
      !Number.isSafeInteger(frozen.contractVersion) ||
      frozen.contractVersion < 1 ||
      envelope.contractVersion !== frozen.contractVersion
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      !isBoundedString(envelope.sessionId, P2_LIMITS.maxShortStringChars) ||
      !isBoundedString(envelope.problemHash, P2_LIMITS.maxStringChars) ||
      envelope.problemHash !== frozen.problemHash
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      !isBoundedString(frozen.problemFullText, P2_LIMITS.maxProblemChars) ||
      p2ProblemHashOf(frozen.problemFullText) !== frozen.problemHash
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      !Number.isSafeInteger(envelope.eventSeq) ||
      envelope.eventSeq < 1 ||
      envelope.eventSeq >= Number.MAX_SAFE_INTEGER
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const specs = validateP2GoalSpecs(frozen.goals);
    const checkScopes = (goal: P2GoalSpec): void => {
      if (goal.scope.scopeId !== p2ScopeIdOf(goal.scope)) {
        throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
      }
      for (const child of goal.subgoals) {
        checkScopes(child);
      }
    };
    for (const goal of specs) {
      checkScopes(goal);
    }
    const seenObligations = new Set<string>();
    for (const obligation of frozen.obligations) {
      if (
        typeof obligation !== "object" ||
        obligation === null ||
        Array.isArray(obligation) ||
        !isBoundedString(obligation.obligationId, P2_LIMITS.maxShortStringChars)
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      if (seenObligations.has(obligation.obligationId)) {
        throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
      }
      seenObligations.add(obligation.obligationId);
      if (obligation.status !== "OPEN" || obligation.acceptance !== null) {
        throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
      }
      const obligationEnvelope = obligation.envelope;
      if (
        typeof obligationEnvelope !== "object" ||
        obligationEnvelope === null ||
        Array.isArray(obligationEnvelope) ||
        obligationEnvelope.sessionId !== envelope.sessionId ||
        obligationEnvelope.problemHash !== envelope.problemHash ||
        obligationEnvelope.contractVersion !== envelope.contractVersion ||
        obligationEnvelope.sourceModule !== "M1"
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    for (const task of frozen.tasks) {
      if (
        typeof task !== "object" ||
        task === null ||
        Array.isArray(task) ||
        !isBoundedString(task.taskId, P2_LIMITS.maxShortStringChars)
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      if (
        task.delivery !== "READY" ||
        !Array.isArray(task.inputArtifactRefs) ||
        task.inputArtifactRefs.length !== 0
      ) {
        throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
      }
      const taskEnvelope = task.envelope;
      if (
        typeof taskEnvelope !== "object" ||
        taskEnvelope === null ||
        Array.isArray(taskEnvelope) ||
        taskEnvelope.sessionId !== envelope.sessionId ||
        taskEnvelope.problemHash !== envelope.problemHash ||
        taskEnvelope.contractVersion !== envelope.contractVersion ||
        taskEnvelope.sourceModule !== "M1"
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    validateGraph(frozen, frozen.tasks);
    this.sessionId = envelope.sessionId;
    this.problemHash = frozen.problemHash;
    this.contract = frozen;
    this.nextSeq = envelope.eventSeq;
    for (const obligation of frozen.obligations) {
      this.obligations.set(obligation.obligationId, {
        obligation,
        status: obligation.status,
        acceptance: null,
      });
    }
    for (const task of frozen.tasks) {
      this.tasks.set(task.taskId, { task, delivery: task.delivery, deliveredRefs: [] });
    }
    this.append("CONTRACT_COMPILED", "M1", envelope.eventSeq, {});
  }

  /** Next free event sequence; fixture composition binds M3 artifacts to it. */
  nextEventSeq(): number {
    return this.nextSeq;
  }

  snapshot(): P2Contract {
    return p2Snapshot({
      ...this.contract,
      obligations: [...this.obligations.values()].map((state) => ({
        ...state.obligation,
        status: state.status,
        acceptance: state.acceptance,
      })),
      tasks: [...this.tasks.values()].map((state) => ({
        ...state.task,
        delivery: state.delivery,
        inputArtifactRefs: state.task.inputArtifactRefs,
      })),
    });
  }

  eventsSnapshot(): readonly P2Event[] {
    return p2Snapshot(this.events);
  }

  private append(
    eventType: P2EventType,
    sourceModule: P2Event["sourceModule"],
    eventSeq: number,
    extra: Partial<P2Event>,
  ): void {
    if (this.events.length >= P2_LIMITS.maxLedgerEvents) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (
      !Number.isSafeInteger(eventSeq) ||
      eventSeq < 1 ||
      eventSeq >= Number.MAX_SAFE_INTEGER ||
      eventSeq !== this.nextSeq
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    this.events.push(p2Snapshot({
      eventId: `${this.sessionId}:event:${eventSeq}`,
      sessionId: this.sessionId,
      eventSeq,
      eventType,
      sourceModule,
      contractVersion: this.contract.contractVersion,
      ...extra,
    }));
    this.nextSeq = eventSeq + 1;
  }

  private requireTask(taskId: string): TaskState {
    const state = this.tasks.get(taskId);
    if (state === undefined) {
      throw new P2Error(P2_ERROR_CODES.DANGLING_REFERENCE);
    }
    return state;
  }

  private requireObligation(obligationId: string): ObligationState {
    const state = this.obligations.get(obligationId);
    if (state === undefined) {
      throw new P2Error(P2_ERROR_CODES.DANGLING_REFERENCE);
    }
    return state;
  }

  /**
   * Tasks whose dependencies are all DELIVERED, with the real recorded refs of
   * those dependencies collected as `inputArtifactRefs`. A blocked obligation
   * never appears here.
   */
  readyTasks(): readonly P2Task[] {
    const ready: { readonly task: P2Task; readonly refs: readonly P2ArtifactRef[] }[] = [];
    for (const state of this.tasks.values()) {
      if (state.delivery !== "READY" && state.delivery !== "PARTIAL") {
        continue;
      }
      const obligation = this.requireObligation(state.task.obligationId);
      if (obligation.status === "BLOCKED" || obligation.status === "SATISFIED") {
        continue;
      }
      const refs: P2ArtifactRef[] = [];
      let blocked = false;
      for (const dependency of state.task.dependencyTaskIds) {
        const upstream = this.tasks.get(dependency);
        if (upstream === undefined || upstream.delivery !== "DELIVERED") {
          blocked = true;
          break;
        }
        refs.push(...upstream.deliveredRefs);
      }
      if (blocked) {
        continue;
      }
      ready.push({ task: state.task, refs });
    }
    const rank = (task: P2Task): number => {
      const obligation = this.requireObligation(task.obligationId);
      if (obligation.obligation.kind === "CANDIDATE_VALIDITY") {
        return 0;
      }
      if (obligation.obligation.kind === "BOUNDARY_EXCEPTIONS") {
        return 1;
      }
      return 2;
    };
    const ordered = [...ready].sort((left, right) => {
      const byRank = rank(left.task) - rank(right.task);
      if (byRank !== 0) {
        return byRank;
      }
      return left.task.taskId < right.task.taskId ? -1 : left.task.taskId > right.task.taskId ? 1 : 0;
    });
    return p2Snapshot(
      ordered.map((entry) => ({
        ...entry.task,
        delivery: this.requireTask(entry.task.taskId).delivery,
        inputArtifactRefs: entry.refs,
      })),
    );
  }

  /** Move one ready task to RUNNING and return the prepared task. */
  startTask(taskId: string): P2Task {
    const prepared = this.readyTasks().find((task) => task.taskId === taskId);
    if (prepared === undefined) {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const state = this.requireTask(taskId);
    const obligation = this.requireObligation(state.task.obligationId);
    if (
      obligation.status !== "OPEN" &&
      obligation.status !== "REOPENED" &&
      obligation.status !== "IN_PROGRESS"
    ) {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const seq = this.nextSeq;
    const running = p2Snapshot({ ...prepared, delivery: "RUNNING" as P2TaskDelivery });
    const nextObligation: ObligationState = {
      obligation: obligation.obligation,
      status:
        obligation.status === "OPEN" || obligation.status === "REOPENED"
          ? "IN_PROGRESS"
          : obligation.status,
      acceptance: obligation.acceptance,
    };
    this.append("TASK_STARTED", "M1", seq, { taskId, obligationId: state.task.obligationId });
    this.tasks.set(taskId, {
      task: { ...state.task, inputArtifactRefs: running.inputArtifactRefs },
      delivery: "RUNNING",
      deliveredRefs: state.deliveredRefs,
    });
    this.obligations.set(state.task.obligationId, nextObligation);
    return running;
  }

  /**
   * Record a delivery. `DELIVERED` only marks the task delivered; it never
   * satisfies the obligation. `PARTIAL` keeps the task requestable and keeps
   * the same step budget. A later full delivery replaces the partial refs.
   */
  recordDelivery(
    taskId: string,
    artifactRef: P2ArtifactRef,
    status: P2RecordableDelivery,
    eventSeq: number,
  ): void {
    if (!(P2_RECORDABLE_DELIVERY as readonly string[]).includes(status)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
    }
    if (!isArtifactRef(artifactRef)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const state = this.requireTask(taskId);
    if (state.delivery !== "RUNNING") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (
      !Number.isSafeInteger(eventSeq) ||
      eventSeq < 1 ||
      eventSeq >= Number.MAX_SAFE_INTEGER ||
      eventSeq !== this.nextSeq
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const refs = status === "DELIVERED" ? [p2Snapshot(artifactRef)] : [];
    const delivery: P2TaskDelivery = status;
    this.append("DELIVERY_RECORDED", "M3", eventSeq, {
      taskId,
      obligationId: state.task.obligationId,
      artifactId: artifactRef.artifactId,
      artifactVersion: artifactRef.artifactVersion,
    });
    this.tasks.set(taskId, { ...state, delivery, deliveredRefs: refs });
  }

  /**
   * B1c (DECISION-0150): record the local M1 update of one already-delivered
   * task after an evidence-gated S2 revision. Only this task's current delivery
   * is repointed at the revised child artifact; every obligation and every other
   * task keeps its prior state. A truthful structural transition (the M1 ledger
   * "syncs" the affected obligation's local update), never acceptance and never
   * a new obligation state.
   */
  recordLocalRevision(taskId: string, artifactRef: P2ArtifactRef, eventSeq: number): void {
    const state = this.requireTask(taskId);
    if (state.delivery !== "DELIVERED" && state.delivery !== "PARTIAL") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (!isArtifactRef(artifactRef)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (
      !Number.isSafeInteger(eventSeq) ||
      eventSeq < 1 ||
      eventSeq >= Number.MAX_SAFE_INTEGER ||
      eventSeq !== this.nextSeq
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    this.append("ARTIFACT_ACCEPTED", "M1", eventSeq, {
      taskId,
      obligationId: state.task.obligationId,
      artifactId: artifactRef.artifactId,
      artifactVersion: artifactRef.artifactVersion,
    });
    this.tasks.set(taskId, {
      ...state,
      delivery: "DELIVERED",
      deliveredRefs: [p2Snapshot(artifactRef)],
    });
  }

  /**
   * The only path to SATISFIED. The receipt must be a trusted M5 mock receipt
   * bound to this session, problem, version, goal and scope, and every
   * evidence ref must be a real latest ref of a currently DELIVERED task.
   */
  acceptObligation(obligationId: string, receipt: P2AcceptanceReceipt): void {
    const state = this.requireObligation(obligationId);
    if (state.status !== "IN_PROGRESS") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
      throw new P2Error(P2_ERROR_CODES.UNTRUSTED_ACCEPTANCE);
    }
    const receiptKeys = Object.keys(receipt);
    if (
      receiptKeys.length !== 9 ||
      !receiptKeys.every((key) =>
        (
          [
            "mode",
            "sourceModule",
            "sessionId",
            "problemHash",
            "contractVersion",
            "goalId",
            "scopeId",
            "policy",
            "evidenceRefs",
          ] as readonly string[]
        ).includes(key),
      )
    ) {
      throw new P2Error(P2_ERROR_CODES.UNTRUSTED_ACCEPTANCE);
    }
    if (
      receipt.mode !== "MOCK_ONLY" ||
      receipt.sourceModule !== "M5" ||
      receipt.sessionId !== this.sessionId ||
      receipt.problemHash !== this.problemHash ||
      receipt.contractVersion !== this.contract.contractVersion ||
      receipt.goalId !== state.obligation.goalId ||
      receipt.scopeId !== state.obligation.envelope.scopeId
    ) {
      throw new P2Error(P2_ERROR_CODES.UNTRUSTED_ACCEPTANCE);
    }
    if (!isBoundedString(receipt.policy, P2_LIMITS.maxShortStringChars)) {
      throw new P2Error(P2_ERROR_CODES.UNTRUSTED_ACCEPTANCE);
    }
    if (
      !isBoundedStringList(receipt.evidenceRefs, P2_LIMITS.maxShortStringChars + 17) ||
      receipt.evidenceRefs.length < 1
    ) {
      throw new P2Error(P2_ERROR_CODES.UNTRUSTED_ACCEPTANCE);
    }
    const allowed = new Set<string>();
    for (const task of this.tasks.values()) {
      if (task.delivery !== "DELIVERED" || task.task.obligationId !== obligationId) {
        continue;
      }
      for (const ref of task.deliveredRefs) {
        allowed.add(refKey(ref));
      }
    }
    if (allowed.size === 0) {
      throw new P2Error(P2_ERROR_CODES.UNTRUSTED_ACCEPTANCE);
    }
    for (const evidence of receipt.evidenceRefs) {
      if (!allowed.has(evidence)) {
        throw new P2Error(P2_ERROR_CODES.UNTRUSTED_ACCEPTANCE);
      }
    }
    const frozenReceipt = p2Snapshot(receipt);
    const seq = this.nextSeq;
    this.append("OBLIGATION_SATISFIED", "M5", seq, { obligationId });
    this.obligations.set(obligationId, {
      obligation: state.obligation,
      status: "SATISFIED",
      acceptance: frozenReceipt,
    });
  }

  /** Block an obligation and every task that carries it. */
  blockObligation(obligationId: string): void {
    const state = this.requireObligation(obligationId);
    if (state.status === "SATISFIED" || state.status === "BLOCKED") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const seq = this.nextSeq;
    this.append("OBLIGATION_BLOCKED", "M1", seq, { obligationId });
    this.obligations.set(obligationId, {
      obligation: state.obligation,
      status: "BLOCKED",
      acceptance: state.acceptance,
    });
    for (const [taskId, task] of this.tasks) {
      if (task.task.obligationId === obligationId) {
        this.tasks.set(taskId, { ...task, delivery: "BLOCKED" });
      }
    }
  }

  /**
   * Pure pre-check of one task-specific yield. Nothing is mutated: the task
   * must be RUNNING or PARTIAL, its obligation must not be SATISFIED or
   * BLOCKED, no redo may be pending, the task must hold no delivered ref, the
   * reason must be one fixed value, the source request must be a real earlier
   * WORK ordinal, and the event budget must allow one more record. This is a
   * scheduling check, never a mathematical refutation or satisfaction.
   */
  validateYieldTask(
    taskId: string,
    sourceRequestId: string,
    reason: P2TaskYieldReason,
  ): void {
    if (!isBoundedString(taskId, P2_LIMITS.maxShortStringChars)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (
      typeof sourceRequestId !== "string" ||
      YIELD_REQUEST_ORDINAL.exec(sourceRequestId) === null
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!(P2_TASK_YIELD_REASON as readonly string[]).includes(reason)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const state = this.requireTask(taskId);
    if (state.delivery !== "RUNNING" && state.delivery !== "PARTIAL") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (state.deliveredRefs.length !== 0) {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const obligation = this.requireObligation(state.task.obligationId);
    if (obligation.status === "SATISFIED" || obligation.status === "BLOCKED") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.redoBackups.size !== 0) {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const seq = this.nextSeq;
    if (
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      seq >= Number.MAX_SAFE_INTEGER ||
      this.events.length + 1 > P2_LIMITS.maxLedgerEvents
    ) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
  }

  /**
   * Yield one task for this session. After the full pure pre-check one
   * TASK_YIELDED record is appended and only this task moves to BLOCKED with
   * no delivered refs; its immutable definition, its dependencies, every other
   * task and every obligation state stay untouched. No obligation is blocked,
   * no acceptance is cleared and nothing here is a mathematical refutation.
   */
  yieldTask(
    taskId: string,
    sourceRequestId: string,
    reason: P2TaskYieldReason,
  ): void {
    this.validateYieldTask(taskId, sourceRequestId, reason);
    const state = this.requireTask(taskId);
    const seq = this.nextSeq;
    this.append("TASK_YIELDED", "M1", seq, {
      taskId,
      obligationId: state.task.obligationId,
      sourceRequestId,
      yieldReason: reason,
      eventSchemaVersion: P2_TASK_PROGRESS_EVENT_SCHEMA_VERSION,
    });
    this.tasks.set(taskId, {
      task: state.task,
      delivery: "BLOCKED",
      deliveredRefs: [],
    });
  }

  /** Reopen an obligation: old acceptance is cleared, event history is kept. */
  reopenObligation(obligationId: string): void {
    const state = this.requireObligation(obligationId);
    if (state.status === "OPEN" || state.status === "REOPENED") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const seq = this.nextSeq;
    this.append("OBLIGATION_REOPENED", "M1", seq, { obligationId });
    this.obligations.set(obligationId, {
      obligation: state.obligation,
      status: "REOPENED",
      acceptance: null,
    });
    for (const [taskId, task] of this.tasks) {
      if (task.task.obligationId === obligationId) {
        this.tasks.set(taskId, { ...task, delivery: "READY", deliveredRefs: [] });
      }
    }
  }

  /**
   * Pure pre-check of one task-specific redo scheduling. Nothing is mutated:
   * the task must be DELIVERED with exactly the requested ref as its only
   * delivered ref, its obligation must not be SATISFIED or BLOCKED, no redo
   * may already be pending for it, and the event budget must allow one more
   * record. This is a work-reopen check, never a mathematical refutation.
   */
  validateRedoTicket(taskId: string, targetRef: P2ArtifactRef): void {
    if (!isBoundedString(taskId, P2_LIMITS.maxShortStringChars)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (!isArtifactRef(targetRef)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const state = this.requireTask(taskId);
    if (state.delivery !== "DELIVERED") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const only = state.deliveredRefs[0];
    if (state.deliveredRefs.length !== 1 || only === undefined || !sameRef(only, targetRef)) {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const obligation = this.requireObligation(state.task.obligationId);
    if (obligation.status === "SATISFIED" || obligation.status === "BLOCKED") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.redoBackups.size !== 0) {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const seq = this.nextSeq;
    if (
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      seq >= Number.MAX_SAFE_INTEGER ||
      this.events.length + 1 > P2_LIMITS.maxLedgerEvents
    ) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
  }

  /**
   * Schedule one task-specific redo. After the full pure pre-check the current
   * task and obligation state are backed up privately, one
   * OBLIGATION_REOPENED record is appended to explain the work reopen, and only
   * this task moves back to READY while keeping its immutable definition and
   * its previous delivered refs. No other task, no artifact and no obligation
   * acceptance is touched, and nothing here is a mathematical refutation.
   */
  prepareRedo(taskId: string, targetRef: P2ArtifactRef): P2RedoTicket {
    const frozenRef = p2Snapshot(targetRef) as P2ArtifactRef;
    this.validateRedoTicket(taskId, frozenRef);
    const state = this.requireTask(taskId);
    const obligation = this.requireObligation(state.task.obligationId);
    const seq = this.nextSeq;
    const ticket = p2Snapshot({
      sessionId: this.sessionId,
      problemHash: this.problemHash,
      contractVersion: this.contract.contractVersion,
      taskId,
      targetRef: frozenRef,
      preparedEventSeq: seq,
    }) as P2RedoTicket;
    const backup = p2Snapshot({
      ticket,
      task: state,
      obligation,
    }) as RedoBackup;
    this.append("OBLIGATION_REOPENED", "M1", seq, {
      taskId,
      obligationId: state.task.obligationId,
      artifactId: frozenRef.artifactId,
      artifactVersion: frozenRef.artifactVersion,
    });
    this.redoBackups.set(taskId, backup);
    this.tasks.set(taskId, {
      task: state.task,
      delivery: "READY",
      deliveredRefs: state.deliveredRefs,
    });
    this.obligations.set(state.task.obligationId, {
      obligation: obligation.obligation,
      status: "REOPENED",
      acceptance: obligation.acceptance,
    });
    return ticket;
  }

  /**
   * Abort one pending redo and restore the exact backed-up task and obligation
   * state. The ticket must be the recorded one and the task must still be
   * READY or RUNNING; the sequence never moves backwards and no new artifact
   * ref is invented. The prepare record stays in the event history.
   */
  abortRedo(ticket: P2RedoTicket): void {
    const frozen = p2Snapshot(ticket) as P2RedoTicket;
    if (typeof frozen !== "object" || frozen === null || Array.isArray(frozen)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const taskId = frozen.taskId;
    if (!isBoundedString(taskId, P2_LIMITS.maxShortStringChars)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const backup = this.redoBackups.get(taskId);
    if (backup === undefined) {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (
      frozen.sessionId !== this.sessionId ||
      frozen.problemHash !== this.problemHash ||
      frozen.contractVersion !== this.contract.contractVersion ||
      JSON.stringify(backup.ticket) !== JSON.stringify(frozen)
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const state = this.requireTask(taskId);
    if (state.delivery !== "READY" && state.delivery !== "RUNNING") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    this.tasks.set(taskId, backup.task);
    this.obligations.set(backup.task.task.obligationId, backup.obligation);
    this.redoBackups.delete(taskId);
  }

  /**
   * Pure pre-check of one redo delivery. Nothing is mutated: the pending
   * backup ticket must match this session/hash/version and the exact recorded
   * sequence, the target task must be RUNNING, the new ref must be the next
   * version of the same artifactId, and every stale ref must be a real ref
   * currently held by the target task or by a real transitive dependent task
   * of it. The closure may not contain an unrelated task that merely shares
   * the obligation. All events, the sequence and the affected sets are built
   * here so the commit can apply them without any further check.
   */
  validateRedoDelivery(
    ticket: P2RedoTicket,
    newRef: P2ArtifactRef,
    staleRefs: readonly P2ArtifactRef[],
    eventSeq: number,
  ): void {
    this.prepareRedoCommit(ticket, newRef, staleRefs, eventSeq);
  }

  /**
   * Commit one fully pre-validated redo delivery. The first record is the new
   * DELIVERED ref of the target task; then every stale ref is recorded as
   * invalidated; then each affected dependent task is reset to READY with no
   * refs and its obligation is reopened once. Unrelated tasks, their refs and
   * their obligations are untouched, and no mathematical acceptance is made.
   */
  commitRedoDelivery(
    ticket: P2RedoTicket,
    newRef: P2ArtifactRef,
    staleRefs: readonly P2ArtifactRef[],
    eventSeq: number,
  ): void {
    const plan = this.prepareRedoCommit(ticket, newRef, staleRefs, eventSeq);
    for (const event of plan.events) {
      this.events.push(p2Snapshot(event));
    }
    this.nextSeq = plan.eventSeq + plan.events.length;
    const target = this.requireTask(plan.ticket.taskId);
    this.tasks.set(plan.ticket.taskId, {
      task: target.task,
      delivery: "DELIVERED",
      deliveredRefs: [plan.newRef],
    });
    for (const taskId of plan.affectedTaskIds) {
      const state = this.requireTask(taskId);
      this.tasks.set(taskId, {
        task: { ...state.task, inputArtifactRefs: [] },
        delivery: "READY",
        deliveredRefs: [],
      });
    }
    for (const obligationId of plan.reopenedObligationIds) {
      const state = this.requireObligation(obligationId);
      this.obligations.set(obligationId, {
        obligation: state.obligation,
        status: "REOPENED",
        acceptance: null,
      });
    }
    this.redoBackups.delete(plan.ticket.taskId);
  }

  private prepareRedoCommit(
    ticket: P2RedoTicket,
    newRef: P2ArtifactRef,
    staleRefs: readonly P2ArtifactRef[],
    eventSeq: number,
  ): RedoCommitPlan {
    if (typeof ticket !== "object" || ticket === null || Array.isArray(ticket)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const frozenTicket = p2Snapshot(ticket) as P2RedoTicket;
    if (!isBoundedString(frozenTicket.taskId, P2_LIMITS.maxShortStringChars)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!isArtifactRef(frozenTicket.targetRef)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    // Snapshot first, then validate the frozen copy: a getter cannot swap the
    // value between the check and the use.
    const frozenNew = p2Snapshot(newRef) as P2ArtifactRef;
    if (!isArtifactRef(frozenNew)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (!Array.isArray(staleRefs)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const frozenStaleInput = p2Snapshot(staleRefs) as readonly P2ArtifactRef[];
    if (frozenStaleInput.length > P2_LIMITS.maxArtifacts) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const frozenStale: P2ArtifactRef[] = [];
    const staleKeys = new Set<string>();
    for (const ref of frozenStaleInput) {
      if (!isArtifactRef(ref)) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const key = refKey(ref);
      if (staleKeys.has(key)) {
        throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
      }
      staleKeys.add(key);
      frozenStale.push(ref);
    }
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 1 || eventSeq >= Number.MAX_SAFE_INTEGER) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }

    const backup = this.redoBackups.get(frozenTicket.taskId);
    if (backup === undefined) {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (
      frozenTicket.sessionId !== this.sessionId ||
      frozenTicket.problemHash !== this.problemHash ||
      frozenTicket.contractVersion !== this.contract.contractVersion ||
      JSON.stringify(backup.ticket) !== JSON.stringify(frozenTicket)
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (eventSeq !== this.nextSeq) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const target = this.requireTask(frozenTicket.taskId);
    if (target.delivery !== "RUNNING") {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (
      frozenNew.artifactId !== frozenTicket.targetRef.artifactId ||
      frozenNew.artifactVersion !== frozenTicket.targetRef.artifactVersion + 1
    ) {
      throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
    }
    if (!staleKeys.has(refKey(frozenTicket.targetRef))) {
      throw new P2Error(P2_ERROR_CODES.STALE_DEPENDENCY);
    }

    // Real transitive dependents of the target task, by task dependency only.
    // A dependent is affected whether it is DELIVERED, PARTIAL or READY: a
    // READY dependent still holds stale input refs that must be cleared.
    const dependents = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [taskId, state] of this.tasks) {
        if (taskId === frozenTicket.taskId || dependents.has(taskId)) {
          continue;
        }
        if (
          state.task.dependencyTaskIds.some(
            (dependency) => dependency === frozenTicket.taskId || dependents.has(dependency),
          )
        ) {
          dependents.add(taskId);
          grew = true;
        }
      }
    }

    // The exact stale closure: the old target ref plus every ref currently
    // held by the target task and by every real transitive dependent task.
    // A ref outside this set is rejected, and every ref inside it must be
    // listed, so a partial closure can never leave a stale ref ACTIVE.
    const expected = new Set<string>([refKey(frozenTicket.targetRef)]);
    for (const ref of backup.task.deliveredRefs) {
      expected.add(refKey(ref));
    }
    const affectedTaskIds: string[] = [];
    for (const taskId of dependents) {
      const state = this.requireTask(taskId);
      affectedTaskIds.push(taskId);
      for (const ref of state.deliveredRefs) {
        expected.add(refKey(ref));
      }
    }
    for (const key of staleKeys) {
      if (!expected.has(key)) {
        throw new P2Error(P2_ERROR_CODES.STALE_DEPENDENCY);
      }
    }
    for (const key of expected) {
      if (!staleKeys.has(key)) {
        throw new P2Error(P2_ERROR_CODES.STALE_DEPENDENCY);
      }
    }

    const affectedObligationIds: string[] = [];
    const reopenedObligationIds: string[] = [];
    const targetObligationId = target.task.obligationId;
    for (const taskId of affectedTaskIds) {
      const state = this.requireTask(taskId);
      const obligationId = state.task.obligationId;
      if (!affectedObligationIds.includes(obligationId)) {
        affectedObligationIds.push(obligationId);
      }
      if (!reopenedObligationIds.includes(obligationId)) {
        reopenedObligationIds.push(obligationId);
      }
    }

    const events: P2Event[] = [];
    const push = (
      eventType: P2EventType,
      sourceModule: P2Event["sourceModule"],
      extra: Partial<P2Event>,
    ): void => {
      events.push({
        eventId: `${this.sessionId}:event:${eventSeq + events.length}`,
        sessionId: this.sessionId,
        eventSeq: eventSeq + events.length,
        eventType,
        sourceModule,
        contractVersion: this.contract.contractVersion,
        ...extra,
      });
    };
    push("DELIVERY_RECORDED", "M3", {
      taskId: frozenTicket.taskId,
      obligationId: targetObligationId,
      artifactId: frozenNew.artifactId,
      artifactVersion: frozenNew.artifactVersion,
    });
    for (const ref of frozenStale) {
      push("ARTIFACT_INVALIDATED", "M3", {
        artifactId: ref.artifactId,
        artifactVersion: ref.artifactVersion,
      });
    }
    for (const obligationId of reopenedObligationIds) {
      push("OBLIGATION_REOPENED", "M1", { obligationId });
    }
    if (this.events.length + events.length > P2_LIMITS.maxLedgerEvents) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (eventSeq + events.length >= Number.MAX_SAFE_INTEGER) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }

    return p2Snapshot({
      ticket: frozenTicket,
      newRef: frozenNew,
      staleRefs: frozenStale,
      eventSeq,
      events,
      affectedTaskIds,
      affectedObligationIds,
      reopenedObligationIds,
    }) as RedoCommitPlan;
  }

  /** Add a whole validated batch; nothing is mutated before the batch passes. */
  validateTaskAddition(tasks: readonly P2Task[]): void {
    if (!Array.isArray(tasks)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (tasks.length === 0) {
      return;
    }
    if (tasks.length > P2_LIMITS.maxTasks) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const batch = p2Snapshot(tasks);
    const merged = [...[...this.tasks.values()].map((state) => state.task), ...batch];
    validateGraph(this.contract, merged);
    for (const task of batch) {
      if (task.delivery !== "READY" || task.inputArtifactRefs.length !== 0) {
        throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
      }
    }
    const seq = this.nextSeq;
    if (
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      seq + batch.length >= Number.MAX_SAFE_INTEGER
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (this.events.length + batch.length > P2_LIMITS.maxLedgerEvents) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
  }

  /** Add a whole validated batch; nothing is mutated before the batch passes. */
  addTasks(tasks: readonly P2Task[]): void {
    if (!Array.isArray(tasks)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (tasks.length === 0) {
      return;
    }
    const batch = p2Snapshot(tasks);
    this.validateTaskAddition(batch);
    const seq = this.nextSeq;
    const events: P2Event[] = batch.map((task, index) => ({
      eventId: `${this.sessionId}:event:${seq + index}`,
      sessionId: this.sessionId,
      eventSeq: seq + index,
      eventType: "TASK_ADDED",
      sourceModule: "M1",
      contractVersion: this.contract.contractVersion,
      taskId: task.taskId,
      obligationId: task.obligationId,
    }));
    for (const event of events) {
      this.events.push(p2Snapshot(event));
    }
    this.nextSeq = seq + batch.length;
    for (const task of batch) {
      this.tasks.set(task.taskId, {
        task: { ...task, delivery: "READY", inputArtifactRefs: [] },
        delivery: "READY",
        deliveredRefs: [],
      });
    }
  }

  /**
   * Revise the goal tree: version+1, reopen only changed goals and the
   * dependency closure they affect, preserve unrelated task/obligation state.
   */
  reviseGoals(newSpecs: readonly P2GoalSpec[]): P2RevisionDelta {
    const fromVersion = this.contract.contractVersion;
    const toVersion = fromVersion + 1;
    const templateTaskIds = new Set(this.contract.tasks.map((task) => task.taskId));
    for (const taskId of this.tasks.keys()) {
      if (!templateTaskIds.has(taskId)) {
        throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
      }
    }
    const next = compileP2Contract(
      this.contract.problemFullText,
      this.sessionId,
      newSpecs,
      this.nextSeq,
      toVersion,
    );
    if (next.problemHash !== this.problemHash) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const fingerprint = (goal: P2GoalSpec): string =>
      `${goal.goalId}|${goal.kind}|${p2ScopeIdOf(goal.scope)}|${goal.subgoals
        .map(fingerprint)
        .join(",")}`;
    const oldGoals = new Map<string, string>();
    const collectOld = (goal: P2GoalSpec): void => {
      oldGoals.set(goal.goalId, fingerprint(goal));
      for (const child of goal.subgoals) {
        collectOld(child);
      }
    };
    for (const goal of this.contract.goals) {
      collectOld(goal);
    }
    const newGoals = new Map<string, string>();
    const collectNew = (goal: P2GoalSpec): void => {
      newGoals.set(goal.goalId, fingerprint(goal));
      for (const child of goal.subgoals) {
        collectNew(child);
      }
    };
    for (const goal of next.goals) {
      collectNew(goal);
    }
    const changedGoalIds: string[] = [];
    for (const [goalId, print] of newGoals) {
      if (oldGoals.get(goalId) !== print) {
        changedGoalIds.push(goalId);
      }
    }
    for (const goalId of oldGoals.keys()) {
      if (!newGoals.has(goalId)) {
        changedGoalIds.push(goalId);
      }
    }
    const changed = new Set(changedGoalIds);
    const affected = new Set<string>();
    for (const state of this.tasks.values()) {
      if (changed.has(state.task.goalId)) {
        affected.add(state.task.taskId);
      }
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const state of this.tasks.values()) {
        if (affected.has(state.task.taskId)) {
          continue;
        }
        if (state.task.dependencyTaskIds.some((dependency) => affected.has(dependency))) {
          affected.add(state.task.taskId);
          grew = true;
        }
      }
    }
    const affectedObligationIds = new Set<string>();
    for (const state of this.tasks.values()) {
      if (affected.has(state.task.taskId)) {
        affectedObligationIds.add(state.task.obligationId);
      }
    }
    const nextTaskIds = new Set(next.tasks.map((task) => task.taskId));
    const preservedTaskIds: string[] = [];
    const removedTaskIds: string[] = [];
    for (const state of this.tasks.values()) {
      if (!nextTaskIds.has(state.task.taskId)) {
        removedTaskIds.push(state.task.taskId);
      } else if (!affected.has(state.task.taskId)) {
        preservedTaskIds.push(state.task.taskId);
      }
    }
    const nextObligations = new Map<string, ObligationState>();
    for (const obligation of next.obligations) {
      const previous = this.obligations.get(obligation.obligationId);
      const keep =
        previous !== undefined &&
        !changed.has(obligation.goalId) &&
        !affectedObligationIds.has(obligation.obligationId);
      nextObligations.set(obligation.obligationId, {
        obligation,
        status: keep ? previous.status : previous === undefined ? "OPEN" : "REOPENED",
        acceptance: keep ? previous.acceptance : null,
      });
    }
    const nextTasks = new Map<string, TaskState>();
    for (const task of next.tasks) {
      const previous = this.tasks.get(task.taskId);
      const keep = previous !== undefined && !affected.has(task.taskId);
      nextTasks.set(task.taskId, {
        task: keep
          ? { ...task, inputArtifactRefs: previous.task.inputArtifactRefs }
          : { ...task, inputArtifactRefs: [] },
        delivery: keep ? previous.delivery : "READY",
        deliveredRefs: keep ? previous.deliveredRefs : [],
      });
    }
    const seq = this.nextSeq;
    if (
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      seq >= Number.MAX_SAFE_INTEGER ||
      this.events.length + 1 > P2_LIMITS.maxLedgerEvents
    ) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const delta = p2Snapshot({
      fromVersion,
      toVersion,
      changedGoalIds,
      affectedTaskIds: [...affected],
      preservedTaskIds,
      removedTaskIds,
    });
    validateGraph(next, next.tasks);
    const event: P2Event = p2Snapshot({
      eventId: `${this.sessionId}:event:${seq}`,
      sessionId: this.sessionId,
      eventSeq: seq,
      eventType: "GOALS_REVISED",
      sourceModule: "M1",
      contractVersion: toVersion,
    });
    this.events.push(event);
    this.nextSeq = seq + 1;
    this.contract = next;
    this.obligations.clear();
    for (const [key, value] of nextObligations) {
      this.obligations.set(key, value);
    }
    this.tasks.clear();
    for (const [key, value] of nextTasks) {
      this.tasks.set(key, value);
    }
    return delta;
  }
}
