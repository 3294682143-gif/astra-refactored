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

import { MATH_ASSET_BY_ID, type P2MethodEntry } from "@astra/protocol";

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

const SOLVE_QUADRATIC_DIOPHANTINE_ROUTE: SemanticToolRoute = Object.freeze({
  id: "SOLVE_QUADRATIC_DIOPHANTINE",
  toolName: "solve_quadratic_diophantine",
  operation: "SOLVE_QUADRATIC_DIOPHANTINE",
  argsTemplate:
    '{"a":<integer>,"b":<integer>,"c":<integer>,"d":<integer>,"e":<integer>,"f":<integer>,"y_bound":<positive integer>}',
});

const SYMBOLIC_DIOPHANTINE_ROUTE: SemanticToolRoute = Object.freeze({
  id: "SYMBOLIC_DIOPHANTINE",
  toolName: "symbolic_diophantine_with_timeout",
  operation: "SYMBOLIC_DIOPHANTINE",
  argsTemplate:
    '{"lhs":"<quadratic polynomial>","rhs":"<quadratic polynomial>","variables":["x","y"],"timeout_ms":<positive integer>}',
});

const SYSTEM_OF_EXPRESSIONS_ROUTE: SemanticToolRoute = Object.freeze({
  id: "SYSTEM_OF_EXPRESSIONS",
  toolName: "solve_system_guarded_expr",
  operation: "SYSTEM_OF_EXPRESSIONS",
  argsTemplate:
    '{"expressions":["<polynomial expression>"],"variables":["x","y"],"timeout_ms":<positive integer>,"n_starts":<positive integer>,"seed":<integer>}',
});

const POLYNOMIAL_FUNCTION_CHECK_ROUTE: SemanticToolRoute = Object.freeze({
  id: "POLYNOMIAL_FUNCTION_CHECK",
  toolName: "polynomial_function_check",
  operation: "POLYNOMIAL_FUNCTION_CHECK",
  argsTemplate:
    '{"equation":"<functional equality>","function":"<unary function name>","argument":"<variable name>","variables":["<variable name>"],"expression":"<candidate rational polynomial>"}',
});

const GF2_RANK_ROUTE: SemanticToolRoute = Object.freeze({
  id: "GF2_RANK",
  toolName: "gf2_rank",
  operation: "GF2_RANK",
  argsTemplate: '{"rows":[<nonnegative integer bit rows>]}',
});

const GF2_NULLSPACE_ROUTE: SemanticToolRoute = Object.freeze({
  id: "GF2_NULLSPACE",
  toolName: "gf2_nullspace",
  operation: "GF2_NULLSPACE",
  argsTemplate:
    '{"rows":[<nonnegative integer bit rows>],"width":<integer 1..8>}',
});

const TRANSITION_COUNT_ROUTE: SemanticToolRoute = Object.freeze({
  id: "TRANSITION_COUNT",
  toolName: "transition_count",
  operation: "TRANSITION_COUNT",
  argsTemplate:
    '{"length":3,"num_states":2,"transitions":[[0,1],[1,0],[1,1]]}',
});

const INDEPENDENCE_POLYNOMIAL_CHAIN_ROUTE: SemanticToolRoute = Object.freeze({
  id: "INDEPENDENCE_POLYNOMIAL_CHAIN",
  toolName: "independence_polynomial_chain",
  operation: "INDEPENDENCE_POLYNOMIAL_CHAIN",
  argsTemplate: '{"n":5}',
});

const COUNT_BY_DIGIT_PROPERTY_ROUTE: SemanticToolRoute = Object.freeze({
  id: "COUNT_BY_DIGIT_PROPERTY",
  toolName: "count_by_digit_property",
  operation: "COUNT_BY_DIGIT_PROPERTY",
  argsTemplate:
    '{"digit_set":[1,2,3],"max_digits":3,"modulus":3,"residue":0,"include_zero":false}',
});

const ROOK_NUMBERS_ROUTE: SemanticToolRoute = Object.freeze({
  id: "ROOK_NUMBERS",
  toolName: "rook_numbers",
  operation: "ROOK_NUMBERS",
  argsTemplate: '{"n":3,"forbidden":[[0,0],[1,1],[2,2]]}',
});

const COUNT_AVOIDING_PERMUTATIONS_ROUTE: SemanticToolRoute = Object.freeze({
  id: "COUNT_AVOIDING_PERMUTATIONS",
  toolName: "count_avoiding_permutations",
  operation: "COUNT_AVOIDING_PERMUTATIONS",
  argsTemplate: '{"n":4,"forbidden":[[0,0],[1,1],[2,2],[3,3]]}',
});

const MARKOV_EXPECTED_STEPS_ROUTE: SemanticToolRoute = Object.freeze({
  id: "MARKOV_EXPECTED_STEPS",
  toolName: "markov_expected_steps",
  operation: "MARKOV_EXPECTED_STEPS",
  argsTemplate:
    '{"transition":[[0.0,1.0,0.0],[0.5,0.0,0.5],[0.0,0.0,1.0]],"start":0,"targets":[2]}',
});

const COVER_TIME_COMPLETE_GRAPH_ROUTE: SemanticToolRoute = Object.freeze({
  id: "COVER_TIME_COMPLETE_GRAPH",
  toolName: "cover_time_complete_graph",
  operation: "COVER_TIME_COMPLETE_GRAPH",
  argsTemplate: '{"num_vertices":4}',
});

const FINITE_DIFFERENCE_DERIVATIVE_ROUTE: SemanticToolRoute = Object.freeze({
  id: "FINITE_DIFFERENCE_DERIVATIVE",
  toolName: "finite_difference_derivative",
  operation: "FINITE_DIFFERENCE_DERIVATIVE",
  argsTemplate: '{"f":"x**3","x":1.0,"h":0.01,"method":"central"}',
});

const RICHARDSON_EXTRAPOLATE_ROUTE: SemanticToolRoute = Object.freeze({
  id: "RICHARDSON_EXTRAPOLATE",
  toolName: "richardson_extrapolate",
  operation: "RICHARDSON_EXTRAPOLATE",
  argsTemplate:
    '{"f":"x**3","x":1.0,"h":0.01,"method":"central","order":2}',
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
const EXACT_DEFINITE_INTEGRAL_ROUTE = exactRoute(
  "DEFINITE_INTEGRAL",
  '{"operation":"DEFINITE_INTEGRAL","expression":"<integrand>","variable":"x","lower":"<lower bound>","upper":"<upper bound>"}',
);
const EXACT_SIMPLIFY_ROUTE = exactRoute(
  "SIMPLIFY",
  '{"operation":"SIMPLIFY","expression":"<expression>","variable":"x"}',
);

function continuousProbabilityWording(problemText: string): boolean {
  return /(连续型?随机变量|连续随机变量|连续分布|概率密度|密度函数|\bdensity\b|累积分布|分布函数|\bCDF\b|\bPDF\b|continuous\s+(?:random\s+variable|distribution)|正态分布|normal\s+distribution|指数分布|exponential\s+distribution|均匀分布\s*(?:U\s*)?[\[(]?\s*[0-9]|\[[^\]\n]{1,20}\]\s*(?:上的?)?\s*均匀分布|\bU\s*\(\s*[0-9]|\buniform\s+distribution[^\n。；;]{0,24}[\[(]\s*[0-9])/iu.test(
    problemText,
  );
}

/**
 * Phase-3 finite-state/transition wording. The state-transition family needs
 * both an explicit transition/graph context and a state-count or length/step
 * phrase; random-walk and Markov items keep their own more specific family.
 */
function transitionCountWording(problemText: string): boolean {
  const transitionContext =
    /(状态转移|转移图|(?:有向图|directed\s+graph)[^\n。；;]{0,24}(?:顶点序列|vertex\s+sequences?)|transition\s+graph|state\s+transitions?|\btransitions?\b)/iu.test(
      problemText,
    );
  if (!transitionContext) {
    return false;
  }
  if (
    /(马尔可夫|Markov|转移概率矩阵|transition\s+probability\s+matrix|随机游走|random\s+walk|覆盖时间|cover\s+time)/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  return /(?:状态数|状态个数|\b[0-9]+\s*个状态|\b[0-9]+\s+states\b|\bnum(?:ber)?\s+of\s+states\b|步数|步长|长度|长为|\blength\b|\bsteps?\b)/iu.test(
    problemText,
  );
}

/** Independent-set coefficients of the explicit path P_n. */
function independencePolynomialChainWording(problemText: string): boolean {
  if (/(独立集多项式|independence\s+polynomial)/iu.test(problemText)) {
    return true;
  }
  const pathContext =
    /(?:路图|路径图|path\s+(?:graph|P\s*_?\s*\{?\s*n\s*\}?)|P\s*_?\s*\{?\s*n\s*\}?)/iu.test(
      problemText,
    );
  if (pathContext && /(?:独立集|independent\s+sets?)/iu.test(problemText)) {
    return true;
  }
  return /(?:不相邻顶点[^\n。；;]{0,12}子集|non[- ]?adjacent\s+vertex\s+subsets?)/iu.test(
    problemText,
  );
}

/** Decimal digit-set / digit-DP property counting. */
function countByDigitPropertyWording(problemText: string): boolean {
  return /(十进制数位|数位\s*DP|digit\s*DP|digit\s+property|数字集合[^\n。；;]{0,20}组成|(?:各位|每个)数字[^\n。；;]{0,24}(?:属于|来自|在)[^\n。；;]{0,24}集合[^\n。；;]{0,24}(?:整除|倍数)|digits?[^\n。；;]{0,24}(?:from|belong)[^\n。；;]{0,24}(?:set|collection)[^\n。；;]{0,32}(?:divisible|multiple))/iu.test(
    problemText,
  );
}

/** Rook polynomial / rook numbers on an explicit forbidden board. */
function rookNumbersWording(problemText: string): boolean {
  return /(车多项式|禁位棋盘[^\n。；;]{0,20}(?:车数|车多项式)|rook\s+polynomial|rook\s+numbers?)/iu.test(
    problemText,
  );
}

/** Permutations avoiding an explicit forbidden-cell/position set. */
function countAvoidingPermutationsWording(problemText: string): boolean {
  return /(错排|禁位排列|禁止位置[^\n。；;]{0,16}排列|permutations?\s+avoiding[^\n。；;]{0,24}(?:forbidden|cells?)|derangements?|forbidden\s+(?:positions?|cells?)[^\n。；;]{0,24}permutations?)/iu.test(
    problemText,
  );
}

/** A Markov-chain hitting/absorption expectation, not a stationary law. */
function markovExpectedStepsWording(problemText: string): boolean {
  const markovContext =
    /(马尔可夫链|马尔可夫|Markov\s+chain|转移概率矩阵|transition\s+probability\s+matrix)/iu.test(
      problemText,
    );
  if (!markovContext) {
    return false;
  }
  return /(期望[^\n。；;]{0,8}步数|期望步数|首次击中时间|击中时间|吸收时间|expected\s+(?:number\s+of\s+)?steps?|hitting\s+time|absorption\s+time)/iu.test(
    problemText,
  );
}

/** Cover time of the uniform no-self-loop walk on the complete graph K_n. */
function coverTimeCompleteGraphWording(problemText: string): boolean {
  const completeGraph =
    /(完全图|complete\s+graph|(?<![A-Za-z0-9])K\s*_?\s*(?:\{?\s*n\s*\}?|[0-9]+)(?![A-Za-z0-9]))/iu.test(
      problemText,
    );
  if (!completeGraph) {
    return false;
  }
  return /(覆盖时间|访问(?:所有|全部)顶点[^\n。；;]{0,24}(?:期望|平均)[^\n。；;]{0,12}(?:步数|步|时间)|访问(?:所有|全部)顶点[^\n。；;]{0,16}(?:需要|要)[^\n。；;]{0,8}(?:多少|几)步|cover\s+time|expected\s+(?:number\s+of\s+)?steps?[^\n。；;]{0,32}(?:visit|cover)\s+all\s+vertices|time\s+to\s+visit\s+all\s+vertices)/iu.test(
    problemText,
  );
}

/** Plain finite-difference derivative at an explicit step, never Richardson. */
function finiteDifferenceDerivativeWording(problemText: string): boolean {
  if (/(Richardson|理查森|外推|extrapolat)/iu.test(problemText)) {
    return false;
  }
  return /(有限差分|中心差分|向前差分|向后差分|前向差分|finite[-\s]+difference(?:\s+derivative)?|central\s+difference|forward\s+difference|backward\s+difference)/iu.test(
    problemText,
  );
}

/** Explicit Richardson extrapolation wording. */
function richardsonExtrapolateWording(problemText: string): boolean {
  return /(?:Richardson\s*(?:外推|extrapolat\w*)|理查森外推)/iu.test(problemText);
}

function finiteCountingWording(problemText: string): boolean {
  // Phase-3 families are appended after the seventeen existing routes, so the
  // broad finite-enumeration family must yield to their explicit wording.
  if (
    transitionCountWording(problemText) ||
    independencePolynomialChainWording(problemText) ||
    countByDigitPropertyWording(problemText) ||
    rookNumbersWording(problemText) ||
    countAvoidingPermutationsWording(problemText) ||
    markovExpectedStepsWording(problemText) ||
    coverTimeCompleteGraphWording(problemText) ||
    finiteDifferenceDerivativeWording(problemText) ||
    richardsonExtrapolateWording(problemText)
  ) {
    return false;
  }
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

/**
 * Shared marker for definition/meaning wording. Each caller decides whether a
 * simultaneous explicit computation request overrides it; definition-only
 * prose must not be routed to a numeric tool.
 */
function conceptualDefinitionWording(problemText: string): boolean {
  return /(?:的定义|定义是|定义为何|概念|含义|意义|什么是|何为|基本思想|基本原理|基本假设|\bwhat\s+is\b|\bdefinition\b|\bdefine\b)/iu.test(
    problemText,
  );
}

function polynomialExpandWording(problemText: string): boolean {
  // Rook and path-independence polynomials expose coefficients, but their
  // finite combinatorial families own those requests.
  if (rookNumbersWording(problemText) || independencePolynomialChainWording(problemText)) {
    return false;
  }
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
  // Taylor/Maclaurin requests are coefficient-expansion requests only when
  // the wording asks for an expansion, a series or a coefficient. A mention of
  // the theorem alone (definition, remainder, convergence radius) is not one.
  const taylorMaclaurin =
    /(?:泰勒|麦克劳林|\bTaylor\b|\bMaclaurin\b)/iu.test(problemText);
  const taylorExpansionAction =
    /(?:展开|展开式|级数|多项式|系数|\b(?:expand(?:ed|ing|s)?|series|coefficients?)\b|(?:[x-z]|t)\s*\^\s*\{?\s*[0-9]|[0-9]+\s*(?:次|阶)?\s*项|(?:到|至|前)\s*[^\n。；;]{0,12}\s*项)/iu.test(
      problemText,
    );
  if (
    taylorMaclaurin &&
    taylorExpansionAction &&
    !/(?:定义|概念|含义|意义|收敛半径|收敛域|余项|定理|证明|不等式)/iu.test(
      problemText,
    )
  ) {
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
  if (conceptualDefinitionWording(problemText)) {
    return false;
  }
  return /(插值|拉格朗日|Lagrange|牛顿插值|Newton\s+interpolation|过这些点的多项式|\binterpolat(?:e|ed|es|ing|ion)\b)/iu.test(
    problemText,
  );
}

function statsOlsWording(problemText: string): boolean {
  if (conceptualDefinitionWording(problemText)) {
    return false;
  }
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
    /(?<![A-Za-z0-9_])(?:S_?[34]|A_?[45]|D_?(?:8|10)|[ZC]_?(?:[2-9]|1[0-2])|K_?\{?\s*4\s*\}?|V_?\{?\s*4\s*\}?|Q_?\{?\s*8\s*\}?)(?![A-Za-z0-9_])|(?:Klein\s*(?:四元群|four[-\s]+group)|克莱因(?:四元群|群)|四元数群|quaternion\s+group)/iu.test(
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
  return /(共轭类|conjugacy\s+class(?:es)?|置换群|permutation\s+group|元素的?阶|element\s+orders?|群的?阶|order\s+of\s+(?:the\s+)?group|交换|阿贝尔|Abel|\babelian\b|\bcommutative\b|循环|cyclic|中心|cent(?:er|re)|生成子群|subgroup\s+generated\s+by|generated\s+subgroup|子群|subgroup|由[^\n。；;]{0,60}生成的?(?:子群|群)|子群[^\n。；;]{0,20}生成|结构|structure|同构|isomorphic|阶)/iu.test(
    problemText,
  );
}

function integerSolutionWording(problemText: string): boolean {
  return /(整数解|整数点|整数对|integer\s+solutions?|integer\s+pairs?|integer\s+points?)/iu.test(
    problemText,
  );
}

/**
 * A finite two-variable quadratic Diophantine observation. The route needs an
 * explicitly integral/Diophantine request and a quadratic form; a generic
 * "solve for x" equation, a one-variable integer root, or continuous
 * optimisation is not this family. Symbolic/system wording is left to the
 * higher symbolic-search family.
 */
function quadraticDiophantineWording(problemText: string): boolean {
  const diophantineContext =
    /(丢番图|\bdiophantine\b|pell\s*(?:型|type|equation)|佩尔(?:型|方程)?)/iu.test(
      problemText,
    );
  if (!diophantineContext && !integerSolutionWording(problemText)) {
    return false;
  }
  if (
    /(符号|symbolic|不定方程|indeterminate\s+equations?|整数解集|integer\s+solution\s+set|方程组|system\s+of\s+(?:nonlinear\s+|polynomial\s+)?equations?|polynomial\s+(?:equation\s+)?system|polynomial\s+equations?|非线性|nonlinear)/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  const squaredVariables = new Set(
    [...problemText.matchAll(/(?<![a-zA-Z])([a-zA-Z])\s*(?:\^\s*\{?\s*2\b|²)/giu)].map((match) =>
      (match[1] as string).toLocaleLowerCase("en-US"),
    ),
  );
  const twoVariableQuadratic =
    squaredVariables.size >= 2 ||
    /(?:二次型|二元二次|two[- ]variable\s+quadratic)/iu.test(problemText) ||
    /\b[a-zA-Z]\s*[a-zA-Z]\b/u.test(problemText);
  if (!twoVariableQuadratic) {
    return false;
  }
  return /(?:二次|quadratic|二次型|\b[a-zA-Z]\s*(?:\^\s*\{?\s*2\b|²))/iu.test(problemText);
}

/**
 * A symbolic Diophantine search is explicitly named (symbolic/indefinite
 * equation/integer solution set, or a polynomial system with integer output).
 * An ordinary quadratic equation with integer solutions is not enough.
 */
function symbolicDiophantineWording(problemText: string): boolean {
  const symbolicContext =
    /(?:(?:符号|symbolic)[^\n。；;]{0,32}(?:丢番图|diophantine|整数解|integer\s+solutions?|多项式方程组|polynomial\s+(?:equation\s+)?system|方程组|system\s+of\s+equations?)|不定方程|indeterminate\s+equations?|symbolic\s+(?:diophantine|search|solver))/iu.test(
      problemText,
    );
  const integerSolutionSet =
    /(?:整数解集|integer\s+solution\s+set)/iu.test(problemText) &&
    /(?:丢番图|diophantine|多项式方程组|polynomial\s+(?:equation\s+)?system|system\s+of\s+polynomial\s+equations?|不定方程|indeterminate|符号|symbolic)/iu.test(
      problemText,
    );
  const polynomialSystemWithIntegers =
    /(?:多项式方程组|polynomial\s+(?:equation\s+)?system|system\s+of\s+polynomial\s+equations?)[^\n。；;]{0,40}(?:整数解|符号|symbolic|integer\s+solutions?)/iu.test(
      problemText,
    );
  if (symbolicContext) {
    return true;
  }
  if (!integerSolutionSet && !polynomialSystemWithIntegers) {
    return false;
  }
  return /(求解|求|解出|找出|搜索|\bsolve\b|\bfind\b|\bcompute\b|\bsearch\b)/iu.test(
    problemText,
  );
}

/**
 * A non-linear or polynomial system of equations. A purely linear system stays
 * with `LINEAR_SYSTEM_SOLUTION_SET`, while integer/symbolic search wording
 * stays with the symbolic Diophantine family.
 */
function systemOfExpressionsWording(problemText: string): boolean {
  const systemContext =
    /(方程组|联立[^\n。；;]{0,24}方程|(?:非线性|多项式|混合(?:的)?)[^\n。；;]{0,8}系统|\bsystem\s+of\s+(?:nonlinear\s+|polynomial\s+)?equations?\b|\b(?:nonlinear|polynomial)\s+systems?\s+of\s+equations?\b|\bpolynomial\s+system\b|\bsimultaneous\s+(?:nonlinear\s+|polynomial\s+)?equations?\b)/iu.test(
      problemText,
    );
  if (!systemContext) {
    return false;
  }
  const nonLinearOrPolynomial =
    /(非线性|nonlinear|多项式方程组|polynomial\s+(?:equation\s+)?system|\bsystem\s+of\s+(?:nonlinear|polynomial)\s+equations?\b|\bpolynomial\s+equations?\b|联立多项式|simultaneous\s+polynomial|二次方程组|quadratic\s+system|联立二次方程|quadratic\s+equations?|混合(?:的)?多项式|mixed\s+polynomial)/iu.test(
      problemText,
    );
  if (!nonLinearOrPolynomial) {
    return false;
  }
  return !/(整数解|整数解集|integer\s+solutions?|integer\s+solution\s+set|丢番图|diophantine|不定方程|indeterminate\s+equations?|符号\s*(?:求解|搜索|丢番图)|symbolic\s+(?:solve|search|diophantine))/iu.test(
    problemText,
  );
}

/**
 * Verify one claimed polynomial/functional identity. A plain simplification,
 * expansion or equation-solving request is not an identity check.
 */
function polynomialFunctionCheckWording(problemText: string): boolean {
  const verify =
    /(验证|检验|检查|核验|判断|\bverify\b|\bcheck\b|\bvalidate\b|\bconfirm\b|\bdetermine\s+whether\b)/iu.test(
      problemText,
    );
  const identity =
    /(恒等式|恒等|函数方程|functional\s+equality|functional\s+equation|\bidentity\b|\bequality\s+holds?\b|\bholds?\s+for\s+all\b|\bfor\s+all\b[^\n。；;]{0,40}\bholds?\b)/iu.test(
      problemText,
    );
  const polynomialFunction =
    /(多项式|函数|\bpolynomial\b|\bfunctional\b|\bf\s*\([^)]{0,24}\))/iu.test(
      problemText,
    );
  if (!polynomialFunction) {
    return false;
  }
  if (verify && identity) {
    return true;
  }
  return /(代入[^\n。；;]{0,24}(?:核验|验证|检验)|\bsubstitut(?:e|ion)[^\n。；;]{0,24}\b(?:check|verify|validate))/iu.test(
    problemText,
  );
}

/** GF(2), binary-matrix or mod-2 linear-space wording. */
function gf2LinearSpaceContext(problemText: string): boolean {
  const explicitGF2 =
    /(?:GF\s*[\(\[]?\s*2\s*[\)\]]?|\bF\s*_?\s*2\b|二元\s*(?:矩阵|向量|线性空间)|二进制\s*(?:矩阵|向量|表示)|binary\s+(?:matrix|matrices|vectors?))/iu.test(
      problemText,
    );
  if (explicitGF2) {
    return true;
  }
  return (
    /(?:模|mod(?:ulo)?)\s*2\b/iu.test(problemText) &&
    /(矩阵|向量|线性|空间|秩|零空间|核|null|rank|matrix|vector|kernel)/iu.test(
      problemText,
    )
  );
}

function gf2RankWording(problemText: string): boolean {
  return (
    gf2LinearSpaceContext(problemText) &&
    /(秩|\brank\b|主元|\bpivot\b|极大线性无关组)/iu.test(problemText)
  );
}

function gf2NullspaceWording(problemText: string): boolean {
  return (
    gf2LinearSpaceContext(problemText) &&
    /(零空间|核空间|\bkernel\b|null\s*space|nullspace|解空间|齐次线性方程组|线性相关|linearly\s+dependent)/iu.test(
      problemText,
    )
  );
}

/**
 * A concrete numeric matrix written in LaTeX or in nested-list form. The
 * marker is deliberately narrow: symbolic names such as "matrix A" alone do
 * not provide the numeric data the linear-system tool needs.
 */
function explicitNumericMatrixWording(problemText: string): boolean {
  const latexMatrix =
    /\\begin\s*\{(?:[bpBvV]?matrix|array)\}[\s\S]{0,400}?\\end\s*\{(?:[bpBvV]?matrix|array)\}/u.test(
      problemText,
    );
  const nestedRows = /\[\s*\[[^\]\n]{1,80}\][^\n]{0,200}\]/u.test(problemText);
  const matrixAssignment =
    /(?:矩阵|matrix|(?<![A-Za-z0-9_])[A-Z](?![A-Za-z0-9_]))[^\n。；;]{0,24}[=＝][^\n。；;]{0,16}(?:\\begin\s*\{|\[\[|\\left\s*[\[\(])/u.test(
      problemText,
    );
  return latexMatrix || nestedRows || matrixAssignment;
}

/**
 * A rank/nullity question about an explicit numeric matrix. The linear-system
 * route is reused for these finite linear-algebra observations, while a
 * definitional question or a purely symbolic "matrix A" stays unrouted.
 */
function matrixRankNullityWording(problemText: string): boolean {
  // A mixed determinant-and-rank question needs more than one observation;
  // forcing the linear-system family there would hide the determinant part.
  if (/(行列式|determinant)/iu.test(problemText)) {
    return false;
  }
  const rankNullity =
    /(?:矩阵|matrix|(?<![A-Za-z0-9_])[A-Z](?![A-Za-z0-9_]))[^\n。；;]{0,40}(?:的)?(?:秩|\brank\b|零度|\bnullity\b|零空间|null\s*space|核空间|\bkernel\b|解空间维数)/iu.test(
      problemText,
    ) ||
    /(?:秩|\brank\b|零度|\bnullity\b|零空间|null\s*space|核空间|\bkernel\b)[^\n。；;]{0,20}(?:矩阵|matrix)/iu.test(
      problemText,
    );
  if (!rankNullity || conceptualDefinitionWording(problemText)) {
    return false;
  }
  return explicitNumericMatrixWording(problemText);
}

/** A linear system stated with an explicit numeric coefficient matrix. */
function explicitNumericMatrixSystemWording(problemText: string): boolean {
  if (!explicitNumericMatrixWording(problemText)) {
    return false;
  }
  return (
    /(?:解|求解|求|计算|solve|evaluate)[^\n。；;]{0,32}(?:线性方程组|线性系统|方程组|\blinear\s+system\b|\bsystem\s+of\s+(?:linear\s+)?equations?\b|A\s*[xX]\s*=|\bA\s*[xX]\s*=\s*b\b)/iu.test(
      problemText,
    ) ||
    /(?:线性方程组|线性系统|\blinear\s+system\b|\bsystem\s+of\s+(?:linear\s+)?equations?\b|A\s*[xX]\s*=\s*b)[^\n。；;]{0,32}(?:解|solution|solve)/iu.test(
      problemText,
    )
  );
}

function linearSystemWording(problemText: string): boolean {
  const explicitSystem =
    /(线性方程组|一次方程组|解方程组|求解方程组|联立方程(?:组)?|高斯消元|\bGaussian\s+elimination\b|\bsimultaneous\s+equations?\b|\bsolve\s+the\s+system\b|\bsystem\s+of\s+(?:linear\s+)?equations?\b|\\begin\s*\{cases\})/iu.test(
      problemText,
    ) || explicitNumericMatrixSystemWording(problemText);
  const rankNullity = matrixRankNullityWording(problemText);
  if (!explicitSystem && !rankNullity) {
    return false;
  }
  // A conceptual description of systems/rank is not a solution-set request.
  if ((explicitSystem || rankNullity) && conceptualDefinitionWording(problemText)) {
    return false;
  }
  // Nonlinear/polynomial/symbolic systems and GF(2) linear-space questions
  // have their own families; they must not inherit this rational solution-set
  // route merely because their prose contains "方程组".
  if (
    /(非线性|nonlinear|多项式方程组|polynomial\s+(?:equation\s+)?system|\bsystem\s+of\s+(?:nonlinear|polynomial)\s+equations?\b|联立多项式|simultaneous\s+polynomial|二次方程组|quadratic\s+system|联立二次方程|丢番图|diophantine|不定方程|indeterminate\s+equations?|符号\s*(?:丢番图|求解|搜索)|symbolic\s+(?:diophantine|search|solver))/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  if (
    gf2LinearSpaceContext(problemText) &&
    (rankNullity || gf2RankWording(problemText) || gf2NullspaceWording(problemText))
  ) {
    return false;
  }
  // A differential system is not a finite rational linear system.
  return !(
    /(微分方程组|常微分方程组|differential\s+(?:equation\s+)?system)/iu.test(problemText) &&
    !/(线性方程组|linear\s+system)/iu.test(problemText)
  );
}

function exactLimitWording(problemText: string): boolean {
  // Definition/existence discussions are not value requests. Keep the
  // exclusion narrow (and value-oriented) so an actual `\lim` exercise is not
  // lost merely because its prose mentions a concept word.
  const conceptualLimit =
    /(?:极限|\blimit\b)[^\n。；;]{0,20}(?:的?定义|概念|含义|意义|存在性|是否存在|不存在|唯一性|性质|运算法则|基本思想)|(?:定义|概念|什么是|何为|\bwhat\s+is\b)[^\n。；;]{0,20}(?:极限|\blimit\b)/iu.test(
      problemText,
    );
  const valueRequest =
    /(?:求值|计算|算出|求出|evaluate|compute|calculate|\bvalue\b|值为|的值)/iu.test(
      problemText,
    );
  if (conceptualLimit && !valueRequest) {
    return false;
  }
  if (
    /(?:极限|\\lim(?![A-Za-z])|(?<!\\)\blimits?\b|(?<!\\)\blim\s*_)/iu.test(
      problemText,
    )
  ) {
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

/**
 * A definite-integral request asks for the value of one bounded integral: the
 * wording names a definite integral or carries an integral sign with explicit
 * limits. A limit question keeps the limit family, and a purely qualitative
 * existence/integrability/convergence discussion asks for no value at all, so
 * neither of those is routed here.
 */
function exactDefiniteIntegralWording(problemText: string): boolean {
  // `\lim` items stay LIMIT even when an integral appears inside them.
  if (
    /(?:极限|\\lim(?![A-Za-z])|(?<!\\)\blimits?\b|(?<!\\)\blim\s*_|渐近)/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  const definiteMark = /(定积分|definite\s+integral)/iu.test(problemText);
  const integralSign = /(?:∫|\\int)/u.test(problemText);
  // Standard LaTeX `\\int_{a}^{b}` / `\\int_a^b`, including `\\limits` and a
  // simple nested bound such as `\\frac{0}{1}`. Both scripts are required.
  const integralLimits =
    /(?:∫|\\int)\s*(?:\\limits\s*)?(?:[_^]\s*(?:\{(?:[^{}\n]|\{[^{}\n]{0,48}\}){1,96}\}|[^\s{^_]{1,24})\s*){2}/u.test(
      problemText,
    );
  if (!definiteMark && !(integralSign && integralLimits)) {
    return false;
  }
  if (
    conceptualDefinitionWording(problemText) &&
    !/(求值|计算|算出|求出|evaluate|compute|calculate|\bvalue\b|值为|的值)/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  // A question about convergence, integrability or existence asks no value.
  if (
    /(收敛性|敛散性|是否收敛|是否发散|收敛还是发散|可积性|是否可积|不可积|存在性|是否存在|判断|讨论|证明|convergence|converges?|divergence|diverges?|integrab|exist)/iu.test(
      problemText,
    ) &&
    !/(求值|计算|算出|求出|evaluate|compute|calculate|\bvalue\b|值为|的值)/iu.test(problemText)
  ) {
    return false;
  }
  return true;
}

/**
 * An explicit simplification request reduces one written algebraic expression
 * (a fraction, a radical or an algebraic identity). An explicit expansion or
 * coefficient request keeps the separate expansion route, and solving an
 * equation or counting roots is not a simplification of an expression.
 */
function exactSimplifyWording(problemText: string): boolean {
  if (
    !/(化简|约分|通分|等价化简|\bsimplif(?:y|ies|ied|ying)\b|\breduc(?:e|es|ed|ing)\s+the\s+fraction\b)/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  if (
    /(展开|展开式|乘开|合并同类项|\bexpand(?:ed|ing|s)?\b|\bmultiply\s+out\b|\bcollect(?:ing)?\s+(?:the\s+)?coefficients?\b|系数|\bcoefficients?\b)/iu.test(
      problemText,
    )
  ) {
    return false;
  }
  return !/(?:求|解\s*|solve\s)[^\n。；;]{0,20}(?:方程|等式|equation)|(?:方程|equation)[^\n。；;]{0,16}(?:的)?(?:实根|实数根|根|解)|(?:实根|实数根|零点|\broots?\b|\bzeros?\b)/iu.test(
    problemText,
  );
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
  if (exactDefiniteIntegralWording(problemText)) {
    return EXACT_DEFINITE_INTEGRAL_ROUTE;
  }
  if (exactSimplifyWording(problemText)) {
    return EXACT_SIMPLIFY_ROUTE;
  }
  if (polynomialExpandWording(problemText)) {
    return POLYNOMIAL_EXPAND_COEFFICIENTS_ROUTE;
  }
  if (linearSystemWording(problemText)) {
    return LINEAR_SYSTEM_SOLUTION_SET_ROUTE;
  }
  // Phase-2 families are appended after every existing route, so an existing
  // family never loses priority. Within this block, the more specific
  // Diophantine and GF(2) kernel questions precede their broader neighbours.
  if (quadraticDiophantineWording(problemText)) {
    return SOLVE_QUADRATIC_DIOPHANTINE_ROUTE;
  }
  if (symbolicDiophantineWording(problemText)) {
    return SYMBOLIC_DIOPHANTINE_ROUTE;
  }
  if (systemOfExpressionsWording(problemText)) {
    return SYSTEM_OF_EXPRESSIONS_ROUTE;
  }
  if (polynomialFunctionCheckWording(problemText)) {
    return POLYNOMIAL_FUNCTION_CHECK_ROUTE;
  }
  if (gf2NullspaceWording(problemText)) {
    return GF2_NULLSPACE_ROUTE;
  }
  if (gf2RankWording(problemText)) {
    return GF2_RANK_ROUTE;
  }
  // Phase-3 families are appended after every pre-existing route, so the
  // original seventeen priorities and results stay untouched. Within this
  // block the Markov/random-walk and Richardson exclusions in the shared
  // predicates keep the overlapping families disjoint.
  if (transitionCountWording(problemText)) {
    return TRANSITION_COUNT_ROUTE;
  }
  if (independencePolynomialChainWording(problemText)) {
    return INDEPENDENCE_POLYNOMIAL_CHAIN_ROUTE;
  }
  if (countByDigitPropertyWording(problemText)) {
    return COUNT_BY_DIGIT_PROPERTY_ROUTE;
  }
  if (rookNumbersWording(problemText)) {
    return ROOK_NUMBERS_ROUTE;
  }
  if (countAvoidingPermutationsWording(problemText)) {
    return COUNT_AVOIDING_PERMUTATIONS_ROUTE;
  }
  if (markovExpectedStepsWording(problemText)) {
    return MARKOV_EXPECTED_STEPS_ROUTE;
  }
  if (coverTimeCompleteGraphWording(problemText)) {
    return COVER_TIME_COMPLETE_GRAPH_ROUTE;
  }
  if (finiteDifferenceDerivativeWording(problemText)) {
    return FINITE_DIFFERENCE_DERIVATIVE_ROUTE;
  }
  if (richardsonExtrapolateWording(problemText)) {
    return RICHARDSON_EXTRAPOLATE_ROUTE;
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

/**
 * Tool route -> the `general_v11` method card that owns that family. The two
 * routers are fused through this table only: a card id here is a catalog id,
 * never an item index, answer or hidden table.
 */
const TOOL_ROUTE_PREFERRED_METHOD: Readonly<Record<string, string>> = Object.freeze({
  GROUP_STRUCTURE: "algebraic-structures",
  SPLITTING_FIELD_DEGREE: "algebraic-structures",
  EXACT_FACTOR_OVER_EXTENSION: "algebraic-structures",
  REAL_ROOT_COUNT: "domain-equivalence",
  LINEAR_SYSTEM_SOLUTION_SET: "linearization-spectral",
  EXACT_MAXIMAL_MINORS: "linearization-spectral",
  POLYNOMIAL_EXPAND_COEFFICIENTS: "generating-functions",
  CIRCLE_LAPLACIAN: "differential-equations",
  PLANAR_LAPLACIAN: "differential-equations",
  EXACT_TRIG_REDUCE: "differential-equations",
  EXACT_DEFINITE_INTEGRAL: "integral-symmetry",
  EXACT_LIMIT: "convergence-limits",
  EXACT_DENSITY_CHECK: "conditioning-indicators",
  FINITE_ENUMERATION: "counting-bijections",
  INTERPOLATION_FIT: "numerical-approximation",
  OLS_CHECK: "regression-diagnostics",
  EXACT_SIMPLIFY: "domain-equivalence",
  SOLVE_QUADRATIC_DIOPHANTINE: "modular-crt",
  SYMBOLIC_DIOPHANTINE: "modular-crt",
  SYSTEM_OF_EXPRESSIONS: "domain-equivalence",
  POLYNOMIAL_FUNCTION_CHECK: "domain-equivalence",
  GF2_RANK: "linearization-spectral",
  GF2_NULLSPACE: "linearization-spectral",
  TRANSITION_COUNT: "finite-state-dp",
  INDEPENDENCE_POLYNOMIAL_CHAIN: "finite-state-dp",
  COUNT_BY_DIGIT_PROPERTY: "finite-state-dp",
  ROOK_NUMBERS: "counting-bijections",
  COUNT_AVOIDING_PERMUTATIONS: "counting-bijections",
  MARKOV_EXPECTED_STEPS: "conditioning-indicators",
  COVER_TIME_COMPLETE_GRAPH: "conditioning-indicators",
  FINITE_DIFFERENCE_DERIVATIVE: "numerical-approximation",
  RICHARDSON_EXTRAPOLATE: "numerical-approximation",
});

/**
 * The method card that owns a hit tool route, or null when the route is null or
 * has no registered owner. Pure: it reads the route identity only.
 */
export function preferredMethodForToolRoute(route: SemanticToolRoute | null): string | null {
  if (route === null || typeof route !== "object") {
    return null;
  }
  const id = route.id;
  if (typeof id !== "string") {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(TOOL_ROUTE_PREFERRED_METHOD, id)
    ? TOOL_ROUTE_PREFERRED_METHOD[id]!
    : null;
}

const MAX_METHOD_ROUTE_CANDIDATES = 3;
// Any token score is at most the cardinality of one card's own object/structure
// sets, so a four-digit boost is decisive while the boosted card is still ranked
// by card id against another boosted candidate.
const TOOL_ROUTE_METHOD_BOOST = 1024;
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
 * static semantic trigger table. A hit tool route then gives its owning card a
 * decisive boost, so the card that matches the tool family is ranked first;
 * every other score and the card-id tie-break stay exactly as before. Ties
 * break on the card id (ascending), so the result is independent of entry
 * order. At most three ids are returned; a card id absent from `entries` can
 * never be returned.
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
  const knownIds = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || typeof entry.id !== "string") {
      continue;
    }
    knownIds.add(entry.id);
    const score = routingScore(lowered, entry);
    if (score <= 0) {
      continue;
    }
    scores.set(entry.id, Math.max(scores.get(entry.id) ?? 0, score));
  }
  // Method/tool fusion: when the deterministic tool router hits a family whose
  // owning card is loaded, that card is decisive, so the tool observation and
  // the loaded method text always point at the same mathematical family. When
  // no tool route hits (or its owner is not in this catalog) the scoring and
  // ordering below are exactly the tool-free ones.
  const preferredId = preferredMethodForToolRoute(semanticToolRoute(problemText));
  if (preferredId !== null && knownIds.has(preferredId)) {
    scores.set(preferredId, (scores.get(preferredId) ?? 0) + TOOL_ROUTE_METHOD_BOOST);
  }
  return Object.freeze(
    [...scores.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, MAX_METHOD_ROUTE_CANDIDATES)
      .map(([id]) => id),
  );
}

// ---------------------------------------------------------------------------
// Unified Math Assets Routing (Stage U5)
// ---------------------------------------------------------------------------

export interface SemanticMathAssetRoute {
  readonly id: string;
  readonly assetId: string;
  readonly target: string;
  readonly targetPurpose: string;
  readonly requiredParams: readonly string[];
  readonly optionalParams: readonly string[];
  readonly argsTemplate: string;
}

export const MATH_ASSET_ROUTE_TARGETS: Readonly<Record<string, { readonly assetId: string; readonly target: string }>> = Object.freeze({
  GROUP_STRUCTURE: { assetId: "math.algebraic-structures", target: "group_structure" },
  FINITE_ENUMERATION: { assetId: "math.combinatorics", target: "enumerate" },
  REAL_ROOT_COUNT: { assetId: "math.equations", target: "real_roots" },
  SPLITTING_FIELD_DEGREE: { assetId: "math.algebraic-structures", target: "splitting_field_degree" },
  CIRCLE_LAPLACIAN: { assetId: "math.differential", target: "circle_laplacian" },
  PLANAR_LAPLACIAN: { assetId: "math.differential", target: "planar_laplacian" },
  INTERPOLATION_FIT: { assetId: "math.numerics", target: "interpolation_fit" },
  STATS_OLS: { assetId: "math.regression", target: "ols_check" },
  EXACT_MAXIMAL_MINORS: { assetId: "math.linear-algebra", target: "maximal_minors" },
  EXACT_FACTOR_OVER_EXTENSION: { assetId: "math.algebraic-structures", target: "factor_over_extension" },
  EXACT_DENSITY_CHECK: { assetId: "math.probability", target: "density_check" },
  EXACT_TRIG_REDUCE: { assetId: "math.differential", target: "trig_reduce" },
  EXACT_LIMIT: { assetId: "math.limits", target: "limit" },
  EXACT_DEFINITE_INTEGRAL: { assetId: "math.integration", target: "definite_integral" },
  EXACT_SIMPLIFY: { assetId: "math.equations", target: "simplify" },
  POLYNOMIAL_EXPAND_COEFFICIENTS: { assetId: "math.generating-functions", target: "expand_coefficients" },
  LINEAR_SYSTEM_SOLUTION_SET: { assetId: "math.linear-algebra", target: "solution_set" },
  SOLVE_QUADRATIC_DIOPHANTINE: { assetId: "math.diophantine", target: "quadratic_diophantine" },
  SYMBOLIC_DIOPHANTINE: { assetId: "math.diophantine", target: "symbolic_diophantine" },
  SYSTEM_OF_EXPRESSIONS: { assetId: "math.equations", target: "solve_system" },
  POLYNOMIAL_FUNCTION_CHECK: { assetId: "math.equations", target: "function_identity" },
  GF2_NULLSPACE: { assetId: "math.linear-algebra", target: "gf2_nullspace" },
  GF2_RANK: { assetId: "math.linear-algebra", target: "gf2_rank" },
  TRANSITION_COUNT: { assetId: "math.finite-states", target: "transition_count" },
  INDEPENDENCE_POLYNOMIAL_CHAIN: { assetId: "math.finite-states", target: "independence_polynomial" },
  COUNT_BY_DIGIT_PROPERTY: { assetId: "math.finite-states", target: "digit_property_count" },
  ROOK_NUMBERS: { assetId: "math.combinatorics", target: "rook_numbers" },
  COUNT_AVOIDING_PERMUTATIONS: { assetId: "math.combinatorics", target: "avoiding_permutations" },
  MARKOV_EXPECTED_STEPS: { assetId: "math.probability", target: "markov_expected_steps" },
  COVER_TIME_COMPLETE_GRAPH: { assetId: "math.probability", target: "cover_time" },
  FINITE_DIFFERENCE_DERIVATIVE: { assetId: "math.numerics", target: "finite_difference" },
  RICHARDSON_EXTRAPOLATE: { assetId: "math.numerics", target: "richardson_extrapolate" },
});

export const MATH_ASSET_ROUTE_MAP: Readonly<Record<string, {
  readonly assetId: string;
  readonly target: string;
  readonly targetPurpose: string;
  readonly requiredParams: readonly string[];
  readonly optionalParams: readonly string[];
}>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MATH_ASSET_ROUTE_TARGETS).map(([k, v]) => {
      const asset = MATH_ASSET_BY_ID.get(v.assetId);
      const beh = asset?.behaviors.find((b) => b.target === v.target);
      return [
        k,
        {
          assetId: v.assetId,
          target: v.target,
          targetPurpose: beh?.declaredScope ?? "",
          requiredParams: beh?.requiredParams ?? [],
          optionalParams: beh?.optionalParams ?? [],
        },
      ];
    }),
  ),
);

export function semanticMathAssetRoute(problemText: string): SemanticMathAssetRoute | null {
  const toolRoute = semanticToolRoute(problemText);
  if (!toolRoute) {
    return null;
  }
  const entry = MATH_ASSET_ROUTE_TARGETS[toolRoute.id];
  if (!entry) {
    return null;
  }
  const asset = MATH_ASSET_BY_ID.get(entry.assetId);
  const behavior = asset?.behaviors.find((b) => b.target === entry.target);
  return {
    id: toolRoute.id,
    assetId: entry.assetId,
    target: entry.target,
    targetPurpose: behavior?.declaredScope ?? "",
    requiredParams: behavior?.requiredParams ?? [],
    optionalParams: behavior?.optionalParams ?? [],
    argsTemplate: toolRoute.argsTemplate,
  };
}
