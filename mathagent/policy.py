"""Named implementation defaults, separate from formal Limits and run inputs.

This refactor does not expose new CLI overrides or change policy values. Policy
changes require a new code version and behavior review; these are not estimates
of model quality or provider capacity.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class WorkflowDefaults:
    planning_attempts: int = 2
    missing_review_attempts: int = 2
    exploration_rewards: int = (
        2  # Normal-priority allowance, not a cap on recognized progress.
    )
    no_progress_pause: int = 2
    max_active_routes: int = 2
    expansion_stop_nodes: int = 60
    reported_route_node_limit: int = 64
    closeout_parents: int = 2
    closeout_prediction_max_fraction: float = 0.25
    conditional_priority: int = 30
    pre_branch_risk_terms: tuple[str, ...] = (
        "divide",
        "all",
        "proof",
        "prove",
        "除",
        "所有",
        "证明",
    )
    post_delivery_risk_terms: tuple[str, ...] = (
        "proof",
        "prove",
        "all",
        "证明",
        "所有",
    )


WORKFLOW_DEFAULTS = WorkflowDefaults()
