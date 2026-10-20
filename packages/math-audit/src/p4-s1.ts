/**
 * @astra/math-audit — P4 S1 diagnostic-evidence ledger (pure, no I/O).
 *
 * Binds the two existing registered executors' P3 request/receipt facts to a
 * P4 target. No semantic checker exists, so every row stays
 * PROGRAM_OBSERVATION/PROVISIONAL/UNKNOWN, `semanticMapping` stays UNKNOWN and
 * no row can support an obligation. A structural match is not a mathematical
 * check and never promotes evidence to CHECKED_SCOPE/FORMAL or a PASS.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  canonicalScope,
  detectLoneSurrogates,
  p2Snapshot,
  validateP2Scope,
  type P2Contract,
  type P3Binding,
  type P3EffectReceipt,
  type P3EffectRequest,
  type P4Binding,
  type P4CheckPlan,
  type P4CheckRecord,
  type P4CheckedProperty,
  type P4DiagnosticEvidence,
  type P4S1Assessment,
  type P4S1Reason,
  type P4Target,
} from "@astra/protocol";
import { p4Hash, p4JsonEqual, p4SameBinding, p4Target } from "@astra/protocol";

const CHECK_IDS = ["check-1", "check-2"] as const;
const EFFECT_IDS = ["effect-1", "effect-2"] as const;
const REQUEST_ID = /^model-(?:[1-9][0-9]{0,2})$/u;
const TOOL_VERSION = "tool-registry-v1";
const MAX_ARGS_BYTES = 10000;
const MAX_OBSERVATION_BYTES = 16000;
const MAX_SCOPE_WORDING = 256;
const MAX_OBLIGATIONS = 32;
const MAX_ASSUMPTIONS = 32;
const MIN_REMAINING_MS = 26;
const MAX_REMAINING_MS = 3_600_000;
const LATE_MS = 25;
const HASH = /^[0-9a-f]{64}$/u;

type Code = (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES];

function fail(code: Code): never {
  throw new P2Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) {
    return false;
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return false;
    }
  }
  return true;
}

function text(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectLoneSurrogates(value).ok) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if ([...value].length > maxChars) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

function ms(value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > MAX_REMAINING_MS) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function copyReceipt(receipt: P3EffectReceipt): P3EffectReceipt {
  return p2Snapshot(receipt);
}

/**
 * The S1 checked-property of one registered checker tool, or null when the tool
 * is not an S1 checker. Exported so the control side can build one S1 check plan
 * for a real effect request without re-implementing the mapping.
 */
export function p4CheckedPropertyForTool(name: string): P4CheckedProperty | null {
  return propertyOf(name);
}

function propertyOf(name: string): P4CheckedProperty | null {
  if (name === "polynomial_expand_coefficients") {
    return "SUPPLIED_POLYNOMIAL_COEFFICIENTS";
  }
  if (name === "linear_system_solution_set") {
    return "SUPPLIED_LINEAR_SOLUTION_SET";
  }
  return null;
}

type CommonBinding = Pick<
  P4Binding,
  "sessionId" | "problemHash" | "contractVersion" | "taskId" | "scopeId"
>;

function sameBindingFields(left: CommonBinding, right: CommonBinding): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.problemHash === right.problemHash &&
    left.contractVersion === right.contractVersion &&
    left.taskId === right.taskId &&
    left.scopeId === right.scopeId
  );
}

/**
 * S1 diagnostic ledger for one ACTIVE target. It records at most `maxChecks`
 * (0..2) admitted checks, never retries an UNKNOWN/late outcome and never
 * promotes evidence. `markStale` only marks availability STALE.
 */
export class P4DiagnosticLedger {
  private readonly contract: P2Contract;
  private readonly target: P4Target;
  private readonly maxChecks: number;
  private readonly records: P4CheckRecord[];
  private availability: "ACTIVE" | "STALE";
  private blocked: boolean;

  constructor(contract: P2Contract, target: P4Target, maxChecks = 2) {
    if (typeof maxChecks !== "number" || !Number.isSafeInteger(maxChecks) || maxChecks < 0 || maxChecks > 2) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const frozenContract = p2Snapshot(contract);
    const frozenTarget = p2Snapshot(target);
    if (!isPlainObject(frozenTarget) || !exactKeys(frozenTarget, ["binding", "targetHash", "artifact", "availability"])) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (frozenTarget.availability !== "ACTIVE") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const rebuilt = p4Target(frozenContract, frozenTarget.artifact, "ACTIVE");
    if (!p4SameBinding(rebuilt.binding, frozenTarget.binding) || rebuilt.targetHash !== frozenTarget.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    this.contract = frozenContract;
    this.target = rebuilt;
    this.maxChecks = maxChecks;
    this.records = [];
    this.availability = "ACTIVE";
    this.blocked = false;
  }

  private requirePlan(value: unknown): P4CheckPlan {
    const source = p2Snapshot(value);
    if (!detectLoneSurrogates(source).ok) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      !isPlainObject(source) ||
      !exactKeys(source, [
        "checkId",
        "target",
        "targetHash",
        "scope",
        "assumptions",
        "checkedProperty",
        "methodOrToolVersion",
        "obligationIds",
        "request",
      ])
    ) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const checkId = source.checkId;
    if (typeof checkId !== "string" || !(CHECK_IDS as readonly string[]).includes(checkId)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!isPlainObject(source.target) || !p4SameBinding(source.target, this.target.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (source.targetHash !== this.target.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const scope = validateP2Scope(source.scope);
    if (scope.scopeId !== p4Hash(canonicalScope(scope))) {
      fail(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    if (!Array.isArray(source.assumptions)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (source.assumptions.length > MAX_ASSUMPTIONS) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const assumptions = source.assumptions.map((item) => text(item, MAX_SCOPE_WORDING));
    const checkedProperty = source.checkedProperty;
    if (
      checkedProperty !== "SUPPLIED_POLYNOMIAL_COEFFICIENTS" &&
      checkedProperty !== "SUPPLIED_LINEAR_SOLUTION_SET"
    ) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (source.methodOrToolVersion !== TOOL_VERSION) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!Array.isArray(source.obligationIds) || source.obligationIds.length === 0 || source.obligationIds.length > MAX_OBLIGATIONS) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const obligationIds = source.obligationIds.map((item) => text(item, MAX_SCOPE_WORDING));
    if (new Set(obligationIds).size !== obligationIds.length) {
      fail(P2_ERROR_CODES.DUPLICATE_ID);
    }
    const request = this.requireRequest(source.request);
    return p2Snapshot({
      checkId,
      target: this.target.binding,
      targetHash: this.target.targetHash,
      scope,
      assumptions,
      checkedProperty,
      methodOrToolVersion: TOOL_VERSION,
      obligationIds,
      request,
    }) as P4CheckPlan;
  }

  private requireRequest(value: unknown): P3EffectRequest {
    if (!isPlainObject(value) || !exactKeys(value, ["effectId", "binding", "action", "remainingMs"])) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const effectId = value.effectId;
    if (typeof effectId !== "string" || !(EFFECT_IDS as readonly string[]).includes(effectId)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const binding = value.binding;
    if (
      !isPlainObject(binding) ||
      !exactKeys(binding, ["sessionId", "problemHash", "contractVersion", "taskId", "scopeId", "sourceRequestId"])
    ) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const sessionId = text(binding.sessionId, 128);
    const problemHash = hash(binding.problemHash);
    const contractVersion = binding.contractVersion;
    if (typeof contractVersion !== "number" || !Number.isSafeInteger(contractVersion) || contractVersion <= 0) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const taskId = text(binding.taskId, 256);
    const scopeId = hash(binding.scopeId);
    const sourceRequestId = binding.sourceRequestId;
    if (typeof sourceRequestId !== "string" || !REQUEST_ID.test(sourceRequestId)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const bound: P3Binding = {
      sessionId,
      problemHash,
      contractVersion,
      taskId,
      scopeId,
      sourceRequestId,
    };
    if (!sameBindingFields(bound, this.target.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const action = value.action;
    if (!isPlainObject(action) || !exactKeys(action, ["action", "name", "args", "scope"])) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (action.action !== "tool") {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const name = action.name;
    if (typeof name !== "string" || propertyOf(name) === null) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (!isPlainObject(action.args)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const args = p2Snapshot(action.args);
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > MAX_ARGS_BYTES) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const wording = text(action.scope, MAX_SCOPE_WORDING);
    const remainingMs = ms(value.remainingMs, MIN_REMAINING_MS);
    return p2Snapshot({
      effectId,
      binding: bound,
      action: { action: "tool", name, args, scope: wording },
      remainingMs,
    }) as P3EffectRequest;
  }

  private assessment(plan: P4CheckPlan, reason: P4S1Reason, structuralMatch: boolean): P4S1Assessment {
    return Object.freeze({
      stage: "S1",
      checkId: plan.checkId,
      target: plan.target,
      targetHash: plan.targetHash,
      structuralMatch,
      semanticResult: "UNKNOWN",
      canSupportObligation: false,
      reason,
    });
  }

  private structuralReason(plan: P4CheckPlan): P4S1Reason | null {
    if (this.availability === "STALE" || this.target.availability === "STALE") {
      return "STALE_TARGET";
    }
    if (!p4JsonEqual(plan.scope, this.target.artifact.scope)) {
      return "SCOPE_MISMATCH";
    }
    const declared = this.target.artifact.packet?.assumptions ?? [];
    if (!p4JsonEqual(plan.assumptions, declared)) {
      return "ASSUMPTIONS_MISMATCH";
    }
    const action = plan.request.action;
    if (action.action !== "tool" || propertyOf(action.name) !== plan.checkedProperty) {
      return "UNSUPPORTED_CHECK";
    }
    if (action.name === "linear_system_solution_set") {
      const domain = plan.scope.domain;
      const declaredDomain = (action.args as Record<string, unknown>).domain;
      if (
        (domain === "REAL" || domain === "RATIONAL") &&
        (declaredDomain === "REAL" || declaredDomain === "RATIONAL") &&
        domain !== declaredDomain
      ) {
        return "SCOPE_MISMATCH";
      }
    }
    const goals = this.contract.obligations;
    for (const obligationId of plan.obligationIds) {
      const obligation = goals.find((item) => item.obligationId === obligationId);
      if (obligation === undefined) {
        return "UNSUPPORTED_CHECK";
      }
      if (obligation.goalId !== this.target.binding.goalId) {
        return "UNSUPPORTED_CHECK";
      }
      if (obligation.envelope.scopeId !== this.target.binding.scopeId) {
        return "UNSUPPORTED_CHECK";
      }
    }
    return null;
  }

  /** Structural precheck only; the semantic result stays UNKNOWN. */
  precheck(plan: P4CheckPlan): P4S1Assessment {
    const bound = this.requirePlan(plan);
    const reason = this.structuralReason(bound);
    if (reason !== null) {
      return this.assessment(bound, reason, false);
    }
    return this.assessment(bound, "STRUCTURAL_MATCH_ONLY", true);
  }

  /** Admit one structurally matching check; no receipt is produced here. */
  admit(plan: P4CheckPlan, remainingMs: number): P4CheckRecord {
    const original = this.requirePlan(plan);
    const budget = ms(remainingMs, MIN_REMAINING_MS);
    const bound = p2Snapshot({
      ...original,
      request: {
        ...original.request,
        remainingMs: Math.min(original.request.remainingMs, budget),
      },
    }) as P4CheckPlan;
    const reason = this.structuralReason(bound);
    if (reason !== null) {
      fail(reason === "STALE_TARGET" ? P2_ERROR_CODES.NOT_REUSABLE : P2_ERROR_CODES.PACKET_BINDING);
    }
    if (this.blocked) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    for (const record of this.records) {
      if (record.state === "ADMITTED" || record.state === "DISPATCHED") {
        fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
      }
    }
    if (this.records.length >= this.maxChecks) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    const expected = CHECK_IDS[this.records.length];
    if (bound.checkId !== expected) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    for (const record of this.records) {
      if (record.plan.request.effectId === bound.request.effectId) {
        fail(P2_ERROR_CODES.DUPLICATE_REQUEST_ID);
      }
      if (record.plan.request.binding.sourceRequestId === bound.request.binding.sourceRequestId) {
        fail(P2_ERROR_CODES.DUPLICATE_REQUEST_ID);
      }
    }
    const record: P4CheckRecord = Object.freeze({
      plan: bound,
      assessment: this.assessment(bound, "STRUCTURAL_MATCH_ONLY", true),
      state: "ADMITTED",
      receipt: null,
      evidence: null,
      code: "STRUCTURAL_ONLY",
    });
    this.records.push(record);
    return record;
  }

  private lastDispatched(checkId: string): P4CheckRecord {
    const last = this.records[this.records.length - 1];
    if (last === undefined || last.plan.checkId !== checkId || last.state !== "DISPATCHED") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    return last;
  }

  /** Move the last ADMITTED record to DISPATCHED, exactly once. */
  markDispatched(checkId: string): P4CheckRecord {
    const last = this.records[this.records.length - 1];
    if (last === undefined || last.plan.checkId !== checkId || last.state !== "ADMITTED") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const next: P4CheckRecord = Object.freeze({
      plan: last.plan,
      assessment: last.assessment,
      state: "DISPATCHED",
      receipt: null,
      evidence: null,
      code: "STRUCTURAL_ONLY",
    });
    this.records[this.records.length - 1] = next;
    return next;
  }

  private requireReceipt(rawReceipt: unknown, request: P3EffectRequest): P3EffectReceipt {
    const value = p2Snapshot(rawReceipt);
    if (!detectLoneSurrogates(value).ok) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      !isPlainObject(value) ||
      !exactKeys(value, [
        "effectId",
        "binding",
        "status",
        "source",
        "observation",
        "observationHash",
        "level",
        "checkResult",
      ])
    ) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (value.effectId !== request.effectId) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const binding = value.binding;
    if (
      !isPlainObject(binding) ||
      !exactKeys(binding, ["sessionId", "problemHash", "contractVersion", "taskId", "scopeId", "sourceRequestId"])
    ) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    for (const key of ["sessionId", "problemHash", "contractVersion", "taskId", "scopeId", "sourceRequestId"] as const) {
      if (binding[key] !== request.binding[key]) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    const status = value.status;
    if (status !== "COMPLETE" && status !== "ERROR" && status !== "UNKNOWN") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (value.source !== "PROGRAM_OBSERVATION") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const observation = value.observation;
    if (typeof observation !== "string" || observation.trim().length === 0) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!detectLoneSurrogates(observation).ok) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (Buffer.byteLength(observation, "utf8") > MAX_OBSERVATION_BYTES) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const observationHash = hash(value.observationHash);
    if (p4Hash(observation) !== observationHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (value.level !== "PROVISIONAL" || value.checkResult !== "UNKNOWN") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    return copyReceipt({
      effectId: request.effectId,
      binding: request.binding,
      status,
      source: "PROGRAM_OBSERVATION",
      observation,
      observationHash,
      level: "PROVISIONAL",
      checkResult: "UNKNOWN",
    } as P3EffectReceipt);
  }

  private evidenceOf(plan: P4CheckPlan, receipt: P3EffectReceipt, index: number): P4DiagnosticEvidence {
    const action = plan.request.action;
    if (action.action !== "tool") {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const inputHash = p4Hash(JSON.stringify([action.name, action.args]));
    return Object.freeze({
      evidenceId: `evidence-${index}`,
      target: plan.target,
      targetHash: plan.targetHash,
      scope: plan.scope,
      assumptions: plan.assumptions,
      checkedProperty: plan.checkedProperty,
      methodOrToolVersion: plan.methodOrToolVersion,
      inputHash,
      outputHash: receipt.observationHash,
      requestId: plan.request.binding.sourceRequestId,
      effectId: plan.request.effectId,
      checkerCoverage: plan.obligationIds,
      source: "PROGRAM_OBSERVATION",
      level: "PROVISIONAL",
      availability: "ACTIVE",
      checkResult: "UNKNOWN",
      semanticMapping: "UNKNOWN",
      canSupportObligation: false,
    });
  }

  /**
   * Settle the last DISPATCHED record. A rejected receipt leaves the record
   * DISPATCHED and is never retried automatically.
   */
  settle(checkId: string, receipt: P3EffectReceipt, remainingMs: number): P4CheckRecord {
    const last = this.lastDispatched(checkId);
    const budget = ms(remainingMs, 0);
    const bound = this.requireReceipt(receipt, last.plan.request);
    let next: P4CheckRecord;
    if (bound.status === "UNKNOWN") {
      next = Object.freeze({
        plan: last.plan,
        assessment: last.assessment,
        state: "OUTCOME_UNKNOWN",
        receipt: bound,
        evidence: null,
        code: "OUTCOME_UNKNOWN",
      });
    } else if (budget <= LATE_MS) {
      next = Object.freeze({
        plan: last.plan,
        assessment: last.assessment,
        state: "OBSERVED",
        receipt: bound,
        evidence: null,
        code: "DEADLINE_EXCEEDED",
      });
    } else if (bound.status === "ERROR") {
      next = Object.freeze({
        plan: last.plan,
        assessment: last.assessment,
        state: "OBSERVED",
        receipt: bound,
        evidence: null,
        code: "ERROR",
      });
    } else {
      const evidence = this.evidenceOf(last.plan, bound, this.records.length);
      next = Object.freeze({
        plan: last.plan,
        assessment: last.assessment,
        state: "OBSERVED",
        receipt: bound,
        evidence,
        code: "OBSERVED",
      });
    }
    if (next.code === "OUTCOME_UNKNOWN" || next.code === "DEADLINE_EXCEEDED") {
      this.blocked = true;
    }
    this.records[this.records.length - 1] = next;
    return next;
  }

  /** Mark the target and every evidence row STALE; no record is dropped. */
  markStale(): void {
    const last = this.records[this.records.length - 1];
    if (last !== undefined && (last.state === "ADMITTED" || last.state === "DISPATCHED")) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.availability === "STALE") {
      return;
    }
    this.availability = "STALE";
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index]!;
      if (record.evidence === null) {
        continue;
      }
      this.records[index] = Object.freeze({
        plan: record.plan,
        assessment: record.assessment,
        state: record.state,
        receipt: record.receipt,
        evidence: Object.freeze({ ...record.evidence, availability: "STALE" as const }),
        code: record.code,
      });
    }
  }

  /** Deep-frozen copy of every check record; no live reference escapes. */
  snapshot(): readonly P4CheckRecord[] {
    return p2Snapshot(this.records);
  }

}
