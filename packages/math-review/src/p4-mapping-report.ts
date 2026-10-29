/**
 * @astra/math-review — P4 S1 model semantic-correspondence report parser
 * (pure, no I/O).
 *
 * Parses one raw model mapping text into a strict `P4MappingReviewReport`
 * bound to a supplied target and check plan. A parsed report is a model
 * opinion only: it is never a refutation, never a verification, never a
 * mathematical equivalence proof and never acceptance.
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
  p4Hash,
  p4JsonEqual,
  p4SameBinding,
  p4Target,
  type P2Contract,
  type P3EffectRequest,
  type P4Binding,
  type P4CheckPlan,
  type P4MappingConclusion,
  type P4MappingDimension,
  type P4MappingDimensionRow,
  type P4MappingReviewReport,
  type P4MappingSpan,
  type P4MappingVerdict,
  type P4Target,
} from "@astra/protocol";
import {
  P4_CHECK_TOOL_VERSION,
  P4_MAPPING_CONCLUSION,
  P4_MAPPING_DIMENSIONS,
  P4_MAPPING_REQUEST_ID,
  P4_MAPPING_REVIEW_SCHEMA_VERSION,
  P4_MAPPING_VERDICT,
} from "@astra/protocol";

const MAX_TEXT_CHARS = 20000;
const MAX_BYTES = 65536;
const MAX_RATIONALE_CHARS = 2048;
const MAX_QUOTE_CHARS = 4096;
const MAX_SHORT_CHARS = 256;
const MIN_REMAINING_MS = 26;
const MAX_REMAINING_MS = 3_600_000;

const REPORT_FIELDS = [
  "schemaVersion",
  "requestId",
  "stage",
  "target",
  "targetHash",
  "planHash",
  "conclusion",
  "dimensions",
] as const;
const ROW_FIELDS = [
  "dimension",
  "verdict",
  "rationale",
  "problemSpan",
  "representationSpan",
] as const;
const SPAN_FIELDS = ["start", "end", "quote"] as const;
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
const PLAN_FIELDS = [
  "checkId",
  "target",
  "targetHash",
  "scope",
  "assumptions",
  "checkedProperty",
  "methodOrToolVersion",
  "obligationIds",
  "request",
] as const;
const REQUEST_FIELDS = ["effectId", "binding", "action", "remainingMs"] as const;
const P3_BINDING_FIELDS = [
  "sessionId",
  "problemHash",
  "contractVersion",
  "taskId",
  "scopeId",
  "sourceRequestId",
] as const;
const TARGET_FIELDS = ["binding", "targetHash", "artifact", "availability"] as const;
const ACTION_FIELDS = ["action", "name", "args", "scope"] as const;
const MAX_ARGS_BYTES = 10000;
const MAX_PLAN_BYTES = 65536;
const MAX_OBLIGATIONS = 32;

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

function sameStrings(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function sameP3Binding(left: unknown, right: P4Binding): boolean {
  if (typeof left !== "object" || left === null || Array.isArray(left)) {
    return false;
  }
  const source = left as Record<string, unknown>;
  if (Object.keys(source).length !== P3_BINDING_FIELDS.length) {
    return false;
  }
  for (const field of P3_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      return false;
    }
  }
  return (
    source.sessionId === right.sessionId &&
    source.problemHash === right.problemHash &&
    source.contractVersion === right.contractVersion &&
    source.taskId === right.taskId &&
    source.scopeId === right.scopeId &&
    source.sourceRequestId === right.sourceRequestId
  );
}

/**
 * Structural validation of one mapping review input.
 *
 * Rebuilds the target from the trusted contract/artifact, requires an ACTIVE
 * target, and checks the plan's exact keys, binding, hash, scope, assumptions,
 * property, tool version, obligation ids and effect request. The returned
 * `representationText` is the exact fixed check representation the review is
 * asked about; it is untrusted data and authorizes no operation. A structural
 * match here is not a mathematical check.
 */
export function validateP4MappingInput(
  contract: P2Contract,
  target: P4Target,
  plan: P4CheckPlan,
): {
  readonly target: P4Target;
  readonly plan: P4CheckPlan;
  readonly planHash: string;
  readonly representationText: string;
} {
  try {
    const frozenContract = p2Snapshot(contract);
    const frozenTarget = p2Snapshot(target);
    const frozenPlan = p2Snapshot(plan);
    if (!detectLoneSurrogates(frozenPlan).ok) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (Buffer.byteLength(JSON.stringify(frozenPlan), "utf8") > MAX_PLAN_BYTES) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const targetSource = exact(frozenTarget, TARGET_FIELDS);
    if (targetSource.availability !== "ACTIVE" && targetSource.availability !== "STALE") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (frozenTarget.availability !== "ACTIVE") {
      fail(P2_ERROR_CODES.STALE_DEPENDENCY);
    }
    const rebuilt = p4Target(frozenContract, frozenTarget.artifact, "ACTIVE");
    if (!p4SameBinding(rebuilt.binding, frozenTarget.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rebuilt.targetHash !== frozenTarget.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const planSource = exact(frozenPlan, PLAN_FIELDS);
    if (planSource.checkId !== "check-1") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!p4SameBinding(planSource.target, frozenTarget.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (planSource.targetHash !== frozenTarget.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!p4JsonEqual(planSource.scope, frozenTarget.artifact.scope)) {
      fail(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    if (!sameStrings(planSource.assumptions, frozenTarget.artifact.packet?.assumptions ?? [])) {
      fail(P2_ERROR_CODES.PACKET_SCOPE_VIOLATION);
    }
    const checkedProperty = planSource.checkedProperty;
    if (checkedProperty !== "SUPPLIED_POLYNOMIAL_COEFFICIENTS" &&
        checkedProperty !== "SUPPLIED_LINEAR_SOLUTION_SET") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (planSource.methodOrToolVersion !== P4_CHECK_TOOL_VERSION) {
      fail(P2_ERROR_CODES.VERSION_MISMATCH);
    }
    const request = exact(planSource.request, REQUEST_FIELDS);
    if (request.effectId !== "effect-1") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!sameP3Binding(request.binding, frozenTarget.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if ((request.binding as Record<string, unknown>).sourceRequestId !== "model-1") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (frozenTarget.binding.sourceRequestId !== "model-1") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const remaining = request.remainingMs;
    if (
      typeof remaining !== "number" ||
      !Number.isSafeInteger(remaining) ||
      remaining < MIN_REMAINING_MS ||
      remaining > MAX_REMAINING_MS
    ) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const action = exact(request.action, ACTION_FIELDS);
    if (action.action !== "tool") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const name = action.name;
    if (name !== "polynomial_expand_coefficients" && name !== "linear_system_solution_set") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      (name === "polynomial_expand_coefficients" && checkedProperty !== "SUPPLIED_POLYNOMIAL_COEFFICIENTS") ||
      (name === "linear_system_solution_set" && checkedProperty !== "SUPPLIED_LINEAR_SOLUTION_SET")
    ) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const args = action.args;
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > MAX_ARGS_BYTES) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    if (name === "linear_system_solution_set") {
      const domain = (args as Record<string, unknown>).domain;
      if (domain !== "RATIONAL" && domain !== "REAL") {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
      const scopeDomain = frozenTarget.artifact.scope.domain;
      if (
        (scopeDomain === "RATIONAL" || scopeDomain === "REAL") &&
        scopeDomain !== domain
      ) {
        fail(P2_ERROR_CODES.SCOPE_MISMATCH);
      }
    }
    const actionScope = action.scope;
    if (typeof actionScope !== "string" || actionScope.trim().length === 0 || [...actionScope].length > MAX_SHORT_CHARS) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const allowed = new Set<string>();
    for (const obligation of frozenContract.obligations) {
      if (
        obligation.goalId === frozenTarget.binding.goalId &&
        obligation.envelope.scopeId === frozenTarget.binding.scopeId
      ) {
        allowed.add(obligation.obligationId);
      }
    }
    const obligationIds = planSource.obligationIds;
    if (!Array.isArray(obligationIds) || obligationIds.length === 0 || obligationIds.length > MAX_OBLIGATIONS) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const seen = new Set<string>();
    for (const item of obligationIds) {
      const id = text(item, MAX_SHORT_CHARS);
      if (seen.has(id) || !allowed.has(id)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      seen.add(id);
    }
    const planHash = p4Hash(JSON.stringify(frozenPlan));
    const representationText = JSON.stringify(frozenPlan.request.action);
    return Object.freeze({
      target: frozenTarget,
      plan: frozenPlan,
      planHash,
      representationText,
    });
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
}

function spanOf(
  value: unknown,
  source: string,
  required: boolean,
): P4MappingSpan | null {
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
 * Strict parse of one raw model mapping text against a supplied target and
 * check plan.
 *
 * The target and plan are rebuilt from the trusted contract/artifact and must
 * match exactly; only an ACTIVE target is accepted. The report is bound to
 * `model-2`, the target hash, the plan hash and the S1 stage. A parsed report
 * is a model opinion: it proves nothing and refutes nothing.
 */
export function parseP4MappingReport(
  rawtext: string,
  target: P4Target,
  plan: P4CheckPlan,
  contract: P2Contract,
): P4MappingReviewReport {
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
    const validated = validateP4MappingInput(contract, target, plan);
    const report = exact(frozen, REPORT_FIELDS);
    if (report.schemaVersion !== P4_MAPPING_REVIEW_SCHEMA_VERSION) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (report.requestId !== P4_MAPPING_REQUEST_ID) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.stage !== "S1") {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const binding = exact(report.target, BINDING_FIELDS);
    if (!p4SameBinding(binding, validated.target.binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.targetHash !== validated.target.targetHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (report.planHash !== validated.planHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (!(P4_MAPPING_CONCLUSION as readonly string[]).includes(report.conclusion as string)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const conclusion = report.conclusion as P4MappingConclusion;
    if (!Array.isArray(report.dimensions) || report.dimensions.length !== P4_MAPPING_DIMENSIONS.length) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const problemText = contract.problemFullText;
    const representationText = validated.representationText;
    const rows: P4MappingDimensionRow[] = [];
    const seenDimensions = new Set<string>();
    for (const item of report.dimensions) {
      const row = exact(item, ROW_FIELDS);
      if (!(P4_MAPPING_DIMENSIONS as readonly string[]).includes(row.dimension as string)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const dimension = row.dimension as P4MappingDimension;
      if (seenDimensions.has(dimension)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      seenDimensions.add(dimension);
      if (!(P4_MAPPING_VERDICT as readonly string[]).includes(row.verdict as string)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const verdict = row.verdict as P4MappingVerdict;
      const rationale = text(row.rationale, MAX_RATIONALE_CHARS);
      const required = verdict !== "UNKNOWN";
      const problemSpan = spanOf(row.problemSpan, problemText, required);
      const representationSpan = spanOf(row.representationSpan, representationText, required);
      rows.push(
        Object.freeze({
          dimension,
          verdict,
          rationale,
          problemSpan,
          representationSpan,
        }),
      );
    }
    for (const dimension of P4_MAPPING_DIMENSIONS) {
      if (!seenDimensions.has(dimension)) {
        fail(P2_ERROR_CODES.PACKET_SCHEMA);
      }
    }
    const allMatch = rows.every((row) => row.verdict === "MATCH");
    const anyMismatch = rows.some((row) => row.verdict === "MISMATCH");
    const derived: P4MappingConclusion = allMatch ? "MATCH" : anyMismatch ? "MISMATCH" : "UNKNOWN";
    if (conclusion !== derived) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const frozenBinding: P4Binding = Object.freeze({
      sessionId: validated.target.binding.sessionId,
      problemHash: validated.target.binding.problemHash,
      contractVersion: validated.target.binding.contractVersion,
      artifactId: validated.target.binding.artifactId,
      artifactVersion: validated.target.binding.artifactVersion,
      taskId: validated.target.binding.taskId,
      goalId: validated.target.binding.goalId,
      scopeId: validated.target.binding.scopeId,
      sourceRequestId: validated.target.binding.sourceRequestId,
    });
    return Object.freeze({
      schemaVersion: P4_MAPPING_REVIEW_SCHEMA_VERSION,
      requestId: P4_MAPPING_REQUEST_ID,
      stage: "S1",
      target: frozenBinding,
      targetHash: validated.target.targetHash,
      planHash: validated.planHash,
      conclusion,
      dimensions: Object.freeze(rows),
    });
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
}

export { P4_MAPPING_REVIEW_SCHEMA_VERSION };
