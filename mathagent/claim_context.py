"""Narrow, complete statement-context parsing for progress identity, not proof.

An unsupported premise/quantifier/range is explicitly incomplete. A recognized
conclusion never licenses discarding its surrounding conditions. No full-text
hash is treated as positive evidence of mathematical novelty.
"""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class StatementContext:
    conclusion: str
    premises: tuple = ()
    quantifiers: tuple = ()
    ranges: tuple = ()
    complete: bool = True
    explicit: bool = False

    def __post_init__(self):
        if self.complete and any(not block[1] for block in self.quantifiers):
            raise ValueError("complete quantifier blocks require nonempty variables")

    @property
    def binding(self):
        return self.premises, self.quantifiers, self.ranges


_NUMBERS = {
    "零": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}
_DOMAIN = r"(?:(?:非零|非负|正|负)?(?:整数|实数|自然数)|(?:(?:nonzero|nonnegative|positive|negative)\s+)?(?:integers?|reals?|real numbers?|natural numbers?))"
IDENTIFIER = r"[A-Za-z](?:_[A-Za-z0-9]+)?"
_VARS = rf"{IDENTIFIER}(?:\s*(?:,|和|与|、|(?i:and))\s*{IDENTIFIER})*"
_CONTEXT_MARKER = re.compile(
    r"\b(?:if|unless|when|whenever|assume|assuming|suppose|supposing|let|provided|under|given|because|where|with|for all|for every|for each|for some|for exactly|for at least|for at most|for any|there exists?|such that)\b"
    r"|\b(?:over|for)\s+(?:the\s+)?(?:integers?|reals?|real|natural|nonzero|positive|negative)\b|\bfor\s+[a-z]\s*[<>=!]"
    r"|若(?!干)|如果|只要|只有|仅当|当且仅当|除非|假设|假定|^设|倘若|因为|由于|其中|限定|当.+时|(?<!同)时[,，]|在.+(?:范围|条件|前提)|满足.+的|(?:(?:对|对于)(?:所有|任意|每个))|存在(?:唯一|至少一个|至多一个|一个|某个)?(?:整数|实数|自然数)|∀|∃|∈|∉|^\s*(?:then\b|则|那么)",
    re.IGNORECASE,
)


def _number(text):
    text = text.strip().lower()
    if text in _NUMBERS:
        return _NUMBERS[text]
    if re.fullmatch(r"[+-]?\d{1,6}", text):
        return int(text)
    match = re.fullmatch(r"([一二三四五六七八九]?)十([一二三四五六七八九]?)", text)
    if match:
        return 10 * (_NUMBERS[match[1]] if match[1] else 1) + (
            _NUMBERS[match[2]] if match[2] else 0
        )
    return None


def _domain(text):
    text = re.sub(r"\s+", " ", text.strip().lower())
    sign = next(
        (
            name
            for pattern, name in (
                (r"非零|nonzero", "nonzero"),
                (r"非负|nonnegative", "nonnegative"),
                (r"^正|positive", "positive"),
                (r"^负|negative", "negative"),
            )
            if re.search(pattern, text)
        ),
        "any",
    )
    domain = (
        "integer"
        if re.search(r"整数|integer", text)
        else "real"
        if re.search(r"实数|real", text)
        else "natural"
    )
    return domain, sign


def _variables(text):
    values = tuple(
        part.strip()
        for part in re.split(r",|和|与|、|\band\b", text, flags=re.IGNORECASE)
    )
    if (
        not values
        or any(re.fullmatch(IDENTIFIER, value) is None for value in values)
        or len(set(values)) != len(values)
    ):
        return None
    return tuple(sorted(values))


def _atom(text):
    text = text.strip().strip(".,， ")
    sign = re.fullmatch(
        rf"({IDENTIFIER})\s+(?i:(?:is\s+)?(positive|nonnegative|negative|nonzero|equal to zero))",
        text,
    )
    if sign:
        return (
            "compare",
            sign[1],
            {
                "positive": ">",
                "nonnegative": ">=",
                "negative": "<",
                "nonzero": "!=",
                "equal to zero": "=",
            }[sign[2].lower()],
            0,
        )
    match = re.fullmatch(
        rf"({IDENTIFIER})\s*(?:是|为|等于)\s*({IDENTIFIER})\s*的\s*([零一二两三四五六七八九十\d+-]+)\s*倍",
        text,
    )
    if match:
        factor = _number(match[3])
        return ("multiple", match[1], match[2], factor) if factor is not None else None
    match = re.fullmatch(
        rf"({IDENTIFIER})\s+(?i:is|equals)\s+((?i:twice|thrice|[a-z]+)|[+-]?\d+)\s+(?i:times\s+)?({IDENTIFIER})",
        text,
    )
    if match:
        factor = {"twice": 2, "thrice": 3}.get(match[2].lower(), _number(match[2]))
        return ("multiple", match[1], match[3], factor) if factor is not None else None
    compact = (
        re.sub(r"\s+", "", text)
        .replace("≠", "!=")
        .replace("≤", "<=")
        .replace("≥", ">=")
    )
    for pattern, target, base, number in (
        (rf"({IDENTIFIER})=([+-]?\d{{1,6}})\*?({IDENTIFIER})", 1, 3, 2),
        (rf"({IDENTIFIER})=({IDENTIFIER})\*([+-]?\d{{1,6}})", 1, 2, 3),
        (rf"([+-]?\d{{1,6}})\*?({IDENTIFIER})=({IDENTIFIER})", 3, 2, 1),
    ):
        match = re.fullmatch(pattern, compact)
        if match:
            return "multiple", match[target], match[base], int(match[number])
    match = re.fullmatch(
        rf"({IDENTIFIER})\s*(?:是|为|属于|(?i:is\s+(?:an?\s+)?))\s*((?i:{_DOMAIN}))",
        text,
    )
    if match:
        return "domain", match[1], *_domain(match[2])
    match = re.fullmatch(
        rf"({IDENTIFIER})\s*(?:非零|不为零|不等于零|(?i:is nonzero))", text
    )
    if match:
        return "compare", match[1], "!=", 0
    match = re.fullmatch(rf"({IDENTIFIER})([!<>=]=?|=)([+-]?\d{{1,6}})", compact)
    if match and match[2] in {"=", "!=", "<", "<=", ">", ">="}:
        return "compare", match[1], match[2], int(match[3])
    match = re.fullmatch(
        rf"([+-]?\d{{1,6}})(<|<=)({IDENTIFIER})(<|<=)([+-]?\d{{1,6}})", compact
    )
    if match:
        return "interval", match[3], int(match[1]), match[2], int(match[5]), match[4]
    return None


def statement_context(sentence):
    original = sentence.strip().rstrip(".。")
    rest, quantifiers, ranges, premises = original, [], [], []
    explicit = False
    # Keep ordered quantifier blocks; do not swap forall/exists or erase domains.
    for _ in range(4):
        match = re.match(
            rf"^(对于|对)?(所有|任意|每个|某个|存在)\s*({_DOMAIN})\s*({_VARS})\s*[,，:：]\s*(?:使得\s*)?(.+)$",
            rest,
        )
        if match:
            variables = _variables(match[4])
            if variables is None:
                return StatementContext(original, complete=False, explicit=True)
            quantifiers.append(
                (
                    "exists" if match[2] in {"某个", "存在"} else "forall",
                    variables,
                    _domain(match[3]),
                )
            )
            rest, explicit = match[5], True
            continue
        match = re.match(
            rf"^(for all|for every|for each|for some|there exists?)\s+({_DOMAIN})\s+({_VARS})\s*,\s*(?:such that\s+)?(.+)$",
            rest,
            re.IGNORECASE,
        )
        if match:
            variables = _variables(match[3])
            if variables is None:
                return StatementContext(original, complete=False, explicit=True)
            quantifiers.append(
                (
                    "exists"
                    if match[1].lower().startswith(("for some", "there exist"))
                    else "forall",
                    variables,
                    _domain(match[2]),
                )
            )
            rest, explicit = match[4], True
            continue
        break
    match = re.match(r"^在(直角三角形|三角形)\s*([A-Z]{3})\s*中\s*[,，]\s*(.+)$", rest)
    if match:
        ranges.append(
            (
                "geometry",
                "right_triangle" if match[1] == "直角三角形" else "triangle",
                match[2],
            )
        )
        rest, explicit = match[3], True
    else:
        match = re.match(
            r"^In (?:the |a )?(right(?:[- ]angled)? triangle|triangle)\s+([A-Z]{3}),\s*(.+)$",
            rest,
            re.IGNORECASE,
        )
        if match:
            if re.fullmatch(r"[A-Za-z]{3}", match[2]) is None:
                return StatementContext(original, complete=False, explicit=True)
            ranges.append(
                (
                    "geometry",
                    "right_triangle"
                    if match[1].lower().startswith("right")
                    else "triangle",
                    match[2],
                )
            )
            rest, explicit = match[3], True
    match = re.match(rf"^在({_DOMAIN})范围内\s*[,，]\s*(.+)$", rest)
    if match:
        ranges.append(("domain", *_domain(match[1])))
        rest, explicit = match[2], True
    else:
        match = re.match(rf"^Over (?:the )?({_DOMAIN}),\s*(.+)$", rest, re.IGNORECASE)
        if match:
            ranges.append(("domain", *_domain(match[1])))
            rest, explicit = match[2], True
    condition = None
    match = re.match(
        r"^(?:若|如果|只要)\s*(.+?)\s*[,，]\s*(?:则|那么|就)\s*(.+)$", rest
    )
    if match:
        condition, rest, explicit = match[1], match[2], True
    else:
        match = re.match(r"^If\s+(.+?),\s*(?:then\s+)?(.+)$", rest, re.IGNORECASE)
        if match:
            condition, rest, explicit = match[1], match[2], True
    if condition is None:
        match = re.fullmatch(r"(.+?)\s+(?i:with)\s+(.+)", rest)
        if match:
            rest, condition, explicit = match[1], match[2], True
    membership = re.fullmatch(
        rf"(.+?)[,，]\s*({IDENTIFIER})\s*(?:∈|(?i:in)\s+)\s*([RZNℝℤℕ])", rest
    )
    if membership:
        ranges.append(
            (
                "membership",
                membership[2],
                {
                    "R": "real",
                    "ℝ": "real",
                    "Z": "integer",
                    "ℤ": "integer",
                    "N": "natural",
                    "ℕ": "natural",
                }[membership[3]],
            )
        )
        rest, explicit = membership[1], True
    if condition is not None:
        parts = re.split(r"并且|而且|且|\s+and\s+", condition, flags=re.IGNORECASE)
        atoms = [_atom(part) for part in parts]
        if not atoms or any(atom is None for atom in atoms):
            return StatementContext(original, complete=False, explicit=True)
        for atom in atoms:
            if atom[0] == "domain" and atom[3] != "any":
                premises.append(("domain", atom[1], atom[2], "any"))
                premises.append(
                    (
                        "compare",
                        atom[1],
                        {
                            "nonzero": "!=",
                            "positive": ">",
                            "negative": "<",
                            "nonnegative": ">=",
                        }[atom[3]],
                        0,
                    )
                )
            else:
                premises.append(atom)
        premises = sorted(set(premises))
    # Unknown leading/trailing conditions and quantifiers are NOT dropped. The
    # conclusion may be recognizable, but its equivalence remains UNASSESSED.
    unknown = bool(_CONTEXT_MARKER.search(rest)) or bool(
        re.match(r"^(?:在.+(?:中|内|下)|In\s+|Over\s+|For\s+)", rest, re.IGNORECASE)
    )
    unknown = unknown or bool(
        re.search(
            r"[（(][^()（）]*(?:[=<>≠≤≥]|[\u4e00-\u9fff]{2,}|[A-Za-z]{2,})[^()（）]*[)）]",
            rest,
        )
    )
    return StatementContext(
        rest,
        tuple(premises),
        tuple(quantifiers),
        tuple(ranges),
        not unknown,
        explicit or unknown,
    )


@dataclass(frozen=True)
class StatementSegment:
    raw: str
    frame: StatementContext


def statement_segments(text):
    """One shared scope boundary for formula, prose and UNASSESSED paths.

    Delimiters inside brackets/quotes are data. A multi-part delivery containing
    any scope/continuation marker is not licensed as independent statements: keep
    the group UNASSESSED instead of detaching a consequent from its antecedent.
    This intentionally does not infer where a paragraph-wide assumption ends.
    """
    pieces, stack, quote, escaped = [], [], None, False
    start = 0
    pairs = {")": "(", "]": "[", "}": "{", "）": "（"}
    balanced, boundary = True, True
    for index, char in enumerate(text):
        # Stop BEFORE scanning task text. Its broken parentheses/quotes belong
        # to the task parser, not to the already delivered mathematical prefix.
        if boundary and not stack and not quote and not char.isspace():
            if balanced and re.match(
                r"(?:NEXT(?:\s+[1-3])?|JOIN):", text[index:], re.IGNORECASE
            ):
                text = text[:start]
                break
            boundary = False
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {'"', "`", "'", "“", "‘"} and not (
            char == "'"
            and index > 0
            and index + 1 < len(text)
            and text[index - 1].isalpha()
            and text[index + 1].isalpha()
        ):
            quote = {"“": "”", "‘": "’"}.get(char, char)
        elif char in "([{（":
            stack.append(char)
        elif char in pairs:
            if not stack or stack.pop() != pairs[char]:
                balanced = False
        elif not stack and (
            char in "。;；\n\r"
            or (char == "." and (index + 1 == len(text) or text[index + 1].isspace()))
        ):
            if text[start:index].strip():
                pieces.append((text[start:index].strip(), start))
            start = index + 1
            boundary = True
    if text[start:].strip():
        pieces.append((text[start:].strip(), start))
    if quote or stack or not balanced:
        return (
            StatementSegment(
                text, StatementContext(text, complete=False, explicit=True)
            ),
        )
    prefix = text
    parts = [part for part, _ in pieces]
    if not parts:
        return ()
    if len(parts) > 64:
        return (
            StatementSegment(
                prefix, StatementContext(prefix, complete=False, explicit=True)
            ),
        )
    frames = [
        statement_context(part)
        if len(part) <= 2000
        else StatementContext(part, complete=False, explicit=True)
        for part in parts
    ]
    if len(parts) > 1 and any(frame.explicit for frame in frames):
        return (
            StatementSegment(
                prefix, StatementContext(prefix, complete=False, explicit=True)
            ),
        )
    return tuple(StatementSegment(part, frame) for part, frame in zip(parts, frames))
