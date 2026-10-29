"""Lossless output shape and explicit option coverage, never answer correctness."""

import re

from .content_fields import fields
from .expressions import safe_expr


def math_problem_text(text):
    # Remove only the exact, terminal non-mathematical presentation instruction.
    # No arbitrary sentence/condition or LaTeX expression is discarded.
    return re.sub(
        r"\s*Remember to put your final answer within \\boxed\{\}[.]?\s*$", "", text
    ).strip()


def unwrap_box(text):
    text = text.strip()
    if text.startswith(r"\boxed{"):
        depth = 1
        for i, ch in enumerate(text[7:], 7):
            depth += (ch == "{") - (ch == "}")
            if depth == 0:
                return text[7:i] if not text[i + 1 :].strip() else text
    return text


def option_labels(problem):
    labels = re.findall(
        r"(?<![A-Za-z0-9])([A-H])[.．、]\s*|\\item\[([A-H])[.]?\]", problem
    )
    found = tuple(dict.fromkeys(a or b for a, b in labels))
    return found if len(found) >= 2 and found == tuple("ABCDEFGH"[: len(found)]) else ()


def option_answer(problem, answer):
    labels = option_labels(problem)
    text = unwrap_box(answer).strip().strip("$").strip()
    if not labels or not re.fullmatch(r"[A-H](?:\s*[,，、]?\s*[A-H])*", text):
        return None
    selected = tuple(dict.fromkeys(re.findall(r"[A-H]", text)))
    return (
        tuple(x for x in labels if x in selected)
        if set(selected) <= set(labels)
        else None
    )


def answer_identity(problem, answer):
    """Conservative novelty/agreement key; not a reference-answer matcher."""
    choices = option_answer(problem, answer)
    if choices is not None:
        return ("options", choices)
    payload = unwrap_box(answer).strip()
    if re.fullmatch(r"[\d+*/^()\s-]+", payload) and not re.search(
        r"(?<!\d)0\d", payload
    ):
        try:
            value = safe_expr(payload, constants_only=True)
            if value.is_Rational:
                return ("rational", str(value))
        except (ValueError, SyntaxError, TypeError):
            pass
    return ("text", re.sub(r"\s+", " ", payload))


def choice_coverage(problem, text, answer):
    labels = option_labels(problem)
    sections = fields(text, ["ANSWER", "BASIS", "GAPS"], after_math=True)
    basis = "\n".join(value for label, value in sections if label == "BASIS")
    entries = re.findall(
        r"(?:^|[;；]\s*)OPTION\s+([A-H])\s*:\s*(TRUE|FALSE|UNKNOWN)\b",
        basis,
        re.IGNORECASE,
    )
    values = {k.upper(): v.upper() for k, v in entries}
    complete = (
        bool(labels)
        and len(entries) == len(values)
        and set(values) == set(labels)
        and "UNKNOWN" not in values.values()
    )
    selected = option_answer(problem, answer)
    agrees = (
        complete
        and selected is not None
        and set(selected) == {k for k, v in values.items() if v == "TRUE"}
    )
    return {
        "labels": list(labels),
        "assessed": values,
        "complete_claimed_coverage": complete,
        "answer_consistent_with_claims": bool(agrees),
        "mathematical_truth_verified": False,
    }


def output_payload(problem, answer):
    choices = option_answer(problem, answer)
    judgement = bool(re.search(r"判断\s*[:：]|判断题", problem)) and unwrap_box(
        answer
    ).strip().casefold() in {"true", "false"}
    if judgement:
        answer = "正确" if unwrap_box(answer).strip().casefold() == "true" else "错误"
    if choices is not None:
        answer = "".join(choices)
    if re.search(r"Remember to put your final answer within \\boxed\{\}", problem):
        # Do not box whole paragraphs, proofs, multiple answers or alter meaning.
        compact = (
            judgement
            or choices is not None
            or bool(re.fullmatch(r"[+-]?\d+(?:/\d+|\.\d+)?", answer.strip()))
        )
        if compact:
            return r"\boxed{" + answer.strip() + "}"
    return answer
