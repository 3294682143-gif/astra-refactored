/**
 * Shared reactive mock ports for the unified AgentLoop tests.
 *
 * The ports are real async `generate`/`execute` functions that build their
 * reply from the request they actually receive; no receipt list is prefilled
 * and no request id is guessed. Every reply is literal data, never a proof.
 */

import {
  p4Hash,
  type AgentModelReceipt,
  type AgentModelRequest,
  type P2MethodAsset,
  type P2MethodCatalog,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";

export interface ReactiveWorkOptions {
  readonly candidate?: string | null;
  readonly claim?: string;
  readonly derivation?: string;
  readonly deliveryStatus?: "COMPLETE" | "INCOMPLETE" | "TRUNCATED" | "ERROR";
}

export interface ReactivePorts {
  readonly model: { generate(request: AgentModelRequest): Promise<AgentModelReceipt> };
  readonly effect: { execute(request: P3EffectRequest): Promise<P3EffectReceipt> };
  readonly requests: AgentModelRequest[];
  readonly effects: P3EffectRequest[];
}

/** One synthetic 20-entry catalog with legal ids `method-0`..`method-19`. */
export function syntheticCatalog(): P2MethodCatalog {
  const entries = Array.from({ length: 20 }, (_unused, index) => ({
    id: `method-${index}`,
    title: `Method ${index}`,
  }));
  return { version: "1.1.0", entries };
}

/** One synthetic asset whose body/hash/chars are internally consistent. */
export function syntheticAsset(id: string, title: string, body = "asset advisory"): P2MethodAsset {
  return {
    id,
    title,
    version: "1.1.0",
    body,
    bodySha256: p4Hash(body),
    bodyChars: [...body].length,
  };
}

/** One complete METHOD_REFERENCE receipt bound to the request it answers. */
export function methodEffect(
  request: P3EffectRequest,
  catalog: P2MethodCatalog,
  asset?: P2MethodAsset,
): P3EffectReceipt {
  const id = request.action.action === "method" ? request.action.id : "";
  const title = catalog.entries.find((entry) => entry.id === id)?.title ?? "";
  const body = asset ?? syntheticAsset(id, title);
  const observation = JSON.stringify({
    method: id,
    asset: body,
    interpretation: "ADVISORY_NOT_PROOF",
  });
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "METHOD_REFERENCE",
    observation,
    observationHash: p4Hash(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  };
}

interface WorkBody {
  readonly task: {
    readonly taskId: string;
    readonly goalId: string;
    readonly scopeId: string;
    readonly inputArtifactRefs: readonly { readonly artifactId: string; readonly artifactVersion: number }[];
  };
  readonly sessionId: string;
  readonly problemHash: string;
  readonly contractVersion: number;
  readonly route: { readonly routeId: string };
  readonly sourceRequestId: string;
}

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  const user = request.messages[1];
  if (user === undefined) {
    throw new Error("missing user message");
  }
  return JSON.parse(user.content) as Record<string, unknown>;
}

/** One literal p2a-work-v1 WorkPacket bound to the request it answers. */
export function reactiveWork(request: AgentModelRequest, options: ReactiveWorkOptions = {}): string {
  const body = bodyOf(request) as unknown as WorkBody;
  const candidate = options.candidate === undefined ? "4" : options.candidate;
  return JSON.stringify({
    schemaVersion: "p2a-work-v1",
    sessionId: body.sessionId,
    problemHash: body.problemHash,
    contractVersion: body.contractVersion,
    taskId: body.task.taskId,
    goalId: body.task.goalId,
    scopeId: body.task.scopeId,
    routeId: body.route.routeId,
    sourceRequestId: body.sourceRequestId,
    claim: options.claim ?? "2+2=4",
    derivation: options.derivation ?? "2+2=4",
    assumptions: [],
    dependencies: body.task.inputArtifactRefs.map((ref) => ({
      artifactId: ref.artifactId,
      artifactVersion: ref.artifactVersion,
    })),
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: options.deliveryStatus ?? "COMPLETE",
    candidateProposal: candidate,
  });
}

/** One literal tool action naming an existing registered tool. */
export function reactiveTool(): string {
  return JSON.stringify({
    action: "tool",
    name: "polynomial_expand_coefficients",
    args: { expression: "(x+1)**2", variables: ["x"], parameters: [] },
    scope: "expand the supplied polynomial",
  });
}

/** One literal R2 review report bound to the real target and request id. */
export function reviewReply(
  request: AgentModelRequest,
  conclusion: "NO_ISSUE" | "ISSUES" | "UNKNOWN" = "NO_ISSUE",
): string {
  const body = bodyOf(request);
  const target = body.target as Record<string, unknown>;
  const obligations = body.obligations as readonly { readonly obligationId: string }[];
  const coverage =
    conclusion === "UNKNOWN" ? [] : obligations.map((row) => row.obligationId);
  return JSON.stringify({
    schemaVersion: "p4-review-v1",
    requestId: request.requestId,
    target,
    targetHash: body.targetHash,
    stage: "R2",
    conclusion,
    reviewCoverage: coverage,
    issues: [],
  });
}

/** One complete P3 receipt whose observation hash matches its observation. */
export function goodEffect(request: P3EffectRequest): P3EffectReceipt {
  const observation = JSON.stringify({ expanded: "x^2+2x+1" });
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "PROGRAM_OBSERVATION",
    observation,
    observationHash: p4Hash(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  };
}

export interface ReactivePortsOptions {
  readonly work?: (request: AgentModelRequest) => string;
  readonly review?: (request: AgentModelRequest) => string;
  readonly effect?: (request: P3EffectRequest) => P3EffectReceipt;
}

/**
 * Build the real async ports. `generate` answers WORK with a WorkPacket (or a
 * tool action when `work` says so) and R2 with a review report; `execute`
 * answers with a complete receipt. Both record the exact request they saw.
 */
export function reactivePorts(options: ReactivePortsOptions = {}): ReactivePorts {
  const requests: AgentModelRequest[] = [];
  const effects: P3EffectRequest[] = [];
  const work = options.work ?? ((request: AgentModelRequest) => reactiveWork(request));
  const review = options.review ?? ((request: AgentModelRequest) => reviewReply(request));
  const effect = options.effect ?? goodEffect;
  return {
    requests,
    effects,
    model: {
      async generate(request: AgentModelRequest): Promise<AgentModelReceipt> {
        requests.push(request);
        const text = request.phase === "R2" ? review(request) : work(request);
        return { transportStatus: "COMPLETE", text };
      },
    },
    effect: {
      async execute(request: P3EffectRequest): Promise<P3EffectReceipt> {
        effects.push(request);
        return effect(request);
      },
    },
  };
}
