"""Fully consumed formula signals. AST parsing is syntax only: never execute/eval.

Only explicit presentational prefixes and balanced inline math wrappers may be
discarded. Unknown tails/prefixes are not searched for a convenient true equation.
"""

import ast
import math
import re
from dataclasses import dataclass

from .claim_context import IDENTIFIER
from .runtime.config import fingerprint

_PREFIX = re.compile(
    r"^(?:(?:(?:new |another |derived |relevant |related )*(?:(?:identity|identities)(?: lemma)?|lemma|lemmas|formula)|therefore|thus|hence|we obtain|we get)(?=[\s:：,，])|得到(?:另一个)?(?:相关)?(?:新)?引理|(?:新|另一个)?(?:相关)?(?:恒等式|公式)|换个说法|由此可得|因此|所以)\s*[:：,，]?\s*",
    re.IGNORECASE,
)
_FUNCTIONS = frozenset({"sqrt", "sin", "cos", "tan", "exp", "log", "abs"})
_CONSTANTS = frozenset({"pi"})


@dataclass(frozen=True)
class FormulaSignal:
    key: str | None = None
    objects: frozenset[str] = frozenset()
    unconsumed: bool = False


def math_identifiers(text):
    found = set()
    for match in re.finditer(rf"(?<![A-Za-z0-9_])({IDENTIFIER})(?![A-Za-z0-9_])", text):
        if match[1] in {"a", "A"} and re.match(
            r"\s+(?!(?:and|or)\b)[a-z]{2,}\b", text[match.end() :]
        ):
            continue
        found.add(match[1])
    return frozenset(found)


def _expression(text):
    # AST silently consumes Python comments and explicit line continuations.
    # Neither is part of this bounded mathematical language. Check *all* source
    # characters before parsing, including whitespace the parser would ignore.
    if not re.fullmatch(r"[A-Za-z0-9_+*/^()., \t-]+", text):
        raise ValueError("unconsumed mathematical lexeme")
    root = ast.parse(text.strip().replace("^", "**"), mode="eval")
    nodes = list(ast.walk(root))
    if len(nodes) > 256:
        raise ValueError("expression scope")
    allowed = (
        ast.Expression,
        ast.BinOp,
        ast.UnaryOp,
        ast.Name,
        ast.Load,
        ast.Constant,
        ast.Add,
        ast.Sub,
        ast.Mult,
        ast.Div,
        ast.Pow,
        ast.USub,
        ast.UAdd,
        ast.Call,
    )
    names = set()
    for node in nodes:
        if not isinstance(node, allowed):
            raise TypeError("non-mathematical syntax")
        if isinstance(node, ast.Name):
            if re.fullmatch(IDENTIFIER, node.id):
                names.add(node.id)
            elif node.id not in _FUNCTIONS | _CONSTANTS:
                raise ValueError("unregistered identifier")
        if isinstance(node, ast.Constant) and (
            type(node.value) not in {int, float} or not math.isfinite(node.value)
        ):
            raise ValueError("not a finite mathematical literal")
        if isinstance(node, ast.Call) and (
            not isinstance(node.func, ast.Name)
            or node.keywords
            or not 1 <= len(node.args) <= 3
        ):
            raise ValueError("unregistered application")
    return ast.dump(root.body, annotate_fields=False, include_attributes=False), names


def formula_signal(frame):
    text = frame.conclusion.strip()
    looks_mathematical = bool(re.search(r"[=<>≤≥≠∈∉]", text))
    if not frame.complete:
        return FormulaSignal(
            objects=math_identifiers(text), unconsumed=looks_mathematical
        )
    if not looks_mathematical:
        return FormulaSignal()
    if len(text) > 2000:
        return FormulaSignal(objects=math_identifiers(text), unconsumed=True)
    text = _PREFIX.sub("", text, count=1).strip()
    if len(text) >= 2 and (
        (text[0] == text[-1] == "$") or (text[0] == text[-1] == "`")
    ):
        text = text[1:-1].strip()
    text = text.replace("\\cdot", "*").replace("\\times", "*")
    parts = re.split(r"(<=|>=|!=|=|<|>|≤|≥|≠)", text)
    try:
        if len(parts) not in {3, 5, 7}:
            raise ValueError("not a complete bounded relation")
        operands = [_expression(part) for part in parts[::2]]
        relations = []
        for index, operator in enumerate(parts[1::2]):
            left, right = operands[index][0], operands[index + 1][0]
            operator = {"≤": "<=", "≥": ">=", "≠": "!="}.get(operator, operator)
            if operator in {"=", "!="}:
                left, right = sorted((left, right))
            elif operator in {">", ">="}:
                left, right, operator = right, left, "<" if operator == ">" else "<="
            relations.append((left, operator, right))
        symbols = frozenset().union(*(symbols for _, symbols in operands))
        return FormulaSignal(
            "formula:" + fingerprint((tuple(relations), frame.binding)), symbols
        )
    except (TypeError, ValueError, SyntaxError, RecursionError, OverflowError):
        return FormulaSignal(
            objects=math_identifiers(frame.conclusion), unconsumed=True
        )
