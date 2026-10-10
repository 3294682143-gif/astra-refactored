"""Optional provisioned platform assets; no personal paths or environment lookup."""

import json
from pathlib import Path

from .tools import PythonSandbox


def platform_python(profile=None):
    if profile is None:
        root = Path(__file__).resolve().parent.parent
        descriptor = root / "mathagent/resources/platform-python.json"
        if not descriptor.is_file():
            return None
        value = json.loads(descriptor.read_text(encoding="utf-8"))
        if (
            not isinstance(value, dict)
            or set(value) != {"profile"}
            or not isinstance(value["profile"], str)
        ):
            raise ValueError("invalid platform Python asset descriptor")
        relative = Path(value["profile"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("platform Python assets must be inside the submission")
        profile = (root / relative).resolve(strict=True)
        if not profile.is_relative_to(root):
            raise ValueError("platform Python asset escapes submission")
    sandbox = PythonSandbox(profile=profile)
    if not sandbox.available or not sandbox.identity:
        raise ValueError(
            "configured platform Python profile is not accepted or available"
        )
    return sandbox
