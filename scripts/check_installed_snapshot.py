"""Read-only parity gate; run from another cwd with the installed site on PYTHONPATH."""

import argparse
import json
from pathlib import Path

import math_families
import mathagent
import mathagent.check_templates
import mathagent.tool_contracts
import user_agent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--installed-root", type=Path, required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    source, installed = args.source_root.resolve(), args.installed_root.resolve()
    modules = (
        mathagent,
        mathagent.check_templates,
        mathagent.tool_contracts,
        math_families,
        user_agent,
    )
    origins = {m.__name__: str(Path(m.__file__).resolve()) for m in modules}
    problems = [
        name
        for name, path in origins.items()
        if not Path(path).is_relative_to(installed)
    ]
    if mathagent.__version__ != args.version:
        problems.append("version mismatch")
    paths = [
        p
        for package in ("mathagent", "math_families")
        for p in (source / package).rglob("*")
        if p.is_file() and p.suffix in {".py", ".json", ".md"}
    ]
    paths.append(source / "user_agent.py")
    if len(paths) <= 64:
        problems.append("missing source tree")
    for path in paths:
        relative = path.relative_to(source)
        target = installed / relative
        if (
            not target.is_file()
            or not path.is_file()
            or target.read_bytes() != path.read_bytes()
        ):
            problems.append(str(relative))
    print(
        json.dumps(
            {
                "result": "FAIL" if problems else "PASS",
                "version": mathagent.__version__,
                "checked_files": len(paths),
                "module_origins": origins,
                "mismatches": problems,
                "provider_calls": 0,
            },
            indent=2,
        )
    )
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
