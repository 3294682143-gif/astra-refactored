#!/usr/bin/env python3
"""Credential-hygiene scanner for the astra-refactored work copy.

Scans the working tree, the entire git history, and the local repository
metadata (remote URLs) for common credential shapes, and reports every hit as
``file / commit / line`` -- or ``.git/config <key>`` for metadata.

Detected shapes
---------------
* named assignments   ``API_KEY = "<long value>"``, ``client_secret: ...``,
  ``password = ...`` and friends
* ``ghp_`` / ``gho_`` / ``ghs_`` / ``github_pat_`` GitHub token prefixes
* ``sk-`` / ``sk-ant-`` style provider keys
* ``AKIA`` AWS access-key ids
* long ``Bearer <token>`` authorization values
* credentials embedded in a URL userinfo section, the classic
  ``https://`` + ``<token>`` + ``@host/repo.git`` git-remote shape

Why repository metadata is a separate category
----------------------------------------------
``.git/config`` is not part of the working tree and is never committed, so a
token embedded in a remote URL is invisible to both a working-tree scan and a
history scan.  It is nonetheless a live credential and is reported here.

Disclosure property (important)
-------------------------------
Matched credential material is NEVER printed.  Every hit is rendered as a
masked snippet plus a short SHA-256 fingerprint of the matched value, so the
same secret can be followed across commits without the secret itself being
reproduced in a report, log or commit message.

Exit codes (regression gate)
----------------------------
``0``  working tree is clean.  Historical hits and repository-metadata hits
       are reported but do NOT fail the run -- historical residue cannot be
       removed without rewriting published history, and the metadata hits are
       rotation items, not code defects.  See
       ``docs/web/14-credential-status.md``.
``1``  at least one working-tree hit -> gate failed.
``2``  usage / environment error (not a credential verdict).

``--strict-remotes`` additionally makes repository-metadata hits fail the run
(exit 1), so the gate can cover embedded remote credentials too.

Usage
-----
    python scripts/secret_scan.py                  # worktree + history + remotes
    python scripts/secret_scan.py --no-history
    python scripts/secret_scan.py --no-remotes
    python scripts/secret_scan.py --strict-remotes # remotes also gate
    python scripts/secret_scan.py --json
    python scripts/secret_scan.py --self-test      # fixture checks (gate can fail)

Coverage limits (explicit, not silent)
--------------------------------------
* ``node_modules/`` and other vendored/build directories are skipped by
  default (``--include-vendored`` opts in).  ``.git/`` is skipped; remote
  credentials are covered by the repository-metadata category instead.
* Files larger than ``--max-file-bytes`` (default 5 MiB) are skipped and are
  listed explicitly in the report; archive members inside a skipped container
  (e.g. a .zip) are NOT inspected.
* History scanning uses ``git grep -E`` only to shortlist candidates; the
  authoritative Python patterns re-check every candidate, so the ERE set can
  be broader than the Python set without producing false hits.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# --------------------------------------------------------------------------
# Patterns
# --------------------------------------------------------------------------

# Credentials embedded in a URL userinfo section, e.g. a token in a git
# remote: ``https://`` + ``<token>`` + ``@host/repo.git``.
URL_USERINFO = re.compile(r"(?i)\bhttps?://(?P<val>[^/@\s]+)@")

# (name, compiled-regex, name-of-mask-group-or-None).  This Python list is the
# AUTHORITATIVE semantics; the POSIX-ERE list below only narrows the git-grep
# candidate set for the history scan, and every candidate is re-checked here.
PATTERN_SPECS = [
    (
        "named-assignment",
        re.compile(
            r"(?i)\b(?:api[_-]?key|apikey|access[_-]?key[_-]?id|secret[_-]?key"
            r"|client[_-]?secret|auth[_-]?token|access[_-]?token|password|passwd)\b"
            # A dotted reference such as `api_key=config.credential` is a variable
            # path, never a secret literal, so it is excluded explicitly. Unquoted
            # single-token values are still reported, because .env-style leaks are
            # exactly that shape.
            r"\s*[:=]\s*(?P<q>['\"]?)"
            r"(?!(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*\b)"
            r"(?P<val>[A-Za-z0-9_/+.\-]{16,})(?P=q)"
        ),
        "val",
    ),
    (
        "github-pat",
        re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})"),
        None,
    ),
    ("provider-sk", re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}"), None),
    ("aws-akia", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), None),
    (
        "bearer-token",
        re.compile(r"(?i)\bbearer\s+(?P<val>[A-Za-z0-9._\-]{24,})"),
        "val",
    ),
    ("url-userinfo", URL_USERINFO, "val"),
]

# POSIX-ERE equivalents for ``git grep -E`` (GNU ERE has no inline flags,
# named groups or backreferences, so this set is deliberately BROADER than
# PATTERN_SPECS).  ``git grep -i`` supplies case-insensitivity.
GIT_GREP_ERE = [
    r"(api[_-]?key|apikey|access[_-]?key[_-]?id|secret[_-]?key|client[_-]?secret|"
    r"auth[_-]?token|access[_-]?token|password|passwd)[[:space:]]*[:=][[:space:]]*"
    r"['\"]?[A-Za-z0-9_/+.-]{16,}",
    r"(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})",
    r"sk-(ant-)?[A-Za-z0-9_-]{20,}",
    r"AKIA[0-9A-Z]{16}",
    r"bearer[[:space:]]+[A-Za-z0-9._-]{24,}",
    r"https?://[^/@[:space:]]+@",
]

# Belt-and-braces redaction: within an already-reported line, any remaining
# long token is masked as well, so pattern drift can never leak material.
LONG_TOKEN = re.compile(r"[A-Za-z0-9_/+.\-]{16,}")

SKIP_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".pytest_cache",
        ".venv",
        "venv",
        "dist",
        "build",
        ".mypy_cache",
        ".ruff_cache",
    }
)

MAX_FILE_BYTES = 5 * 1024 * 1024


# --------------------------------------------------------------------------
# Matching and masking
# --------------------------------------------------------------------------


def fingerprint(value):
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()[:12]


def specific_matches(line):
    """Authoritative matches for one line: list of ``(pattern-name, span)``."""
    found = []
    for name, rx, group in PATTERN_SPECS:
        for m in rx.finditer(line):
            if group is not None and m.group(group) is not None:
                span = m.span(group)
            else:
                span = m.span()
            found.append((name, span))
    return found


def mask_line(line, matches=None, belt=True):
    """Return ``(masked_line, sorted pattern names)`` for one source line."""
    matches = specific_matches(line) if matches is None else matches
    spans = [span for _name, span in matches]
    names = sorted({name for name, _span in matches})

    if belt:
        for m in LONG_TOKEN.finditer(line):
            spans.append(m.span())

    if not spans:
        return line, names

    spans.sort()
    merged = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    out = []
    cursor = 0
    for start, end in merged:
        out.append(line[cursor:start])
        out.append(
            "<MASKED len=%d sha256=%s>" % (end - start, fingerprint(line[start:end]))
        )
        cursor = end
    out.append(line[cursor:])
    return "".join(out), names


# --------------------------------------------------------------------------
# Working-tree scan
# --------------------------------------------------------------------------


def iter_files(root):
    for path in sorted(root.rglob("*")):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.is_symlink() or not path.is_file():
            continue
        yield path


def scan_working_tree(root, max_bytes=MAX_FILE_BYTES):
    hits = []
    scanned = 0
    skipped = []

    for path in iter_files(root):
        try:
            size = path.stat().st_size
        except OSError:
            skipped.append("%s (stat failed)" % path)
            continue
        if size > max_bytes:
            skipped.append("%s (size=%d)" % (path, size))
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            skipped.append("%s (unreadable)" % path)
            continue

        scanned += 1
        text = raw.decode("utf-8", "replace")
        rel = path.relative_to(root).as_posix()
        for lineno, line in enumerate(text.splitlines(), start=1):
            matches = specific_matches(line)
            if not matches:
                continue
            masked, names = mask_line(line, matches)
            hits.append(
                {
                    "location": rel,
                    "line": lineno,
                    "patterns": names,
                    "masked": masked.strip()[:300],
                }
            )

    return hits, {"files_scanned": scanned, "files_skipped": skipped}


# --------------------------------------------------------------------------
# Git-history scan
# --------------------------------------------------------------------------


def _git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo)] + list(args),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def scan_history(repo):
    hits = []
    count = _git(repo, "rev-list", "--all", "--count")
    if count.returncode != 0:
        return hits, {"commits_scanned": 0, "error": count.stderr.strip()}

    commits = _git(repo, "rev-list", "--all").stdout.split()
    grep_args = ["grep", "-n", "-I", "-i", "-E"]
    for ere in GIT_GREP_ERE:
        grep_args += ["-e", ere]

    for commit in commits:
        proc = _git(repo, *(grep_args + [commit]))
        if proc.returncode not in (0, 1):
            continue
        for raw_line in proc.stdout.splitlines():
            parts = raw_line.split(":", 3)
            if len(parts) != 4:
                continue
            _commit, path, lineno, content = parts
            matches = specific_matches(content)
            if not matches:
                # git-grep's broader ERE matched; the authoritative Python
                # patterns reject it -> not a credential hit.
                continue
            masked, names = mask_line(content, matches)
            hits.append(
                {
                    "commit": commit,
                    "location": path,
                    "line": int(lineno) if lineno.isdigit() else lineno,
                    "patterns": names,
                    "masked": masked.strip()[:300],
                }
            )

    return hits, {"commits_scanned": len(commits)}


# --------------------------------------------------------------------------
# Repository-metadata scan (.git/config remote URLs -- never committed)
# --------------------------------------------------------------------------


def scan_repo_metadata(repo):
    hits = []
    proc = _git(repo, "config", "--local", "--get-regexp", r"^remote\..*\.url$")
    if proc.returncode not in (0, 1):
        return hits, {"keys_checked": 0, "error": proc.stderr.strip()}

    keys = 0
    for line in proc.stdout.splitlines():
        key, _, value = line.partition(" ")
        value = value.strip()
        if not key or not value:
            continue
        keys += 1
        matches = specific_matches(value)
        if not matches:
            continue
        masked, names = mask_line(value, matches, belt=False)
        hits.append(
            {
                "location": ".git/config",
                "key": key,
                "patterns": names,
                "masked": masked.strip()[:300],
            }
        )

    return hits, {"keys_checked": keys}


# --------------------------------------------------------------------------
# Gate
# --------------------------------------------------------------------------


def gate_exit_code(working_tree_hits):
    return 1 if working_tree_hits > 0 else 0


# --------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------
#
# Fixture values are assembled at run time so this scanner never trips over
# its own fixtures: no credential-shaped literal exists in this file.

_FIXTURE_KEY = "FAKEFIXTURE" + "0" * 18
_FIXTURE_GHP = "ghp_" + "F" * 36
_FIXTURE_SK = "sk-" + "F" * 28
_FIXTURE_AKIA = "AKIA" + "F" * 16
_FIXTURE_BEARER = "Bearer " + "F" * 38
_FIXTURE_REMOTE = "https://" + _FIXTURE_GHP + "@github.com/example/repo.git"

FAKE_FIXTURE = "\n".join(
    [
        'API_KEY = "' + _FIXTURE_KEY + '"',
        "GITHUB_TOKEN=" + _FIXTURE_GHP,
        "OPENAI_KEY: " + _FIXTURE_SK,
        "aws_access_key_id = " + _FIXTURE_AKIA,
        "authorization: " + _FIXTURE_BEARER,
        "",
    ]
)

CLEAN_FIXTURE = "def add(a, b):\n    return a + b\n"

NEEDLES = (
    _FIXTURE_KEY,
    _FIXTURE_GHP,
    _FIXTURE_SK,
    _FIXTURE_AKIA,
    _FIXTURE_BEARER,
)


def self_test():
    failures = []
    tmp = Path(tempfile.mkdtemp(prefix="secret-scan-selftest-"))
    try:
        dirty = tmp / "dirty"
        clean = tmp / "clean"
        dirty.mkdir()
        clean.mkdir()
        (dirty / "leaked.py").write_text(FAKE_FIXTURE, encoding="utf-8")
        (clean / "ok.py").write_text(CLEAN_FIXTURE, encoding="utf-8")

        dirty_hits, _dst = scan_working_tree(dirty)
        clean_hits, _cst = scan_working_tree(clean)

        if len(dirty_hits) < 5:
            failures.append(
                "dirty fixture produced %d hits, expected >= 5" % len(dirty_hits)
            )
        if clean_hits:
            failures.append(
                "clean fixture produced %d hits, expected 0" % len(clean_hits)
            )
        if gate_exit_code(len(dirty_hits)) != 1:
            failures.append("dirty fixture did not fail the gate")
        if gate_exit_code(len(clean_hits)) != 0:
            failures.append("clean fixture did not pass the gate")

        blob = json.dumps(dirty_hits, ensure_ascii=False)
        for needle in NEEDLES:
            if needle in blob:
                failures.append("masking leaked fixture value: %s..." % needle[:12])

        # A URL-embedded credential must be detected and masked too.
        url_matches = specific_matches(_FIXTURE_REMOTE)
        url_names = sorted({n for n, _s in url_matches})
        if "url-userinfo" not in url_names:
            failures.append("url-userinfo pattern did not match an embedded token")
        url_masked, _un = mask_line(_FIXTURE_REMOTE, url_matches, belt=False)
        for needle in NEEDLES:
            if needle in url_masked:
                failures.append("URL masking leaked fixture value: %s..." % needle[:12])

        # This file itself must be clean under its own rules.
        self_hits, _sst = scan_working_tree(Path(__file__).resolve().parent.parent)
        own = [h for h in self_hits if h["location"] == "scripts/secret_scan.py"]
        if own:
            failures.append(
                "scanner flags its own source: %d hit(s) at line(s) %s"
                % (len(own), [h["line"] for h in own])
            )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        for item in failures:
            print("SELF-TEST FAIL: %s" % item)
        return 1
    print("SELF-TEST PASS: fixture gate fails, clean tree passes, values masked")
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Scan working tree, git history and local repo metadata for "
        "credential material (values are always masked in output)."
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (default: parent of this script's directory)",
    )
    parser.add_argument(
        "--no-history", action="store_true", help="skip the git-history scan"
    )
    parser.add_argument(
        "--no-remotes",
        action="store_true",
        help="skip the repository-metadata (remote URL) check",
    )
    parser.add_argument(
        "--strict-remotes",
        action="store_true",
        help="repository-metadata hits also fail the run (exit 1)",
    )
    parser.add_argument(
        "--json", action="store_true", help="emit a machine-readable report"
    )
    parser.add_argument(
        "--max-file-bytes",
        type=int,
        default=MAX_FILE_BYTES,
        help="skip worktree files larger than this (default %d)" % MAX_FILE_BYTES,
    )
    parser.add_argument(
        "--include-vendored",
        action="store_true",
        help="also scan node_modules/ and other vendored directories",
    )
    parser.add_argument(
        "--self-test", action="store_true", help="run built-in fixture checks"
    )
    args = parser.parse_args(argv)

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # pragma: no cover - non-reconfigurable stream
            pass

    if args.self_test:
        return self_test()

    repo = args.repo
    if not repo.is_dir():
        print("error: --repo is not a directory: %s" % repo, file=sys.stderr)
        return 2

    if args.include_vendored:
        global SKIP_DIRS
        SKIP_DIRS = frozenset(SKIP_DIRS - {"node_modules", "dist", "build"})

    wt_hits, wt_stats = scan_working_tree(repo, args.max_file_bytes)

    hist_hits = []
    hist_stats = {"commits_scanned": 0}
    if not args.no_history:
        if (repo / ".git").exists():
            hist_hits, hist_stats = scan_history(repo)
        else:
            hist_stats = {"commits_scanned": 0, "error": "not a git repository"}

    meta_hits = []
    meta_stats = {"keys_checked": 0}
    if not args.no_remotes:
        if (repo / ".git").exists():
            meta_hits, meta_stats = scan_repo_metadata(repo)
        else:
            meta_stats = {"keys_checked": 0, "error": "not a git repository"}

    code = gate_exit_code(len(wt_hits))
    if args.strict_remotes and meta_hits:
        code = 1

    if args.json:
        print(
            json.dumps(
                {
                    "repo": str(repo),
                    "working_tree": dict(wt_stats, hits=wt_hits),
                    "history": dict(hist_stats, hits=hist_hits),
                    "repository_metadata": dict(
                        meta_stats,
                        hits=meta_hits,
                        gate_contribution="gating"
                        if args.strict_remotes
                        else "advisory",
                    ),
                    "gate": "fail" if code else "pass",
                    "exit_code": code,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return code

    print("repo: %s" % repo)
    print(
        "worktree scan: %d files scanned, %d skipped"
        % (wt_stats["files_scanned"], len(wt_stats["files_skipped"]))
    )
    for skipped in wt_stats["files_skipped"]:
        print("[SKIPPED] %s" % skipped)
    if not args.no_history:
        if "error" in hist_stats:
            print("history scan: unavailable (%s)" % hist_stats["error"])
        else:
            print("history scan: %d commits scanned" % hist_stats["commits_scanned"])
    if not args.no_remotes:
        if "error" in meta_stats:
            print("repository-metadata scan: unavailable (%s)" % meta_stats["error"])
        else:
            print(
                "repository-metadata scan: %d remote key(s) checked"
                % meta_stats["keys_checked"]
            )

    for hit in wt_hits:
        print(
            "[WORKTREE] %s:%s [%s] %s"
            % (hit["location"], hit["line"], ",".join(hit["patterns"]), hit["masked"])
        )
    for hit in hist_hits:
        print(
            "[HISTORY] %s %s:%s [%s] %s"
            % (
                hit["commit"][:7],
                hit["location"],
                hit["line"],
                ",".join(hit["patterns"]),
                hit["masked"],
            )
        )
    for hit in meta_hits:
        print(
            "[REPO-METADATA] %s %s [%s] %s"
            % (hit["location"], hit["key"], ",".join(hit["patterns"]), hit["masked"])
        )

    if meta_hits:
        print(
            "!! repository metadata carries credential material: rotate it and "
            "strip the userinfo from the remote URL (manual action; see "
            "docs/web/14-credential-status.md)"
        )

    print("working-tree hits: %d" % len(wt_hits))
    print(
        "history hits: %d (historical residue, informational only; "
        "see docs/web/14-credential-status.md)" % len(hist_hits)
    )
    print(
        "repository-metadata hits: %d (%s)"
        % (len(meta_hits), "gating" if args.strict_remotes else "advisory")
    )
    print("gate: %s" % ("FAIL" if code else "PASS"))
    return code


if __name__ == "__main__":
    raise SystemExit(main())