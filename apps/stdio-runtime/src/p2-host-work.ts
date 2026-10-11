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
  type P2Contract,
  type P2MethodCatalog,
  type P2MethodLoad,
  type P2RouteSpec,
  type P2Task,
  type P2TransportStatus,
} from "@astra/protocol";
import { compileP2Contract } from "@astra/math-contract";
import { ContractLedger } from "@astra/math-contract";
import { P2WorkunitStore, prepareP2Context, type P2PreparedContext } from "@astra/math-workunit";
import { P2MethodSession } from "@astra/runtime-core";

const REQUEST_ID = "model-1";
const ARTIFACT_ID = "artifact-1";
const FRAME_BUDGET = 65536;
const RESERVE_BYTES = 1024;

export class P2HostWork {
  public readonly contract: P2Contract;
  public readonly task: P2Task;
  public readonly route: P2RouteSpec;
  public methodStatus: "NONE" | "LOADED" | "REFUSED" = "NONE";
  public deliveryStatus = "NONE";

  private readonly ledger: ContractLedger;
  private readonly store: P2WorkunitStore;
  private prepared: P2PreparedContext | null = null;
  private methodSession: P2MethodSession | null = null;
  private catalogValue: P2MethodCatalog | null = null;
  private loadValue: P2MethodLoad = { status: "disabled", asset: null };

  constructor(problem: string, sessionId: string, problemHash: string) {
    this.contract = compileP2Contract(problem, sessionId);
    if (this.contract.problemHash !== problemHash) throw new P2Error("PACKET_BINDING");
    this.ledger = new ContractLedger(this.contract);
    this.store = new P2WorkunitStore(this.contract);
    const ready = this.ledger.readyTasks();
    const first = ready[0];
    if (first === undefined) throw new P2Error("BOUND_EXCEEDED");
    this.task = this.ledger.startTask(first.taskId);
    this.route = this.store.registerRoute({
      routeId: "route-1",
      representation: "original-problem",
      operation: "direct-reasoning",
      lemmas: [],
      construction: "single-workunit",
    });
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
      this.task,
      this.route,
      REQUEST_ID,
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

  prepare(): P2PreparedContext {
    const catalog = this.methodSession === null ? [] : this.methodSession.catalog().entries;
    const assets = this.methodSession === null ? [] : this.methodSession.assetsSnapshot();
    const prepared = prepareP2Context(
      this.ledger.snapshot(),
      this.task,
      this.route,
      REQUEST_ID,
      [],
      catalog,
      assets,
    );
    this.prepared = p2Snapshot(prepared);
    return this.prepared;
  }

  privateContext(): P2PreparedContext | null {
    return this.prepared;
  }

  accept(transport: P2TransportStatus, text: string): void {
    if (this.prepared === null) throw new P2Error("PACKET_DELIVERY");
    const eventSeq = this.ledger.nextEventSeq();
    const artifact = this.store.accept(this.task, {
      artifactId: ARTIFACT_ID,
      routeId: this.route.routeId,
      sourceRequestId: REQUEST_ID,
      transportStatus: transport,
      text,
      eventSeq,
      supersedes: null,
    });
    const status = artifact.deliveryStatus === "COMPLETE" ? "DELIVERED" : "PARTIAL";
    this.ledger.recordDelivery(
      this.task.taskId,
      { artifactId: artifact.artifactId, artifactVersion: artifact.envelope.artifactVersion ?? 0 },
      status,
      eventSeq,
    );
    this.deliveryStatus = artifact.deliveryStatus;
  }

  /**
   * Mark the latest artifact version STALE. Used when the deadline is already
   * inside the reserve window after a late result: the artifact stays recorded
   * but can no longer be read as a current candidate.
   */
  invalidateLatest(): void {
    const latest = this.store.snapshot().at(-1);
    if (latest === undefined) return;
    this.store.invalidate({
      artifactId: latest.artifact.artifactId,
      artifactVersion: latest.artifact.envelope.artifactVersion ?? 0,
    });
  }

  summary(modelCalls: number, methodLoads: number): Record<string, unknown> {
    const entries = this.store.snapshot();
    const latest = entries.at(-1) ?? null;
    const ref =
      latest === null
        ? null
        : {
            artifactId: latest.artifact.artifactId,
            artifactVersion: latest.artifact.envelope.artifactVersion ?? 0,
          };
    const candidate = ref === null ? null : this.candidateOf(ref);
    const openObligations = this.ledger
      .snapshot()
      .obligations.filter((obligation) => obligation.status !== "SATISFIED").length;
    return {
      status: candidate === null ? "unsolved" : "candidate",
      finalResponse: candidate ?? "Unsolved in offline work unit.",
      candidateVerified: false,
      strictAcceptance: "NOT_PERFORMED",
      mode: "MOCK_ONLY",
      modelCalls,
      methodLoads,
      methodStatus: this.methodStatus,
      deliveryStatus: this.deliveryStatus,
      artifactCount: entries.length === 0 ? 0 : 1,
      openObligations,
      contextHash: this.prepared === null ? null : this.prepared.contextHash,
    };
  }

  private candidateOf(ref: { artifactId: string; artifactVersion: number }): string | null {
    const obligation = this.ledger
      .snapshot()
      .obligations.find((item) => item.obligationId === this.task.obligationId);
    if (obligation === undefined) return null;
    if (obligation.kind !== "CANDIDATE_VALIDITY" && obligation.kind !== "ANSWER_REQUEST") {
      return null;
    }
    return this.store.candidate(ref);
  }
}
