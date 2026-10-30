# Atria-Dawn 模型说明（参赛材料附件）

## 来源与标识
- 模型：**Atria-Dawn**（上海人工智能实验室 · 端砚/Intern 系列）
- 官方资料：HuggingFace `internlm/Atria-Dawn` 模型卡与 `internlm/atria-dawn` 合集
- 接入端点：`https://discovery-api.intern-ai.org.cn/v1/chat/completions`（OpenAI 兼容，SSE 流式）
- 备选端点：`https://chat.intern-ai.org.cn/api/v1/chat/completions`（同 key 可用，S2 系模型同端点）
- 接入方式：官方托管 API，未本地部署权重；凭据仅存服务端环境变量（`ASTRA_ATRIA_API_KEY`），浏览器与导出包不含凭据

## 接入实现（可审查代码）
- 直连客户端：`mathagent/atria_client.py::AtriaDawnClient`
  - 端点主机/模型白名单、文本双消息校验、temperature=0.2/max_tokens≤8192 冻结契约（对齐 PublicChatPort）
  - 混合推理（ASTRA_ATRIA_REASONING_MODE）：`off` / `hybrid`（选票/审计关快响应 reasoning=False，推导关 wire_max_tokens 扩至 24576）/ `auto_expand`
  - 429 处理：读取 `Retry-After`，预算不足时拒绝重试而非挂死；取消句柄在等待期可打断
  - usage 解析：OpenAI 三字段与 inkstone USAGE_KEYS 四字段双兼容；缺省值保留 null，**零值不伪造**
- 桥接通道：`mathagent/atria_client.py::InkstoneDesktopBridgeClient` + inkstone `src/desktop/atria-bridge-runner.mjs`
  - 事件流经 `parseGatewayEvent` 精确键校验（载荷键 `text`、usage 嵌套四字段）
  - 取消：`cancelInferenceDecision` 真实签名（身份不符抛错；本地 abort ≠ 服务端停止）
  - 409 冲突：5s 证明窗内单次重试（recovery.mjs 判定链）

## 使用范围
- 求解运行时（M1-M5 架构的模型调用：WORK/REVIEW/BALLOT 等帧）
- 产品对话演示通道（/chat，明确标注"不产生求解证书"）
- 协议观测台实时事件源（经桥接通道时）

## 实测行为记录（2026-10-30 真实调用，`docs/atria-smoke-log.md`）
- 双模式 usage（服务端回执）：off 26/51/77、hybrid 26/55/81（prompt/completion/total tokens）
- solver 通道：选票关 10.851s/87tok 快响应；推导关 38.364s/813tok 深度推导——混合模式实际生效
- **重要实测现象**：请求显式 `reasoning:false` 时，响应仍包含 `reasoning_content`（约 19 reasoning tokens）。本系统客户端按实测容忍该字段，材料不假设其为空。
- `Intern-S2-Preview-397B` 已于 2026-10-22 下线（HTTP 404 model_disabled）；对照底座改用 `intern-s2`（同 key 实测 200 可用）

## 用量与成本
- 全部 usage 取自服务端回执（prompt_tokens/completion_tokens/total_tokens），本系统不估算
- 账户级 60 RPM 限流由客户端 Retry-After 守卫处理；具体配额以报名提额结果为准（方案 §23.1 已声明不假定跨平台互通）
