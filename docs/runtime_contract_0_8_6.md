# 0.8.6 条件绑定与回放／判分协议

本轮复用已有公开传输、共享协调、Controller和WASI。下面是已实现的协议；不是目标接受或真实成绩声明。

## F1：当前运行准入

公开runner产生`public-sdk-evaluation-v3` manifest。`run_contract`为`mathagent-run-contract-v1`，包含运行核心版本、模型ID、SDK与runner哈希、全部公开请求参数、传输／终态责任、协调模式、当前环境、依赖、物理资源、实际功能开关及数学策略；`run_contract_fingerprint`绑定其完整内容。顶层别名也核对，不能只修改外层model_id绕开指纹。

目前该契约明确支持已实现的同机SQLite＋公开非流式、无prefill、命名thinking_mode=False、单次已观察HTTP尝试。不能用另一个配置名假装已实现公开跨主机服务。default platform最小入口未改变，G1正式责任仍独立记录。

依赖只有版本信息的诊断会标为`versions_only`，不冒充锁定安装。完整真实运行和完整运行的比较要求`locked`身份；物理Python资产身份与Python是否启用分开，所以合法Python消融不会改变固定资产。

准入文件升级为`architecture-acceptance-v2`。环境相关A02/A03/A06/A11分别绑定`environment_contract_fingerprint`；A12绑定实际`run_contract_fingerprint`。`check_release.py --profile admit --evidence FILE --manifest PLANNED_MANIFEST`及公开runner同时检查当前条件。模型或请求变化不会自动改写证据，需新A12；SDK、runner、代码、依赖或资产等变化还使对应环境证据不匹配。旧v1记录不能按缺失字段相等放行。

受控单项消融可以在`allowed_ablations`中明确记录原／目标指纹、唯一机制及已通过的受控案例附件。程序校验只从启用变禁用一个机制、物理资源和其余条件不变，再允许继承已绑定的基础模型诊断；不自动生成此许可，不据此宣称消融效果已验证。换模型不能伪装为消融。

拒绝发生在新run目录、协调账本和模型client创建之前。历史许可清单仅按原规则只读检查；已有8条未知不会通过新契约释放。

## F2：停止与读取分离

共享入口先在同一事务查已存在题目，校验run、item_key、problem_hash并返回已提交final。全局停止不阻碍此只读路径；新题、未完成题、同idx改题仍拒绝。普通与resume读取不改变calls、once、起止、快照或其它未知许可。

## F3：可核验离线回放

`LocalDiagnostics`新增独立`math-replay-descriptor-v1`描述及逐次记录。它保存原运行／实验／数学策略、实际item与时序、软预算决策、Controller的数学时钟读取、Python／Skill身份、初始恢复快照、公开适配参数，以及原manifest引用。描述、调用清单、完整绑定工具记录、末态快照关联到同一recording_id。该ID只是诊断记录标识，不推导run身份或分配任何真实额度。

回放必须明确选择：

```bash
python scripts/replay_public_diagnostics.py --diagnostics DIR --state STATE --mode full
python scripts/replay_public_diagnostics.py --diagnostics DIR --state STATE --mode resume
python scripts/replay_public_diagnostics.py --diagnostics DIR --state STATE --mode segment --request-id SAVED_ID
```

full从原始空状态重建；resume只回放有已记录初始快照的恢复后缀，原先的规划、父产物和已花机会不重放；segment只验证所选交付，不检查整题候选且不等于全流程成功。

当前支持原代码／资源一致、单条活跃路线的shared_public完整或恢复回放，可顺序切换备用路线。两条同时活跃路线的调度时序、旧local／R4／default-platform执行契约或缺少描述的旧日志，明确返回`UNSUPPORTED_REPLAY_CONFIG`。不从旧末态推测缺失的原时钟／预算，不默认关掉Python/Skill。原数据仍可做明确范围的人工数学复盘；不称为一致全流程回放。

匹配包含完整消息、参数、once、截止、任务类型、item及调用清单。记录的拒绝准入与已派发生成分别计数。还核对全部应消费时钟、软预算决策、工具、数学状态、Review／进展事件和最终选中候选。失配、遗漏、多余调用、候选差异、不支持配置都退出2。

Python只回放与完整代码、提案、WorkUnit义务／范围／依赖匹配的旧BOUNDED_OBSERVATION/NONE，拒绝用日志提供verification或certificate；不启动guest，不授予新的数学真值。登记工具用当前同版本检查器在新的有界**本地**工具时限内重新执行，再与原记录对照；不从日志复制精确证明权威，也不重置原模型预算。缺记录或结果不同不能报一致。

`offline_replay=true`仅表示没有模型联网；`replay_consistent`另行给出。原截断或失败也能以`original_failure_reproduced=true`被正确复现，无须所有原运行都答对。可见材料只写授权本地诊断目录，正式trace仍有界；没有隐藏reasoning记录。

## F4：报告必须属于该运行及该输出文件

预先冻结Judge契约升级为`independent-judge-contract-v2`，包含完整题号与总数。原ReferenceJudge源码不修改，仍是保守文本／数值匹配，不是证明等价器或官方隐藏Judge。

```bash
python scripts/score_reference_judge.py --input INPUT --references REFS --freeze-contract JUDGE_CONTRACT
python scripts/score_reference_judge.py --input INPUT --references REFS --outputs OUTPUTS --manifest RUN_MANIFEST --contract JUDGE_CONTRACT
```

输出文件每行由runner加入run_id和manifest指纹。新报告`bound-score-report-v2`绑定run_id、manifest指纹、原输出字节SHA256、题集／参考／Judge哈希、完整题号及分母。输出只读取一次后判分和绑定，防止两次读取拿到不同内容。缺失输出仍错误并留在分母；重复／外来ID、不一致计数、空参考或错配不得形成可比报告。

```bash
python scripts/compare_eval_runs.py --comparison-mode repeat \
  --baseline-manifest BASE_M --current-manifest CURRENT_M \
  --baseline-report BASE_R --current-report CURRENT_R \
  --baseline-outputs BASE_OUT --current-outputs CURRENT_OUT
```

比较模式严格区别：repeat要求相同版本/所有条件；ablation只允许完整控制→关闭一个实际启用机制；r4允许原R4与完整新核心的求解器／协议／数学编排不同，公共运行核心、SDK、runner、传输、模型、固定资源、环境、依赖、Judge和正式限制保持。模式之外的变化或缺字段均拒绝。

旧exact-text或ReferenceJudge报告只能历史展示。`summarize_eval.py --historical-display`明确不认证运行、不比较优劣；新比较CLI和公开`compare_reports` API必须提供对应manifest与实际outputs。绑定和条件可比仍不自动证明真实模型执行或正式验收，比较结果的`model_accuracy_established`保持独立。
