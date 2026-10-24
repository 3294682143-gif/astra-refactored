/**
 * @astra/math-gateway — DSH-inspired monotonic tool-guard pipeline (G4/PR5 4b).
 *
 * The fixed pipeline is `pre -> monotonic guards -> dispatch -> execute -> post`.
 * This module owns only the *pre* + *monotonic guards* stage: given one parsed
 * action and the trusted admission inputs it returns an irreversible decision.
 * A refusal can never be undone by later logic (there is no `unreject`), and no
 * guard reads the network, the clock or a provider response. Tool/method
 * execution itself stays in the caller (the unique Python Host); this stage
 * never executes anything.
 *
 * The Host still performs its own second whitelist/quota check; a receipt it
 * produces is a PROGRAM_OBSERVATION whose math-evidence grade is decided by M5,
 * strictly separate from this admission decision.
 */

import type { P3Action } from "@astra/protocol";

export const TOOL_GUARD_PIPELINE = ["pre", "guards", "dispatch", "execute", "post"] as const;

export interface ToolGuardInput {
  readonly action: P3Action;
  readonly allowTools: boolean;
  readonly allowMethods: boolean;
  /** Present iff the action is a method action; the parsed method id. */
  readonly methodId: string | null;
  /** The trusted catalog ids (empty when no catalog is available). */
  readonly catalogIds: readonly string[];
  /** Model calls left, including the reserved review slots. */
  readonly callsLeft: number;
  readonly maxReviews: number;
  /**
   * Stage D+: whether the Host advertised `AVAILABLE_BOUNDED` generated Python.
   * Absent is false, so an `explore` action is refused exactly like an
   * unavailable tool and every existing caller is unchanged.
   */
  readonly allowExplorations?: boolean;
}

export interface ToolGuardDecision {
  readonly admitted: boolean;
  readonly stage: "pre" | "guards";
  /** Fixed code; never raw model text. */
  readonly code:
    | "ADMITTED"
    | "NOT_AN_EFFECT_ACTION"
    | "METHOD_UNAVAILABLE"
    | "ACTION_NOT_ALLOWED"
    | "UNKNOWN_METHOD"
    | "BUDGET_RESERVED";
  /** A refusal is irreversible: this is always true. */
  readonly monotonic: true;
}

function reject(stage: "pre" | "guards", code: ToolGuardDecision["code"]): ToolGuardDecision {
  return Object.freeze({ admitted: false, stage, code, monotonic: true } as const);
}

/**
 * Run the pre + monotonic-guard stages for one parsed action. The decision is a
 * pure function of the trusted inputs; every refusal code maps the same way the
 * caller already treats an illegal action (a fixed control rejection).
 */
export function monotonicToolGuard(input: ToolGuardInput): ToolGuardDecision {
  const { action } = input;
  if (action.action === "explore") {
    // A bounded exploration is admitted only when the Host advertised the
    // bounded capability; it spends tool-kind effect capacity, never a method
    // attempt, and it is never treated as an evidence-bearing tool.
    if (input.allowExplorations !== true) {
      return reject("guards", "ACTION_NOT_ALLOWED");
    }
    if (input.callsLeft < 1 + input.maxReviews) {
      return reject("guards", "BUDGET_RESERVED");
    }
    return Object.freeze({ admitted: true, stage: "guards", code: "ADMITTED", monotonic: true } as const);
  }
  if (action.action !== "tool" && action.action !== "method") {
    return reject("pre", "NOT_AN_EFFECT_ACTION");
  }
  const isMethod = action.action === "method";
  if (isMethod) {
    if (!input.allowMethods || input.methodId === null) {
      return reject("guards", "METHOD_UNAVAILABLE");
    }
    if (!input.catalogIds.includes(input.methodId)) {
      return reject("guards", "UNKNOWN_METHOD");
    }
  } else if (!input.allowTools) {
    return reject("guards", "ACTION_NOT_ALLOWED");
  }
  if (input.callsLeft < 1 + input.maxReviews) {
    return reject("guards", "BUDGET_RESERVED");
  }
  return Object.freeze({ admitted: true, stage: "guards", code: "ADMITTED", monotonic: true } as const);
}
