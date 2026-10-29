/**
 * Canonical answer keys for bounded consensus voting (pure, no I/O).
 *
 * A key only removes presentation differences that are mathematically
 * insignificant for the explicitly supported families. It never proves an
 * answer and it never merges two different mathematical objects: anything not
 * recognised as one of those families falls back to the stripped text.
 */

import { polynomialOf, type Poly } from "./agent-semantics.js";

const LABEL = /^(?:最终答案|答案|final\s+answer)\s*[:：]?\s*/iu;

function unwrapOnce(source: string): string {
  const text = source.trim();
  let match = /^\$([^$]+)\$$/su.exec(text);
  if (match !== null) return (match[1] as string).trim();
  match = /^\\\(([\s\S]*)\\\)$/u.exec(text);
  if (match !== null) return (match[1] as string).trim();
  match = /^\\\[([\s\S]*)\\\]$/u.exec(text);
  if (match !== null) return (match[1] as string).trim();
  match = /^\\boxed\{([\s\S]*)\}$/u.exec(text);
  if (match !== null) return (match[1] as string).trim();
  return text;
}

function bigAbs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a);
  let y = bigAbs(b);
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1n;
}

function rational(n: bigint, d: bigint): string | null {
  if (d === 0n) return null;
  let num = n;
  let den = d;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const factor = gcd(num, den);
  return `rat:${num / factor}/${den / factor}`;
}

/** Exact reduced rational key for the whole answer, or null. */
function rationalToken(text: string): string | null {
  let match = /^([+-]?\d+)\/([+-]?\d+)$/u.exec(text);
  if (match !== null) {
    return rational(BigInt(match[1] as string), BigInt(match[2] as string));
  }
  match = /^([+-]?)(\d+)\.(\d+)$/u.exec(text);
  if (match !== null) {
    const sign = match[1] === "-" ? -1n : 1n;
    const fraction = match[3] as string;
    const denominator = 10n ** BigInt(fraction.length);
    const numerator = BigInt(match[2] as string) * denominator + BigInt(fraction);
    return rational(sign * numerator, denominator);
  }
  match = /^([+-]?\d+)$/u.exec(text);
  if (match !== null) {
    return rational(BigInt(match[1] as string), 1n);
  }
  match = /^\\frac\{([+-]?\d+)\}\{([+-]?\d+)\}$/u.exec(text);
  if (match !== null) {
    return rational(BigInt(match[1] as string), BigInt(match[2] as string));
  }
  // TeX's unbraced form takes exactly one token for each argument.
  match = /^\\frac([+-]?\d)([+-]?\d)$/u.exec(text);
  if (match !== null) {
    return rational(BigInt(match[1] as string), BigInt(match[2] as string));
  }
  return null;
}

/** Sorted exact numeric-set key, or null when the whole answer is not one. */
function numericSetToken(text: string): string | null {
  const match = /^\{([^{}]*)\}$/u.exec(text);
  if (match === null) return null;
  const body = (match[1] as string).trim();
  if (body.length === 0) return "set:";
  const keys = new Set<string>();
  for (const part of body.split(",")) {
    const key = rationalToken(part.trim());
    if (key === null) return null;
    keys.add(key);
  }
  return `set:${[...keys].sort().join(",")}`;
}

/**
 * Canonical option key. A one-letter answer is treated as an option only when
 * it carries explicit option notation; a longer list must consist only of
 * option letters and separators. A sentence that merely contains option
 * letters is never converted.
 */
function optionToken(text: string): string | null {
  let body: string;
  let singleMustBeExplicit = false;
  if (/^\([a-e](?:[,，、;；]?[a-e])*\)$/u.test(text)) {
    body = text.slice(1, -1);
  } else if (/^[a-e][.、]$/u.test(text)) {
    body = text.slice(0, 1);
    singleMustBeExplicit = true;
  } else if (/^[a-e]{2,}$/u.test(text)) {
    body = text;
  } else if (/^[a-e](?:[,，、;；][a-e])+$/u.test(text)) {
    body = text;
  } else {
    return null;
  }
  const letters = new Set((body.match(/[a-e]/gu) ?? []).map((letter) => letter.toUpperCase()));
  if (letters.size === 0) return null;
  if (letters.size === 1 && !singleMustBeExplicit && !/^\([a-e]\)$/u.test(text)) {
    return null;
  }
  return `options:${[...letters].sort().join(",")}`;
}

function polynomialToken(poly: Poly): string {
  const rows = [...poly.entries()]
    .filter(([, coefficient]) => coefficient !== 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `poly:${rows.map(([monomial, coefficient]) => `${monomial}=${coefficient}`).join(";")}`;
}

/** Conservative canonical key used only for bounded consensus comparison. */
export function canonicalAnswerKey(text: string): string {
  let value = text.trim();
  value = value.replace(LABEL, "").trim();
  value = unwrapOnce(value);
  // A single uppercase A-E is an option answer in this voting context; a
  // lowercase single letter stays a mathematical variable.
  const compactRaw = value.replace(/\s+/gu, "");
  if (/^[A-E]$/u.test(compactRaw)) {
    return `options:${compactRaw}`;
  }
  const compactLower = compactRaw.toLowerCase();

  if (
    compactLower === "正确" ||
    compactLower === "真" ||
    compactLower === "true" ||
    compactLower === "yes"
  ) {
    return "truth:true";
  }
  if (
    compactLower === "错误" ||
    compactLower === "假" ||
    compactLower === "false" ||
    compactLower === "no"
  ) {
    return "truth:false";
  }
  const rationalKey = rationalToken(value.replace(/\s*\/\s*/gu, "/").trim());
  if (rationalKey !== null) {
    return rationalKey;
  }
  const setKey = numericSetToken(value);
  if (setKey !== null) {
    return setKey;
  }
  const optionKey = optionToken(compactLower);
  if (optionKey !== null) {
    return optionKey;
  }
  // Do not turn two adjacent numeric literals ("1 2", "1 1/2") into a
  // polynomial product and then a different numeric answer.
  const polynomial = /\d\s+\d/u.test(value) ? null : polynomialOf(compactLower);
  if (polynomial !== null) {
    return polynomialToken(polynomial);
  }
  return `text:${compactLower}`;
}

/** True exactly when two answers have the same canonical key. */
export function sameAnswerKey(a: string, b: string): boolean {
  return canonicalAnswerKey(a) === canonicalAnswerKey(b);
}

const COMPONENT_OPEN = "([{（【「";
const COMPONENT_CLOSE = ")]}）】」";
const COMPONENT_SEPARATOR = /[,;，；、]/u;
/**
 * A short left-hand tag of a labelled component: `σ^{-2}=(14253)`, `x=1`,
 * `A: 3`. It must not contain a separator (already split), and it must be short
 * so that a real equation such as `240 - 190·(5/6)^{3/2} = 95.46` is never
 * treated as a tag plus a value.
 */
const COMPONENT_TAG = /^[^=:：]{1,32}[=:：]\s*(.+)$/su;

/**
 * The value of one component, with a short left-hand tag removed.
 *
 * Two ballots of the same question routinely label the same blank differently
 * (`σ^{-2}=(14253)` against a bare `(14253)`), and an unlabelled comparison would
 * split those two identical answers into two minorities while a wrong bare value
 * keeps both of its votes. Only the component comparison uses this form; the
 * whole-answer vote and the delivered text always stay the model's own.
 */
export function componentValue(part: string): string {
  const text = part.trim();
  const match = COMPONENT_TAG.exec(text);
  if (match === null) return text;
  const value = (match[1] as string).trim();
  return value.length === 0 ? text : value;
}

function componentKey(part: string): string {
  return canonicalAnswerKey(componentValue(part));
}

/**
 * Split a multi-part answer into its top-level components.
 *
 * Only separators OUTSIDE brackets split, so `(14253),(165)` is two answers
 * while `(a,b)` and `\{1,2,3\}` stay one. Empty components are dropped and the
 * original text of every component is kept, because a component is only ever
 * compared through `canonicalAnswerKey` and the delivered answer is always one
 * real packet, never a rewrite.
 */
export function answerComponents(text: string): string[] {
  const value = unwrapOnce(text);
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (COMPONENT_OPEN.includes(character)) {
      depth += 1;
    } else if (COMPONENT_CLOSE.includes(character)) {
      depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && COMPONENT_SEPARATOR.test(character)) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

/**
 * How many components of each candidate agree with the per-component majority.
 *
 * This only answers a question the whole-answer vote cannot: when every ballot
 * produced a DIFFERENT whole answer, the whole-answer vote has no majority at
 * all and falls back to the last reply. On a multi-part question the ballots
 * usually still agree component by component, and the ballot that matches the
 * most component majorities is the strongest real packet to deliver. The result
 * is a score per ballot, never a synthesised answer: the caller keeps one real
 * packet, so the delivered candidate stays a real receipt the Host can project.
 *
 * Two conservative guards keep this out of the way everywhere else: fewer than
 * two components scores zero for every ballot, and ballots with different
 * component counts score zero as well (their components are not comparable).
 */
export function componentAgreementScores(candidates: readonly string[]): number[] {
  const components = candidates.map(answerComponents);
  const width = components[0]?.length ?? 0;
  if (width < 2 || components.some((row) => row.length !== width)) {
    return candidates.map(() => 0);
  }
  const targets: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const counts = new Map<string, number>();
    for (const row of components) {
      const key = componentKey(row[index]!);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best = 0;
    for (const count of counts.values()) best = Math.max(best, count);
    // Latest tie-break, exactly like the whole-answer vote.
    let target = componentKey(components[components.length - 1]![index]!);
    for (let row = components.length - 1; row >= 0; row -= 1) {
      const key = componentKey(components[row]![index]!);
      if ((counts.get(key) ?? 0) === best) {
        target = key;
        break;
      }
    }
    targets.push(target);
  }
  return components.map((row) =>
    row.reduce(
      (score, part, index) =>
        score + (componentKey(part) === targets[index] ? 1 : 0),
      0,
    ),
  );
}

/**
 * Index of the ballot exact support selects, or -1 for no ballot at all.
 *
 * One rule, two stages, and every tie-break is the LATEST ballot:
 *   1. a whole-answer majority (two or more ballots sharing one canonical key);
 *   2. otherwise, when every whole answer differs, the ballot matching the most
 *      per-component majorities (see `componentAgreementScores`).
 *
 * The Host mirrors this in `ballot_choice`; the two implementations must stay
 * identical or the protected-candidate projection stops matching the delivered
 * artifact.
 */
export function frontRunnerIndex(candidates: readonly string[]): number {
  if (candidates.length === 0) return -1;
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = canonicalAnswerKey(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  for (const count of counts.values()) best = Math.max(best, count);
  if (best >= 2) {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if ((counts.get(canonicalAnswerKey(candidates[index]!)) ?? 0) === best) {
        return index;
      }
    }
    return candidates.length - 1;
  }
  const scores = componentAgreementScores(candidates);
  let top = 0;
  for (const score of scores) top = Math.max(top, score);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (scores[index] === top) return index;
  }
  return candidates.length - 1;
}
