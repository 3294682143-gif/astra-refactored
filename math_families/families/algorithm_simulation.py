"""algorithm_simulation family.

Structural criterion: deterministic simulation of a coding/algorithmic
process, with presentation of the result parameterized separately from its
content. Instances are textbook-size; the point is exact, re-checkable
simulation whose certificates are typography-agnostic.

Tools:
- lz78_encode: phrase decomposition of a message under LZ78 (greedy longest
  match in a growing dictionary, entry 0 = empty word). Certificate: the
  decoded phrase words; self-check: decode(encode(x)) == x round trip.
- lz78_decode: rebuild a message from an (index, symbol) phrase list.
  Self-check: greedy re-encode detects non-canonical phrase lists.
- lz78_bit_string: fixed-width binary rendering of phrases under a given
  symbol code. Self-check: fixed-width re-parse round trip.
- format_phrases: parameterized typography (separator, LaTeX wrapping,
  parenthesized vs subscript pairs, optional decoded-words tail).
  Self-check: re-parse of the rendered text round trip.
- verify_phrases: independent certificate checker for a phrase list against
  a message.

Conventions: a phrase is a pair (index, symbol); index 0 denotes the empty
word, and dictionary entry k (k >= 1) is the word built by the k-th phrase.
A phrase may carry an empty symbol "" only as the final phrase, when the
message ends exactly on a dictionary word.
"""
from __future__ import annotations

import re

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible

#: Caps keeping every simulation interruptible and certificates cheap.
_MAX_MESSAGE_SYMBOLS = 200_000
_MAX_PHRASES = 200_000
_MAX_DECODED_SYMBOLS = 5_000_000

#: Symbols that would make a rendered pair ambiguous to re-parse.
_UNRENDERABLE = set("(),{}_\\ \t")


class _DecodedTooLarge(Exception):
    """Raised internally when a decode exceeds the decoded-length budget."""


# --------------------------------------------------------------------- #
# Internal phrase engine (validated, normalized pairs only)
# --------------------------------------------------------------------- #
def _normalize_phrases(phrases) -> list[tuple[int, str]]:
    """Validate structure: each phrase is an (int, single-symbol) pair."""
    norm = []
    for k, pair in enumerate(phrases):
        if not isinstance(pair, (tuple, list)) or len(pair) != 2:
            raise ValueError(f"phrase {k} must be a pair (index, symbol)")
        idx, char = pair
        if not isinstance(idx, int) or isinstance(idx, bool) or idx < 0:
            raise ValueError(f"phrase {k}: index must be a non-negative int")
        if not isinstance(char, str) or len(char) > 1:
            raise ValueError(f"phrase {k}: symbol must be a single character or ''")
        norm.append((idx, char))
    return norm


def _encode_phrases(message: str) -> list[tuple[int, str]]:
    """Greedy longest-match LZ78 parse; dictionary entry 0 is the empty word."""
    index_of = {"": 0}
    phrases: list[tuple[int, str]] = []
    i, n = 0, len(message)
    while i < n:
        j = i
        while j < n and message[i : j + 1] in index_of:
            j += 1
        word = message[i:j]
        char = message[j] if j < n else ""
        phrases.append((index_of[word], char))
        if word + char not in index_of:
            index_of[word + char] = len(index_of)
        i = j + 1
    return phrases


def _decode_words(norm: list[tuple[int, str]], limit: int | None) -> tuple[str, list[str]]:
    """Decode normalized phrases to (message, phrase_words).

    Raises ValueError on forward references; raises _DecodedTooLarge when the
    running decoded length exceeds ``limit``.
    """
    dict_words = [""]
    seen = {""}
    parts: list[str] = []
    total = 0
    for k, (idx, char) in enumerate(norm):
        if idx >= len(dict_words):
            raise ValueError(
                f"phrase {k}: index {idx} references a dictionary entry not yet "
                f"built (only {len(dict_words)} entries exist)"
            )
        w = dict_words[idx] + char
        parts.append(w)
        total += len(w)
        if limit is not None and total > limit:
            raise _DecodedTooLarge(f"decoded length exceeds {limit} symbols at phrase {k}")
        if w not in seen:
            seen.add(w)
            dict_words.append(w)
    return "".join(parts), parts


# --------------------------------------------------------------------- #
# 1. LZ78 encode
# --------------------------------------------------------------------- #
def lz78_encode(message: str) -> Evidence:
    """Phrase decomposition of ``message`` under LZ78.

    Certificate: the decoded phrase words (each word minus its last symbol
    must be an earlier word; concatenation must be the message — checkable
    with ``verify_phrases``). Self-check: decode(encode(message)) == message.
    """
    if not isinstance(message, str):
        raise ValueError("message must be a string")
    n = len(message)
    if n > _MAX_MESSAGE_SYMBOLS:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"message has {n} symbols > {_MAX_MESSAGE_SYMBOLS}",
                "O(n * max_word_len) dictionary probes",
            ),
            complexity_bound="O(n * max_word_len)",
        )

    phrases = _encode_phrases(message)
    decoded, words = _decode_words(phrases, limit=None)
    ok = decoded == message
    max_word = max((len(w) for w in words), default=0)
    return Evidence(
        value=phrases,
        certificate=f"phrase_words={words}",
        self_check=f"decode(encode(message))==message: {'ok' if ok else 'MISMATCH'}",
        feasibility="ok",
        complexity_bound=f"O(n * max_word_len) = O({n}*{max_word}); {len(phrases)} phrases",
    )


# --------------------------------------------------------------------- #
# 2. LZ78 decode
# --------------------------------------------------------------------- #
def lz78_decode(phrases) -> Evidence:
    """Rebuild the message from an (index, symbol) phrase list.

    Certificate: the phrase words. Self-check: greedy re-encode of the
    decoded message — a mismatch means the input list was decodable but not
    greedy-canonical (LZ78 parses are unique), which is reported, not hidden.
    """
    norm = _normalize_phrases(phrases)
    if len(norm) > _MAX_PHRASES:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"{len(norm)} phrases > {_MAX_PHRASES}", "O(total decoded length)"
            ),
            complexity_bound="O(total decoded length)",
        )
    try:
        decoded, words = _decode_words(norm, limit=_MAX_DECODED_SYMBOLS)
    except _DecodedTooLarge as exc:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"aborted: {exc}",
            feasibility=infeasible(str(exc), "O(total decoded length)"),
            complexity_bound="O(total decoded length)",
        )

    if len(decoded) <= _MAX_MESSAGE_SYMBOLS:
        same = _encode_phrases(decoded) == norm
        check = "ok" if same else "differs: input phrase list is not greedy-canonical"
    else:
        check = "re-encode skipped: decoded longer than encode budget"
    return Evidence(
        value=decoded,
        certificate=f"phrase_words={words}",
        self_check=f"reencode(decoded)==phrases: {check}",
        feasibility="ok",
        complexity_bound=f"O(total) = O({len(decoded)}) symbols; {len(norm)} phrases",
    )


def verify_phrases(phrases, message: str) -> bool:
    """Independent certificate checker: the phrase list must decode to
    exactly ``message`` using only valid back-references."""
    try:
        norm = _normalize_phrases(phrases)
        decoded, _ = _decode_words(norm, limit=len(message) + 1)
    except (ValueError, _DecodedTooLarge):
        return False
    return decoded == message


# --------------------------------------------------------------------- #
# 3. Fixed-width binary rendering
# --------------------------------------------------------------------- #
def lz78_bit_string(phrases, symbol_code: dict[str, str], index_bits: int) -> Evidence:
    """Render phrases as a bit string: per phrase, an ``index_bits``-wide
    binary index followed by the symbol's code word.

    ``symbol_code`` maps single symbols to equal-length binary strings and
    must be injective. Every phrase must carry a non-empty symbol (an
    empty-tail final phrase has no fixed-width rendering). Certificate:
    per-phrase bit groups; self-check: fixed-width re-parse round trip.
    """
    if not isinstance(index_bits, int) or index_bits < 1:
        raise ValueError("index_bits must be a positive int")
    if not symbol_code:
        raise ValueError("symbol_code must be a non-empty dict symbol -> bitstring")
    widths = {len(b) for b in symbol_code.values()}
    if len(widths) != 1 or not all(b and set(b) <= {"0", "1"} for b in symbol_code.values()):
        raise ValueError("symbol_code values must be equal-length nonempty binary strings")
    if len(set(symbol_code.values())) != len(symbol_code):
        raise ValueError("symbol_code must be injective (distinct code words)")

    norm = _normalize_phrases(phrases)
    if len(norm) > _MAX_PHRASES:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(f"{len(norm)} phrases > {_MAX_PHRASES}", "O(phrases)"),
            complexity_bound="O(phrases)",
        )
    sym_bits = widths.pop()
    groups = []
    for k, (idx, char) in enumerate(norm):
        if char not in symbol_code:  # also catches the empty-tail symbol ""
            raise ValueError(f"phrase {k}: symbol {char!r} has no code word")
        if idx >= 1 << index_bits:
            return Evidence(
                value=None,
                certificate="",
                self_check=f"aborted at phrase {k}",
                feasibility=infeasible(
                    f"phrase index {idx} needs {idx.bit_length()} bits > index_bits {index_bits}",
                    f"O({len(norm)} phrases)",
                ),
                complexity_bound="O(phrases)",
            )
        groups.append(f"{idx:0{index_bits}b}{symbol_code[char]}")
    bits = "".join(groups)

    inv = {b: s for s, b in symbol_code.items()}
    width = index_bits + sym_bits
    back = [
        (int(bits[i : i + index_bits], 2), inv[bits[i + index_bits : i + width]])
        for i in range(0, len(bits), width)
    ]
    ok = back == norm
    return Evidence(
        value=bits,
        certificate=f"groups={groups}",
        self_check=(
            f"reparse({len(norm)} phrases, width {width})==phrases: "
            f"{'ok' if ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=f"O(phrases * width) = O({len(norm)}*{width})",
    )


# --------------------------------------------------------------------- #
# 4. Parameterized typography
# --------------------------------------------------------------------- #
_FORMAT_STYLES = {
    "plain": {"sep": " ", "latex": False, "with_words": False, "pair": "paren"},
    "comma": {"sep": ", ", "latex": False, "with_words": False, "pair": "paren"},
    "latex": {"sep": ",\\ ", "latex": True, "with_words": False, "pair": "paren"},
    "subscript": {"sep": "\\ ", "latex": True, "with_words": False, "pair": "subscript"},
    "words": {"sep": " ", "latex": False, "with_words": True, "pair": "paren"},
}


def _render_pair(idx: int, char: str, pair: str) -> str:
    if pair == "paren":
        return f"({idx},{char})"
    return f"{char}_{{{idx}}}"


def _parse_rendered(text: str, pair: str) -> list[tuple[int, str]]:
    if pair == "paren":
        return [(int(i), c) for i, c in re.findall(r"\((\d+),([^(),\s]*)\)", text)]
    return [(int(i), c) for c, i in re.findall(r"([^\s_{},()\[\]\\]*)_\{(\d+)\}", text)]


def format_phrases(
    phrases,
    style: str = "comma",
    *,
    sep: str | None = None,
    latex: bool | None = None,
    with_words: bool | None = None,
    pair: str | None = None,
) -> Evidence:
    """Typeset a phrase list; layout is parameterized, content is not.

    ``style`` picks a preset from ``_FORMAT_STYLES``; the keyword overrides
    tune ``sep`` (separator), ``latex`` (wrap in \\[ ... \\]), ``pair``
    ("paren" renders (0,a); "subscript" renders a_{0}) and ``with_words``
    (append the decoded phrase words after " : ").

    Certificate: the resolved layout parameters; self-check: re-parsing the
    rendered text with the same layout reproduces the input phrases.
    """
    if style not in _FORMAT_STYLES:
        raise ValueError(f"unknown style {style!r}; choose from {sorted(_FORMAT_STYLES)}")
    layout = dict(_FORMAT_STYLES[style])
    for key, val in (("sep", sep), ("latex", latex), ("with_words", with_words), ("pair", pair)):
        if val is not None:
            layout[key] = val
    if layout["pair"] not in ("paren", "subscript"):
        raise ValueError("pair must be 'paren' or 'subscript'")

    norm = _normalize_phrases(phrases)
    if len(norm) > _MAX_PHRASES:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(f"{len(norm)} phrases > {_MAX_PHRASES}", "O(phrases)"),
            complexity_bound="O(phrases)",
        )
    for k, (_, char) in enumerate(norm):
        if char and set(char) & _UNRENDERABLE:
            raise ValueError(f"phrase {k}: symbol {char!r} cannot be rendered unambiguously")

    body = layout["sep"].join(_render_pair(i, c, layout["pair"]) for i, c in norm)
    text = f"\\[{body}\\]" if layout["latex"] else body
    if layout["with_words"]:
        try:
            _, words = _decode_words(norm, limit=_MAX_DECODED_SYMBOLS)
        except _DecodedTooLarge as exc:
            return Evidence(
                value=None,
                certificate="",
                self_check=f"aborted: {exc}",
                feasibility=infeasible(str(exc), "O(total decoded length)"),
                complexity_bound="O(phrases + total decoded length)",
            )
        text = f"{text} : {' '.join(words)}"

    ok = _parse_rendered(text, layout["pair"]) == norm
    return Evidence(
        value=text,
        certificate=f"layout={layout}",
        self_check=f"reparse(rendered)==phrases: {'ok' if ok else 'MISMATCH'}",
        feasibility="ok",
        complexity_bound=f"O(phrases) = O({len(norm)})",
    )


# --------------------------------------------------------------------- #
# Evidence wrappers (W3): raw checkers stay as subroutines; the
# Evidence-returning variants are what the tool tiers consume (§1.1).
# --------------------------------------------------------------------- #
def verify_phrases_evidence(phrases, message: str) -> Evidence:
    """Independent LZ78 phrase-certificate check, as Evidence.

    Self-check: the wrapper's value is exactly the independent
    decode-and-compare checker's verdict (the certificate is the checker
    itself — deterministic, no search).
    """
    ok = verify_phrases(phrases, message)
    return Evidence(
        value=ok,
        certificate=f"decoded==message: {ok}; message_len={len(message)}",
        self_check="independent decode-and-compare checker executed deterministically",
        feasibility="ok",
        complexity_bound="O(total symbols)",
    )
