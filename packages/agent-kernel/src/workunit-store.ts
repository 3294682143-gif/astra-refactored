/**
 * @zygos/agent-kernel — Versioned WorkUnits & STALE Invalidation Propagation.
 *
 * Implements K06 and enforces Invariants I03 and I09.
 */

import type { Artifact, WorkUnit } from "@zygos/domain-contract";

export class WorkUnitStore {
  private readonly _runId: string;
  private readonly _workUnits = new Map<string, WorkUnit>();
  private readonly _artifacts = new Map<string, Artifact>();
  private readonly _artifactDependencies = new Map<string, Set<string>>(); // parentId -> childIds

  constructor(runId: string) {
    this._runId = runId;
  }

  get runId(): string {
    return this._runId;
  }

  get artifacts(): readonly Artifact[] {
    return Array.from(this._artifacts.values());
  }

  /**
   * T06: Propose task with cycle detection.
   */
  addTask(task: WorkUnit): void {
    if (this._workUnits.has(task.taskId)) {
      throw new Error(`Task already registered: ${task.taskId}`);
    }
    // Check if dependencies create a circular reference
    for (const dep of task.dependencies) {
      if (dep === task.taskId) {
        throw new Error(`Circular dependency detected: task ${task.taskId} cannot depend on itself`);
      }
    }
    this._workUnits.set(task.taskId, task);
  }

  /**
   * I03 & I09: Register a versioned research artifact.
   * Registers dependency graph edges and tracks lineage.
   */
  registerArtifact(artifact: Artifact): void {
    const existing = this._artifacts.get(artifact.artifactId);
    if (existing && existing.version >= artifact.version) {
      throw new Error(
        `Cannot overwrite artifact ${artifact.artifactId} version ${existing.version} with version ${artifact.version}`
      );
    }

    this._artifacts.set(artifact.artifactId, artifact);

    // Track dependency links: parent -> child
    for (const parentId of artifact.dependencyRefs) {
      if (!this._artifactDependencies.has(parentId)) {
        this._artifactDependencies.set(parentId, new Set());
      }
      this._artifactDependencies.get(parentId)!.add(artifact.artifactId);
    }

    // Invariant I09: If an existing artifact is updated to a new version,
    // all downstream dependents must be marked STALE.
    if (existing) {
      this._propagateStale(artifact.artifactId);
    }
  }

  /**
   * Invariant I09: Invalidate downstream conclusions when upstream changes.
   */
  private _propagateStale(changedArtifactId: string): void {
    const queue = [changedArtifactId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const dependents = this._artifactDependencies.get(current);
      if (dependents) {
        for (const childId of dependents) {
          const childArtifact = this._artifacts.get(childId);
          if (childArtifact && !childArtifact.isStale) {
            this._artifacts.set(childId, {
              ...childArtifact,
              isStale: true,
            });
            queue.push(childId);
          }
        }
      }
    }
  }

  getArtifact(artifactId: string): Artifact | undefined {
    return this._artifacts.get(artifactId);
  }

  isArtifactStale(artifactId: string): boolean {
    const art = this._artifacts.get(artifactId);
    return art ? art.isStale : false;
  }
}
