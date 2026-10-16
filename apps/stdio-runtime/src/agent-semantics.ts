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

function tokenize(source: string): string[] | null {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === " ") {
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
      if (exponent === null || !/^[0-9]+$/.test(exponent)) {
        return null;
      }
      return polyPow(base, Number(exponent));
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
      return new Map([["", Number(token)]]);
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
    if (!Number.isInteger(value)) {
      return null;
    }
    const e = parts.get(variable) ?? 0;
    rows.push({ e, c: value });
    if (e > degree) {
      degree = e;
    }
  }
  const out: bigint[] = new Array(degree + 1).fill(0n);
  for (const row of rows) {
    out[row.e] = (out[row.e] as bigint) + BigInt(row.c);
  }
  return out;
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
