"""Conservative source-to-check compilation, independent of problem IDs/gold.

This is a documented language subset, not a natural-language truth oracle.
Every accepted source is consumed in full after lossless math-wrapper cleanup.
Unsupported conditions/definitions return no plan instead of a weaker problem.
"""

from __future__ import annotations

import ast
import re
from dataclasses import asdict, dataclass

from .answer_contracts import math_problem_text
from .output_checks import algebraic as exact
from .runtime.config import fingerprint

VERSION = "source-math-contract-v2-16-members"


class UnsupportedSource(ValueError):
    pass


@dataclass(frozen=True)
class SourceCheck:
    tool: str
    arguments: dict


@dataclass(frozen=True)
class SourcePlan:
    property: str
    domain: str
    source_hash: str
    answer_hash: str
    checks: tuple[SourceCheck, ...]
    full_goal: bool = False

    @property
    def digest(self):
        return fingerprint((VERSION, asdict(self)))


def plain(text):
    if type(text) is not str or len(text) > 12000:
        raise UnsupportedSource("source text bound")
    text = math_problem_text(text)
    for token in ("$", r"\(", r"\)", r"\[", r"\]"):
        text = text.replace(token, " ")
    text = re.sub(r"\\mathbb\s*\{([RCQ])\}", r"\1", text)
    text = text.replace(r"\rightarrow", "->").replace(r"\to", "->").replace("→", "->")
    text = text.replace(r"\in", " in ").replace("∈", " in ")
    text = text.replace("−", "-").replace(r"\\", " ")
    return re.sub(r"\s+", " ", text).strip()


def _group(text, start):
    if start >= len(text) or text[start] != "{":
        raise UnsupportedSource("balanced LaTeX group required")
    depth = 1
    for i in range(start + 1, len(text)):
        depth += (text[i] == "{") - (text[i] == "}")
        if depth > 16:
            raise UnsupportedSource("math group nesting bound")
        if not depth:
            return text[start + 1 : i], i + 1
    raise UnsupportedSource("unterminated math group")


def latex(text):
    if len(text) > 2000:
        raise UnsupportedSource("expression source bound")
    for token in (
        r"\left",
        r"\right",
        r"\bigl",
        r"\bigr",
        r"\Bigl",
        r"\Bigr",
        r"\!",
        r"\,",
        r"\;",
        r"\ ",
    ):
        text = text.replace(token, "")
    text = text.replace(r"\cdot", "*").replace(r"\times", "*").replace("−", "-")
    out = ""
    i = 0
    while i < len(text):
        match = re.match(r"\\(?:dfrac|tfrac|frac)", text[i:])
        if match:
            a, j = _group(text, i + match.end())
            b, i = _group(text, j)
            out += "((" + latex(a) + ")/(" + latex(b) + "))"
            continue
        match = re.match(r"\\sqrt(?:\[([2-6])\])?", text[i:])
        if match:
            value, i = _group(text, i + match.end())
            out += "root(" + latex(value) + "," + (match[1] or "2") + ")"
            continue
        match = re.match(r"\\boxed", text[i:])
        if match:
            value, i = _group(text, i + match.end())
            out += "(" + latex(value) + ")"
            continue
        if text[i] == "{":
            value, i = _group(text, i)
            out += "(" + latex(value) + ")"
            continue
        if text[i] == "\\":
            raise UnsupportedSource("unsupported LaTeX command")
        out += text[i]
        i += 1
    return out.replace("^", "**")


def expression(text, variables, functions=()):
    """Normalize only declared symbols, rational arithmetic and named calls."""
    text = latex(text.strip())
    allowed = sorted(set(variables) | set(functions), key=len, reverse=True)
    symbol_pattern = "|".join(re.escape(v) for v in allowed)
    tokens = []
    i = 0
    while i < len(text):
        if text[i].isspace():
            i += 1
            continue
        match = re.match(r"\d+|\*\*|[()+*/,-]", text[i:])
        kind = "op"
        if match:
            token = match[0]
            if token.isdigit():
                kind = "atom"
            elif token == "(":
                kind = "open"
            elif token == ")":
                kind = "close"
        else:
            match = re.match(symbol_pattern, text[i:]) if allowed else None
            if not match:
                raise UnsupportedSource("unknown mathematical identifier/token")
            token = match[0]
            kind = "function" if token in functions else "atom"
        if (
            tokens
            and tokens[-1][1] in {"atom", "close"}
            and kind in {"atom", "function", "open"}
        ):
            tokens.append(("*", "op"))
        tokens.append((token, kind))
        i += len(token)
    value = "".join(t[0] for t in tokens)
    if len(value) > 500:
        raise UnsupportedSource("normalized expression bound")
    ast.parse(value, mode="eval")
    return value


def variable_list(text):
    values = [v.strip() for v in re.split(r",|\band\b", text) if v.strip()]
    exact.names(values)
    return values


def _unbox(text):
    text = text.strip()
    if text.startswith(r"\boxed{"):
        body, end = _group(text, len(r"\boxed"))
        if end == len(text):
            return body
    return text


def function_answers(answer, function, domain):
    value = _unbox(plain(answer)).strip().rstrip(".")
    value = re.sub(
        r"^(?:The solutions are|The functions are|The solution is|The function is)\s+",
        "",
        value,
        flags=re.IGNORECASE,
    )
    # Only total function claims. A restricted candidate such as x>0 is not
    # silently extended to the original real domain.
    domain_alias = r"(?:R|ℝ)" if domain == "R" else r"(?:C|ℂ)"
    quantified = re.search(
        r"(?:,\s*|\s+)for all\s+([a-zA-Z])\s+in\s+" + domain_alias + r"\s*$",
        value,
    )
    if quantified:
        value = value[: quantified.start()].rstrip()
    pattern = re.compile(r"\b" + re.escape(function) + r"\s*\(\s*([a-zA-Z])\s*\)\s*=")
    matches = list(pattern.finditer(value))
    if not 1 <= len(matches) <= 16 or value[: matches[0].start()].strip():
        raise UnsupportedSource("explicit complete function answer list required")
    if quantified and any(match[1] != quantified[1] for match in matches):
        raise UnsupportedSource(
            "candidate quantifier variable differs from function argument"
        )
    result = []
    for index, match in enumerate(matches):
        body = value[
            match.end() : matches[index + 1].start()
            if index + 1 < len(matches)
            else len(value)
        ]
        if index + 1 < len(matches):
            separator = re.search(r"\s*(?:,?\s*and|,?\s*or|,)\s*$", body, re.IGNORECASE)
            if not separator:
                raise UnsupportedSource("ambiguous function list")
            body = body[: separator.start()]
        variable = match[1]
        normalized = expression(body, [variable])
        exact.poly(normalized, [variable])
        result.append((variable, normalized))
    return result


def _functional(source, answer):
    pattern = (
        r"(?:Find|Determine) all functions\s+([A-Za-z])\s*:\s*([RC])\s*->\s*\2\s+"
        r"(?:such that|satisfying)\s+(.+?)\s+(?:holds\s+)?for all\s+(real|complex)\s+(?:numbers\s+)?([A-Za-z](?:\s*(?:,|and)\s*[A-Za-z]){0,2})\s*\.?"
    )
    match = re.fullmatch(pattern, source, re.IGNORECASE)
    if not match:
        return None
    function, domain, equation, kind, variables = match.groups()
    domain = domain.upper()
    if (domain == "R") != (kind.lower() == "real"):
        raise UnsupportedSource("function/quantifier domains differ")
    variables = variable_list(variables)
    if equation.count("=") != 1:
        raise UnsupportedSource("one unconditional functional equality required")
    left, right = equation.split("=")
    equation = (
        expression(left, variables, [function])
        + "="
        + expression(right, variables, [function])
    )
    result = []
    for argument, formula in function_answers(answer, function, domain):
        args = {
            "equation": equation,
            "function": function,
            "argument": argument,
            "variables": variables,
            "expression": formula,
        }
        exact.normalize("polynomial_function_check", args)
        result.append(SourceCheck("polynomial_function_check", args))
    return (
        "source_function_satisfaction",
        "real" if domain == "R" else "complex",
        tuple(result),
        False,
    )


def _call_arguments(text, name, variables, functions=()):
    node = ast.parse(expression(text, variables, (*functions, name)), mode="eval").body
    if (
        not isinstance(node, ast.Call)
        or not isinstance(node.func, ast.Name)
        or node.func.id != name
        or node.keywords
    ):
        raise UnsupportedSource("one declared function application required")
    return [ast.unparse(arg) for arg in node.args]


def _invariant(source, answer):
    match = re.fullmatch(
        r"(?:Find|Determine) all\s+(?:polynomials\s+)?([A-Za-z])\s+in\s+C\[([A-Za-z]\s*,\s*[A-Za-z])\]\s+such that for all complex numbers\s+([A-Za-z]\s*,\s*[A-Za-z])\s*,\s*(.+?)\.?",
        source,
        re.IGNORECASE,
    )
    if not match:
        return None
    function, base, variables, equation = match.groups()
    base = variable_list(base)
    variables = variable_list(variables)
    if equation.count("=") != 1:
        raise UnsupportedSource("one invariant equality required")
    left, right = equation.split("=")
    forward = _call_arguments(left, function, variables)
    target = _call_arguments(right, function, variables)
    value = plain(answer)
    assignment = re.search(
        r"\b"
        + re.escape(function)
        + r"\s*\(\s*"
        + re.escape(base[0])
        + r"\s*,\s*"
        + re.escape(base[1])
        + r"\s*\)\s*=\s*([A-Za-z])\s*",
        value,
    )
    if not assignment:
        raise UnsupportedSource("explicit polynomial-family expression required")
    prefix = value[: assignment.start()].strip()
    if not re.fullmatch(
        r"(?:All such polynomials are(?: exactly those)?(?: of the form)?|The solutions are)?",
        prefix,
        re.IGNORECASE,
    ):
        raise UnsupportedSource("unsupported or conditional family prefix")
    outer = assignment[1]
    tail = value[assignment.end() :]
    for token in (r"\!", r"\bigl", r"\bigr", r"\Bigl", r"\Bigr", r"\left", r"\right"):
        tail = tail.replace(token, "")
    tail = tail.lstrip()
    if not tail.startswith("("):
        raise UnsupportedSource("explicit family generators required")
    depth = 0
    end = None
    for i, c in enumerate(tail):
        depth += (c == "(") - (c == ")")
        if not depth:
            end = i + 1
            break
    if end is None:
        raise UnsupportedSource("unbalanced polynomial family")
    invariants = _call_arguments(outer + tail[:end], outer, base)
    declaration = re.fullmatch(
        r"\s*for (?:an? )?arbitrary polynomial\s+([A-Za-z])(?:\s+in\s+[RC]\[([A-Za-z](?:\s*,\s*[A-Za-z]){0,3})\])?\s*\.?"
        r"(?:\s*Equivalently, the invariant subring is\s+C\[(.+)\]\s*\.?)?",
        tail[end:],
        re.IGNORECASE,
    )
    if not declaration or declaration[1] != outer:
        raise UnsupportedSource(
            "arbitrary family declaration must be complete and unconditional"
        )
    if declaration[2] and len(variable_list(declaration[2])) != len(invariants):
        raise UnsupportedSource("generator arity differs from polynomial declaration")
    if declaration[3]:
        repeated = _call_arguments(outer + "(" + declaration[3] + ")", outer, base)
        if [exact.poly(e, base) for e in repeated] != [
            exact.poly(e, base) for e in invariants
        ]:
            raise UnsupportedSource(
                "equivalent-ring claim is not a lossless repetition"
            )
    args = {
        "base_variables": base,
        "variables": variables,
        "forward": forward,
        "target": target,
        "invariants": invariants,
    }
    exact.normalize("polynomial_invariant_check", args)
    return (
        "source_invariant_generators",
        "complex",
        (SourceCheck("polynomial_invariant_check", args),),
        False,
    )


def _field_expressions(argument, target, placeholder=None):
    """One positive radical field; different radicands may be powers of its base."""
    import sympy as sp

    expressions = [
        expression(argument, [], ["root"]),
        expression(target, [placeholder] if placeholder else [], ["root"]),
    ]
    trees = [ast.parse(e, mode="eval").body for e in expressions]
    radicals = []
    for node in (n for tree in trees for n in ast.walk(tree)):
        if isinstance(node, ast.Call):
            if (
                not isinstance(node.func, ast.Name)
                or node.func.id != "root"
                or len(node.args) != 2
                or node.keywords
                or any(
                    not isinstance(a, ast.Constant) or type(a.value) is not int
                    for a in node.args
                )
            ):
                raise UnsupportedSource("explicit positive integer radicals only")
            radicand, degree = (a.value for a in node.args)
            if not 2 <= radicand <= 128 or not 2 <= degree <= 6:
                raise UnsupportedSource("positive radical field bound")
            radicals.append((radicand, degree))
    if not radicals or len({n for _, n in radicals}) != 1:
        raise UnsupportedSource("one radical degree required")
    base = min(r for r, _ in radicals)
    degree = radicals[0][1]
    t = sp.Symbol("t")
    modulus = t**degree - base
    if not sp.Poly(modulus, t, domain=sp.QQ).is_irreducible:
        raise UnsupportedSource("radical does not give this irreducible field")

    def reduce(value):
        return sp.rem(value, modulus, t)

    def visit(node, parameter=None):
        if (
            isinstance(node, ast.Constant)
            and type(node.value) is int
            and abs(node.value) <= 10**6
        ):
            return sp.Integer(node.value)
        if (
            isinstance(node, ast.Name)
            and placeholder
            and node.id == placeholder
            and parameter is not None
        ):
            return parameter
        if isinstance(node, ast.Call):
            value = node.args[0].value
            power = 0
            while value > 1 and value % base == 0:
                value //= base
                power += 1
            if value != 1:
                raise UnsupportedSource("radicals not powers of one declared base")
            return reduce(t**power)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand, parameter)
            return -value if isinstance(node.op, ast.USub) else value
        if isinstance(node, ast.BinOp):
            a, b = visit(node.left, parameter), visit(node.right, parameter)
            if isinstance(node.op, ast.Add):
                value = a + b
            elif isinstance(node.op, ast.Sub):
                value = a - b
            elif isinstance(node.op, ast.Mult):
                value = a * b
            elif isinstance(node.op, ast.Div):
                if b == 0:
                    raise UnsupportedSource("zero field denominator")
                value = a * sp.invert(b, modulus, t)
            elif (
                isinstance(node.op, ast.Pow)
                and b.is_Integer
                and 0 <= b <= 8
                and not (a == 0 and b == 0)
            ):
                value = a ** int(b)
            else:
                raise UnsupportedSource("unsupported field expression")
            result = reduce(value)
            if any(
                abs(int(c.p)).bit_length() > 256 or int(c.q).bit_length() > 256
                for c in sp.Poly(result, t, domain=sp.QQ).coeffs()
            ):
                raise UnsupportedSource("field arithmetic budget")
            return result
        raise UnsupportedSource("unsupported field syntax")

    a = visit(trees[0])
    b = visit(trees[1], a)
    return str(modulus), str(a), str(b)


def _algebraic(source, answer):
    # Direct statement; or a locally defined predicate with exactly one explicit
    # defining equality. Predicate spelling is captured, never hard-coded.
    defined = re.fullmatch(
        r"We call a real number\s+([A-Za-z])\s+['\"]([A-Za-z][A-Za-z-]*)['\"]\s+if it is a\s+solution to\s+([A-Za-z])\(\1\)\s*=\s*(.+?)\s+for some polynomial\s+\3\(\1\)\s+with rational coefficients\.\s*(?:Find|Determine) all polynomials\s+\3\(\1\)\s+with rational coefficients of lowest possible degree such that\s+(.+?)\s+is\s+\2\.?",
        source,
        re.IGNORECASE,
    )
    if defined:
        variable, _, function, target, argument = defined.groups()
        placeholder = variable
        applications = re.findall(r"\b([A-Za-z])\(([A-Za-z])\)", source)
        if applications != [(function, variable)] * 3:
            raise UnsupportedSource("definition/goal symbol binding differs")
    else:
        direct = re.fullmatch(
            r"(?:Find|Determine) all polynomials\s+([A-Za-z])\(([A-Za-z])\)\s+with rational coefficients of (?:lowest possible|minimum) degree such that\s+(.+?)\.?",
            source,
            re.IGNORECASE,
        )
        if not direct:
            return None
        function, variable, equality = direct.groups()
        if equality.count("=") != 1:
            raise UnsupportedSource("one algebraic target equality required")
        left, target = equality.split("=")
        arguments = _call_arguments(left, function, [], ["root"])
        if len(arguments) != 1:
            raise UnsupportedSource("one algebraic argument required")
        # _field_expressions accepts the same root() spelling as normalized LaTeX.
        argument = arguments[0]
        placeholder = None
    values = function_answers(answer, function, "R")
    if len(values) != 1:
        raise UnsupportedSource("one minimal polynomial answer required")
    polynomial_variable, formula = values[0]
    modulus, a, b = _field_expressions(argument, target, placeholder)
    if polynomial_variable == "t":
        formula = re.sub(r"\bt\b", "z", formula)
        polynomial_variable = "z"
    args = {
        "minimal_polynomial": modulus,
        "generator": "t",
        "argument": a,
        "target": b,
        "expression": formula,
        "variable": polynomial_variable,
    }
    exact.normalize("algebraic_polynomial_check", args)
    return (
        "source_algebraic_minimum",
        "real_algebraic",
        (SourceCheck("algebraic_polynomial_check", args),),
        True,
    )


def compile_candidate(problem, answer):
    """No whole-problem hashes, expected answers, item IDs or family votes used."""
    try:
        source = plain(problem)
        result = None
        for compiler in (_functional, _invariant, _algebraic):
            result = compiler(source, answer)
            if result is not None:
                break
        if result is None:
            return None
        prop, domain, checks, full = result
        return SourcePlan(
            prop, domain, fingerprint(problem), fingerprint(answer), checks, full
        )
    except (
        ValueError,
        TypeError,
        SyntaxError,
        KeyError,
        IndexError,
        OverflowError,
        RecursionError,
    ):
        return None
