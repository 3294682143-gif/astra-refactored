"""Canonical answer keys for the Host-side consensus ballot.

The Node Loop used to vote on the raw candidate string, so ``1/2`` and
``\\frac12`` split one correct answer into two one-vote minorities. This module
is the Python mirror of the Node ``canonicalAnswerKey`` helper
(``apps/stdio-runtime/src/agent-answer-key.ts``): it maps one answer text to one
comparable key so two *equal* answers cannot be counted as two ballots.

A key is a comparison token, never a normalized answer. Nothing here decides
whether an answer is correct: no expression is evaluated at a point, no
directory is read and no model is called. Parsing a polynomial into its
coefficient map is a *syntactic* normalisation used only for equality, exactly
as on the Node side.

Contract (mirrors ``canonicalAnswerKey``):

1. trim, strip one leading answer label (``答案``, ``最终答案``,
   ``final answer``), trim again;
2. unwrap at most ONE layer of ``$...$``, ``\\(...\\)``, ``\\[...\\]``,
   ``\\boxed{...}``;
3. lowercase and remove insignificant whitespace;
4. classify the whole answer, in this order:

   * truth token (``正确``/``真``/``true``/``yes``, ``错误``/``假``/``false``/``no``)
     -> ``truth:true`` / ``truth:false``;
   * exact rational literal (``1/2``, ``-0.5``, ``3``, ``\\frac{1}{2}``,
     ``\\frac12``) -> ``rat:n/d`` (reduced, positive denominator);
   * finite numeric set (``{1, 0.5}``) -> ``set:rat:...,rat:...`` sorted;
   * whole-answer option notation (``(A)``, ``A.``, ``A、C``, ``A, C``, ``AC``)
     -> ``options:A,C`` sorted;
   * whole polynomial (``x^2-x``, ``x(x-1)``) -> ``poly:<monomial>=<coefficient>``;
   * otherwise -> ``text:<compact text>``.

Only a whole answer is ever classified. A sentence that merely mentions option
letters, such as ``A、B、C 正确，D 错误``, stays text. A lone uppercase
``A`` is an option answer; a lone lowercase ``a`` stays a mathematical variable.
"""

from __future__ import annotations

import math
import re

from .text_contract import JS_WHITESPACE, js_trim

__all__ = [
    "answer_components",
    "canonical_answer_key",
    "component_agreement_scores",
    "component_value",
]

_EPS = 1e-9
_MAX_TOKENS = 4096
_DIGITS = frozenset("0123456789")
_LETTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
_WORD_CHARS = _LETTERS | _DIGITS | frozenset("_")
_WS_CLASS = "".join(sorted(JS_WHITESPACE))
_WS_RE = re.compile("[" + re.escape(_WS_CLASS) + "]+")

# The Node label set is exactly these three; "Answer:" alone is not a label.
_LABEL = re.compile(r"^(?:最终答案|答案|final\s+answer)\s*[:：]?\s*", re.IGNORECASE)

_DOLLAR_WRAP = re.compile(r"^\$([^$]+)\$$", re.DOTALL)
_PAREN_WRAP = re.compile(r"^\\\((.*)\\\)$", re.DOTALL)
_BRACKET_WRAP = re.compile(r"^\\\[(.*)\\\]$", re.DOTALL)
_BOXED_WRAP = re.compile(r"^\\boxed\{(.*)\}$", re.DOTALL)

_TRUE_TOKENS = frozenset(("正确", "真", "true", "yes"))
_FALSE_TOKENS = frozenset(("错误", "假", "false", "no"))

_FRACTION_LITERAL = re.compile(r"^([+-]?\d+)/([+-]?\d+)$")
_DECIMAL_LITERAL = re.compile(r"^([+-]?)(\d+)\.(\d+)$")
_INTEGER_LITERAL = re.compile(r"^([+-]?\d+)$")
_FRAC_BRACED = re.compile(r"^\\frac\{([+-]?\d+)\}\{([+-]?\d+)\}$")
_FRAC_BARE = re.compile(r"^\\frac([+-]?\d)([+-]?\d)$")

_SET_BODY = re.compile(r"^\{([^{}]*)\}$")
_OPTION_PAREN = re.compile(r"^\(([a-e](?:[,，、;；]?[a-e])*)\)$")
_OPTION_DOTTED = re.compile(r"^([a-e])[.、]$")
_OPTION_RUN = re.compile(r"^([a-e]{2,})$")
_OPTION_LIST = re.compile(r"^([a-e](?:[,，、;；][a-e])+)$")
_OPTION_SINGLE_PAREN = re.compile(r"^\([a-e]\)$")
_OPTION_LETTER = re.compile(r"[a-e]")


# -- wrappers and labels -----------------------------------------------------


def _unwrap_once(text):
    """Remove at most one wrapper layer, exactly like the Node helper."""
    value = js_trim(text)
    for pattern in (_DOLLAR_WRAP, _PAREN_WRAP, _BRACKET_WRAP, _BOXED_WRAP):
        match = pattern.match(value)
        if match is not None:
            return js_trim(match.group(1))
    return value


# -- exact rationals ---------------------------------------------------------


def _gcd(left, right):
    x = left if left >= 0 else -left
    y = right if right >= 0 else -right
    while y:
        x, y = y, x % y
    return x or 1


def _rat_key(numerator, denominator):
    if denominator == 0:
        return None
    if denominator < 0:
        numerator = -numerator
        denominator = -denominator
    factor = _gcd(numerator, denominator)
    return "rat:%d/%d" % (numerator // factor, denominator // factor)


def _rational_token(text):
    match = _FRACTION_LITERAL.match(text)
    if match is not None:
        return _rat_key(int(match.group(1)), int(match.group(2)))
    match = _DECIMAL_LITERAL.match(text)
    if match is not None:
        sign = -1 if match.group(1) == "-" else 1
        fraction = match.group(3)
        denominator = 10 ** len(fraction)
        numerator = int(match.group(2)) * denominator + int(fraction)
        return _rat_key(sign * numerator, denominator)
    match = _INTEGER_LITERAL.match(text)
    if match is not None:
        return _rat_key(int(match.group(1)), 1)
    match = _FRAC_BRACED.match(text)
    if match is not None:
        return _rat_key(int(match.group(1)), int(match.group(2)))
    match = _FRAC_BARE.match(text)
    if match is not None:
        return _rat_key(int(match.group(1)), int(match.group(2)))
    return None


def _numeric_set_token(text):
    match = _SET_BODY.match(text)
    if match is None:
        return None
    body = js_trim(match.group(1))
    if not body:
        return "set:"
    keys = set()
    for part in body.split(","):
        key = _rational_token(js_trim(part))
        if key is None:
            return None
        keys.add(key)
    return "set:" + ",".join(sorted(keys))


# -- whole-answer option notation --------------------------------------------


def _option_token(text):
    single_must_be_explicit = False
    match = _OPTION_PAREN.match(text)
    if match is not None:
        body = match.group(1)
    else:
        match = _OPTION_DOTTED.match(text)
        if match is not None:
            body = match.group(1)
            single_must_be_explicit = True
        else:
            match = _OPTION_RUN.match(text) or _OPTION_LIST.match(text)
            if match is None:
                return None
            body = match.group(1)
    letters = {letter.upper() for letter in _OPTION_LETTER.findall(body)}
    if not letters:
        return None
    if (
        len(letters) == 1
        and not single_must_be_explicit
        and _OPTION_SINGLE_PAREN.match(text) is None
    ):
        return None
    return "options:" + ",".join(sorted(letters))


# -- polynomial comparison key -----------------------------------------------


def _mono_parts(key):
    parts = {}
    if key == "":
        return parts
    for part in key.split("*"):
        pieces = part.split("^")
        name = pieces[0]
        exponent = int(pieces[1]) if len(pieces) > 1 else 1
        parts[name] = exponent
    return parts


def _mono_key(parts):
    rows = [(name, exponent) for name, exponent in parts.items() if exponent != 0]
    rows.sort(key=lambda row: row[0])
    return "*".join(
        name if exponent == 1 else "%s^%d" % (name, exponent)
        for name, exponent in rows
    )


def _clean(poly):
    return {key: value for key, value in poly.items() if abs(value) > _EPS}


def _poly_add(left, right):
    out = dict(left)
    for key, value in right.items():
        out[key] = out.get(key, 0.0) + value
    return _clean(out)


def _poly_neg(poly):
    return {key: -value for key, value in poly.items()}


def _poly_scale(poly, factor):
    return _clean({key: value * factor for key, value in poly.items()})


def _poly_mul(left, right):
    out = {}
    for left_key, left_value in left.items():
        for right_key, right_value in right.items():
            parts = _mono_parts(left_key)
            for name, exponent in _mono_parts(right_key).items():
                parts[name] = parts.get(name, 0) + exponent
            key = _mono_key(parts)
            out[key] = out.get(key, 0.0) + left_value * right_value
    return _clean(out)


def _poly_pow(base, exponent):
    if not isinstance(exponent, int) or exponent < 0 or exponent > 16:
        return None
    result = {"": 1.0}
    for _ in range(exponent):
        result = _poly_mul(result, base)
    return result


def _tokenize(source):
    tokens = []
    index = 0
    length = len(source)
    while index < length:
        char = source[index]
        if char == " ":
            index += 1
            continue
        if char in _DIGITS:
            end = index
            while end < length and source[end] in _DIGITS:
                end += 1
            tokens.append(source[index:end])
            index = end
            continue
        if char in _LETTERS:
            end = index
            while end < length and source[end] in _WORD_CHARS:
                end += 1
            tokens.append(source[index:end])
            index = end
            continue
        if char == "*" and source[index + 1:index + 2] == "*":
            tokens.append("^")
            index += 2
            continue
        if char in "+-*/^()":
            tokens.append(char)
            index += 1
            continue
        return None
    if not tokens or len(tokens) > _MAX_TOKENS:
        return None
    return tokens


class _Parser:
    """Recursive-descent polynomial parser mirroring the Node ``Parser``."""

    def __init__(self, tokens):
        self.tokens = tokens
        self.index = 0

    def _peek(self):
        return self.tokens[self.index] if self.index < len(self.tokens) else None

    def _next(self):
        if self.index >= len(self.tokens):
            self.index += 1
            return None
        value = self.tokens[self.index]
        self.index += 1
        return value

    def parse(self):
        value = self._expr()
        if value is None or self._peek() is not None:
            return None
        return value

    def _expr(self):
        left = self._term()
        if left is None:
            return None
        while self._peek() in ("+", "-"):
            operator = self._next()
            right = self._term()
            if right is None:
                return None
            left = _poly_add(left, right) if operator == "+" else _poly_add(left, _poly_neg(right))
        return left

    def _term(self):
        left = self._factor()
        if left is None:
            return None
        while True:
            token = self._peek()
            if token in ("*", "/"):
                self._next()
                right = self._factor()
                if right is None:
                    return None
                if token == "*":
                    left = _poly_mul(left, right)
                else:
                    divisor = self._constant(right)
                    if divisor is None or divisor == 0:
                        return None
                    left = _poly_scale(left, 1.0 / divisor)
                continue
            # Implicit multiplication: ``x(x-1)``, ``2x``, ``(a)(b)``.
            if token is not None and (token == "(" or token[0] in _WORD_CHARS):
                right = self._factor()
                if right is None:
                    return None
                left = _poly_mul(left, right)
                continue
            return left

    def _factor(self):
        if self._peek() == "-":
            self._next()
            value = self._factor()
            return None if value is None else _poly_neg(value)
        if self._peek() == "+":
            self._next()
            return self._factor()
        base = self._atom()
        if base is None:
            return None
        if self._peek() == "^":
            self._next()
            exponent = self._next()
            if exponent is None or not exponent or any(ch not in _DIGITS for ch in exponent):
                return None
            return _poly_pow(base, int(exponent))
        return base

    def _atom(self):
        token = self._peek()
        if token == "(":
            self._next()
            value = self._expr()
            if value is None or self._next() != ")":
                return None
            return value
        if token is not None and token and all(ch in _DIGITS for ch in token):
            self._next()
            try:
                number = float(int(token))
            except (OverflowError, ValueError):
                return None
            if not math.isfinite(number):
                return None
            return {"": number}
        if (
            token is not None
            and token
            and token[0] in _LETTERS
            and all(ch in _WORD_CHARS for ch in token)
        ):
            self._next()
            return {token: 1.0}
        return None

    @staticmethod
    def _constant(poly):
        rows = list(poly.items())
        if len(rows) == 1 and rows[0][0] == "":
            return rows[0][1]
        return None


def _polynomial_of(source):
    tokens = _tokenize(source)
    if tokens is None:
        return None
    return _Parser(tokens).parse()


def _js_number(value):
    """Shortest JavaScript-like literal for one finite coefficient."""
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    return repr(value)


def _polynomial_token(poly):
    rows = [(key, value) for key, value in poly.items() if value != 0]
    rows.sort(key=lambda row: row[0])
    return "poly:" + ";".join("%s=%s" % (key, _js_number(value)) for key, value in rows)


# -- the key -----------------------------------------------------------------


def canonical_answer_key(text):
    """One comparable key for one answer text; never a normalized answer."""
    if not isinstance(text, str):
        return "text:"
    value = js_trim(_LABEL.sub("", text))
    value = _unwrap_once(value)
    compact_raw = _WS_RE.sub("", value)
    if re.fullmatch(r"[A-E]", compact_raw):
        return "options:" + compact_raw
    compact_lower = compact_raw.lower()
    if compact_lower in _TRUE_TOKENS:
        return "truth:true"
    if compact_lower in _FALSE_TOKENS:
        return "truth:false"
    # Normalize spaces around an explicit slash only; never fold two adjacent
    # numeric literals ("1 2", "1 1/2") into a different number.
    rational = _rational_token(re.sub(r"\s*/\s*", "/", value).strip())
    if rational is not None:
        return rational
    members = _numeric_set_token(value)
    if members is not None:
        return members
    options = _option_token(compact_lower)
    if options is not None:
        return options
    polynomial = None if re.search(r"\d\s+\d", value) else _polynomial_of(compact_lower)
    if polynomial is not None:
        return _polynomial_token(polynomial)
    return "text:" + compact_lower


# -- multi-part ballots ------------------------------------------------------

_COMPONENT_OPEN = frozenset("([{（【「")
_COMPONENT_CLOSE = frozenset(")]}）】」")
_COMPONENT_SEPARATOR = frozenset(",;，；、")
# A short left-hand tag of a labelled component: ``σ^{-2}=(14253)``, ``x=1``.
# It must not span a separator (the component is already split) and must stay
# short, so a real equation such as ``240 - 190·(5/6)^{3/2} = 95.46`` is never
# read as a tag plus a value.
_COMPONENT_TAG = re.compile(r"^[^=:：]{1,32}[=:：]\s*(.+)$", re.DOTALL)


def component_value(part):
    """The value of one component with a short left-hand tag removed.

    Two ballots of the same question label the same blank differently
    (``σ^{-2}=(14253)`` against a bare ``(14253)``); comparing the raw text would
    split those identical answers into two minorities while a wrong bare value
    keeps both of its votes. Only the component comparison uses this form.
    """
    text = js_trim(part) if isinstance(part, str) else ""
    match = _COMPONENT_TAG.match(text)
    if match is None:
        return text
    value = js_trim(match.group(1))
    return text if not value else value


def _component_key(part):
    return canonical_answer_key(component_value(part))


def answer_components(text):
    """Split a multi-part answer into its top-level components.

    Only separators OUTSIDE brackets split, so ``(14253),(165)`` is two answers
    while ``(a,b)`` and ``\{1,2,3\}`` stay one. This mirrors
    ``answerComponents`` in ``apps/stdio-runtime/src/agent-answer-key.ts``; the
    Host and the Node must agree, or the protected-candidate projection stops
    matching the delivered artifact.
    """
    if not isinstance(text, str):
        return []
    value = _unwrap_once(js_trim(text))
    parts = []
    current = []
    depth = 0
    for character in value:
        if character in _COMPONENT_OPEN:
            depth += 1
        elif character in _COMPONENT_CLOSE:
            depth = max(0, depth - 1)
        if depth == 0 and character in _COMPONENT_SEPARATOR:
            parts.append(js_trim("".join(current)))
            current = []
            continue
        current.append(character)
    parts.append(js_trim("".join(current)))
    return [part for part in parts if part]


def component_agreement_scores(candidates):
    """How many components of each candidate agree with the component majority.

    Used only when the whole-answer vote has NO majority (every ballot differs),
    to choose the real packet that best matches the per-component majorities
    instead of the last reply. It never synthesises an answer: the caller still
    delivers one real packet. Ballots with fewer than two components, or with
    different component counts, all score zero and the caller keeps its previous
    behaviour.
    """
    rows = [answer_components(candidate) for candidate in candidates]
    width = len(rows[0]) if rows else 0
    if width < 2 or any(len(row) != width for row in rows):
        return [0 for _ in rows]
    targets = []
    for index in range(width):
        counts = {}
        for row in rows:
            key = _component_key(row[index])
            counts[key] = counts.get(key, 0) + 1
        best = max(counts.values())
        target = _component_key(rows[-1][index])
        for row in reversed(rows):
            key = _component_key(row[index])
            if counts[key] == best:
                target = key
                break
        targets.append(target)
    return [
        sum(1 for index, part in enumerate(row) if _component_key(part) == targets[index])
        for row in rows
    ]
