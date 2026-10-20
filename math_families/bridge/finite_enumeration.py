"""Bounded exhaustive enumeration over an explicitly supplied finite universe.

The caller supplies the objects, the subset size and a small predicate over
attribute summaries.  This module never evaluates arbitrary Python: the
predicate is an arithmetic/comparison/boolean expression restricted by AST.
The result is a count, not a proof of how the model mapped the problem.
"""

from __future__ import annotations

import ast
import itertools
from fractions import Fraction

from math_families.core.evidence import Evidence

__all__ = ["bounded_enumeration"]

_MAX_OBJECTS = 60
_MAX_ARITY = 4
_MAX_CHOOSE = 6
_MAX_COMBINATIONS = 5_000_000
_MAX_PREDICATE_CHARS = 400
_MAX_PREDICATE_NODES = 96
_FUNCS = {"distinct", "count", "size", "sum", "min", "max", "contains"}


def _predicate_ast(source: str) -> ast.Expression:
    if not isinstance(source, str) or not source.strip():
        raise ValueError("predicate must be a non-empty string")
    if len(source) > _MAX_PREDICATE_CHARS:
        raise ValueError("predicate too long")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        raise ValueError("predicate syntax") from exc
    nodes = list(ast.walk(tree))
    if len(nodes) > _MAX_PREDICATE_NODES:
        raise ValueError("predicate AST too large")
    allowed = (
        ast.Expression,
        ast.BoolOp,
        ast.And,
        ast.Or,
        ast.UnaryOp,
        ast.Not,
        ast.USub,
        ast.UAdd,
        ast.Compare,
        ast.Eq,
        ast.NotEq,
        ast.Lt,
        ast.LtE,
        ast.Gt,
        ast.GtE,
        ast.BinOp,
        ast.Add,
        ast.Sub,
        ast.Mult,
        ast.Div,
        ast.Mod,
        ast.FloorDiv,
        ast.Pow,
        ast.Constant,
        ast.Call,
        ast.Name,
        ast.Load,
        ast.Tuple,
    )
    for node in nodes:
        if not isinstance(node, allowed):
            raise ValueError(f"predicate node {type(node).__name__} is not allowed")
        if isinstance(node, ast.Constant) and type(node.value) not in {int, float, str}:
            raise ValueError("predicate constants must be int, float or string")
        if isinstance(node, ast.Constant) and type(node.value) in {int, float}:
            if abs(node.value) > 10**9:
                raise ValueError("predicate numeric literal too large")
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
                raise ValueError("predicate function is not allowed")
            if node.keywords:
                raise ValueError("predicate keyword arguments are not allowed")
        if isinstance(node, ast.Name) and node.id not in _FUNCS:
            raise ValueError(f"predicate name {node.id!r} is not a function")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow):
            if not isinstance(node.right, ast.Constant) or type(node.right.value) is not int or abs(node.right.value) > 6:
                raise ValueError("predicate exponent must be a small integer literal")
    return tree


def _validate_objects(objects):
    if not isinstance(objects, list) or not 1 <= len(objects) <= _MAX_OBJECTS:
        raise ValueError("objects must be a non-empty bounded list")
    arity = None
    for row in objects:
        if not isinstance(row, list) or not 1 <= len(row) <= _MAX_ARITY:
            raise ValueError("each object must be a short attribute list")
        if arity is None:
            arity = len(row)
        elif len(row) != arity:
            raise ValueError("all objects must have the same arity")
        for value in row:
            if type(value) not in {int, str}:
                raise ValueError("object attributes must be integers or strings")
            if isinstance(value, str) and (len(value) > 64 or any(0xD800 <= ord(c) <= 0xDFFF for c in value)):
                raise ValueError("object string attribute is not a bounded scalar")
    return arity


def bounded_enumeration(objects=None, choose=None, predicate=None, ranges=None):
    """Count k-subsets satisfying a predicate over their attributes.

    Predicate vocabulary (all indices are zero-based):
      size()                  number of selected objects
      distinct(i)             number of distinct values of attribute i
      count(i, value)         occurrences of value in attribute i
      sum(i)                  numeric sum of attribute i
      min(i) / max(i)         numeric extrema of attribute i
      contains(i, value)      whether value occurs in attribute i
    Arithmetic, comparisons and and/or/not are allowed. No other names or
    calls are reachable.
    """
    if type(choose) is not int or not 1 <= choose <= _MAX_CHOOSE:
        raise ValueError("choose must be an integer in 1..6")
    if (objects is None) == (ranges is None):
        raise ValueError("supply exactly one of objects or ranges")
    if ranges is not None:
        if not isinstance(ranges, list) or not 1 <= len(ranges) <= _MAX_ARITY:
            raise ValueError("ranges must contain 1..4 positive sizes")
        if any(type(size) is not int or not 1 <= size <= _MAX_OBJECTS for size in ranges):
            raise ValueError("each range size must be in 1..60")
        objects = [list(row) for row in itertools.product(*(range(size) for size in ranges))]
    arity = _validate_objects(objects)
    if choose > len(objects):
        raise ValueError("choose exceeds the number of objects")
    total = 1
    for i in range(choose):
        total = total * (len(objects) - i) // (i + 1)
    if total > _MAX_COMBINATIONS:
        raise ValueError("enumeration exceeds the bounded combination budget")
    tree = _predicate_ast(predicate)
    code = compile(tree, "<bounded-enumeration>", "eval")
    current = ()

    def distinct(i):
        return len({row[i] for row in current})

    def count(i, value):
        return sum(1 for row in current if row[i] == value)

    def size():
        return len(current)

    def total_sum(i):
        return sum(row[i] for row in current)

    def minimum(i):
        return min(row[i] for row in current)

    def maximum(i):
        return max(row[i] for row in current)

    def contains(i, value):
        return any(row[i] == value for row in current)

    env = {
        "__builtins__": {},
        "distinct": distinct,
        "count": count,
        "size": size,
        "sum": total_sum,
        "min": minimum,
        "max": maximum,
        "contains": contains,
    }
    favorable = 0
    examples = []
    for combo in itertools.combinations(objects, choose):
        current = combo
        try:
            accepted = eval(code, env, {})  # noqa: S307 - AST is whitelisted above
        except (TypeError, ValueError, ZeroDivisionError, IndexError) as exc:
            raise ValueError("predicate evaluation failed") from exc
        if accepted:
            favorable += 1
            if len(examples) < 8:
                examples.append([list(row) for row in combo])
    fraction = Fraction(favorable, total)
    return Evidence(
        value={
            "schema": "bounded-enumeration-v1",
            "objects": len(objects),
            "ranges": ranges,
            "choose": choose,
            "arity": arity,
            "predicate": predicate,
            "favorable": favorable,
            "total": total,
            "fraction": f"{fraction.numerator}/{fraction.denominator}",
            "examples": examples,
            "complete_for_input": True,
        },
        certificate=f"exhaustive enumeration of all {total} subsets; favorable={favorable}",
        self_check="favorable <= total and fraction reduced exactly",
        feasibility="ok",
        complexity_bound=f"O(C({len(objects)},{choose})) bounded by 5,000,000",
    )
