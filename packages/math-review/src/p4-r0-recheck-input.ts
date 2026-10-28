/**
 * @astra/math-review — P4 R0 revised-plan recheck input validation (pure).
 *
 * Validates one `P4R0RecheckPreparation` handed over by trusted M1. It does
 * not authenticate arbitrary external objects, does not import the M1
 * contract module and does not re-derive the revision: M1 already replayed the
 * real ledger, so no template or revision-policy algorithm is duplicated here.
 * A structural pass is never a mathematical result: `semanticResult` stays
 * `UNKNOWN` and `canSupportObligation` stays false.
 */

import {
  P2_LIMITS,
  P2Error,
  P2_ERROR_CODES,
  P4_R0_RECHECK_ACTION,
  P4_R0_RECHECK_SCHEMA_VERSION,
  P4_R0_REVISION_SCHEMA_VERSION,
  decodeFrame,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
  p2Snapshot,
  p4Hash,
  p4JsonEqual,
  P2_GOAL_KIND,
  type P2Contract,
  type P2Event,
  type P2GoalKind,
  type P2GoalSpec,
  type P4R0Binding,
  type P4R0RecheckPreparation,
  type P4R0RevisionDelta,
  type P4R0RevisionLineage,
  type P4R0RevisionRecord,
  type P4R0RevisionReport,
  type P4R0RevisionSnapshot,
} from "@astra/protocol";

import { validateRecheckContract } from "./p4-r0-recheck-contract.js";

const MAX_RAW_CHARS = 20000;
const MAX_RAW_BYTES = 65536;
const MAX_CONTEXT_CHARS = 65536;
const MAX_CONTEXT_BYTES = 65536;
const MAX_PLAN_BYTES = 65536;
const MAX_ID_CHARS = 256;
const MAX_RECORD_ID_CHARS = 4096;
const CONTEXT_SCHEMA_VERSION = "p4-r0-revision-context-v1" as const;

function need(condition: unknown): asserts condition {
  if (!condition) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}

const isObj = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  need(isObj(value));
  const source = value as Record<string, unknown>;
  need(Object.keys(source).length === keys.length);
  for (const key of keys) {
    need(Object.prototype.hasOwnProperty.call(source, key));
  }
  return source;
};

const num = (value: unknown, min: number, max: number): number => {
  need(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max);
  return value as number;
};

const id = (value: unknown, max = MAX_ID_CHARS): string => {
  need(typeof value === "string" && value.length > 0 && [...value].length <= max);
  need(detectLoneSurrogates(value).ok);
  return value as string;
};

const hash = (value: unknown): string => {
  need(typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
  return value as string;
};

const positiveInt = (value: unknown): number => {
  need(typeof value === "number" && Number.isSafeInteger(value) && value >= 1);
  return value as number;
};

const PREP = [
  "target",
  "parent",
  "reviewHash",
  "revisionHash",
  "revision",
  "action",
  "planningModelCalls",
  "remainingRootCalls",
  "remainingMs",
  "semanticResult",
  "canSupportObligation",
] as const;
const TARGET = ["binding", "contract", "planText"] as const;
const BINDING = ["sessionId", "problemHash", "contractVersion", "planHash"] as const;
const SNAPSHOT = [
  "parent",
  "reviewHash",
  "availability",
  "record",
  "parentContract",
  "revisedContract",
  "delta",
  "events",
] as const;
const RECORD = [
  "requestId",
  "parent",
  "reviewHash",
  "context",
  "state",
  "transportStatus",
  "rawResponseText",
  "report",
  "code",
  "lineage",
  "availability",
] as const;
const LINEAGE = [
  "parent",
  "child",
  "reviewHash",
  "sourceRequestId",
  "changedGoalIds",
  "requiresRecheck",
  "canActivate",
  "checkResult",
  "canSupport",
] as const;
const DELTA = [
  "fromVersion",
  "toVersion",
  "changedGoalIds",
  "affectedTaskIds",
  "preservedTaskIds",
  "removedTaskIds",
] as const;
const REPORT = [
  "schemaVersion",
  "requestId",
  "parent",
  "reviewHash",
  "changes",
] as const;
const CHANGE = [
  "goalId",
  "fromKind",
  "toKind",
  "issueDimension",
  "rationale",
  "problemSpan",
  "planSpan",
] as const;
const EVENT = [
  "eventId",
  "sessionId",
  "eventSeq",
  "eventType",
  "sourceModule",
  "contractVersion",
] as const;
const CONTEXT = ["messages", "contextHash", "contextBytes"] as const;
const MESSAGE = ["role", "content"] as const;
const CONTEXT_BODY = [
  "schemaVersion",
  "stage",
  "requestId",
  "parent",
  "reviewHash",
  "problemFullText",
  "planText",
  "issueRows",
  "allowedLeaves",
  "allowedToKinds",
  "limits",
  "untrustedDataNotice",
] as const;

/** Strict JSON guards: lone surrogates, codepoint/byte bounds, duplicate keys. */
function strictJson(rawtext: string, maxChars: number): unknown {
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

/** Bounded, duplicate-free list of legal ids. */
function idList(value: unknown, max: number): readonly string[] {
  need(Array.isArray(value) && value.length <= max);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const item = id(entry);
    need(!seen.has(item));
    seen.add(item);
    out.push(item);
  }
  return out;
}

function checkBinding(value: unknown, expected: P4R0Binding): void {
  const binding = exact(value, BINDING);
  need(p4JsonEqual(binding, expected));
}

function checkContext(
  value: unknown,
  parent: P4R0Binding,
  reviewHash: string,
  parentContract: P2Contract,
  parentPlanText: string,
): void {
  const context = exact(value, CONTEXT);
  need(Array.isArray(context.messages) && context.messages.length === 2);
  const messages: { readonly role: "system" | "user"; readonly content: string }[] = [];
  for (const item of context.messages) {
    const message = exact(item, MESSAGE);
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

  const payload = strictJson(messages[1]?.content ?? "", MAX_CONTEXT_CHARS);
  const body = exact(payload, CONTEXT_BODY);
  need(body.schemaVersion === CONTEXT_SCHEMA_VERSION);
  need(body.stage === "R0");
  need(body.requestId === "model-2");
  checkBinding(body.parent, parent);
  need(body.reviewHash === reviewHash);
  need(body.problemFullText === parentContract.problemFullText);
  need(body.planText === parentPlanText);
  need(typeof body.untrustedDataNotice === "string" && body.untrustedDataNotice.trim().length > 0);
}

function checkEvents(
  value: unknown,
  parent: P4R0Binding,
  child: P4R0Binding,
  parentSeq: number,
): void {
  need(Array.isArray(value) && value.length === 2);
  const expectedTypes = ["CONTRACT_COMPILED", "GOALS_REVISED"] as const;
  const expectedVersions = [parent.contractVersion, child.contractVersion] as const;
  const expectedSeqs = [parentSeq, parentSeq + 1] as const;
  for (let index = 0; index < 2; index += 1) {
    const event = exact(value[index], EVENT) as unknown as P2Event;
    need(event.eventType === expectedTypes[index]);
    need(event.sourceModule === "M1");
    need(event.sessionId === parent.sessionId);
    need(event.contractVersion === expectedVersions[index]);
    need(event.eventSeq === expectedSeqs[index]);
    need(event.eventId === `${parent.sessionId}:event:${event.eventSeq}`);
  }
}

/** The exact leaf goal tree produced by retyping only the recorded changes. */
function expectedGoalTree(
  parentGoals: readonly P2GoalSpec[],
  kinds: ReadonlyMap<string, P2GoalKind>,
): readonly P2GoalSpec[] {
  return parentGoals.map((goal) => {
    const kind = kinds.get(goal.goalId);
    return {
      goalId: goal.goalId,
      kind: kind === undefined ? goal.kind : kind,
      scope: goal.scope,
      subgoals: expectedGoalTree(goal.subgoals, kinds),
    };
  });
}

/**
 * Check the recorded `model-2` report shape and derive the retyped goal tree.
 *
 * Only the seven declared change fields are allowed; every row must name a
 * distinct existing leaf goal, `fromKind` must equal that goal's recorded kind
 * and `toKind` must be a different non-MULTIPART kind. The rationale and span
 * semantics are replayed by M1, so they are not duplicated here.
 */
function checkRevisionReport(
  value: unknown,
  parent: P4R0Binding,
  reviewHash: string,
  parentContract: P2Contract,
): ReadonlyMap<string, P2GoalKind> {
  const report = exact(value, REPORT);
  need(report.schemaVersion === P4_R0_REVISION_SCHEMA_VERSION);
  need(report.requestId === "model-2");
  checkBinding(report.parent, parent);
  need(report.reviewHash === reviewHash);
  need(Array.isArray(report.changes));
  need(report.changes.length >= 1 && report.changes.length <= P2_LIMITS.maxGoals);

  const leaves = new Map<string, P2GoalKind>();
  const collect = (goals: readonly P2GoalSpec[]): void => {
    for (const goal of goals) {
      if (goal.subgoals.length === 0 && goal.kind !== "MULTIPART") {
        leaves.set(goal.goalId, goal.kind);
      }
      collect(goal.subgoals);
    }
  };
  collect(parentContract.goals);

  const kinds = new Map<string, P2GoalKind>();
  for (const item of report.changes) {
    const row = exact(item, CHANGE);
    need(typeof row.goalId === "string" && row.goalId.length > 0);
    need(!kinds.has(row.goalId));
    const oldKind = leaves.get(row.goalId);
    need(oldKind !== undefined);
    need(row.fromKind === oldKind);
    need((P2_GOAL_KIND as readonly string[]).includes(row.toKind as string));
    const toKind = row.toKind as P2GoalKind;
    need(toKind !== "MULTIPART");
    need(toKind !== oldKind);
    kinds.set(row.goalId, toKind);
  }
  return kinds;
}

/**
 * Validate one trusted M1 revised-plan recheck preparation.
 *
 * The whole input is deep-frozen once. The parent contract is checked as a
 * pristine contract (all obligations `OPEN`) and the child is checked against
 * that parent plus the recorded delta, so a real `REOPENED` status is preserved
 * and never normalized. The target contract must be structurally equal to
 * `revision.revisedContract` with an exact hash, the child binding must be the
 * real child (`contractVersion` parent+1, same session/problem), the revision
 * snapshot must carry exactly the eight declared fields, and the recorded
 * `model-2` proposal must be ACTIVE/RETURNED/COMPLETE/PROPOSAL_RECORDED with a
 * report, a lineage and a delta whose `changedGoalIds` match the lineage.
 */
export function validateP4R0RecheckInput(
  preparation: P4R0RecheckPreparation,
): P4R0RecheckPreparation {
  try {
    const frozen = p2Snapshot(preparation);
    need(detectLoneSurrogates(frozen).ok);
    const prep = exact(frozen, PREP);
    const target = exact(prep.target, TARGET);
    const binding = exact(target.binding, BINDING) as unknown as P4R0Binding;
    const contract = target.contract as P2Contract;
    const planText = target.planText;

    const parent = exact(prep.parent, BINDING) as unknown as P4R0Binding;
    const reviewHash = hash(prep.reviewHash);
    const revisionHash = hash(prep.revisionHash);

    const revision = exact(prep.revision, SNAPSHOT) as unknown as P4R0RevisionSnapshot;
    need(revisionHash === p4Hash(JSON.stringify(revision)));
    need(revision.availability === "ACTIVE");
    checkBinding(revision.parent, parent);
    need(revision.reviewHash === reviewHash);

    const parentContract = revision.parentContract;
    const revisedContract = revision.revisedContract;
    need(revisedContract !== null);
    const delta = revision.delta;
    need(delta !== null);

    need(parent.sessionId === parentContract.envelope.sessionId);
    need(parent.problemHash === parentContract.problemHash);
    need(parent.contractVersion === parentContract.contractVersion);
    need(parent.planHash === p4Hash(JSON.stringify(parentContract)));

    const record = exact(revision.record, RECORD) as unknown as P4R0RevisionRecord;
    need(record.requestId === "model-2");
    checkBinding(record.parent, parent);
    need(record.reviewHash === reviewHash);
    need(record.state === "RETURNED");
    need(record.transportStatus === "COMPLETE");
    need(record.code === "PROPOSAL_RECORDED");
    need(record.availability === "ACTIVE");
    need(typeof record.rawResponseText === "string");
    need(record.report !== null);
    need(record.lineage !== null);

    const lineage = exact(record.lineage, LINEAGE) as unknown as P4R0RevisionLineage;
    checkBinding(lineage.parent, parent);
    need(lineage.reviewHash === reviewHash);
    need(lineage.sourceRequestId === "model-2");
    need(lineage.requiresRecheck === true);
    need(lineage.canActivate === false);
    need(lineage.checkResult === "UNKNOWN");
    need(lineage.canSupport === false);

    const child = exact(lineage.child, BINDING) as unknown as P4R0Binding;
    need(child.sessionId === parent.sessionId);
    need(child.problemHash === parent.problemHash);
    need(child.contractVersion === parent.contractVersion + 1);
    need(child.planHash === p4Hash(JSON.stringify(revisedContract)));
    checkBinding(binding, child);

    need(p4JsonEqual(contract, revisedContract));
    need(binding.planHash === p4Hash(JSON.stringify(contract)));
    need(contract.contractVersion === child.contractVersion);
    need(contract.problemHash === parent.problemHash);
    need(contract.problemFullText === parentContract.problemFullText);
    need(contract.envelope.sessionId === parent.sessionId);
    need(contract.envelope.eventSeq === parentContract.envelope.eventSeq + 1);

    const expectedPlanText = JSON.stringify({
      goals: contract.goals,
      obligations: contract.obligations,
      tasks: contract.tasks,
      riskHints: contract.riskHints,
    });
    need(planText === expectedPlanText);
    need(Buffer.byteLength(expectedPlanText, "utf8") <= MAX_PLAN_BYTES);

    validateRecheckContract(parentContract);
    validateRecheckContract(contract, parentContract, delta);

    const deltaRow = exact(delta, DELTA) as unknown as P4R0RevisionDelta;
    need(deltaRow.fromVersion === parent.contractVersion);
    need(deltaRow.toVersion === child.contractVersion);
    const changedGoalIds = idList(deltaRow.changedGoalIds, P2_LIMITS.maxGoals);
    need(changedGoalIds.length >= 1);
    const goalIds = new Set<string>();
    const collectGoals = (goals: readonly { readonly goalId: string; readonly subgoals: readonly unknown[] }[]): void => {
      for (const goal of goals) {
        goalIds.add(goal.goalId);
        collectGoals(goal.subgoals as readonly { readonly goalId: string; readonly subgoals: readonly unknown[] }[]);
      }
    };
    collectGoals(parentContract.goals);
    for (const goalId of changedGoalIds) {
      need(goalIds.has(goalId));
    }
    const parentTaskIds = new Set(parentContract.tasks.map((task) => task.taskId));
    const affectedTaskIds = idList(deltaRow.affectedTaskIds, P2_LIMITS.maxTasks);
    const preservedTaskIds = idList(deltaRow.preservedTaskIds, P2_LIMITS.maxTasks);
    const removedTaskIds = idList(deltaRow.removedTaskIds, P2_LIMITS.maxTasks);
    for (const taskId of affectedTaskIds) {
      need(parentTaskIds.has(taskId));
    }
    for (const taskId of preservedTaskIds) {
      need(parentTaskIds.has(taskId));
      need(!affectedTaskIds.includes(taskId));
      need(!removedTaskIds.includes(taskId));
    }
    for (const taskId of removedTaskIds) {
      need(parentTaskIds.has(taskId));
    }
    need(p4JsonEqual(lineage.changedGoalIds, changedGoalIds));

    const kinds = checkRevisionReport(record.report, parent, reviewHash, parentContract);
    need(p4JsonEqual(expectedGoalTree(parentContract.goals, kinds), contract.goals));
    const rawReport = strictJson(record.rawResponseText, MAX_RAW_CHARS);
    need(p4JsonEqual(rawReport, record.report));

    checkContext(record.context, parent, reviewHash, parentContract, JSON.stringify({
      goals: parentContract.goals,
      obligations: parentContract.obligations,
      tasks: parentContract.tasks,
      riskHints: parentContract.riskHints,
    }));

    checkEvents(revision.events, parent, child, parentContract.envelope.eventSeq);

    need(prep.semanticResult === "UNKNOWN");
    need(prep.canSupportObligation === false);
    const planningModelCalls = num(prep.planningModelCalls, 0, 1);
    const remainingRootCalls = num(prep.remainingRootCalls, 0, 2);
    // Same root-deadline domain as the R0 review input: the recheck shares the
    // evaluation item's real remaining time, not a preview-only 5s ceiling.
    const remainingMs = num(prep.remainingMs, 0, 3_600_000);
    need((P4_R0_RECHECK_ACTION as readonly string[]).includes(prep.action as string));
    if (prep.action === "REQUEST_REVIEW") {
      need(planningModelCalls === 1);
      need(remainingRootCalls === 2);
      need(remainingMs >= 26);
    } else {
      need(prep.action === "INSUFFICIENT_BUDGET");
      need(planningModelCalls !== 1 || remainingRootCalls !== 2 || remainingMs < 26);
    }

    return frozen;
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}
