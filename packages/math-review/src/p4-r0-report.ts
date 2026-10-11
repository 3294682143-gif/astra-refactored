/**
 * @astra/math-review — P4 R0 model initial-template review report parser
 * (pure, no I/O).
 *
 * Parses one raw model R0 text into a strict `P4R0ReviewReport` bound to a
 * trusted M1 preparation. A parsed report is a model opinion only: it is never
 * a refutation, never a verification, never a mathematical equivalence proof
 * and never acceptance. A hash confirms identity of the same data, not
 * equivalence.
 */

import {
  P2Error,
  P2_ERROR_CODES,
  P4_R0_CONCLUSION,
  P4_R0_DIMENSION,
  P4_R0_REVIEW_SCHEMA_VERSION,
  P4_R0_VERDICT,
  decodeFrame,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
  p2Snapshot,
  p4JsonEqual,
  type P4R0Check,
  type P4R0Conclusion,
  type P4R0Dimension,
  type P4R0Preparation,
  type P4R0ReviewReport,
  type P4R0Verdict,
  type P4StepLocator,
} from "@astra/protocol";
import { validateP4R0Input } from "./p4-r0-input.js";

const MAX_TEXT_CHARS = 20000;
const MAX_BYTES = 65536;
const MAX_RATIONALE_CHARS = 2048;
const MAX_QUOTE_CHARS = 4096;

const REPORT_FIELDS = [
  "schemaVersion",
  "requestId",
  "stage",
  "target",
  "planHash",
  "conclusion",
  "reviewCoverage",
  "checks",
] as const;
const BINDING_FIELDS = ["sessionId", "problemHash", "contractVersion", "planHash"] as const;
const CHECK_FIELDS = ["dimension", "verdict", "rationale", "problemSpan", "planSpan"] as const;
const SPAN_FIELDS = ["start", "end", "quote"] as const;

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

function spanOf(value: unknown, source: string, required: boolean): P4StepLocator | null {
  if (value === null) {
    if (required) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    return null;
  }
  const locator = exact(value, SPAN_FIELDS);
  const start = locator.start;
  const end = locator.end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > [...source].length
  ) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const quote = text(locator.quote, MAX_QUOTE_CHARS);
  if ([...source].slice(start, end).join("") !== quote) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return Object.freeze({ start, end, quote });
}

/**
 * Strict parse of one raw model R0 text against a trusted M1 preparation.
 *
 * The preparation must pass `validateP4R0Input` and its action must be
 * `REQUEST_REVIEW`; the report is bound to `model-1`, the R0 stage, the target
 * binding and the plan hash, and `reviewCoverage` must list exactly the
 * contract's obligation ids in order. A parsed report proves nothing.
 */
export function parseP4R0Report(
  rawtext: string,
  preparation: P4R0Preparation,
): P4R0ReviewReport {
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

    const validated = validateP4R0Input(preparation);
    if (validated.action !== "REQUEST_REVIEW") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const contract = validated.target.contract;
    const binding = validated.target.binding;

    const report = exact(frozen, REPORT_FIELDS);
    if (report.schemaVersion !== P4_R0_REVIEW_SCHEMA_VERSION) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (report.requestId !== "model-1") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.stage !== "R0") {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const reportBinding = exact(report.target, BINDING_FIELDS);
    if (!p4JsonEqual(reportBinding, binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.planHash !== binding.planHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!(P4_R0_CONCLUSION as readonly string[]).includes(report.conclusion as string)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const conclusion = report.conclusion as P4R0Conclusion;

    const expectedCoverage = contract.obligations.map((item) => item.obligationId);
    const coverage = report.reviewCoverage;
    if (!Array.isArray(coverage) || coverage.length !== expectedCoverage.length) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    for (let index = 0; index < expectedCoverage.length; index += 1) {
      if (coverage[index] !== expectedCoverage[index]) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
    }

    if (!Array.isArray(report.checks) || report.checks.length !== P4_R0_DIMENSION.length) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const problemText = contract.problemFullText;
    const planText = validated.target.planText;
    const checks: P4R0Check[] = [];
    const seenDimensions = new Set<string>();
    for (const item of report.checks) {
      const row = exact(item, CHECK_FIELDS);
      if (!(P4_R0_DIMENSION as readonly string[]).includes(row.dimension as string)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const dimension = row.dimension as P4R0Dimension;
      if (seenDimensions.has(dimension)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      seenDimensions.add(dimension);
      if (!(P4_R0_VERDICT as readonly string[]).includes(row.verdict as string)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const verdict = row.verdict as P4R0Verdict;
      const rationale = text(row.rationale, MAX_RATIONALE_CHARS);
      const required = verdict !== "UNKNOWN";
      const problemSpan = spanOf(row.problemSpan, problemText, required);
      const planSpan = spanOf(row.planSpan, planText, required);
      checks.push(Object.freeze({ dimension, verdict, rationale, problemSpan, planSpan }));
    }
    for (const dimension of P4_R0_DIMENSION) {
      if (!seenDimensions.has(dimension)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
    }

    const anyIssues = checks.some((check) => check.verdict === "ISSUES");
    const allNoIssue = checks.every((check) => check.verdict === "NO_ISSUE");
    const derived: P4R0Conclusion = anyIssues ? "ISSUES" : allNoIssue ? "NO_ISSUE" : "UNKNOWN";
    if (conclusion !== derived) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }

    return p2Snapshot({
      schemaVersion: P4_R0_REVIEW_SCHEMA_VERSION,
      requestId: "model-1",
      stage: "R0",
      target: binding,
      planHash: binding.planHash,
      conclusion,
      reviewCoverage: Object.freeze([...expectedCoverage]),
      checks: Object.freeze(checks),
    }) as P4R0ReviewReport;
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
}
