"""P0 Python Host bridge for the Astra TS stdio probe.

This package is a process and protocol host only. It starts the Node probe,
speaks the frozen P0 NDJSON protocol and answers the read-only
``method.catalog`` callback from the existing :class:`MethodCatalog`. It
performs no model call, no tool call and no mathematical solve.

Nothing here changes the frozen Python entry point or the default engine.
"""

from __future__ import annotations

__all__ = ["p0_protocol", "p0_probe"]
