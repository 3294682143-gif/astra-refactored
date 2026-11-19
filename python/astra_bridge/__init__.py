"""P0 Python Host bridge for the Astra TS stdio probe.

This package is a process and protocol host only. It starts the Node probe,
speaks the frozen P0 NDJSON protocol and answers the read-only
``method.catalog`` callback from the existing :class:`MethodCatalog`. It
performs no model call, no tool call and no mathematical solve.

Nothing here changes the frozen Python entry point or the default engine.
"""

from __future__ import annotations

__all__ = ["p0_protocol", "p0_probe"]


# --- Windows: force every child process (multiprocessing spawn / subprocess / node / git)
#     to be created with CREATE_NO_WINDOW, so a windowless server never pops console windows.
import os as _os
if _os.name == "nt":
    try:
        import _winapi as _wi
        if not getattr(_wi, "_astra_nowin_patched", False):
            _astra_orig_CreateProcess = _wi.CreateProcess
            def _astra_CreateProcess(application_name, command_line, process_attributes, thread_attributes, inherit_handles, creation_flags, environment, current_directory, startup_info):
                try:
                    creation_flags = (creation_flags or 0) | 0x08000000
                except Exception:
                    pass
                return _astra_orig_CreateProcess(application_name, command_line, process_attributes, thread_attributes, inherit_handles, creation_flags, environment, current_directory, startup_info)
            _wi.CreateProcess = _astra_CreateProcess
            _wi._astra_nowin_patched = True
    except Exception:
        pass
