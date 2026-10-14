/**
 * @astra/stdio-runtime — unified AgentLoop composition root (async, injected ports).
 *
 * One root AgentSession owns the single deadline, the global model/effect
 * counters and the trace; one P4RecheckModelGate owns the sequential model
 * ledger across every work unit, tool and R2 review. The injected async ports
 * are the only model/effect entry points. No fixture, no prefilled receipts,
 * no Python, no retry. This module performs no direct I/O of its own: every
 * model/effect call goes through the captured ports. Every candidate stays
 * unverified.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  p2AnswerObligationForGoal,
  p2IsAnswerObligationKindForGoal,
  p2Snapshot,
  p4Hash,
  p4Target,
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentLoopSummary,
  type AgentPorts,
  type AgentTraceCode,
  type P2Artifact,
  type P2ArtifactRef,
  type P2GoalKind,
  type P2ObligationKind,
  type P2MethodAsset,
  type P2MethodCatalog,
  type P2Task,
  type P3Action,
  type P3EffectReceipt,
  type P4Challenge,
  type P4DeliveryPolicy,
  type P4ReviseBasis,
  type P4S1Assessment,
  type P4Target,
} from "@astra/protocol";
import type {
  AgentModelReceipt,
  AgentModelRequest,
  P2Contract,
  P4R0RevisionTrigger,
} from "@astra/protocol";
import { ContractLedger, P4R0PlanRevisionSession, compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import {
  P3EffectGate,
  P4RecheckModelGate,
  chooseP2ReadyTask,
  monotonicToolGuard,
  parseP3Action,
  p3EffectKey,
} from "@astra/math-gateway";
import { P2WorkunitStore } from "@astra/math-workunit";
import { P4R0ReviewSession, P4ReviewSession } from "@astra/math-review";
import { P4CandidateGate, P4DiagnosticLedger, p4CheckedPropertyForTool, reviseCandidate } from "@astra/math-audit";
import { AgentSession, SessionLog, SESSION_LOG_KIND, p3MethodCatalog, readAsset } from "@astra/runtime-core";
import { AgentCalls } from "./agent-loop-calls.js";
import { projectProtectedFinal, validateAgentFinal } from "./agent-final.js";
import { buildAgentWorkContext } from "./agent-loop-context.js";
import { AgentWorkflowRoutes } from "./agent-workflow.js";
import { AgentRevisionAdmission } from "./agent-revision.js";
import { AgentProgressPolicy } from "./agent-progress.js";
import {
  boundedAwait,
  captureAgentOptions,
  captureAgentPorts,
  checkedAgentReceipt,
  deriveRootBudget,
  type CapturedAgentOptions,
  type CapturedAgentPorts,
} from "./agent-loop-io.js";

const MIN_MS = 25;

/**
 * B2 (DECISION-0150): auxiliary (non-answer) obligations whose open state must
 * be reported honestly. A proof's `PREMISES` (E05) and an optimization's
 * `ATTAINMENT` (E06) never carry the whole-problem candidate, but while they
 * are unclosed the delivered candidate stays unverified. The frozen
 * `P2_ANSWER_OBLIGATION_BY_GOAL` authority is untouched.
 */
const AUX_OBLIGATION_KINDS: readonly P2ObligationKind[] = ["PREMISES", "ATTAINMENT"];

/**
 * The declared goal kind of one goal id, or `UNKNOWN` when the goal is not
 * part of the trusted contract. The goal tree is walked read-only; nothing
 * here is a mathematical decision.
 */
function goalKindOf(
  goals: readonly { readonly goalId: string; readonly kind: P2GoalKind; readonly subgoals: readonly unknown[] }[],
  goalId: string,
): P2GoalKind {
  for (const goal of goals) {
    if (goal.goalId === goalId) {
      return goal.kind;
    }
    const nested = goalKindOf(
      goal.subgoals as readonly { readonly goalId: string; readonly kind: P2GoalKind; readonly subgoals: readonly unknown[] }[],
      goalId,
    );
    if (nested !== "UNKNOWN") {
      return nested;
    }
  }
  return "UNKNOWN";
}

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function boundedProblem(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > 8192) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

function boundedSession(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > 128) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

/**
 * B3 (DECISION-0150): the trusted parameter branches of a PARAMETER goal, or
 * an empty list for a non-PARAMETER (or unknown) goal. These are the bounded
 * trusted gap source for the multi-gap REPAIR flagship: a revised child must
 * restate every trusted branch or the revision fails closed.
 */
function parameterGapsOf(
  goals: readonly {
    readonly goalId: string;
    readonly kind: P2GoalKind;
    readonly scope?: { readonly branchConditions?: readonly string[] };
    readonly subgoals: readonly unknown[];
  }[],
  goalId: string,
): readonly string[] {
  for (const goal of goals) {
    if (goal.goalId === goalId) {
      return goal.kind === "PARAMETER" ? (goal.scope?.branchConditions ?? []) : [];
    }
    const nested = parameterGapsOf(goal.subgoals as never, goalId);
    if (nested.length > 0) {
      return nested;
    }
  }
  return [];
}

/**
 * B1 (DECISION-0150): dispatch one R0 planning-review model call through the
 * injected model port using only the shared root budget. R0 has no work task,
 * so it bypasses the P4RecheckModelGate; the root still owns the ordinal and
 * the deadline. Returns an UNKNOWN receipt on any port/validation failure.
 */
async function r0Generate(
  root: AgentSession,
  ports: CapturedAgentPorts,
  sessionLog: SessionLog,
  context: {
    readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
    readonly contextHash: string;
    readonly contextBytes: number;
  },
  scopeId: string,
): Promise<AgentModelReceipt> {
  const remaining = root.remainingMs();
  if (remaining <= MIN_MS) {
    fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }
  const requestId = root.nextModelId();
  if (requestId === null) {
    fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
  }
  const request = p2Snapshot({
    sessionId: root.sessionId,
    problemHash: root.problemHash,
    requestId,
    phase: "R0" as const,
    taskId: "r0",
    scopeId,
    messages: context.messages,
    contextHash: context.contextHash,
    contextBytes: context.contextBytes,
    remainingMs: remaining,
    maxTokens: 8192 as const,
  }) as AgentModelRequest;
  sessionLog.append("MODEL_REQUEST", {
    phase: "R0",
    requestId,
    contextHash: request.contextHash,
    contextBytes: request.contextBytes,
    messages: request.messages,
  });
  root.reserveModel("R0");
  let raw: unknown;
  try {
    raw = await boundedAwait(() => ports.model.generate(request), remaining);
  } catch {
    root.settleModel(requestId, "UNKNOWN");
    return Object.freeze({ transportStatus: "UNKNOWN" as const, text: "" }) as AgentModelReceipt;
  }
  let receipt: AgentModelReceipt;
  try {
    receipt = checkedAgentReceipt(raw);
  } catch {
    root.settleModel(requestId, "UNKNOWN");
    return Object.freeze({ transportStatus: "UNKNOWN" as const, text: "" }) as AgentModelReceipt;
  }
  root.settleModel(requestId, receipt.transportStatus);
  return receipt;
}

/**
 * B1: the bounded R0 planning review. Exactly one review; on a recorded ISSUES
 * conclusion exactly one `reviseGoals` revision (contractVersion 1 -> 2). Any
 * inconclusive, unparseable or illegal path falls back to the fixed
 * deterministic template under the same root budget — never a second bump and
 * never extra planning budget.
 */
async function runBoundedR0(
  initial: P2Contract,
  root: AgentSession,
  ports: CapturedAgentPorts,
  opts: CapturedAgentOptions,
  problemText: string,
  session: string,
  sessionLog: SessionLog,
): Promise<P2Contract> {
  const fallback = (): P2Contract => compileP2Contract(problemText, session, undefined);
  try {
    if (root.stopped() || root.remainingMs() <= MIN_MS) {
      return initial;
    }
    // prepareP4R0 caps the frozen planning view at four root calls; the real
    // root budget is unchanged (R0 only ever spends the calls it actually makes).
    const r0RootCalls = Math.min(opts.maxModelCalls, 4);
    const prep = prepareP4R0(initial, {
      enabled: true,
      planningModelCalls: 1,
      remainingRootCalls: r0RootCalls,
      remainingMs: root.remainingMs(),
    });
    if (prep.action !== "REQUEST_REVIEW") {
      return initial;
    }
    const review = new P4R0ReviewSession(prep, 1);
    const admitted = review.admit(root.remainingMs(), r0RootCalls);
    const receipt = await r0Generate(root, ports, sessionLog, admitted.context, prep.target.binding.planHash);
    review.markDispatched();
    const settled = review.settle(receipt.transportStatus, receipt.text, root.remainingMs());
    if (settled.code !== "OK" || settled.report === null || settled.report.conclusion !== "ISSUES") {
      return initial;
    }
    const reviewSnapshot = review.snapshot();
    const checks = reviewSnapshot.record?.report?.checks ?? [];
    const issueDimensions = [
      ...new Set(checks.filter((row) => row.verdict === "ISSUES").map((row) => row.dimension)),
    ];
    if (issueDimensions.length === 0) {
      return initial;
    }
    const trigger = p2Snapshot({
      parent: prep.target.binding,
      reviewHash: p4Hash(JSON.stringify(reviewSnapshot)),
      issueDimensions,
      review: reviewSnapshot,
    }) as P4R0RevisionTrigger;
    const revision = new P4R0PlanRevisionSession(prep, trigger, 1);
    const rAdmitted = revision.admit(root.remainingMs(), 2, 3);
    const rReceipt = await r0Generate(root, ports, sessionLog, rAdmitted.context, prep.target.binding.planHash);
    revision.markDispatched();
    revision.settle(rReceipt.transportStatus, rReceipt.text, root.remainingMs());
    const snapshot = revision.snapshot();
    if (snapshot.revisedContract !== null) {
      // The revision session records a *proposal* against a private ledger; it
      // is not itself an activatable contract. Recompile a clean version-2
      // contract from the revised goal tree so the main ledger sees OPEN
      // obligations and READY tasks (the single bounded bump is now applied).
      const revised = compileP2Contract(
        problemText,
        session,
        snapshot.revisedContract.goals,
        snapshot.revisedContract.envelope.eventSeq,
        2,
      );
      sessionLog.append("CONTRACT_REVISED", { fromVersion: 1, toVersion: revised.contractVersion });
      return revised;
    }
    return fallback();
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    try {
      return fallback();
    } catch {
      return initial;
    }
  }
}

export async function runAgentLoop(
  problem: string,
  sessionId: string,
  options: AgentLoopOptions,
  ports: AgentPorts,
): Promise<AgentLoopResult> {
  const problemText = boundedProblem(problem);
  const session = boundedSession(sessionId);
  const opts0 = captureAgentOptions(options);
  const captured = captureAgentPorts(ports);
  const problemHash = p4Hash(problemText);
  let contract = compileP2Contract(
    problemText,
    session,
    opts0.goalSpecs.length > 0 ? opts0.goalSpecs : undefined,
  );
  // One budget, derived from the compiled task graph, is the single source.
  const derived = opts0.deriveBudget
    ? deriveRootBudget(contract.tasks.length, opts0.maxReviews)
    : null;
  const opts: CapturedAgentOptions =
    derived === null
      ? opts0
      : Object.freeze({
          ...opts0,
          maxWorkUnits: derived.maxWorkUnits,
          maxModelCalls: derived.maxModelCalls,
        });
  const root = new AgentSession({
    sessionId: session,
    problemHash,
    maxModelCalls: opts.maxModelCalls,
    maxEffects: opts.maxEffects,
    remainingMs: opts.remainingMs,
    now: opts.now,
  });
  // G4/PR5 Slice 4a: the immutable SessionLog is the single source of truth for
  // what the model saw; every model request is a deterministic projection of it.
  const sessionLog = new SessionLog();
  // G7/PR7 Slice 7d: an authenticated resume prefix is pre-seeded as
  // already-settled events, so the settled model/tool calls are never
  // re-dispatched. Absent keeps the default path byte-identical.
  if (opts.resumeSessionLog !== null && opts.resumeSessionLog.length > 0) {
    for (const row of opts.resumeSessionLog) {
      const kind = SESSION_LOG_KIND.find((candidate) => candidate === row.kind);
      if (kind === undefined) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      sessionLog.append(kind, row.data);
    }
  } else {
    sessionLog.append("SESSION_INIT", { sessionId: session, problemHash });
  }
  // B1 (DECISION-0150): the bounded, opt-in R0 planning review. It runs before
  // any WORK, shares the same root budget, and may change the contract to
  // version 2 via at most one `reviseGoals`. With the default `maxR0=0` this is
  // a no-op and the run is byte-identical to before.
  if (opts.maxR0 >= 1) {
    contract = await runBoundedR0(contract, root, captured, opts, problemText, session, sessionLog);
  }
  sessionLog.append("CONTRACT", {
    contractVersion: contract.contractVersion,
    tasks: contract.tasks.length,
    obligations: contract.obligations.length,
  });
  const ledger = new ContractLedger(contract);
  const store = new P2WorkunitStore(ledger.snapshot());
  const workflow = new AgentWorkflowRoutes(ledger, store);
  const revision = new AgentRevisionAdmission(ledger, store, (task) => workflow.forTask(task));
  const gate = new P4RecheckModelGate(
    session,
    problemHash,
    contract.contractVersion,
    opts.maxModelCalls,
    root.modelCalls(),
  );
  const calls = new AgentCalls(root, gate, captured, sessionLog);
  const progress = new AgentProgressPolicy();

  let workUnits = 0;
  let reviewCalls = 0;
  let repairCalls = 0;
  let catalogCalls = 0;
  let methodLoads = 0;
  let catalog: P2MethodCatalog | null = null;
  let methodAssets: P2MethodAsset[] = [];
  let stop: AgentTraceCode = "NO_CANDIDATE";
  let target: P4Target | null = null;
  let protectedOrigin: P4Target | null = null;
  let review: P4ReviewSession | null = null;
  let firstReviewOrdinal = 2;
  let candidateTask: P2Task | null = null;
  let revisedDecision: ReturnType<typeof reviseCandidate>["decision"] | null = null;
  let s1Assessment: P4S1Assessment | null = null;
  let s2Transaction: {
    readonly supersededObligationIds: readonly string[];
    readonly preservedObligationIds: readonly string[];
    readonly preservedParentArtifactId: string | null;
  } | null = null;

  const callsLeft = (): number => opts.maxModelCalls - root.modelCalls();
  const reserve = (): number =>
    target !== null && target.availability === "ACTIVE" && opts.maxReviews > 0 ? 1 : 0;

  const methodsEnabled =
    opts.maxMethodLoads === 1 &&
    captured.effect !== null &&
    captured.catalog !== null &&
    opts.maxEffects > 0 &&
    opts.maxModelCalls >= 2 + opts.maxReviews;
  if (methodsEnabled && root.remainingMs() > MIN_MS) {
    const readRemaining = root.remainingMs();
    let raw: unknown = null;
    try {
      raw = await boundedAwait(() => {
        catalogCalls += 1;
        return captured.catalog!.read(readRemaining);
      }, readRemaining);
    } catch {
      raw = null;
    }
    if (raw !== null) {
      try {
        catalog = p3MethodCatalog(p2Snapshot(raw));
      } catch {
        catalog = null;
      }
    }
    if (catalog === null || catalog.entries.length === 0) {
      catalog = null;
    }
  }

  try {
    while (workUnits < opts.maxWorkUnits && !root.stopped()) {
      if (callsLeft() <= reserve() || root.remainingMs() <= MIN_MS) {
        stop = root.remainingMs() <= MIN_MS ? "DEADLINE_EXCEEDED" : "BUDGET_EXHAUSTED";
        break;
      }
      const ready = ledger.readyTasks();
      const pendingRedoTaskId = revision.pendingTaskId();
      const redoReady =
        pendingRedoTaskId === null
          ? []
          : ready.filter((task) => task.taskId === pendingRedoTaskId);
      // A pending redo whose task is not genuinely READY is a control
      // inconsistency: never fall back to an unrelated ordinary task while a
      // redo is pending, because that would move other mathematical state.
      if (pendingRedoTaskId !== null && redoReady.length === 0) {
        root.stop("CONTROL_REJECTED");
        stop = "CONTROL_REJECTED";
        break;
      }
      // A dynamically admitted route task is preferred while it is genuinely
      // READY; otherwise the original ready set is used unchanged.
      const routeReady = ready.filter(
        (task) =>
          workflow.provenanceOf(task.taskId) !== null ||
          workflow.dependencyProvenanceOf(task.taskId) !== null,
      );
      const chosen = chooseP2ReadyTask(
        ledger.snapshot(),
        redoReady.length > 0 ? redoReady : routeReady.length > 0 ? routeReady : ready,
      );
      if (chosen === null) {
        stop = "WORK_UNITS_COMPLETE";
        break;
      }
      let running: P2Task;
      try {
        running = ledger.startTask(chosen.taskId);
      } catch (error) {
        if (!(error instanceof P2Error)) {
          throw error;
        }
        stop = "CONTROL_REJECTED";
        break;
      }
      const route = workflow.forTask(running);
      const observations: P3EffectReceipt[] = [];
      const seenEffectIds = new Set<string>();
      for (const item of calls.effects) {
        const receipt = item.receipt;
        if (receipt.binding.taskId !== running.taskId) {
          continue;
        }
        if (receipt.status !== "COMPLETE" && receipt.status !== "ERROR") {
          continue;
        }
        if (seenEffectIds.has(receipt.effectId)) {
          continue;
        }
        seenEffectIds.add(receipt.effectId);
        observations.push(receipt);
      }
      let subGate: P3EffectGate | null = null;
      const effectRoom = opts.maxEffects - root.effectCalls();
      if (effectRoom > 0 && captured.effect !== null) {
        subGate = new P3EffectGate(
          {
            sessionId: session,
            problemHash,
            contractVersion: contract.contractVersion,
            taskId: running.taskId,
            scopeId: running.scopeId,
          },
          effectRoom,
          root.effectCalls() + 1,
        );
      }
      let advanced = false;
      let yielded = false;
      while (!root.stopped()) {
        if (root.remainingMs() <= MIN_MS) {
          stop = "DEADLINE_EXCEEDED";
          break;
        }
        const inputs: P2Artifact[] = [];
        let inputOk = true;
        for (const ref of running.inputArtifactRefs) {
          const entry = store.get(ref);
          if (entry.availability !== "ACTIVE") {
            inputOk = false;
            break;
          }
          inputs.push(entry.artifact);
        }
        if (!inputOk) {
          stop = "CONTROL_REJECTED";
          break;
        }
        const cachedTool = observations.some(
          (item) => item.source === "PROGRAM_OBSERVATION",
        );
        const cachedMethod = observations.some(
          (item) => item.source === "METHOD_REFERENCE",
        );
        // The model reserve is never lowered by a cache hit: a later WORK and
        // the R2 review must still fit. A cache hit only keeps an action
        // advertised when the root effect room is already spent.
        const allowTools =
          subGate !== null &&
          callsLeft() >= 2 + opts.maxReviews &&
          (root.effectCalls() < opts.maxEffects || cachedTool);
        const allowMethods =
          catalog !== null &&
          subGate !== null &&
          callsLeft() >= 2 + opts.maxReviews &&
          ((methodLoads < opts.maxMethodLoads && root.effectCalls() < opts.maxEffects) ||
            cachedMethod);
        const protectedCandidate = projectProtectedFinal(ledger.snapshot(), target);
        const sameScope =
          protectedCandidate !== null &&
          protectedCandidate.binding.scopeId === running.scopeId;
        const exposedCandidate = sameScope ? protectedCandidate : null;
        const allowFinal = sameScope && callsLeft() >= 1 + opts.maxReviews;
        // The proposal flag reserves the current WORK call itself: admission
        // is only considered for the budget left after this work is received.
        const remainingCallsAfterWork = callsLeft() - 1;
        const remainingUnitsAfterWork = opts.maxWorkUnits - workUnits - 1;
        const allowRouteProposal =
          !revision.hasUsed() &&
          remainingCallsAfterWork >= 1 &&
          remainingUnitsAfterWork >= 1 &&
          workflow.canAdmit(
            remainingCallsAfterWork,
            opts.maxReviews,
            remainingUnitsAfterWork,
            root.remainingMs(),
          );
        const allowTaskContinuation =
          !revision.hasUsed() &&
          remainingCallsAfterWork >= 1 &&
          remainingUnitsAfterWork >= 1 &&
          workflow.canContinue(
            remainingCallsAfterWork,
            opts.maxReviews,
            remainingUnitsAfterWork,
            root.remainingMs(),
          );
        // The redo flag is a budget question only: a pending redo makes
        // `canRedo` false by itself, so no pending condition belongs here.
        const allowArtifactRedo =
          remainingCallsAfterWork >= 1 &&
          remainingUnitsAfterWork >= 1 &&
          revision.canRedo(
            remainingCallsAfterWork,
            opts.maxReviews,
            remainingUnitsAfterWork,
            root.remainingMs(),
          );
        const requestId = root.nextModelId();
        if (requestId === null) {
          stop = "BUDGET_EXHAUSTED";
          break;
        }
        let context: ReturnType<typeof buildAgentWorkContext>;
        try {
          // Read-only wiring of the declared scope-coverage rows of this task
          // AND of its declared upstream tasks (the tasks it consumes). A task's
          // own declaration is registered only after it runs, so in practice a
          // row is read by the downstream consumers that depend on the declaring
          // task. The rows are declared data only: they never close an
          // obligation, never change the ready set and are never a coverage
          // proof. A missing declaration is an empty list.
          const upstreamTaskIds = new Set(running.dependencyTaskIds);
          const declaredCoverage = store
            .scopeCoverageSnapshot()
            .filter((row) => row.taskId === running.taskId || upstreamTaskIds.has(row.taskId));
          context = buildAgentWorkContext({
            contract: ledger.snapshot(),
            task: running,
            route,
            requestId,
            inputs,
            toolObservations: observations,
            allowTools,
            allowMethods,
            allowFinal,
            protectedCandidate: exposedCandidate,
            catalog,
            methodAssets,
            allowRouteProposal,
            allowTaskContinuation,
            allowArtifactRedo,
            routeProvenance: workflow.provenanceOf(running.taskId),
            dependencyProvenance: workflow.dependencyProvenanceOf(running.taskId),
            revisionProvenance: revision.provenanceFor(running.taskId),
            revisionTarget: revision.targetFor(running.taskId),
            scopeCoverage: declaredCoverage,
          });
        } catch (error) {
          if (!(error instanceof P2Error)) {
            throw error;
          }
          stop = "CONTEXT_REJECTED";
          break;
        }
        const outcome = await calls.model({
          task: running,
          phase: "WORK",
          messages: context.messages,
          contextHash: context.contextHash,
          contextBytes: context.contextBytes,
        });
        if (outcome.receipt.transportStatus !== "COMPLETE") {
          // Pi truncated-tool-barrier (E08/E09): a reply that is not COMPLETE
          // never yields a tool/method action, an artifact or a candidate. An
          // explicit length/TRUNCATED is marked TRUNCATED; a missing finish
          // reason stays COMPLETENESS_UNKNOWN and conservatively bans actions.
          sessionLog.append("TRUNCATION", {
            phase: "WORK",
            transportStatus: outcome.receipt.transportStatus,
            completeness:
              outcome.receipt.transportStatus === "TRUNCATED"
                ? "TRUNCATED"
                : "COMPLETENESS_UNKNOWN",
          });
        }
        if (
          outcome.receipt.transportStatus !== "COMPLETE" ||
          outcome.code !== "WORK" ||
          root.remainingMs() <= MIN_MS
        ) {
          stop = outcome.code === "WORK" ? "DEADLINE_EXCEEDED" : outcome.code;
          break;
        }
        let action: P3Action | null = null;
        try {
          action = parseP3Action(outcome.receipt.text);
        } catch {
          action = null;
        }
        if (action !== null && (action.action === "tool" || action.action === "method")) {
          const isMethod = action.action === "method";
          const methodId = action.action === "method" ? action.id : null;
          // DSH monotonic tool-guard pipeline: pre -> guards, irreversible.
          const guard = monotonicToolGuard({
            action,
            allowTools,
            allowMethods,
            methodId,
            catalogIds: catalog === null ? [] : catalog.entries.map((entry) => entry.id),
            callsLeft: callsLeft(),
            maxReviews: opts.maxReviews,
          });
          if (!guard.admitted || subGate === null || (isMethod && catalog === null)) {
            stop = "CONTROL_REJECTED";
            break;
          }
          const effectsBefore = root.effectCalls();
          const receipt = await calls.effect(
            running,
            outcome.requestId,
            action,
            subGate,
            callsLeft(),
            catalog ?? undefined,
          );
          sessionLog.append(isMethod ? "METHOD_LOAD" : "TOOL_OBSERVATION", {
            effectId: receipt.effectId,
            source: receipt.source,
            level: receipt.level,
            checkResult: receipt.checkResult,
          });
          if (isMethod && root.effectCalls() > effectsBefore) {
            methodLoads += 1;
          }
          if (receipt.status === "UNKNOWN" || root.remainingMs() <= MIN_MS) {
            stop = receipt.status === "UNKNOWN" ? "STOPPED" : "DEADLINE_EXCEEDED";
            break;
          }
          const cached = root.effectCalls() === effectsBefore;
          let repeated = false;
          try {
            repeated = progress.observeEffect(
              running.taskId,
              outcome.requestId,
              p3EffectKey(action),
              cached,
            );
          } catch (error) {
            if (!(error instanceof P2Error)) {
              throw error;
            }
            stop = "CONTROL_REJECTED";
            break;
          }
          if (!observations.some((item) => item.effectId === receipt.effectId)) {
            observations.push(receipt);
          }
          if (
            isMethod &&
            methodId !== null &&
            receipt.status === "COMPLETE" &&
            receipt.source === "METHOD_REFERENCE" &&
            catalog !== null &&
            !methodAssets.some((asset) => asset.id === methodId)
          ) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(receipt.observation);
            } catch {
              parsed = null;
            }
            const title = catalog.entries.find((entry) => entry.id === methodId)?.title;
            if (parsed !== null && title !== undefined) {
              try {
                const asset = readAsset(
                  (parsed as Record<string, unknown>)["asset"],
                  methodId,
                  title,
                );
                methodAssets = [...methodAssets, asset];
              } catch {
                stop = "CONTROL_REJECTED";
                break;
              }
            }
          }
          if (repeated && revision.pendingTaskId() === null) {
            try {
              ledger.validateYieldTask(running.taskId, outcome.requestId, "REPEATED_EFFECT");
              progress.validateRecordYield(running.taskId, outcome.requestId, "REPEATED_EFFECT");
              ledger.yieldTask(running.taskId, outcome.requestId, "REPEATED_EFFECT");
              progress.recordYield(running.taskId, outcome.requestId, "REPEATED_EFFECT");
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              stop = "CONTROL_REJECTED";
              break;
            }
            yielded = true;
            stop = "NO_CANDIDATE";
            break;
          }
          continue;
        }
        if (action !== null && action.action === "unsolved") {
          if (revision.pendingTaskId() === null) {
            try {
              ledger.validateYieldTask(running.taskId, outcome.requestId, "UNSOLVED");
              progress.validateRecordYield(running.taskId, outcome.requestId, "UNSOLVED");
              ledger.yieldTask(running.taskId, outcome.requestId, "UNSOLVED");
              progress.recordYield(running.taskId, outcome.requestId, "UNSOLVED");
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              stop = "CONTROL_REJECTED";
              break;
            }
            yielded = true;
            stop = "NO_CANDIDATE";
            break;
          }
          stop = "NO_CANDIDATE";
          break;
        }
        if (action !== null && action.action === "final") {
          if (
            exposedCandidate === null ||
            !allowFinal ||
            !validateAgentFinal(
              action,
              exposedCandidate,
              ledger.snapshot(),
              running.scopeId,
              outcome.requestId,
            )
          ) {
            root.stop("CONTROL_REJECTED");
            stop = "CONTROL_REJECTED";
            break;
          }
          stop = "WORK_UNITS_COMPLETE";
          break;
        }
        let accepted: P2Artifact;
        let ref: P2ArtifactRef;
        if (revision.pendingTaskId() === running.taskId) {
          const origin = revision.provenanceFor(running.taskId);
          if (origin === null) {
            root.stop("CONTROL_REJECTED");
            stop = "CONTROL_REJECTED";
            break;
          }
          const settled = revision.settle(running, {
            artifactId: origin.targetArtifactRef.artifactId,
            routeId: route.routeId,
            sourceRequestId: outcome.requestId,
            transportStatus: outcome.receipt.transportStatus,
            text: outcome.receipt.text,
            eventSeq: ledger.nextEventSeq(),
            supersedes: origin.targetArtifactRef,
          });
          if (settled === null) {
            root.stop("CONTROL_REJECTED");
            stop = "CONTROL_REJECTED";
            break;
          }
          accepted = settled;
          ref = {
            artifactId: settled.artifactId,
            artifactVersion: settled.envelope.artifactVersion ?? 1,
          };
          workUnits += 1;
          // Refresh the protected origin's current availability immediately:
          // a later WORK context must never expose a stale candidate as ACTIVE.
          if (protectedOrigin !== null) {
            const originRef: P2ArtifactRef = {
              artifactId: protectedOrigin.binding.artifactId,
              artifactVersion: protectedOrigin.binding.artifactVersion,
            };
            let originEntry;
            try {
              originEntry = store.get(originRef);
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              originEntry = null;
            }
            if (originEntry !== null && originEntry.availability === "STALE") {
              target = p2Snapshot({ ...protectedOrigin, availability: "STALE" as const }) as P4Target;
            }
          }
          if (accepted.deliveryStatus !== "COMPLETE") {
            stop = "NO_CANDIDATE";
            break;
          }
          // A committed replacement ends the WORK phase of this profile: the
          // loop exits to the R2/finalization stage instead of admitting more
          // work, matching the Host-side finished-redo projection.
          stop = "WORK_UNITS_COMPLETE";
          break;
        } else {
          const receiptInput = {
            artifactId: `artifact-${workUnits + 1}`,
            routeId: route.routeId,
            sourceRequestId: outcome.requestId,
            transportStatus: outcome.receipt.transportStatus,
            text: outcome.receipt.text,
            eventSeq: ledger.nextEventSeq(),
            supersedes: null,
          };
          // Pre-check the acceptance and, when the v5 packet carries a
          // scopeProposal, validate that declaration BEFORE the artifact write
          // or the delivery record. An out-of-scope proposal is therefore a
          // fixed rejection with no side effect on the store, the ledger or the
          // scheduling sequence.
          let prepared: P2Artifact;
          try {
            prepared = store.validateAccept(running, receiptInput);
          } catch (error) {
            if (!(error instanceof P2Error)) {
              throw error;
            }
            stop = "PACKET_REJECTED";
            break;
          }
          if (prepared.packet !== null && prepared.packet.schemaVersion === "p2a-work-v5") {
            const proposed = prepared.packet.scopeProposal;
            if (proposed !== null) {
              try {
                store.validateScopeCoverage(running, {
                  quantifiers: proposed.quantifiers,
                  branchConditions: proposed.branchConditions,
                  boundaryCases: proposed.boundaryCases,
                  goalExhaustion: proposed.goalExhaustion,
                });
              } catch (error) {
                if (!(error instanceof P2Error)) {
                  throw error;
                }
                // A control-violating v5 scope proposal is fail-closed: stop the
                // whole run so a later R2 can never overwrite the reason, and
                // never release an earlier candidate. No artifact and no
                // delivery record were written for this turn.
                root.stop("CONTROL_REJECTED");
                stop = "CONTROL_REJECTED";
                target = null;
                protectedOrigin = null;
                break;
              }
            }
          }
          try {
            accepted = store.accept(running, receiptInput);
          } catch (error) {
            if (!(error instanceof P2Error)) {
              throw error;
            }
            stop = "PACKET_REJECTED";
            break;
          }
          ref = {
            artifactId: accepted.artifactId,
            artifactVersion: accepted.envelope.artifactVersion ?? 1,
          };
          ledger.recordDelivery(
            running.taskId,
            ref,
            accepted.deliveryStatus === "COMPLETE" ? "DELIVERED" : "PARTIAL",
            accepted.envelope.eventSeq,
          );
          sessionLog.append("WORKUNIT", {
            taskId: running.taskId,
            goalId: running.goalId,
            artifactId: ref.artifactId,
            artifactVersion: ref.artifactVersion,
            deliveryStatus: accepted.deliveryStatus,
          });
          workUnits += 1;
          if (accepted.deliveryStatus !== "COMPLETE") {
            if (revision.pendingTaskId() === null) {
              try {
                ledger.validateYieldTask(running.taskId, outcome.requestId, "PARTIAL");
                progress.validateRecordYield(running.taskId, outcome.requestId, "PARTIAL");
                ledger.yieldTask(running.taskId, outcome.requestId, "PARTIAL");
                progress.recordYield(running.taskId, outcome.requestId, "PARTIAL");
              } catch (error) {
                if (!(error instanceof P2Error)) {
                  throw error;
                }
                stop = "CONTROL_REJECTED";
                break;
              }
              yielded = true;
            }
            stop = "NO_CANDIDATE";
            break;
          }
          if (target === null && store.candidate(ref) !== null) {
            const snapshot = ledger.snapshot();
            const obligation = snapshot.obligations.find(
              (row) => row.obligationId === running.obligationId,
            );
            // The whole-problem candidate may only come from a ROOT goal's
            // answer obligation. A task of a sub-goal (e.g. a MULTIPART child
            // goal-1-a) is a local step: it is a real task and can be consumed,
            // but its COMPLETE packet is never the whole-problem candidate.
            const rootGoal = snapshot.goals.some((goal) => goal.goalId === running.goalId);
            if (
              obligation !== undefined &&
              rootGoal &&
              p2IsAnswerObligationKindForGoal(
                goalKindOf(snapshot.goals, running.goalId),
                obligation.kind,
              )
            ) {
              try {
                target = p4Target(snapshot, accepted, "ACTIVE");
                protectedOrigin = target;
                candidateTask = running;
              } catch (error) {
                if (!(error instanceof P2Error)) {
                  throw error;
                }
                stop = "CONTROL_REJECTED";
                break;
              }
            }
          }
        }
        // Only a WORK whose context actually allowed a proposal may admit one.
        // A rejected proposal returns false and leaves the accepted artifact,
        // the ledger, the store and the protected candidate untouched.
        if (allowRouteProposal) {
          workflow.admit(
            accepted,
            callsLeft(),
            opts.maxReviews,
            opts.maxWorkUnits - workUnits,
            root.remainingMs(),
          );
        }
        if (allowTaskContinuation) {
          workflow.admitDependency(
            accepted,
            callsLeft(),
            opts.maxReviews,
            opts.maxWorkUnits - workUnits,
            root.remainingMs(),
          );
        }
        if (allowArtifactRedo) {
          revision.admit(
            accepted,
            callsLeft(),
            opts.maxReviews,
            opts.maxWorkUnits - workUnits,
            root.remainingMs(),
          );
        }
        // A real v5 SCOPE_REFINEMENT proposal is registered as declared data
        // only. It never closes an obligation, never changes the ready set and
        // is never a coverage proof; an out-of-scope item is a fixed
        // SCOPE_MISMATCH rejection that leaves the accepted artifact, the
        // ledger and the store untouched.
        const scopeProposal =
          accepted.packet !== null &&
          accepted.packet.schemaVersion === "p2a-work-v5"
            ? accepted.packet.scopeProposal
            : null;
        if (scopeProposal !== null) {
          // Explicit six-field -> four-field projection of the untrusted v5
          // scope proposal. `kind` and `rationale` are dropped here; only the
          // four declared list fields reach the store. The projection and its
          // validation happen before any write, so a tampered, missing or
          // extra field is a fixed rejection with no side effect on the store,
          // the ledger or the scheduling sequence.
          const projected = {
            quantifiers: scopeProposal.quantifiers,
            branchConditions: scopeProposal.branchConditions,
            boundaryCases: scopeProposal.boundaryCases,
            goalExhaustion: scopeProposal.goalExhaustion,
          };
          try {
            store.declareScopeCoverage(running, projected);
          } catch (error) {
            if (!(error instanceof P2Error)) {
              throw error;
            }
            stop = "CONTROL_REJECTED";
            break;
          }
        }
        advanced = true;
        break;
      }
      if (stop !== "NO_CANDIDATE" && stop !== "WORK_UNITS_COMPLETE") {
        break;
      }
      if (yielded) {
        continue;
      }
      if (!advanced) {
        break;
      }
    }

    if (stop === "NO_CANDIDATE" && target !== null) {
      stop = "WORK_UNITS_COMPLETE";
    }

    if (revision.pendingTaskId() !== null) {
      revision.abort();
    }

    if (protectedOrigin !== null) {
      const originRef: P2ArtifactRef = {
        artifactId: protectedOrigin.binding.artifactId,
        artifactVersion: protectedOrigin.binding.artifactVersion,
      };
      let originEntry;
      try {
        originEntry = store.get(originRef);
      } catch (error) {
        if (!(error instanceof P2Error)) {
          throw error;
        }
        originEntry = null;
      }
      if (originEntry !== null && originEntry.availability === "STALE") {
        target = p2Snapshot({ ...protectedOrigin, availability: "STALE" as const }) as P4Target;
      }
    }

    if (target !== null && target.availability === "ACTIVE" && !root.stopped()) {
      if (opts.maxReviews === 0) {
        stop = "NO_REVIEW";
      } else if (root.nextModelId() === null || root.remainingMs() <= MIN_MS) {
        stop = root.remainingMs() <= MIN_MS ? "DEADLINE_EXCEEDED" : "NO_REVIEW";
      } else {
        const reviewTask = ledger
          .snapshot()
          .tasks.find((row) => row.taskId === target?.binding.taskId);
        if (reviewTask === undefined || reviewTask.delivery !== "DELIVERED") {
          stop = "CONTROL_REJECTED";
        } else {
          firstReviewOrdinal = root.modelCalls() + 1;
          review = new P4ReviewSession(ledger.snapshot(), target, 1, firstReviewOrdinal);
          const requestId = root.nextModelId();
          if (requestId !== null) {
            let admitted: ReturnType<P4ReviewSession["admit"]> | null = null;
            try {
              admitted = review.admit(requestId, root.remainingMs());
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              stop = "CONTROL_REJECTED";
            }
            if (admitted !== null) {
              const before = root.modelCalls();
              const outcome = await calls.model({
                task: reviewTask,
                phase: "R2",
                messages: admitted.context.messages,
                contextHash: admitted.context.contextHash,
                contextBytes: admitted.context.contextBytes,
                onDispatch: (id) => review?.markDispatched(id),
              });
              if (root.modelCalls() > before) {
                reviewCalls += 1;
              }
              if (root.modelCalls() > before) {
                try {
                  const settled = review.settle(
                    outcome.requestId,
                    outcome.receipt.transportStatus,
                    outcome.receipt.text,
                    root.remainingMs(),
                  );
                  stop =
                    settled.code === "OK" &&
                    settled.report !== null &&
                    settled.report.conclusion !== "UNKNOWN"
                      ? "REVIEWS_COMPLETE"
                      : "REVIEW_STOP";
                } catch (error) {
                  if (!(error instanceof P2Error)) {
                    throw error;
                  }
                  stop = "CONTROL_REJECTED";
                }
              } else {
                stop = outcome.code;
              }
            }
          }
        }
      }
    }

    // G3/PR4 S2: at most one evidence-triggered revision after the R2 review.
    // A protected candidate whose answer (global) obligation drew a challenge is
    // re-stated once, and the revised child may replace it ONLY when the
    // replacement is grounded by an independent, Host-accepted checker
    // observation already bound to the original problem. This is opt-in
    // (`maxRepairs`); with the default 0 the whole block is dead and the run is
    // byte-identical to before.
    if (review !== null) {
      const reviewSnapshotForLog = review.snapshot();
      sessionLog.append("REVIEW_CHALLENGE", {
        reviewCalls,
        challenges: reviewSnapshotForLog.challenges.length,
        records: reviewSnapshotForLog.records.length,
      });
    }

    if (
      opts.maxRepairs >= 1 &&
      stop === "REVIEWS_COMPLETE" &&
      target !== null &&
      target.availability === "ACTIVE" &&
      review !== null &&
      candidateTask !== null &&
      !root.stopped() &&
      root.remainingMs() > MIN_MS &&
      callsLeft() >= 1
    ) {
      const challenges: readonly P4Challenge[] = review
        .snapshot()
        .challenges.filter((item) => item.status === "CHALLENGED" && item.availability === "ACTIVE");
      const checker = calls.effects.find(
        (item) =>
          item.receipt.status === "COMPLETE" &&
          item.receipt.source === "PROGRAM_OBSERVATION" &&
          item.receipt.binding.scopeId === candidateTask!.scopeId,
      );
      const snapshot = ledger.snapshot();
      const goalKind = goalKindOf(
        snapshot.goals as readonly { readonly goalId: string; readonly kind: P2GoalKind; readonly subgoals: readonly unknown[] }[],
        candidateTask.goalId,
      );
      const answerKind = p2AnswerObligationForGoal(goalKind);
      const answerObligation = snapshot.obligations.find(
        (row) => row.goalId === candidateTask!.goalId && row.kind === answerKind,
      );
      // G3/PR4 Slice 3a: M5 S1 original-problem mapping gate. A
      // PROGRAM_OBSERVATION receipt may be promoted to a CHECKED_SCOPE/PASS
      // P4ReviseBasis ONLY after the S1 structural mapping check passes against
      // the trusted target: the checker's tool/checked-property, scope,
      // assumptions and challenged obligations must all be the target's own.
      // An E07 wrong mapping (unknown checker tool, foreign obligation, scope or
      // assumption mismatch) is refused, so the receipt can never ground a
      // revision and can never upgrade the candidate.
      const challenge0 = challenges[0];
      if (challenge0 !== undefined && checker !== undefined && answerObligation !== undefined) {
        try {
          s1Assessment = new P4DiagnosticLedger(ledger.snapshot(), target, 1).precheck({
            checkId: "check-1",
            target: target.binding,
            targetHash: target.targetHash,
            scope: target.artifact.scope,
            assumptions: target.artifact.packet?.assumptions ?? [],
            checkedProperty:
              checker.request.action.action === "tool"
                ? p4CheckedPropertyForTool(checker.request.action.name) ??
                  "SUPPLIED_POLYNOMIAL_COEFFICIENTS"
                : "SUPPLIED_POLYNOMIAL_COEFFICIENTS",
            methodOrToolVersion: "tool-registry-v1",
            obligationIds: challenge0.issue.obligationIds,
            request: checker.request,
          });
        } catch (error) {
          if (!(error instanceof P2Error)) {
            throw error;
          }
          s1Assessment = null;
        }
      }
      const s1Ok =
        s1Assessment !== null &&
        s1Assessment.structuralMatch &&
        s1Assessment.reason === "STRUCTURAL_MATCH_ONLY";
      if (challenges.length > 0 && checker !== undefined && answerObligation !== undefined && s1Ok) {
        // `challenges[0]` is defined by the length guard above.
        const challenge = challenges[0]!;
        const route = workflow.forTask(candidateTask);
        const repairTask = candidateTask;
        const requestId = root.nextModelId();
        if (requestId !== null) {
          const body = {
            schemaVersion: "p4-repair-context-v1" as const,
            sessionId: session,
            problemHash,
            contractVersion: contract.contractVersion,
            problemFullText: problemText,
            stage: "REPAIR" as const,
            requestId,
            task: p2Snapshot({
              taskId: repairTask.taskId,
              goalId: repairTask.goalId,
              scopeId: repairTask.scopeId,
              inputArtifactRefs: repairTask.inputArtifactRefs,
            }),
            route: { routeId: route.routeId },
            sourceRequestId: requestId,
            answerObligationId: answerObligation.obligationId,
            challenge,
            parentCandidate: target.artifact.packet?.candidateProposal ?? null,
          };
          const messages = [
            {
              role: "system" as const,
              content:
                "You are a strict single revision reviser. Reply with exactly one JSON work packet and nothing else. You cannot declare anything verified.",
            },
            { role: "user" as const, content: JSON.stringify(body) },
          ];
          const contextBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
          const before = root.modelCalls();
          const outcome = await calls.model({
            task: repairTask,
            phase: "REPAIR",
            messages,
            contextHash: p4Hash(JSON.stringify(messages)),
            contextBytes,
          });
          if (root.modelCalls() > before && outcome.receipt.transportStatus === "COMPLETE") {
            repairCalls += 1;
            try {
              const childArtifact = store.accept(repairTask, {
                artifactId: "repair-1",
                routeId: route.routeId,
                sourceRequestId: requestId,
                transportStatus: outcome.receipt.transportStatus,
                text: outcome.receipt.text,
                eventSeq: ledger.nextEventSeq(),
                supersedes: null,
              });
              const child = p4Target(ledger.snapshot(), childArtifact, "ACTIVE");
              // B3 (DECISION-0150): for a PARAMETER goal the trusted parameter
              // branches are the required gap set (the bounded "PARAMETER two
              // gaps" flagship); the revised child must restate every branch or
              // the revision fails closed (REVISE_REJECTED).
              const gapSet =
                goalKind === "PARAMETER"
                  ? parameterGapsOf(ledger.snapshot().goals, candidateTask.goalId)
                  : [];
              const answerText = child.artifact.packet?.candidateProposal ?? "";
              const basis: P4ReviseBasis = {
                source: "CHECKER_COUNTEREXAMPLE",
                level: "CHECKED_SCOPE",
                checkResult: "PASS",
                scopeId: target.binding.scopeId,
                witness: checker.receipt.observation.slice(0, 2048),
                obligatedObligationIds: [answerObligation.obligationId],
                childCoverage: [answerObligation.obligationId],
                ...(gapSet.length > 0
                  ? {
                      requiredGaps: gapSet,
                      coveredGaps: gapSet.filter((gap) => answerText.includes(gap)),
                    }
                  : {}),
              };
              const revision = reviseCandidate(
                ledger.snapshot(),
                { parent: target, child, challenge, basis },
                root.remainingMs(),
              );
              revisedDecision = revision.decision;
              sessionLog.append("REPAIR", {
                accepted: revision.accepted,
                reason: revision.decision.reason,
              });
              if (revision.accepted) {
                // B1c (DECISION-0150): sync the M1 ledger to the local update of
                // the affected (challenged) answer obligation's task; every other
                // obligation/task keeps its prior state.
                ledger.recordLocalRevision(
                  repairTask.taskId,
                  {
                    artifactId: childArtifact.artifactId,
                    artifactVersion: childArtifact.envelope.artifactVersion ?? 1,
                  },
                  childArtifact.envelope.eventSeq,
                );
              }
              s2Transaction = {
                supersededObligationIds: revision.supersededObligationIds,
                preservedObligationIds: revision.preservedObligationIds,
                preservedParentArtifactId: revision.preservedParentArtifactId,
              };
              stop = revision.accepted ? "REVISED_CANDIDATE" : "REVISE_REJECTED";
            } catch (error) {
              if (!(error instanceof P2Error)) {
                throw error;
              }
              stop = "CONTROL_REJECTED";
            }
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
  }

  // A pending redo that never settled must not leave its task READY/PENDING.
  if (revision.pendingTaskId() !== null) {
    revision.abort();
  }

  const policy: P4DeliveryPolicy = opts.policy;
  const candidateGate = new P4CandidateGate(
    ledger.snapshot(),
    policy,
    review === null ? 2 : firstReviewOrdinal,
  );
  if (target !== null) {
    try {
      candidateGate.protect(protectedOrigin === null ? target : protectedOrigin);
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      root.stop("CONTROL_REJECTED");
      stop = "CONTROL_REJECTED";
    }
  }
  const decision = revisedDecision ?? candidateGate.finalize(
    ledger.snapshot(),
    target,
    review === null ? null : review.snapshot(),
    root.remainingMs(),
  );
  if (!root.stopped()) {
    root.stop(stop);
  }
  const unresolvedObligations: readonly string[] = Object.freeze(
    ledger
      .snapshot()
      .obligations.filter(
        (row) => AUX_OBLIGATION_KINDS.includes(row.kind) && row.status !== "SATISFIED",
      )
      .map((row) => row.obligationId),
  );
  sessionLog.append("FINAL", {
    status: decision.status,
    reason: decision.reason,
    finalResponse: decision.finalResponse,
    candidateVerified: false,
  });
  const summary: AgentLoopSummary = p2Snapshot({
    mode: "TS_PREVIEW" as const,
    targetEnvironment: "TARGET_UNVERIFIED" as const,
    sessionId: session,
    status: decision.status,
    finalResponse: decision.finalResponse,
    candidateVerified: false as const,
    strictAcceptance: "NOT_PERFORMED" as const,
    policy,
    reason: decision.reason,
    modelCalls: root.modelCalls(),
    effectCalls: root.effectCalls(),
    workUnits,
    reviewCalls,
    repairCalls,
    catalogCalls,
    methodLoads,
    stopReason: stop,
    unresolvedObligations,
  }) as AgentLoopSummary;
  const privateState = p2Snapshot({
    contract: ledger.snapshot(),
    events: ledger.eventsSnapshot(),
    artifacts: store.snapshot(),
    requests: calls.requests,
    effects: calls.effects,
    modelGate: gate.snapshot(),
    review: review === null ? null : review.snapshot(),
    decision,
    session: root.snapshot(),
    catalog,
    routes: workflow.snapshot().routes,
    taskRoutes: workflow.snapshot().taskRoutes,
    routeAdmissions: workflow.snapshot().routeAdmissions,
    dependencyAdmissions: workflow.snapshot().dependencyAdmissions,
    revisions: revision.snapshot(),
    s1Assessment,
    s2Transaction,
    readyTasks: ledger.readyTasks(),
    progressEvents: progress.snapshot(),
    sessionLog: sessionLog.snapshot(),
  });
  return p2Snapshot({ summary, privateState }) as AgentLoopResult;
}
