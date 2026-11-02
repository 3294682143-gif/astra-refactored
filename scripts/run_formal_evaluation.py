"""Command-line script to run the formal scientific evaluation and ablation suite (E15)."""

from __future__ import annotations

import json
from pathlib import Path
import sys

# Ensure repository root is in sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from python.astra_web.evaluation_matrix import ScientificEvaluationEngine


def main() -> None:
    print("=== Running Formal Scientific Evaluation & Ablation Suite (Track 160 AI4S) ===")
    engine = ScientificEvaluationEngine()
    results = engine.run_full_suite()

    release_dir = REPO_ROOT / "release"
    release_dir.mkdir(parents=True, exist_ok=True)

    json_path = release_dir / "evaluation_results.json"
    json_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"-> JSON factsheet saved: {json_path}")

    md_content = ScientificEvaluationEngine.format_factsheet_markdown(results)
    md_path = release_dir / "EVALUATION_FACTSHEET.md"
    md_path.write_text(md_content, encoding="utf-8")
    print(f"-> Markdown factsheet saved: {md_path}")
    print("\n" + md_content)


if __name__ == "__main__":
    main()
