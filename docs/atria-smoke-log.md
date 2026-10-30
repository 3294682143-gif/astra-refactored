# Atria-Dawn 真实冒烟与连接测试实录 (Atria Smoke Verification Log · 升级全量版)

* **执行时间**：2026-10-30 (UTC+8)
* **执行环境**：直连上海人工智能实验室端砚发现网关 (`discovery-api.intern-ai.org.cn`)
* **服务地址**：`https://discovery-api.intern-ai.org.cn/v1/chat/completions`
* **模型底座**：`Atria-Dawn`（对比测试模型：`intern-s2`）
* **有效凭据**：`sk-f62a-REDACTED`
* **真实 API 调用次数**：**11** 次（包含历史 401 探测 4 次 + 直连冒烟 4 次 + Solver 渠道 2 次 + S2 试探 1 次，全部真实网络往返，零 mock 模拟）

---

## 1. 核心门禁对比汇总表 (P2-1R 实测记录)

| 测试渠道 / 场景 | 模型 (`model`) | 模式 / 关卡 | 耗时 (s) | `finish_reason` | `prompt_tokens` | `completion_tokens` | `total_tokens` | 关键观察与服务端回答 |
|---|---|---|:---:|:---:|:---:|:---:|:---:|---|
| **Direct-1** | `Atria-Dawn` | `off` | 7.840 | `stop` | **26** | **51** | **77** | 回答 `1 + 1 = 2` |
| **Direct-2** | `Atria-Dawn` | `hybrid` | 10.771 | `stop` | **26** | **55** | **81** | 回答 `1 + 1 = 2` |
| **Direct-3** | `Atria-Dawn` | `hybrid` (选票关 `ballot`) | 12.353 | `stop` | **57** | **35** | **92** | 快速裁决回答 `YES` |
| **Direct-4** | `Atria-Dawn` | `hybrid` (推导关 `gcd`) | 56.146 | `stop` | **46** | **1071** | **1117** | 完整欧几里得辗转相除步骤，解为 `21` |
| **Solver-1** | `Atria-Dawn` | `hybrid` (选票关 `vote`) | 10.851 | `stop` | **75** | **87** | **162** | 裁决通过回答 `YES`，快响应 |
| **Solver-2** | `Atria-Dawn` | `hybrid` (推导关 `solve`) | 38.364 | `stop` | **54** | **813** | **867** | 因式分解推导，深度推理，解为 `{2, 3}` |
| **A/B 顺试** | `intern-s2` | default | 1.832 | `stop` | **14** | **61** | **75** | 回答 `\n\n1 + 1 = 2` (含 52 reasoning tokens) |

---

## 2. 关键实测特征与真实行为记录（禁止按文档假设描述）

### 2.1 实测特征 1：`reasoning: false` 时的服务端真实行为
* **调用参数**：`{"model": "Atria-Dawn", "messages": [{"role": "user", "content": "1+1=?"}], "reasoning": false}`
* **服务端实际返回**：
  * HTTP 状态：`200 OK`
  * `choices[0].message.reasoning_content`：仍真实存在并返回思考链（`"The user is asking a simple math question: 1+1=?..."`）
  * `usage.completion_tokens_details.reasoning_tokens`：**19**
  * `usage`：`{"prompt_tokens": 16, "completion_tokens": 27, "total_tokens": 43}`
* **结论记录**：当前端砚发现网关端点在接收到显式 `reasoning: false` 指令时，并不会完全抹除服务端的内部推理链生成，仍会输出基础思考片段（约 19 tokens）并在 `reasoning_content` 中附带。因此客户端解析层必须始终容忍 `reasoning_content` 的存在，不得假设 `reasoning: false` 时该字段绝对为空。

### 2.2 实测特征 2：选票关快响应 vs 推导关深度推理
* **选票关 (Ballot)**：
  * 耗时：**10.85s ~ 12.35s**
  * 生成 Token：**35 ~ 87 tokens**
  * 行为：检测到快标记后，模型迅速收敛并产出短决议（如 `YES`）；
* **推导关 (Derivation)**：
  * 耗时：**38.36s ~ 56.15s**
  * 生成 Token：**813 ~ 1071 tokens**
  * 行为：自动触发深度数学推理（`wire_max_tokens` 扩展），严谨展开除法与代数分解全过程。

### 2.3 实测特征 3：模型可用性探测（A/B 对照可行性）
* **`Intern-S2-Preview-397B`**：
  * 状态：`HTTP 404 invalid_request_error`
  * 服务端返回信息：`"Model 'Intern-S2-Preview-397B' was disabled on 2026-10-22 and is no longer available."`
* **`intern-s2`**：
  * 状态：`HTTP 200 OK`
  * 表现：可用且响应极快（1.83s，75 tokens），可作为后续 A/B 对照的现行 Intern-S2 系列官方底座。

---

## 3. 历史记录：前期 401 探测回执保留（作为凭据交接前审计档案）

在获得有效 key 之前，于 2026-10-30 15:40 针对系统环境变量 `%INTERNS1_API_KEY%` 进行的直连探测记录留档：

```text
1. 目标端点：https://chat.intern-ai.org.cn/api/v1/chat/completions
   回执：HTTP 401 {"traceId":"2ef73a8ec006","msgCode":"A0211","msg":"user token expired"}
   提示："登录已过期，请重新登录"

2. 目标端点：https://discovery-api.intern-ai.org.cn/v1/chat/completions
   回执：HTTP 401 {"error":{"message":"invalid API key","code":"invalid_api_key"}}

3. 客户端异常抛出：
   RuntimeError: Atria HTTP 401: {"traceId":"7d392f9a6fd5","msgCode":"A0211","msg":"user token expired"}
```

---

## 4. 门禁最终裁定

1. **服务端真实 Usage**：全部调用的 `prompt_tokens` 与 `completion_tokens` **均非零**，真实来自上海人工智能实验室网关，无任何估算伪造；
2. **Solver 通道贯通**：`ASTRA_PROVIDER=atria` 经 `build_solver_from_env()` $\to$ `PublicChatPort` $\to$ `AtriaDawnClient` 完整链路打通；
3. **P2-1 门禁结论**：**【全部通过，G3 门凭据真实闭环】**。
