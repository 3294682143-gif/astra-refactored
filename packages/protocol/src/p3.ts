/**
 * @astra/protocol — P3 shared DTOs (types only).
 *
 * These are the shared data shapes of the P3 finite-action surface. They carry
 * no I/O, no environment access, no authorization and no mathematical
 * decision: a `P3EffectPort` is injected by a trusted host, and a model payload
 * can never construct a receipt by itself. `observationHash` is an integrity
 * check of the exact observation bytes, not a mathematical proof.
 */

/** The two existing registered executors this phase may name. */
export const P3_TOOL_NAMES = Object.freeze([
  "polynomial_expand_coefficients",
  "linear_system_solution_set",
] as const);
export type P3ToolName = (typeof P3_TOOL_NAMES)[number];

/**
 * One strict model action. Exactly one of the four shapes; `scope` on a tool
 * action is an intent string only — the real session/hash/version/task/scope
 * come from the trusted control binding, never from the model.
 */
export type P3Action =
  | {
      readonly action: "tool";
      readonly name: P3ToolName;
      readonly args: Readonly<Record<string, unknown>>;
      readonly scope: string;
    }
  | { readonly action: "method"; readonly id: string }
  | {
      readonly action: "final";
      readonly answer: string;
      readonly complete: boolean;
      readonly unresolved: readonly string[];
    }
  | { readonly action: "unsolved"; readonly reason: string };

/** Trusted control-side identity of one effect. Never model-supplied. */
export interface P3Binding {
  readonly sessionId: string;
  readonly problemHash: string;
  readonly contractVersion: number;
  readonly taskId: string;
  readonly scopeId: string;
  readonly sourceRequestId: string;
}

/** One admitted effect attempt. `remainingMs` is a control-side budget. */
export interface P3EffectRequest {
  readonly effectId: string;
  readonly binding: P3Binding;
  readonly action: Extract<P3Action, { action: "tool" | "method" }>;
  readonly remainingMs: number;
}

/**
 * One effect outcome. `observation` is normalized private material; an ERROR or
 * UNKNOWN receipt may still carry a fixed explanation. Every receipt stays
 * PROVISIONAL/UNKNOWN: a successful execution is not a mathematical proof and
 * never satisfies an obligation.
 */
export interface P3EffectReceipt {
  readonly effectId: string;
  readonly binding: P3Binding;
  readonly status: "COMPLETE" | "ERROR" | "UNKNOWN";
  readonly source: "PROGRAM_OBSERVATION" | "METHOD_REFERENCE";
  readonly observation: string;
  readonly observationHash: string;
  readonly level: "PROVISIONAL";
  readonly checkResult: "UNKNOWN";
}

/**
 * Trusted host-injected synchronous fixture port. `execute` is the only entry
 * point; it exposes no model-visible callback and no transport.
 */
export interface P3EffectPort {
  execute(request: P3EffectRequest): P3EffectReceipt;
}
