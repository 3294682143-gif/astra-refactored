"""Workflow prompt text only; 0.9.0 adds explicit bounded computation contracts.

Control event labels and parsing rules intentionally stay with their owners.
"""

CLOSEOUT_GOAL = "Form one concrete original-problem answer with necessary reasoning and assumptions. Write ANSWER: exact payload; BASIS: derivation; GAPS: unresolved obligations. Do not restart planning or reviews."

UNVERIFIED_PREREQUISITE_SUFFIX = "; no complete mathematical check was obtained."

UNVERIFIED_PREREQUISITE_PREFIX = "Unverified prerequisite: "

ROUTE_TASK_SEPARATOR = "; intended mathematical task: "

ROUTE_METHOD_PREFIX = "Provisional route method (not a verified premise): "

NEXT_CANDIDATE_GOAL = "Using the complete available artifacts, form the original problem candidate. Write ANSWER: concrete answer; BASIS: necessary derivation and assumptions; GAPS: remaining obligations."

JOIN_CANDIDATE_GOAL = "Using the complete available artifacts, form the original problem candidate. Write ANSWER: concrete answer; BASIS: derivation; GAPS: remaining obligations."

SMALLER_WORK_GOAL = "Derive one smaller closed intermediate result from the original problem. State a precise next gap."

SMALLER_TASK_SUFFIX = ". Produce one complete bounded result from the original conditions and complete parents."

SMALLER_TASK_PREFIX = "Resolve this specific remaining mathematical gap: "

INITIAL_CONFLICT_GOAL = "Review only this concrete disagreement. Explain the mathematical basis and minimal check; do not vote or solve the whole problem. Write COVERAGE: supplied conflict; FINDING: specific unresolved issue; BASIS: justification; CHECK: minimal next check. A NO_ISSUE report does not erase earlier doubts."

PLANNING_REPAIR_HINT = (
    " Repair the missing card/routes/task structure in the supplied draft."
)

BRANCH_INTENT_PREFIX = "Proposed next work: "

REPAIR_ANSWER_HINT = (
    "Write ANSWER: concrete answer; BASIS: derivation; GAPS: remaining obligations."
)

TARGETED_CHECK_SUFFIX = " (original challenge NOT discharged):\n"

REPAIR_DERIVATION_HINT = ". Derive a fresh corrected answer from the original conditions; do not assume invalidated parents. "

TARGETED_CHECK_PREFIX = "\nTargeted check material for "

REPAIR_TASK_SEPARATOR = ". Minimal task: "

SPECIFIC_ISSUE_SEPARATOR = "\nSpecific issue: "

REPAIR_BASIS_SEPARATOR = ". Basis: "

REPAIR_ISSUE_PREFIX = "Address this exact issue: "

ARITHMETIC_RESULT_HINT = (
    " RESULT must contain only the exact scalar value for this arithmetic check."
)

TOOL_PROPOSAL_HINT = " If a registered calculation is needed, suggest TOOL: registered_name; INPUT: small JSON object; PURPOSE: exact property; DOMAIN: finite bounds and assumptions; MAPPING: problem variables to arguments. The controller decides whether to execute; never claim execution."

FOLLOWUP_HINT = " If further bounded tasks are needed after this complete artifact, append NEXT: one task, or NEXT 1: first task; NEXT 2: independent second task; optionally JOIN: the task using both outputs. Use at most three local task labels; do not supply internal IDs or claim graph/verification authority."

EXACT_CHECK_HINT = (
    " For suitable bounded local checks, a NEXT task can use an exact checker grammar: "
    "Compute binomial: n=<integer>,k=<integer>; Check arithmetic equality: <expression> = <expression>; "
    "Check polynomial solution: <equation> at x=<value>,y=<value>; "
    "Compute path independence coefficients (low to high): n=<integer>. "
    "These are syntax examples, not facts about SOURCE_PROBLEM. Bind the actual problem variables, "
    "parameters and scope; a verified local example never proves all cases."
)

GENERATED_PYTHON_HINT = ' A separately enabled WASI Python explorer is available with stdlib, SymPy 1.12 and mpmath 1.3.0 (not NumPy/SciPy or host extensions). To propose it use TOOL: generated_python; INPUT: {"code":"bounded Python source"}; PURPOSE: specific exploration; DOMAIN: exact finite bounds; MAPPING: problem variables to code. R3 and the controller decide execution. No network, installation, system commands, host files, or persistent data. Printed claims have no verification authority.'
