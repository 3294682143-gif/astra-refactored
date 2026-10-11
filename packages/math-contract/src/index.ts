/**
 * @astra/math-contract — P1 M1 contract module.
 *
 * Builds the versioned contract record from the original problem text. It
 * verifies the sha256 identity of the text, keeps the text verbatim (no trim,
 * no rewrite) and records exactly one still-open ANSWER_REQUEST obligation.
 * It does not decompose the problem into a full obligation set.
 */

import { createHash } from "node:crypto";

import {
  P1_MAX_PROBLEM_CHARS,
  type P1Contract,
  type P1Obligation,
  type RecordEnvelope,
} from "@astra/protocol";

export const MATH_CONTRACT_VERSION = "0.0.0-p1" as const;
export const CONTRACT_VERSION = 1 as const;

export * from "./p2-compiler.js";
export * from "./p2-ledger.js";
export * from "./p4-r0.js";

/** The single obligation this phase records; it stays OPEN. */
export const ANSWER_REQUEST_OBLIGATION: P1Obligation = Object.freeze({
  obligationId: "obligation-1",
  kind: "ANSWER_REQUEST",
  status: "OPEN",
});

/** sha256 of the exact UTF-8 bytes of the problem text, lowercase hex. */
export function problemHashOf(problem: string): string {
  return createHash("sha256").update(problem, "utf8").digest("hex");
}

/**
 * Compile the M1 contract. `problemHash` is checked against the actual text;
 * a mismatch is a hard failure rather than a silently accepted identity.
 */
export function compileContract(
  problem: string,
  sessionId: string,
  problemHash: string,
  eventSeq: number,
): P1Contract {
  if (typeof problem !== "string" || problem.length === 0) {
    throw new RangeError("problem");
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new RangeError("sessionId");
  }
  if ([...sessionId].length > 128) {
    throw new RangeError("sessionId");
  }
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 1) {
    throw new RangeError("eventSeq");
  }
  if ([...problem].length > P1_MAX_PROBLEM_CHARS) {
    throw new RangeError("problem");
  }
  if (problemHashOf(problem) !== problemHash) {
    throw new RangeError("problemHash");
  }
  const envelope: RecordEnvelope = Object.freeze({
    recordId: `${sessionId}:m1:1`,
    sessionId,
    problemHash,
    sourceModule: "M1",
    contractVersion: CONTRACT_VERSION,
    artifactVersion: 1,
    eventSeq,
  });
  return Object.freeze({
    envelope,
    problemFullText: problem,
    problemHash,
    contractVersion: CONTRACT_VERSION,
    obligations: Object.freeze([ANSWER_REQUEST_OBLIGATION]),
  });
}
