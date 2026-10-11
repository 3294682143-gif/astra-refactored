/**
 * @astra/math-contract — P4 R0 revision input validation (M1 side, pure).
 *
 * Validates one trusted M4 revision trigger against a trusted M1 preparation.
 * It does not authenticate arbitrary external objects, does not import the M4
 * module and does not re-derive the R0 review: M4 owns the full model report
 * replay. A validated trigger is a proposal binding only, never a refutation,
 * never a verification and never acceptance.
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
  p4Hash,
  p4JsonEqual,
  P2_GOAL_KIND,
  type P2GoalKind,
  type P2GoalSpec,
  type P4R0Dimension,
  type P4R0Preparation,
  type P4R0ReviewRecord,
  type P4R0ReviewReport,
  type P4R0ReviewSnapshot,
  type P4R0RevisionChange,
  type P4R0RevisionReport,
  type P4R0RevisionTrigger,
  type P4StepLocator,
} from "@astra/protocol";

import { prepareP4R0 } from "./p4-r0.js";
import { P4_R0_REVISION_SCHEMA_VERSION } from "@astra/protocol";

const MAX_RAW_CHARS = 20000;
const MAX_RAW_BYTES = 65536;
const MAX_CONTEXT_BYTES = 65536;
const MAX_RATIONALE_CHARS = 2048;
const MAX_QUOTE_CHARS = 4096;
const MAX_CHANGES = 8;
const CONTEXT_SCHEMA_VERSION = "p4-r0-context-v1" as const;

const TRIGGER_FIELDS = ["parent", "reviewHash", "issueDimensions", "review"] as const;
const BINDING_FIELDS = ["sessionId", "problemHash", "contractVersion", "planHash"] as const;
const REVIEW_FIELDS = ["target", "planHash", "availability", "record"] as const;
const RECORD_FIELDS = [
  "requestId",
  "target",
  "planHash",
  "source",
  "level",
  "checkResult",
  "canSupportObligation",
  "canReviseContract",
  "availability",
  "state",
  "transportStatus",
  "context",
  "rawResponseText",
  "report",
  "code",
] as const;
const CONTEXT_FIELDS = ["messages", "contextHash", "contextBytes"] as const;
const MESSAGE_FIELDS = ["role", "content"] as const;
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
const CHECK_FIELDS = ["dimension", "verdict", "rationale", "problemSpan", "planSpan"] as const;
const REVISION_FIELDS = [
  "schemaVersion",
  "requestId",
  "parent",
  "reviewHash",
  "changes",
] as const;
const CHANGE_FIELDS = [
  "goalId",
  "fromKind",
  "toKind",
  "issueDimension",
  "rationale",
  "problemSpan",
  "planSpan",
] as const;
const SPAN_FIELDS = ["start", "end", "quote"] as const;

function need(condition: unknown): asserts condition {
  if (!condition) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}

function isObj(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  need(isObj(value));
  const source = value as Record<string, unknown>;
  need(Object.keys(source).length === keys.length);
  for (const key of keys) {
    need(Object.prototype.hasOwnProperty.call(source, key));
  }
  return source;
}

function strictJson(rawtext: string, maxChars = MAX_RAW_CHARS): unknown {
  need(typeof rawtext === "string" && detectLoneSurrogates(rawtext).ok);
  need([...rawtext].length <= maxChars);
  need(Buffer.byteLength(rawtext, "utf8") <= MAX_RAW_BYTES);
  const decoded = decodeFrame(Buffer.from(rawtext, "utf8"));
  need(decoded.ok);
  const raw = decoded.value;
  need(detectDuplicateKeys(raw).ok);
  need(detectNonFiniteTokens(raw).ok);
  need(detectUnsafeNumbers(raw).ok);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    need(false);
  }
  need(detectLoneSurrogates(parsed).ok);
  return parsed;
}

function checkContext(
  value: unknown,
  preparation: P4R0Preparation,
  binding: P4R0Preparation["target"]["binding"],
): void {
  const context = exact(value, CONTEXT_FIELDS);
  need(Array.isArray(context.messages) && context.messages.length === 2);
  const messages: { readonly role: "system" | "user"; readonly content: string }[] = [];
  for (const item of context.messages) {
    const message = exact(item, MESSAGE_FIELDS);
    need(message.role === "system" || message.role === "user");
    need(typeof message.content === "string" && message.content.trim().length > 0);
    need(detectLoneSurrogates(message.content).ok);
    messages.push({ role: message.role, content: message.content });
  }
  need(messages[0]?.role === "system" && messages[1]?.role === "user");
  const serialized = JSON.stringify(messages);
  need(typeof context.contextBytes === "number" && Number.isSafeInteger(context.contextBytes));
  need(context.contextBytes === Buffer.byteLength(serialized, "utf8"));
  need(context.contextBytes <= MAX_CONTEXT_BYTES);
  need(context.contextHash === p4Hash(serialized));

  const payload = strictJson(messages[1]?.content ?? "", MAX_CONTEXT_BYTES);
  const body = exact(payload, [
    "schemaVersion",
    "stage",
    "requestId",
    "target",
    "planHash",
    "problemFullText",
    "planText",
    "riskCodes",
    "reviewCoverage",
    "dimensions",
    "untrustedDataNotice",
  ]);
  need(body.schemaVersion === CONTEXT_SCHEMA_VERSION);
  need(body.stage === "R0");
  need(body.requestId === "model-1");
  need(p4JsonEqual(body.target, binding));
  need(body.planHash === binding.planHash);
  const contract = preparation.target.contract;
  need(body.problemFullText === contract.problemFullText);
  need(body.planText === preparation.target.planText);
  need(p4JsonEqual(body.riskCodes, preparation.riskCodes));
  need(p4JsonEqual(body.reviewCoverage, contract.obligations.map((item) => item.obligationId)));
  need(p4JsonEqual(body.dimensions, P4_R0_DIMENSION));
  need(typeof body.untrustedDataNotice === "string" && body.untrustedDataNotice.trim().length > 0);
}

function checkReport(
  value: unknown,
  preparation: P4R0Preparation,
  binding: P4R0Preparation["target"]["binding"],
): readonly P4R0Dimension[] {
  const report = exact(value, REPORT_FIELDS) as unknown as P4R0ReviewReport;
  need(report.schemaVersion === P4_R0_REVIEW_SCHEMA_VERSION);
  need(report.requestId === "model-1");
  need(report.stage === "R0");
  need(p4JsonEqual(report.target, binding));
  need(report.planHash === binding.planHash);
  need(report.conclusion === "ISSUES");
  need((P4_R0_CONCLUSION as readonly string[]).includes(report.conclusion as string));
  const coverage = report.reviewCoverage;
  const expected = preparation.target.contract.obligations.map((item) => item.obligationId);
  need(Array.isArray(coverage) && coverage.length === expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    need(coverage[index] === expected[index]);
  }
  need(Array.isArray(report.checks) && report.checks.length === P4_R0_DIMENSION.length);
  const seen = new Set<string>();
  const issueDimensions: P4R0Dimension[] = [];
  for (const item of report.checks) {
    const row = exact(item, CHECK_FIELDS);
    need((P4_R0_DIMENSION as readonly string[]).includes(row.dimension as string));
    const dimension = row.dimension as P4R0Dimension;
    need(!seen.has(dimension));
    seen.add(dimension);
    need((P4_R0_VERDICT as readonly string[]).includes(row.verdict as string));
    if (row.verdict === "ISSUES") {
      issueDimensions.push(dimension);
    }
  }
  for (const dimension of P4_R0_DIMENSION) {
    need(seen.has(dimension));
  }
  need(issueDimensions.length > 0);
  return issueDimensions;
}

function spanOf(value: unknown, source: string): P4StepLocator {
  const locator = exact(value, SPAN_FIELDS);
  const start = locator.start;
  const end = locator.end;
  need(typeof start === "number" && Number.isSafeInteger(start) && start >= 0);
  need(typeof end === "number" && Number.isSafeInteger(end) && end > start);
  need(end <= [...source].length);
  need(typeof locator.quote === "string" && locator.quote.length > 0);
  need([...locator.quote].length <= MAX_QUOTE_CHARS);
  need(detectLoneSurrogates(locator.quote).ok);
  need([...source].slice(start, end).join("") === locator.quote);
  return Object.freeze({ start, end, quote: locator.quote });
}

/**
 * Strict parse of one raw model-2 revision report against a trusted M1
 * preparation and a trusted M4 trigger.
 *
 * The preparation/trigger pair must pass `validateP4R0RevisionInput`. Only
 * existing leaf goals may be retyped: `fromKind` must equal the recorded kind,
 * `toKind` must be a different non-MULTIPART kind, the issue dimension must be
 * one the trigger recorded as ISSUES, and the plan span must quote exactly the
 * JSON of that old leaf goal. A parsed report is a proposal record only: it is
 * never a refutation, never a verification and never acceptance.
 */
export function parseP4R0RevisionReport(
  rawtext: string,
  preparation: P4R0Preparation,
  trigger: P4R0RevisionTrigger,
): P4R0RevisionReport {
  try {
    const validated = validateP4R0RevisionInput(preparation, trigger);
    const prep = validated.preparation;
    const trig = validated.trigger;
    const binding = prep.target.binding;
    const contract = prep.target.contract;
    const planText = prep.target.planText;
    const problemText = contract.problemFullText;

    const parsed = strictJson(rawtext);
    const report = exact(parsed, REVISION_FIELDS);
    need(report.schemaVersion === P4_R0_REVISION_SCHEMA_VERSION);
    need(report.requestId === "model-2");
    need(p4JsonEqual(report.parent, binding));
    need(report.reviewHash === trig.reviewHash);

    const leaves = new Map<string, P2GoalSpec>();
    const collect = (goal: P2GoalSpec): void => {
      if (goal.subgoals.length === 0 && goal.kind !== "MULTIPART") {
        leaves.set(goal.goalId, goal);
      }
      for (const child of goal.subgoals) {
        collect(child);
      }
    };
    for (const goal of contract.goals) {
      collect(goal);
    }

    need(Array.isArray(report.changes));
    need(report.changes.length >= 1 && report.changes.length <= MAX_CHANGES);
    const changes: P4R0RevisionChange[] = [];
    const seenGoalIds = new Set<string>();
    for (const item of report.changes) {
      const row = exact(item, CHANGE_FIELDS);
      need(typeof row.goalId === "string" && row.goalId.length > 0);
      need(!seenGoalIds.has(row.goalId));
      seenGoalIds.add(row.goalId);
      const old = leaves.get(row.goalId);
      need(old !== undefined);
      need(row.fromKind === old.kind);
      need((P2_GOAL_KIND as readonly string[]).includes(row.toKind as string));
      const toKind = row.toKind as P2GoalKind;
      need(toKind !== "MULTIPART");
      need(toKind !== old.kind);
      need((P4_R0_DIMENSION as readonly string[]).includes(row.issueDimension as string));
      const issueDimension = row.issueDimension as P4R0Dimension;
      need(trig.issueDimensions.includes(issueDimension));
      need(typeof row.rationale === "string" && row.rationale.trim().length > 0);
      need([...row.rationale].length <= MAX_RATIONALE_CHARS);
      need(detectLoneSurrogates(row.rationale).ok);
      const problemSpan = spanOf(row.problemSpan, problemText);
      const planSpan = spanOf(row.planSpan, planText);
      need(planSpan.quote === JSON.stringify(old));
      changes.push(
        Object.freeze({
          goalId: row.goalId,
          fromKind: old.kind,
          toKind,
          issueDimension,
          rationale: row.rationale,
          problemSpan,
          planSpan,
        }),
      );
    }

    return p2Snapshot({
      schemaVersion: P4_R0_REVISION_SCHEMA_VERSION,
      requestId: "model-2",
      parent: binding,
      reviewHash: trig.reviewHash,
      changes: Object.freeze(changes),
    }) as P4R0RevisionReport;
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}

/**
 * Validate one trusted M4 revision trigger against one trusted M1 preparation.
 *
 * The preparation is rebuilt through `prepareP4R0` and must be JSON-equal to
 * the supplied one with action `REQUEST_REVIEW`; the trigger must bind that
 * parent, the sha256 of the full review snapshot, the exact recorded ISSUES
 * dimensions and a review record that is ACTIVE, RETURNED, transport COMPLETE,
 * code OK, report conclusion ISSUES, exactly REVIEWED, checkResult UNKNOWN,
 * canSupportObligation false and canReviseContract false. The raw text is
 * re-decoded strictly and must be JSON-equal to the recorded report. M4 owns
 * the full model report replay; this validator is not a semantic reviewer.
 */
export function validateP4R0RevisionInput(
  preparation: P4R0Preparation,
  trigger: P4R0RevisionTrigger,
): { readonly preparation: P4R0Preparation; readonly trigger: P4R0RevisionTrigger } {
  try {
    const prep = p2Snapshot(preparation);
    need(detectLoneSurrogates(prep).ok);
    const rebuilt = prepareP4R0(prep.target.contract, {
      enabled: true,
      planningModelCalls: prep.planningModelCalls,
      remainingRootCalls: prep.remainingRootCalls,
      remainingMs: prep.remainingMs,
    });
    need(p4JsonEqual(rebuilt, prep));
    need(prep.action === "REQUEST_REVIEW");
    const binding = prep.target.binding;
    need(prep.target.contract.obligations.every((item) => item.status === "OPEN"));
    need(prep.target.contract.tasks.every((task) => task.delivery === "READY"));

    const trig = p2Snapshot(trigger);
    need(detectLoneSurrogates(trig).ok);
    const triggerBody = exact(trig, TRIGGER_FIELDS);
    const parent = exact(triggerBody.parent, BINDING_FIELDS);
    need(p4JsonEqual(parent, binding));
    const review = exact(triggerBody.review, REVIEW_FIELDS) as unknown as P4R0ReviewSnapshot;
    need(triggerBody.reviewHash === p4Hash(JSON.stringify(review)));
    need(p4JsonEqual(review.target, binding));
    need(review.planHash === binding.planHash);
    need(review.availability === "ACTIVE");

    const record = exact(review.record, RECORD_FIELDS) as unknown as P4R0ReviewRecord;
    need(record.requestId === "model-1");
    need(p4JsonEqual(record.target, binding));
    need(record.planHash === binding.planHash);
    need(record.source === "MODEL_REVIEW");
  need(record.level === "REVIEWED");
    need(record.checkResult === "UNKNOWN");
    need(record.canSupportObligation === false);
    need(record.canReviseContract === false);
    need(record.availability === "ACTIVE");
    need(record.state === "RETURNED");
    need(record.transportStatus === "COMPLETE");
    need(record.code === "OK");
    checkContext(record.context, prep, binding);
    need(typeof record.rawResponseText === "string");
    const rawReport = strictJson(record.rawResponseText);
    need(p4JsonEqual(rawReport, record.report));
    const issueDimensions = checkReport(record.report, prep, binding);

    need(Array.isArray(triggerBody.issueDimensions));
    const declared = triggerBody.issueDimensions as readonly P4R0Dimension[];
    need(declared.length === issueDimensions.length);
    for (let index = 0; index < issueDimensions.length; index += 1) {
      need(declared[index] === issueDimensions[index]);
    }

    return p2Snapshot({ preparation: prep, trigger: trig });
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}
