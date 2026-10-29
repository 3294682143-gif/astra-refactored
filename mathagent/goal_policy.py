"""Versioned bounded policy; formal Limits remain independent and immutable."""

from dataclasses import asdict, dataclass

from .runtime.config import fingerprint


@dataclass(frozen=True)
class GoalClosurePolicy:
    schema: str = "goal-closure-policy-v5-unassessed-yield"
    min_dispatch_attempted: int = 5000
    working_capacity_target: int = 5500
    max_logical_admitted: int = 10000
    initial_cycles: int = 3
    no_progress_pause_after: int = 2
    unassessed_repeat_limit: int = 2
    obligation_attempts_max: int = 16
    contract_repair_failures_max: int = 2
    minimal_repair_seconds_max: float = 90.0
    minimal_repair_soft_fraction: float = 0.15
    binding_repairs_max: int = 2
    diagnostic_require_goal_closure: bool = True
    route_extension_rounds_max: int = 1
    new_routes_per_extension_max: int = 2
    routes_max: int = 5
    active_routes_max: int = 2
    task_nodes_per_problem_max: int = 256
    dispatch_batch_max: int = 4
    request_profile: str = "fixed_8192"

    def __post_init__(self):
        defaults = type(self).__dataclass_fields__
        for key, field in defaults.items():
            value = getattr(self, key)
            if key == "request_profile":
                if value not in {"fixed_8192", "scoped_caps_v1", "scoped_caps_v2"}:
                    raise ValueError("unsupported request policy")
            elif type(value) is not type(field.default) or value != field.default:
                raise ValueError("policy change requires a new accepted schema: " + key)

    @property
    def digest(self):
        return fingerprint(asdict(self))


DEFAULT = GoalClosurePolicy()


def policy_for(store):
    return GoalClosurePolicy(**store.control.get("goal_policy", asdict(DEFAULT)))
