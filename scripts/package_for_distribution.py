"""Package astra-refactored into a distribution zip for third-party reproduction.

Includes:
  - Complete v15 codebase anchored on commit 7d4dfb5
  - Built frontend static assets (apps/web-demo/dist)
  - Standalone Node runtime bundle (release/stdio-runtime.bundle.mjs)
  - One-click startup scripts (start.bat, start.ps1, start.sh)
  - Dependency manifests (requirements-web.txt, pyproject.toml)
  - Full git repository (.git) for verifiable commit history
  - Historical runs sample in var/astra for instant replay
Excludes:
  - node_modules
  - .venv / venv
  - __pycache__ / *.pyc
  - pytest temporary files / logs
"""
import os, sys, zipfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST_ZIP = ROOT.parent / "astra-v15-reproduce.zip"

EXCLUDE_DIRS = {
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_tmp",
    "pytest_tmp",
    ".turbo",
    ".cache",
}

EXCLUDE_EXTS = {
    ".pyc",
    ".pyo",
    ".pyd",
    ".log",
    ".DS_Store",
}

def should_exclude(rel_path: Path) -> bool:
    parts = set(rel_path.parts)
    if parts & EXCLUDE_DIRS:
        return True
    if rel_path.suffix in EXCLUDE_EXTS:
        return True
    if rel_path.name == "Thumbs.db":
        return True
    return False

def make_zip(out_path: Path):
    print(f"Creating archive: {out_path} ...")
    start_time = time.time()
    count = 0
    total_bytes = 0

    if out_path.exists():
        out_path.unlink()

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        # We put everything under an enclosing folder 'astra-refactored/'
        prefix = "astra-refactored"
        for root, dirs, files in os.walk(ROOT):
            # Prune exclude dirs from walking
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            
            for file in files:
                abs_file = Path(root) / file
                rel_file = abs_file.relative_to(ROOT)
                if should_exclude(rel_file):
                    continue
                
                archive_name = f"{prefix}/{rel_file.as_posix()}"
                zf.write(abs_file, archive_name)
                count += 1
                total_bytes += abs_file.stat().st_size

    elapsed = time.time() - start_time
    zip_size_mb = out_path.stat().st_size / (1024 * 1024)
    raw_size_mb = total_bytes / (1024 * 1024)
    print(f"Archive created successfully in {elapsed:.2f}s!")
    print(f"  Files packed:  {count}")
    print(f"  Raw size:      {raw_size_mb:.2f} MB")
    print(f"  Zip size:      {zip_size_mb:.2f} MB")
    print(f"  Output path:   {out_path}")

if __name__ == "__main__":
    make_zip(DEST_ZIP)
