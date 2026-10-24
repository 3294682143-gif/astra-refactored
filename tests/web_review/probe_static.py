"""Independent source-level verification probe for defects #2 (demo fallback / hardcoded L3)
and #6 (hardcoded batch score / asset check / service-ready, unwired import button).

Usage: C:\\Python314\\python.exe tests/web_review/probe_static.py <treeRoot>
Prints, per defect marker, every match with file:line. Read-only.
"""
from __future__ import annotations
import json, re, sys
from pathlib import Path

tree = Path(sys.argv[1]).resolve()
src = tree / "apps" / "web-demo" / "src"

MARKERS = [
    ("D1_demo_fixture_source", r"demo_fixture"),
    ("D2_offline_fallback_banner", r"offline fallback"),
    ("D3_client_demofallback", r"DEMO_SAMPLE_LOG|DEMO_RUN_ID"),
    ("D4_hardcoded_L3_badge", r'level="L3"|level=\x27L3\x27'),
    ("D5_batch_score_100_112", r"100\s*/\s*112"),
    ("D6_batch_100pct", r">\s*100%|100%\s*<"),
    ("D7_assets_verified_ok", r"VERIFY_OK"),
    ("D8_assets_checked_pass", r"校验通过"),
    ("D9_settings_ready_hardcode", r"已配置就绪|端点状态"),
    ("D10_forbidden_claim", r"已验证|验证通过|形式化通过|证明完成|正确性保证|已证明"),
    ("D11_batch_import_label", r"导入评测批次|批量导入"),
]

results = {}
for name, pat in MARKERS:
    rx = re.compile(pat)
    hits = []
    for f in sorted(src.rglob("*")):
        if f.is_file() and f.suffix in (".ts", ".tsx", ".html", ".css"):
            try:
                text = f.read_text(encoding="utf-8")
            except Exception:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if rx.search(line):
                    hits.append(f"{f.relative_to(tree).as_posix()}:{i}: {line.strip()[:160]}")
    results[name] = {"pattern": pat, "count": len(hits), "matches": hits[:12]}

print(json.dumps({"tree": str(tree), "markers": results}, ensure_ascii=False, indent=2))