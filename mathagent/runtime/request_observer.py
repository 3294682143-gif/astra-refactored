"""Request-thread-local visible transport observations; never terminal authority."""

import threading
from contextlib import contextmanager
from contextvars import ContextVar

_observer = ContextVar("s2_visible_request_observer", default=None)


class RequestObserverThread(threading.Thread):
    """Owned local observer with a completion marker after settlement/journaling."""

    def __init__(self, *, target, run_id, completed):
        super().__init__(target=target, name="s2-public-call", daemon=True)
        self.run_id, self.completed = run_id, completed


def local_observers_pending(run_id):
    return any(
        isinstance(thread, RequestObserverThread)
        and thread.run_id == run_id
        and not thread.completed.is_set()
        for thread in threading.enumerate()
    )


@contextmanager
def observing(callback):
    token = _observer.set(callback)
    try:
        yield
    finally:
        _observer.reset(token)


def observe(event, **values):
    sink = _observer.get()
    if sink is not None:
        sink({"event": event, **values})
