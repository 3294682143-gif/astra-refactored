"""Canonical answer-key parity: vectors shared with the Node Loop.

The ballot in ``agent_history.project_artifacts`` counts canonical answer keys,
not raw text, so ``1/2`` and ``\\frac12`` can no longer split one correct answer
into two one-vote minorities.

``tests/bridge/fixtures/canonical_answer_keys.v2.json`` is the language-neutral
parity file: it carries only *relations* (these inputs share a key / these two
must not), so the Node test for ``canonicalAnswerKey`` can read the very same
file, plus a Python-only table of literal key strings.

A key is a comparison token. These tests never assert that an answer is
mathematically correct; a key only decides whether two answers are the same
string modulo presentation.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from python.astra_bridge.answer_semantics import canonical_answer_key
from python.astra_bridge.agent_history import ballot_choice

VECTORS = Path(__file__).resolve().parent / "fixtures" / "canonical_answer_keys.v2.json"


def _data():
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def _same():
    return _data()["same"]


def _different():
    return _data()["different"]


def _python_keys():
    return _data()["pythonKeys"]


def test_vector_file_is_well_formed():
    data = _data()
    assert data["contractVersion"] == 2
    assert data["same"] and data["different"] and data["pythonKeys"]
    for group in data["same"]:
        assert len(group["inputs"]) >= 2
    for pair in data["different"]:
        assert isinstance(pair["left"], str) and isinstance(pair["right"], str)


@pytest.mark.parametrize("group", _same(), ids=[g["group"] for g in _same()])
def test_equivalent_answers_share_one_key(group):
    keys = {canonical_answer_key(text) for text in group["inputs"]}
    assert len(keys) == 1, (group["group"], keys)


@pytest.mark.parametrize("pair", _different(), ids=[p["group"] for p in _different()])
def test_different_answers_keep_different_keys(pair):
    assert canonical_answer_key(pair["left"]) != canonical_answer_key(pair["right"])


@pytest.mark.parametrize("case", _python_keys(), ids=[c["input"] for c in _python_keys()])
def test_literal_key(case):
    assert canonical_answer_key(case["input"]) == case["key"]


def test_rational_forms_share_one_key():
    forms = ["1/2", "\\frac{1}{2}", "\\frac12", "0.5", "2/4"]
    assert {canonical_answer_key(text) for text in forms} == {"rat:1/2"}


def test_finite_set_is_sorted_and_exact():
    assert canonical_answer_key("{2, 1}") == "set:rat:1/1,rat:2/1"
    assert canonical_answer_key("{0.5, 1/2}") == "set:rat:1/2"
    assert canonical_answer_key("{1, x}") != canonical_answer_key("{1, 2}")


def test_whole_answer_option_notation():
    assert canonical_answer_key("(A)") == canonical_answer_key("A") == "options:A"
    assert canonical_answer_key("A\u3001C") == canonical_answer_key("AC")
    assert canonical_answer_key("A\u3001B\u3001C") == "options:A,B,C"


def test_option_notation_never_swallows_a_sentence():
    """A sentence that merely names options is never an option set."""
    for text in (
        "A\u3001B\u3001C \u6b63\u786e\uff0cD \u9519\u8bef",
        "\u53ea\u6709 A \u6b63\u786e",
        "A and C are correct",
        "\u9009\u9879 A",
    ):
        assert not canonical_answer_key(text).startswith("options:"), text
    assert canonical_answer_key(
        "A\u3001B\u3001C \u6b63\u786e\uff0cD \u9519\u8bef"
    ) != canonical_answer_key("A\u3001B\u3001C")


def test_truth_tokens_collapse_without_merging_the_verdicts():
    for text in ("\u6b63\u786e", "\u771f", "TRUE", "yes"):
        assert canonical_answer_key(text) == "truth:true"
    for text in ("\u9519\u8bef", "\u5047", "FALSE", "no"):
        assert canonical_answer_key(text) == "truth:false"
    assert canonical_answer_key("\u6b63\u786e") != canonical_answer_key("\u9519\u8bef")


def test_only_one_wrapper_layer_is_removed():
    assert canonical_answer_key("$1/2$") == "rat:1/2"
    assert canonical_answer_key("\\(\\frac{1}{2}\\)") == "rat:1/2"
    assert canonical_answer_key("\\boxed{\\frac12}") == "rat:1/2"
    # The Node helper unwraps exactly one layer, so the inner boxed form stays
    # text instead of being unwrapped twice.
    assert canonical_answer_key("$\\boxed{\\frac12}$") == "text:\\boxed{\\frac12}"


def test_non_answer_text_is_only_lowercased_and_compacted():
    assert canonical_answer_key(" X = 1 ") == "text:x=1"
    assert canonical_answer_key("x = 1") == canonical_answer_key("X=1")
    assert canonical_answer_key("") == "text:"
    assert canonical_answer_key("   ") == "text:"
    assert canonical_answer_key(None) == "text:"


def test_key_is_a_comparison_token_not_an_answer():
    """The key must never invent a verdict, a number or an option set."""
    for text in (
        "x=1",
        "\u6ca1\u6709\u89e3",
        "not always true",
        "A\u3001B\u3001C \u6b63\u786e\uff0cD \u9519\u8bef",
    ):
        key = canonical_answer_key(text)
        for family in ("truth:", "rat:", "set:", "options:"):
            assert not key.startswith(family), (text, key)
    # A relation is not a polynomial answer and never collapses into one.
    assert canonical_answer_key("x+1=0") != canonical_answer_key("x+1")


# -- ballot parity -----------------------------------------------------------


def test_ballot_counts_canonical_keys_not_raw_text():
    """The consensus ballot must not split one answer into two minorities."""
    # Raw text: three distinct strings, a three-way tie, so the last one wins.
    # Canonical keys: ``1/2`` and ``\\frac12`` are one answer with two votes.
    packets = [("model-1", "1/2"), ("model-2", "\\frac12"), ("model-3", "1/3")]
    assert ballot_choice(packets) == "model-2"


def test_ballot_keeps_the_latest_tie_break():
    packets = [("model-1", "1/2"), ("model-2", "0.5"), ("model-3", "1/2")]
    assert ballot_choice(packets) == "model-3"
    assert ballot_choice(list(reversed(packets))) == "model-1"


def test_ballot_counts_option_polynomial_and_truth_forms():
    options = [("model-1", "A\u3001C"), ("model-2", "AC"), ("model-3", "B")]
    assert ballot_choice(options) == "model-2"
    truth = [("model-1", "\u6b63\u786e"), ("model-2", "true"), ("model-3", "\u9519\u8bef")]
    assert ballot_choice(truth) == "model-2"
    polynomials = [
        ("model-1", "x^2 - x"), ("model-2", "x(x-1)"), ("model-3", "x^2+x"),
    ]
    assert ballot_choice(polynomials) == "model-2"
    sets = [("model-1", "{1, 2}"), ("model-2", "{2,1}"), ("model-3", "{3}")]
    assert ballot_choice(sets) == "model-2"


def test_ballot_leaves_a_single_packet_alone():
    assert ballot_choice([("model-1", "x=1")]) == "model-1"


def test_internal_whitespace_never_merges_adjacent_numbers():
    assert canonical_answer_key("1 2") != canonical_answer_key("12")
    assert canonical_answer_key("1 1/2") != canonical_answer_key("11/2")


def test_huge_numeric_text_is_total_and_stays_text():
    key = canonical_answer_key("x+" + "9" * 420)
    assert key.startswith("text:")
