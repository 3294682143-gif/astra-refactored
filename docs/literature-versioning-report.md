# Literature Search & Data Versioning Invalidation Report (F-10 / K16 / K17)

## 1. 文献源实测探测（Semantic Scholar Graph API）
- **目标端点**：`https://api.semanticscholar.org/graph/v1/paper/search`
- **实测连通性记录**：
  - TCP/TLS 握手：成功建立（`HTTP/1.1 200 Connection established`）
  - HTTP 响应：`HTTP/1.1 429 Too Many Requests`
  - 服务端回执：`{"message": "Too Many Requests. Please wait and try again or apply for a key for higher rate limits."}`
- **诚实降级处理（按任务书规定）**：
  - 判定：由于未提供付费/申请专用 API 密钥，免费 IP 级限流生效（HTTP 429）。
  - 执行：协议层（`python/astra_web/literature_client.py`）完整就绪；实测记录真实状态 `BLOCKED_RATE_LIMITED (HTTP 429)`，禁止伪造检索数据。
  - **T35 疑点保留**：当文献 `openAccessPdf` 状态为 CLOSED 或 URL 为空时，系统严格保留疑点 `T35_PDF_ACCESS_UNCERTAIN`，如实标注 "Publisher access restricted; PDF full text requires credential resolution"，绝不冒充已获取全文。

## 2. T37 数据改版失效演示（K17 最小闭环）
- **核心机制**：
  1. **数据集版本化**：数据集以不可变快照形式落盘（如 `ds_heat_diffusion_v1.json`、`ds_heat_diffusion_v2.json`），历史版本永不被覆盖或物理删除。
  2. **产物血缘追踪**：实验产物（如数值复现报告 `art_heat_report_001`）严格绑定上游数据集 ID、特定版本号与内容 SHA-256 哈希。
  3. **自动化失效触发**：当上游数据集从 v1 升级至 v2 时，注册表自动扫描依赖于历史版本的产物，将其状态原子转换为 `STALE`，并记录失效原因：
     `T37_DATASET_VERSION_UPDATED: Upstream dataset 'ds_heat_diffusion' promoted from v1 to v2`。
  4. **历史不可篡改**：旧产物内容与哈希保留在磁盘中，供审计溯源；新实验基于 v2 生成新产物（`art_heat_report_002`），状态为 `ACTIVE`。
- **验证用例**：`tests/test_f10_literature_and_versioning.py` 100% 通过。
