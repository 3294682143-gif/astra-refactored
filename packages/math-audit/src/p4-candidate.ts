/**
 * @astra/math-audit — P4 S3 conservative final selection (pure, no I/O).
 *
 * Records at most one protected candidate and emits a final decision under a
 * pre-frozen BEST_EFFORT | STRICT policy. No checker exists in this phase, so
 * `candidateVerified` is always false, strict acceptance is never performed
 * and no obligation is ever closed. A model review is a claim, never a
 * refutation: a later candidate never replaces the first protected one.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  canonicalScope,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
  p2IsAnswerObligationKind,
  p2Snapshot,
  type P2Contract,
  type P2ObligationKind,
  type P2TransportStatus,
} from "@astra/protocol";
import {
  P4_BINDING_FIELDS,
  p4Hash,
  p4JsonEqual,
  p4SameBinding,
  p4Target,
  type P4Binding,
  type P4Challenge,
  type P4CoverageRow,
  type P4DeliveryPolicy,
  type P4EvidenceAvailability,
  type P4FinalDecision,
  type P4FinalReason,
  type P4ReviewEvidence,
  type P4ReviewRecord,
  type P4ReviewSnapshot,
  type P4Target,
} from "@astra/protocol";

const MAX_REMAINING_MS = 3_600_000;
const MAX_REVIEWS = 2;
const MAX_REQUEST_ORDINAL = 32;
const MAX_CHALLENGES = 16;
const MAX_COVERAGE = 32;
const MAX_ISSUES = 8;
const MAX_SHORT_CHARS = 256;
const MAX_TEXT_CHARS = 20000;
const MAX_CONTEXT_BYTES = 65536;
const UNSOLVED_RESPONSE = "Unsolved." as const;
const REVIEW_CODES = [
  "OK",
  "INVALID_REPORT",
  "TRANSPORT_INCOMPLETE",
  "DEADLINE_EXCEEDED",
  "NOT_DISPATCHED",
  "OUTCOME_UNKNOWN",
] as const;

const SNAPSHOT_FIELDS = [
  "target",
  "targetHash",
  "availability",
  "records",
  "challenges",
  "evidence",
] as const;
const RECORD_FIELDS = [
  "requestId",
  "target",
  "targetHash",
  "state",
  "transportStatus",
  "context",
  "rawResponseText",
  "report",
  "code",
] as const;
const CONTEXT_FIELDS = ["messages", "contextHash", "contextBytes"] as const;
const EVIDENCE_FIELDS = [
  "requestId",
  "target",
  "targetHash",
  "source",
  "level",
  "availability",
  "checkResult",
] as const;
const CHALLENGE_FIELDS = [
  "challengeId",
  "target",
  "targetHash",
  "issue",
  "requestIds",
  "status",
  "availability",
] as const;
const ISSUE_FIELDS = [
  "stepLocator",
  "suspectedIssue",
  "rationale",
  "requestedCheck",
  "obligationIds",
] as const;
const LOCATOR_FIELDS = ["start", "end", "quote"] as const;
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

const RECORD_STATES = ["ADMITTED", "DISPATCHED", "RETURNED", "OUTCOME_UNKNOWN"] as const;
const TRANSPORT_STATES = ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const;
const AVAILABILITY = ["ACTIVE", "STALE"] as const;
const CHALLENGE_STATUS = ["CHALLENGED", "UNKNOWN"] as const;
const EVIDENCE_LEVEL = ["PROVISIONAL", "REVIEWED"] as const;
const CONCLUSIONS = ["NO_ISSUE", "ISSUES", "UNKNOWN"] as const;
const ISSUE_KINDS = [
  "ZERO_DIVISOR",
  "NON_EQUIVALENT",
  "QUANTIFIER_SHIFT",
  "MISSING_CASE",
  "UNPROVED_PREMISE",
  "UNSUPPORTED_CONCLUSION",
  "OTHER",
] as const;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function ms(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) {
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

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > max) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return value;
}

function enumOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return value as T;
}

function requireContract(contract: unknown): P2Contract {
  if (!isPlainObject(contract)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const envelope = (contract as Record<string, unknown>).envelope;
  if (!isPlainObject(envelope) || envelope.sourceModule !== "M1") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const sessionId = envelope.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const problemFullText = (contract as Record<string, unknown>).problemFullText;
  if (typeof problemFullText !== "string" || problemFullText.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const problemHash = p4Hash(problemFullText);
  if (
    (contract as Record<string, unknown>).problemHash !== problemHash ||
    envelope.problemHash !== problemHash
  ) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const version = (contract as Record<string, unknown>).contractVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    fail(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (envelope.contractVersion !== version) {
    fail(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  return contract as unknown as P2Contract;
}

/** The single obligation of the task that produced the protected artifact. */
function taskObligation(contract: P2Contract, binding: P4Binding): { obligationId: string; kind: P2ObligationKind } {
  const task = contract.tasks.find((item) => item.taskId === binding.taskId);
  if (task === undefined) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const obligation = contract.obligations.find((item) => item.obligationId === task.obligationId);
  if (obligation === undefined) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return { obligationId: obligation.obligationId, kind: obligation.kind };
}

/** Real obligation ids of the protected goal/scope, in contract order. */
function allowedObligationIds(contract: P2Contract, binding: P4Binding): readonly string[] {
  return contract.obligations
    .filter(
      (item) =>
        item.goalId === binding.goalId && item.envelope.scopeId === binding.scopeId,
    )
    .map((item) => item.obligationId);
}

function issueKey(issue: Record<string, unknown>): string {
  const locator = exact(issue.stepLocator, LOCATOR_FIELDS);
  const start = locator.start;
  const end = locator.end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end)
  ) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const kind = enumOf(issue.suspectedIssue, ISSUE_KINDS);
  const obligationIds = issue.obligationIds;
  if (!Array.isArray(obligationIds)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const ids: string[] = [];
  for (const item of obligationIds) {
    ids.push(boundedText(item, MAX_SHORT_CHARS));
  }
  return p4Hash(JSON.stringify([start, end, kind, [...ids].sort()]));
}

export class P4CandidateGate {
  private readonly contract: P2Contract;
  private readonly policy: P4DeliveryPolicy;
  private readonly firstReviewOrdinal: number;
  private protectedTarget: P4Target | null = null;

  constructor(contract: P2Contract, policy: P4DeliveryPolicy, firstReviewOrdinal = 2) {
    if (policy !== "BEST_EFFORT" && policy !== "STRICT") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      typeof firstReviewOrdinal !== "number" ||
      !Number.isSafeInteger(firstReviewOrdinal) ||
      firstReviewOrdinal < 2 ||
      firstReviewOrdinal > MAX_REQUEST_ORDINAL
    ) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const frozen = p2Snapshot(contract);
    this.contract = requireContract(frozen);
    this.policy = policy;
    this.firstReviewOrdinal = firstReviewOrdinal;
  }

  /**
   * Record the first eligible candidate. A later different candidate is
   * refused and never replaces the protected record; there is no replace path.
   */
  protect(target: P4Target): boolean {
    const frozen = p2Snapshot(target);
    const rebuilt = p4Target(this.contract, frozen.artifact, frozen.availability);
    if (!p4SameBinding(rebuilt.binding, frozen.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rebuilt.targetHash !== frozen.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (frozen.availability !== "ACTIVE") {
      fail(P2_ERROR_CODES.STALE_DEPENDENCY);
    }
    const packet = frozen.artifact.packet;
    if (packet === null || packet.deliveryStatus !== "COMPLETE") {
      fail(P2_ERROR_CODES.PACKET_DELIVERY);
    }
    if (packet.candidateProposal === null || packet.candidateProposal.trim().length === 0) {
      fail(P2_ERROR_CODES.PACKET_DELIVERY);
    }
    const obligation = taskObligation(this.contract, frozen.binding);
    if (!p2IsAnswerObligationKind(obligation.kind)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (this.protectedTarget === null) {
      this.protectedTarget = p2Snapshot(rebuilt) as P4Target;
      return true;
    }
    if (
      p4SameBinding(this.protectedTarget.binding, rebuilt.binding) &&
      this.protectedTarget.targetHash === rebuilt.targetHash
    ) {
      return true;
    }
    return false;
  }

  private verifyReview(
    review: P4ReviewSnapshot,
    protectedTarget: P4Target,
  ): { readonly mentioned: ReadonlySet<string>; readonly challenges: number } {
    const snapshot = exact(p2Snapshot(review), SNAPSHOT_FIELDS);
    const availability = enumOf(snapshot.availability, AVAILABILITY);
    const targetHash = boundedText(snapshot.targetHash, MAX_SHORT_CHARS);
    if (targetHash !== protectedTarget.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const binding = exact(snapshot.target, P4_BINDING_FIELDS);
    if (!p4SameBinding(binding, protectedTarget.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const allowed = new Set(allowedObligationIds(this.contract, protectedTarget.binding));
    const records = snapshot.records;
    if (!Array.isArray(records) || records.length > MAX_REVIEWS) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (records.length + this.firstReviewOrdinal - 1 > MAX_REQUEST_ORDINAL) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const settledRecords = new Map<string, Record<string, unknown>>();
    const settledReports = new Map<string, Record<string, unknown>>();
    const mentioned = new Set<string>();
    let expected = this.firstReviewOrdinal;
    for (const item of records) {
      const record = exact(item, RECORD_FIELDS);
      const requestId = boundedText(record.requestId, MAX_SHORT_CHARS);
      if (requestId !== `model-${expected}`) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      expected += 1;
      const state = enumOf(record.state, RECORD_STATES);
      const code = enumOf(record.code, REVIEW_CODES);
      const transport =
        record.transportStatus === null ? null : enumOf(record.transportStatus, TRANSPORT_STATES);
      const recordBinding = exact(record.target, P4_BINDING_FIELDS);
      if (!p4SameBinding(recordBinding, protectedTarget.binding)) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (record.targetHash !== protectedTarget.targetHash) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      const context = exact(record.context, CONTEXT_FIELDS);
      const messages = context.messages;
      if (!Array.isArray(messages) || messages.length !== 2) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const roles = ["system", "user"] as const;
      for (let position = 0; position < 2; position += 1) {
        const message = exact(messages[position], ["role", "content"]);
        if (message.role !== roles[position]) {
          fail(P2_ERROR_CODES.PACKET_SCHEMA);
        }
        const content = message.content;
        if (typeof content !== "string" || !detectLoneSurrogates(content).ok) {
          fail(P2_ERROR_CODES.PACKET_SCHEMA);
        }
      }
      const serialized = JSON.stringify(messages);
      if (context.contextHash !== p4Hash(serialized)) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      const bytes = context.contextBytes;
      if (
        typeof bytes !== "number" ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > MAX_CONTEXT_BYTES ||
        bytes !== Buffer.byteLength(serialized, "utf8")
      ) {
        fail(P2_ERROR_CODES.BOUND_EXCEEDED);
      }
      const raw = record.rawResponseText;
      const report = record.report;
      if (raw !== null && typeof raw !== "string") {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      if (state === "ADMITTED" || state === "DISPATCHED") {
        if (transport !== null || raw !== null || report !== null || code !== "NOT_DISPATCHED") {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        continue;
      }
      if (state === "OUTCOME_UNKNOWN") {
        if (transport !== "UNKNOWN" || code !== "OUTCOME_UNKNOWN" || report !== null) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        if (typeof raw !== "string" || !detectLoneSurrogates(raw).ok) {
          fail(P2_ERROR_CODES.PACKET_SCHEMA);
        }
        if ([...raw].length > MAX_TEXT_CHARS) {
          fail(P2_ERROR_CODES.BOUND_EXCEEDED);
        }
        if (Buffer.byteLength(raw, "utf8") > MAX_CONTEXT_BYTES) {
          fail(P2_ERROR_CODES.BOUND_EXCEEDED);
        }
        settledRecords.set(requestId, record);
        continue;
      }
      if (transport === null || transport === "UNKNOWN") {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (typeof raw !== "string" || !detectLoneSurrogates(raw).ok) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      if ([...raw].length > MAX_TEXT_CHARS) {
        fail(P2_ERROR_CODES.BOUND_EXCEEDED);
      }
      if (Buffer.byteLength(raw, "utf8") > MAX_CONTEXT_BYTES) {
        fail(P2_ERROR_CODES.BOUND_EXCEEDED);
      }
      if (report === null) {
        if (code === "OK") {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        settledRecords.set(requestId, record);
        continue;
      }
      if (transport !== "COMPLETE" || code !== "OK") {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      {
        if (raw.trim().length === 0) {
          fail(P2_ERROR_CODES.PACKET_SCHEMA);
        }
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
        const frozenReport = exact(p2Snapshot(report), REPORT_FIELDS);
        if (!p4JsonEqual(p2Snapshot(parsed), frozenReport)) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        if (frozenReport.schemaVersion !== "p4-review-v1" || frozenReport.stage !== "R2") {
          fail(P2_ERROR_CODES.PACKET_SCHEMA);
        }
        if (frozenReport.requestId !== requestId) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        if (frozenReport.targetHash !== protectedTarget.targetHash) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        const reportBinding = exact(frozenReport.target, P4_BINDING_FIELDS);
        if (!p4SameBinding(reportBinding, protectedTarget.binding)) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        const conclusion = enumOf(frozenReport.conclusion, CONCLUSIONS);
        const coverage = frozenReport.reviewCoverage;
        if (!Array.isArray(coverage) || coverage.length > MAX_COVERAGE) {
          fail(P2_ERROR_CODES.BOUND_EXCEEDED);
        }
        const seen = new Set<string>();
        for (const id of coverage) {
          const value = boundedText(id, MAX_SHORT_CHARS);
          if (seen.has(value) || !allowed.has(value)) {
            fail(P2_ERROR_CODES.PACKET_SCHEMA);
          }
          seen.add(value);
        }
        const issues = frozenReport.issues;
        if (!Array.isArray(issues) || issues.length > MAX_ISSUES) {
          fail(P2_ERROR_CODES.PACKET_SCHEMA);
        }
        for (const issue of issues) {
          const checked = exact(issue, ISSUE_FIELDS);
          issueKey(checked);
          const obligationIds = checked.obligationIds as readonly unknown[];
          for (const id of obligationIds) {
            const value = boundedText(id, MAX_SHORT_CHARS);
            if (!allowed.has(value) || !seen.has(value)) {
              fail(P2_ERROR_CODES.PACKET_SCHEMA);
            }
          }
        }
        if (conclusion === "NO_ISSUE" && issues.length !== 0) {
          fail(P2_ERROR_CODES.PACKET_SCHEMA);
        }
        if (conclusion === "ISSUES" && issues.length === 0) {
          fail(P2_ERROR_CODES.PACKET_SCHEMA);
        }
        if (conclusion === "UNKNOWN" && issues.length !== 0) {
          fail(P2_ERROR_CODES.PACKET_SCHEMA);
        }
        if (availability === "ACTIVE" && conclusion !== "UNKNOWN") {
          for (const id of coverage) {
            mentioned.add(boundedText(id, MAX_SHORT_CHARS));
          }
        }
        settledReports.set(requestId, frozenReport);
      }
      settledRecords.set(requestId, record);
    }
    const evidence = snapshot.evidence;
    if (!Array.isArray(evidence)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (evidence.length !== settledRecords.size) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const evidenceIds = new Set<string>();
    for (const item of evidence) {
      const row = exact(item, EVIDENCE_FIELDS);
      if (row.source !== "MODEL_REVIEW") {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      const level = enumOf(row.level, EVIDENCE_LEVEL);
      if (row.checkResult !== "UNKNOWN") {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (row.availability !== availability) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      const requestId = boundedText(row.requestId, MAX_SHORT_CHARS);
      if (evidenceIds.has(requestId)) {
        fail(P2_ERROR_CODES.DUPLICATE_ID);
      }
      evidenceIds.add(requestId);
      const record = settledRecords.get(requestId);
      if (record === undefined) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      const report = settledReports.get(requestId);
      const expectedLevel =
        report !== undefined &&
        report.conclusion !== "UNKNOWN" &&
        record.code === "OK" &&
        record.transportStatus === "COMPLETE"
          ? "REVIEWED"
          : "PROVISIONAL";
      if (level !== expectedLevel) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      const rowBinding = exact(row.target, P4_BINDING_FIELDS);
      if (!p4SameBinding(rowBinding, protectedTarget.binding)) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (row.targetHash !== protectedTarget.targetHash) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    const challenges = snapshot.challenges;
    if (!Array.isArray(challenges) || challenges.length > MAX_CHALLENGES) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const challengeIds = new Set<string>();
    for (const item of challenges) {
      const row = exact(item, CHALLENGE_FIELDS);
      const challengeId = boundedText(row.challengeId, MAX_SHORT_CHARS);
      if (challengeIds.has(challengeId)) {
        fail(P2_ERROR_CODES.DUPLICATE_ID);
      }
      challengeIds.add(challengeId);
      enumOf(row.status, CHALLENGE_STATUS);
      if (row.availability !== availability) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      const rowBinding = exact(row.target, P4_BINDING_FIELDS);
      if (!p4SameBinding(rowBinding, protectedTarget.binding)) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      if (row.targetHash !== protectedTarget.targetHash) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      const requestIds = row.requestIds;
      if (!Array.isArray(requestIds) || requestIds.length === 0) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const challengeIssue = exact(row.issue, ISSUE_FIELDS);
      const key = issueKey(challengeIssue);
      const seenRequestIds = new Set<string>();
      let first = true;
      for (const id of requestIds) {
        const value = boundedText(id, MAX_SHORT_CHARS);
        if (seenRequestIds.has(value)) {
          fail(P2_ERROR_CODES.DUPLICATE_ID);
        }
        seenRequestIds.add(value);
        const report = settledReports.get(value);
        if (report === undefined) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        const issues = report.issues as readonly unknown[];
        let matched = false;
        for (const issue of issues) {
          const checked = exact(issue, ISSUE_FIELDS);
          if (issueKey(checked) !== key) {
            continue;
          }
          if (first && !p4JsonEqual(p2Snapshot(checked), p2Snapshot(challengeIssue))) {
            fail(P2_ERROR_CODES.PACKET_BINDING);
          }
          matched = true;
          break;
        }
        if (!matched) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        first = false;
      }
    }
    const expectedKeys = new Set<string>();
    for (const report of settledReports.values()) {
      const issues = report.issues as readonly unknown[];
      for (const issue of issues) {
        expectedKeys.add(issueKey(exact(issue, ISSUE_FIELDS)));
      }
    }
    const actualKeys = new Set<string>();
    for (const item of challenges) {
      const row = exact(item, CHALLENGE_FIELDS);
      const key = issueKey(exact(row.issue, ISSUE_FIELDS));
      if (actualKeys.has(key)) {
        fail(P2_ERROR_CODES.DUPLICATE_ID);
      }
      actualKeys.add(key);
      const owners = new Set<string>();
      for (const [requestId, report] of settledReports) {
        const issues = report.issues as readonly unknown[];
        for (const issue of issues) {
          if (issueKey(exact(issue, ISSUE_FIELDS)) === key) {
            owners.add(requestId);
          }
        }
      }
      const listed = new Set<string>();
      for (const id of row.requestIds as readonly unknown[]) {
        listed.add(boundedText(id, MAX_SHORT_CHARS));
      }
      if (listed.size !== owners.size) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      for (const owner of owners) {
        if (!listed.has(owner)) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
      }
    }
    if (actualKeys.size !== expectedKeys.size) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    for (const key of expectedKeys) {
      if (!actualKeys.has(key)) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    return { mentioned, challenges: challenges.length };
  }

  /**
   * S3 final selection under the pre-frozen policy. The first protected
   * candidate is never replaced; a later different or stale candidate only
   * yields STALE_CANDIDATE. No checker exists, so `candidateVerified` stays
   * false and strict acceptance is never performed.
   */
  finalize(
    currentContract: P2Contract,
    currentTarget: P4Target | null,
    review: P4ReviewSnapshot | null,
    remainingMs: number,
  ): P4FinalDecision {
    const frozenContract = requireContract(p2Snapshot(currentContract));
    if (frozenContract.envelope.sessionId !== this.contract.envelope.sessionId) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (frozenContract.problemHash !== this.contract.problemHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (frozenContract.contractVersion < this.contract.contractVersion) {
      fail(P2_ERROR_CODES.VERSION_MISMATCH);
    }
    const remaining = ms(remainingMs, 0, MAX_REMAINING_MS);
    const protectedTarget = this.protectedTarget;
    const protectedBinding = protectedTarget === null ? null : protectedTarget.binding;
    const protectedHash = protectedTarget === null ? null : protectedTarget.targetHash;
    const openObligations = frozenContract.obligations.length;

    if (protectedTarget === null) {
      return this.decision(
        "unsolved",
        UNSOLVED_RESPONSE,
        "WITHHELD",
        null,
        null,
        0,
        openObligations,
        this.coverageRows(frozenContract, null),
        "NO_CANDIDATE",
      );
    }

    let mentioned: ReadonlySet<string> = new Set<string>();
    let challenges = 0;
    if (review !== null) {
      const checked = this.verifyReview(review, protectedTarget);
      challenges = checked.challenges;
      if (frozenContract.contractVersion === this.contract.contractVersion) {
        mentioned = checked.mentioned;
      }
    }

    let stale = false;
    if (frozenContract.contractVersion !== this.contract.contractVersion) {
      stale = true;
    }
    if (currentTarget === null) {
      stale = true;
    } else {
      const frozenTarget = p2Snapshot(currentTarget);
      if (frozenTarget.availability !== "ACTIVE") {
        stale = true;
      } else if (frozenContract.contractVersion === this.contract.contractVersion) {
        const rebuilt = p4Target(frozenContract, frozenTarget.artifact, frozenTarget.availability);
        if (!p4SameBinding(rebuilt.binding, frozenTarget.binding)) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        if (rebuilt.targetHash !== frozenTarget.targetHash) {
          fail(P2_ERROR_CODES.PACKET_BINDING);
        }
        if (
          !p4SameBinding(rebuilt.binding, protectedTarget.binding) ||
          rebuilt.targetHash !== protectedTarget.targetHash
        ) {
          stale = true;
        }
      } else if (
        !p4SameBinding(frozenTarget.binding, protectedTarget.binding) ||
        frozenTarget.targetHash !== protectedTarget.targetHash
      ) {
        stale = true;
      }
    }

    if (stale) {
      return this.decision(
        "unsolved",
        UNSOLVED_RESPONSE,
        "WITHHELD",
        protectedBinding,
        protectedHash,
        challenges,
        openObligations,
        this.coverageRows(frozenContract, null),
        "STALE_CANDIDATE",
      );
    }

    const rows = this.coverageRows(frozenContract, protectedTarget, mentioned);

    if (remaining === 0) {
      return this.decision(
        "unsolved",
        UNSOLVED_RESPONSE,
        "WITHHELD",
        protectedBinding,
        protectedHash,
        challenges,
        openObligations,
        rows,
        "DEADLINE_EXCEEDED",
      );
    }
    if (this.policy === "STRICT") {
      return this.decision(
        "unsolved",
        UNSOLVED_RESPONSE,
        "WITHHELD",
        protectedBinding,
        protectedHash,
        challenges,
        openObligations,
        rows,
        "STRICT_NOT_VERIFIED",
      );
    }
    const packet = protectedTarget.artifact.packet;
    if (packet === null || packet.candidateProposal === null) {
      fail(P2_ERROR_CODES.PACKET_DELIVERY);
    }
    return this.decision(
      "candidate",
      packet.candidateProposal,
      "BEST_EFFORT",
      protectedBinding,
      protectedHash,
      challenges,
      openObligations,
      rows,
      "BEST_EFFORT_CANDIDATE",
    );
  }

  private coverageRows(
    currentContract: P2Contract,
    protectedTarget: P4Target | null,
    mentioned?: ReadonlySet<string>,
  ): readonly P4CoverageRow[] {
    const coveredId =
      protectedTarget === null ? null : taskObligation(this.contract, protectedTarget.binding).obligationId;
    const packet = protectedTarget === null ? null : protectedTarget.artifact.packet;
    const usable =
      packet !== null &&
      packet.deliveryStatus === "COMPLETE" &&
      packet.candidateProposal !== null &&
      packet.candidateProposal.trim().length > 0;
    const rows: P4CoverageRow[] = [];
    for (const obligation of currentContract.obligations) {
      rows.push(
        Object.freeze({
          obligationId: obligation.obligationId,
          kind: obligation.kind,
          deliveryCovered: usable && obligation.obligationId === coveredId,
          reviewMentioned: mentioned !== undefined && mentioned.has(obligation.obligationId),
          checkResult: "UNKNOWN" as const,
        }),
      );
    }
    return Object.freeze(rows);
  }

  private decision(
    status: P4FinalDecision["status"],
    finalResponse: string,
    submissionEligibility: P4FinalDecision["submissionEligibility"],
    protectedCandidate: P4Binding | null,
    targetHash: string | null,
    unresolvedChallenges: number,
    openObligations: number,
    coverage: readonly P4CoverageRow[],
    reason: P4FinalReason,
  ): P4FinalDecision {
    return p2Snapshot({
      mode: "MOCK_ONLY",
      targetEnvironment: "TARGET_UNVERIFIED",
      stage: "S3",
      policy: this.policy,
      status,
      finalResponse,
      candidateVerified: false,
      strictAcceptance: "NOT_PERFORMED",
      submissionEligibility,
      protectedCandidate,
      targetHash,
      unresolvedChallenges,
      openObligations,
      coverage,
      reason,
    }) as P4FinalDecision;
  }

  /** Frozen view of the policy and the protected target; no live reference. */
  snapshot(): { readonly policy: P4DeliveryPolicy; readonly protectedTarget: P4Target | null } {
    return p2Snapshot({
      policy: this.policy,
      protectedTarget: this.protectedTarget,
    }) as { readonly policy: P4DeliveryPolicy; readonly protectedTarget: P4Target | null };
  }
}
