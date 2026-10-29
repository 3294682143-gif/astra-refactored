"""Local packaging checks, not a declaration of official readiness or score."""

import argparse
import json

from mathagent.skills import SkillCatalog
from mathagent.testing import ScriptedClient
from mathagent.tools import PythonSandbox
from user_agent import ReasoningAgent


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--profile", choices=("entry", "admit", "full"), default="entry")
    p.add_argument(
        "--evidence", help="content-bound acceptance record for this installed snapshot"
    )
    p.add_argument(
        "--manifest",
        help="current planned run manifest; required for model-bound admission/full checks",
    )
    args = p.parse_args()
    if args.profile != "entry":
        from pathlib import Path

        from mathagent.release_gates import check_full_release

        manifest = (
            json.loads(Path(args.manifest).read_text(encoding="utf-8"))
            if args.manifest
            else None
        )
        result = check_full_release(args.profile, args.evidence, manifest=manifest)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["passed"] else 2
    result = ReasoningAgent(ScriptedClient([])).solve("test", {"idx": 0})
    json.dumps(result)
    print(
        json.dumps(
            {
                "entry_loads": bool(result["final_response"]),
                "family_count": len(SkillCatalog().families),
                "generated_python_available": PythonSandbox.available,
                "official_readiness": "NOT_VERIFIED",
                "quality_comparison": "NOT_RUN",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
