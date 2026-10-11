/**
 * @astra/stdio-runtime — P2 local Host work-unit composition (pure, no I/O).
 *
 * Composes the accepted M1 contract compiler, M3 context preparation and the
 * versioned artifact store into one single-work-unit flow. Every candidate is
 * a proposal only: nothing here is mathematical acceptance, no obligation is
 * ever SATISFIED and no model call is issued.
 */
import {
  P2Error,
  p2Snapshot,
  type P2Artifact,
  type P2Contract,
  type P2MethodCatalog,
  type P2MethodLoad,
  type P2RouteSpec,
  type P2Task,
  type P2TransportStatus,
} from "@astra/protocol";
import { compileP2Contract } from "@astra/math-contract";
import { ContractLedger } from "@astra/math-contract";
import {
  P2WorkunitStore,
  prepareP2Context,
  type P2ArtifactEntry,
  type P2PreparedContext,
} from "@astra/math-workunit";
import { P2MethodSession } from "@astra/runtime-core";
import { chooseP2ReadyTask } from "@astra/math-gateway";

const FRAME_BUDGET = 65536;
const RESERVE_BYTES = 1024;
const REQUEST_ID_PATTERN = /^model-[1-3]$/;

export class P2HostWork {
  public readonly contract: P2Contract;
  public readonly route: P2RouteSpec;
  public methodStatus: "NONE" | "LOADED" | "REFUSED" = "NONE";
  public deliveryStatus = "NONE";

  private readonly ledger: ContractLedger;
  private readonly store: P2WorkunitStore;
  private currentTask: P2Task;
  private requestId = "model-1";
  private unitIndex = 1;
  private prepared: P2PreparedContext | null = null;
  private canAdvance = false;
  private methodSession: P2MethodSession | null = null;
  private catalogValue: P2MethodCatalog | null = null;
  private loadValue: P2MethodLoad = { status: "disabled", asset: null };

  constructor(problem: string, sessionId: string, problemHash: string) {
    this.contract = compileP2Contract(problem, sessionId);
    if (this.contract.problemHash !== problemHash) throw new P2Error("PACKET_BINDING");
    this.ledger = new ContractLedger(this.contract);
    this.store = new P2WorkunitStore(this.contract);
    const next = chooseP2ReadyTask(this.ledger.snapshot(), this.ledger.readyTasks());
    if (next === null) throw new P2Error("BOUND_EXCEEDED");
    this.currentTask = this.ledger.startTask(next.taskId);
    this.route = this.store.registerRoute({
      routeId: "route-1",
      representation: "original-problem",
      operation: "direct-reasoning",
      lemmas: [],
      construction: "single-workunit",
    });
  }

  /** Frozen copy of the currently RUNNING task; no live reference escapes. */
  get task(): P2Task {
    return p2Snapshot(this.currentTask);
  }

  setCatalog(catalog: P2MethodCatalog): void {
    this.catalogValue = p2Snapshot(catalog);
    this.methodSession = new P2MethodSession(
      { catalog: () => this.catalogValue as P2MethodCatalog, load: () => this.loadValue },
      1,
      12000,
    );
  }

  canLoad(id: string): boolean {
    if (this.methodSession === null) return false;
    try {
      const entries = this.methodSession.catalog().entries;
      return entries.some((entry) => entry.id === id);
    } catch {
      return false;
    }
  }

  refuseMethod(): void {
    this.methodStatus = "REFUSED";
  }

  acceptMethod(id: string, result: P2MethodLoad): void {
    this.loadValue = p2Snapshot(result);
    const base = prepareP2Context(
      this.ledger.snapshot(),
      this.currentTask,
      this.route,
      this.requestId,
      [],
      [],
      [],
    );
    const budget = Math.max(0, Math.floor((FRAME_BUDGET - base.contextBytes - RESERVE_BYTES) / 2));
    if (this.methodSession === null) {
      this.methodStatus = "REFUSED";
      return;
    }
    const use = this.methodSession.load(id, budget);
    this.methodStatus = use.status === "loaded" ? "LOADED" : "REFUSED";
  }

  /**
   * Build the fixed messages for the current unit. The request id must be the
   * next sequential `model-N` (1..3) and must match the artifact count, so a
   * rejected or unknown call can never be silently re-prepared.
   */
  prepare(requestId: string = this.requestId): P2PreparedContext {
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
      throw new P2Error("PACKET_BINDING");
    }
    const index = Number.parseInt(requestId.slice("model-".length), 10);
    if (index !== this.store.snapshot().length + 1) throw new P2Error("PACKET_BINDING");
    const inputs: P2Artifact[] = [];
    for (const ref of this.currentTask.inputArtifactRefs) {
      const entry = this.store.get(ref);
      if (entry.availability !== "ACTIVE") throw new P2Error("STALE_DEPENDENCY");
      inputs.push(entry.artifact);
    }
    const catalog = this.methodSession === null ? [] : this.methodSession.catalog().entries;
    const assets = this.methodSession === null ? [] : this.methodSession.assetsSnapshot();
    const prepared = prepareP2Context(
      this.ledger.snapshot(),
      this.currentTask,
      this.route,
      requestId,
      inputs,
      catalog,
      assets,
    );
    this.requestId = requestId;
    this.unitIndex = index;
    this.prepared = p2Snapshot(prepared);
    return this.prepared;
  }

  privateContext(): P2PreparedContext | null {
    return this.prepared;
  }

  accept(transport: P2TransportStatus, text: string, requestId: string = this.requestId): void {
    if (this.prepared === null) throw new P2Error("PACKET_DELIVERY");
    if (requestId !== this.requestId) throw new P2Error("PACKET_BINDING");
    const eventSeq = this.ledger.nextEventSeq();
    const artifact = this.store.accept(this.currentTask, {
      artifactId: `artifact-${this.unitIndex}`,
      routeId: this.route.routeId,
      sourceRequestId: this.requestId,
      transportStatus: transport,
      text,
      eventSeq,
      supersedes: null,
    });
    const status = artifact.deliveryStatus === "COMPLETE" ? "DELIVERED" : "PARTIAL";
    this.ledger.recordDelivery(
      this.currentTask.taskId,
      { artifactId: artifact.artifactId, artifactVersion: artifact.envelope.artifactVersion ?? 0 },
      status,
      eventSeq,
    );
    this.deliveryStatus = artifact.deliveryStatus;
    this.canAdvance = artifact.deliveryStatus === "COMPLETE";
  }

  /**
   * Advance to the next ready unit after a COMPLETE delivery. A partial or
   * failed delivery never advances and never retries the same task.
   */
  advance(): boolean {
    if (!this.canAdvance) return false;
    const next = chooseP2ReadyTask(this.ledger.snapshot(), this.ledger.readyTasks());
    if (next === null) return false;
    this.currentTask = this.ledger.startTask(next.taskId);
    this.prepared = null;
    this.canAdvance = false;
    return true;
  }

  /**
   * Mark the latest artifact version STALE. Used when the deadline is already
   * inside the reserve window after a late result: the artifact stays recorded
   * but can no longer be read as a current candidate.
   */
  invalidateLatest(): void {
    this.canAdvance = false;
    const latest = this.store.snapshot().at(-1);
    if (latest === undefined) return;
    this.store.invalidate({
      artifactId: latest.artifact.artifactId,
      artifactVersion: latest.artifact.envelope.artifactVersion ?? 0,
    });
  }

  summary(modelCalls: number, methodLoads: number): Record<string, unknown> {
    const entries = this.store.snapshot();
    const selected = this.selectCandidate(entries);
    const candidate = selected === null ? null : this.store.candidate(selected.ref);
    const openObligations = this.ledger
      .snapshot()
      .obligations.filter((obligation) => obligation.status !== "SATISFIED").length;
    return {
      status: candidate === null ? "unsolved" : "candidate",
      finalResponse: candidate ?? "Unsolved in offline work unit.",
      candidateRequestId: selected === null ? null : selected.artifact.sourceRequestId,
      candidateVerified: false,
      strictAcceptance: "NOT_PERFORMED",
      mode: "MOCK_ONLY",
      modelCalls,
      methodLoads,
      methodStatus: this.methodStatus,
      deliveryStatus: this.deliveryStatus,
      artifactCount: entries.length,
      openObligations,
      contextHash: this.prepared === null ? null : this.prepared.contextHash,
    };
  }

  /** Frozen real ledger/store view for local acceptance; never sent on the wire. */
  privateSnapshot(): { contract: P2Contract; artifacts: readonly P2ArtifactEntry[] } {
    return p2Snapshot({ contract: this.ledger.snapshot(), artifacts: this.store.snapshot() });
  }

  /**
   * First ACTIVE artifact in insertion order whose task obligation is a
   * candidate-bearing kind and whose stored candidate is non-null. An earlier
   * complete candidate is protected even after a later partial delivery.
   */
  private selectCandidate(
    entries: readonly P2ArtifactEntry[],
  ): { ref: { artifactId: string; artifactVersion: number }; artifact: P2Artifact } | null {
    const obligations = new Map(
      this.ledger.snapshot().obligations.map((entry) => [entry.obligationId, entry]),
    );
    const tasks = new Map(this.ledger.snapshot().tasks.map((entry) => [entry.taskId, entry]));
    for (const entry of entries) {
      if (entry.availability !== "ACTIVE") continue;
      const artifact = entry.artifact;
      const taskId = artifact.envelope.taskId;
      if (taskId === undefined) continue;
      const task = tasks.get(taskId);
      if (task === undefined) continue;
      const obligation = obligations.get(task.obligationId);
      if (obligation === undefined) continue;
      if (obligation.kind !== "CANDIDATE_VALIDITY" && obligation.kind !== "ANSWER_REQUEST") continue;
      const ref = {
        artifactId: artifact.artifactId,
        artifactVersion: artifact.envelope.artifactVersion ?? 0,
      };
      if (this.store.candidate(ref) === null) continue;
      return { ref, artifact };
    }
    return null;
  }
}
