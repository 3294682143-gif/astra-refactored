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
