"""One node budget for graph, direct WorkUnits and ReviewTasks (not requests)."""


def admit_task(store, identity):
    if not isinstance(identity, str) or not identity:
        raise ValueError("task resource identity must be a nonempty string")
    with store.lock:
        seen = store.control.setdefault("task_resource_ids", [])
        if identity in seen or identity in store.tasks.nodes:
            return
        if len(set(seen) | set(store.tasks.nodes) | {identity}) > store.tasks.max_nodes:
            from .runtime.coordinator import AdmissionError

            raise AdmissionError("problem mathematical task node capacity exhausted")
        seen.append(identity)
        # This is a membership/counting ledger, not an execution timeline.
        # Concurrent independent R0 tasks may arrive in either order.
        seen.sort()
