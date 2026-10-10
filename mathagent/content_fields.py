"""Bounded role-label extraction; never rewrites mathematical punctuation/text."""

import re


def fields(text, labels, *, after_math=False, adjacent_labels=()):
    alternatives = "|".join(labels)
    math_boundary = r"|(?<=[}$])\s+" if after_math else ""
    pattern = rf"(?:^|[;；\n]\s*|(?<=[.!。])\s+{math_boundary})(?P<label>{alternatives})\s*[:：]\s*"
    matches = list(re.finditer(pattern, text, re.IGNORECASE))
    if adjacent_labels:
        # Opt-in for reserved protocol labels only. Mathematical text and quoted
        # labels still pass through the same delimiter/quote filter below.
        adjacent = "|".join(re.escape(label) for label in adjacent_labels)
        matches += list(
            re.finditer(rf"(?<![\w])(?P<label>{adjacent})\s*[:：]\s*", text)
        )
        by_label = {}
        for match in matches:
            by_label.setdefault(match.start("label"), match)
        matches = sorted(by_label.values(), key=lambda match: match.start("label"))
    # Reserved labels inside quoted strings or mathematical delimiters are data.
    accepted, cursor, depth, quote, escaped = [], 0, 0, None, False
    for match in matches:
        boundary = match.start("label")
        while cursor < boundary:
            char = text[cursor]
            previous = text[cursor - 1] if cursor else ""
            if quote:
                if char == quote and not escaped:
                    quote = None
            elif (
                char in {'"', "'"}
                and not escaped
                and (char == '"' or not previous.isalnum())
            ):
                quote = char
            elif char in "([{":
                depth += 1
            elif char in ")]}":
                depth = max(0, depth - 1)
            escaped = char == "\\" and not escaped
            cursor += 1
        if not quote and depth == 0:
            accepted.append(match)
    matches = accepted
    return tuple(
        (
            re.sub(r"\s+", " ", match["label"].upper()),
            text[
                match.end() : matches[index + 1].start()
                if index + 1 < len(matches)
                else len(text)
            ].strip(),
        )
        for index, match in enumerate(matches)
    )
