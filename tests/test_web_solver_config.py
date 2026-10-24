"""求解器接入配置（凭据只写不读）与用量面 的测试套件。

覆盖 G1：
1. 未配置时的诚实视图（configured=false，并给出官方端点目录）
2. PUT 保存后**不重启即接线**：wired=true 且 capabilities.execution.solver_configured 翻转
3. 凭据只写不读：PUT/GET/usage 的响应文本里绝不出现提交的凭据明文，只有 sha256 指纹
4. 端点/模型必须来自官方目录；非法组合被拒**且不落盘**
5. 缺字段 / 非 JSON 体 → 400
6. DELETE 清除并断线
7. 用量面：观测值只来自真实响应；余额无官方接口 → available=false 且给链接
8. 配置文件落在宿主数据根下（仓库之外），不产生仓库内文件
"""
from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from python.astra_web.app import create_app
from python.astra_web.solver_config import (
    BALANCE_LEDGER_URL,
    ENDPOINTS,
    credential_fingerprint,
)

CREDENTIAL = "test-supplied-credential-0001"
CHAT = ENDPOINTS[0]
INKSTONE = ENDPOINTS[1]


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # Never touch an ambient host configuration while testing.
    monkeypatch.delenv("ASTRA_USER_CLIENT_CONFIG", raising=False)
    app = create_app(data_root=tmp_path / "store", mount_static=False)
    return TestClient(app)


def test_unconfigured_view_is_honest(client: TestClient):
    body = client.get("/api/config/solver").json()
    assert body["configured"] is False
    assert body["wired"] is False
    assert body["endpoint"] is None
    assert body["model"] is None
    assert body["credential_fingerprint"] is None
    # The console needs the catalogue to offer a choice.
    keys = {entry["key"] for entry in body["endpoints"]}
    assert keys == {"intern-s2-chat", "intern-inkstone"}
    assert body["balance_ledger_url"] == BALANCE_LEDGER_URL


def test_put_wires_the_solver_without_a_restart(client: TestClient):
    before = client.get("/api/capabilities").json()
    assert before["execution"]["solver_configured"] is False

    response = client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": CHAT.models[0], "credential": CREDENTIAL},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is True
    assert body["wired"] is True
    assert body["endpoint"] == CHAT.url
    assert body["model"] == CHAT.models[0]

    after = client.get("/api/capabilities").json()
    assert after["execution"]["solver_configured"] is True


def test_inkstone_endpoint_also_wires(client: TestClient):
    response = client.put(
        "/api/config/solver",
        json={
            "endpoint": INKSTONE.url,
            "model": INKSTONE.models[0],
            "credential": CREDENTIAL,
        },
    )
    assert response.status_code == 200
    assert response.json()["wired"] is True
    assert client.get("/api/capabilities").json()["execution"]["solver_configured"] is True


def test_credential_is_write_only(client: TestClient):
    put = client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": CHAT.models[0], "credential": CREDENTIAL},
    )
    assert CREDENTIAL not in put.text

    get = client.get("/api/config/solver")
    assert CREDENTIAL not in get.text

    usage = client.get("/api/config/usage")
    assert CREDENTIAL not in usage.text

    # Only the fingerprint is exposed, and it must identify the real credential.
    assert get.json()["credential_fingerprint"] == credential_fingerprint(CREDENTIAL)


def test_unsanctioned_endpoint_is_rejected_and_not_persisted(
    client: TestClient, tmp_path: Path
):
    response = client.put(
        "/api/config/solver",
        json={
            "endpoint": "https://evil.example/v1/chat/completions",
            "model": "intern-s2",
            "credential": CREDENTIAL,
        },
    )
    assert response.status_code == 400
    assert CREDENTIAL not in response.text

    state = client.get("/api/config/solver").json()
    assert state["configured"] is False
    assert state["wired"] is False
    # A rejected submission must leave nothing behind on disk.
    assert not (tmp_path / "store" / "user_client.conf").exists()


def test_model_must_belong_to_the_selected_endpoint(client: TestClient):
    response = client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": INKSTONE.models[0], "credential": CREDENTIAL},
    )
    assert response.status_code == 400
    assert client.get("/api/config/solver").json()["configured"] is False


@pytest.mark.parametrize("missing", ["endpoint", "model", "credential"])
def test_required_fields(client: TestClient, missing: str):
    payload = {"endpoint": CHAT.url, "model": CHAT.models[0], "credential": CREDENTIAL}
    payload.pop(missing)
    assert client.put("/api/config/solver", json=payload).status_code == 400


def test_short_credential_is_rejected(client: TestClient):
    response = client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": CHAT.models[0], "credential": "short"},
    )
    assert response.status_code == 400


def test_delete_clears_and_unwires(client: TestClient):
    client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": CHAT.models[0], "credential": CREDENTIAL},
    )
    assert client.get("/api/capabilities").json()["execution"]["solver_configured"] is True

    removed = client.delete("/api/config/solver")
    assert removed.status_code == 200
    assert removed.json()["removed"] is True
    assert removed.json()["configured"] is False
    assert client.get("/api/capabilities").json()["execution"]["solver_configured"] is False


def test_usage_is_observed_only_and_balance_is_linked(client: TestClient):
    body = client.get("/api/config/usage").json()
    usage = body["usage"]
    # Nothing has been called yet: counts are real zeros, token figures unknown.
    assert usage["calls"] == 0
    assert usage["failures"] == 0
    assert usage["prompt_tokens"] is None
    assert usage["completion_tokens"] is None
    assert usage["total_tokens"] is None
    assert usage["unknown_usage_responses"] == 0
    # No balance API exists; the console must link out rather than invent a number.
    assert body["balance"]["available"] is False
    assert body["balance"]["ledger_url"] == BALANCE_LEDGER_URL


def test_config_file_lives_under_the_data_root(client: TestClient, tmp_path: Path):
    client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": CHAT.models[0], "credential": CREDENTIAL},
    )
    stored = tmp_path / "store" / "user_client.conf"
    assert stored.is_file()
    text = stored.read_text(encoding="utf-8")
    # The file is the one place the credential legitimately exists on disk, and it
    # is outside the repository.
    assert CREDENTIAL in text
    assert "endpoint=" + CHAT.url in text
