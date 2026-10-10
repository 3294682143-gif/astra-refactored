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

function refKey(ref: P2ArtifactRef): string {
  return `${ref.artifactId}@${ref.artifactVersion}`;
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

  /** Add a whole validated batch; nothing is mutated before the batch passes. */
  addTasks(tasks: readonly P2Task[]): void {
    if (!Array.isArray(tasks)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (tasks.length === 0) {
      return;
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
    if (this.events.length + events.length > P2_LIMITS.maxLedgerEvents) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
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
