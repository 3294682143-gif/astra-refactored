/**
 * @astra/stdio-runtime — unified AgentLoop result types (declarations only).
 *
 * Re-exports the shared DTO surface so the composition root and its tests
 * import one definition. No I/O, no environment access, no runtime logic.
 */

export type {
  AgentLoopPrivateState,
  AgentLoopResult,
  AgentLoopSummary,
} from "@astra/protocol";
