"""Compile trusted, hash-checked CPython WASM as a provisioned runtime asset.

Wasmtime deserialization must only consume this trusted, pinned output, never
user/model-supplied serialized modules. No generated Python is executed here.
"""

import argparse
import hashlib
from pathlib import Path

import wasmtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", required=True, type=Path)
    parser.add_argument("--wasm-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if hashlib.sha256(args.wasm.read_bytes()).hexdigest() != args.wasm_sha256:
        raise ValueError("trusted source module hash mismatch")
    cfg = wasmtime.Config()
    cfg.parallel_compilation = False
    cfg.memory_reservation = 0
    cfg.memory_reservation_for_growth = 0
    cfg.memory_guard_size = 0
    engine = wasmtime.Engine(cfg)
    module = wasmtime.Module.from_file(engine, str(args.wasm))
    with args.output.open("xb") as stream:
        stream.write(module.serialize())
    print(hashlib.sha256(args.output.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
