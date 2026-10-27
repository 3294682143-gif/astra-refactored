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
    SolverConfig,
    credential_fingerprint,
)

CREDENTIAL = "test-supplied-credential-0001"
CHAT = ENDPOINTS[0]
INKSTONE = ENDPOINTS[1]


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # Pin the host configuration into this test's own tmp dir. The production
    # default is the user-level directory (and never a path inside the repo), so a
    # test must both avoid that directory and not rely on the repository layout.
    monkeypatch.setenv("ASTRA_USER_CLIENT_CONFIG", str(tmp_path / "user_client.conf"))
    app = create_app(data_root=tmp_path / "store", mount_static=False)
    return TestClient(app)


@pytest.fixture(autouse=True)
def offline_model_listing(monkeypatch: pytest.MonkeyPatch):
    """Keep the suite offline.

    PUT now asks the endpoint itself which models it serves, so without this the
    suite would depend on the network. Individual tests override this patch when
    they need to exercise the accept/reject branches.
    """
    import python.astra_web.app as app_module

    def unavailable(endpoint, credential, **kwargs):
        raise ValueError("model listing unavailable in the offline suite")

    monkeypatch.setattr(app_module, "fetch_models", unavailable)


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


def test_put_accepts_a_model_the_endpoint_actually_serves(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    import python.astra_web.app as app_module

    # The endpoint reports 11 models; the repository records 1. The endpoint wins.
    monkeypatch.setattr(
        app_module, "fetch_models", lambda endpoint, credential, **kw: ["intern-s2", "another"]
    )
    response = client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": "intern-s2", "credential": CREDENTIAL},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["wired"] is True
    assert body["model_verified"] is True


def test_put_rejects_a_model_the_endpoint_does_not_serve(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    import python.astra_web.app as app_module

    monkeypatch.setattr(app_module, "fetch_models", lambda endpoint, credential, **kw: ["intern-s2"])
    response = client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": "definitely-not-served", "credential": CREDENTIAL},
    )
    assert response.status_code == 400
    assert "端点未提供该模型" in response.json()["detail"]
    assert client.get("/api/config/solver").json()["configured"] is False


def test_put_says_so_when_the_list_cannot_be_read(client: TestClient):
    # The autouse fixture makes listing fail; the submission is still accepted, and
    # the response states that it was not verified instead of implying it was.
    response = client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": "intern-s2", "credential": CREDENTIAL},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["model_verified"] is False
    assert "未能向端点核对模型列表" in body["model_verified_note"]
    # The model from the endpoint's own list must NOT be rejected for being absent
    # from the repository's stale known list.
    assert client.get("/api/capabilities").json()["execution"]["solver_configured"] is True


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


def test_config_file_lives_outside_the_repository(client: TestClient, tmp_path: Path):
    client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": CHAT.models[0], "credential": CREDENTIAL},
    )
    stored = tmp_path / "user_client.conf"
    assert stored.is_file()
    text = stored.read_text(encoding="utf-8")
    # The file is the one place the credential legitimately exists on disk...
    assert CREDENTIAL in text
    assert "endpoint=" + CHAT.url in text
    # ...and it must not sit under the BFF data root, which lives inside the
    # repository (and would make the worktree credential gate fail).
    assert not (tmp_path / "store" / "user_client.conf").exists()


def test_default_config_path_is_not_inside_the_repository(
    monkeypatch: pytest.MonkeyPatch,
):
    from python.astra_web.solver_config import config_path

    monkeypatch.delenv("ASTRA_USER_CLIENT_CONFIG", raising=False)
    resolved = config_path()
    repo_root = Path(__file__).resolve().parents[1]
    assert repo_root not in resolved.resolve().parents


def test_models_endpoint_rejects_unsanctioned_endpoint(client: TestClient):
    response = client.post(
        "/api/config/models",
        json={"endpoint": "https://evil.example/v1/chat/completions", "credential": CREDENTIAL},
    )
    assert response.status_code == 400
    assert CREDENTIAL not in response.text


def test_models_endpoint_passes_through_what_the_endpoint_reports(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    import python.astra_web.app as app_module

    monkeypatch.setattr(
        app_module, "fetch_models", lambda endpoint, credential, **kw: ["m-a", "m-b"]
    )
    response = client.post(
        "/api/config/models", json={"endpoint": CHAT.url, "credential": CREDENTIAL}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "endpoint"
    assert body["models"] == ["m-a", "m-b"]
    assert CREDENTIAL not in response.text


def test_models_endpoint_falls_back_and_says_so(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    import python.astra_web.app as app_module

    def boom(endpoint, credential, **kwargs):
        raise ValueError("unreachable in this environment")

    monkeypatch.setattr(app_module, "fetch_models", boom)
    response = client.post(
        "/api/config/models", json={"endpoint": CHAT.url, "credential": CREDENTIAL}
    )
    assert response.status_code == 200
    body = response.json()
    # The fallback must identify itself, never masquerade as a live list.
    assert body["source"] == "fallback"
    assert body["models"] == list(CHAT.models)
    assert "未能从端点获取模型列表" in body["detail"]
    assert CREDENTIAL not in response.text


def test_models_endpoint_uses_the_stored_credential(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    import python.astra_web.app as app_module

    seen: list[str] = []

    def capture(endpoint, credential, **kwargs):
        seen.append(credential)
        # Must contain the configured model, or the new live-list check rejects it.
        return [CHAT.models[0]]

    monkeypatch.setattr(app_module, "fetch_models", capture)
    client.put(
        "/api/config/solver",
        json={"endpoint": CHAT.url, "model": CHAT.models[0], "credential": CREDENTIAL},
    )
    seen.clear()
    response = client.post("/api/config/models", json={"endpoint": CHAT.url})
    assert response.status_code == 200
    assert seen == [CREDENTIAL]
    assert CREDENTIAL not in response.text


def test_model_ids_accepts_the_shapes_endpoints_return():
    from python.astra_web.solver_runtime import _model_ids

    assert _model_ids({"data": [{"id": "a"}, {"id": "b"}, {"id": "a"}]}) == ["a", "b"]
    assert _model_ids({"models": ["x", "y"]}) == ["x", "y"]
    assert _model_ids(["only"]) == ["only"]
    assert _model_ids({"unexpected": 1}) == []


# --------------------------------------------------------------------------- #
# Solver adapter call path. This is where the workbench broke: the adapter
# referenced a StopReason member that does not exist, so every real run
# collapsed into an unclassified ERROR and no module call was ever made.
# --------------------------------------------------------------------------- #

ANSWER_PAYLOAD = {
    "choices": [
        {
            "index": 0,
            "message": {"content": "候选答案：P(x) 是某整系数多项式的平方。"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
}


def _build_adapter(endpoint, monkeypatch: pytest.MonkeyPatch, call):
    import python.astra_web.solver_runtime as runtime

    monkeypatch.setattr(runtime, "_call_openai_compatible", call)
    config = SolverConfig(
        endpoint=endpoint.url, model=endpoint.models[0], credential=CREDENTIAL, source=Path("x")
    )
    usage = runtime.UsageLedger()
    return runtime.build_solver(config, usage), usage


def test_solver_adapter_yields_a_candidate_with_a_real_stop_reason(
    monkeypatch: pytest.MonkeyPatch,
):
    from python.astra_web.contracts.enums import StopReason
    from python.astra_web.contracts.mapping import classify_stop_reason

    solve, usage = _build_adapter(INKSTONE, monkeypatch, lambda c, p, t: ANSWER_PAYLOAD)
    outcome = solve({"problem": "证明题"})

    assert outcome.stop_reason is StopReason.SOLVED
    # The authoritative mapping turns SOLVED into the *candidate* status — never
    # into a claim that the answer was verified.
    assert classify_stop_reason(outcome.stop_reason).value == "candidate"
    assert outcome.final_response == "候选答案：P(x) 是某整系数多项式的平方。"
    assert outcome.executed is True
    assert usage.calls == 1 and usage.total_tokens == 15


def test_solver_adapter_reports_a_real_failure_as_a_system_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    from python.astra_web.contracts.enums import StopReason

    def boom(config, problem, timeout):
        raise TimeoutError("no answer")

    solve, usage = _build_adapter(INKSTONE, monkeypatch, boom)
    outcome = solve({"problem": "证明题"})

    assert outcome.stop_reason is StopReason.ERROR
    assert outcome.code == "TRANSPORT_FAILED"
    assert outcome.executed is True
    assert outcome.final_response == "Unsolved."
    assert usage.failures == 1


def test_solver_adapter_treats_thinking_only_truncation_as_a_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    payload = {"choices": [{"message": {"content": None}, "finish_reason": "length"}], "usage": {}}
    solve, _ = _build_adapter(INKSTONE, monkeypatch, lambda c, p, t: payload)
    outcome = solve({"problem": "证明题"})
    assert outcome.code == "TRUNCATED_THINKING_ONLY"
    assert outcome.final_response == "Unsolved."


def test_solver_adapter_never_invents_usage(monkeypatch: pytest.MonkeyPatch):
    payload = {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}
    solve, usage = _build_adapter(INKSTONE, monkeypatch, lambda c, p, t: payload)
    solve({"problem": "证明题"})
    snapshot = usage.snapshot()
    # No usage block was reported: the figures stay unknown, never 0.
    assert snapshot["total_tokens"] is None
    assert snapshot["prompt_tokens"] is None
    assert snapshot["unknown_usage_responses"] == 1


def test_solver_adapter_requires_problem_text(monkeypatch: pytest.MonkeyPatch):
    solve, _ = _build_adapter(INKSTONE, monkeypatch, lambda c, p, t: ANSWER_PAYLOAD)
    outcome = solve({})
    assert outcome.code == "REQUEST_INVALID"
    assert outcome.final_response == "Unsolved."
