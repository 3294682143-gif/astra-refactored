/**
 * @astra/protocol — P3 shared DTOs (types only).
 *
 * These are the shared data shapes of the P3 finite-action surface. They carry
 * no I/O, no environment access, no authorization and no mathematical
 * decision: a `P3EffectPort` is injected by a trusted host, and a model payload
 * can never construct a receipt by itself. `observationHash` is an integrity
 * check of the exact observation bytes, not a mathematical proof.
 */

/**
 * The registered executors this phase may name: a closed whitelist of
 * seventeen data-only operators. Every name here has a Host input contract and
 * a dispatch entry, so naming anything else is a fixed validation failure
 * rather than a silent runtime miss. The first eleven are the Phase 1 surface;
 * the last six are the Phase 2 batch-1 additions, appended in the plan's order
 * so every live table stays order-stable.
 */
export const P3_TOOL_NAMES = Object.freeze([
  "polynomial_expand_coefficients",
  "linear_system_solution_set",
  "exact_check_expr",
  "bounded_enumeration",
  "real_root_count_expr",
  "splitting_field_degree_expr",
  "circle_laplacian_expr",
  "planar_laplacian_expr",
  "interpolation_fit_check",
  "stats_ols_check",
  "finite_group_structure",
  "solve_quadratic_diophantine",
  "symbolic_diophantine_with_timeout",
  "solve_system_guarded_expr",
  "polynomial_function_check",
  "gf2_rank",
  "gf2_nullspace",
  "transition_count",
  "independence_polynomial_chain",
  "count_by_digit_property",
  "rook_numbers",
  "count_avoiding_permutations",
  "markov_expected_steps",
  "cover_time_complete_graph",
  "finite_difference_derivative",
  "richardson_extrapolate",
] as const);
export type P3ToolName = (typeof P3_TOOL_NAMES)[number];

/**
 * One controlled, bounded generated-Python exploration (Stage D+).
 *
 * `code` is untrusted model-authored source of at most 65536 UTF-8 bytes and
 * `scope` is a bounded intent string of 1..256 code points. Nothing here is
 * authorization: the Host admits one exploration only when it advertises
 * `capabilities.generatedPython === "AVAILABLE_BOUNDED"`, its
 * `GenerativeExecutionGate` admits the request and one effect id is still free.
 * The outcome is a `BOUNDED_OBSERVATION` tagged `BOUNDED_OBSERVATION_NOT_PROOF`
 * — never a proof, never a certificate, never an obligation discharge.
 */
export type P3ExploreAction = {
  readonly action: "explore";
  readonly code: string;
  readonly scope: string;
};

/**
 * One strict model action. Exactly one of the five shapes; `scope` is an intent
 * string only — the real session/hash/version/task/scope come from the trusted
 * control binding, never from the model.
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
      readonly action: "math_asset";
      readonly assetId: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly scope?: string;
    }
  | P3ExploreAction
  | {
      readonly action: "final";
      readonly answer: string;
      readonly complete: boolean;
      readonly unresolved: readonly string[];
    }
  | { readonly action: "unsolved"; readonly reason: string };

/**
 * The three action kinds that spend a P3 effect id: a registered tool, a method
 * card load and a bounded generated-Python exploration. An exploration is
 * counted against the same tool-kind effect quota, so `maxEffects` and the
 * effect-id capacity math never widen.
 */
export type P3EffectAction = Extract<P3Action, { action: "tool" | "method" | "explore" | "math_asset" }>;

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
  readonly action: P3EffectAction;
  readonly remainingMs: number;
}

/**
 * One effect outcome. `observation` is normalized private material; an ERROR or
 * UNKNOWN receipt may still carry a fixed explanation. A tool/method receipt
 * stays PROVISIONAL/UNKNOWN: a successful execution is not a mathematical proof
 * and never satisfies an obligation. A `GENERATED_OBSERVATION` receipt is the
 * one OBSERVED level in the surface: it carries an explicitly unverified
 * `BOUNDED_OBSERVATION` (`BOUNDED_OBSERVATION_NOT_PROOF`) and is still never a
 * proof, a certificate or an obligation discharge.
 */
export interface P3EffectReceipt {
  readonly effectId: string;
  readonly binding: P3Binding;
  readonly status: "COMPLETE" | "ERROR" | "UNKNOWN";
  readonly source: "PROGRAM_OBSERVATION" | "METHOD_REFERENCE" | "GENERATED_OBSERVATION";
  readonly observation: string;
  readonly observationHash: string;
  readonly level: "PROVISIONAL" | "OBSERVED";
  readonly checkResult: "UNKNOWN";
}

/**
 * Trusted host-injected synchronous fixture port. `execute` is the only entry
 * point; it exposes no model-visible callback and no transport.
 */
export interface P3EffectPort {
  execute(request: P3EffectRequest): P3EffectReceipt;
}
