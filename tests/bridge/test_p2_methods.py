"""Offline tests for the fixture-only method adapter over MethodCatalog."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from mathagent.lite import methods as methods_module
from mathagent.lite.methods import MethodCatalog
from python.astra_bridge import p2_methods

REPO_ROOT = Path(__file__).resolve().parents[2]
PRIVATE = "PRIVATE_SENTINEL"


def _real_root() -> Path:
    return Path(methods_module.__file__).resolve().parents[1] / "resources" / "general_v11"


def _spy(monkeypatch, calls):
    original = methods_module._read_bytes

    def spy(root, rel):
        calls.append(rel)
        return original(root, rel)

    monkeypatch.setattr(methods_module, "_read_bytes", spy)


def test_catalog_and_load_touch_only_the_named_reference(monkeypatch):
    calls: list[str] = []
    _spy(monkeypatch, calls)
    catalog = MethodCatalog()
    payload = p2_methods.fixture_catalog(catalog)
    assert payload["version"] == methods_module.EXPECTED_VERSION
    assert len(payload["entries"]) == 20
    assert all(set(row) == {"id", "title"} for row in payload["entries"])
    assert calls == ["SOURCE.json", "data/methods.json"]
    calls.clear()
    loaded = p2_methods.fixture_load("linearization-spectral", catalog=catalog)
    assert loaded["status"] == "loaded"
    asset = loaded["asset"]
    assert asset["id"] == "linearization-spectral"
    assert asset["version"] == methods_module.EXPECTED_VERSION
    assert asset["bodyChars"] == len(asset["body"])
    assert asset["bodySha256"] == hashlib.sha256(asset["body"].encode("utf-8")).hexdigest()
    assert calls == ["references/linearization-spectral.md"]
    source = json.loads((_real_root() / "SOURCE.json").read_text(encoding="utf-8"))
    assert source["files"]["references/linearization-spectral.md"] == asset["bodySha256"]


class _RefusingCatalog:
    def __init__(self):
        self.loads = 0

    def catalog(self):
        return [], None

    def load(self, method_id):
        self.loads += 1
        raise AssertionError(PRIVATE)

    def title(self, method_id):
        raise AssertionError(PRIVATE)


@pytest.mark.parametrize(
    "method_id",
    ["../SOURCE.json", "/etc/passwd", "UPPER", "m_0", "x" * 65, None, True],
)
def test_illegal_ids_are_refused_before_any_read(method_id):
    catalog = _RefusingCatalog()
    result = p2_methods.fixture_load(method_id, catalog=catalog)
    assert result == {"status": "not_found", "asset": None}
    assert catalog.loads == 0


def test_tampered_body_and_source_version(tmp_path):
    root = tmp_path / "resource"
    shutil.copytree(_real_root(), root)
    target = root / "references" / "linearization-spectral.md"
    target.write_text(target.read_text(encoding="utf-8") + "TAMPER", encoding="utf-8")
    catalog = MethodCatalog(root=root)
    assert len(p2_methods.fixture_catalog(catalog)["entries"]) == 20
    assert p2_methods.fixture_load("linearization-spectral", catalog=catalog) == {
        "status": "integrity_failed",
        "asset": None,
    }
    source = json.loads((root / "SOURCE.json").read_text(encoding="utf-8"))
    source["version"] = "0.0.0-bogus"
    (root / "SOURCE.json").write_text(json.dumps(source), encoding="utf-8")
    broken = MethodCatalog(root=root)
    assert p2_methods.fixture_catalog(broken)["entries"] == []
    assert p2_methods.fixture_load("linearization-spectral", catalog=broken) == {
        "status": "disabled",
        "asset": None,
    }


class _RaisingCatalog:
    def catalog(self):
        raise RuntimeError(PRIVATE)

    def load(self, method_id):
        raise RuntimeError(PRIVATE)

    def title(self, method_id):
        raise RuntimeError(PRIVATE)


def test_adapter_never_echoes_private_exception_text():
    catalog = _RaisingCatalog()
    assert p2_methods.fixture_catalog(catalog) == {
        "version": methods_module.EXPECTED_VERSION,
        "entries": [],
    }
    result = p2_methods.fixture_load("linearization-spectral", catalog=catalog)
    assert result == {"status": "disabled", "asset": None}
    assert PRIVATE not in json.dumps(result)


class _FakeCatalog:
    def __init__(self, result, title="t"):
        self._result = result
        self._title = title

    def catalog(self):
        return [{"id": "linearization-spectral", "title": self._title}], None

    def load(self, method_id):
        return self._result

    def title(self, method_id):
        return self._title


def _load_result(**overrides):
    body = "abc"
    base = {
        "status": "loaded",
        "method_id": "linearization-spectral",
        "title": "t",
        "body": body,
        "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "body_chars": 3,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_fake_loads_are_rejected_without_a_body():
    cases = [
        (_load_result(body_chars=True), "integrity_failed"),
        (_load_result(method_id="other"), "integrity_failed"),
        (_load_result(body="\ud800", body_chars=1), "disabled"),
    ]
    for result, expected in cases:
        out = p2_methods.fixture_load("linearization-spectral", catalog=_FakeCatalog(result))
        assert out == {"status": expected, "asset": None}


def _cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "python.astra_bridge.p2_methods", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=3,
    )


def test_cli_rejects_unknown_and_abbreviated_flags():
    for args in (["--root", "/tmp"], ["--meth", "linearization-spectral"], ["--method"]):
        done = _cli(*args)
        assert done.returncode == 2
        assert json.loads(done.stdout) == {"status": "disabled", "asset": None}
        assert done.stderr == ""
