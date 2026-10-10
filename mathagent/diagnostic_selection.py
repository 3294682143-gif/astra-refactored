"""Public-ID diagnostic selection; does not reorder or filter the scored suite."""


def validate_selection(selection):
    if not isinstance(selection, list) or not 1 <= len(selection) <= 3:
        raise ValueError("diagnostic_item_ids must contain 1..3 public IDs")
    if any(
        type(value) not in {str, int} or not str(value).strip() for value in selection
    ):
        raise ValueError("diagnostic public IDs must be integers or nonempty strings")
    if len({str(value) for value in selection}) != len(selection):
        raise ValueError("duplicate diagnostic public ID")
    return selection


def select_diagnostic_items(items, selection=None, *, require_goal_closure=False):
    by_id = {str(item["idx"]): item for item in items}
    if len(by_id) != len(items):
        raise ValueError("duplicate source item ID")
    if selection is None and require_goal_closure:
        import re

        # Public mathematical structure, not an answer key or a hardcoded ID.
        candidate = next(
            (
                item
                for item in items
                if re.search(
                    r"\b(?:find|determine)\s+all\s+functions\b",
                    item["problem"],
                    re.IGNORECASE,
                )
            ),
            None,
        )
        if candidate is not None:
            selection = [candidate["idx"]]
    selected = (
        [str(item["idx"]) for item in items[:3]]
        if selection is None
        else [str(value) for value in validate_selection(selection)]
    )
    if not selected or any(key not in by_id for key in selected):
        raise ValueError("diagnostic selection is outside the original public input")
    return [
        {"idx": "diagnostic:" + key, "problem": by_id[key]["problem"]}
        for key in selected
    ]


def tool_activation_failed(usage, *, required=False):
    attempted = any(row.get("computational_tasks", 0) for row in usage)
    executed = any(row.get("tool_successful", 0) for row in usage)
    return (required or attempted) and not executed
