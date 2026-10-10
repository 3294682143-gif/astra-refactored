"""Pin explicit local WASI assets; this command does not grant acceptance."""

import argparse
import hashlib
import json
from pathlib import Path

import mathagent.runtime.wasi_acceptance
import mathagent.sandbox_wasi
from mathagent.runtime.wasi_acceptance import environment


def build(*, runtime, libraries, python, wasmtime_package, compiled_module, output):
    roots = [
        Path(p).resolve(strict=True) for p in (runtime, libraries, wasmtime_package)
    ]
    binary = Path(python).absolute()
    if binary.is_symlink() or not binary.is_file():
        raise ValueError("provide a regular dedicated venv executable, not a symlink")
    compiled = Path(compiled_module).resolve(strict=True)
    paths = [
        binary,
        compiled,
        binary.parent.parent / "pyvenv.cfg",
        Path(mathagent.sandbox_wasi.__file__),
        Path(mathagent.sandbox_wasi.__file__).with_name("_wasi_worker.py"),
        Path(mathagent.runtime.wasi_acceptance.__file__),
    ]
    for root in roots:
        for path in root.rglob("*"):
            if path.is_symlink():
                raise ValueError("runtime symlinks are forbidden")
            if path.is_file():
                paths.append(path)
    result = {
        "schema": "astra-wasi-profile-v1",
        "acceptance": "PRECONDITIONS_ONLY_NOT_ACCEPTED",
        "formal_platform_accepted": False,
        "installation_environment": environment(),
        "python": str(binary),
        "runtime": str(roots[0]),
        "libraries": str(roots[1]),
        "wasmtime_package": str(roots[2]),
        "compiled_module": str(compiled),
        "guest_memory_mib": 512,
        "host_address_space_mib": 1024,
        "maximum_seconds": 30,
        "maximum_output_bytes": 65536,
        "libraries_declared": [
            "CPython WASI 3.12.0 stdlib",
            "SymPy 1.12",
            "mpmath 1.3.0",
        ],
        "unsupported_libraries": ["NumPy", "SciPy", "native host extensions"],
        "file_hashes": {
            str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(set(paths))
        },
    }
    with Path(output).open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "runtime",
        "libraries",
        "python",
        "wasmtime-package",
        "compiled-module",
        "output",
    ):
        parser.add_argument("--" + name, required=True)
    args = vars(parser.parse_args())
    result = build(**args)
    print(
        json.dumps(
            {
                "acceptance": result["acceptance"],
                "pinned_files": len(result["file_hashes"]),
            }
        )
    )
