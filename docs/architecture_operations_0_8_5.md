# 0.8.5 准备、运行、停止与恢复

这是已经实现的本地入口说明，不是正式平台接受证明。`PY` 指目标解释器，`ROOT` 指最终提交目录，路径先由操作者解析，不能照搬旧机器 profile。

完整Agent包内提供安装所需脚本及实际WASI测试。下文评测、R4和诊断脚本在配套审查源码包／仓库中，不将评测资料混入正式Agent包。

## 构建和安装 WASI 完整包

`scripts/build_full_submission.py --help` 接受源码根、经明确 SHA256 批准的原资产归档、目标 ZIP，可附 `--dependency-lock` 与 `--wheelhouse`。它导出必要生产文件、Skill、guest CPython／数学库、Wasmtime 原 wheel 和真实验收源，不复制旧 host venv、旧编译模块或 accepted profile。

当前归档来源是之前已交付的 `astra-wasi-assets-local.zip`，SHA256 `799556807e4b92f48ef28d19cd2502c7659ef1bf521e321222609250c3345e00`。相对资产清单记录逐文件哈希；原始构建的上游精确来源／再分发条件仍须单独确认，不能声称已取得可重现 CPython WASM 构建链。SymPy／mpmath 和 Wasmtime wheel 保留其分发许可资料。

解开新包后，在最终目录使用安装过声明依赖的目标解释器；确保 `mathagent.__file__` 来自该目录。正式提交源码加载时可通过公开 loader 的正常模块路径加入 ROOT；本地命令可在 ROOT 执行 `PYTHONPATH="$ROOT" "$PY" scripts/...`。这里的 ROOT 是实际交付包，不是下载素材目录或另一个源码快照。

```bash
"$PY" scripts/prepare_target_runtime.py --root "$ROOT"
"$PY" scripts/run_wasi_acceptance.py \
  --profile "$ROOT/runtime-install/pending.json" --output "$ROOT/actual-acceptance"
"$PY" scripts/accept_wasi_profile.py \
  --profile "$ROOT/runtime-install/pending.json" \
  --junit "$ROOT/actual-acceptance/actual-wasi.xml" \
  --evidence "$ROOT/actual-acceptance/evidence.json" \
  --output "$ROOT/runtime-install/accepted.json"
"$PY" scripts/activate_wasi_profile.py \
  --root "$ROOT" --profile "$ROOT/runtime-install/accepted.json"
```

准备阶段仅从已核验本地 wheel 安装受信 Wasmtime，编译已核验 WASM；没有网络安装，也不执行模型代码。安装／验收目录要求不存在，避免覆盖旧证据。实际测试必须全部通过，不接受只给历史XML或手改 available。激活仅写包内相对描述符；生产发现后仍检查该安装物的绝对文件 pin 和环境身份。

移动、升级解释器／worker／资产后重新准备并实际验收；失败的旧目录保留证据，另建新安装目录，不通过删证据或改标记“恢复”。WASI生成代码只有 BOUNDED_OBSERVATION，R3 必需准入不因风险Review消融而取消。

`requirements-target-linux-x86_64-py310-085.txt` 是当前本机安装验证的19依赖哈希锁；配套wheel为环境派生快照，非上游原版或其他平台认证。目标OS／CPU／Python变化时重建适用锁和包。普通代码快照继续用 `export_platform_submission.py`，不含WASI能力。

## 公开非流式诊断与整套评测

`run_public_eval.py` 默认只读预检；`--execute` 才可能调用模型。真实执行仍要求明确 SDK／model／session／历史账本。8条未知未解决时仍被拒绝，没有为了新版本清账。

诊断明确加 `--run-purpose diagnostic`，仅1–3题、默认最多30调用，可下调 `--diagnostic-max-calls`；资源时间仍受原题／整套截止。整套使用 `--run-purpose full_suite`，须通过当前 WP5-A `--admission-evidence`，不是依靠一次fixture演示放行。

完整真实评测还须给 `--dependency-lock` 与 `--judge-contract`。独立Judge设施可在运行前用 `score_reference_judge.py --input FILE --references FILE --freeze-contract NEW_JSON` 检查完整ID／参考覆盖，输出不含答案的冻结契约；运行后加 `--outputs FILE --contract NEW_JSON` 核对题集、参考和原Judge未变。不得以诊断用途逃避整套条件或拼接诊断成绩。

`--evaluation-mode full_suite|strict_diagnostic` 是继续策略，与 run-purpose（证据用途）独立。正常full_suite允许一次截断经有界修复后继续；严重故障、不可用响应、明确停止策略或无额度会停止新派发。底层未知不退款、不TTL释放。

`--ablation` 支持 none/risk_review/skills/alternate_routes/dynamic_budget/python/fallback，最多一个机制，运行模式不切回旧流式。risk_review 只关闭可选 R1/R2，R0、必需 R3、修复R4和收尾R5保留。Python关闭时同时撤掉能力宣告和执行通道，登记工具保留。dynamic_budget只有共享协调实际启用时才有有效跨题含义。

`--diagnostics` 将当前Adapter收到的可见消息与回复、终态／usage及最终数学状态写入新run的0700目录、0600文件，不读取隐藏reasoning或client私有字段，不进入Git或代码包。`replay_public_diagnostics.py --diagnostics DIR --state FILE` 按完整消息匹配离线回放，不匹配时显式失败，绝不补发模型请求。trace仍只返回有界摘要。

独立判分用 `score_reference_judge.py`，先单独安装用户给定的原判分器；该脚本不调用Agent或模型，拒绝缺失、重复、空参考与外来输出。它保留全部题分母；支持范围仍是原ReferenceJudge的文本／数值口径。不同题集、Judge或请求配置不可比较。

## R4 和版本取舍

`build_r4_public_variant.py --baseline-manifest FILE --destination NEW_DIR` 从冻结原件生成独立副本，仅调整公开调用适配及取消参数降级重试。`run_public_eval.py --solver r4 --r4-variant NEW_DIR` 复用当前公开传输和资源治理，R4 自己处理 ACTION／候选及解题编排，不进入新Controller。观察器不以L3误判合法R4交付；语义解析状态没有被伪造成L3通过。

R4公开runner为每题启动独立进程组，原题起点先于worker启动；原截止后TERM／KILL及有界回收，输出有界，进程死亡不结算远端未知，超时后不采用无法证明在截止前形成的旧final。支持代码身份在父子进程间校验；观察器仍用同一个权威账本。

R4目标进程／原生工具生命周期另用 `--r4-lifecycle-evidence` 验收记录，不修改原副本的构建时false标记冒充通过。记录必须绑定variant_id、support_identity、实际环境、正式Limits和证据文件哈希。当前本机进程与localhost固定响应测试不自动成为PASS_TARGET。这份副本不声称精确复现21.34，不自动替换原基线。

## 停止与恢复

共享协调器 `stop_dispatch(reason)` 持久停止整场新准入；题内facade仅停止该题。stop不意味着远端取消。已派发未知保持占用，迟到正文不会覆盖已关闭题的最终答案；额外10秒只做终止／保存。

增强入口 `RunContext(resume=True, ...)` 必须沿用原身份、目录、boot、代码／配置和原起止。已完成题可直接读原final；活owner或未知请求阻止重复执行。数学快照包含图、候选、Challenge、Review、progress及原软预算，once存于同一共享数据库。R4只支持已完成结果，不支持重放半途编排。

## 发布门禁

`check_release.py --profile entry` 仅测试入口；`--profile admit --evidence FILE` 检查功能证据、实际必需资产、正式配置、目标进程边界及当前真实数学诊断；不要求先有整套结果。`--profile full` 才要求同一次整套的 A13、WP5-B 与交付绑定证据。

functional_complete、target_runtime_admitted、target_runtime_accepted、real_suite_evaluated、baseline_replacement_supported 独立记录。缺失证据时非零退出；人工改bool没有内容绑定证据仍不能放行。当前不能把入口检查或离线测试数量称为“完整可用”。
