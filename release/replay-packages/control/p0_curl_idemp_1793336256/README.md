# 时间胶囊 · control / p0_curl_idemp_1793336256

- 状态：candidate（stopReason=STOPPED）
- provider：mock（candidateVerified=False）
- 离线回放：`details.json` 为 L2 全量存档原样拷贝（SHA256 见 manifest.json）；
  将其放入 ASTRA_DATA_ROOT/runs/p0_curl_idemp_1793336256/ 后启动 BFF，访问 /runs/p0_curl_idemp_1793336256/replay。
- 复跑：问题文本见 manifest.json 的 problem 字段，经 POST /api/v2/runs 同域重跑对比。
