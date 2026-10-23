"""D-03 只读 BFF / 导入 / 存档 的测试套件。

覆盖：
1. 存储层 (storage.py): 初始化、安全路径拼接 safe_join 防穿越、SQLite 增删查、多条件过滤
2. 存档层 (archive.py): atomic_write_bytes / atomic_write_json 原子写与覆写
3. 重放导入层 (replays.py): L1/L2/L3 载荷校验、run_id 规则、多格式导入、JSONL 容错
4. BFF 接口层 (app.py): /api/health (不调用模型), /api/capabilities, /api/runs, /api/replays, /api/assets
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
import pytest

from python.astra_web.storage import (
    Store,
    PathTraversalError,
    DuplicateRunError,
    is_valid_run_id,
)
from python.astra_web.archive import atomic_write_bytes, atomic_write_json
from python.astra_web.replays import (
    ImportValidationError,
    normalize_run,
    import_json_bytes,
    import_jsonl_bytes,
)
from python.astra_web.app import (
    create_app,
    health,
    capabilities,
    list_runs,
    get_run,
    list_replays,
    get_replay,
    list_assets,
    download_asset,
)
from starlette.requests import Request
from starlette.exceptions import HTTPException


@pytest.fixture
def temp_store(tmp_path: Path) -> Store:
    return Store(root=tmp_path / "store")


def test_is_valid_run_id():
    assert is_valid_run_id("run-001") is True
    assert is_valid_run_id("abc.123_DEF-99") is True
    assert is_valid_run_id("../evil") is False
    assert is_valid_run_id("") is False
    assert is_valid_run_id(None) is False
    assert is_valid_run_id("/root") is False


def test_storage_safe_join(temp_store: Store):
    safe_path = temp_store.safe_join("runs/run-1/details.json")
    assert safe_path.is_relative_to(temp_store.root)

    with pytest.raises(PathTraversalError):
        temp_store.safe_join("../outside.txt")

    with pytest.raises(PathTraversalError):
        temp_store.safe_join("runs/../../outside.txt")


def test_archive_atomic_writes(tmp_path: Path):
    target = tmp_path / "test" / "file.json"
    data = {"hello": "world", "number": 123}
    atomic_write_json(target, data)
    assert target.is_file()
    assert json.loads(target.read_text(encoding="utf-8")) == data

    # 覆写
    atomic_write_bytes(target, b"new bytes")
    assert target.read_bytes() == b"new bytes"


def test_replays_normalize_run_valid():
    raw = {
        "run_id": "run-test-1",
        "created_at": 1700000000.0,
        "status": "ok",
        "scenario": "imo-2024-p1",
        "model": "deepseek-v4.1",
        "seed": 42,
        "duration_s": 12.5,
        "summary": {"answer": "x = 42", "candidate_verified": False},
        "details": [{"step": 1, "action": "factorize"}],
        "artifacts": [{"name": "diagram.txt", "text": "A---B"}],
        "tags": ["math", "algebra"],
    }
    norm = normalize_run(raw, source="test")
    assert norm["run_id"] == "run-test-1"
    assert norm["status"] == "ok"
    assert norm["scenario"] == "imo-2024-p1"
    assert norm["summary"]["candidate_verified"] is False
    assert norm["checksum"] is not None


def test_replays_normalize_run_rejects_missing_l1():
    with pytest.raises(ImportValidationError, match="missing L1 payload"):
        normalize_run({"run_id": "run-x", "created_at": 100.0}, source="test")


def test_replays_import_json_and_duplicate(temp_store: Store):
    sample = {
        "run_id": "run-import-1",
        "status": "ok",
        "scenario": "test-scenario",
        "summary": {"status": "candidate", "candidate_verified": False},
        "details": {"steps": [1, 2, 3]},
        "artifacts": [
            {"name": "output.txt", "text": "sample text"},
            {"name": "data.bin", "data_base64": "SGVsbG8gV29ybGQ="},
        ],
    }
    res = import_json_bytes(temp_store, json.dumps(sample).encode("utf-8"))
    assert res["run_id"] == "run-import-1"
    assert res["assets"] == 2
    assert temp_store.has_run("run-import-1")

    # 查运行
    run = temp_store.get_run("run-import-1")
    assert run is not None
    assert run["scenario"] == "test-scenario"
    assert run["l2_path"] is not None

    # 重复导入默认抛错
    with pytest.raises(ImportValidationError, match="duplicate run_id"):
        import_json_bytes(temp_store, json.dumps(sample).encode("utf-8"))

    # overwrite=True 成功
    res_overwrite = import_json_bytes(
        temp_store, json.dumps(sample).encode("utf-8"), overwrite=True
    )
    assert res_overwrite["run_id"] == "run-import-1"


def test_replays_import_jsonl(temp_store: Store):
    line1 = json.dumps({"run_id": "run-l1", "summary": {"val": 1}})
    line2 = "# comment line"
    line3 = json.dumps({"run_id": "run-l2", "summary": {"val": 2}})
    blob = f"{line1}\n{line2}\n\n{line3}\n".encode("utf-8")

    res = import_jsonl_bytes(temp_store, blob)
    assert len(res) == 2
    assert res[0]["run_id"] == "run-l1"
    assert res[1]["run_id"] == "run-l2"


def _make_dummy_request(app, method="GET", path="/", query_params=None, path_params=None):
    from urllib.parse import urlencode
    qs = urlencode(query_params or {}).encode("utf-8")
    scope = {
        "type": "http",
        "app": app,
        "method": method,
        "path": path,
        "query_string": qs,
        "headers": [],
        "path_params": path_params or {},
    }
    return Request(scope)


def test_bff_health_endpoint(temp_store: Store):
    app = create_app(data_root=temp_store.root, mount_static=False)
    req = _make_dummy_request(app, path="/api/health")
    resp = health(req)
    assert resp.status_code == 200
    data = json.loads(resp.body.decode("utf-8"))
    assert data["status"] == "ok"
    assert data["service"] == "astra-web-bff"
    assert data["model_invoked"] is False  # 红线：严格禁止调用模型


def test_bff_capabilities_endpoint(temp_store: Store):
    app = create_app(data_root=temp_store.root, mount_static=False)
    req = _make_dummy_request(app, path="/api/capabilities")
    resp = capabilities(req)
    assert resp.status_code == 200
    data = json.loads(resp.body.decode("utf-8"))
    assert data["read_only"] is True
    assert data["model_invoked"] is False
    assert "/api/runs" in data["routes"]


def test_bff_runs_and_replays_endpoints(temp_store: Store):
    app = create_app(data_root=temp_store.root, mount_static=False)

    # 导入数据
    run_payload = {
        "run_id": "run-bff-01",
        "scenario": "geometry",
        "summary": {"score": 100},
        "details": {"nodes": ["A", "B"]},
        "artifacts": [{"name": "proof.txt", "text": "QED"}],
    }
    import_json_bytes(temp_store, json.dumps(run_payload).encode("utf-8"))

    # GET /api/runs
    req = _make_dummy_request(app, path="/api/runs", query_params={"limit": 10})
    resp = list_runs(req)
    assert resp.status_code == 200
    runs_data = json.loads(resp.body.decode("utf-8"))
    assert runs_data["count"] == 1
    assert runs_data["items"][0]["run_id"] == "run-bff-01"

    # GET /api/runs/{run_id}
    req = _make_dummy_request(app, path="/api/runs/run-bff-01", path_params={"run_id": "run-bff-01"})
    resp = get_run(req)
    assert resp.status_code == 200
    run_detail = json.loads(resp.body.decode("utf-8"))
    assert run_detail["run_id"] == "run-bff-01"
    assert len(run_detail["assets"]) == 1

    # GET /api/replays
    req = _make_dummy_request(app, path="/api/replays")
    resp = list_replays(req)
    assert resp.status_code == 200
    replays_data = json.loads(resp.body.decode("utf-8"))
    assert replays_data["count"] == 1

    # GET /api/replays/{run_id}
    req = _make_dummy_request(app, path="/api/replays/run-bff-01", path_params={"run_id": "run-bff-01"})
    resp = get_replay(req)
    assert resp.status_code == 200
    replay_detail = json.loads(resp.body.decode("utf-8"))
    assert replay_detail["details"] == {"nodes": ["A", "B"]}

    # GET /api/assets
    req = _make_dummy_request(app, path="/api/assets")
    resp = list_assets(req)
    assets_data = json.loads(resp.body.decode("utf-8"))
    assert assets_data["count"] == 1

    # GET /api/assets/{asset_id}
    asset_id = assets_data["items"][0]["asset_id"]
    req = _make_dummy_request(app, path=f"/api/assets/{asset_id}", path_params={"asset_id": asset_id})
    resp = download_asset(req)
    assert resp.status_code == 200


def test_bff_static_dist_mount(tmp_path: Path):
    dist_dir = tmp_path / "web_dist"
    dist_dir.mkdir()
    index_html = dist_dir / "index.html"
    index_html.write_text("<!DOCTYPE html><html><body>Astra UI</body></html>", encoding="utf-8")

    app = create_app(data_root=tmp_path / "data", web_dist=dist_dir, mount_static=True)
    assert app.state.web_dist == dist_dir
    # 验证路由表中已挂载静态资源
    route_names = [r.name for r in app.routes if hasattr(r, "name")]
    assert "web" in route_names

