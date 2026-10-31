# F-22 终核报告（CodeArts 最终验收）

* **日期**：2026-10-30
* **范围**：任务书 v2.1 全部 F 项 + 两仓推送 + 安全审计
* **结论**：**通过，可提交参赛**

## 1. 推送状态（远端已验证）

| 仓库 | 分支 | 远端 HEAD | 服务端回执 |
|---|---|---|---|
| inkstone-re-lab | `re/windows-desktop-027` | `c3e104c`（fb014b3 K13 + c3e104c F-05 导航入口） | `unpack ok` + `ok refs/...` |
| astra-refactored | `track160-submission`（新分支） | `25fbd12`（26 commit 干净链） | `unpack ok` + `ok refs/...`，42MB/65s |

## 2. 安全审计（发现并修复真实泄露）

- **发现**：施工方在 `docs/atria-smoke-log.md:7` 与 `scripts/run_p2_1_{atria_smoke,solver_channel}.py` 硬编码了完整 Atria API key（commit `398977b` 引入）。
- **修复**：① 三文件当前版本脱敏（`624aabd`/`dc50d1e`）；② filter-branch 两次不可行（tree-filter 超时、index-filter 无声失败）后改用**精准历史手术**：`398977b` amend 脱敏 + 后续 7 个干净 commit cherry-pick 重链，跳过冗余脱敏 commit。
- **验证**：`git grep <完整key> $(git rev-list --all)` = **0**；工作树全扫 = **0**；旧 key（sk-MEUnAM6）历史中仅为 `sk-MEUnAM6...` 前缀引用（施工方原已脱敏）。
- **遗留提醒**：该 key 曾在对话与本会话历史中明文出现，**赛后必须到端砚控制台轮换**；GitHub PAT 同理。

## 3. 回归与校验（全部复跑）

| 项 | 命令 | 结果 |
|---|---|---|
| 全仓编译 | `tsc -b`（直接 node 调用） | EXIT=0 |
| kernel 测试 | `node --test "packages/agent-kernel/tests/*.test.mjs"` | 22/22 |
| 域测试 | `node --test "tests/domains/*/*.test.mjs"` | 21/21（control 7 + data_analysis 8 + scicomp 6） |
| python 测试 | `pytest tests/runtime_v2 tests/test_atria_client tests/test_web_solver_adapter tests/test_web_public_chat_port` | 42/42 |
| 资产同步 | `python scripts/build_math_assets.py --check` | OK byte-identical |
| 发布清单 | `python scripts/build_release_manifest.py --verify` | VERIFY_OK（commit=25fbd12 链内） |
| 前端构建 | vite build（TEMP 重定向） | 485KB，typecheck=0 |
| inkstone UI 自检 | `node scripts/check-self-ui.mjs` | 通过（零官方引用） |

## 4. 全量完成定义对照（方案 §26 诚实终态）

| 类别 | 终态 | 关键证据 |
|---|---|---|
| 内核 | ✅ 已验证 | agent-kernel 22 测试 + 进生产 bundle |
| 数学 | ✅ 已验证 | 生产 bundle 子进程级四等价对照 |
| 复制性 | ✅ 已验证 | control/data_analysis/scicomp 三域真实端到端；案例 D 零核心改动 |
| 模型（Atria） | ✅ 已验证 | 真实冒烟 usage 非零 + 双模式 + reasoning:false 实测现象如实记录 |
| 工程（恢复/幂等/取消） | ✅ 已验证 | K13 三矩阵 + F-12 九用例 + F-06 T34 |
| 证据/复现 | ✅ 已验证 | 四域时间胶囊（SHA256 + manifest） |
| 产品（Inkstone 主工作台） | ⚠️ 建设中 | 导航级合体已交付；UI 级合体未做（如实标注） |
| 科研链路 | ⚠️ 骨架真实 | T37 数据版本已验证；文献源 429 频控留档，真实检索未验证 |
| 专业场景 | ⚠️ 三域已验证 | 生信/地学不交付（如实标注） |
| 材料 | ✅ 已齐 | fact-table / tech-report-outline / demo-video-script / atria-model-note / deployment-checklist |
| 环境性失败基线 | 已如实标注 | TestClient 9 例（沙箱 loopback）、R1 3 例（Windows 无 /proc，基线 commit 对照证实非回归） |

## 5. 提交前用户侧剩余动作（非代码）

1. 刷新/轮换凭据：Atria key + GitHub PAT（均曾在对话明文出现）
2. 录制演示视频：按 `docs/demo-video-script.md` 九分镜（禁拍凭据）
3. 按 `docs/tech-report-outline.md` 导出技术方案 PDF
4. 提交系统链接填写：应用体验入口 `http://127.0.0.1:8011/home`（`scripts\start_demo.bat` 一键起）
