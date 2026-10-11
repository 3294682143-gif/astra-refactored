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
  type P2Task,
  type P3Action,
  type P3EffectReceipt,
  type P4DeliveryPolicy,
  type P4Target,
} from "@astra/protocol";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import {
  P3EffectGate,
  P4RecheckModelGate,
  chooseP2ReadyTask,
  parseP3Action,
} from "@astra/math-gateway";
import { P2WorkunitStore } from "@astra/math-workunit";
import { P4ReviewSession } from "@astra/math-review";
import { P4CandidateGate } from "@astra/math-audit";
import { AgentSession } from "@astra/runtime-core";
import { AgentCalls } from "./agent-loop-calls.js";
import { buildAgentWorkContext } from "./agent-loop-context.js";
import { captureAgentOptions, captureAgentPorts } from "./agent-loop-io.js";

const ROUTE = {
  routeId: "route-1",
  representation: "original-problem",
  operation: "direct-reasoning",
  lemmas: [],
  construction: "unified-agent-loop",
} as const;
const CANDIDATE_KINDS = ["CANDIDATE_VALIDITY", "ANSWER_REQUEST"] as const;
const MIN_MS = 25;

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

export async function runAgentLoop(
  problem: string,
  sessionId: string,
  options: AgentLoopOptions,
  ports: AgentPorts,
): Promise<AgentLoopResult> {
  const problemText = boundedProblem(problem);
  const session = boundedSession(sessionId);
  const opts = captureAgentOptions(options);
  const captured = captureAgentPorts(ports);
  const problemHash = p4Hash(problemText);
  const root = new AgentSession({
    sessionId: session,
    problemHash,
    maxModelCalls: opts.maxModelCalls,
    maxEffects: opts.maxEffects,
    remainingMs: opts.remainingMs,
    now: opts.now,
  });
  const contract = compileP2Contract(
    problemText,
    session,
    opts.goalSpecs.length > 0 ? opts.goalSpecs : undefined,
  );
  const ledger = new ContractLedger(contract);
  const store = new P2WorkunitStore(ledger.snapshot());
  const route = store.registerRoute(ROUTE);
  const gate = new P4RecheckModelGate(session, problemHash, contract.contractVersion, opts.maxModelCalls);
  const calls = new AgentCalls(root, gate, captured);

  let workUnits = 0;
  let reviewCalls = 0;
  let stop: AgentTraceCode = "NO_CANDIDATE";
  let target: P4Target | null = null;
  let review: P4ReviewSession | null = null;
  let firstReviewOrdinal = 2;
  let candidateTask: P2Task | null = null;

  const callsLeft = (): number => opts.maxModelCalls - root.modelCalls();
  const reserve = (): number => (target !== null && opts.maxReviews > 0 ? 1 : 0);

  try {
    while (workUnits < opts.maxWorkUnits && !root.stopped()) {
      if (callsLeft() <= reserve() || root.remainingMs() <= MIN_MS) {
        stop = root.remainingMs() <= MIN_MS ? "DEADLINE_EXCEEDED" : "BUDGET_EXHAUSTED";
        break;
      }
      const ready = ledger.readyTasks();
      const chosen = chooseP2ReadyTask(ledger.snapshot(), ready);
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
      const observations: P3EffectReceipt[] = [];
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
        const allowTools = callsLeft() >= 2 + opts.maxReviews && subGate !== null;
        const requestId = root.nextModelId();
        if (requestId === null) {
          stop = "BUDGET_EXHAUSTED";
          break;
        }
        let context: ReturnType<typeof buildAgentWorkContext>;
        try {
          context = buildAgentWorkContext({
            contract: ledger.snapshot(),
            task: running,
            route,
            requestId,
            inputs,
            toolObservations: observations,
            allowTools,
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
        if (action !== null && action.action === "tool") {
          if (!allowTools || subGate === null || callsLeft() < 1 + opts.maxReviews) {
            stop = "CONTROL_REJECTED";
            break;
          }
          const receipt = await calls.effect(
            running,
            outcome.requestId,
            action,
            subGate,
            callsLeft(),
          );
          if (receipt.status === "UNKNOWN" || root.remainingMs() <= MIN_MS) {
            stop = receipt.status === "UNKNOWN" ? "STOPPED" : "DEADLINE_EXCEEDED";
            break;
          }
          if (!observations.some((item) => item.effectId === receipt.effectId)) {
            observations.push(receipt);
          }
          continue;
        }
        if (action !== null && action.action === "unsolved") {
          stop = "NO_CANDIDATE";
          break;
        }
        if (action !== null && (action.action === "method" || action.action === "final")) {
          stop = "CONTROL_REJECTED";
          break;
        }
        let accepted: P2Artifact;
        try {
          accepted = store.accept(running, {
            artifactId: `artifact-${workUnits + 1}`,
            routeId: route.routeId,
            sourceRequestId: outcome.requestId,
            transportStatus: outcome.receipt.transportStatus,
            text: outcome.receipt.text,
            eventSeq: ledger.nextEventSeq(),
            supersedes: null,
          });
        } catch (error) {
          if (!(error instanceof P2Error)) {
            throw error;
          }
          stop = "PACKET_REJECTED";
          break;
        }
        const ref: P2ArtifactRef = {
          artifactId: accepted.artifactId,
          artifactVersion: accepted.envelope.artifactVersion ?? 1,
        };
        ledger.recordDelivery(
          running.taskId,
          ref,
          accepted.deliveryStatus === "COMPLETE" ? "DELIVERED" : "PARTIAL",
          accepted.envelope.eventSeq,
        );
        workUnits += 1;
        if (accepted.deliveryStatus !== "COMPLETE") {
          stop = "NO_CANDIDATE";
          break;
        }
        if (target === null && store.candidate(ref) !== null) {
          const obligation = ledger
            .snapshot()
            .obligations.find((row) => row.obligationId === running.obligationId);
          if (
            obligation !== undefined &&
            (CANDIDATE_KINDS as readonly string[]).includes(obligation.kind)
          ) {
            try {
              target = p4Target(ledger.snapshot(), accepted, "ACTIVE");
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
        advanced = true;
        break;
      }
      if (stop !== "NO_CANDIDATE" && stop !== "WORK_UNITS_COMPLETE") {
        break;
      }
      if (!advanced) {
        break;
      }
    }

    if (stop === "NO_CANDIDATE" && target !== null) {
      stop = "WORK_UNITS_COMPLETE";
    }

    if (target !== null && !root.stopped()) {
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
  } catch (error) {
    if (!(error instanceof P2Error)) {
      throw error;
    }
    stop = "CONTROL_REJECTED";
  }

  const policy: P4DeliveryPolicy = opts.policy;
  const candidateGate = new P4CandidateGate(
    ledger.snapshot(),
    policy,
    review === null ? 2 : firstReviewOrdinal,
  );
  if (target !== null) {
    try {
      candidateGate.protect(target);
    } catch (error) {
      if (!(error instanceof P2Error)) {
        throw error;
      }
      target = null;
    }
  }
  const decision = candidateGate.finalize(
    ledger.snapshot(),
    target,
    review === null ? null : review.snapshot(),
    root.remainingMs(),
  );
  if (!root.stopped()) {
    root.stop(stop);
  }
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
    stopReason: stop,
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
  });
  return p2Snapshot({ summary, privateState }) as AgentLoopResult;
}
