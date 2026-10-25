"""Minimal Chrome DevTools Protocol driver (standard library + websockets).

The acceptance script needs a *real* browser that clicks, submits, loses its
network and comes back — a ``--dump-dom`` render cannot do any of that. Only the
observed-surface commands are implemented here (navigate, evaluate, network
emulation), so the driver stays small and auditable.
"""
from __future__ import annotations

import asyncio
import json
import urllib.request
from typing import Any, Iterable

import websockets


async def _target_ws(port: int, timeout: float = 20.0) -> str:
    """Return the page target websocket for a freshly started Chrome."""
    deadline = asyncio.get_event_loop().time() + timeout
    last_error: Exception | None = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                targets = json.loads(response.read().decode("utf-8"))
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    return str(target["webSocketDebuggerUrl"])
        except Exception as exc:  # Chrome is still starting
            last_error = exc
        await asyncio.sleep(0.1)
    raise RuntimeError(f"chrome devtools target not ready: {last_error}")


class CDP:
    """One page-level CDP session."""

    def __init__(self, websocket: Any) -> None:
        self._ws = websocket
        self._next_id = 0

    @classmethod
    async def connect(cls, port: int) -> "CDP":
        ws = await websockets.connect(await _target_ws(port), max_size=8 * 1024 * 1024)
        session = cls(ws)
        await session.send("Page.enable")
        await session.send("Runtime.enable")
        await session.send("Network.enable")
        return session

    async def send(
        self, method: str, params: dict[str, Any] | None = None, *, timeout: float = 60.0
    ) -> dict[str, Any]:
        self._next_id += 1
        message_id = self._next_id
        await self._ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        while True:
            raw = await asyncio.wait_for(self._ws.recv(), timeout=timeout)
            payload = json.loads(raw)
            if payload.get("id") == message_id:
                if "error" in payload:
                    raise RuntimeError(f"{method} failed: {payload['error']}")
                return payload.get("result", {})

    async def evaluate(self, expression: str, *, await_promise: bool = False) -> Any:
        result = await self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
            },
            timeout=180.0 if await_promise else 60.0,
        )
        if result.get("exceptionDetails"):
            raise RuntimeError(f"evaluate failed: {result['exceptionDetails']}")
        return result.get("result", {}).get("value")

    async def navigate(self, url: str) -> None:
        await self.send("Page.navigate", {"url": url})

    async def text(self) -> str:
        return str(await self.evaluate("document.body ? document.body.innerText : ''"))

    async def wait_for_text(self, needle: str, *, timeout: float = 30.0) -> bool:
        condition = f"document.body && document.body.innerText.includes({json.dumps(needle)})"
        return bool(await self.wait_for(condition, timeout=timeout))

    async def wait_for(self, condition_js: str, *, timeout: float = 30.0) -> Any:
        script = (
            "(async () => {"
            f"  const deadline = Date.now() + {int(timeout * 1000)};"
            "  while (Date.now() < deadline) {"
            f"    if ({condition_js}) {{ return true; }}"
            "    await new Promise((resolve) => setTimeout(resolve, 100));"
            "  }"
            "  return false;"
            "})()"
        )
        return await self.evaluate(script, await_promise=True)

    async def click_text(self, needle: str) -> bool:
        script = (
            "(() => {"
            f"  const needle = {json.dumps(needle)};"
            "  const nodes = [...document.querySelectorAll('button, a')];"
            "  const hit = nodes.find((node) => (node.innerText || '').includes(needle));"
            "  if (!hit) { return false; }"
            "  hit.click();"
            "  return true;"
            "})()"
        )
        return bool(await self.evaluate(script))

    async def set_offline(self, offline: bool) -> None:
        await self.send(
            "Network.emulateNetworkConditions",
            {
                "offline": offline,
                "latency": 0,
                "downloadThroughput": -1,
                "uploadThroughput": -1,
            },
        )

    async def close(self) -> None:
        await self._ws.close()


async def run_sequence(steps: Iterable[Any]) -> None:  # pragma: no cover - helper
    for step in steps:
        await step
