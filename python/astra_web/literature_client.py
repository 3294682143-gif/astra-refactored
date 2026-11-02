"""Semantic Scholar literature search and T35 audit trail integration (F-10 / K16)."""

from __future__ import annotations

import hashlib
import io
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
            "fields": "title,authors,year,abstract,openAccessPdf,externalIds,url",
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
                "externalIds": p.get("externalIds") or {},
                "landingPageUrl": p.get("url"),
                "openAccessPdfUrl": pdf_url if has_pdf_access else None,
                "hasPdfAccess": has_pdf_access,
                "auditDoubt": audit_doubt,
            })

        return {
            "totalHits": data.get("total", len(parsed_papers)),
            "query": query,
            "papers": parsed_papers,
        }

    def read_open_access_pdf(
        self,
        paper: Dict[str, Any],
        *,
        max_bytes: int = 20 * 1024 * 1024,
        max_characters: int = 100_000,
    ) -> Dict[str, Any]:
        pdf_url = paper.get("openAccessPdfUrl")
        if not paper.get("hasPdfAccess") or not isinstance(pdf_url, str) or not pdf_url.startswith("https://"):
            return {
                "status": "T35_PDF_ACCESS_UNCERTAIN",
                "paperId": paper.get("paperId"),
                "text": "",
                "pages": [],
            }
        request = urllib.request.Request(
            pdf_url,
            headers={"User-Agent": "AstraResearchAgent/1.0 (academic-verifier)"},
        )
        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
            final_url = response.geturl()
            if not final_url.startswith("https://"):
                raise ValueError("PDF redirect downgraded to a non-HTTPS URL")
            content = response.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise ValueError("PDF exceeds the configured size limit")
        if not content.startswith(b"%PDF"):
            raise ValueError("Open-access URL did not return a PDF document")
        try:
            from pypdf import PdfReader
        except ImportError as exc:
            raise RuntimeError("PDF_PARSER_UNAVAILABLE") from exc
        reader = PdfReader(io.BytesIO(content), strict=False)
        pages = []
        remaining = max_characters
        for page_number, page in enumerate(reader.pages, start=1):
            if remaining <= 0:
                break
            text = page.extract_text() or ""
            text = text[:remaining]
            remaining -= len(text)
            if text.strip():
                pages.append({"page": page_number, "text": text})
        full_text = "\n\n".join(f"[Page {page['page']}]\n{page['text']}" for page in pages)
        return {
            "status": "FULL_TEXT_EXTRACTED" if full_text.strip() else "TEXT_EXTRACTION_EMPTY",
            "paperId": paper.get("paperId"),
            "title": paper.get("title"),
            "sourceUrl": pdf_url,
            "sha256": hashlib.sha256(content).hexdigest(),
            "bytes": len(content),
            "pageCount": len(reader.pages),
            "pages": pages,
            "text": full_text,
            "candidateVerified": False,
        }

    def save_literature_snapshot(self, search_result: Dict[str, Any], output_path: Path) -> Path:
        """Persist structured literature query results to disk."""
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(search_result, indent=2, ensure_ascii=False), encoding="utf-8")
        return output_path
