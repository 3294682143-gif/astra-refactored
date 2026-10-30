# Track160 技术方案 PDF 大纲（每节锚定真实代码与 commit）

* 评分对齐：完整性 30% / 实用性 40% / 技术实现难度 30%（方案 §23.1）
* 写作纪律：所有性能/能力声明必须能回溯到本文件列出的源码位置与 commit；未验证项如实标"建设中"

## 1. 问题（1 页）
- AI4S 智能体的两类通病：黑箱结论不可复核、单领域定制不可复制
- 赛题方向 1 要求：搜读算做写全流程 + 验证迭代 + 可复现
- 本方案主张：**从数学科研运行时中提炼领域无关的"目标契约+证据限定+有据修复"内核，用领域适配器复制到多类科学任务**

## 2. 核心设计（2 页）
- 通用内核五件：ContractLedger（I01 原始输入防篡改/I05 根预算硬拦截/I06 未发未决分账）、WorkUnitStore（I03 版本覆盖/I09 DAG 级联 STALE/T03 身份绑定）、CandidateGate（I15 candidateVerified 恒 false）、GenericLoop（契约编译→上下文→观察→义务→交付五步）、DomainAdapter 接口
  - 代码：`packages/agent-kernel/src/*.ts`（commit `3b3a70a` 起）；不变量测试 22/22
- Host 治理：PublicChatPort 冻结契约（temperature=0.2/max_tokens≤8192/stream=true/thinking=false/MAX_REQUEST_SECONDS=1200），`python/astra_bridge/public_chat_port.py:35-40`
- 端砚协议栈融合：gateway-events 精确键校验（text 载荷/嵌套 usage 四字段）、cancelInferenceDecision 取消语义、recovery 409 判定链（5s 证明窗单次重试）
  - 代码：inkstone `src/desktop/{gateway-events,cancel,recovery,atria-bridge-runner}.mjs`
- Atria-Dawn 接入：ASTRA_PROVIDER 三分支（atria/inkstone-desktop/s2）+ hybrid 混合推理（选票关 reasoning=False 快响应、推导关 wire_max_tokens 扩至 24576）+ 429 Retry-After 预算守卫
  - 代码：`mathagent/atria_client.py`、`python/astra_web/solver_adapter.py`

## 3. 复制性证据（1.5 页）——技术难度主证
| 领域 | 接入方式 | 证据 |
|---|---|---|
| math（原域） | 迁移等价 | math-parity 生产 bundle 子进程对照，四等价（投递/义务/预算/终态）5/5 通过（`packages/agent-kernel/tests/math-parity.test.mjs:438`） |
| control.identification | 第二领域实证 | 端到端 L2：阻尼振子 m/c/k 辨识 + CI + 四不妥协守卫（T36 训练/验证隔离、混叠、残差白性） |
| data_analysis | **第三领域零核心改动**（G4 决定性证据） | `git diff fe3a0c4..d3b54df -- packages/agent-kernel apps/stdio-runtime/src/agent-loop.ts` = 0 行；Welch t=-8.6507 手算可复算 |
| scientific_computing | 第四域 | FDM vs 解析解 L2 误差 0.000513、Richardson 收敛阶 1.997、故障注入触发 Challenge |

## 4. 实验（1.5 页）
- 真实 Atria-Dawn 冒烟：`docs/atria-smoke-log.md`（双模式 usage 非零、solver 通道选票 10.9s/87tok vs 推导 38.4s/813tok；**实测现象如实标注：reasoning:false 不切断思维链 ≈19 tokens**）
- K13 恢复三矩阵：T25 断线重连 / T21 429 节流（Retry-After=3s 预算守卫）/ 409 冲突恢复，11/11
- 测试矩阵覆盖清单与真实计数来源：`docs/fact-table.md` §5
- A/B 对照底座事实：`Intern-S2-Preview-397B` 2026-10-22 下线，改用 `intern-s2`

## 5. 边界与诚实声明（1 页）
- 建设中项：Inkstone UI 级合体（导航级已合）、文献检索真实接入（429 频控留档）、生信/地学领域包、课题组/机构部署形态
- 环境性失败基线与复现条件（`docs/fact-table.md` §4）
- Atria 来源与用量：官方 API（discovery-api.intern-ai.org.cn），模型标识 Atria-Dawn；usage 全部来自服务端回执，无估算
- candidateVerified 恒 false：系统不宣称"已验证"，候选交付附证据与适用范围

## 6. 复现指引（0.5 页）
- 一键启动 `scripts/start_demo.bat`（8011+8899+8787 三进程）
- 时间胶囊回放：`release/replay-packages/` 四域（manifest 含 SHA256 与复跑命令）
- 构建与校验：`pnpm tsc -b`、`python scripts/build_release_manifest.py --verify`
