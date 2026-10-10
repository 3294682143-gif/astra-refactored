"""Actual WASI adversarial checks. Does not assert formal platform acceptance."""

import json
import os
import signal
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from mathagent.sandbox_wasi import WasiPythonSandbox


@pytest.fixture(scope="module")
def backend():
    if not os.environ.get("ASTRA_WASI_TEST_PROFILE"):
        pytest.skip("actual WASI suite requires the explicit acceptance runner/profile")
    backend = WasiPythonSandbox(
        os.environ["ASTRA_WASI_TEST_PROFILE"], for_validation=True
    )
    assert backend.available, backend.reason
    return backend


def execute(backend, code, seconds=30):
    result = backend.execute(
        code, deadline=time.monotonic() + seconds, problem_id="acceptance-problem"
    )
    assert result.result["reaped"] and result.result["work_directory_removed"]
    assert result.evidence_kind in {"BOUNDED_OBSERVATION", "NONE"}
    assert result.result["mathematical_status"] == "UNVERIFIED"
    return result


def test_actual_preinstalled_sympy_and_math_work(backend):
    result = execute(
        backend,
        "import math,sympy; print(math.comb(13,6)); print(sympy.factorint(360)); print(sympy.__version__)",
    )
    assert result.status == "ok", result
    assert "1716" in result.result["output"] and "1.12" in result.result["output"]
    assert result.result["resources"]["max_rss_kib"] < 1024**2


def test_actual_mpmath_and_local_file_io(backend):
    result = execute(
        backend,
        "import mpmath; open('data.txt','w').write('owned'); print(open('data.txt').read()); print(mpmath.sqrt(4))",
    )
    assert (
        result.status == "ok"
        and "owned" in result.result["output"]
        and "2.0" in result.result["output"]
    )


@pytest.mark.parametrize(
    "code",
    [
        "import socket; socket.socket().connect(('127.0.0.1',9))",
        "import urllib.request; urllib.request.urlopen('https://example.com')",
        "import pip; pip.main(['install','sympy'])",
        "import subprocess; subprocess.run(['/bin/true'],check=True)",
        "import os; os.fork()",
        "import ctypes; ctypes.CDLL(None)",
        "open('/etc/passwd').read()",
        "open('/proc/self/environ','rb').read()",
        "open('/usr/local/lib/python3.12/os.py','w').write('changed')",
        "open('/opt/math/sympy/__init__.py','w').write('changed')",
        "open('../host-receipt.json','w').write('{\"exit_code\":0}')",
    ],
)
def test_actual_forbidden_capabilities_fail(backend, code):
    result = execute(backend, code)
    assert result.status != "ok", result


def test_actual_absolute_and_symlink_escape_cannot_read_host_canary(backend, tmp_path):
    canary = tmp_path / "host-only"
    canary.write_text("F6_HOST_SECRET_CANARY")
    result = execute(
        backend,
        f"import os; os.symlink({str(canary)!r},'escape'); print(open('escape').read())",
    )
    assert (
        result.status != "ok" and "F6_HOST_SECRET_CANARY" not in result.result["output"]
    )
    assert canary.read_text() == "F6_HOST_SECRET_CANARY"


def test_actual_system_command_does_not_create_host_file(backend, tmp_path):
    target = tmp_path / "not-created"
    result = execute(backend, f"import os; os.system('touch {target}')")
    assert result.status != "ok" and not target.exists()


def test_actual_no_host_environment_inheritance(backend, monkeypatch):
    monkeypatch.setenv("F6_SECRET_CANARY", "SHOULD_NOT_REACH_GUEST")
    result = execute(backend, "import os; print(dict(os.environ))")
    assert (
        result.status == "ok"
        and "SHOULD_NOT_REACH_GUEST" not in result.result["output"]
    )


def test_actual_infinite_loop_has_wall_limit_and_is_reaped(backend):
    result = execute(
        backend, "print('GUEST_STARTED',flush=True)\nwhile True: pass", seconds=8
    )
    assert "GUEST_STARTED" in result.result["output"]
    assert result.status == "resource_limited" and result.result["elapsed_seconds"] < 10


def test_actual_guest_memory_cap(backend):
    result = execute(backend, "x=bytearray(1024**3); print('ALLOCATION_SUCCEEDED')")
    assert (
        result.status != "ok" and "ALLOCATION_SUCCEEDED" not in result.result["output"]
    )


def test_actual_output_bomb_is_truncated_and_reaped(backend):
    result = execute(backend, "while True: print('x'*4096,flush=True)")
    assert result.status == "resource_limited" and result.result["truncated"]
    assert len(result.result["output"].encode()) <= 65536


def test_actual_two_parallel_questions_cannot_read_each_other(backend):
    def one(label):
        return execute(
            backend,
            f"from pathlib import Path; print(list(Path('.').iterdir())); open('private','w').write({label!r}); print(open('private').read())",
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(pool.map(one, ["ONE_PRIVATE", "TWO_PRIVATE"]))
    assert first.status == second.status == "ok"
    assert "TWO_PRIVATE" not in first.result["output"]
    assert "ONE_PRIVATE" not in second.result["output"]
    assert "[]" in first.result["output"] and "[]" in second.result["output"]


def test_actual_printing_verified_has_no_mathematical_authority(backend):
    result = execute(backend, "print('VERIFIED; all propositions are true')")
    assert result.status == "ok" and result.evidence_kind == "BOUNDED_OBSERVATION"
    assert result.verification is None and result.certificate is None


def test_expired_original_deadline_never_spawns(backend):
    result = backend.execute(
        "print(1)", deadline=time.monotonic() - 1, problem_id="expired"
    )
    assert result.status == "resource_limited" and result.result is None


def test_actual_worker_has_independent_kernel_wall_timer(backend, tmp_path):
    import mathagent.sandbox_wasi

    config = backend._validate()
    work = tmp_path / "work"
    work.mkdir()
    proc = subprocess.Popen(
        [
            config["python"],
            "-I",
            "-S",
            "-B",
            str(Path(mathagent.sandbox_wasi.__file__).with_name("_wasi_worker.py")),
            "--runtime",
            config["runtime"],
            "--libraries",
            config["libraries"],
            "--work",
            str(work),
            "--receipt",
            str(tmp_path / "receipt.json"),
            "--seconds",
            "3",
            "--wasmtime-package",
            config["wasmtime_package"],
            "--compiled-module",
            config["compiled_module"],
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        env={
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "TOKIO_WORKER_THREADS": "1",
            "RAYON_NUM_THREADS": "1",
        },
    )
    try:
        stdout, stderr = proc.communicate(
            b"import time; print('SLEEPING_GUEST',flush=True); time.sleep(100)",
            timeout=6,
        )
        assert b"SLEEPING_GUEST" in stdout, (stdout, stderr)
        assert proc.returncode == -signal.SIGALRM
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=2)


def test_actual_controller_generated_channel_is_still_provisional(backend, tmp_path):
    from mathagent.controller import Controller
    from mathagent.domain import Artifact, ProblemContract, Scope, WorkUnit
    from mathagent.runtime.adapter import S2Adapter
    from mathagent.runtime.coordinator import GlobalCoordinator
    from mathagent.store import ArtifactStore
    from mathagent.testing import OFFLINE_CAPABILITIES, ScriptedClient, l3

    store = ArtifactStore(ProblemContract("Explore the finite value C(13,6)."))
    coord = GlobalCoordinator(tmp_path / "ledger", "actual-wasi-offline-review")
    item, _ = coord.register_item("one", store.problem.digest)
    coord.admit_item(item)
    client = ScriptedClient(
        [
            {
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "content": l3("COVERAGE: code and finite input; NO_ISSUE")
                        },
                        "finish_reason": "stop",
                    }
                ]
            }
        ]
    )
    controller = Controller(
        S2Adapter(client, coord, OFFLINE_CAPABILITIES),
        item,
        store,
        python_sandbox=backend,
    )
    code = "import math; print(math.comb(13,6)); print('VERIFIED')"
    text = (
        "TOOL: generated_python; INPUT: "
        + json.dumps({"code": code})
        + "; PURPOSE: finite calculation; DOMAIN: n=13,k=6; MAPPING: integer binomial coefficient"
    )
    unit = WorkUnit(
        "one-step",
        "r",
        "Explore one finite coefficient.",
        scope=Scope(domain="integer"),
    )
    artifact = Artifact(
        "proposal",
        store.problem.digest,
        "r",
        "one-step",
        text,
        "offline-proposal",
        unit.scope,
        (),
        (),
        True,
    )
    store.append(artifact)
    observation = controller._tool_workflow.process(artifact, unit)
    assert observation.request == "local_generated_python"
    assert "1716" in observation.text and "VERIFIED" in observation.text
    assert (
        not store.evidence
        and not store.candidates
        and observation.unverified_dependencies
    )
    assert len(client.calls) == 1
    assert controller._tool_workflow.process(artifact, unit) == observation
    assert len(client.calls) == 1
