# Track160 演示视频脚本（5 分钟 / 720P 分镜）

* 录屏执行：用户本机（无沙箱环境）；启动：`scripts\start_demo.bat`（8011 驾驶舱 + 8899 智衍 + 8787 mock）
* 原则：全部画面来自真实运行；合成数据处必须口头标注"synthetic"

| # | 时长 | 画面 | 解说要点 |
|---|---|---|---|
| 1 | 0:00-0:35 | `/home` 门户 | 兴智杯 Track160 方向 1：AI4S 全流程科研智能体。三张创新点卡 = 有界证据调度多选票审计 / 端砚协议状态机取消恢复 / 审计驾驶舱时间胶囊。顶部状态条=真实 /api/capabilities（当前 provider=mock，口头说明"无 key 走诚实不可用路径，不冒充模型结果"） |
| 2 | 0:35-1:30 | `/domains` 四域场景页 | **核心卖点：内核复制性**。四域注册表来自 GET /api/v2/domains（math 1.4.0 / control.identification / scientific_computing / data_analysis）。强调"第三领域 data_analysis 接入时 kernel 与调度核心 diff=0"（git 证据）。点进 control 最近 run |
| 3 | 1:30-2:15 | `/runs/p0_curl_idemp_1793336256`（控制辨识） | 七审计子标签走一遍：M1 契约（5 义务：防泄漏/物理边界/抗混叠/残差白性/独立 RMSE）→ RESULT（m=1.4915±CI、c、k 真值对照）→ 强调四不妥协：训练/验证隔离（T36）、欠采样拦截、残差非白判"结构欠定"、candidateVerified 恒 false |
| 4 | 2:15-2:45 | `/runs/p1_curl_da_idemp_20261030`（数据分析） | 展示 Welch t=-8.6507、df=97.07、三诊断全过；口头强调"统计量手算可复算（meanDiff/SE），非硬编码" |
| 5 | 2:45-3:20 | `/protocol` 协议观测台 | 打开 sess_k13_conflict409_retry：RECOVERY_409_CHECK→GATEWAY_EVENT×5→CANCEL_DECISION 泳道；validationStatus=pass 徽章=parseGatewayEvent 精确键校验；切 sess_k13_t21_throttle429 看 Retry-After 落盘 |
| 6 | 3:20-3:50 | `/protocol/resilience` 三场景卡 | 取消（本地 abort≠服务端停止的诚实语义）、409 恢复（5s 证明窗单次重试）、429 节流（预算守卫） |
| 7 | 3:50-4:20 | `/runs/golden_math_20261030_v3/replay` 时间胶囊回放 | 数学推导确定性回放（x=2,x=3，REVIEWS_COMPLETE）；展示 release/replay-packages/ 目录与 SHA256 |
| 8 | 4:20-4:45 | `/chat` 产品对话 | 思考开关快速/深度切换；发送一条；展示 reasoning_dispatched 尾注与"停止生成→远端状态未知"诚实标注（无 key 时显示 SOLVER_NOT_CONFIGURED，口头说明真实 Atria 冒烟证据见 docs/atria-smoke-log.md） |
| 9 | 4:45-5:00 | `/settings` + 收尾 | 只读提供方卡片（model/endpoint_host 脱敏）；一句话收束："从数学科研提炼的可验证内核，复制到控制、数值、统计三个领域，全程证据可回放、结论有边界" |

**禁拍**：任何含 API key 的环境变量面板、token、邮箱；/chat 实拍前确认无凭据泄露在画面中。
