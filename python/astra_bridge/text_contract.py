"""Shared ECMAScript whitespace contract for Host-side non-empty checks.

This module is pure data and pure predicates: it has no project imports, no
I/O, no client call and no mathematical selection. It exists so that every
Python non-empty check agrees with the Node ``String.prototype.trim``
whitespace set, which is fixed by the ECMAScript specification and does not
drift with the host Unicode version.

The set is exactly ``WhiteSpace`` + ``LineTerminator``:
``\t \n \v \f \r space``, ``U+00A0``, ``U+1680``, ``U+2000``..``U+200A``,
``U+2028``, ``U+2029``, ``U+202F``, ``U+205F``, ``U+3000`` and ``U+FEFF``.
It deliberately excludes ``U+0085``, ``U+001C``..``U+001F`` and ``U+200B``.

``js_trim`` only decides emptiness; it never rewrites the value a caller
returns, hashes or stores. Raw strings stay byte-exact.
"""

from __future__ import annotations

__all__ = ["JS_WHITESPACE", "is_js_whitespace", "js_trim", "js_nonempty"]

JS_WHITESPACE = frozenset((
    "\t", "\n", "\v", "\f", "\r", " ",
    "\u00a0", "\u1680",
    "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006",
    "\u2007", "\u2008", "\u2009", "\u200a",
    "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff",
))


def is_js_whitespace(ch):
    """True when one character is ECMAScript whitespace."""
    return ch in JS_WHITESPACE


def js_trim(value):
    """ECMAScript ``String.prototype.trim`` over the fixed whitespace set.

    The returned slice is only used to decide emptiness. Callers keep the
    original ``value`` for every return, hash and stored field.
    """
    if not isinstance(value, str):
        raise TypeError("js_trim expects str")
    start = 0
    end = len(value)
    while start < end and value[start] in JS_WHITESPACE:
        start += 1
    while end > start and value[end - 1] in JS_WHITESPACE:
        end -= 1
    return value[start:end]


def js_nonempty(value):
    """True when ``value`` is a string with at least one non-whitespace char."""
    if not isinstance(value, str):
        return False
    return bool(js_trim(value))
