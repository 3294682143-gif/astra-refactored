export * from "./types.js";

/**
 * Validates whether a candidate conforms to the strict Zygos candidate integrity rules.
 * Enforces Invariant I15: candidate_verified must be false.
 */
export function assertCandidateIntegrity(candidate: { readonly candidateVerified: boolean }): void {
  if (candidate.candidateVerified !== false) {
    throw new Error("Invariant I15 violation: candidateVerified must strictly remain false");
  }
}

/**
 * Helper to check if a run state is terminal.
 */
export function isTerminalRunState(state: string): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
}
