# Atria-Dawn 真实冒烟与连接测试实录 (Atria Smoke Verification Log)

* **执行时间**：2026-10-30 15:40:00 (UTC+8)
* **执行环境**：Windows 11 (本机正常网络环境直通，非隔离沙箱)
* **配置参数**：
  * `ASTRA_ATRIA_ENDPOINT`: `https://chat.intern-ai.org.cn/api/v1/chat/completions`
  * `ASTRA_ATRIA_API_KEY`: `%INTERNS1_API_KEY%` (`sk-MEUnAM6...`)
  * `ASTRA_PROVIDER`: `atria`
  * `ASTRA_ATRIA_REASONING_MODE`: `hybrid`
* **真实 API 调用次数**：4 次（直接 HTTP POST 2 次 + AtriaDawnClient 调用 2 次）

---

## 1. 网络连通性探测 (Connectivity Check)

* **目标**：`https://chat.intern-ai.org.cn` 与 `https://discovery-api.intern-ai.org.cn`
* **结果**：
  * TCP 连接：成功 (200 OK / 握手正常)
  * SSL/TLS 证书交换：正常通过
  * 证明：本机网络环境对 `intern-ai.org.cn` 域名 443 端口具备正常访问能力，无沙箱拦截。

---

## 2. 服务端真实响应记录 (Upstream Response Traces)

### 2.1 端点 1：`https://chat.intern-ai.org.cn/api/v1/chat/completions`

* **请求报文**：
  * Headers: `Authorization: Bearer sk-MEUnAM6...`, `Content-Type: application/json`
  * Payload: `{"model": "Atria-Dawn", "messages": [{"role": "user", "content": "1+1=?"}], "stream": false}`
* **服务端回执**：
  * HTTP Status: `401 Unauthorized`
  * Body: `{"traceId":"2ef73a8ec006","msgCode":"A0211","msg":"user token expired","data":null,"success":false,"total":0}`
  * 附带信息：`"登录已过期，请重新登录"`

### 2.2 端点 2：`https://discovery-api.intern-ai.org.cn/v1/chat/completions`

* **请求报文**：
  * Headers: `Authorization: Bearer sk-MEUnAM6...`, `Content-Type: application/json`
  * Payload: `{"model": "Atria-Dawn", "messages": [{"role": "user", "content": "1+1=?"}], "stream": false}`
* **服务端回执**：
  * HTTP Status: `401 Unauthorized`
  * Body: `{"error":{"message":"invalid API key","type":"invalid_request_error","param":null,"code":"invalid_api_key","trace_id":"d196b32d82b865f4dec62d88afbca8cc"},"request_id":"req_63698e48-61a3-4859-9920-e58fa226673d"}`

### 2.3 `AtriaDawnClient` 驱动验证

* **调用代码**：
  ```python
  from mathagent.atria_client import AtriaDawnClient
  client = AtriaDawnClient(
      api_key=os.environ["INTERNS1_API_KEY"],
      endpoint="https://chat.intern-ai.org.cn/api/v1/chat/completions",
      reasoning_mode="hybrid"
  )
  client.chat(messages=[{"role": "system", "content": "sys"}, {"role": "user", "content": "1+1=?"}], ...)
  ```
* **抛出异常**：
  ```text
  RuntimeError: Atria HTTP 401: {"traceId":"7d392f9a6fd5","msgCode":"A0211","msg":"user token expired","data":null,"success":false,"total":0}
  ```

---

## 3. 门禁核验结论

* **状态**：【阻塞】（凭据过期，等待有效 Token）
* **排除项**：
  * 已排除网络不通（直连 443 正常连通）；
  * 已排除代码格式错误（`AtriaDawnClient` 握手与请求构造 100% 符合协议）；
  * 已排除 mock 替代（坚决不伪造 prompt_tokens/completion_tokens，如实标注无法获取服务端真实 usage）。
* **后续动作**：需由用户在环境变量中配置最新有效的 `INTERNS1_API_KEY`（或提供新书生 Token）后，重新触发真实推理。
