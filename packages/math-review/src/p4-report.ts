/**
 * @astra/protocol — P4 strict model review report parser (pure, no I/O).
 *
 * Parses one raw model review text into a strict `P4ReviewReport` bound to a
 * supplied target. A parsed report is a model claim only: it is never a
 * refutation, never a verification and never acceptance.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  p2Snapshot,
  type P2Contract,
} from "@astra/protocol";
import {
  decodeFrame,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
} from "@astra/protocol";
import {
  P4_ISSUE_KINDS,
  P4_REVIEW_CONCLUSION,
  P4_REVIEW_SCHEMA_VERSION,
  type P4Binding,
  type P4IssueKind,
  type P4ReviewIssue,
  type P4ReviewReport,
  type P4StepLocator,
  type P4Target,
} from "@astra/protocol";
import { p4Hash, p4SameBinding, p4Target } from "@astra/protocol";

const MAX_TEXT_CHARS = 20000;
const MAX_BYTES = 65536;
const MAX_RATIONALE_CHARS = 2048;
const MAX_QUOTE_CHARS = 4096;
const MAX_SHORT_CHARS = 256;
const MAX_COVERAGE = 32;
const MAX_ISSUES = 8;

const REPORT_FIELDS = [
  "schemaVersion",
  "requestId",
  "target",
  "targetHash",
  "stage",
  "conclusion",
  "reviewCoverage",
  "issues",
] as const;
const ISSUE_FIELDS = [
  "stepLocator",
  "suspectedIssue",
  "rationale",
  "requestedCheck",
  "obligationIds",
] as const;
const LOCATOR_FIELDS = ["start", "end", "quote"] as const;

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
  }
  return source;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if ([...value].length > max || !detectLoneSurrogates(value).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return value;
}

function ids(value: unknown, allowed: ReadonlySet<string>, minItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > MAX_COVERAGE) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const seen = new Set<string>();
  const collected: string[] = [];
  for (const item of value) {
    const id = text(item, MAX_SHORT_CHARS);
    if (seen.has(id) || !allowed.has(id)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    seen.add(id);
    collected.push(id);
  }
  return collected;
}

/**
 * Strict parse of one raw model review text against a supplied target.
 *
 * The target is rebuilt from the trusted contract/artifact and must match the
 * supplied binding and hash exactly; only an ACTIVE target is accepted. The
 * report is bound to `requestId`, the target hash and the R2 stage. A parsed
 * report is a model claim: it proves nothing and refutes nothing.
 */
export function parseP4ReviewReport(
  rawtext: string,
  requestId: string,
  target: P4Target,
  contract: P2Contract,
  firstRequestOrdinal = 2,
): P4ReviewReport {
  try {
    if (
      typeof firstRequestOrdinal !== "number" ||
      !Number.isSafeInteger(firstRequestOrdinal) ||
      firstRequestOrdinal < 2 ||
      firstRequestOrdinal > 4
    ) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (typeof rawtext !== "string" || !detectLoneSurrogates(rawtext).ok) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if ([...rawtext].length > MAX_TEXT_CHARS) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (Buffer.byteLength(rawtext, "utf8") > MAX_BYTES) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const decoded = decodeFrame(Buffer.from(rawtext, "utf8"));
    if (!decoded.ok) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const raw = decoded.value;
    if (!detectDuplicateKeys(raw).ok) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (!detectNonFiniteTokens(raw).ok) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (!detectUnsafeNumbers(raw).ok) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const frozen = p2Snapshot(parsed);
    if (!detectLoneSurrogates(frozen).ok) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const report = exact(frozen, REPORT_FIELDS);
    if (report.schemaVersion !== P4_REVIEW_SCHEMA_VERSION) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (report.stage !== "R2") {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const lastAllowed = Math.min(firstRequestOrdinal + 1, 4);
    let ordinalOk = false;
    for (let ordinal = firstRequestOrdinal; ordinal <= lastAllowed; ordinal += 1) {
      if (requestId === `model-${ordinal}`) {
        ordinalOk = true;
        break;
      }
    }
    if (!ordinalOk) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.requestId !== requestId) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (target.availability !== "ACTIVE") {
      throw new P2Error(P2_ERROR_CODES.STALE_DEPENDENCY);
    }
    const rebuilt = p4Target(contract, target.artifact, "ACTIVE");
    if (!p4SameBinding(rebuilt.binding, target.binding)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rebuilt.targetHash !== target.targetHash) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const binding = exact(report.target, [
      "sessionId",
      "problemHash",
      "contractVersion",
      "artifactId",
      "artifactVersion",
      "taskId",
      "goalId",
      "scopeId",
      "sourceRequestId",
    ]);
    if (!p4SameBinding(binding, target.binding)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.targetHash !== target.targetHash) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const packet = target.artifact.packet;
    if (packet === null) {
      throw new P2Error(P2_ERROR_CODES.PACKET_DELIVERY);
    }
    const derivation = [...packet.derivation];
    const allowed = new Set<string>();
    for (const obligation of contract.obligations) {
      if (
        obligation.goalId === target.binding.goalId &&
        obligation.envelope.scopeId === target.binding.scopeId
      ) {
        allowed.add(obligation.obligationId);
      }
    }
    const coverage = ids(report.reviewCoverage, allowed, 0);
    if (!(P4_REVIEW_CONCLUSION as readonly string[]).includes(report.conclusion as string)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const conclusion = report.conclusion as P4ReviewReport["conclusion"];
    if (!Array.isArray(report.issues) || report.issues.length > MAX_ISSUES) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const coverageSet = new Set(coverage);
    const issues: P4ReviewIssue[] = [];
    for (const item of report.issues) {
      const issue = exact(item, ISSUE_FIELDS);
      const locator = exact(issue.stepLocator, LOCATOR_FIELDS);
      const start = locator.start;
      const end = locator.end;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > derivation.length
      ) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const quote = text(locator.quote, MAX_QUOTE_CHARS);
      if (derivation.slice(start, end).join("") !== quote) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      if (!(P4_ISSUE_KINDS as readonly string[]).includes(issue.suspectedIssue as string)) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const rationale = text(issue.rationale, MAX_RATIONALE_CHARS);
      const requestedCheck = text(issue.requestedCheck, MAX_SHORT_CHARS);
      const obligationIds = ids(issue.obligationIds, allowed, 1);
      for (const id of obligationIds) {
        if (!coverageSet.has(id)) {
          throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
        }
      }
      const frozenLocator: P4StepLocator = Object.freeze({ start, end, quote });
      issues.push(
        Object.freeze({
          stepLocator: frozenLocator,
          suspectedIssue: issue.suspectedIssue as P4IssueKind,
          rationale,
          requestedCheck,
          obligationIds: Object.freeze(obligationIds),
        }),
      );
    }
    if (conclusion === "NO_ISSUE") {
      if (issues.length !== 0 || coverage.length !== allowed.size) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
    } else if (conclusion === "ISSUES") {
      if (issues.length === 0 || coverage.length === 0) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
    } else if (issues.length !== 0) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const frozenBinding: P4Binding = Object.freeze({
      sessionId: target.binding.sessionId,
      problemHash: target.binding.problemHash,
      contractVersion: target.binding.contractVersion,
      artifactId: target.binding.artifactId,
      artifactVersion: target.binding.artifactVersion,
      taskId: target.binding.taskId,
      goalId: target.binding.goalId,
      scopeId: target.binding.scopeId,
      sourceRequestId: target.binding.sourceRequestId,
    });
    return Object.freeze({
      schemaVersion: P4_REVIEW_SCHEMA_VERSION,
      requestId,
      target: frozenBinding,
      targetHash: target.targetHash,
      stage: "R2",
      conclusion,
      reviewCoverage: Object.freeze(coverage),
      issues: Object.freeze(issues),
    });
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
}

export { p4Hash };
