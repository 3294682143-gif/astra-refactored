/**
 * Generic answer-closure diagnostics (pure, no I/O).
 *
 * These checks never prove mathematics and never set `candidateVerified`. They
 * only expose a machine-visible defect between the candidate and one of:
 *
 *   - the options the problem actually states;
 *   - an exact tool observation computed from the same input;
 *   - an independently determinable rational solution set.
 *
 * The caller may spend one bounded model turn to close a defect. The checks are
 * deliberately written in terms of mathematical objects, not item ids, answers
 * or benchmark tables.
 */

import {
  candidateChoiceLetters,
  summarizeCertificate,
  type CertificatePacketView,
} from "./agent-answer-certificate.js";
import {
  polynomialOf,
  rationalSetKeys,
  samePolynomial,
  semanticToolRoute,
  type Poly,
} from "./agent-semantics.js";

export type AnswerClosureKind =
  | "DEGREE_CONSERVATION"
  | "NORMALIZATION"
  | "OPTION_COVERAGE"
  | "REAL_ROOT_COUNT"
  | "SOLUTION_COMPLETENESS"
  | "SPLITTING_FIELD_DEGREE"
  | "INTERPOLATION_RESIDUAL"
  | "OLS_MISMATCH"
  | "GROUP_STRUCTURE_MISMATCH"
  | "OPTION_NUMERIC_CONTRADICTION"
  | "OPTION_VERDICT_CONTRADICTION";

/**
 * What actually grounds one defect. This is provenance for the operator metric,
 * never a proof and never a verification claim:
 *
 *   - `OBSERVATION`   a completed tool observation computed from the same input
 *                     (Sturm count, maximal minors, density integral, ...);
 *   - `CERTIFICATE`   a row of the packet's own CERT1 table (options, markers);
 *   - `TEXT`          wording/notation of the problem or the candidate only.
 */
export type AnswerClosureEvidence = "OBSERVATION" | "CERTIFICATE" | "TEXT";

export interface AnswerClosureDefect {
  readonly kind: AnswerClosureKind;
  readonly detail: string;
  /** Bounded provenance of this defect; every produced defect carries one. */
  readonly evidence?: AnswerClosureEvidence;
}

function defect(
  kind: AnswerClosureKind,
  detail: string,
  evidence: AnswerClosureEvidence,
): AnswerClosureDefect {
  return { kind, detail, evidence };
}

/** The bounded `result` object returned by the exact-check tool. */
export interface ExactObservationView {
  readonly operation?: unknown;
  readonly normalized?: unknown;
  readonly numeric_integral?: unknown;
  readonly nonnegative_samples?: unknown;
  readonly normalized_minors?: unknown;
  readonly complete_for_input?: unknown;
}

/**
 * Operation-keyed access to completed exact-check results. A plain
 * `Map<string, ExactObservationView>` satisfies it. Keying by operation is what
 * keeps a later, unrelated exact operation (e.g. `LIMIT`) from displacing the
 * `MAXIMAL_MINORS` or `DENSITY_CHECK` result a specific diagnostic needs.
 */
export interface ExactObservationIndex {
  readonly get: (operation: string) => ExactObservationView | null | undefined;
}

/** One completed tool observation, independent of the tool family. */
export interface ToolObservationView {
  readonly name: string;
  readonly operation?: string | null;
  readonly result: unknown;
}

export interface AnswerClosureInput {
  readonly problemText: string;
  readonly candidate: string;
  readonly packet: CertificatePacketView;
  /**
   * Completed exact-check results keyed by operation. Preferred over the
   * single-slot `exactObservation` below.
   */
  readonly exactObservations?: ExactObservationIndex | null;
  /**
   * Legacy single exact observation. It only ever satisfies a diagnostic whose
   * operation matches, so it can never ground an unrelated check.
   */
  readonly exactObservation?: ExactObservationView | null;
  /** Every completed tool observation for this run, not only exact checks. */
  readonly toolObservations?: readonly ToolObservationView[] | null;
  /**
   * Canonical keys (`n/d`) of a solution set that was solved independently
   * from the problem text, or null when it is not determinable.
   */
  readonly expectedSolutionKeys?: readonly string[] | null;
  /** The problem asks for every solution/root/case. */
  readonly requiresExhaustive?: boolean;
}

function rows(packet: CertificatePacketView): readonly string[] {
  return Array.isArray(packet.suggestedChecks)
    ? packet.suggestedChecks.filter((row): row is string => typeof row === "string")
    : [];
}

function checkRows(packet: CertificatePacketView): readonly { kind: string; passed: boolean }[] {
  const out: { kind: string; passed: boolean }[] = [];
  for (const row of rows(packet)) {
    if (!row.startsWith("CERT1|CHECK|")) continue;
    const fields = row.split("|");
    if (fields.length < 4) continue;
    out.push({
      kind: (fields[3] ?? "").trim().toUpperCase(),
      passed: /=>\s*PASS\b/iu.test(row),
    });
  }
  return out;
}

function hasPassingCheck(packet: CertificatePacketView, kind: string): boolean {
  return checkRows(packet).some(
    (row) => row.kind === kind.toUpperCase() && row.passed,
  );
}

function hasCompletenessMarker(packet: CertificatePacketView): boolean {
  return rows(packet).some(
    (row) => row.startsWith("CERT1|COMPLETENESS|") && /=>\s*PASS\b/iu.test(row),
  );
}

/**
 * Option letters stated by the problem itself. The punctuation requirement
 * keeps ordinary mathematical variables named A..E out of the set.
 */
export function problemChoiceLetters(problemText: string): string[] {
  const found = new Set<string>();
  for (const match of problemText.matchAll(
    /(?:^|[\s\n（(\[。；;，,？?！!])([A-E])[\.\)、:：\]]/gu,
  )) {
    found.add(match[1]!.toUpperCase());
  }
  return [...found].sort();
}

function optionCoverageDefect(
  problemText: string,
  candidate: string,
  packet: CertificatePacketView,
): AnswerClosureDefect | null {
  const expected = problemChoiceLetters(problemText);
  if (expected.length < 2) return null;
  const summary = summarizeCertificate(packet);
  const stated = [...summary.optionTruths.keys()].sort();
  const candidateLetters = candidateChoiceLetters(candidate);
  // A formula answer to a problem whose text contains labelled subparts is
  // not a multiple-choice answer; only apply the option contract when the
  // model itself used option letters or supplied an option table.
  if (candidateLetters.length === 0 && stated.length === 0) return null;
  if (stated.length === 0) {
    return defect(
      "OPTION_COVERAGE",
      "the answer uses option letters but the packet has no CERT1|OPTIONS table",
      "CERTIFICATE",
    );
  }
  const missing = expected.filter((letter) => !stated.includes(letter));
  if (missing.length > 0) {
    return defect(
      "OPTION_COVERAGE",
      "the CERT1|OPTIONS table does not cover option(s) " + missing.join(", "),
      "CERTIFICATE",
    );
  }
  const extra = stated.filter((letter) => !expected.includes(letter));
  if (extra.length > 0) {
    return defect(
      "OPTION_COVERAGE",
      "the CERT1|OPTIONS table contains option(s) not stated by the problem: " +
        extra.join(", "),
      "CERTIFICATE",
    );
  }
  return null;
}

function polynomialVariables(poly: Poly): string[] {
  const variables = new Set<string>();
  for (const key of poly.keys()) {
    for (const part of key.split("*")) {
      if (part === "") continue;
      variables.add(part.split("^")[0]!);
    }
  }
  return [...variables].sort();
}

function degreeIn(poly: Poly, variable: string): number {
  let degree = 0;
  let sawVariable = false;
  for (const key of poly.keys()) {
    let exponent = 0;
    for (const part of key.split("*")) {
      if (part === "") continue;
      const [name, raw] = part.split("^");
      if (name === variable) {
        exponent += Number(raw ?? "1");
      }
    }
    if (exponent > 0) {
      sawVariable = true;
      degree = Math.max(degree, exponent);
    }
  }
  return sawVariable ? degree : 0;
}

/** Maximum TOTAL degree of a polynomial (the sum of every monomial's exponents). */
function totalDegree(poly: Poly): number {
  let degree = 0;
  for (const key of poly.keys()) {
    let term = 0;
    for (const part of key.split("*")) {
      if (part === "") continue;
      const [name, raw] = part.split("^");
      void name;
      term += Number(raw ?? "1");
    }
    degree = Math.max(degree, term);
  }
  return degree;
}

/** True when the two polynomials differ by one constant factor only. */
function sameUpToConstantFactor(left: Poly, right: Poly): boolean {
  if (left.size !== right.size || left.size === 0) return false;
  let pivot: string | null = null;
  for (const key of left.keys()) {
    if (right.has(key)) {
      pivot = key;
      break;
    }
  }
  if (pivot === null) return false;
  const leftValue = left.get(pivot) as number;
  const rightValue = right.get(pivot) as number;
  if (Math.abs(leftValue) < 1e-12 || Math.abs(rightValue) < 1e-12) return false;
  const factor = rightValue / leftValue;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined) return false;
    if (Math.abs(other - value * factor) > 1e-9 * Math.max(1, Math.abs(other))) {
      return false;
    }
  }
  return true;
}

/** One `{polynomial}` object or a plain string entry of `normalized_minors`. */
function minorPolynomialText(minor: unknown): string | null {
  if (typeof minor === "string") return minor;
  if (typeof minor === "object" && minor !== null && !Array.isArray(minor)) {
    const value = (minor as Record<string, unknown>)["polynomial"];
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * The invariant polynomial carried by a `MAXIMAL_MINORS` observation.
 *
 * A real payload lists every maximal minor, so the list is only usable when it
 * is unambiguous: either every non-zero minor is the same polynomial up to a
 * constant factor, or every non-constant minor has the same total degree. The
 * highest-degree non-constant minor then represents the invariant. An
 * inconsistent list yields null: this check never invents a polynomial.
 */
function observationPolynomial(
  observation: ExactObservationView | null | undefined,
): { polynomial: string; variable: string } | null {
  if (observation?.operation !== "MAXIMAL_MINORS") return null;
  const minors = observation.normalized_minors;
  if (!Array.isArray(minors) || minors.length === 0) return null;
  const parsed: { readonly text: string; readonly poly: Poly; readonly degree: number }[] = [];
  for (const minor of minors) {
    const text = minorPolynomialText(minor);
    if (text === null) return null;
    const poly = polynomialOf(text);
    if (poly === null) return null;
    parsed.push({ text, poly, degree: totalDegree(poly) });
  }
  const nonZero = parsed.filter((row) => row.poly.size > 0);
  const nonConstant = nonZero.filter((row) => row.degree > 0);
  if (nonConstant.length === 0) return null;
  const consistent =
    nonZero.every((row) => sameUpToConstantFactor(nonZero[0]!.poly, row.poly)) ||
    nonConstant.every((row) => row.degree === nonConstant[0]!.degree);
  if (!consistent) return null;
  const highest = nonConstant.reduce(
    (best, row) => (row.degree > best.degree ? row : best),
    nonConstant[0]!,
  );
  const representative =
    nonConstant.find(
      (row) => row.degree === highest.degree && polynomialVariables(row.poly).length === 1,
    ) ?? null;
  if (representative === null) return null;
  return {
    polynomial: representative.text,
    variable: polynomialVariables(representative.poly)[0]!,
  };
}

function candidatePolynomial(candidate: string, variable: string): Poly | null {
  // Accept `P(t)=...` and a short formula. A long multi-part answer is not a
  // single polynomial and must not be compared by degree.
  if (candidate.length > 320 || /[\n;；]/.test(candidate)) return null;
  const body = candidate
    .replace(/\$/g, "")
    .split("=")
    .slice(-1)[0]!
    .replace(/\\left|\\right/gu, "")
    .trim();
  const parsed = polynomialOf(body);
  if (parsed === null) return null;
  const variables = polynomialVariables(parsed);
  if (variables.length > 1) return null;
  if (variables.length === 1 && variables[0] !== variable) return null;
  return parsed;
}

function degreeConservationDefect(
  problemText: string,
  candidate: string,
  observation: ExactObservationView | null | undefined,
): AnswerClosureDefect | null {
  if (!/(多项式|特征式|Alexander|亚历山|polynomial|characteristic)/iu.test(problemText)) {
    return null;
  }
  const observed = observationPolynomial(observation);
  if (observed === null) return null;
  const observedPoly = polynomialOf(observed.polynomial);
  if (observedPoly === null) return null;
  const observedDegree = degreeIn(observedPoly, observed.variable);
  if (observedDegree < 1) return null;
  const answerPoly = candidatePolynomial(candidate, observed.variable);
  if (answerPoly === null) return null;
  const answerDegree = degreeIn(answerPoly, observed.variable);
  if (answerDegree === observedDegree) return null;
  return defect(
    "DEGREE_CONSERVATION",
    "exact maximal-minor polynomial has degree " +
      observedDegree +
      " in " +
      observed.variable +
      ", but the candidate polynomial has degree " +
      answerDegree +
      "; a lower-degree factor cannot replace the full invariant",
    "OBSERVATION",
  );
}

function normalizationDefect(
  problemText: string,
  candidate: string,
  packet: CertificatePacketView,
  observation: ExactObservationView | null | undefined,
): AnswerClosureDefect | null {
  if (!/(密度|density)/iu.test(problemText)) return null;
  const normalized =
    observation?.operation === "DENSITY_CHECK" ? observation.normalized : null;
  if (normalized === true) return null;
  if (normalized === false) {
    return defect(
      "NORMALIZATION",
      "the exact density check reports an integral of " +
        JSON.stringify(observation?.numeric_integral ?? "a value other than 1") +
        ", not 1",
      "OBSERVATION",
    );
  }
  if (hasPassingCheck(packet, "DENSITY_CHECK")) return null;
  const looksLikeDensity =
    /(?:\\frac|\\sqrt|sqrt|exp|e\^)/iu.test(candidate) &&
    /[A-Za-z]/u.test(candidate);
  if (!looksLikeDensity) return null;
  // No exact density observation exists at all: this defect rests on the
  // candidate's notation plus the absence of a certificate row, so it is NOT
  // observation-grounded.
  return defect(
    "NORMALIZATION",
    "the candidate is a continuous formula but the packet has neither a normalized exact density observation nor a passing CERT1 DENSITY_CHECK row",
    "TEXT",
  );
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function solutionCompletenessDefect(
  candidate: string,
  packet: CertificatePacketView,
  expectedSolutionKeys: readonly string[] | null | undefined,
  requiresExhaustive: boolean,
): AnswerClosureDefect | null {
  if (!requiresExhaustive) return null;
  if (expectedSolutionKeys !== null && expectedSolutionKeys !== undefined) {
    if (expectedSolutionKeys.length === 0) {
      if (/(无解|不存在|没有解|no\s+solution|empty\s+set)/iu.test(candidate)) {
        return null;
      }
    }
    const candidateKeys = rationalSetKeys(candidate);
    if (candidateKeys === null) {
      if (hasCompletenessMarker(packet)) return null;
      return defect(
        "SOLUTION_COMPLETENESS",
        "the problem asks for every solution and an exact finite solution set was independently determined, but the candidate is not an explicit finite set or the packet has no completeness marker",
        "CERTIFICATE",
      );
    }
    if (!sameKeys(candidateKeys, expectedSolutionKeys)) {
      return defect(
        "SOLUTION_COMPLETENESS",
        "the candidate set is not the independently solved complete set " +
          JSON.stringify(expectedSolutionKeys),
        "CERTIFICATE",
      );
    }
    return null;
  }
  if (hasCompletenessMarker(packet)) return null;
  return defect(
    "SOLUTION_COMPLETENESS",
    "the problem asks for every solution/root/case, but the packet has no CERT1|COMPLETENESS|... => PASS marker",
    "CERTIFICATE",
  );
}

function observationInteger(result: unknown): number | null {
  if (typeof result === "number" && Number.isSafeInteger(result)) {
    return result;
  }
  if (typeof result === "string" && /^[+-]?\d+$/u.test(result.trim())) {
    return Number(result.trim());
  }
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const value = (result as Record<string, unknown>)["value"];
    return observationInteger(value);
  }
  return null;
}

function candidateInteger(candidate: string, suffixes: boolean): number | null {
  let text = candidate.trim();
  text = text.replace(/^(?:最终答案|答案|final\s+answer)\s*[:：]?\s*/iu, "").trim();
  let match = /^\$([^$]+)\$$/su.exec(text);
  if (match !== null) text = (match[1] as string).trim();
  match = /^\\boxed\{([\s\S]*)\}$/u.exec(text);
  if (match !== null) text = (match[1] as string).trim();
  const suffix = suffixes ? "(?:个|条|项)?" : "";
  match = new RegExp(`^([+-]?\\d+)\\s*${suffix}$`, "u").exec(text);
  return match === null ? null : Number(match[1] as string);
}

function explicitDegree(candidate: string): number | null {
  let text = candidate.trim();
  text = text.replace(/^(?:最终答案|答案|final\s+answer)\s*[:：]?\s*/iu, "").trim();
  let match = /^\$([^$]+)\$$/su.exec(text);
  if (match !== null) text = (match[1] as string).trim();
  match = /\[[^\]]+:[^\]]+\]\s*=\s*([+-]?\d+)/u.exec(text);
  if (match !== null) return Number(match[1] as string);
  match = /(?:\\deg|degree|次数)\s*[=:：]?\s*([+-]?\d+)/iu.exec(text);
  if (match !== null) return Number(match[1] as string);
  match = /^([+-]?\d+)\s*(?:次|degree)?$/iu.exec(text);
  return match === null ? null : Number(match[1] as string);
}

function lastObservation(
  observations: readonly ToolObservationView[] | null | undefined,
  name: string,
): ToolObservationView | null {
  if (!Array.isArray(observations)) return null;
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (observation?.name === name) return observation;
  }
  return null;
}

function realRootCountDefect(
  problemText: string,
  candidate: string,
  observations: readonly ToolObservationView[] | null | undefined,
): AnswerClosureDefect | null {
  if (semanticToolRoute(problemText)?.id !== "REAL_ROOT_COUNT") return null;
  const observation = lastObservation(observations, "real_root_count_expr");
  if (observation === null) return null;
  const observed = observationInteger(observation.result);
  const stated = candidateInteger(candidate, true);
  if (observed === null || stated === null || observed === stated) return null;
  return defect(
    "REAL_ROOT_COUNT",
    "the exact Sturm count reports " +
      observed +
      " distinct real root(s), but the candidate states " +
      stated,
    "OBSERVATION",
  );
}

function splittingFieldDegreeDefect(
  problemText: string,
  candidate: string,
  observations: readonly ToolObservationView[] | null | undefined,
): AnswerClosureDefect | null {
  if (semanticToolRoute(problemText)?.id !== "SPLITTING_FIELD_DEGREE") return null;
  const observation = lastObservation(observations, "splitting_field_degree_expr");
  if (observation === null) return null;
  const observed = observationInteger(observation.result);
  const stated = explicitDegree(candidate);
  if (observed === null || stated === null || observed === stated) return null;
  return defect(
    "SPLITTING_FIELD_DEGREE",
    "the exact splitting-field computation reports degree " +
      observed +
      ", but the candidate explicitly states degree " +
      stated,
    "OBSERVATION",
  );
}

// ---------------------------------------------------------------------------
// Observation-grounded diagnostics for the exact data/group tools.
//
// Every helper below is bounded and fail-closed: a payload of the wrong shape,
// an unparsable number, a statement the candidate makes ambiguously, or an
// observation that contradicts itself yields NO defect. Nothing is guessed and
// nothing is invented. A defect is only ever the disagreement between one
// explicit observed value and one explicit value the candidate states.
// ---------------------------------------------------------------------------

/** A plain JSON object, or null. Arrays and primitives are never objects here. */
function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `n`, `-n` or `n/d` with a positive denominator and bounded magnitude. */
const EXACT_RATIONAL_TEXT = /^[+-]?[0-9]{1,9}(?:\/[1-9][0-9]{0,8})?$/u;

/** Exact value of a producer-emitted rational string, or null. */
function exactRationalOf(
  text: unknown,
): { readonly n: bigint; readonly d: bigint } | null {
  if (typeof text !== "string") return null;
  const trimmed = text.replace(/\s+/gu, "");
  if (trimmed.length === 0 || trimmed.length > 24) return null;
  if (!EXACT_RATIONAL_TEXT.test(trimmed)) return null;
  const [numeratorText, denominatorText] = trimmed.split("/") as [
    string,
    string | undefined,
  ];
  const n = BigInt(numeratorText);
  const d = denominatorText === undefined ? 1n : BigInt(denominatorText);
  return d === 0n ? null : { n, d };
}

/**
 * Exact rational equality. Only canonical exact text participates: a decimal,
 * a float or a symbolic expression is never coerced into a number.
 */
function sameRational(left: unknown, right: unknown): boolean {
  const a = exactRationalOf(left);
  const b = exactRationalOf(right);
  if (a === null || b === null) return false;
  return a.n * b.d === b.n * a.d;
}

/** Bounded candidate text: a long prose candidate states no exact value. */
const MAX_VALUE_SCAN_CHARS = 1200;

/**
 * Every exact rational the candidate states for ONE labelled quantity.
 *
 * The label has to be explicit (`slope`, `斜率`, `共轭类个数`, ...). A bare
 * number in prose is never attributed to a quantity.
 */
function labelledRationals(
  candidate: string,
  patterns: readonly RegExp[],
): readonly string[] {
  const text =
    candidate.length > MAX_VALUE_SCAN_CHARS
      ? candidate.slice(0, MAX_VALUE_SCAN_CHARS)
      : candidate;
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (typeof value === "string" && exactRationalOf(value) !== null) {
        found.push(value);
      }
    }
  }
  return found;
}

/**
 * The one value the candidate states, or null when it states none or states
 * several different ones. An ambiguous statement is never interpreted: the
 * diagnostic stays silent instead of guessing which number was meant.
 */
function uniqueStatedValue(values: readonly string[]): string | null {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.some((seen) => sameRational(seen, value))) unique.push(value);
  }
  return unique.length === 1 ? unique[0]! : null;
}

/** `interpolation-fit-check-v1` payload, validated field by field. */
interface InterpolationObservationView {
  readonly allZero: boolean;
  readonly residuals: readonly string[];
  readonly variable: string;
  readonly interpolatingPolynomial: string;
}

function interpolationObservation(
  result: unknown,
): InterpolationObservationView | null {
  const record = recordValue(result);
  if (record === null) return null;
  const allZero = record["all_zero"];
  if (typeof allZero !== "boolean") return null;
  const residuals = record["residuals"];
  if (!Array.isArray(residuals) || residuals.length === 0 || residuals.length > 32) {
    return null;
  }
  const residualText: string[] = [];
  for (const residual of residuals) {
    if (exactRationalOf(residual) === null) return null;
    residualText.push((residual as string).replace(/\s+/gu, ""));
  }
  const interpolatingPolynomial = record["interpolating_polynomial"];
  if (
    typeof interpolatingPolynomial !== "string" ||
    interpolatingPolynomial.length === 0 ||
    interpolatingPolynomial.length > 200
  ) {
    return null;
  }
  const variable = record["variable"];
  if (typeof variable !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,15}$/u.test(variable)) {
    return null;
  }
  return {
    allZero,
    residuals: residualText,
    variable,
    interpolatingPolynomial,
  };
}

function interpolationResidualDefect(
  problemText: string,
  candidate: string,
  observations: readonly ToolObservationView[] | null | undefined,
): AnswerClosureDefect | null {
  if (semanticToolRoute(problemText)?.id !== "INTERPOLATION_FIT") return null;
  const observation = lastObservation(observations, "interpolation_fit_check");
  if (observation === null) return null;
  const observed = interpolationObservation(observation.result);
  if (observed === null) return null;
  // A clean residual list is not a defect: with distinct interpolation points
  // the checked expression IS the unique interpolating polynomial.
  if (observed.allZero) return null;
  const answerPoly = candidatePolynomial(candidate, observed.variable);
  if (answerPoly === null) return null;
  const exactPoly = polynomialOf(observed.interpolatingPolynomial);
  if (exactPoly === null) return null;
  // The payload contradicts itself (non-zero residuals for a candidate that
  // canonicalises to the observed interpolant). Never invent a defect from an
  // internally inconsistent observation.
  if (samePolynomial(answerPoly, exactPoly)) return null;
  return defect(
    "INTERPOLATION_RESIDUAL",
    "the exact interpolation check reports residuals " +
      JSON.stringify(observed.residuals) +
      " at the " +
      observed.residuals.length +
      " stated point(s), so the candidate polynomial of degree " +
      degreeIn(answerPoly, observed.variable) +
      " does not pass through those points; the interpolating polynomial is " +
      observed.interpolatingPolynomial,
    "OBSERVATION",
  );
}

/** `stats-ols-check-v1` payload, validated field by field. */
interface OlsObservationView {
  readonly claimMatches: boolean | null;
  readonly slope: string;
  readonly intercept: string;
  readonly n: number | null;
}

function olsObservation(result: unknown): OlsObservationView | null {
  const record = recordValue(result);
  if (record === null) return null;
  const claimMatches = record["claim_matches"];
  if (claimMatches !== true && claimMatches !== false && claimMatches !== null) {
    return null;
  }
  if (exactRationalOf(record["slope"]) === null) return null;
  if (exactRationalOf(record["intercept"]) === null) return null;
  const rawN = record["n"];
  const n =
    typeof rawN === "number" && Number.isSafeInteger(rawN) && rawN > 0 ? rawN : null;
  return {
    claimMatches,
    slope: (record["slope"] as string).replace(/\s+/gu, ""),
    intercept: (record["intercept"] as string).replace(/\s+/gu, ""),
    n,
  };
}

/** `y = m*x + b` and the labelled `slope`/`斜率` forms. */
const SLOPE_PATTERNS: readonly RegExp[] = [
  /(?:斜率|\bslope\b)\s*(?:为|是|等于|[:：=]|\bis\b|=)\s*([+-]?[0-9]{1,9}(?:\/[1-9][0-9]{0,8})?)/giu,
  /\by\s*=\s*([+-]?[0-9]{1,9}(?:\/[1-9][0-9]{0,8})?)\s*\*?\s*[A-Za-z]\b/gu,
];

/** `y = m*x + b` and the labelled `intercept`/`截距` forms. */
const INTERCEPT_PATTERNS: readonly RegExp[] = [
  /(?:截距|\bintercept\b)\s*(?:为|是|等于|[:：=]|\bis\b|=)\s*([+-]?[0-9]{1,9}(?:\/[1-9][0-9]{0,8})?)/giu,
  /\by\s*=\s*[+-]?[0-9]{1,9}(?:\/[1-9][0-9]{0,8})?\s*\*?\s*[A-Za-z]\s*([+-]\s*[0-9]{1,9}(?:\s*\/\s*[1-9][0-9]{0,8})?)\s*$/gmu,
];

function olsMismatchDefect(
  candidate: string,
  observations: readonly ToolObservationView[] | null | undefined,
): AnswerClosureDefect | null {
  const observation = lastObservation(observations, "stats_ols_check");
  if (observation === null) return null;
  const observed = olsObservation(observation.result);
  // `true` means the claim the tool checked agreed with the data; `null` means
  // no claim was supplied. Neither is a defect, and a missing field is never
  // read as a disagreement.
  if (observed === null || observed.claimMatches !== false) return null;
  const statedSlope = uniqueStatedValue(labelledRationals(candidate, SLOPE_PATTERNS));
  const statedIntercept = uniqueStatedValue(
    labelledRationals(candidate, INTERCEPT_PATTERNS),
  );
  if (statedSlope === null && statedIntercept === null) return null;
  const stated: string[] = [];
  if (statedSlope !== null && !sameRational(observed.slope, statedSlope)) {
    stated.push("slope " + statedSlope.replace(/\s+/gu, ""));
  }
  if (statedIntercept !== null && !sameRational(observed.intercept, statedIntercept)) {
    stated.push("intercept " + statedIntercept.replace(/\s+/gu, ""));
  }
  if (stated.length === 0) return null;
  return defect(
    "OLS_MISMATCH",
    "the exact least-squares fit reports slope " +
      observed.slope +
      " and intercept " +
      observed.intercept +
      (observed.n === null ? "" : " for " + observed.n + " exact data pair(s)") +
      ", but the candidate states " +
      stated.join(" and "),
    "OBSERVATION",
  );
}

/** `finite-group-structure-v1` payload, validated field by field. */
interface GroupObservationView {
  readonly order: number;
  readonly conjugacyClassCount: number;
  /** Only a real boolean is a usable verdict; anything else is `null`. */
  readonly isAbelian: boolean | null;
  readonly isCyclic: boolean | null;
}

function groupObservation(result: unknown): GroupObservationView | null {
  const record = recordValue(result);
  if (record === null) return null;
  const order = record["order"];
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 1) {
    return null;
  }
  const classes = record["conjugacy_classes"];
  if (!Array.isArray(classes) || classes.length === 0 || classes.length > 4096) {
    return null;
  }
  for (const row of classes) {
    const entry = recordValue(row);
    if (entry === null) return null;
    if (typeof entry["representative"] !== "string") return null;
    const size = entry["size"];
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
      return null;
    }
  }
  return {
    order,
    conjugacyClassCount: classes.length,
    isAbelian: typeof record["is_abelian"] === "boolean" ? record["is_abelian"] : null,
    isCyclic: typeof record["is_cyclic"] === "boolean" ? record["is_cyclic"] : null,
  };
}

/**
 * The group order, only from an explicit group-order label. `元素的阶` (element
 * order) is deliberately not accepted: it is a different quantity.
 */
const GROUP_ORDER_PATTERNS: readonly RegExp[] = [
  /(?:\|G\||群的?阶|\bgroup\s+order\b|\border\s+of\s+(?:the\s+)?group\b)\s*(?:为|是|等于|[:：=]|\bis\b)?\s*([0-9]{1,6})/giu,
];

/** The number of conjugacy classes, only from an explicit label. */
const CONJUGACY_CLASS_PATTERNS: readonly RegExp[] = [
  /共轭类(?:的)?(?:个数|数目|数)?\s*(?:为|是|等于|共有?|有|[:：=])\s*([0-9]{1,6})/gu,
  /([0-9]{1,6})\s*个共轭类/gu,
  /\bconjugacy\s+classes?\b\s*(?:[:：=]|\bis\b|\bare\b)?\s*([0-9]{1,6})/giu,
  /([0-9]{1,6})\s+conjugacy\s+classes?\b/giu,
];

function groupStructureMismatchDefect(
  candidate: string,
  observations: readonly ToolObservationView[] | null | undefined,
): AnswerClosureDefect | null {
  const observation = lastObservation(observations, "finite_group_structure");
  if (observation === null) return null;
  const observed = groupObservation(observation.result);
  if (observed === null) return null;
  const statedOrder = uniqueStatedValue(
    labelledRationals(candidate, GROUP_ORDER_PATTERNS),
  );
  const statedClassCount = uniqueStatedValue(
    labelledRationals(candidate, CONJUGACY_CLASS_PATTERNS),
  );
  // The candidate states neither number: never guess which number it meant.
  if (statedOrder === null && statedClassCount === null) return null;
  const stated: string[] = [];
  if (statedOrder !== null && Number(statedOrder) !== observed.order) {
    stated.push("order " + statedOrder);
  }
  if (
    statedClassCount !== null &&
    Number(statedClassCount) !== observed.conjugacyClassCount
  ) {
    stated.push(
      statedClassCount + " conjugacy class" + (Number(statedClassCount) === 1 ? "" : "es"),
    );
  }
  if (stated.length === 0) return null;
  return defect(
    "GROUP_STRUCTURE_MISMATCH",
    "the exact group enumeration reports order " +
      observed.order +
      " and " +
      observed.conjugacyClassCount +
      " conjugacy class" +
      (observed.conjugacyClassCount === 1 ? "" : "es") +
      ", but the candidate states " +
      stated.join(" and "),
    "OBSERVATION",
  );
}

// ---------------------------------------------------------------------------
// Option-level diagnostics: the CHOSEN option's own text vs one observation.
//
// A verdict-shaped answer ("B", "A、C") carries no number of its own, so no
// candidate-level comparison can see the contradiction. The chosen option's
// text is where the wrong number or the wrong group property sits, so these two
// checks read the problem's option block and compare ONLY the options the
// candidate actually selected.
//
// Everything here is fail-closed by construction:
//   - a number is attributed to a quantity only through an explicit label in
//     the SAME clause; any number left unattributed poisons that option;
//   - two different values for the same quantity poison that quantity;
//   - an unparsable option block, an absent option text, an absent or malformed
//     observation, an unchosen option and any prose outside the option block
//     never produce a defect;
//   - negations and hedges ("不一定可交换") are never read as assertions.
// ---------------------------------------------------------------------------

/** One `letter -> text` row of the problem's own option block. */
export interface ProblemOptionView {
  readonly letter: string;
  readonly text: string;
}

/** An option body is bounded: a long body states no single comparable value. */
const MAX_OPTION_TEXT_CHARS = 320;

/**
 * Option marker: a letter at a clause/line start followed by list punctuation.
 *
 * `[` is deliberately NOT an allowed prefix: inside a bracket expression such as
 * `[E:Q]=6` the `E:` fragment would otherwise be read as option E, which would
 * make the whole block look repeated and unusable.
 */
const OPTION_MARKER = /(?:^|[\s\n;；。，,（(])([A-E])[\.\)、:：]/gmu;

/**
 * The problem's option block, or `[]` when it is not a clean letter table.
 *
 * Only the text BETWEEN two markers is ever read, so prose before the first
 * marker and the letters themselves can never be attributed to an option. A
 * repeated letter, fewer than two markers, an empty body or an over-long body
 * make the block unusable and yield no rows at all.
 */
export function problemOptionTexts(problemText: string): readonly ProblemOptionView[] {
  if (typeof problemText !== "string" || problemText.length === 0) return [];
  const markers: { readonly letter: string; readonly start: number; readonly bodyStart: number }[] =
    [];
  for (const match of problemText.matchAll(OPTION_MARKER)) {
    const letter = (match[1] ?? "").toUpperCase();
    if (letter.length === 0) continue;
    const start = match.index ?? 0;
    markers.push({ letter, start, bodyStart: start + match[0].length });
  }
  if (markers.length < 2) return [];
  const seen = new Set<string>();
  for (const marker of markers) {
    if (seen.has(marker.letter)) return [];
    seen.add(marker.letter);
  }
  const options: ProblemOptionView[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    const end = index + 1 < markers.length ? markers[index + 1]!.start : problemText.length;
    const text = problemText.slice(marker.bodyStart, end).trim();
    if (text.length === 0 || text.length > MAX_OPTION_TEXT_CHARS) continue;
    options.push({ letter: marker.letter, text });
  }
  return options;
}

/**
 * The options the candidate actually selected, in letter order.
 *
 * A letter that the problem does not state is dropped instead of matched
 * against invented text, and a candidate that names no option letter selects
 * nothing: neither produces a defect.
 */
function chosenOptionTexts(
  problemText: string,
  candidate: string,
): readonly ProblemOptionView[] {
  const options = problemOptionTexts(problemText);
  if (options.length < 2) return [];
  const chosen = candidateChoiceLetters(candidate);
  if (chosen.length === 0) return [];
  const byLetter = new Map(options.map((option) => [option.letter, option] as const));
  const picked: ProblemOptionView[] = [];
  for (const letter of chosen) {
    const option = byLetter.get(letter);
    if (option !== undefined) picked.push(option);
  }
  return picked;
}

/** One character span of a clause, used to mask already-attributed numbers. */
interface TextSpan {
  readonly start: number;
  readonly length: number;
}

/** Blank out every span, keeping the clause length (and offsets) intact. */
function maskSpans(text: string, spans: readonly TextSpan[]): string {
  if (spans.length === 0) return text;
  const ordered = [...spans].sort((left, right) => left.start - right.start);
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) {
      const end = span.start + span.length;
      if (end > cursor) {
        out += " ".repeat(end - cursor);
        cursor = end;
      }
      continue;
    }
    out += text.slice(cursor, span.start) + " ".repeat(span.length);
    cursor = span.start + span.length;
  }
  return out + text.slice(cursor);
}

/** Clause boundary of an option body: `.` is excluded so decimals stay whole. */
const CLAUSE_SPLIT = /[，,；;。\n]/u;

/**
 * Explicitly labelled quantities these checks never compare, masked before the
 * compared families run. `元素的阶` (element order) is a different quantity
 * from `群的阶` (group order) and must not be read as the group order.
 */
const UNCOMPARED_LABELLED_QUANTITIES: readonly RegExp[] = [
  /元素(?:的)?阶(?:为|是|等于|共有?|有|[:：=])?\s*[0-9]{1,6}/gu,
  /\belement\s+orders?\b\s*(?:is|are|=|:)?\s*[0-9]{1,6}/giu,
];

/** Exact integer the option states for the group order. */
const OPTION_GROUP_ORDER_PATTERNS: readonly RegExp[] = [
  /(?:\|G\||群的?阶|阶为)\s*(?:为|是|等于|[:：=]|\bis\b)?\s*([0-9]{1,6})/gu,
  /(?:[A-Z][A-Za-z0-9_]{0,3}|群|group)[^0-9]{0,10}\border\b\s*(?:为|是|等于|[:：=]|\bis\b)\s*([0-9]{1,6})/gu,
];

/** Exact integer the option states for the number of real roots. */
const OPTION_REAL_ROOT_PATTERNS: readonly RegExp[] = [
  /(?:实根|real\s+roots?)\s*(?:个数|数目|数)?\s*(?:为|是|等于|共有?|有|[:：=]|\bis\b|\bare\b)?\s*([0-9]{1,6})/giu,
  /([0-9]{1,6})\s*(?:个)?\s*(?:实根|real\s+roots?)/giu,
];

/**
 * Exact integer the option states for the splitting-field degree. `次数` alone
 * is only read when the same clause names the splitting field or its extension,
 * so a polynomial degree is never compared with an extension degree.
 */
const OPTION_SPLITTING_FIELD_PATTERNS: readonly RegExp[] = [
  /(?:分裂域|分裂扩张)[^0-9]{0,14}?次数\s*(?:为|是|等于|[:：=])?\s*([0-9]{1,6})/gu,
  /\[[A-Za-z][^\]]{0,8}:[^\]]{0,8}\]\s*(?:为|是|等于|[:：=])?\s*([0-9]{1,6})/gu,
  /(?:扩张次数|扩域次数)\s*(?:为|是|等于|[:：=])?\s*([0-9]{1,6})/gu,
  /([0-9]{1,6})\s*(?:次)?\s*(?:的)?\s*(?:分裂域|分裂扩张)/gu,
];

/** Exact rational the option states for the least-squares slope. */
const OPTION_SLOPE_PATTERNS: readonly RegExp[] = [
  /(?:斜率|\bslope\b)\s*(?:为|是|等于|[:：=]|\bis\b)?\s*([+-]?[0-9]{1,9}(?:\/[1-9][0-9]{0,8})?)/giu,
];

/** Exact rational the option states for the least-squares intercept. */
const OPTION_INTERCEPT_PATTERNS: readonly RegExp[] = [
  /(?:截距|\bintercept\b)\s*(?:为|是|等于|[:：=]|\bis\b)?\s*([+-]?[0-9]{1,9}(?:\/[1-9][0-9]{0,8})?)/giu,
];

type OptionQuantityId =
  | "GROUP_ORDER"
  | "CONJUGACY_CLASSES"
  | "REAL_ROOTS"
  | "SPLITTING_FIELD_DEGREE"
  | "OLS_SLOPE"
  | "OLS_INTERCEPT";

/** One comparable quantity, with the exact label that states it in an option. */
interface OptionQuantityFamily {
  readonly id: OptionQuantityId;
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

/**
 * The compared families in their fixed declaration order. That order, then the
 * option letter order, is the deterministic order of one closure pass.
 */
const OPTION_QUANTITY_FAMILIES: readonly OptionQuantityFamily[] = [
  { id: "GROUP_ORDER", label: "group order", patterns: OPTION_GROUP_ORDER_PATTERNS },
  {
    id: "CONJUGACY_CLASSES",
    label: "conjugacy-class count",
    patterns: CONJUGACY_CLASS_PATTERNS,
  },
  { id: "REAL_ROOTS", label: "distinct real-root count", patterns: OPTION_REAL_ROOT_PATTERNS },
  {
    id: "SPLITTING_FIELD_DEGREE",
    label: "splitting-field degree",
    patterns: OPTION_SPLITTING_FIELD_PATTERNS,
  },
  { id: "OLS_SLOPE", label: "slope", patterns: OPTION_SLOPE_PATTERNS },
  { id: "OLS_INTERCEPT", label: "intercept", patterns: OPTION_INTERCEPT_PATTERNS },
];

/** One observed exact value a chosen option can be compared against. */
interface ObservedOptionQuantity {
  readonly id: OptionQuantityId;
  readonly label: string;
  readonly source: string;
  /** Exact observed value as text, for the defect detail. */
  readonly text: string;
  /** Set for an integer-valued quantity, otherwise null. */
  readonly integer: bigint | null;
  /** Set for a rational-valued quantity, otherwise null. */
  readonly rational: string | null;
  /** False when the observed text is not comparable at all. */
  readonly usable: boolean;
}

/** Every quantity this run actually observed, in family declaration order. */
function observedOptionQuantities(
  observations: readonly ToolObservationView[] | null | undefined,
): readonly ObservedOptionQuantity[] {
  const out: ObservedOptionQuantity[] = [];
  const group = groupObservation(
    lastObservation(observations, "finite_group_structure")?.result,
  );
  if (group !== null) {
    out.push({
      id: "GROUP_ORDER",
      label: "group order",
      source: "the exact group enumeration",
      text: String(group.order),
      integer: BigInt(group.order),
      rational: null,
      usable: true,
    });
    out.push({
      id: "CONJUGACY_CLASSES",
      label: "conjugacy-class count",
      source: "the exact group enumeration",
      text: String(group.conjugacyClassCount),
      integer: BigInt(group.conjugacyClassCount),
      rational: null,
      usable: true,
    });
  }
  const realRoots = observationInteger(
    lastObservation(observations, "real_root_count_expr")?.result,
  );
  if (realRoots !== null) {
    out.push({
      id: "REAL_ROOTS",
      label: "distinct real-root count",
      source: "the exact Sturm real-root count",
      text: String(realRoots),
      integer: BigInt(realRoots),
      rational: null,
      usable: true,
    });
  }
  const splittingField = observationInteger(
    lastObservation(observations, "splitting_field_degree_expr")?.result,
  );
  if (splittingField !== null) {
    out.push({
      id: "SPLITTING_FIELD_DEGREE",
      label: "splitting-field degree",
      source: "the exact splitting-field computation",
      text: String(splittingField),
      integer: BigInt(splittingField),
      rational: null,
      usable: true,
    });
  }
  const ols = olsObservation(lastObservation(observations, "stats_ols_check")?.result);
  if (ols !== null) {
    out.push({
      id: "OLS_SLOPE",
      label: "slope",
      source: "the exact least-squares fit",
      text: ols.slope,
      integer: null,
      rational: ols.slope,
      usable: exactRationalOf(ols.slope) !== null,
    });
    out.push({
      id: "OLS_INTERCEPT",
      label: "intercept",
      source: "the exact least-squares fit",
      text: ols.intercept,
      integer: null,
      rational: ols.intercept,
      usable: exactRationalOf(ols.intercept) !== null,
    });
  }
  return out;
}

interface AssertedOptionQuantity {
  readonly family: OptionQuantityFamily;
  readonly value: string;
}

/**
 * Every quantity one option body explicitly assert, or `null` when the body is
 * ambiguous.
 *
 * A number counts only when a following/preceding quantity label in the SAME
 * clause binds it; any digit left over after masking every attributed span makes
 * the whole option unusable (`null`), so a bare number is never guessed at.
 */
function assertedOptionQuantities(
  optionText: string,
  families: readonly OptionQuantityFamily[],
): readonly AssertedOptionQuantity[] | null {
  const asserted: AssertedOptionQuantity[] = [];
  for (const rawClause of optionText.split(CLAUSE_SPLIT)) {
    const clause = rawClause.trim();
    if (clause.length === 0) continue;
    // 1. Mask labelled quantities this check never compares (element orders).
    const ignored: TextSpan[] = [];
    for (const pattern of UNCOMPARED_LABELLED_QUANTITIES) {
      for (const match of clause.matchAll(pattern)) {
        ignored.push({ start: match.index ?? 0, length: match[0].length });
      }
    }
    const work = maskSpans(clause, ignored);
    // 2. Bind one number per compared family through its explicit label.
    const attributed: TextSpan[] = [];
    for (const family of families) {
      for (const pattern of family.patterns) {
        for (const match of work.matchAll(pattern)) {
          const value = match[1];
          // An unparsable or over-long value is never attributed to a quantity.
          if (typeof value !== "string" || exactRationalOf(value) === null) continue;
          attributed.push({ start: match.index ?? 0, length: match[0].length });
          asserted.push({ family, value: value.replace(/\s+/gu, "") });
        }
      }
    }
    // 3. A leftover digit is a number with no label in this clause: ambiguous.
    if (/[0-9]/u.test(maskSpans(work, attributed))) return null;
  }
  return asserted;
}

/** Integer families compare as exact integers, never through a float. */
function familiesAreInteger(family: OptionQuantityFamily): boolean {
  return (
    family.id === "GROUP_ORDER" ||
    family.id === "CONJUGACY_CLASSES" ||
    family.id === "REAL_ROOTS" ||
    family.id === "SPLITTING_FIELD_DEGREE"
  );
}

/**
 * One chosen option's number against one observation.
 *
 * `skip` covers "the option states no such quantity" and "it states several
 * different values"; `agree` covers "the option states exactly the observation".
 */
type QuantityVerdict = "skip" | "agree" | "contradict";

function compareAssertedQuantity(
  family: OptionQuantityFamily,
  observed: ObservedOptionQuantity,
  claim: string,
): QuantityVerdict {
  if (!observed.usable) return "skip";
  if (familiesAreInteger(family)) {
    if (observed.integer === null) return "skip";
    if (!/^[0-9]{1,6}$/u.test(claim)) return "skip";
    return BigInt(claim) === observed.integer ? "agree" : "contradict";
  }
  if (observed.rational === null) return "skip";
  if (exactRationalOf(claim) === null) return "skip";
  return sameRational(observed.rational, claim) ? "agree" : "contradict";
}

function optionNumericContradictionDefect(
  problemText: string,
  candidate: string,
  observations: readonly ToolObservationView[] | null | undefined,
): AnswerClosureDefect | null {
  const chosen = chosenOptionTexts(problemText, candidate);
  if (chosen.length === 0) return null;
  const observed = observedOptionQuantities(observations);
  if (observed.length === 0) return null;
  const families = OPTION_QUANTITY_FAMILIES.filter((family) =>
    observed.some((row) => row.id === family.id),
  );
  if (families.length === 0) return null;
  const parts: string[] = [];
  for (const option of chosen) {
    const asserted = assertedOptionQuantities(option.text, families);
    // An ambiguous option body states no single comparable quantity.
    if (asserted === null) continue;
    for (const family of families) {
      const observation = observed.find((row) => row.id === family.id);
      if (observation === undefined) continue;
      const claim = uniqueStatedValue(
        asserted.filter((row) => row.family.id === family.id).map((row) => row.value),
      );
      if (claim === null) continue;
      if (compareAssertedQuantity(family, observation, claim) !== "contradict") continue;
      parts.push(
        "option " +
          option.letter +
          " asserts " +
          family.label +
          " " +
          claim +
          ", but " +
          observation.source +
          " reports exactly " +
          observation.text,
      );
    }
  }
  if (parts.length === 0) return null;
  return defect("OPTION_NUMERIC_CONTRADICTION", parts.join("; "), "OBSERVATION");
}

/**
 * A negation or a hedge anywhere in the clause means the option does not assert
 * the property, so no verdict defect is produced. Silence is the correct answer
 * when the wording cannot be decided.
 */
const OPTION_ASSERTION_HEDGE =
  /(?:不|非|未|否|未必|不一定|可能|也许|或许|是否|错误|不对|\bnot\b|\bnever\b|\bn[o']t\b|\bmight\b|\bmay\b|\bnon-?)/iu;

/**
 * The group properties a verdict option can assert directly.
 *
 * `元素的阶` (element order) is deliberately absent: the observation carries a
 * distribution (`element_orders`) rather than one value, so an option stating an
 * element order cannot be compared exactly and yields no defect.
 */
const GROUP_PROPERTY_ASSERTIONS: readonly {
  readonly id: "ABELIAN" | "CYCLIC";
  readonly label: string;
  readonly keyword: RegExp;
  readonly observedField: string;
  readonly observedValue: (observation: GroupObservationView) => boolean | null;
}[] = [
  {
    id: "ABELIAN",
    label: "the group is abelian",
    keyword: /(?:可交换|交换群|阿贝尔|\babelian\b)/iu,
    observedField: "is_abelian",
    observedValue: (observation) => observation.isAbelian,
  },
  {
    id: "CYCLIC",
    label: "the group is cyclic",
    keyword: /(?:循环群|循环的|\bcyclic\b)/iu,
    observedField: "is_cyclic",
    observedValue: (observation) => observation.isCyclic,
  },
];

function optionVerdictContradictionDefect(
  problemText: string,
  candidate: string,
  observations: readonly ToolObservationView[] | null | undefined,
): AnswerClosureDefect | null {
  const chosen = chosenOptionTexts(problemText, candidate);
  if (chosen.length === 0) return null;
  const observed = groupObservation(
    lastObservation(observations, "finite_group_structure")?.result,
  );
  if (observed === null) return null;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const option of chosen) {
    for (const rawClause of option.text.split(CLAUSE_SPLIT)) {
      const clause = rawClause.trim();
      if (clause.length === 0) continue;
      for (const property of GROUP_PROPERTY_ASSERTIONS) {
        if (!property.keyword.test(clause)) continue;
        // A negated or hedged clause ("不一定可交换") is not an assertion.
        if (OPTION_ASSERTION_HEDGE.test(clause)) continue;
        // Only a positive assertion the observation explicitly refutes counts.
        const value = property.observedValue(observed);
        if (value !== false) continue;
        const key = option.letter + "|" + property.id;
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(
          "option " +
            option.letter +
            " asserts " +
            property.label +
            ", but the exact group enumeration reports " +
            property.observedField +
            "=false",
        );
      }
    }
  }
  if (parts.length === 0) return null;
  return defect("OPTION_VERDICT_CONTRADICTION", parts.join("; "), "OBSERVATION");
}

/**
 * The exact observation for ONE operation, or null when this run never recorded
 * it. The keyed index is consulted first; the legacy single slot counts only
 * when its own operation matches, so an unrelated exact result (e.g. `LIMIT`)
 * can never satisfy a diagnostic.
 */
function exactObservationFor(
  input: AnswerClosureInput,
  operation: string,
): ExactObservationView | null {
  const indexed = input.exactObservations?.get(operation) ?? null;
  if (indexed !== null) return indexed;
  const single = input.exactObservation ?? null;
  if (single === null) return null;
  return single.operation === operation ? single : null;
}

/**
 * All machine-visible defects, in deterministic order.
 *
 * The order is fixed and independent of the observation arrival order, so two
 * runs over the same input always emit the same list:
 *
 *   1. `OPTION_COVERAGE`            certificate (option table)
 *   2. `NORMALIZATION`              exact density observation, else text
 *   3. `DEGREE_CONSERVATION`        exact maximal-minor observation
 *   4. `REAL_ROOT_COUNT`            exact Sturm-count observation
 *   5. `SPLITTING_FIELD_DEGREE`     exact splitting-field observation
 *   6. `INTERPOLATION_RESIDUAL`     `interpolation_fit_check` observation
 *   7. `OLS_MISMATCH`               `stats_ols_check` observation
 *   8. `GROUP_STRUCTURE_MISMATCH`   `finite_group_structure` observation
 *   9. `OPTION_NUMERIC_CONTRADICTION` chosen option text vs an observation
 *  10. `OPTION_VERDICT_CONTRADICTION` chosen option text vs an observation
 *  11. `SOLUTION_COMPLETENESS`      certificate / independently solved set
 *
 * The observation-grounded kinds stay adjacent; the exhaustiveness check
 * remains last because it is the only one that can fire on its own. Within one
 * option-level pass the chosen options are visited in letter order and each
 * option's quantities in the fixed family order above.
 */
export function answerClosureDefects(
  input: AnswerClosureInput,
): readonly AnswerClosureDefect[] {
  const defects: AnswerClosureDefect[] = [];
  const option = optionCoverageDefect(
    input.problemText,
    input.candidate,
    input.packet,
  );
  if (option !== null) defects.push(option);
  const normalization = normalizationDefect(
    input.problemText,
    input.candidate,
    input.packet,
    exactObservationFor(input, "DENSITY_CHECK"),
  );
  if (normalization !== null) defects.push(normalization);
  const degree = degreeConservationDefect(
    input.problemText,
    input.candidate,
    exactObservationFor(input, "MAXIMAL_MINORS"),
  );
  if (degree !== null) defects.push(degree);
  const realRoots = realRootCountDefect(
    input.problemText,
    input.candidate,
    input.toolObservations,
  );
  if (realRoots !== null) defects.push(realRoots);
  const splittingField = splittingFieldDegreeDefect(
    input.problemText,
    input.candidate,
    input.toolObservations,
  );
  if (splittingField !== null) defects.push(splittingField);
  const interpolation = interpolationResidualDefect(
    input.problemText,
    input.candidate,
    input.toolObservations,
  );
  if (interpolation !== null) defects.push(interpolation);
  const ols = olsMismatchDefect(input.candidate, input.toolObservations);
  if (ols !== null) defects.push(ols);
  const groupStructure = groupStructureMismatchDefect(
    input.candidate,
    input.toolObservations,
  );
  if (groupStructure !== null) defects.push(groupStructure);
  const optionNumeric = optionNumericContradictionDefect(
    input.problemText,
    input.candidate,
    input.toolObservations,
  );
  if (optionNumeric !== null) defects.push(optionNumeric);
  const optionVerdict = optionVerdictContradictionDefect(
    input.problemText,
    input.candidate,
    input.toolObservations,
  );
  if (optionVerdict !== null) defects.push(optionVerdict);
  const completeness = solutionCompletenessDefect(
    input.candidate,
    input.packet,
    input.expectedSolutionKeys,
    input.requiresExhaustive === true,
  );
  if (completeness !== null) defects.push(completeness);
  return defects;
}

/** A bounded single-line excerpt, so a hint can never grow with the input. */
function boundedNoteExcerpt(text: string, limit = 240): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length <= limit ? single : single.slice(0, limit - 1).trimEnd() + "…";
}

/** A bounded, answer-free instruction for the one closure turn. */
export function answerClosureNote(defects: readonly AnswerClosureDefect[]): string {
  const kinds = new Set(defects.map((row) => row.kind));
  // One bounded, defect-specific hint per observation-grounded family. The
  // observed exact values are already named by the defect lines above; these
  // lines only say what the corrected packet has to contain.
  const hints: string[] = [];
  if (kinds.has("INTERPOLATION_RESIDUAL")) {
    hints.push(
      "If the answer is an interpolating polynomial, fit it through every stated point exactly and state the polynomial that is named as the interpolating polynomial above.",
    );
  }
  if (kinds.has("OLS_MISMATCH")) {
    hints.push(
      "If the answer is a least-squares line, state exactly the slope and intercept named above; do not restate the rejected pair.",
    );
  }
  if (kinds.has("GROUP_STRUCTURE_MISMATCH")) {
    hints.push(
      "If the answer states a group order or a conjugacy-class count, use exactly the observed values named above.",
    );
  }
  // Option-level defects: the chosen option's own text carries the rejected
  // value, so the hint restates the option letter with observed-versus-asserted.
  for (const row of defects) {
    if (
      row.kind === "OPTION_NUMERIC_CONTRADICTION" ||
      row.kind === "OPTION_VERDICT_CONTRADICTION"
    ) {
      hints.push(
        "Reconcile the chosen option with the exact observation: " +
          boundedNoteExcerpt(row.detail) +
          ".",
      );
    }
  }
  const lines = [
    "ANSWER CLOSURE. Control found machine-visible defects in the current candidate. Correct them from the problem statement; do not merely restate the candidate.",
    ...defects.map((row) => "- " + row.kind + ": " + row.detail + "."),
    ...hints,
    "Return exactly one complete WorkPacket with a corrected candidateProposal.",
    "Include one `CERT1|CHECK|<id>|<kind>|<explicit computation> => PASS` row for each corrected property.",
    "If the answer is multiple choice, include `CERT1|OPTIONS|A=TRUE,B=FALSE,...` covering every option in the problem exactly once and make candidateProposal exactly the TRUE options.",
    "If the problem asks for every solution or case, include `CERT1|COMPLETENESS|<exhaustive case split> => PASS`.",
    "If the answer is a density, include `CERT1|CHECK|<id>|DENSITY_CHECK|<integral over the support> = 1 => PASS`.",
    "Do not change tasks, scopes or protocol identity fields; keep claim, derivation and candidateProposal within 4096 Unicode code points each.",
  ];
  return lines.join("\n");
}
