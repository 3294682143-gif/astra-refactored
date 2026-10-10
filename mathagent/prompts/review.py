"""Independent role prompts; complete review never implies mathematical truth."""

ROLES = {
    "meaning": "Check the original conditions, variables, domains, quantifiers, goal and answer shape. Locate omissions, added assumptions and changed goals.",
    "method": "Check mathematical applicability, assumptions, critical lemmas and bottlenecks. Identify genuinely repeated methods and advise priority.",
    "task_tool": "Check task inputs, expected artifact, completion obligations, dependencies, variable mapping and tool scope. Sampling is not a universal proof.",
}

REVIEW_SUFFIX = " Only review this exact supplied artifact. Inside RESULT write COVERAGE: inspected material; FINDING: specific issue; BASIS: mathematical reason; CHECK: minimal next check. If no concrete issue was found write COVERAGE: inspected material; NO_ISSUE. GAP describes unfinished review, not unresolved mathematics."


def review_goal(role, purpose=None):
    from ..review_tasks import PURPOSES

    if purpose is not None and purpose not in PURPOSES:
        raise ValueError("unknown review purpose")
    extra = (
        " For route advice optionally append ORDER: Route 2, Route 1; WIDTH: 1 or 2; BASIS: mathematical reason. "
        "For a definite applicability position use POSITION: the specific proposition; STANCE: AFFIRMS or DENIES; SCOPE: its exact assumptions. "
        "Uncertain applicability is not an affirmation or denial."
        if role == "method"
        else ""
    )
    return (
        ROLES[role]
        + (" " + PURPOSES[purpose] if purpose else "")
        + REVIEW_SUFFIX
        + extra
        + " Repeat FINDING/BASIS/CHECK for each distinct issue; append UNCOVERED: specific unaudited items when needed."
        + " A new guessed answer is not a counterexample. If alleging an error, identify the exact violated original condition or the missing proof step; request a bounded computation when needed. "
        "Preserve quantifiers (possible versus necessary, one versus all), parameterized answers and the stated operator/norm/transform convention. "
        "Do not replace a finite-step numerical approximation by its analytic limit, or change a definition to match an expected answer."
    )
