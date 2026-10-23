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
