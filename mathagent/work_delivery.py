"""Task-delivery contracts and computational intent, never mathematical authority."""

import re
from dataclasses import dataclass

from .check_templates import result_instruction
from .tools import parse_tool_proposal


def computational_kind(goal, default="DERIVE"):
    if default not in {"DERIVE", "CHECK"}:
        return default
    from .verification import arithmetic_goal

    if arithmetic_goal(goal) is not None or result_instruction(goal):
        return default
    from .computation_policy import intent

    classified = intent(goal)
    if classified.mode == "REASON":
        return default
    if classified.mode == "COMPUTE":
        return "COMPUTE"
    action = re.search(
        r"\b(?:execute|implement|simulate|enumerate|compute|recompute|calculate|evaluate|verify|run)\b|执行|编程|模拟|枚举|计算|复算",
        goal,
        re.IGNORECASE,
    )
    operation = re.search(
        r"\b(?:DP|dynamic programming|transfer.matrix|exhaustive|enumerat\w*|simulation|algorithm|python|code|binomial|binom|central difference|finite difference|digit|LZ78|Lempel)\b|动态规划|转移矩阵|穷举|枚举|代码|二项式|中心差分|数位|编码",
        goal,
        re.IGNORECASE,
    )
    return "COMPUTE" if action and operation else default


def computational_method(text):
    return bool(
        re.search(
            r"\b(?:DP|dynamic programming|transfer.matrix|exhaustive|enumerat\w*|simulation|LZ78|central difference|finite difference|numerical differentiation)\b|动态规划|转移矩阵|穷举|枚举|仿真|中心差分|有限差分|数值微分",
            text,
            re.IGNORECASE,
        )
    )


def bare_math(text):
    text = text.strip()
    if re.fullmatch(r"[+-]?\d+(?:/\d+|\.\d+)?|[A-H](?:\s*[,，]?\s*[A-H])*", text):
        return True
    if not text.startswith(r"\boxed{"):
        return False
    depth = 1
    for index, char in enumerate(text[7:], 7):
        depth += (char == "{") - (char == "}")
        if depth == 0:
            return not text[index + 1 :].strip()
    return False


@dataclass(frozen=True)
class DeliveryAssessment:
    status: str
    gap: str = ""


def assess_delivery(unit, text):
    if text.startswith("COMPUTATION_NEEDED:"):
        return DeliveryAssessment(
            "COMPUTATION_NEEDED",
            "mathematical task awaits a new bounded calculation; not a completed answer",
        )
    if unit.kind == "COMPUTE":
        if parse_tool_proposal(text) is None:
            return DeliveryAssessment(
                "MISMATCH",
                "The assigned computation requires an executable TOOL/INPUT/PURPOSE/DOMAIN/MAPPING proposal, not a claimed result. Supply bounded parameters or explain why no sound mapping is available.",
            )
        return DeliveryAssessment("DELIVERED")
    if unit.kind in {"DERIVE", "CHECK", "REPAIR"}:
        from .verification import arithmetic_goal
        from .workflows.candidates import candidate_payload

        candidate_repair = (
            unit.kind == "REPAIR" and "original_goal_coverage" in unit.obligations
        )
        if not candidate_repair and candidate_payload(text) is not None:
            return DeliveryAssessment(
                "MISMATCH",
                "An ANSWER/BASIS candidate was returned to a local work unit. Keep it as an unvalidated draft, not a completed local premise; candidate formation requires its own authorized task.",
            )

        if arithmetic_goal(unit.goal) is not None or result_instruction(unit.goal):
            return DeliveryAssessment("DELIVERED")
        expects_work = re.search(
            r"\b(?:prove|proof|construct|derive|formulate|define|justify|explain|verify|parameteriz\w*|characteriz\w*)\b|证明|构造|推导|定义|核验|验证",
            unit.goal,
            re.IGNORECASE,
        )
        if expects_work and bare_math(text) and not candidate_repair:
            return DeliveryAssessment(
                "MISMATCH",
                "A bare answer does not deliver the requested proof, construction, model or check. Return the complete bounded work and its remaining mathematical gap; the draft is not an established premise.",
            )
    # No arbitrary length threshold or model confidence is treated as a proof.
    return DeliveryAssessment("UNASSESSED")
