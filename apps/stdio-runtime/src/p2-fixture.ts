/**
 * @astra/stdio-runtime — P2-A offline fixture composition root.
 *
 * Synchronous, in-memory composition of M1 (contract/ledger), M3 (context)
 * and runtime-core (method session). It is not a client: no network, no tool
 * execution, no filesystem access. Every candidate stays unverified.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  p2Snapshot,
  type P2Artifact,
  type P2ArtifactRef,
  type P2Contract,
  type P2ErrorCode,
  type P2MethodUse,
  type P2PacketDelivery,
  type P2Task,
} from "@astra/protocol";
import { ContractLedger } from "@astra/math-contract";
import { P2MethodSession } from "@astra/runtime-core";
import { P2WorkunitStore, prepareP2Context } from "@astra/math-workunit";
import {
  validateP2FixtureUnits,
  type P2FixtureOptions,
  type P2FixtureRequest,
  type P2FixtureResult,
  type P2FixtureStop,
  type P2FixtureTrace,
  type P2FixtureUnit,
} from "./p2-fixture-types.js";

export type {
  P2FixtureOptions,
  P2FixturePrivateState,
  P2FixtureRequest,
  P2FixtureResult,
  P2FixtureStop,
  P2FixtureSummary,
  P2FixtureTrace,
  P2FixtureUnit,
} from "./p2-fixture-types.js";

const RESERVE_MS = 25;
const CONTEXT_BUDGET = 65536;
const CONTEXT_SLACK = 256;
const CANDIDATE_KINDS = ["CANDIDATE_VALIDITY", "ANSWER_REQUEST"];

function finiteNow(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new P2Error(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }
  return value;
}

export function runP2Fixture(
  contract: P2Contract,
  units: readonly P2FixtureUnit[],
  options: P2FixtureOptions,
): P2FixtureResult {
  const clock = options.now ?? (() => performance.now());
  let start: number;
  try {
    start = finiteNow(clock());
  } catch {
    throw new P2Error(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }
  const list = validateP2FixtureUnits(units, options);
  const maxWorkUnits = options.maxWorkUnits;
  const remainingMs = options.remainingMs;
  const maxMethods = options.maxMethods;
  const maxMethodChars = options.maxMethodChars;
  const port = options.methodPort ?? null;
  const routes = p2Snapshot(options.routes);
  const deadline = start + remainingMs;

  let lastNow = start;
  const expired = (): boolean => {
    let value: number;
    try {
      value = clock();
    } catch {
      return true;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < lastNow) {
      return true;
    }
    lastNow = value;
    return value >= deadline - RESERVE_MS;
  };

  const ledger = new ContractLedger(contract);
  const store = new P2WorkunitStore(ledger.snapshot());
  for (const route of routes) {
    store.registerRoute(route);
  }

  const requests: P2FixtureRequest[] = [];
  const trace: P2FixtureTrace[] = [];
  let methods: P2MethodSession | null = null;
  let candidate: string | null = null;
  let stop: P2FixtureStop = "BUDGET_EXHAUSTED";

  const finish = (): P2FixtureResult => {
    const summary = p2Snapshot({
      mode: "MOCK_ONLY" as const,
      targetEnvironment: "TARGET_UNVERIFIED" as const,
      status: candidate === null ? ("unsolved" as const) : ("candidate" as const),
      candidateProposal: candidate,
      candidateVerified: false as const,
      strictAcceptance: "NOT_PERFORMED" as const,
      stopReason: stop,
      fixtureReceiptsConsumed: requests.length,
      methodLoadAttempts: methods === null ? 0 : methods.loadAttempts(),
      trace,
    });
    const privateState = p2Snapshot({
      contract: ledger.snapshot(),
      artifacts: store.snapshot(),
      requests,
    });
    return p2Snapshot({ summary, privateState }) as P2FixtureResult;
  };

  for (let index = 0; index < maxWorkUnits; index += 1) {
    if (expired()) {
      stop = "DEADLINE_EXCEEDED";
      return finish();
    }
    const unit = list[index];
    if (unit === undefined) {
      stop = "FIXTURE_EXHAUSTED";
      return finish();
    }
    const ready = ledger.readyTasks().find((task) => task.taskId === unit.taskId);
    const route = store.routesSnapshot().find((spec) => spec.routeId === unit.routeId);
    if (ready === undefined || route === undefined) {
      stop = "TASK_NOT_READY";
      return finish();
    }
    const task: P2Task = ledger.startTask(unit.taskId);
    const inputs: P2Artifact[] = [];
    for (const ref of task.inputArtifactRefs) {
      const entry = store.get(ref);
      if (entry.availability !== "ACTIVE") {
        stop = "TASK_NOT_READY";
        return finish();
      }
      inputs.push(entry.artifact);
    }
    const requestId = `fixture-${index + 1}`;
    const build = (): ReturnType<typeof prepareP2Context> =>
      prepareP2Context(
        ledger.snapshot(),
        task,
        route,
        requestId,
        inputs,
        methods === null ? [] : methods.catalog().entries,
        methods === null ? [] : methods.assetsSnapshot(),
      );
    let prepared: ReturnType<typeof prepareP2Context>;
    try {
      prepared = build();
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      stop = "CONTEXT_TOO_LARGE";
      return finish();
    }
    const uses: P2MethodUse[] = [];
    for (const methodId of unit.methodIds) {
      if (expired()) {
        stop = "DEADLINE_EXCEEDED";
        return finish();
      }
      if (methods === null) {
        methods = new P2MethodSession(port, maxMethods, maxMethodChars);
        if (expired()) {
          stop = "DEADLINE_EXCEEDED";
          return finish();
        }
      }
      const budget = Math.max(0, Math.floor((CONTEXT_BUDGET - prepared.contextBytes - CONTEXT_SLACK) / 2));
      const use = methods.load(methodId, budget);
      uses.push(use);
      if (expired()) {
        stop = "DEADLINE_EXCEEDED";
        return finish();
      }
      try {
        prepared = build();
      } catch (error) {
        if (!(error instanceof P2Error)) {
          throw error;
        }
        stop = "CONTEXT_TOO_LARGE";
        return finish();
      }
    }
    if (expired()) {
      stop = "DEADLINE_EXCEEDED";
      return finish();
    }
    const base: P2FixtureRequest = {
      ...prepared,
      requestId,
      taskId: task.taskId,
      methodUses: uses,
      transportStatus: unit.transportStatus,
      rawResponseText: unit.text,
      artifactRef: null,
      errorCode: null,
    };
    requests.push(base);
    const seq = ledger.nextEventSeq();
    let artifact: P2Artifact;
    try {
      artifact = store.accept(task, {
        artifactId: `fixture-artifact-${index + 1}`,
        routeId: unit.routeId,
        sourceRequestId: requestId,
        transportStatus: unit.transportStatus,
        text: unit.text,
        eventSeq: seq,
        supersedes: null,
      });
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      const code: P2ErrorCode = error.code;
      requests[requests.length - 1] = { ...base, errorCode: code };
      trace.push({ unit: index, requestId, deliveryStatus: "REJECTED", code });
      ledger.blockObligation(task.obligationId);
      stop = "PACKET_REJECTED";
      return finish();
    }
    const ref: P2ArtifactRef = { artifactId: artifact.artifactId, artifactVersion: artifact.envelope.artifactVersion ?? 1 };
    const delivery: P2PacketDelivery = artifact.deliveryStatus;
    ledger.recordDelivery(task.taskId, ref, delivery === "COMPLETE" ? "DELIVERED" : "PARTIAL", seq);
    requests[requests.length - 1] = { ...base, artifactRef: ref };
    trace.push({ unit: index, requestId, deliveryStatus: delivery, code: null });
    if (expired()) {
      store.invalidate(ref);
      trace[trace.length - 1] = { unit: index, requestId, deliveryStatus: delivery, code: P2_ERROR_CODES.DEADLINE_EXCEEDED };
      stop = "DEADLINE_EXCEEDED";
      return finish();
    }
    if (candidate === null) {
      const proposal = store.candidate(ref);
      const obligation = ledger.snapshot().obligations.find((row) => row.obligationId === task.obligationId);
      if (proposal !== null && obligation !== undefined && (CANDIDATE_KINDS as readonly string[]).includes(obligation.kind)) {
        candidate = proposal;
      }
    }
    if (unit.transportStatus === "UNKNOWN" || unit.transportStatus === "ERROR") {
      stop = "TRANSPORT_STOP";
      return finish();
    }
  }
  return finish();
}
