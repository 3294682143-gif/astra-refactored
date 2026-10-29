"""Trusted worker: generated source is executed by WASI CPython, never host exec."""

import argparse
import ctypes
import json
import math
import os
import resource
import signal
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--libraries", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--wasmtime-package", required=True)
    parser.add_argument("--compiled-module", required=True)
    parser.add_argument("--seconds", type=float, required=True)
    parser.add_argument("--parent-pid", type=int, default=None)
    args = parser.parse_args()
    if args.parent_pid is not None:
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            raise OSError("parent death guard unavailable")
        if os.getppid() != args.parent_pid:
            return 75
    code = sys.stdin.buffer.read(65537)
    if len(code) > 65536 or not 0 < args.seconds <= 30:
        return 64
    # Kernel-enforced wall time survives loss of the supervising parent and
    # interrupts a sleeping guest or native runtime call, not only Python bytecode.
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.setitimer(signal.ITIMER_REAL, args.seconds)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # 512 MiB WASM linear memory plus trusted JIT address-space headroom.
    # This is explicitly a 1 GiB whole-host-process virtual-memory profile.
    resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
    cpu = max(1, min(30, math.ceil(args.seconds)))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    # The host is launched with -I -S: no .pth or sitecustomize executes before
    # limits. Only the separately pinned Wasmtime package is added explicitly.
    sys.path.insert(0, str(Path(args.wasmtime_package).parent))
    import wasmtime

    cfg = wasmtime.Config()
    cfg.parallel_compilation = False
    cfg.memory_reservation = 0
    cfg.memory_reservation_for_growth = 0
    cfg.memory_guard_size = 0
    engine = wasmtime.Engine(cfg)
    # Unsafe for untrusted serialized modules: the parent pins this provisioned
    # asset and every runtime file before launch. No guest module is accepted.
    module = wasmtime.Module.deserialize_file(engine, args.compiled_module)
    store = wasmtime.Store(engine)
    store.set_limits(
        memory_size=512 * 1024**2,
        instances=1,
        memories=1,
        tables=1,
        table_elements=65536,
    )
    wasi = wasmtime.WasiConfig()
    wasi.inherit_stdout()
    wasi.inherit_stderr()
    wasi.argv = [
        "python",
        "-I",
        "-B",
        "-c",
        "import os,sys; os.chdir('/work'); sys.path.append('/opt/math');\n"
        + code.decode("utf-8"),
    ]
    wasi.env = [("PYTHONHASHSEED", "0")]
    wasi.preopen_dir(str(Path(args.runtime) / "usr"), "/usr", fs_mutable=False)
    wasi.preopen_dir(args.libraries, "/opt/math", fs_mutable=False)
    wasi.preopen_dir(args.work, "/work", fs_mutable=True)
    store.set_wasi(wasi)
    linker = wasmtime.Linker(engine)
    linker.define_wasi()
    result, reason = 0, "completed"
    try:
        instance = linker.instantiate(store, module)
        # Trusted memory-image initialization precedes the first guest instruction.
        resource.setrlimit(resource.RLIMIT_FSIZE, (1024**2, 1024**2))
        instance.exports(store)["_start"](store)
    except wasmtime.ExitTrap as exc:
        result = exc.code
        reason = "guest_exit"
    except wasmtime.Trap:
        result, reason = 70, "wasm_trap"
    finally:
        store.close()
        linker.close()
        module.close()
        engine.close()
    usage = resource.getrusage(resource.RUSAGE_SELF)
    # The receipt is outside all guest preopens and cannot be forged by printing.
    with Path(args.receipt).open("x", encoding="utf-8") as stream:
        json.dump(
            {
                "exit_code": result,
                "reason": reason,
                "cpu_seconds": usage.ru_utime + usage.ru_stime,
                "max_rss_kib": usage.ru_maxrss,
            },
            stream,
        )
    return result


if __name__ == "__main__":
    raise SystemExit(main())
