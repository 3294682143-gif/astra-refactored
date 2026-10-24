"""Read-only verification artifacts.

``tests/web_review/baseline/`` is a frozen copy of the repository at the pre-fix
commit, produced on demand (``git archive``) to reproduce the "before" state. It
duplicates every tracked module name, so pytest must never collect it — doing so
interrupts a bare ``pytest`` run with import-file-mismatch errors.

The probe scripts in this directory are manually runnable evidence, not part of
the automated test suite, so the baseline subtree is excluded from collection.
The baseline itself is kept out of the committed tree by ``.gitignore``.
"""

collect_ignore_glob = ["baseline", "baseline/*", "baseline/**"]
