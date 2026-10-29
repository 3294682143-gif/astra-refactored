"""Bounded bilingual mathematical-claim signals for scheduling, never truth.

Typed relations and their objects/qualifiers are retained in a canonical key.
This is deliberately not a general semantic verifier, nor a reward for arbitrary
new prose. Unrecognized text produces no positive claim signal; original artifacts remain
unchanged. Adding a predicate requires positive, paraphrase and negative tests.
"""

import re
from dataclasses import dataclass, replace

from .claim_context import IDENTIFIER, statement_segments
from .progress_formula import formula_signal, math_identifiers
from .runtime.config import fingerprint

CONCEPTS = {
    "triangle": r"\btriangles?\b|三角形",
    "right_triangle": r"\bright(?:[- ]angled)? triangle\b|直角三角形",
    "hypotenuse": r"\bhypotenuse\b|斜边",
    "midpoint": r"\bmidpoints?\b|中点",
    "circumcenter": r"\bcircumcent(?:er|re)s?\b|外心",
    "equidistant": r"\bequidistant\b|等距|距离相等",
    "vertices": r"\bvert(?:ex|ices)\b|顶点",
    "parallel": r"\bparallel\b|平行",
    "perpendicular": r"\bperpendicular\b|垂直",
    "collinear": r"\bcollinear\b|共线",
    "concyclic": r"\bconcyclic\b|共圆",
    "bijection": r"\bbijection\b|一一对应|双射",
    "counting": r"\bcount(?:ing|ed)?\b|计数|数目|出现",
    "partition": r"\b(?:cases?|partition)\b|分类|情况|划分",
    "divisibility": r"\b(?:divides|divisibility|divisible)\b|整除",
    "parity": r"\b(?:odd|even|parity)\b|奇数|偶数|奇偶",
    "objects": r"\bobjects?\b|对象",
    "sets": r"\bsets?\b|集合",
    "identity": r"\bidentit(?:y|ies)\b|恒等式",
    "polynomial": r"\bpolynomials?\b|多项式",
    "inequality": r"\binequalit(?:y|ies)\b|不等式",
}
_QUALIFIERS = {"right_triangle", "hypotenuse", "midpoint"}


@dataclass(frozen=True)
class ClaimSignal:
    key: str
    objects: frozenset[str]
    concepts: frozenset[str]
    predicate: str


def concepts(text):
    return frozenset(
        name
        for name, pattern in CONCEPTS.items()
        if re.search(pattern, text, re.IGNORECASE)
    )


def objects(text):
    labels = set(math_identifiers(text))
    for match in re.finditer(r"(?<![A-Za-z0-9_])([A-Z]{1,3})(?![A-Za-z0-9_])", text):
        # English indefinite article, not geometric point A.
        if match[1] == "A" and re.match(
            r"\s+(?:point|triangle|bijection|set|midpoint)\b",
            text[match.end() :],
            re.IGNORECASE,
        ):
            continue
        labels.update(match[1])
    return frozenset(labels)


def _signal(predicate, roles, sentence):
    tags = concepts(sentence)
    polarity = bool(
        re.search(
            r"\b(?:not|never)\b|不(?:是|相|等|共|平行|垂直)|非", sentence, re.IGNORECASE
        )
    )
    numbers = tuple(re.findall(r"(?<![A-Za-z0-9])\d+(?:\.\d+)?", sentence))
    key = fingerprint((predicate, roles, sorted(tags & _QUALIFIERS), polarity, numbers))
    return ClaimSignal(
        "prose:" + key,
        objects(" ".join(roles)) if roles else frozenset(),
        tags,
        predicate,
    )


def claims(text, *, segments=None):
    signals = []
    for segment in statement_segments(text) if segments is None else segments:
        sentence, frame = segment.raw, segment.frame
        if not sentence.strip() or len(sentence) > 2000:
            continue
        if re.search(
            r"\b(?:need to|should|try to|must prove|conjecture|perhaps)\b|需要|待证|尝试|猜想|可能|是否",
            sentence,
            re.IGNORECASE,
        ):
            continue
        if not frame.complete:
            continue
        sentence = frame.conclusion
        first_signal = len(signals)
        tags = concepts(sentence)
        # Point-to-points relation: keep the subject distinct from its targets.
        match = re.search(
            r"(?:中点|点)\s*([A-Z])\s*到\s*([A-Z](?:\s*[、,，和及]\s*[A-Z]){1,7}).{0,20}(?:等距|距离相等)",
            sentence,
        )
        if match is None:
            match = re.search(
                r"(?:point|midpoint)\s+([A-Z])\b.{0,100}?\bequidistant\s+from\s+([A-Z](?:\s*(?:,\s*(?:and\s+)?|and\s+)[A-Z]){1,7})",
                sentence,
                re.IGNORECASE,
            )
        if match:
            subject, targets = match[1], tuple(sorted(objects(match[2])))
            if len(targets) >= 2:
                signals.append(_signal("equidistant", (subject, *targets), sentence))
        # A general characterization has conceptual bindings instead of named
        # points. Direction matters; the converse is not silently identified.
        if {"equidistant", "circumcenter", "triangle", "vertices"} <= tags:
            eq = re.search(CONCEPTS["equidistant"], sentence, re.IGNORECASE)
            center = re.search(CONCEPTS["circumcenter"], sentence, re.IGNORECASE)
            direction = (
                "equidistant_implies_center"
                if eq.start() < center.start()
                else "center_implies_equidistant"
            )
            if re.search(
                r"\bis\b|\bare\b|是|外心.*(?:等距|距离相等)", sentence, re.IGNORECASE
            ):
                signals.append(
                    _signal(direction, tuple(sorted(objects(sentence))), sentence)
                )
        for predicate, word in (("parallel", "平行"), ("perpendicular", "垂直")):
            match = re.search(
                rf"([A-Z]{{1,2}})\s*(?:与|和)\s*([A-Z]{{1,2}})\s*(?:相互)?{word}",
                sentence,
            )
            if match is None:
                match = re.search(
                    rf"\b([A-Z]{{1,2}})\s+(?:is\s+)?{predicate}\s+to\s+([A-Z]{{1,2}})\b",
                    sentence,
                )
            if match:
                signals.append(
                    _signal(predicate, tuple(sorted(match.groups())), sentence)
                )
        for predicate, word, minimum in (
            ("collinear", "共线", 3),
            ("concyclic", "共圆", 4),
        ):
            if predicate in tags:
                names = tuple(sorted(objects(sentence)))
                if len(names) >= minimum and re.search(
                    rf"{word}|\b(?:are|lie)\b", sentence, re.IGNORECASE
                ):
                    signals.append(_signal(predicate, names, sentence))
        if "bijection" in tags:
            match = re.search(
                r"集合\s*([A-Z])\s*(?:与|和)\s*(?:集合\s*)?([A-Z]).{0,25}(?:一一对应|双射)",
                sentence,
            )
            if match is None:
                match = re.search(
                    r"\bbijection between (?:the )?sets?\s+([A-Z])\s+and\s+(?:set\s+)?([A-Z])\b",
                    sentence,
                )
            if match:
                signals.append(
                    _signal("bijection", tuple(sorted(match.groups())), sentence)
                )
        if re.search(
            r"每个对象恰好(?:被计数|出现)一次|\beach object is counted exactly once\b",
            sentence,
            re.IGNORECASE,
        ):
            signals.append(
                _signal("counted_once", tuple(sorted(objects(sentence))), sentence)
            )
        if re.search(
            r"两两互斥|pairwise disjoint", sentence, re.IGNORECASE
        ) and re.search(r"覆盖全部|exhaustive", sentence, re.IGNORECASE):
            signals.append(
                _signal(
                    "exhaustive_partition", tuple(sorted(objects(sentence))), sentence
                )
            )
        conclusion = re.sub(
            r"^(?:因此|所以|结论[:：]?|Thus[,：:]?|Therefore[,：:]?|Conclusion:)\s*",
            "",
            sentence.strip(),
            flags=re.IGNORECASE,
        )
        match = re.fullmatch(
            rf"({IDENTIFIER})\s*(?:整除|(?i:divides\s+))\s*({IDENTIFIER})[.]?",
            conclusion,
        )
        if match:
            signals.append(_signal("divides", match.groups(), sentence))
        if frame.explicit:
            signals[first_signal:] = [
                replace(signal, key="prose:" + fingerprint((signal.key, frame.binding)))
                for signal in signals[first_signal:]
            ]
    return tuple(signals)


def related_keys(text, target, context=(), *, segments=None):
    binding = target + "\n" + "\n".join(context)
    known_objects, known_concepts = objects(binding), concepts(binding)
    related = set()
    for claim in claims(text, segments=segments):
        if claim.predicate == "bijection" and not known_concepts & {
            "counting",
            "bijection",
            "sets",
            "partition",
        }:
            continue
        if claim.objects:
            bound = bool(claim.objects & known_objects)
        else:
            bound = len(claim.concepts & known_concepts) >= 2 or (
                claim.predicate == "exhaustive_partition"
                and "partition" in known_concepts
            )
        if bound:
            related.add(claim.key)
    return related


def unassessed_statement(text, target, context=(), *, segments=None):
    """Unrecognized related assertions earn no reward and no stagnation verdict."""
    binding = target + "\n" + "\n".join(context)
    known_concepts, known_objects = concepts(binding), objects(binding)
    if not known_concepts and not known_objects:
        return False
    for segment in statement_segments(text) if segments is None else segments:
        sentence, frame = segment.raw, segment.frame
        formula = formula_signal(frame)
        if frame.complete and (
            claims(sentence, segments=(segment,)) or formula.key is not None
        ):
            continue  # Recognized duplicates/unrelated propositions remain NONE.
        if re.search(
            r"\b(?:need to|should|try to|must prove)\b|需要|待证|尝试|是否",
            sentence,
            re.IGNORECASE,
        ):
            continue
        has_binding = (
            bool(objects(sentence) & known_objects)
            or len(concepts(sentence) & known_concepts) >= 2
            or (
                not known_objects
                and bool(formula.objects)
                and bool(known_concepts & {"identity", "polynomial", "inequality"})
            )
        )
        assertion = (
            (frame.explicit and not frame.complete)
            or formula.unconsumed
            or "divisibility" in concepts(sentence)
            or re.search(
                r"\b(?:is|are|has|have|lies?|contains?|implies)\b|是|位于|存在|属于|具有|经过|在.{1,40}上",
                sentence,
                re.IGNORECASE,
            )
        )
        if has_binding and assertion:
            return True
    return False
