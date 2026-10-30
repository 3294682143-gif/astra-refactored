"""Semantic Scholar literature search and T35 audit trail integration (F-10 / K16)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional
import urllib.parse
import urllib.request


SEMANTIC_SCHOLAR_SEARCH_ENDPOINT = "https://api.semanticscholar.org/graph/v1/paper/search"


class SemanticScholarClient:
    """Client for querying Semantic Scholar Graph API with T35 PDF doubt auditing."""

    def __init__(self, endpoint: str = SEMANTIC_SCHOLAR_SEARCH_ENDPOINT, timeout_seconds: float = 10.0):
        self.endpoint = endpoint
        self.timeout_seconds = timeout_seconds

    def search(self, query: str, limit: int = 3) -> Dict[str, Any]:
        """Query Semantic Scholar Graph API for academic literature."""
        params = {
            "query": query,
            "limit": str(limit),
            "fields": "title,authors,year,abstract,openAccessPdf",
        }
        url = f"{self.endpoint}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "AstraResearchAgent/1.0 (academic-verifier)"},
        )

        with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        raw_papers = data.get("data") or []
        parsed_papers: List[Dict[str, Any]] = []

        for p in raw_papers:
            pdf_info = p.get("openAccessPdf") or {}
            pdf_url = pdf_info.get("url") or ""
            pdf_status = pdf_info.get("status") or "UNKNOWN"

            # T35: When PDF is closed or unlinked, explicitly retain doubt rather than fabricating content
            has_pdf_access = bool(pdf_url and pdf_status == "OPEN")
            audit_doubt = None
            if not has_pdf_access:
                audit_doubt = {
                    "code": "T35_PDF_ACCESS_UNCERTAIN",
                    "status": pdf_status,
                    "reason": "Publisher access restricted; PDF full text requires credential resolution or Unpaywall fallback",
                }

            parsed_papers.append({
                "paperId": p.get("paperId"),
                "title": p.get("title"),
                "year": p.get("year"),
                "authors": [a.get("name") for a in (p.get("authors") or [])],
                "abstract": p.get("abstract"),
                "hasPdfAccess": has_pdf_access,
                "auditDoubt": audit_doubt,
            })

        return {
            "totalHits": data.get("total", len(parsed_papers)),
            "query": query,
            "papers": parsed_papers,
        }

    def save_literature_snapshot(self, search_result: Dict[str, Any], output_path: Path) -> Path:
        """Persist structured literature query results to disk."""
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(search_result, indent=2, ensure_ascii=False), encoding="utf-8")
        return output_path
