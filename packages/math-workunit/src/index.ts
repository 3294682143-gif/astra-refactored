/**
 * @astra/math-workunit — P1 M3 work-unit module.
 *
 * Builds the two fixed model messages from the contract and converts one
 * model receipt into a versioned, explicitly provisional WorkResult. It never
 * upgrades a truncated, errored, unknown or empty receipt to COMPLETE.
 */

import {
  P1_DELIVERY_STATUS,
  P1_MAX_MESSAGE_CHARS,
  P1_MAX_RESPONSE_CHARS,
  P1_MODEL_REQUEST_ID,
  P1_SYSTEM_PROMPT,
  p1EventId,
  type P1Contract,
  type P1DeliveryStatus,
  type P1ModelMessage,
  type P1WorkResult,
  type RecordEnvelope,
} from "@astra/protocol";

export const MATH_WORKUNIT_VERSION = "0.0.0-p1" as const;
export const WORKUNIT_ARTIFACT_VERSION = 1 as const;

export * from "./p2-routes.js";
export * from "./p2-store.js";
export * from "./p2-prepare.js";
export * from "./p2-a2-context.js";
export * from "./p3-context.js";
export {
  P2_SCOPE_COVERAGE_FIELDS,
  p2ScopeCoverage,
  checkScopeCoverage,
  checkScopeCoverageAgainstScope,
  checkTaskScopeCoverage,
  type P2ScopeCoverage,
  type P2TaskScopeCoverage,
} from "./p2-context.js";

/**
 * The fixed system template. Exported so the Host can compare the exact text
 * it receives instead of guessing at it.
 */
export const SYSTEM_PROMPT = P1_SYSTEM_PROMPT;

/** Exactly two messages: the fixed system template and the original problem. */
export function prepareMessages(contract: P1Contract): readonly P1ModelMessage[] {
  const messages: readonly P1ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: contract.problemFullText },
  ];
  for (const message of messages) {
    if (message.content.length === 0 || [...message.content].length > P1_MAX_MESSAGE_CHARS) {
      throw new RangeError("messages");
    }
  }
  return Object.freeze(messages.map((message) => Object.freeze({ ...message })));
}

/**
 * Accept one model receipt. The delivery status must be on the fixed
 * allowlist, the request id must be the single expected one and the text must
 * fit the response bound; nothing is rewritten on the way in.
 */
export function acceptModelResult(
  contract: P1Contract,
  deliveryStatus: P1DeliveryStatus,
  text: string,
  requestId: string,
  eventSeq: number,
): P1WorkResult {
  if (!(P1_DELIVERY_STATUS as readonly string[]).includes(deliveryStatus)) {
    throw new RangeError("deliveryStatus");
  }
  if (requestId !== P1_MODEL_REQUEST_ID) {
    throw new RangeError("requestId");
  }
  if (typeof text !== "string" || [...text].length > P1_MAX_RESPONSE_CHARS) {
    throw new RangeError("text");
  }
  const envelope: RecordEnvelope = Object.freeze({
    recordId: `${contract.envelope.sessionId}:m3:1`,
    sessionId: contract.envelope.sessionId,
    problemHash: contract.problemHash,
    sourceModule: "M3",
    contractVersion: contract.contractVersion,
    artifactVersion: WORKUNIT_ARTIFACT_VERSION,
    causeEventId: p1EventId(contract.envelope.sessionId, contract.envelope.eventSeq),
    eventSeq,
  });
  return Object.freeze({
    envelope,
    deliveryStatus,
    text,
    sourceRequestId: requestId,
    provisional: true,
  });
}
