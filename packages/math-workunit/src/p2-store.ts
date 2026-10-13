/**
 * @astra/math-workunit — P2-A versioned artifact store.
 *
 * Holds immutable artifact versions, route registrations and the latest
 * version per artifactId. Availability is independent of the artifact record:
 * invalidation only marks entries STALE and never rewrites the artifact, never
 * drops a version and never claims REFUTED. Every candidate is a proposal
 * only; nothing here is mathematical acceptance. This library does not claim a
 * complete event audit: the inherited root sequence is supplied by a future
 * composition root.
 */

import {
  P2_ERROR_CODES,
  P2_LIMITS,
  P2Error,
  canonicalScope,
  p2Snapshot,
  type P2Artifact,
  type P2ArtifactAvailability,
  type P2ArtifactRef,
  type P2Contract,
  type P2GoalSpec,
  type P2RouteSpec,
  type P2Task,
} from "@astra/protocol";
import {
  checkScopeCoverage,
  checkScopeCoverageAgainstScope,
  checkGoalExhaustionAgainstGoal,
  checkTaskScopeCoverage,
  p2ScopeCoverage,
  workHash,
  workRefKey,
  workScope,
  type P2ScopeCoverage,
  type P2TaskScopeCoverage,
} from "./p2-context.js";
import { P2RouteRegistry, type P2RouteInput } from "./p2-routes.js";
import { readWorkReceipt, type P2WorkReceipt } from "./p2-receipt.js";

export type { P2WorkReceipt } from "./p2-receipt.js";

export interface P2ArtifactEntry {
  readonly artifact: P2Artifact;
  readonly availability: P2ArtifactAvailability;
}

export type { P2TaskScopeCoverage } from "./p2-context.js";

const MAX_TASKS = P2_LIMITS.maxTasks;
const MAX_OBLIGATIONS = P2_LIMITS.maxObligations;
const MAX_ARTIFACTS = P2_LIMITS.maxArtifacts;

/**
 * Read-only lookup of one goal node in the trusted goal tree. Returns `null`
 * when the goal id is not part of the contract; nothing here is a
 * mathematical decision.
 */
function findGoalSpec(
  goals: readonly P2GoalSpec[],
  goalId: string,
): P2GoalSpec | null {
  for (const goal of goals) {
    if (goal.goalId === goalId) {
      return goal;
    }
    const nested = findGoalSpec(goal.subgoals, goalId);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

/** Static identity guards only; the contract's own task state is not changed. */
function guardContract(contract: P2Contract): number {
  if (typeof contract !== "object" || contract === null) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const tasks = contract.tasks;
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_TASKS) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const obligations = contract.obligations;
  if (!Array.isArray(obligations) || obligations.length > MAX_OBLIGATIONS) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const seen = new Set<string>();
  let lastSeq = 0;
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const taskId = task.taskId;
    if (typeof taskId !== "string" || seen.has(taskId)) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    seen.add(taskId);
    const running = { ...task, delivery: "RUNNING" } as P2Task;
    workScope(contract, running);
    const seq = task.envelope.eventSeq;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > lastSeq) {
      lastSeq = seq;
    }
  }
  const contractSeq = contract.envelope.eventSeq;
  if (typeof contractSeq === "number" && Number.isSafeInteger(contractSeq) && contractSeq > lastSeq) {
    lastSeq = contractSeq;
  }
  return lastSeq;
}

export class P2WorkunitStore {
  private contract: P2Contract;
  private readonly routes = new P2RouteRegistry();
  private readonly entries = new Map<string, P2ArtifactEntry>();
  private readonly latest = new Map<string, number>();
  private readonly requests = new Set<string>();
  private readonly scopeCoverage = new Map<string, P2TaskScopeCoverage>();
  private lastSeq: number;

  constructor(contract: P2Contract) {
    const frozen = p2Snapshot(contract) as P2Contract;
    this.lastSeq = guardContract(frozen);
    this.contract = frozen;
  }

  registerRoute(input: P2RouteInput): P2RouteSpec {
    return this.routes.register(input);
  }

  /**
   * Pure pre-check of one prospective declared-coverage row. Runs the exact
   * same normalization and scope binding as `declareScopeCoverage` but writes
   * nothing, so a caller can prove a v5 scope proposal is admissible BEFORE it
   * accepts the artifact or records any delivery. An out-of-scope quantifier or
   * branch condition is the same fixed `SCOPE_MISMATCH` rejection.
   *
   * When the declaring goal carries subgoals (a MULTIPART root), the declared
   * `goalExhaustion` must be exactly the trusted child goal id set of that
   * goal; a missing, extra or duplicated child id is a fixed `SCOPE_MISMATCH`
   * rejection. A goal without subgoals keeps the previous behaviour and the
   * list stays declared data.
   */
  validateScopeCoverage(task: P2Task, proposal: unknown): P2ScopeCoverage {
    const frozenTask = p2Snapshot(task) as P2Task;
    const scope = workScope(this.contract, frozenTask);
    const coverage = p2ScopeCoverage(p2Snapshot(proposal));
    const goal = findGoalSpec(this.contract.goals, frozenTask.goalId);
    if (goal === null) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    checkScopeCoverageAgainstScope(coverage, scope, goal.kind);
    checkGoalExhaustionAgainstGoal(coverage, goal);
    return p2Snapshot(coverage) as P2ScopeCoverage;
  }

  /**
   * Store the declared scope coverage of one task. The proposal is normalized
   * through `p2ScopeCoverage` and every quantifier/branch item must already be
   * part of the trusted scope of that task; an out-of-scope item is a fixed
   * `SCOPE_MISMATCH` rejection. Nothing else is mutated: artifacts, versions,
   * requests, routes and the sequence stay exactly as they were, and the
   * coverage hash is a declaration identity, never a coverage proof.
   */
  declareScopeCoverage(task: P2Task, proposal: unknown): P2ScopeCoverage {
    const frozenTask = p2Snapshot(task) as P2Task;
    const scope = workScope(this.contract, frozenTask);
    const coverage = this.validateScopeCoverage(frozenTask, proposal);
    this.scopeCoverage.set(frozenTask.taskId, p2Snapshot({
      taskId: frozenTask.taskId,
      scopeId: scope.scopeId,
      coverage,
    }) as P2TaskScopeCoverage);
    return coverage;
  }

  /** The stored declared coverage of one task, or `null` when none is stored. */
  scopeCoverageOf(taskId: string): P2ScopeCoverage | null {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const stored = this.scopeCoverage.get(taskId);
    return stored === undefined ? null : (p2Snapshot(stored.coverage) as P2ScopeCoverage);
  }

  /**
   * Deep-frozen copy of every stored declared coverage row, each carrying the
   * trusted scope id it was declared against. The row is declared data only:
   * it never marks an obligation covered and never closes a task.
   */
  scopeCoverageSnapshot(): readonly P2TaskScopeCoverage[] {
    const rows: P2TaskScopeCoverage[] = [];
    for (const row of this.scopeCoverage.values()) {
      rows.push(checkTaskScopeCoverage(row));
    }
    return p2Snapshot(rows) as readonly P2TaskScopeCoverage[];
  }

  /**
   * Pure pre-check of one prospective contract snapshot that only appends
   * tasks. Session, problem hash, contract version, problem text, goals and
   * obligation identity must be unchanged; every already-owned task must keep
   * its immutable definition (delivery and input refs are ledger runtime state
   * and may differ); every added task must be READY with no inputs, fully
   * bound, uniquely identified and part of a legal DAG. Nothing is mutated.
   */
  validateAddedTasks(snapshot: P2Contract): void {
    const next = p2Snapshot(snapshot) as P2Contract;
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const current = this.contract;
    if (
      typeof next.envelope !== "object" ||
      next.envelope === null ||
      Array.isArray(next.envelope) ||
      !Array.isArray(next.goals) ||
      !Array.isArray(next.obligations) ||
      !Array.isArray(next.tasks)
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (next.envelope.sessionId !== current.envelope.sessionId) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (next.problemHash !== current.problemHash) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (next.problemFullText !== current.problemFullText) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (next.contractVersion !== current.contractVersion) {
      throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
    }
    if (next.envelope.contractVersion !== current.envelope.contractVersion) {
      throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
    }
    if (next.envelope.problemHash !== current.envelope.problemHash) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (next.envelope.sourceModule !== "M1") {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    // The master envelope is immutable through a task sync: a control class
    // must not be able to rewrite recordId, eventSeq or any other envelope
    // field by appending tasks. `ledger.snapshot()` keeps this value stable.
    if (JSON.stringify(next.envelope) !== JSON.stringify(current.envelope)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (JSON.stringify(next.goals) !== JSON.stringify(current.goals)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    // Shape guards run before any member is read, so a malformed row can never
    // be dereferenced while building the id map.
    for (const row of next.obligations) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (typeof row.envelope !== "object" || row.envelope === null || Array.isArray(row.envelope)) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (typeof row.obligationId !== "string" || row.obligationId.length === 0) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    const nextObligations = new Map(next.obligations.map((row) => [row.obligationId, row]));
    if (nextObligations.size !== next.obligations.length) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    if (nextObligations.size !== current.obligations.length) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    for (const obligation of current.obligations) {
      const candidate = nextObligations.get(obligation.obligationId);
      if (candidate === undefined) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (
        candidate.goalId !== obligation.goalId ||
        candidate.kind !== obligation.kind ||
        JSON.stringify(candidate.envelope) !== JSON.stringify(obligation.envelope)
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (JSON.stringify(candidate.acceptance) !== JSON.stringify(obligation.acceptance)) {
        throw new P2Error(P2_ERROR_CODES.UNTRUSTED_ACCEPTANCE);
      }
      if (obligation.status !== "SATISFIED" && candidate.status === "SATISFIED") {
        throw new P2Error(P2_ERROR_CODES.UNTRUSTED_ACCEPTANCE);
      }
    }
    // Same ordering rule for tasks: shape first, id map second.
    for (const row of next.tasks) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (typeof row.envelope !== "object" || row.envelope === null || Array.isArray(row.envelope)) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (typeof row.taskId !== "string" || row.taskId.length === 0) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    const nextTasks = new Map(next.tasks.map((row) => [row.taskId, row]));
    if (nextTasks.size !== next.tasks.length) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    if (next.tasks.length > MAX_TASKS) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    for (const task of current.tasks) {
      const candidate = nextTasks.get(task.taskId);
      if (candidate === undefined) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (
        candidate.goalId !== task.goalId ||
        candidate.obligationId !== task.obligationId ||
        candidate.scopeId !== task.scopeId ||
        candidate.expectedResult !== task.expectedResult ||
        candidate.acceptanceCriteria !== task.acceptanceCriteria ||
        JSON.stringify(candidate.envelope) !== JSON.stringify(task.envelope) ||
        JSON.stringify(candidate.dependencyTaskIds) !== JSON.stringify(task.dependencyTaskIds)
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    const owned = new Set(current.tasks.map((task) => task.taskId));
    for (const task of next.tasks) {
      if (owned.has(task.taskId)) {
        continue;
      }
      if (task.delivery !== "READY") {
        throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
      }
      if (!Array.isArray(task.inputArtifactRefs) || task.inputArtifactRefs.length !== 0) {
        throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
      }
      if (
        !Array.isArray(task.dependencyTaskIds) ||
        task.dependencyTaskIds.length > P2_LIMITS.maxArrayItems ||
        !task.dependencyTaskIds.every((dependency: unknown): boolean => {
          if (typeof dependency !== "string") {
            return false;
          }
          return dependency.length > 0 && [...dependency].length <= P2_LIMITS.maxShortStringChars;
        })
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      if (new Set(task.dependencyTaskIds).size !== task.dependencyTaskIds.length) {
        throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
      }
      const obligation = nextObligations.get(task.obligationId);
      if (obligation === undefined) {
        throw new P2Error(P2_ERROR_CODES.DANGLING_REFERENCE);
      }
      if (obligation.goalId !== task.goalId) {
        throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
      }
      if (obligation.envelope.scopeId !== task.scopeId) {
        throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
      }
      if (
        task.envelope.sourceModule !== "M1" ||
        task.envelope.sessionId !== current.envelope.sessionId ||
        task.envelope.problemHash !== current.problemHash ||
        task.envelope.contractVersion !== current.contractVersion ||
        task.envelope.taskId !== task.taskId ||
        task.envelope.scopeId !== task.scopeId
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
      for (const dependency of task.dependencyTaskIds) {
        if (!nextTasks.has(dependency)) {
          throw new P2Error(P2_ERROR_CODES.DANGLING_REFERENCE);
        }
        if (dependency === task.taskId) {
          throw new P2Error(P2_ERROR_CODES.DEPENDENCY_CYCLE);
        }
      }
    }
    const marks = new Map<string, number>();
    const visit = (taskId: string): void => {
      const mark = marks.get(taskId) ?? 0;
      if (mark === 1) {
        throw new P2Error(P2_ERROR_CODES.DEPENDENCY_CYCLE);
      }
      if (mark === 2) {
        return;
      }
      marks.set(taskId, 1);
      const task = nextTasks.get(taskId);
      for (const dependency of task?.dependencyTaskIds ?? []) {
        visit(dependency);
      }
      marks.set(taskId, 2);
    };
    for (const task of next.tasks) {
      visit(task.taskId);
    }
    guardContract(next);
    const running = { ...next, tasks: next.tasks.map((task) => ({ ...task, delivery: "RUNNING" as const })) };
    for (const task of running.tasks) {
      workScope(running, task as P2Task);
    }
  }

  /**
   * Commit one prospective contract snapshot after the full pure pre-check.
   * Routes, entries, requests, latest versions and the sequence are preserved;
   * the sequence never moves backwards.
   */
  syncAddedTasks(snapshot: P2Contract): void {
    const next = p2Snapshot(snapshot) as P2Contract;
    this.validateAddedTasks(next);
    const guarded = guardContract(next);
    this.contract = next;
    if (guarded > this.lastSeq) {
      this.lastSeq = guarded;
    }
  }

  routesSnapshot(): readonly P2RouteSpec[] {
    return this.routes.snapshot();
  }

  snapshot(): readonly P2ArtifactEntry[] {
    return p2Snapshot([...this.entries.values()]) as readonly P2ArtifactEntry[];
  }

  get(ref: P2ArtifactRef): P2ArtifactEntry {
    const entry = this.entries.get(workRefKey(ref));
    if (entry === undefined) {
      throw new P2Error(P2_ERROR_CODES.UNKNOWN_DEPENDENCY);
    }
    return entry;
  }

  candidate(ref: P2ArtifactRef): string | null {
    const entry = this.get(ref);
    if (entry.availability !== "ACTIVE") {
      return null;
    }
    const artifact = entry.artifact;
    if (artifact.deliveryStatus !== "COMPLETE" || artifact.packet === null) {
      return null;
    }
    const proposal = artifact.packet.candidateProposal;
    if (proposal === null || proposal.trim().length === 0) {
      return null;
    }
    return proposal;
  }

  /**
   * Accept one raw receipt as a new immutable artifact version.
   *
   * Every check and every snapshot happens before the first mutation, so a
   * rejected call leaves entries, latest, requests and the sequence untouched.
   * The trusted task input refs are all recorded as dependencies (conservative
   * inclusion), while the packet keeps its own reported dependency list. The
   * result stays PROVISIONAL/UNKNOWN; this is not mathematical acceptance.
   */
  accept(task: P2Task, input: P2WorkReceipt): P2Artifact {
    const { artifact, receipt, entryKey } = this.prepareAcceptance(task, input);
    const entry = p2Snapshot({ artifact, availability: "ACTIVE" }) as P2ArtifactEntry;
    if (receipt.supersedes !== null) {
      this.invalidate(receipt.supersedes);
    }
    this.entries.set(entryKey, entry);
    this.latest.set(artifact.artifactId, artifact.envelope.artifactVersion as number);
    this.requests.add(receipt.sourceRequestId);
    this.lastSeq = receipt.eventSeq;
    return artifact;
  }

  /**
   * Pure pre-check of one prospective acceptance. Runs every validation and
   * builds the exact artifact plus its entry key, but writes no map, no
   * request, no latest version and no sequence. `accept` reuses this so the
   * pre-check and the commit can never diverge.
   */
  validateAccept(task: P2Task, input: P2WorkReceipt): P2Artifact {
    return this.prepareAcceptance(task, input).artifact;
  }

  /**
   * Pure pre-check of one prospective replacement of an existing version.
   *
   * It runs the same shared acceptance pre-check and then requires the new
   * artifact to keep the exact canonical scope of the version it replaces.
   * Nothing is mutated: no map, no request, no latest version, no sequence and
   * no availability change. The scope comparison uses the full canonical scope
   * of the prepared artifact, which the shared M3 work-scope resolution has
   * already bound to the real goal/scope of the task.
   */
  validateReplacement(task: P2Task, input: P2WorkReceipt, previous: P2Artifact): P2Artifact {
    const prepared = this.prepareAcceptance(task, input).artifact;
    const frozenPrevious = p2Snapshot(previous) as P2Artifact;
    if (canonicalScope(prepared.scope) !== canonicalScope(frozenPrevious.scope)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    return prepared;
  }

  private prepareAcceptance(
    task: P2Task,
    input: P2WorkReceipt,
  ): { readonly artifact: P2Artifact; readonly receipt: P2WorkReceipt; readonly entryKey: string } {
    const frozenTask = p2Snapshot(task) as P2Task;
    const scope = workScope(this.contract, frozenTask);
    const read = readWorkReceipt(this.contract, frozenTask, scope, input);
    const receipt = read.receipt;

    const route = this.routes.get(receipt.routeId);
    if (this.requests.has(receipt.sourceRequestId)) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_REQUEST_ID);
    }
    if (receipt.eventSeq <= this.lastSeq) {
      throw new P2Error(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.entries.size >= MAX_ARTIFACTS) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }

    const artifactVersion = this.resolveVersion(receipt, frozenTask, scope, route);
    const dependencies = this.resolveDependencies(frozenTask, scope, route, receipt);
    this.checkCycle(receipt.artifactId, dependencies);

    const sessionId = this.contract.envelope.sessionId;
    const artifact = p2Snapshot({
      envelope: {
        recordId: `${sessionId}:m3:artifact:${receipt.eventSeq}`,
        sessionId,
        problemHash: this.contract.problemHash,
        sourceModule: "M3",
        taskId: frozenTask.taskId,
        contractVersion: this.contract.contractVersion,
        artifactId: receipt.artifactId,
        artifactVersion,
        scopeId: scope.scopeId,
        causeEventId: `${sessionId}:event:${frozenTask.envelope.eventSeq}`,
        eventSeq: receipt.eventSeq,
      },
      artifactId: receipt.artifactId,
      routeId: route.routeId,
      scope,
      dependencies,
      sourceRequestId: receipt.sourceRequestId,
      rawResponseHash: workHash(receipt.text),
      rawResponseRef: `${sessionId}:raw:${receipt.sourceRequestId}`,
      rawResponseText: receipt.text,
      packet: read.packet,
      transportStatus: receipt.transportStatus,
      deliveryStatus: read.deliveryStatus,
      level: "PROVISIONAL",
      checkResult: "UNKNOWN",
      provisionalDependency: dependencies.length > 0,
    }) as P2Artifact;

    const entryKey = workRefKey({ artifactId: artifact.artifactId, artifactVersion });
    return p2Snapshot({ artifact, receipt, entryKey }) as {
      readonly artifact: P2Artifact;
      readonly receipt: P2WorkReceipt;
      readonly entryKey: string;
    };
  }

  /**
   * Resolve the new version number for one artifactId. A first version must
   * not declare `supersedes`; a later version must supersede exactly the
   * current latest version of the same artifactId and must keep the same task,
   * scope and route as that version.
   */
  private resolveVersion(
    receipt: P2WorkReceipt,
    task: P2Task,
    scope: P2Artifact["scope"],
    route: P2RouteSpec,
  ): number {
    const current = this.latest.get(receipt.artifactId);
    if (current === undefined) {
      if (receipt.supersedes !== null) {
        throw new P2Error(P2_ERROR_CODES.UNKNOWN_DEPENDENCY);
      }
      return 1;
    }
    if (receipt.supersedes === null) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    if (receipt.supersedes.artifactId !== receipt.artifactId || receipt.supersedes.artifactVersion !== current) {
      throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
    }
    const previous = this.entries.get(workRefKey({ artifactId: receipt.artifactId, artifactVersion: current }));
    if (previous === undefined) {
      throw new P2Error(P2_ERROR_CODES.UNKNOWN_DEPENDENCY);
    }
    const old = previous.artifact;
    if (old.envelope.taskId !== task.taskId) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (old.scope.scopeId !== scope.scopeId) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    if (old.routeId !== route.routeId) {
      throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
    }
    const next = current + 1;
    if (!Number.isSafeInteger(next)) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    return next;
  }

  /**
   * Every trusted task input ref must exist, be ACTIVE at its latest version,
   * agree on session/hash/contract/scope/route and be a COMPLETE packet. All
   * of them are recorded as dependencies, not only the packet's own subset.
   */
  private resolveDependencies(
    task: P2Task,
    scope: P2Artifact["scope"],
    route: P2RouteSpec,
    receipt: P2WorkReceipt,
  ): readonly P2ArtifactRef[] {
    const sessionId = this.contract.envelope.sessionId;
    const problemHash = this.contract.problemHash;
    const contractVersion = this.contract.contractVersion;
    const collected: P2ArtifactRef[] = [];
    for (const ref of task.inputArtifactRefs) {
      const entry = this.get(ref);
      if (entry.availability !== "ACTIVE") {
        throw new P2Error(P2_ERROR_CODES.STALE_DEPENDENCY);
      }
      const artifact = entry.artifact;
      if (this.latest.get(artifact.artifactId) !== artifact.envelope.artifactVersion) {
        throw new P2Error(P2_ERROR_CODES.STALE_DEPENDENCY);
      }
      if (
        artifact.envelope.sessionId !== sessionId ||
        artifact.envelope.problemHash !== problemHash ||
        artifact.envelope.contractVersion !== contractVersion
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (artifact.scope.scopeId !== scope.scopeId) {
        throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
      }
      if (canonicalScope(artifact.scope) !== canonicalScope(scope)) {
        throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
      }
      if (artifact.routeId !== route.routeId) {
        throw new P2Error(P2_ERROR_CODES.CROSS_ROUTE_REVIEW_REQUIRED);
      }
      if (artifact.deliveryStatus !== "COMPLETE" || artifact.packet === null) {
        throw new P2Error(P2_ERROR_CODES.NOT_REUSABLE);
      }
      collected.push(p2Snapshot(ref) as P2ArtifactRef);
    }
    return p2Snapshot(collected) as readonly P2ArtifactRef[];
  }

  /**
   * A new version must not depend on its own previous version or on any
   * transitive downstream of it, so replacing a version can never leave the
   * new artifact referencing the chain it just invalidated.
   */
  private checkCycle(artifactId: string, dependencies: readonly P2ArtifactRef[]): void {
    const seen = new Set<string>();
    const queue: P2ArtifactRef[] = [...dependencies];
    while (queue.length > 0) {
      const ref = queue.shift() as P2ArtifactRef;
      const key = workRefKey(ref);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const entry = this.entries.get(key);
      if (entry === undefined) {
        continue;
      }
      if (entry.artifact.artifactId === artifactId) {
        throw new P2Error(P2_ERROR_CODES.DEPENDENCY_CYCLE);
      }
      for (const nested of entry.artifact.dependencies) {
        queue.push(nested);
      }
    }
  }

  invalidate(ref: P2ArtifactRef): readonly P2ArtifactRef[] {
    const affected = this.previewInvalidation(ref);
    for (const item of affected) {
      const key = workRefKey(item);
      const entry = this.entries.get(key) as P2ArtifactEntry;
      this.entries.set(key, p2Snapshot({ artifact: entry.artifact, availability: "STALE" }) as P2ArtifactEntry);
    }
    return affected;
  }

  /**
   * Pure query of the exact invalidation closure of one ref: the target plus
   * every transitive downstream that depends on it. Nothing is mutated and no
   * availability is changed. A ref that is not a stored version is rejected
   * with the same fixed code as `invalidate`, so a forged version can never
   * turn into an empty closure.
   */
  previewInvalidation(ref: P2ArtifactRef): readonly P2ArtifactRef[] {
    const rootKey = workRefKey(ref);
    if (!this.entries.has(rootKey)) {
      throw new P2Error(P2_ERROR_CODES.UNKNOWN_DEPENDENCY);
    }
    const closure = new Set<string>([rootKey]);
    const queue: string[] = [rootKey];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const [key, entry] of this.entries) {
        if (closure.has(key)) {
          continue;
        }
        for (const dependency of entry.artifact.dependencies) {
          if (workRefKey(dependency) === current) {
            closure.add(key);
            queue.push(key);
            break;
          }
        }
      }
    }
    const affected: P2ArtifactRef[] = [];
    for (const key of closure) {
      const entry = this.entries.get(key) as P2ArtifactEntry;
      affected.push({
        artifactId: entry.artifact.artifactId,
        artifactVersion: entry.artifact.envelope.artifactVersion as number,
      });
    }
    return p2Snapshot(affected) as readonly P2ArtifactRef[];
  }
}
