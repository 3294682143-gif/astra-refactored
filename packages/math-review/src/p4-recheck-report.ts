/**
 * @astra/math-review — P4 S2 post-repair re-review report parser (pure).
 *
 * Parses one raw model re-review text into a strict `P4RecheckReport` bound to
 * the validated parent/child/challenge/repair material. A parsed report is a
 * model opinion only: it is never a refutation, never a verification, never a
 * resolution of the original challenge and never acceptance.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  decodeFrame,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
  p2Snapshot,
  p4SameBinding,
  type P2Contract,
  type P4Binding,
  type P4RecheckCheck,
  type P4RecheckDimension,
  type P4RecheckReport,
  type P4RecheckVerdict,
  type P4RepairSnapshot,
  type P4ReviewSnapshot,
  type P4StepLocator,
  type P4Target,
} from "@astra/protocol";
import {
  P4_RECHECK_DIMENSION,
  P4_RECHECK_REQUEST_ID,
  P4_RECHECK_SCHEMA_VERSION,
  P4_RECHECK_VERDICT,
} from "@astra/protocol";
import { validateP4RecheckInput } from "./p4-recheck-input.js";

const MAX_TEXT_CHARS = 20000;
const MAX_BYTES = 65536;
const MAX_RATIONALE_CHARS = 2048;
const MAX_QUOTE_CHARS = 4096;
const MAX_COVERAGE = 32;

const REPORT_FIELDS = [
  "schemaVersion",
  "requestId",
  "stage",
  "parent",
  "parentHash",
  "child",
  "childHash",
  "challengeId",
  "repairHash",
  "conclusion",
  "reviewCoverage",
  "checks",
] as const;
const CHECK_FIELDS = ["dimension", "verdict", "rationale", "childStepLocator"] as const;
const LOCATOR_FIELDS = ["start", "end", "quote"] as const;
const BINDING_FIELDS = [
  "sessionId",
  "problemHash",
  "contractVersion",
  "artifactId",
  "artifactVersion",
  "taskId",
  "goalId",
  "scopeId",
  "sourceRequestId",
] as const;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
  }
  return source;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if ([...value].length > max || !detectLoneSurrogates(value).ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return value;
}

function locatorOf(value: unknown, derivation: string, required: boolean): P4StepLocator | null {
  if (value === null) {
    if (required) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    return null;
  }
  const locator = exact(value, LOCATOR_FIELDS);
  const start = locator.start;
  const end = locator.end;
  const points = [...derivation];
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > points.length
  ) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const quote = text(locator.quote, MAX_QUOTE_CHARS);
  if (points.slice(start, end).join("") !== quote) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return Object.freeze({ start, end, quote });
}

/**
 * Strict parse of one raw model re-review text.
 *
 * The parent/child/challenge/repair material is rebuilt and replayed by
 * `validateP4RecheckInput`; the report must match that validated material
 * exactly. A parsed report is a model opinion: it proves nothing, refutes
 * nothing, resolves no challenge and supersedes no parent.
 */
export function parseP4RecheckReport(
  rawtext: string,
  contract: P2Contract,
  parent: P4Target,
  child: P4Target,
  parentReview: P4ReviewSnapshot,
  repair: P4RepairSnapshot,
): P4RecheckReport {
  try {
    if (typeof rawtext !== "string" || !detectLoneSurrogates(rawtext).ok) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if ([...rawtext].length > MAX_TEXT_CHARS) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (Buffer.byteLength(rawtext, "utf8") > MAX_BYTES) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const decoded = decodeFrame(Buffer.from(rawtext, "utf8"));
    if (!decoded.ok) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const raw = decoded.value;
    if (!detectDuplicateKeys(raw).ok) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (!detectNonFiniteTokens(raw).ok) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (!detectUnsafeNumbers(raw).ok) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const frozen = p2Snapshot(parsed);
    if (!detectLoneSurrogates(frozen).ok) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const validated = validateP4RecheckInput(contract, parent, child, parentReview, repair);
    const report = exact(frozen, REPORT_FIELDS);
    if (report.schemaVersion !== P4_RECHECK_SCHEMA_VERSION) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (report.requestId !== P4_RECHECK_REQUEST_ID) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.stage !== "S2") {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const parentBinding = exact(report.parent, BINDING_FIELDS);
    if (!p4SameBinding(parentBinding, validated.parent.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.parentHash !== validated.parent.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const childBinding = exact(report.child, BINDING_FIELDS);
    if (!p4SameBinding(childBinding, validated.child.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.childHash !== validated.child.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.challengeId !== validated.challenge.challengeId) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.repairHash !== validated.repairHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const expectedCoverage = validated.challenge.issue.obligationIds;
    if (!Array.isArray(report.reviewCoverage) || report.reviewCoverage.length !== expectedCoverage.length) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (report.reviewCoverage.length === 0 || report.reviewCoverage.length > MAX_COVERAGE) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const coverage: string[] = [];
    for (let index = 0; index < expectedCoverage.length; index += 1) {
      const item = report.reviewCoverage[index];
      if (typeof item !== "string" || item !== expectedCoverage[index]) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      coverage.push(item);
    }
    if (!(P4_RECHECK_VERDICT as readonly string[]).includes(report.conclusion as string)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const conclusion = report.conclusion as P4RecheckVerdict;
    if (!Array.isArray(report.checks) || report.checks.length !== P4_RECHECK_DIMENSION.length) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const childPacket = validated.child.artifact.packet;
    if (childPacket === null) {
      fail(P2_ERROR_CODES.PACKET_DELIVERY);
    }
    const derivation = childPacket.derivation;
    const rows: P4RecheckCheck[] = [];
    const seen = new Set<string>();
    for (const item of report.checks) {
      const row = exact(item, CHECK_FIELDS);
      if (!(P4_RECHECK_DIMENSION as readonly string[]).includes(row.dimension as string)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const dimension = row.dimension as P4RecheckDimension;
      if (seen.has(dimension)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      seen.add(dimension);
      if (!(P4_RECHECK_VERDICT as readonly string[]).includes(row.verdict as string)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const verdict = row.verdict as P4RecheckVerdict;
      const rationale = text(row.rationale, MAX_RATIONALE_CHARS);
      const childStepLocator = locatorOf(row.childStepLocator, derivation, verdict !== "UNKNOWN");
      rows.push(Object.freeze({ dimension, verdict, rationale, childStepLocator }));
    }
    for (const dimension of P4_RECHECK_DIMENSION) {
      if (!seen.has(dimension)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
    }
    const anyIssues = rows.some((row) => row.verdict === "ISSUES");
    const allNoIssue = rows.every((row) => row.verdict === "NO_ISSUE");
    const derived: P4RecheckVerdict = anyIssues ? "ISSUES" : allNoIssue ? "NO_ISSUE" : "UNKNOWN";
    if (conclusion !== derived) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const frozenParentBinding: P4Binding = Object.freeze({
      sessionId: validated.parent.binding.sessionId,
      problemHash: validated.parent.binding.problemHash,
      contractVersion: validated.parent.binding.contractVersion,
      artifactId: validated.parent.binding.artifactId,
      artifactVersion: validated.parent.binding.artifactVersion,
      taskId: validated.parent.binding.taskId,
      goalId: validated.parent.binding.goalId,
      scopeId: validated.parent.binding.scopeId,
      sourceRequestId: validated.parent.binding.sourceRequestId,
    });
    const frozenChildBinding: P4Binding = Object.freeze({
      sessionId: validated.child.binding.sessionId,
      problemHash: validated.child.binding.problemHash,
      contractVersion: validated.child.binding.contractVersion,
      artifactId: validated.child.binding.artifactId,
      artifactVersion: validated.child.binding.artifactVersion,
      taskId: validated.child.binding.taskId,
      goalId: validated.child.binding.goalId,
      scopeId: validated.child.binding.scopeId,
      sourceRequestId: validated.child.binding.sourceRequestId,
    });
    return Object.freeze({
      schemaVersion: P4_RECHECK_SCHEMA_VERSION,
      requestId: P4_RECHECK_REQUEST_ID,
      stage: "S2",
      parent: frozenParentBinding,
      parentHash: validated.parent.targetHash,
      child: frozenChildBinding,
      childHash: validated.child.targetHash,
      challengeId: validated.challenge.challengeId,
      repairHash: validated.repairHash,
      conclusion,
      reviewCoverage: Object.freeze(coverage),
      checks: Object.freeze(rows),
    });
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
}

export { P4_RECHECK_SCHEMA_VERSION };
