from __future__ import annotations

import re
from dataclasses import dataclass, field

from .content_fields import fields as content_fields
from .domain import Route
from .computation_policy import OPERATION_FIELDS, intent
from dataclasses import asdict
from .goal_contracts import (
    LABELS,
    ContractProposal,
    contract_fields,
    parse_proposal,
    proposal_issues,
)
from .prompts.planning import GENERIC_ALTERNATIVE_GOAL, GENERIC_PRIMARY_GOAL, PLAN_GOAL

__all__ = ["PLAN_GOAL", "Plan", "generic_plan", "mechanism", "parse_plan"]


@dataclass(frozen=True)
class Plan:
    raw: str
    card: str
    fields: tuple[str, ...]
    routes: tuple[Route, ...]
    complete: bool
    suggested_width: int = 1
    contract: ContractProposal = field(default_factory=ContractProposal)
    operations: dict = field(default_factory=dict)

    @property
    def contract_ready(self):
        return not proposal_issues(self.contract)


def mechanism(method):
    patterns = {
        "transfer_matrix": r"transfer[- ]matrix|frontier|转移矩阵|轮廓线",
        "dynamic_programming": r"dynamic programming|minimax|\bDP\b|动态规划|倒推",
        "modular_structure": r"valuation|congruence|modular|p.adic|同余|赋值",
        "generating_function": r"generating function|生成函数",
        "linear_algebra": r"linear algebra|matrix rank|nullspace|线性代数|矩阵秩",
        "convexity": r"convexity|Jensen|凸性|詹森",
        "factorization": r"factor|因式分解|zero.product|零积",
        "substitution": r"substitut|代入|换元",
        "enumeration": r"enumerat|exhaustive|穷举|枚举",
        "induction": r"induct|归纳",
        "counterexample": r"counterexample|反例",
        "invariant": r"invariant|不变量",
        "geometry": r"geometr|几何",
        "calculus": r"derivative|differentiat|微分|导数",
    }
    return next(
        (
            key
            for key, pattern in patterns.items()
            if re.search(pattern, method, re.IGNORECASE)
        ),
        "UNKNOWN",
    )


def parse_plan(result: str) -> Plan:
    entries = content_fields(
        result,
        [
            "CARD",
            "FIELDS",
            "WIDTH",
            r"ROUTE\s+[1-3]",
            "TASK",
            *OPERATION_FIELDS,
            *LABELS,
        ],
        adjacent_labels=LABELS,
    )
    cards = [v for k, v in entries if k == "CARD"]
    families = [v for k, v in entries if k == "FIELDS"]
    widths = [v for k, v in entries if k == "WIDTH"]
    card = cards[0] if len(cards) == 1 else "UNKNOWN"
    family = families[0] if len(families) == 1 else ""
    routes, operations = [], {}
    for index, (label, method) in enumerate(entries[:-1]):
        following, goal = entries[index + 1]
        if (
            label.startswith("ROUTE ")
            and following == "TASK"
            and method
            and goal
            and len(goal) <= 2000
        ):
            number = label.split()[-1]
            routes.append(
                Route("route-" + number, method, goal, mechanism(method), int(number))
            )
            advice = {}
            duplicate_advice = False
            for key, value in entries[index + 2 :]:
                if key not in OPERATION_FIELDS:
                    break
                if key in advice:
                    duplicate_advice = True
                advice[key] = value
            if duplicate_advice:
                advice["TASK_MODE"] = "INVALID"
            if advice:
                operations["route-" + number] = asdict(intent(goal, advice))
    if len({r.id for r in routes}) != len(routes):
        routes = []
    width = re.match(r"([12])(?:\b|$)", widths[0]) if len(widths) == 1 else None
    return Plan(
        result,
        card,
        tuple(x.strip() for x in re.split(r"[,，]", family) if x.strip())[:3],
        tuple(routes),
        bool(card != "UNKNOWN" and card and family and routes),
        int(width[1]) if width else 1,
        parse_proposal(contract_fields(result)),
        operations,
    )


def generic_plan(raw=""):
    return Plan(
        raw,
        "UNKNOWN: reread the original conditions",
        (),
        (
            Route(
                "route-general",
                "General stepwise reasoning",
                GENERIC_PRIMARY_GOAL,
            ),
            Route(
                "route-alternative",
                "Alternative representation",
                GENERIC_ALTERNATIVE_GOAL,
            ),
        ),
        False,
    )
