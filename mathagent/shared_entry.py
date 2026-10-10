"""Shared resource governance combined with the unchanged public chat transport."""

from .controller import Controller
from .domain import ProblemContract
from .experiments import ExperimentConfig
from .finalization import UNSOLVED, finalize
from .platform_entry import public_trace
from .runtime.platform_adapter import PlatformAdapter
from .runtime.public_coordination import SharedPublicCoordinator
from .store import ArtifactStore


def solve_shared_public(
    problem,
    *,
    client,
    authority,
    item,
    recovered=None,
    known_total=None,
    experiment=None,
    python_sandbox=None,
    public_return_settles=False,
    diagnostic_sink=None,
):
    store = (
        ArtifactStore.restore(ProblemContract(problem), recovered)
        if recovered is not None
        else ArtifactStore(ProblemContract(problem))
    )
    coord = SharedPublicCoordinator(
        authority, item, public_return_settles=public_return_settles
    )
    adapter = PlatformAdapter(
        client, coord, diagnostic_sink=getattr(diagnostic_sink, "call", None)
    )
    try:
        authority.admit_item(item)
        experiment = experiment or ExperimentConfig()
        recording, registered = None, None
        if callable(getattr(diagnostic_sink, "begin_item", None)):
            from .runtime.diagnostics import RecordingPython, RecordingRegistered
            from .tools import RegisteredExecutor

            recording = diagnostic_sink.begin_item(
                store=store,
                item=item,
                coordinator=coord,
                adapter=adapter,
                experiment=experiment,
                known_total=known_total,
                python_sandbox=python_sandbox,
                initial_snapshot=recovered,
                entry="closeout"
                if recovered is not None and not store.control.get("planning")
                else "solve",
            )
            adapter.diagnostic_sink, coord.budget_observer = (
                recording.call,
                recording.budget,
            )
            if python_sandbox:
                python_sandbox = RecordingPython(python_sandbox, recording)
            registered = RecordingRegistered(RegisteredExecutor(), recording)
        ctl = Controller(
            adapter,
            item,
            store,
            total_items=known_total,
            experiment=experiment,
            python_sandbox=python_sandbox,
            clock=recording.math_clock if recording else None,
            registered_executor=registered,
        )
        result = (
            ctl.closeout()
            if recovered is not None and not store.control.get("planning")
            else ctl.solve()
        )
    except Exception as exc:  # noqa: BLE001 - preserve existing candidates at public boundary
        store.event("runtime_error", error_type=type(exc).__name__)
        result = finalize(store)
    finally:
        # Save mathematical state even at the deadline; ordinary checkpoints
        # cannot authorize more work in the ten-second termination grace.
        coord.close()
    if diagnostic_sink is not None:
        try:
            if callable(getattr(diagnostic_sink, "record_state", None)):
                diagnostic_sink.record_state(store, item_id=item.id)
            else:
                diagnostic_sink(store)
        except (OSError, ValueError, TypeError):
            # Optional diagnostics cannot erase an already acquired candidate.
            store.event("diagnostic_persistence_failed", math_result_retained=True)
            authority.stop_dispatch("diagnostic_persistence_failed")
    answer = result.get("final_response") or UNSOLVED
    public = {
        "final_response": answer,
        "trace": public_trace(
            store.events,
            coord.metrics(),
            64,
            capabilities={
                **adapter.public_contract,
                "mode": "shared_public",
                "global_resource_authority": "trusted_same_host_coordinator",
                "persistent_agent_recovery": True,
                "cross_question_borrowing": True,
                "cross_question_dynamic_budget": True,
                "generated_python_available": python_sandbox is not None,
                "generated_python_target_acceptance": "not_established_by_agent",
            },
        ),
    }
    return authority.close_item(item, public, snapshot=store.snapshot())
