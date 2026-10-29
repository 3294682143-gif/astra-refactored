"""Deterministic, frozen per-task output caps; no retry or token refunds."""

PROFILES = {"fixed_8192", "scoped_caps_v1", "scoped_caps_v2"}
CLASSES = {
    "full",
    "bounded_review",
    "single_object_check",
    "contract",
    "tool_proposal",
    "binding_repair",
    "local_repair",
    "candidate",
}


def effective_max_tokens(profile, task_class, ceiling):
    if profile not in PROFILES or task_class not in CLASSES:
        raise ValueError("unsupported output profile or task class")
    if type(ceiling) is not int or not 1 <= ceiling <= 8192:
        raise ValueError("invalid global token ceiling")
    requested = (
        8192
        if profile == "fixed_8192"
        else {
            "full": 8192,
            "bounded_review": 4096,
            "single_object_check": 2048,
            "contract": 4096,
            "tool_proposal": 4096,
            "binding_repair": 2048 if profile == "scoped_caps_v2" else 8192,
            "local_repair": 4096 if profile == "scoped_caps_v2" else 8192,
            "candidate": 4096 if profile == "scoped_caps_v2" else 8192,
        }[task_class]
    )
    return min(ceiling, requested)


def task_class(
    *, kind, purpose=None, material="", profile="scoped_caps_v1", position=None, goal=""
):
    if profile not in PROFILES:
        raise ValueError("unsupported request profile")
    if profile == "scoped_caps_v2":
        import re

        full = re.search(
            r"necessity|exhaustiveness|general (?:solution|proof)|all functions|parameter (?:domain|family)|必要性|穷尽|通解|全集|参数族",
            goal + " " + (purpose or ""),
            re.I,
        )
        if full or len((goal + material).encode()) > 8000:
            return "full"
        if (
            purpose in {"BIND_MEMBER", "BINDING_REPAIR"}
            and len(material.encode()) <= 2000
        ):
            return "binding_repair"
        if (
            kind == "REVIEW"
            and position in {"R0", "R3", "R4"}
            and len(material.encode()) <= 4000
        ):
            return "bounded_review"
        if kind in {"REPAIR", "LOCAL_REPAIR"} and len(material.encode()) <= 4000:
            return "local_repair"
        if (
            kind in {"CANDIDATE", "ASSEMBLE", "FALLBACK"}
            and len(material.encode()) <= 4000
        ):
            return "candidate"
    # Long proofs and necessity arguments never receive a short cap by role alone.
    if kind in {"PLAN", "CONTRACT_CLARIFY"}:
        return "contract"
    if kind == "COMPUTE" and len(material) <= 4000:
        return "tool_proposal"
    if purpose in {"MEMBERSHIP", "EXCEPTIONS"} and len(material) <= 2000:
        from .content_fields import fields
        from .solution_branches import BRANCH_LABELS

        entries = fields(material, BRANCH_LABELS)
        if sum(k == "BRANCH" for k, _ in entries) == 1 and (
            ("PARAMETERS", "NONE") in entries
            and ("BRANCH_CONDITIONS", "NONE") in entries
        ):
            return "single_object_check"
    return "full"
