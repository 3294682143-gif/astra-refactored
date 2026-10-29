#!/usr/bin/env python3
"""Serve the real BFF with an explicitly scripted model, for browser acceptance.

Only the remote model *answer* is scripted. Everything else — the BFF, the
Python Host, the Node runtime bundle and the unified ``use_math_asset`` executor —
is the production code path, and the scripted brain is wrapped in the same
``PublicChatPort`` the production assembly uses, so the browser exercises the
real client contract too.

This server is never the production entry point: ``python.astra_web.app:app``
stays wired to ``build_solver_from_env()``.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from python.astra_bridge.public_chat_port import PublicChatPort  # noqa: E402
from python.astra_web.app import create_app  # noqa: E402
from python.astra_web.config import DEFAULT_BUDGET  # noqa: E402
from python.astra_web.solver_adapter import SolverAdapter  # noqa: E402
from tests.web_math_helpers import MathAssetScriptedClient  # noqa: E402

ASSET_ID = "math.linear-algebra"
TARGET = "gf2_rank"
INPUT = {"rows": [1, 2]}


class DropEventStreamOnce:
    """Fault injection: drop one live SSE connection, like a flaky proxy would.

    The browser must reconnect on its own (``Last-Event-ID``) and the run must
    still close honestly. Without this the reconnect path is never exercised.
    """

    def __init__(self, app, drop_after: int = 3) -> None:
        self.app = app
        self.drop_after = max(1, int(drop_after))
        self._dropped: set[str] = set()

    async def __call__(self, scope, receive, send):  # noqa: ANN001 - ASGI
        if scope.get("type") != "http" or not str(scope.get("path", "")).endswith("/events"):
            await self.app(scope, receive, send)
            return

        run_path = str(scope.get("path", ""))
        already = run_path in self._dropped
        sent_bodies = 0
        suppressed = False

        async def guarded_send(message):  # noqa: ANN001 - ASGI message
            nonlocal sent_bodies, suppressed
            if suppressed:
                return
            if message.get("type") == "http.response.body" and not already:
                sent_bodies += 1
                if sent_bodies >= self.drop_after:
                    self._dropped.add(run_path)
                    suppressed = True
                    await send({"type": "http.response.body", "body": b"", "more_body": False})
                    return
            await send(message)

        await self.app(scope, receive, guarded_send)


class ThrottledScriptedModel(MathAssetScriptedClient):
    """Scripted answers with a visible per-call delay (shows live progress)."""

    def __init__(self, delay_seconds: float = 1.1) -> None:
        super().__init__(ASSET_ID, TARGET, INPUT)
        self.delay_seconds = delay_seconds

    def chat(self, messages, **kwargs):  # noqa: ANN001 - mirrors the connector
        time.sleep(self.delay_seconds)
        return super().chat(messages, **kwargs)


def build_scripted_solver(delay_seconds: float = 1.1) -> SolverAdapter:
    def _factory(budgets):
        seconds = float(budgets.get("problem_seconds", DEFAULT_BUDGET["problem_seconds"]))
        return PublicChatPort(ThrottledScriptedModel(delay_seconds), request_seconds=seconds)

    return SolverAdapter(client_factory=_factory)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--delay", type=float, default=1.1)
    parser.add_argument(
        "--drop-events-after",
        type=int,
        default=3,
        help="drop one live SSE connection after N chunks (reconnect fault injection)",
    )
    args = parser.parse_args(argv)

    app = create_app(solver=build_scripted_solver(args.delay))
    app = DropEventStreamOnce(app, drop_after=args.drop_events_after)
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
