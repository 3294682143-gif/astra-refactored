/**
 * Trusted RC — repair-evidence semantics (Step 1).
 *
 * A checker can ground a revision of a challenged answer obligation ONLY when
 * the relation it checks is the original problem's OWN relation, compared by
 * polynomial equivalence — not merely an expression that mentions the same
 * variable. `x+999` (or a constant like `2+2`) is never equivalent to the
 * problem's relation `x(x-1)=0`, so it can never support the revision; `x*(x-1)`
 * is. Pure module: no I/O, no clock, no model call.
 */

import type { P2MethodEntry } from "@astra/protocol";

export type Poly = ReadonlyMap<string, number>;

const EPS = 1e-9;

function monoParts(key: string): Map<string, number> {
  const out = new Map<string, number>();
  if (key === "") {
    return out;
  }
  for (const part of key.split("*")) {
    const [name, exponent] = part.split("^");
    out.set(name as string, Number(exponent ?? "1"));
  }
  return out;
}

function keyOf(parts: Map<string, number>): string {
  const rows = [...parts.entries()].filter(([, exponent]) => exponent !== 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return rows.map(([name, exponent]) => (exponent === 1 ? name : `${name}^${exponent}`)).join("*");
}

function clean(source: Map<string, number>): Poly {
  const out = new Map<string, number>();
  for (const [key, value] of source) {
    if (Math.abs(value) > EPS) {
      out.set(key, value);
    }
  }
  return out;
}

function polyAdd(a: Poly, b: Poly): Poly {
  const out = new Map<string, number>(a);
  for (const [key, value] of b) {
    out.set(key, (out.get(key) ?? 0) + value);
  }
  return clean(out);
}

function polyNeg(a: Poly): Poly {
  const out = new Map<string, number>();
  for (const [key, value] of a) {
    out.set(key, -value);
  }
  return out;
}

function polyScale(a: Poly, factor: number): Poly {
  const out = new Map<string, number>();
  for (const [key, value] of a) {
    out.set(key, value * factor);
  }
  return clean(out);
}

function polyMul(a: Poly, b: Poly): Poly {
  const out = new Map<string, number>();
  for (const [ka, ca] of a) {
    for (const [kb, cb] of b) {
      const parts = monoParts(ka);
      for (const [name, exponent] of monoParts(kb)) {
        parts.set(name, (parts.get(name) ?? 0) + exponent);
      }
      const key = keyOf(parts);
      out.set(key, (out.get(key) ?? 0) + ca * cb);
    }
  }
  return clean(out);
}

function polyPow(base: Poly, exponent: number): Poly | null {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 16) {
    return null;
  }
  let result: Poly = new Map([["", 1]]);
  for (let index = 0; index < exponent; index += 1) {
    result = polyMul(result, base);
  }
  return result;
}

/**
 * Reciprocal power of ONE monomial (`x⁻¹`, `(2x)⁻²`). A negative exponent is
 * representable only when the powered base is exactly one monomial; every other
 * case yields null rather than an invented polynomial.
 */
function monomialInversePow(base: Poly, magnitude: number): Poly | null {
  if (!Number.isInteger(magnitude) || magnitude < 1 || magnitude > 16) {
    return null;
  }
  const powered = polyPow(base, magnitude);
  if (powered === null || powered.size !== 1) {
    return null;
  }
  const [key, coefficient] = [...powered.entries()][0]!;
  if (!Number.isFinite(coefficient) || Math.abs(coefficient) < EPS) {
    return null;
  }
  const inverted = new Map<string, number>();
  for (const [name, exponent] of monoParts(key)) {
    inverted.set(name, -exponent);
  }
  return clean(new Map([[keyOf(inverted), 1 / coefficient]]));
}

/** `²` -> "2"; anything else -> null. Only the ten Unicode superscript digits. */
function superscriptDigit(ch: string): string | null {
  const position = "⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(ch);
  return position < 0 ? null : String(position);
}

/** `⁻` -> "-", `⁺` -> "+", anything else -> null. */
function superscriptSign(ch: string): string | null {
  return ch === "⁻" ? "-" : ch === "⁺" ? "+" : null;
}

/**
 * Unicode notation the model actually writes in Chinese mathematical answers:
 * `²³⁴` superscript exponents, `⁻¹` superscript inverse, `−` U+2212 minus,
 * `·` U+00B7 and `×` U+00D7 multiplication. Tokenization stays pure and
 * deterministic; every other unknown character is still a hard null.
 */
function tokenize(source: string): string[] | null {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === " ") {
      index += 1;
      continue;
    }
    if (superscriptDigit(ch) !== null || superscriptSign(ch) !== null) {
      // One superscript run is one exponent: `x¹²` -> `x ^ 12`, `x⁻¹` -> `x ^ -1`.
      let sign = "";
      const leading = superscriptSign(ch);
      if (leading !== null) {
        sign = leading;
        index += 1;
      }
      let digits = "";
      while (index < source.length) {
        const digit = superscriptDigit(source[index] as string);
        if (digit === null) {
          break;
        }
        digits += digit;
        index += 1;
      }
      if (digits.length === 0) {
        return null; // a superscript sign with no superscript digits
      }
      tokens.push("^");
      tokens.push(sign + digits);
      continue;
    }
    if (ch === "·" || ch === "×") {
      tokens.push("*");
      index += 1;
      continue;
    }
    if (ch === "−") {
      tokens.push("-");
      index += 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = index;
      while (end < source.length && /[0-9]/.test(source[end] as string)) {
        end += 1;
      }
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let end = index;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] as string)) {
        end += 1;
      }
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    if (ch === "*" && source[index + 1] === "*") {
      tokens.push("^");
      index += 2;
      continue;
    }
    if ("+-*/^()".includes(ch)) {
      tokens.push(ch);
      index += 1;
      continue;
    }
    return null;
  }
  return tokens.length > 0 && tokens.length <= 4096 ? tokens : null;
}

class Parser {
  #index = 0;

  constructor(private readonly tokens: readonly string[]) {}

  #peek(): string | null {
    return this.tokens[this.#index] ?? null;
  }

  #next(): string | null {
    return this.tokens[this.#index++] ?? null;
  }

  parse(): Poly | null {
    const value = this.#expr();
    return value !== null && this.#peek() === null ? value : null;
  }

  #expr(): Poly | null {
    let left = this.#term();
    if (left === null) {
      return null;
    }
    while (this.#peek() === "+" || this.#peek() === "-") {
      const op = this.#next();
      const right = this.#term();
      if (right === null) {
        return null;
      }
      left = op === "+" ? polyAdd(left, right) : polyAdd(left, polyNeg(right));
    }
    return left;
  }

  #term(): Poly | null {
    let left = this.#factor();
    if (left === null) {
      return null;
    }
    for (;;) {
      const token = this.#peek();
      if (token === "*" || token === "/") {
        this.#next();
        const right = this.#factor();
        if (right === null) {
          return null;
        }
        if (token === "*") {
          left = polyMul(left, right);
        } else {
          const divisor = this.#constant(right);
          if (divisor === null || divisor === 0) {
            return null;
          }
          left = polyScale(left, 1 / divisor);
        }
        continue;
      }
      // Implicit multiplication: `x(x-1)`, `2x`, `(a)(b)`.
      if (token !== null && (token === "(" || /^[A-Za-z0-9]/.test(token))) {
        const right = this.#factor();
        if (right === null) {
          return null;
        }
        left = polyMul(left, right);
        continue;
      }
      return left;
    }
  }

  #factor(): Poly | null {
    if (this.#peek() === "-") {
      this.#next();
      const value = this.#factor();
      return value === null ? null : polyNeg(value);
    }
    if (this.#peek() === "+") {
      this.#next();
      return this.#factor();
    }
    const base = this.#atom();
    if (base === null) {
      return null;
    }
    if (this.#peek() === "^") {
      this.#next();
      const exponent = this.#next();
      if (exponent === null || !/^[+-]?[0-9]+$/u.test(exponent)) {
        return null;
      }
      const power = Number(exponent);
      // Only a superscript run can carry a sign (`x⁻¹`); the ASCII `x^-1` form
      // keeps its previous behaviour of an unparsable exponent.
      return power < 0 ? monomialInversePow(base, -power) : polyPow(base, power);
    }
    return base;
  }

  #atom(): Poly | null {
    const token = this.#peek();
    if (token === "(") {
      this.#next();
      const value = this.#expr();
      if (value === null || this.#next() !== ")") {
        return null;
      }
      return value;
    }
    if (token !== null && /^[0-9]+$/.test(token)) {
      this.#next();
      const number = Number(token);
      if (!Number.isFinite(number)) {
        return null;
      }
      return new Map([["", number]]);
    }
    if (token !== null && /^[A-Za-z][A-Za-z0-9_]*$/.test(token)) {
      this.#next();
      return new Map([[token, 1]]);
    }
    return null;
  }

  #constant(value: Poly): number | null {
    const rows = [...value.entries()];
    return rows.length === 1 && rows[0]![0] === "" ? rows[0]![1] : null;
  }
}

/** Normalized polynomial of one arithmetic expression, or null when unparsable. */
export function polynomialOf(source: string): Poly | null {
  const tokens = tokenize(source);
  if (tokens === null) {
    return null;
  }
  return new Parser(tokens).parse();
}

/** The problem's own relation, as `lhs - rhs`, or null when none is present. */
export function problemRelationPolynomial(problem: string): Poly | null {
  const match = /[A-Za-z0-9_+\-*/^().]+\s*=\s*[A-Za-z0-9_+\-*/^().]+/.exec(problem);
  if (match === null) {
    return null;
  }
  const parts = match[0].split("=");
  const left = polynomialOf(parts[0] as string);
  const right = polynomialOf(parts[1] as string);
  if (left === null || right === null) {
    return null;
  }
  return polyAdd(left, polyNeg(right));
}

/** Exact polynomial equivalence (coefficient map equality). */
export function samePolynomial(a: Poly | null, b: Poly | null): boolean {
  if (a === null || b === null || a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || Math.abs(value - other) > EPS) {
      return false;
    }
  }
  return true;
}

/** True when the relation vanishes at the numeric value (a genuine root). */
export function polynomialVanishesAt(poly: Poly | null, value: number): boolean {
  if (poly === null) {
    return false;
  }
  let total = 0;
  for (const [key, coefficient] of poly) {
    let term = coefficient;
    for (const [name, exponent] of monoParts(key)) {
      term *= Math.pow(value, exponent);
    }
    total += term;
  }
  return Math.abs(total) < 1e-9;
}

/** Parse a `{a,b,c}` answer set of numbers, or null when it is not a numeric set. */
export function numericSetElements(proposal: string): readonly number[] | null {
  const match = /^\s*\{([^}]*)\}\s*$/.exec(proposal);
  if (match === null) {
    return null;
  }
  const body = (match[1] as string).trim();
  if (body.length === 0) {
    return [];
  }
  const out: number[] = [];
  for (const part of body.split(",")) {
    const text = part.trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
      return null;
    }
    out.push(Number(text));
  }
  return out;
}

// ---------------------------------------------------------------------------
// P0-1: exact rational solution-set semantics (no float approximation, exact
// dedup, explicit parse-failure, independent rational-root solving).
// ---------------------------------------------------------------------------

export interface Rat {
  readonly n: bigint;
  readonly d: bigint;
}

function bigAbs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function bigGcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a);
  let y = bigAbs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function rat(n: bigint, d: bigint): Rat {
  if (d === 0n) {
    throw new Error("RAT_ZERO_DEN");
  }
  let num = n;
  let den = d;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = bigGcd(num, den) || 1n;
  return { n: num / g, d: den / g };
}

function ratAdd(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

function ratMul(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d);
}

function ratSub(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

function ratSign(a: Rat): number {
  return a.n === 0n ? 0 : a.n < 0n ? -1 : 1;
}

function ratIsZero(a: Rat): boolean {
  return a.n === 0n;
}

function ratKey(a: Rat): string {
  return `${a.n}/${a.d}`;
}

function parseRat(text: string): Rat | null {
  const t = text.trim();
  let m = /^([+-]?\d+)\/([+-]?\d+)$/.exec(t);
  if (m) {
    const den = BigInt(m[2] as string);
    if (den === 0n) {
      return null;
    }
    return rat(BigInt(m[1] as string), den);
  }
  m = /^([+-]?\d+)$/.exec(t);
  if (m) {
    return rat(BigInt(m[1] as string), 1n);
  }
  m = /^([+-]?)(\d+)\.(\d+)$/.exec(t);
  if (m) {
    const sign = m[1] === "-" ? -1n : 1n;
    const frac = m[3] as string;
    const den = 10n ** BigInt(frac.length);
    const num = BigInt(m[2] as string) * den + BigInt(frac);
    return rat(sign * num, den);
  }
  return null;
}

/**
 * Parse an answer set `{a,b,c}` into EXACT reduced rationals with silent-free
 * deduplication. Returns null when the text is not a set or any element is not
 * an exact rational (no partial parsing, no dropped elements).
 */
export function rationalSetElements(proposal: string): readonly Rat[] | null {
  const m = /^\s*\{([^}]*)\}\s*$/.exec(proposal);
  if (m === null) {
    return null;
  }
  const body = (m[1] as string).trim();
  if (body === "") {
    return [];
  }
  const seen = new Map<string, Rat>();
  for (const part of body.split(",")) {
    const value = parseRat(part);
    if (value === null) {
      return null;
    }
    seen.set(ratKey(value), value);
  }
  return [...seen.values()];
}

function singleVariable(poly: Poly): string | null {
  const vars = new Set<string>();
  for (const key of poly.keys()) {
    for (const [name] of monoParts(key)) {
      vars.add(name);
    }
  }
  return vars.size === 1 ? [...vars][0]! : null;
}

function integerCoefficients(poly: Poly, variable: string): bigint[] | null {
  let degree = 0;
  const rows: { readonly e: number; readonly c: number }[] = [];
  for (const [key, value] of poly) {
    const parts = monoParts(key);
    for (const [name] of parts) {
      if (name !== variable) {
        return null;
      }
    }
    const e = parts.get(variable) ?? 0;
    if (!Number.isInteger(e) || e < 0) {
      // A Laurent monomial (`x⁻¹`) has no coefficient row in this basis.
      return null;
    }
    rows.push({ e, c: value });
    if (e > degree) {
      degree = e;
    }
  }
  const numeric: number[] = new Array(degree + 1).fill(0);
  for (const row of rows) {
    numeric[row.e] = (numeric[row.e] as number) + row.c;
  }
  // Clear simple rational coefficients (e.g. `x/2 - 1`) with the smallest integer
  // factor that makes every coefficient integral; scaling does not change the
  // roots. Irrational coefficients do not clear and yield null (undeterminable).
  let scale = 1;
  for (; scale <= 4096; scale += 1) {
    if (numeric.every((value) => Math.abs(value * scale - Math.round(value * scale)) < 1e-9)) {
      break;
    }
  }
  if (scale > 4096) {
    return null;
  }
  return numeric.map((value) => BigInt(Math.round(value * scale)));
}

function divisors(value: bigint): bigint[] {
  const m = bigAbs(value);
  const out: bigint[] = [];
  for (let i = 1n; i * i <= m; i += 1n) {
    if (m % i === 0n) {
      out.push(i);
      if (i * i !== m) {
        out.push(m / i);
      }
    }
  }
  return out;
}

function ratPow(base: Rat, exponent: number): Rat {
  let out = rat(1n, 1n);
  for (let i = 0; i < exponent; i += 1) {
    out = ratMul(out, base);
  }
  return out;
}

function evalRat(coefficients: readonly bigint[], x: Rat): Rat {
  let acc = rat(0n, 1n);
  for (let e = 0; e < coefficients.length; e += 1) {
    if (coefficients[e] === 0n) {
      continue;
    }
    acc = ratAdd(acc, ratMul(rat(coefficients[e] as bigint, 1n), ratPow(x, e)));
  }
  return acc;
}

const Q_ZERO: Rat = { n: 0n, d: 1n };

function ratDiv(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d, a.d * b.n);
}

function qTrim(poly: readonly Rat[]): Rat[] {
  const out = poly.slice();
  let hi = out.length - 1;
  while (hi >= 0 && ratIsZero(out[hi] as Rat)) {
    hi -= 1;
  }
  return out.slice(0, hi + 1);
}

function qScale(poly: readonly Rat[], factor: Rat): Rat[] {
  return qTrim(poly.map((value) => ratMul(value, factor)));
}

function qSub(a: readonly Rat[], b: readonly Rat[]): Rat[] {
  const size = Math.max(a.length, b.length);
  const out: Rat[] = [];
  for (let i = 0; i < size; i += 1) {
    out.push(ratSub((a[i] ?? Q_ZERO) as Rat, (b[i] ?? Q_ZERO) as Rat));
  }
  return qTrim(out);
}

function qMul(a: readonly Rat[], b: readonly Rat[]): Rat[] {
  if (a.length === 0 || b.length === 0) {
    return [];
  }
  const out: Rat[] = new Array(a.length + b.length - 1).fill(Q_ZERO);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      out[i + j] = ratAdd(out[i + j] as Rat, ratMul(a[i] as Rat, b[j] as Rat));
    }
  }
  return qTrim(out);
}

function qDerivative(poly: readonly Rat[]): Rat[] {
  const out: Rat[] = [];
  for (let e = 1; e < poly.length; e += 1) {
    out.push(ratMul(rat(BigInt(e), 1n), poly[e] as Rat));
  }
  return qTrim(out);
}

/** Exact polynomial remainder over the rationals (ascending powers). */
function qRemainder(a: readonly Rat[], b: readonly Rat[]): Rat[] {
  let rest = qTrim(a);
  const divisor = qTrim(b);
  if (divisor.length === 0) {
    return [];
  }
  const divisorDegree = divisor.length - 1;
  const divisorLead = divisor[divisorDegree] as Rat;
  while (rest.length > 0 && rest.length - 1 >= divisorDegree) {
    const restDegree = rest.length - 1;
    const factor = ratDiv(rest[restDegree] as Rat, divisorLead);
    const term: Rat[] = new Array(restDegree - divisorDegree + 1).fill(Q_ZERO);
    term[restDegree - divisorDegree] = factor;
    const next = qSub(rest, qMul(term, divisor));
    if (next.length - 1 >= restDegree) {
      return []; // defensive: never loop on degenerate input
    }
    rest = next;
  }
  return rest;
}

function qSignAtInfinity(poly: readonly Rat[], negative: boolean): number {
  const trimmed = qTrim(poly);
  const degree = trimmed.length - 1;
  const sign = ratSign(trimmed[degree] as Rat);
  return negative && degree % 2 === 1 ? -sign : sign;
}

function qSignChangesAtInfinity(sequence: readonly (readonly Rat[])[], negative: boolean): number {
  let changes = 0;
  let previous = 0;
  for (const poly of sequence) {
    const sign = qSignAtInfinity(poly, negative);
    if (sign === 0) {
      continue;
    }
    if (previous !== 0 && sign !== previous) {
      changes += 1;
    }
    previous = sign;
  }
  return changes;
}

/**
 * Exact "does this real polynomial have a real root?" via the Sturm sequence.
 * Used only to decide whether the rational roots already found are the WHOLE
 * real solution set; it never claims a numeric root by approximation.
 */
function hasRealRoot(poly: readonly Rat[]): boolean {
  const base = qTrim(poly);
  if (base.length <= 1) {
    return false;
  }
  if (base.length === 2) {
    return true;
  }
  const sequence: Rat[][] = [base, qDerivative(base)];
  while (sequence.length <= base.length + 1) {
    const last = qTrim(sequence[sequence.length - 1] as Rat[]);
    if (last.length === 0) {
      break;
    }
    const previous = qTrim(sequence[sequence.length - 2] as Rat[]);
    const next = qScale(qRemainder(previous, last), rat(-1n, 1n));
    if (next.length === 0) {
      break;
    }
    sequence.push(next);
  }
  return qSignChangesAtInfinity(sequence, true) - qSignChangesAtInfinity(sequence, false) > 0;
}

/** Divide an exact rational polynomial by `(x - root)`; null when not divisible. */
function stripLinearRoot(poly: readonly Rat[], root: Rat): Rat[] | null {
  const trimmed = qTrim(poly);
  const degree = trimmed.length - 1;
  if (degree < 1) {
    return null;
  }
  const quotient: Rat[] = new Array(degree).fill(Q_ZERO);
  quotient[degree - 1] = trimmed[degree] as Rat;
  for (let i = degree - 1; i >= 1; i -= 1) {
    quotient[i - 1] = ratAdd(trimmed[i] as Rat, ratMul(root, quotient[i] as Rat));
  }
  const remainder = ratAdd(trimmed[0] as Rat, ratMul(root, quotient[0] as Rat));
  if (!ratIsZero(remainder)) {
    return null;
  }
  return qTrim(quotient);
}

/**
 * The COMPLETE finite real solution set of a single-variable relation, expressed
 * exactly, or null when it cannot be determined. It is `null` whenever the real
 * roots are NOT all rational (a rational-root enumeration alone is never proof
 * of the whole real solution set), and for multi-variable / non-integer /
 * oversized / zero relations. This is an independent, verifiable solving result
 * — never a model self-claim, and never an incomplete set passed off as complete.
 */
export function solutionSetOf(poly: Poly | null): readonly Rat[] | null {
  if (poly === null) {
    return null;
  }
  const variable = singleVariable(poly);
  if (variable === null) {
    return null;
  }
  const coefficients = integerCoefficients(poly, variable);
  if (coefficients === null) {
    return null;
  }
  let hi = coefficients.length - 1;
  while (hi >= 0 && coefficients[hi] === 0n) {
    hi -= 1;
  }
  if (hi < 0) {
    return null;
  }
  const working = coefficients.slice(0, hi + 1);
  const roots = new Map<string, Rat>();
  let zeroShift = 0;
  while (working.length > 1 && working[0] === 0n) {
    working.shift();
    zeroShift += 1;
  }
  if (zeroShift > 0) {
    roots.set(ratKey(rat(0n, 1n)), rat(0n, 1n));
  }
  if (working.length === 1) {
    return [...roots.values()];
  }
  const constant = working[0] as bigint;
  const leading = working[working.length - 1] as bigint;
  if (bigAbs(constant) > 1000000n || bigAbs(leading) > 1000000n) {
    return null;
  }
  for (const p of divisors(constant)) {
    for (const q of divisors(leading)) {
      for (const sign of [1n, -1n]) {
        const candidate = rat(sign * p, q);
        if (ratIsZero(evalRat(working, candidate))) {
          roots.set(ratKey(candidate), candidate);
        }
      }
    }
  }
  // Completeness certification: divide out every rational root (with its full
  // multiplicity). If any real root remains, the rational roots are NOT the whole
  // real solution set, so the set is undeterminable here and must be null.
  let residual = qTrim(working.map((value) => rat(value, 1n)));
  for (const root of roots.values()) {
    let reduced = stripLinearRoot(residual, root);
    while (reduced !== null) {
      residual = reduced;
      reduced = stripLinearRoot(residual, root);
    }
  }
  if (residual.length > 1 && hasRealRoot(residual)) {
    return null;
  }
  return [...roots.values()];
}

/** Exact set equality of two (possibly null) rational sets. */
export function sameRationalSet(a: readonly Rat[] | null, b: readonly Rat[] | null): boolean {
  if (a === null || b === null || a.length !== b.length) {
    return false;
  }
  const right = new Set(b.map(ratKey));
  for (const value of a) {
    if (!right.has(ratKey(value))) {
      return false;
    }
  }
  return true;
}

/** Canonical stable key of one exact rational. */
export function rationalKeyOf(value: Rat): string {
  return ratKey(value);
}

/**
 * Canonical keys of a `{a,b,c}` answer set, sorted for direct comparison, or
 * null when the proposal is not an exact finite rational set.
 */
export function rationalSetKeys(proposal: string): readonly string[] | null {
  const values = rationalSetElements(proposal);
  return values === null ? null : values.map(ratKey).sort();
}

/** One deterministic, problem-semantic route to a whitelisted tool. */
export interface SemanticToolRoute {
  /** Stable identity used only for Host-side funnel metrics. */
  readonly id: string;
  readonly toolName: string;
  /** Semantic operation label; for exact_check_expr it is the tool operation. */
  readonly operation: string;
  /** A safe JSON argument skeleton shown to the model; never executed. */
  readonly argsTemplate: string;
}

const FINITE_ENUMERATION_ROUTE: SemanticToolRoute = Object.freeze({
  id: "FINITE_ENUMERATION",
  toolName: "bounded_enumeration",
  operation: "ENUMERATE",
  argsTemplate:
    '{"ranges":[<positive sizes>],"choose":<k>,"predicate":"<expression>"}',
});

const REAL_ROOT_COUNT_ROUTE: SemanticToolRoute = Object.freeze({
  id: "REAL_ROOT_COUNT",
  toolName: "real_root_count_expr",
  operation: "REAL_ROOT_COUNT",
  argsTemplate: '{"expression":"<explicit univariate polynomial>","variable":"x"}',
});

const SPLITTING_FIELD_DEGREE_ROUTE: SemanticToolRoute = Object.freeze({
  id: "SPLITTING_FIELD_DEGREE",
  toolName: "splitting_field_degree_expr",
  operation: "SPLITTING_FIELD_DEGREE",
  argsTemplate: '{"expression":"<explicit univariate polynomial>","variable":"x"}',
});

const CIRCLE_LAPLACIAN_ROUTE: SemanticToolRoute = Object.freeze({
  id: "CIRCLE_LAPLACIAN",
  toolName: "circle_laplacian_expr",
  operation: "CIRCLE_LAPLACIAN",
  argsTemplate: '{"expression":"<function of theta>"}',
});

const PLANAR_LAPLACIAN_ROUTE: SemanticToolRoute = Object.freeze({
  id: "PLANAR_LAPLACIAN",
  toolName: "planar_laplacian_expr",
  operation: "PLANAR_LAPLACIAN",
  argsTemplate: '{"expression":"<multivariable expression>","variables":["x","y"]}',
});

const POLYNOMIAL_EXPAND_COEFFICIENTS_ROUTE: SemanticToolRoute = Object.freeze({
  id: "POLYNOMIAL_EXPAND_COEFFICIENTS",
  toolName: "polynomial_expand_coefficients",
  operation: "EXPAND_COEFFICIENTS",
  argsTemplate:
    '{"expression":"<polynomial expression>","variables":["x"],"parameters":[]}',
});

const LINEAR_SYSTEM_SOLUTION_SET_ROUTE: SemanticToolRoute = Object.freeze({
  id: "LINEAR_SYSTEM_SOLUTION_SET",
  toolName: "linear_system_solution_set",
  operation: "SOLUTION_SET",
  argsTemplate:
    '{"matrix":[[<coefficients>]],"rhs":[<constants>],"variables":["x"],"domain":"RATIONAL"}',
});

const INTERPOLATION_FIT_ROUTE: SemanticToolRoute = Object.freeze({
  id: "INTERPOLATION_FIT",
  toolName: "interpolation_fit_check",
  operation: "INTERPOLATION_FIT",
  argsTemplate:
    '{"points":[{"x":"<exact rational>","y":"<exact rational>"}],"expression":"<claimed univariate polynomial>","variable":"x"}',
});

const STATS_OLS_ROUTE: SemanticToolRoute = Object.freeze({
  id: "OLS_CHECK",
  toolName: "stats_ols_check",
  operation: "OLS_CHECK",
  argsTemplate:
    '{"data":[{"x":"<exact rational>","y":"<exact rational>"}],"claimed":{"slope":"<exact rational>","intercept":"<exact rational>"}}',
});

const GROUP_STRUCTURE_ROUTE: SemanticToolRoute = Object.freeze({
  id: "GROUP_STRUCTURE",
  toolName: "finite_group_structure",
  operation: "GROUP_STRUCTURE",
  argsTemplate:
    '{"generators":["(12)","(123)"],"degree":3} OR {"named_group":"A4"}',
});

function exactRoute(operation: string, argsTemplate: string): SemanticToolRoute {
  return Object.freeze({
    id: `EXACT_${operation}`,
    toolName: "exact_check_expr",
    operation,
    argsTemplate,
  });
}

const EXACT_MAXIMAL_MINORS_ROUTE = exactRoute(
  "MAXIMAL_MINORS",
  '{"operation":"MAXIMAL_MINORS","matrix":<explicit matrix>,"variable":"t"}',
);
const EXACT_FACTOR_OVER_EXTENSION_ROUTE = exactRoute(
  "FACTOR_OVER_EXTENSION",
  '{"operation":"FACTOR_OVER_EXTENSION","expression":"<polynomial>","variable":"x","minimal_polynomials":[<minimal polynomials>]}',
);
const EXACT_DENSITY_CHECK_ROUTE = exactRoute(
  "DENSITY_CHECK",
  '{"operation":"DENSITY_CHECK","density":"<density valid on its support>","variable":"x","lower":"0","upper":"oo"}',
);
const EXACT_TRIG_REDUCE_ROUTE = exactRoute(
  "TRIG_REDUCE",
  '{"operation":"TRIG_REDUCE","expression":"<trigonometric/polynomial expression>","variable":"x"}',
);
const EXACT_LIMIT_ROUTE = exactRoute(
  "LIMIT",
  '{"operation":"LIMIT","expression":"<expression>","variable":"x","point":<limit point>}',
);

function continuousProbabilityWording(problemText: string): boolean {
  return /(连续型?随机变量|连续随机变量|连续分布|概率密度|密度函数|\bdensity\b|累积分布|分布函数|\bCDF\b|\bPDF\b|continuous\s+(?:random\s+variable|distribution)|正态分布|normal\s+distribution|指数分布|exponential\s+distribution|均匀分布\s*(?:U\s*)?[\[(]?\s*[0-9]|\[[^\]\n]{1,20}\]\s*(?:上的?)?\s*均匀分布|\bU\s*\(\s*[0-9]|\buniform\s+distribution[^\n。；;]{0,24}[\[(]\s*[0-9])/iu.test(
    problemText,
  );
}

function finiteCountingWording(problemText: string): boolean {
  const continuous = continuousProbabilityWording(problemText);
  const probabilityDraw =
    /(概率|probability)/iu.test(problemText) &&
    /(抽取|选取|随机取|从中取|draw|choose|select|hand)/iu.test(problemText);
  if (probabilityDraw) {
    return !continuous;
  }
  if (continuous) {
    return false;
  }
  const enumerationAction =
    /(枚举|列举|罗列|计数|排列数|组合数|(?:共轭类|生成元|子群|子集|顶点|元素|整数|集合|排列|组合)[^\n。；;]{0,16}(?:的)?个数|(?:多少|几)(?:个|种)[^\n。；;]{0,16}(?:排列|组合|整数|集合|子集|元素|群|顶点|边|方式|方法|选法|种)?|\bnumber\s+of\s+ways?\b|\bways?\s+to\b|\bcount\s+(?:the\s+)?number\s+of\b|\bhow\s+many\b)/iu.test(
      problemText,
    );
  if (!enumerationAction) {
    return false;
  }
  // Real-root counting has its own higher-priority route.
  if (/(实根|实数根|real\s+roots?)/iu.test(problemText)) {
    return false;
  }
  if (/(无限|无穷|\binfinite\b|all\s+real|任意实数)/iu.test(problemText)) {
    return false;
  }
  return /(排列|组合|整数|正整数|自然数|集合|子集|元素|群元素|子群|共轭类|生成元|顶点|边|图|树|字符串|元组|划分|方式|方法|选法|\bways?\b|permutation|combination|integer|set|subset|element|group|conjugacy|generator|vertex|vertices|edge|graph|tree|string|tuple|partition)/iu.test(
    problemText,
  );
}

function polynomialExpandWording(problemText: string): boolean {
  // The determinant/eigenvalue family owns characteristic-polynomial items.
  if (
    /(特征多项式|特征值|行列式|determinant|characteristic\s+polynomial|eigenvalue)/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  // Root finding and equation solving are not coefficient-expansion requests.
  if (
    /(?:求|解)[^\n。；;]{0,20}(?:方程|equation)|(?:方程|equation)[^\n。；;]{0,16}(?:的)?(?:实根|实数根|根|解)|(?:实根|实数根|零点|\broots?\b|\bzeros?\b)/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  const expansionAction =
    /(展开|展开式|乘积展开|乘开|合并同类项|因式分解[^\n。；;]{0,24}(?:乘法|相乘)|化简[^\n。；;]{0,24}(?:多项式|代数式|表达式)|(?:多项式|代数式|表达式)[^\n。；;]{0,12}化简|\bexpand(?:ed|ing|s)?\b|\bmultiply\s+out\b|\bcollect(?:ing)?\s+(?:the\s+)?coefficients?\b|\bsimplify[^\n。；;]{0,32}(?:polynomial|algebraic\s+expression|expression)\b)/iu.test(
      problemText,
    );
  if (expansionAction) {
    return true;
  }
  const coefficientAction = /(系数|\bcoefficients?\b)/iu.test(problemText);
  const polynomialContext =
    /(多项式|代数式|展开式|二项式|多项式环|乘积|\bpolynomial\b|\bbinomial\b|\bexpansion\b|\balgebraic\s+expression\b|\bmultiply\b|\bproduct\b|\([^()\n]{1,120}\)\s*\^\s*\{?\s*[0-9A-Za-z]|[xyztuvw]\s*\^\s*\{?\s*[0-9][^\n。；;]{0,12}(?:项|的)?\s*系数|系数[^\n。；;]{0,16}[xyztuvw]\s*\^|\bcoefficients?\b[^\n。；;]{0,20}[xyztuvw]\s*\^)/iu.test(
      problemText,
    );
  return coefficientAction && polynomialContext;
}

function interpolationFitWording(problemText: string): boolean {
  return /(插值|拉格朗日|Lagrange|牛顿插值|Newton\s+interpolation|过这些点的多项式|\binterpolat(?:e|ed|es|ing|ion)\b)/iu.test(
    problemText,
  );
}

function statsOlsWording(problemText: string): boolean {
  const explicitRegression =
    /(最小二乘|least\s+squares?|\bOLS\b|回归系数|regression\s+coefficients?|拟合直线|linear\s+regression|回归直线)/iu.test(
      problemText,
    );
  const residual = /(残差|\bresiduals?\b)/iu.test(problemText);
  if (!explicitRegression && !residual) {
    return false;
  }
  // A generic probability/distribution question is not an OLS request merely
  // because a residual or regression word appears somewhere in its prose.
  if (
    !explicitRegression &&
    /(概率|probability|分布|distribution)/iu.test(problemText)
  ) {
    return false;
  }
  return true;
}

function finiteGroupStructureWording(problemText: string): boolean {
  // A route to a permutation-group observation needs either explicit cycle
  // notation or one named group from the closed vocabulary the tool accepts.
  // Group terminology alone can be background to a homomorphism proof.
  const explicitCycle =
    /\(\s*[0-9]{2,}\s*\)|\(\s*[0-9]+\s*(?:[,\s]\s*[0-9]+\s*)+\)/u.test(
      problemText,
    );
  const namedGroup =
    /(?<![A-Za-z0-9_])(?:S_?[34]|A_?[45]|D_?(?:8|10)|[ZC]_?(?:[2-9]|1[0-2]))(?![A-Za-z0-9_])/iu.test(
      problemText,
    );
  if (!explicitCycle && !namedGroup) {
    return false;
  }
  // Ring/field language belongs to the algebra families, not to this one.
  if (
    /(环论|环同态|整环|商环|多项式环|一个环|是环|为环|在环|设环|令环|(?<!循)环(?:上|中|内|的)|理想|\bideals?\b|\bring\b|域论|有限域|域扩张|扩域|数域|一个域|是域|为域|在域|设域|令域|域(?:上|中|内)|\bfields?\b)/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  return /(共轭类|conjugacy\s+class(?:es)?|置换群|permutation\s+group|元素的?阶|element\s+orders?|群的?阶|order\s+of\s+(?:the\s+)?group|交换|abelian|commutative|循环|cyclic|中心|cent(?:er|re)|生成子群|subgroup\s+generated\s+by|generated\s+subgroup|子群|subgroup|由[^\n。；;]{0,60}生成的?(?:子群|群)|子群[^\n。；;]{0,20}生成|阶)/iu.test(
    problemText,
  );
}

function linearSystemWording(problemText: string): boolean {
  const explicitSystem =
    /(线性方程组|一次方程组|解方程组|求解方程组|联立方程(?:组)?|高斯消元|\bGaussian\s+elimination\b|\bsimultaneous\s+equations?\b|\bsolve\s+the\s+system\b|\bsystem\s+of\s+(?:linear\s+)?equations?\b|\\begin\s*\{cases\})/iu.test(
      problemText,
    );
  if (!explicitSystem) {
    return false;
  }
  // A differential system is not a finite rational linear system.
  return !(
    /(微分方程组|常微分方程组|differential\s+(?:equation\s+)?system)/iu.test(problemText) &&
    !/(线性方程组|linear\s+system)/iu.test(problemText)
  );
}

function exactLimitWording(problemText: string): boolean {
  if (/(极限|limit|\\lim|lim\s*_)/iu.test(problemText)) {
    return true;
  }
  const seriesLimit =
    /(级数[^\n。；;]{0,32}(?:的?和|求和|收敛|发散)|\b(?:series|power\s+series)\b[^\n。；;]{0,32}(?:sum|converges?|diverges?|limit)|\bsum\s+of\s+(?:the\s+)?(?:power\s+)?series\b|收敛到|收敛于|\bconverges?\s+to\b|\basymptotic\s+limit\b|渐近极限|(?:∑|\\sum|Σ)[^\n。；;]{0,32}(?:和|求和|极限|sum|limit))/iu.test(
      problemText,
    );
  if (!seriesLimit) {
    return false;
  }
  // A plain integral request must not borrow the limit family through a symbol.
  return !/(?:求|计算|evaluate|compute)[^\n。；;]{0,20}(?:积分|integral)/iu.test(problemText);
}

function realRootCountWording(problemText: string): boolean {
  return (
    /(?:实根|实数根|real\s+roots?)[^\n。；;]{0,24}(?:个数|数量|数目|多少|number|count)/iu.test(
      problemText,
    ) ||
    /(?:个数|数量|数目|number\s+of|count\s+of)[^\n。；;]{0,24}(?:实根|实数根|real\s+roots?)/iu.test(
      problemText,
    ) ||
    /(?:有几个|多少个|几条|how\s+many)[^\n。；;]{0,16}(?:实根|实数根|real\s+roots?)/iu.test(
      problemText,
    )
  );
}

function splittingFieldDegreeWording(problemText: string): boolean {
  if (
    /(分裂域|splitting\s+field)/iu.test(problemText) &&
    /(次数|degree|\[[^\]]*:[^\]]*\])/iu.test(problemText)
  ) {
    return true;
  }
  return (
    /Galois/iu.test(problemText) &&
    /(扩张次数|degree\s+of|次数)/iu.test(problemText)
  );
}

function circleLaplacianWording(problemText: string): boolean {
  return (
    /(单位圆|圆周|圆上|unit\s+circle|\bcircle\b|S\^?1)/iu.test(problemText) &&
    /(Laplacian|Laplace|拉普拉斯|调和)/iu.test(problemText)
  );
}

function planarLaplacianWording(problemText: string): boolean {
  return (
    /(平面|欧几里得|二维|Euclidean|planar|R\^?2)/iu.test(problemText) &&
    /(Laplacian|Laplace|拉普拉斯)/iu.test(problemText)
  );
}

/**
 * Deterministic semantic tool routing. The first matching family wins; no
 * item index, reference answer or hidden data participates. The returned
 * skeleton is advisory text only: the model still supplies every argument and
 * the trusted tool implementation validates them.
 */
export function semanticToolRoute(problemText: string): SemanticToolRoute | null {
  if (finiteGroupStructureWording(problemText)) return GROUP_STRUCTURE_ROUTE;
  if (finiteCountingWording(problemText)) return FINITE_ENUMERATION_ROUTE;
  if (realRootCountWording(problemText)) return REAL_ROOT_COUNT_ROUTE;
  if (splittingFieldDegreeWording(problemText)) return SPLITTING_FIELD_DEGREE_ROUTE;
  if (circleLaplacianWording(problemText)) return CIRCLE_LAPLACIAN_ROUTE;
  if (planarLaplacianWording(problemText)) return PLANAR_LAPLACIAN_ROUTE;
  if (interpolationFitWording(problemText)) return INTERPOLATION_FIT_ROUTE;
  if (statsOlsWording(problemText)) return STATS_OLS_ROUTE;
  if (
    /(亚历山大|Alexander|特征多项式|characteristic\s+polynomial|子式|\bminor\b)/iu.test(
      problemText,
    )
  ) {
    return EXACT_MAXIMAL_MINORS_ROUTE;
  }
  if (/(分裂域|Galois|splitting\s+field|不可约|扩域)/iu.test(problemText)) {
    return EXACT_FACTOR_OVER_EXTENSION_ROUTE;
  }
  if (/(CDF|累积分布|分布函数|密度|density)/iu.test(problemText)) {
    return EXACT_DENSITY_CHECK_ROUTE;
  }
  if (/(分离变量|偏微分|PDE|u_t|u_xx|边界条件|初值)/iu.test(problemText)) {
    return EXACT_TRIG_REDUCE_ROUTE;
  }
  if (exactLimitWording(problemText)) {
    return EXACT_LIMIT_ROUTE;
  }
  if (polynomialExpandWording(problemText)) {
    return POLYNOMIAL_EXPAND_COEFFICIENTS_ROUTE;
  }
  if (linearSystemWording(problemText)) {
    return LINEAR_SYSTEM_SOLUTION_SET_ROUTE;
  }
  return null;
}
/**
 * Static semantic trigger table for soft method routing. Keys are the card's
 * own `objects`/`structures` tokens; values are wording that names that token
 * in Chinese or English. This table is data only: it never reads a method body,
 * an item index, a reference answer or any hidden per-item table.
 */
const METHOD_ROUTING_TRIGGERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // objects
  equation: ["方程", "等式", "equation"],
  rational_expression: ["有理式", "分式", "rational expression", "rational function"],
  radical: ["根式", "平方根", "radical", "square root"],
  parameter: ["参数", "parameter", "parametric"],
  statement: ["命题", "陈述", "statement"],
  set: ["集合", "set"],
  function: ["函数", "function"],
  sequence: ["数列", "序列", "sequence"],
  configuration: ["构型", "配置", "configuration"],
  game: ["博弈", "游戏", "game"],
  integer: ["整数", "integer"],
  graph: ["图论", "graph"],
  recursive_object: ["递归对象", "递归", "recursive", "recursion"],
  finite_state: ["有限状态", "状态机", "finite state", "state machine"],
  combinatorial_object: ["组合对象", "排列", "组合", "combinatorial", "permutation"],
  sample_space: ["样本空间", "sample space"],
  polynomial: ["多项式", "polynomial"],
  formal_series: ["形式幂级数", "形式级数", "formal series", "formal power series"],
  congruence: ["同余", "congruence", "modulo"],
  integral: ["积分", "integral"],
  region: ["区域", "region", "domain of integration"],
  point: ["点", "point"],
  line: ["直线", "line"],
  plane: ["平面", "plane"],
  curve: ["曲线", "curve"],
  geometric_configuration: ["几何构型", "几何配置", "geometric configuration"],
  inequality: ["不等式", "inequality"],
  feasible_set: ["可行域", "可行集", "feasible set"],
  matrix: ["矩阵", "行列式", "matrix", "matrices", "determinant"],
  linear_system: ["线性方程组", "方程组", "linear system", "system of linear equations"],
  linear_map: ["线性映射", "线性变换", "linear map", "linear transformation"],
  quadratic_form: ["二次型", "quadratic form"],
  random_variable: ["随机变量", "random variable"],
  event: ["事件", "event"],
  distribution: ["分布", "密度", "density", "distribution"],
  differential_equation: [
    "微分方程",
    "偏微分",
    "PDE",
    "ODE",
    "differential equation",
    "boundary condition",
    "边界条件",
  ],
  operator: ["算子", "operator"],
  series: ["级数", "series"],
  physical_model: ["物理模型", "physical model"],
  group: ["群", "同态", "homomorphism", "group"],
  ring: ["环论", "环同态", "ring"],
  field: ["域论", "有限域", "域扩张", "field"],
  metric_space: ["度量空间", "metric space"],
  topological_space: ["拓扑空间", "拓扑", "topological space", "topology"],
  map: ["映射", "map"],
  sample: ["样本", "sample"],
  likelihood: ["似然", "likelihood"],
  regression: ["回归", "regression"],
  design_matrix: ["设计矩阵", "design matrix"],
  response: ["响应变量", "response variable", "response"],
  error: ["误差", "error"],
  algorithm: ["算法", "algorithm"],

  // structures
  domain: ["定义域", "domain"],
  equivalence: ["等价", "equivalence", "equivalent"],
  degeneracy: ["退化", "degenerate", "degeneracy"],
  quantifier: ["量词", "quantifier", "forall", "exists"],
  necessity: ["必要性", "necessary"],
  sufficiency: ["充分性", "sufficient"],
  counterexample: ["反例", "counterexample"],
  invariant: ["不变量", "invariant"],
  parity: ["奇偶", "parity"],
  potential: ["势函数", "势能", "potential"],
  extremal: ["极端原理", "极值", "extremal"],
  induction: ["归纳", "induction"],
  recurrence: ["递推", "recurrence", "recursive"],
  well_founded: ["良基", "well-founded", "well founded"],
  dynamic_programming: ["动态规划", "dynamic programming"],
  automaton: ["自动机", "automaton"],
  residue_tracking: ["模状态", "剩余类", "residue"],
  bijection: ["双射", "一一对应", "bijection"],
  double_counting: ["双计数", "double counting"],
  inclusion_exclusion: ["容斥", "inclusion-exclusion", "inclusion exclusion"],
  generating_function: ["生成函数", "generating function"],
  convolution: ["卷积", "convolution"],
  modular_constraints: ["同余约束", "modular constraint", "modular"],
  prime_power: ["素数幂", "prime power"],
  symmetry: ["对称", "symmetry", "symmetric"],
  substitution: ["换元", "代换", "substitution"],
  improper_integral: ["反常积分", "广义积分", "improper integral"],
  coordinates: ["坐标", "coordinates"],
  metric: ["度量", "metric"],
  incidence: ["关联", "incidence"],
  convexity: ["凸性", "凸函数", "convex"],
  monotonicity: ["单调", "monotonic"],
  bound: ["界", "bound", "upper bound", "lower bound"],
  equality_case: ["等号成立", "取等", "equality case"],
  rank: ["秩", "rank"],
  nullspace: ["零空间", "核空间", "nullspace", "kernel"],
  eigenvalue: ["特征值", "本征值", "eigenvalue"],
  change_of_basis: ["基变换", "换基", "change of basis"],
  conditional_probability: ["条件概率", "conditional probability"],
  indicator: ["指示函数", "示性函数", "indicator"],
  coupling: ["耦合", "coupling"],
  independence: ["独立", "independence", "independent"],
  convergence: ["收敛", "convergence", "converge"],
  domination: ["控制收敛", "domination", "dominated"],
  uniform_integrability: ["一致可积", "uniform integrability"],
  limit_distribution: ["极限分布", "limit distribution"],
  initial_value: ["初值", "初始条件", "initial value", "initial condition"],
  boundary_value: ["边值", "边界条件", "boundary value", "boundary condition"],
  separation: ["分离变量", "separation of variables"],
  linearization: ["线性化", "linearization", "linearize"],
  homomorphism: ["同态", "homomorphism"],
  quotient: ["商群", "商环", "商", "quotient"],
  factorization: ["因式分解", "分解", "factorization", "factor"],
  extension: ["扩域", "域扩张", "extension"],
  compactness: ["紧致", "compactness", "compact"],
  completeness: ["完备", "completeness", "complete"],
  basis: ["基底", "基", "basis"],
  local_global: ["局部与整体", "局部-整体", "local and global", "local-global"],
  confidence_interval: ["置信区间", "confidence interval"],
  hypothesis_test: ["假设检验", "hypothesis test"],
  sufficiency_statistic: ["充分统计量", "sufficient statistic"],
  fisher_information: ["费舍尔信息", "Fisher information"],
  least_squares: ["最小二乘", "least squares"],
  regularization: ["正则化", "regularization"],
  collinearity: ["共线性", "collinearity"],
  heteroskedasticity: ["异方差", "heteroskedasticity"],
  error_bound: ["误差界", "误差估计", "error bound"],
  conditioning: ["条件数", "病态", "conditioning", "condition number"],
  discretization: ["离散化", "discretization"],
  interpolation: ["插值", "interpolation"],
});

const MAX_METHOD_ROUTE_CANDIDATES = 3;
const ASCII_TRIGGER = /^[\x00-\x7f]+$/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function triggerMatches(problemText: string, trigger: string): boolean {
  const needle = trigger.toLocaleLowerCase("en-US");
  if (!ASCII_TRIGGER.test(needle)) {
    return problemText.includes(needle);
  }
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?=$|[^a-z0-9])`, "u").test(
    problemText,
  );
}

function triggersForToken(token: string): readonly string[] {
  const out = [...(METHOD_ROUTING_TRIGGERS[token] ?? [])];
  if (!out.includes(token)) {
    out.push(token);
  }
  const spaced = token.replace(/_/gu, " ");
  if (spaced !== token && !out.includes(spaced)) {
    out.push(spaced);
  }
  return out;
}

function routingScore(problemText: string, entry: P2MethodEntry): number {
  const tokens = new Set<string>();
  for (const value of [entry.objects, entry.structures]) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const token of value) {
      if (typeof token === "string" && token.length > 0) {
        tokens.add(token);
      }
    }
  }
  let score = 0;
  for (const token of tokens) {
    if (triggersForToken(token).some((trigger) => triggerMatches(problemText, trigger))) {
      score += 1;
    }
  }
  return score;
}

/**
 * Deterministic soft method routing over catalog metadata only. Each card is
 * scored by how many of its own `objects`/`structures` tokens overlap the
 * static semantic trigger table. Ties break on the card id (ascending), so the
 * result is independent of entry order. At most three ids are returned; a card
 * id absent from `entries` can never be returned.
 */
export function semanticMethodRoute(
  problemText: string,
  entries: readonly P2MethodEntry[],
): readonly string[] {
  if (typeof problemText !== "string" || problemText.length === 0 || !Array.isArray(entries)) {
    return [];
  }
  const lowered = problemText.toLocaleLowerCase("en-US");
  const scores = new Map<string, number>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || typeof entry.id !== "string") {
      continue;
    }
    const score = routingScore(lowered, entry);
    if (score <= 0) {
      continue;
    }
    scores.set(entry.id, Math.max(scores.get(entry.id) ?? 0, score));
  }
  return Object.freeze(
    [...scores.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, MAX_METHOD_ROUTE_CANDIDATES)
      .map(([id]) => id),
  );
}
