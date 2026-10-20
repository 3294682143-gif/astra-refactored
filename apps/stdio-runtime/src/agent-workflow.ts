/**
 * @astra/stdio-runtime — unified AgentLoop dynamic route admission (pure).
 *
 * One untrusted v2 WorkPacket may carry a NEW_ROUTE suggestion. This helper
 * re-checks that suggestion against the trusted ledger/store, derives the
 * route id, task id and provenance itself, and appends one independent READY
 * task. The model never supplies a route id, task id, scope, dependency or
 * budget. Nothing here is mathematical verification: a route signature is an
 * identity of declared data, not a proof of independence.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  p2Snapshot,
  type AgentDependencyProvenance,
  type AgentRouteAdmission,
  type AgentRouteProvenance,
  type AgentTaskRoute,
  type P2Artifact,
  type P2ArtifactRef,
  type P2RouteSpec,
  type P2Task,
  type P2WorkPacketV2,
  type P2WorkPacketV3,
} from "@astra/protocol";
import {
  P2RouteRegistry,
  p2RouteSignature,
  type P2RouteInput,
} from "@astra/math-workunit";
import type { ContractLedger } from "@astra/math-contract";
import type { P2WorkunitStore } from "@astra/math-workunit";
import { AGENT_MAX_MODEL_CALLS } from "@astra/runtime-core";

const MAX_ROUTES = 2;
const MAX_DEPENDENCIES = 2;
const MAX_REVIEWS = 3;
const MAX_WORK_UNITS = 64;
const MAX_REMAINING_MS = 3_600_000;
const MIN_REMAINING_MS = 25;
const MAX_TASK_ID_CHARS = 256;

/** The default mechanism; its route id is derived from its own signature. */
const DEFAULT_MECHANISM = {
  representation: "original-problem",
  operation: "direct-reasoning",
  lemmas: [] as readonly string[],
  construction: "unified-agent-loop",
} as const;

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

/** Route id derived from the mechanism signature; never a constant. */
function routeIdOf(signature: string): string {
  return `route-${signature.slice(0, 16)}`;
}

/**
 * Control-side dynamic route admission for one unified AgentLoop run.
 *
 * The default route is registered from its own mechanism signature. A second
 * route is admitted only from a real COMPLETE v2 packet whose proposal names a
 * real, non-closed obligation of the same scope, and only when the root still
 * has room for one more work unit and the review reserve.
 */
export class AgentWorkflowRoutes {
  private readonly ledger: ContractLedger;
  private readonly store: P2WorkunitStore;
  private readonly defaultRoute: P2RouteSpec;
  private readonly taskRoutes = new Map<string, AgentTaskRoute>();
  private readonly admissions: AgentRouteAdmission[] = [];
  private readonly dependencies: AgentRouteAdmission[] = [];

  constructor(ledger: ContractLedger, store: P2WorkunitStore) {
    this.ledger = ledger;
    this.store = store;
    const signature = p2RouteSignature({ routeId: "probe", ...DEFAULT_MECHANISM });
    this.defaultRoute = store.registerRoute({
      routeId: routeIdOf(signature),
      ...DEFAULT_MECHANISM,
    });
  }

  /** The default route of this run. */
  default(): P2RouteSpec {
    return this.defaultRoute;
  }

  /**
   * Route of one task: the real admitted mapping when one exists, otherwise
   * the default route. No old artifact is ever relabelled.
   */
  forTask(task: P2Task): P2RouteSpec {
    const mapped = this.taskRoutes.get(task.taskId);
    if (mapped === undefined) {
      return this.defaultRoute;
    }
    const found = this.store.routesSnapshot().find((route) => route.routeId === mapped.routeId);
    if (found === undefined) {
      // A mapped task whose route is missing is a control inconsistency, never
      // a silent fallback onto the default route.
      fail(P2_ERROR_CODES.ROUTE_MISMATCH);
    }
    return found;
  }

  /** Provenance of one task, or null for a task on the default route. */
  provenanceOf(taskId: string): AgentRouteProvenance | null {
    const admission = this.admissions.find((row) => row.taskId === taskId);
    return admission?.provenance ?? null;
  }

  /** Provenance of one dependent task, or null when it is not one. */
  dependencyProvenanceOf(taskId: string): AgentDependencyProvenance | null {
    const admission = this.dependencies.find((row) => row.taskId === taskId);
    return admission?.provenance ?? null;
  }

  /**
   * Whether a second route may even be considered. All bounds are strict
   * integers; a model can never widen them.
   */
  canAdmit(
    remainingCalls: number,
    maxReviews: number,
    remainingWorkUnits: number,
    remainingMs: number,
  ): boolean {
    const calls = boundedInt(remainingCalls, AGENT_MAX_MODEL_CALLS);
    const reviews = boundedInt(maxReviews, MAX_REVIEWS);
    const units = boundedInt(remainingWorkUnits, MAX_WORK_UNITS);
    const ms = boundedInt(remainingMs, MAX_REMAINING_MS);
    if (this.admissions.length !== 0) {
      return false;
    }
    if (this.store.routesSnapshot().length >= MAX_ROUTES) {
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
   * Whether one dependent task may even be considered. Same strict bounds as
   * `canAdmit`, but the route count is not a limit here: only the dependency
   * admission count is.
   */
  canContinue(
    remainingCalls: number,
    maxReviews: number,
    remainingWorkUnits: number,
    remainingMs: number,
  ): boolean {
    const calls = boundedInt(remainingCalls, AGENT_MAX_MODEL_CALLS);
    const reviews = boundedInt(maxReviews, MAX_REVIEWS);
    const units = boundedInt(remainingWorkUnits, MAX_WORK_UNITS);
    const ms = boundedInt(remainingMs, MAX_REMAINING_MS);
    if (this.dependencies.length >= MAX_DEPENDENCIES) {
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
   * Admit one dependent task from a real COMPLETE v3 artifact.
   *
   * Every check runs before the first mutation. A rejected proposal returns
   * `false` and leaves the ledger, store, routes and mappings untouched; the
   * already accepted artifact and candidate are preserved. The model supplies
   * no task id, refs, route or budget: the child inherits the real route of its
   * source task and its input refs are filled later by the ledger.
   */
  admitDependency(
    artifact: P2Artifact,
    remainingCalls: number,
    maxReviews: number,
    remainingWorkUnits: number,
    remainingMs: number,
  ): boolean {
    if (!this.canContinue(remainingCalls, maxReviews, remainingWorkUnits, remainingMs)) {
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
    if (packet === null || packet.schemaVersion !== "p2a-work-v3") {
      return false;
    }
    const proposal = (packet as P2WorkPacketV3).workflowProposal;
    if (proposal === null || !isPlainObject(proposal)) {
      return false;
    }
    if (proposal.kind !== "DEPENDENT_TASK") {
      return false;
    }
    if (typeof proposal.rationale !== "string" || proposal.rationale.trim().length === 0) {
      return false;
    }
    const obligationId = proposal.obligationId;
    if (typeof obligationId !== "string" || obligationId.trim().length === 0) {
      return false;
    }

    // The artifact must be the real ACTIVE latest entry of the store.
    const ref: P2ArtifactRef = {
      artifactId: frozen.artifactId,
      artifactVersion: frozen.envelope.artifactVersion ?? 0,
    };
    let entry;
    try {
      entry = this.store.get(ref);
    } catch (error) {
      if (error instanceof P2Error) {
        return false;
      }
      throw error;
    }
    if (entry.availability !== "ACTIVE") {
      return false;
    }
    if (entry.artifact !== artifact && JSON.stringify(entry.artifact) !== JSON.stringify(frozen)) {
      return false;
    }
    // Only a strictly higher version of the same artifactId makes this entry
    // non-latest; keeping older versions is normal and never a rejection.
    const currentVersion = frozen.envelope.artifactVersion ?? 0;
    if (
      this.store
        .snapshot()
        .some(
          (row) =>
            row.artifact.artifactId === frozen.artifactId &&
            (row.artifact.envelope.artifactVersion ?? 0) > currentVersion,
        )
    ) {
      return false;
    }

    const contract = this.ledger.snapshot();
    const sourceTask = contract.tasks.find((task) => task.taskId === frozen.envelope.taskId);
    if (sourceTask === undefined || sourceTask.delivery !== "DELIVERED") {
      return false;
    }
    if (obligationId !== sourceTask.obligationId) {
      return false;
    }
    const obligation = contract.obligations.find((row) => row.obligationId === obligationId);
    if (obligation === undefined) {
      return false;
    }
    if (obligation.status === "BLOCKED" || obligation.status === "SATISFIED") {
      return false;
    }
    if (obligation.envelope.scopeId !== sourceTask.scopeId) {
      return false;
    }
    if (!packet.pendingObligations.includes(obligationId)) {
      return false;
    }

    const sourceRoute = this.forTask(sourceTask);
    if (sourceRoute.routeId !== frozen.routeId) {
      return false;
    }
    if (!this.store.routesSnapshot().some((route) => route.routeId === sourceRoute.routeId)) {
      return false;
    }

    const taskId = `dep-task-${frozen.sourceRequestId}`;
    if ([...taskId].length > MAX_TASK_ID_CHARS) {
      return false;
    }
    if (contract.tasks.some((task) => task.taskId === taskId)) {
      return false;
    }
    if (this.dependencies.some((row) => row.provenance.sourceRequestId === frozen.sourceRequestId)) {
      return false;
    }
    const eventSeq = this.ledger.nextEventSeq();
    const sessionId = contract.envelope.sessionId;
    const newTask: P2Task = p2Snapshot({
      envelope: {
        ...sourceTask.envelope,
        recordId: `${sessionId}:m1:dep-task:${frozen.sourceRequestId}`,
        taskId,
        eventSeq,
      },
      taskId,
      goalId: sourceTask.goalId,
      obligationId: sourceTask.obligationId,
      scopeId: sourceTask.scopeId,
      inputArtifactRefs: [],
      dependencyTaskIds: [sourceTask.taskId],
      expectedResult: sourceTask.expectedResult,
      acceptanceCriteria: sourceTask.acceptanceCriteria,
      delivery: "READY",
    }) as P2Task;

    const prospective = p2Snapshot({
      ...contract,
      tasks: [...contract.tasks, newTask],
    });
    try {
      this.ledger.validateTaskAddition([newTask]);
      this.store.validateAddedTasks(prospective);
    } catch (error) {
      if (error instanceof P2Error) {
        return false;
      }
      throw error;
    }

    const provenance: AgentDependencyProvenance = p2Snapshot({
      sourceRequestId: frozen.sourceRequestId,
      sourceArtifactRef: ref,
      obligationId,
      routeSignature: sourceRoute.signature,
    }) as AgentDependencyProvenance;

    // No asynchronous gap: every mutation below uses the already validated
    // frozen values and cannot fail. No route is registered and no source
    // artifact is relabelled.
    this.ledger.addTasks([newTask]);
    this.store.syncAddedTasks(this.ledger.snapshot());
    this.taskRoutes.set(taskId, p2Snapshot({
      taskId,
      routeId: sourceRoute.routeId,
      provenance: null,
    }) as AgentTaskRoute);
    this.dependencies.push(p2Snapshot({
      taskId,
      routeId: sourceRoute.routeId,
      provenance,
    }) as AgentRouteAdmission);
    return true;
  }

  /**
   * Admit one dynamic route from a real COMPLETE v2 artifact.
   *
   * Every check runs before the first mutation. A rejected proposal returns
   * `false` and leaves the ledger, store, routes and mappings untouched; the
   * already accepted artifact and candidate are preserved.
   */
  admit(
    artifact: P2Artifact,
    remainingCalls: number,
    maxReviews: number,
    remainingWorkUnits: number,
    remainingMs: number,
  ): boolean {
    if (!this.canAdmit(remainingCalls, maxReviews, remainingWorkUnits, remainingMs)) {
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
    if (packet === null || packet.schemaVersion !== "p2a-work-v2") {
      return false;
    }
    const proposal = (packet as P2WorkPacketV2).workflowProposal;
    if (proposal === null || !isPlainObject(proposal)) {
      return false;
    }
    if (proposal.kind !== "NEW_ROUTE") {
      return false;
    }
    if (typeof proposal.rationale !== "string" || proposal.rationale.trim().length === 0) {
      return false;
    }
    const obligationId = proposal.obligationId;
    if (typeof obligationId !== "string" || obligationId.trim().length === 0) {
      return false;
    }
    const mechanism = proposal.mechanism;
    if (!isPlainObject(mechanism)) {
      return false;
    }

    // The artifact must be the real ACTIVE entry of the store, not a copy.
    const ref: P2ArtifactRef = {
      artifactId: frozen.artifactId,
      artifactVersion: frozen.envelope.artifactVersion ?? 0,
    };
    let entry;
    try {
      entry = this.store.get(ref);
    } catch (error) {
      if (error instanceof P2Error) {
        return false;
      }
      throw error;
    }
    if (entry.availability !== "ACTIVE") {
      return false;
    }
    if (entry.artifact !== artifact && JSON.stringify(entry.artifact) !== JSON.stringify(frozen)) {
      return false;
    }

    const contract = this.ledger.snapshot();
    const sourceTask = contract.tasks.find((task) => task.taskId === frozen.envelope.taskId);
    if (sourceTask === undefined || sourceTask.delivery !== "DELIVERED") {
      return false;
    }
    if (obligationId !== sourceTask.obligationId) {
      return false;
    }
    const obligation = contract.obligations.find((row) => row.obligationId === obligationId);
    if (obligation === undefined) {
      return false;
    }
    if (obligation.status === "BLOCKED" || obligation.status === "SATISFIED") {
      return false;
    }
    if (obligation.envelope.scopeId !== sourceTask.scopeId) {
      return false;
    }
    if (!packet.pendingObligations.includes(obligationId)) {
      return false;
    }

    // The target task template is a real trusted task of that obligation.
    const template = contract.tasks.find((task) => task.taskId === obligation.envelope.taskId);
    if (template === undefined) {
      return false;
    }
    if (template.scopeId !== sourceTask.scopeId) {
      return false;
    }

    const sourceRoute = this.forTask(sourceTask);
    if (sourceRoute.routeId !== frozen.routeId) {
      return false;
    }

    // Pure pre-check of the prospective route against the real registry.
    const probe = new P2RouteRegistry();
    for (const existing of this.store.routesSnapshot()) {
      try {
        probe.register({
          routeId: existing.routeId,
          representation: existing.representation,
          operation: existing.operation,
          lemmas: existing.lemmas,
          construction: existing.construction,
        });
      } catch (error) {
        if (error instanceof P2Error) {
          return false;
        }
        throw error;
      }
    }
    let signature: string;
    let routeInput: P2RouteInput;
    try {
      routeInput = {
        routeId: "probe",
        representation: mechanism.representation as string,
        operation: mechanism.operation as string,
        lemmas: mechanism.lemmas as readonly string[],
        construction: mechanism.construction as string,
      };
      signature = p2RouteSignature(routeInput);
    } catch (error) {
      if (error instanceof P2Error) {
        return false;
      }
      throw error;
    }
    if (signature === sourceRoute.signature) {
      return false;
    }
    const routeId = routeIdOf(signature);
    if (this.store.routesSnapshot().some((route) => route.routeId === routeId)) {
      return false;
    }
    let spec: P2RouteSpec;
    try {
      spec = probe.register({ ...routeInput, routeId });
    } catch (error) {
      if (error instanceof P2Error) {
        return false;
      }
      throw error;
    }
    // Compare the registered spec's mechanism fields: the registry normalizes
    // whitespace only, so this rejects a proposal that differs from the source
    // route by whitespace alone. It is not a mathematical independence proof.
    if (
      spec.operation === sourceRoute.operation &&
      spec.construction === sourceRoute.construction
    ) {
      return false;
    }

    const taskId = `route-task-${frozen.sourceRequestId}`;
    if ([...taskId].length > MAX_TASK_ID_CHARS) {
      return false;
    }
    if (contract.tasks.some((task) => task.taskId === taskId)) {
      return false;
    }
    const eventSeq = this.ledger.nextEventSeq();
    const sessionId = contract.envelope.sessionId;
    const newTask: P2Task = p2Snapshot({
      envelope: {
        ...template.envelope,
        recordId: `${sessionId}:m1:route-task:${frozen.sourceRequestId}`,
        taskId,
        eventSeq,
      },
      taskId,
      goalId: template.goalId,
      obligationId: template.obligationId,
      scopeId: template.scopeId,
      inputArtifactRefs: [],
      dependencyTaskIds: [],
      expectedResult: template.expectedResult,
      acceptanceCriteria: template.acceptanceCriteria,
      delivery: "READY",
    }) as P2Task;

    const prospective = p2Snapshot({
      ...contract,
      tasks: [...contract.tasks, newTask],
    });
    try {
      this.ledger.validateTaskAddition([newTask]);
      this.store.validateAddedTasks(prospective);
    } catch (error) {
      if (error instanceof P2Error) {
        return false;
      }
      throw error;
    }

    const provenance: AgentRouteProvenance = p2Snapshot({
      sourceRequestId: frozen.sourceRequestId,
      sourceArtifactRef: ref,
      obligationId,
      routeSignature: signature,
    }) as AgentRouteProvenance;

    // No asynchronous gap: every mutation below uses the already validated
    // frozen values and cannot fail.
    this.ledger.addTasks([newTask]);
    this.store.syncAddedTasks(this.ledger.snapshot());
    this.store.registerRoute({ ...routeInput, routeId });
    this.taskRoutes.set(taskId, p2Snapshot({
      taskId,
      routeId: spec.routeId,
      provenance,
    }) as AgentTaskRoute);
    this.admissions.push(p2Snapshot({
      taskId,
      routeId: spec.routeId,
      provenance,
    }) as AgentRouteAdmission);
    return true;
  }

  /** Plain-array snapshot for the private state; no Map escapes. */
  snapshot(): {
    readonly routes: readonly P2RouteSpec[];
    readonly taskRoutes: readonly AgentTaskRoute[];
    readonly routeAdmissions: readonly AgentRouteAdmission[];
    readonly dependencyAdmissions: readonly AgentRouteAdmission[];
  } {
    return p2Snapshot({
      routes: this.store.routesSnapshot(),
      taskRoutes: [...this.taskRoutes.values()],
      routeAdmissions: [...this.admissions],
      dependencyAdmissions: [...this.dependencies],
    });
  }
}
