"""Offline trusted installation: verify portable assets, compile locally, pin paths.

This NEVER marks Python accepted or runs generated model code on the host.
Moving the installation requires a fresh preparation and real acceptance.
"""

import argparse
import json
import stat
import subprocess
import sys
import venv
import zipfile
from pathlib import Path, PurePosixPath

from mathagent.runtime.wasi_acceptance import sha
from scripts.build_wasi_profile import build


def prepare(root):
    root = Path(root).resolve(strict=True)
    import mathagent.sandbox_wasi

    if (
        Path(mathagent.sandbox_wasi.__file__).resolve()
        != root / "mathagent/sandbox_wasi.py"
    ):
        raise ValueError(
            "prepare using the final submission import root, not another installed snapshot"
        )
    manifest = json.loads(
        (root / "wasi-assets/manifest.json").read_text(encoding="utf-8")
    )
    if manifest.get("schema") != "portable-wasi-assets-v1" or not manifest.get("files"):
        raise ValueError("portable asset manifest required")
    for name, digest in manifest["files"].items():
        relative = Path(name)
        path = root / relative
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or path.is_symlink()
            or not path.resolve().is_relative_to(root)
            or sha(path) != digest
        ):
            raise ValueError("runtime asset identity mismatch")
    install = root / "runtime-install"
    install.mkdir(exist_ok=False)
    # Use the actual deployment interpreter and its standard library. A venv
    # from another machine is not shipped or treated as portable.
    venv.EnvBuilder(with_pip=False, symlinks=False).create(install / "host")
    host = install / "host/bin/python"
    if not host.is_file() or host.is_symlink():
        raise ValueError("supported POSIX dedicated host Python required")
    version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    site = install / "host/lib" / version / "site-packages"
    wheels = [
        root / name
        for name in manifest["files"]
        if name.startswith("wasi-assets/wheels/wasmtime-") and name.endswith(".whl")
    ]
    if len(wheels) != 1:
        raise ValueError("one compatible pinned Wasmtime wheel required")
    from packaging.tags import sys_tags
    from packaging.utils import parse_wheel_filename

    if not (parse_wheel_filename(wheels[0].name)[3] & set(sys_tags())):
        raise ValueError("Wasmtime wheel incompatible with actual target host")
    with zipfile.ZipFile(wheels[0]) as archive:
        for info in archive.infolist():
            name = PurePosixPath(info.filename)
            if (
                name.is_absolute()
                or ".." in name.parts
                or "\\" in info.filename
                or stat.S_ISLNK(info.external_attr >> 16)
            ):
                raise ValueError("unsafe trusted wheel layout")
            if info.is_dir():
                continue
            target = site / str(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(archive.read(info))
    wasm = root / "wasi-assets/runtime/bin/python-3.12.0.wasm"
    compiled = install / "python.cwasm"
    subprocess.run(
        [
            str(host),
            "-I",
            str(root / "scripts/compile_wasi_runtime.py"),
            "--wasm",
            str(wasm),
            "--wasm-sha256",
            sha(wasm),
            "--output",
            str(compiled),
        ],
        check=True,
        timeout=300,
    )
    profile = build(
        runtime=root / "wasi-assets/runtime",
        libraries=root / "wasi-assets/mathlibs",
        python=host,
        wasmtime_package=site / "wasmtime",
        compiled_module=compiled,
        output=install / "pending.json",
    )
    return {
        "pending_profile": str(install / "pending.json"),
        "acceptance": profile["acceptance"],
        "formal_platform_accepted": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    print(json.dumps(prepare(**vars(parser.parse_args()))))
