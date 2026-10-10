"""Two run-scoped process slots shared by local checks and proposed computation.

File locks are local CPU/memory permits, not model permits or mathematical state.
They disappear with the owning process; the separate STARTED receipt still forbids
replay of an interrupted operation.
"""

import fcntl
import time
from pathlib import Path

MAX_LOCAL_EXECUTIONS = 2


class LocalExecutionGate:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def run(self, operation, *, name, scope, deadline):
        from .tools import ToolResult

        end = min(deadline, time.monotonic() + 30)
        while time.monotonic() < end:
            for index in range(MAX_LOCAL_EXECUTIONS):
                with (self.directory / ("slot-" + str(index) + ".lock")).open(
                    "a+b"
                ) as stream:
                    try:
                        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        continue
                    try:
                        if time.monotonic() >= end:
                            break
                        return operation(end)
                    finally:
                        fcntl.flock(stream, fcntl.LOCK_UN)
            time.sleep(min(0.02, max(0, end - time.monotonic())))
        return ToolResult(
            "resource_limited",
            name,
            None,
            "NONE",
            scope,
            detail="shared local execution capacity/deadline exhausted",
        )


class GatedRegistered:
    def __init__(self, base, gate):
        self.base, self.gate, self.registry = base, gate, base.registry

    def execute(self, name, args, *, deadline, scope):
        return self.gate.run(
            lambda end: self.base.execute(name, args, deadline=end, scope=scope),
            name=name,
            scope=scope,
            deadline=deadline,
        )

    def execute_bound(self, name, args, *, binding, deadline, scope):
        method = getattr(self.base, "execute_bound", None)
        return self.gate.run(
            lambda end: (
                method(name, args, binding=binding, deadline=end, scope=scope)
                if method
                else self.base.execute(name, args, deadline=end, scope=scope)
            ),
            name=name,
            scope=scope,
            deadline=deadline,
        )


class GatedPython:
    def __init__(self, base, gate):
        self.base, self.gate = base, gate
        self.available, self.identity = base.available, base.identity

    def execute_bound(self, code, *, binding, deadline, problem_id, scope):
        method = getattr(self.base, "execute_bound", None)
        return self.gate.run(
            lambda end: (
                method(
                    code,
                    binding=binding,
                    deadline=end,
                    problem_id=problem_id,
                    scope=scope,
                )
                if method
                else self.base.execute(
                    code, deadline=end, problem_id=problem_id, scope=scope
                )
            ),
            name="generated_python",
            scope=scope,
            deadline=deadline,
        )
