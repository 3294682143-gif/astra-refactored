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
  type P2RouteSpec,
  type P2Task,
} from "@astra/protocol";
import { workHash, workRefKey, workScope } from "./p2-context.js";
import { P2RouteRegistry, type P2RouteInput } from "./p2-routes.js";
import { readWorkReceipt, type P2WorkReceipt } from "./p2-receipt.js";

export type { P2WorkReceipt } from "./p2-receipt.js";

export interface P2ArtifactEntry {
  readonly artifact: P2Artifact;
  readonly availability: P2ArtifactAvailability;
}

const MAX_TASKS = P2_LIMITS.maxTasks;
const MAX_OBLIGATIONS = P2_LIMITS.maxObligations;
const MAX_ARTIFACTS = P2_LIMITS.maxArtifacts;

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
  private readonly contract: P2Contract;
  private readonly routes = new P2RouteRegistry();
  private readonly entries = new Map<string, P2ArtifactEntry>();
  private readonly latest = new Map<string, number>();
  private readonly requests = new Set<string>();
  private lastSeq: number;

  constructor(contract: P2Contract) {
    const frozen = p2Snapshot(contract) as P2Contract;
    this.lastSeq = guardContract(frozen);
    this.contract = frozen;
  }

  registerRoute(input: P2RouteInput): P2RouteSpec {
    return this.routes.register(input);
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
    const entry = p2Snapshot({ artifact, availability: "ACTIVE" }) as P2ArtifactEntry;
    if (receipt.supersedes !== null) {
      this.invalidate(receipt.supersedes);
    }
    this.entries.set(entryKey, entry);
    this.latest.set(artifact.artifactId, artifactVersion);
    this.requests.add(receipt.sourceRequestId);
    this.lastSeq = receipt.eventSeq;
    return artifact;
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
      this.entries.set(key, p2Snapshot({ artifact: entry.artifact, availability: "STALE" }) as P2ArtifactEntry);
      affected.push({ artifactId: entry.artifact.artifactId, artifactVersion: entry.artifact.envelope.artifactVersion as number });
    }
    return p2Snapshot(affected) as readonly P2ArtifactRef[];
  }
}
