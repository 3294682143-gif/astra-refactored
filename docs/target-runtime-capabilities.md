# 0.8.5 运行能力与责任边界

实施基线：`872ab0a70e48b13054fc61cf3b9e97a2251c30f5`。本机为 Linux x86_64、CPython 3.10.6；不是官方 ARM64 或其他 OS 的替代验收。

| 能力／来源 | 当前事实 | 范围与剩余条件 |
|---|---|---|
| 官方公开源码 | InternLM/Challenge-Cup-2026 `43be244a`；SDK SHA256 `1da165e26a13651f4a812be11a836edd040912fc8ba0691e6746fb5a3277f737` | 已查源码支持非流式完整消息；明确命名 thinking_mode 才请求 False。实际模型／隐藏 runner 未验收 |
| 官方进程／存储 | 已冻结公开说明：每题独立进程、最多三题，不依赖跨题文件；平台资源权威 | 不能把同机 SQLite 自动带入正式平台；增强模式须部署方另给稳定同轮身份、共享许可与公开责任契约 |
| 默认 platform | 只接 client 与 idx，题内内存保护、不持久恢复 | 保持最小入口，不能称完整跨题模式 |
| shared_public | 可信 RunContext → SharedPublicCoordinator → 原 GlobalCoordinator；仍使用公开非流式 PlatformAdapter | 已实现同机同启动周期共享、原期限、预算、once、checkpoint、已完成结果读取；目标许可未知 |
| 原 local | 旧 S2 流式／prefill 的显式能力路径保留 | 不与新公开非流式配置混作同条件结果 |
| WASI | 旧实际验收源已恢复，完整资产包、目标编译／安装、内容绑定验收与默认描述符激活已实现 | 仅最终位置实际通过后开启；无资产代码快照保持禁用。客体无 NumPy/SciPy |
| 隐藏元数据 | 公开字符串返回不补造 finish_reason 或 usage | 显式终态与可信官方公开返回责任是不同记录；超时不证明远端结束 |
| 历史请求 | 只读复核 13 个历史账本，合计 8 条未知 | 原时间、版本、请求记录不改；没有新结束凭据时无新真实请求容量 |
| 题集／Judge | 历史 indexed 文件哈希未变；questions.txt 与 input/questions.txt 为不同内容 | 未自动选择新版题集、未重新划分或重命名已使用题为未见 holdout；实际整套前须明确冻结 |
| R4 | 原件不改，新 `r4-public-nonstream-*` 副本独立使用原编排／ACTION | 当前公开配置的对照设施不是21.34精确复现；目标原生工具生命周期仍需验收 |

## RunContext 接入

`from mathagent.runtime.run_context import RunContext`。由可信 runner 在构造阶段注入 `ReasoningAgent(client, run_context=context)`，不能把模型文本或普通 metadata 中的字典直接转成这个对象。

必填为 run_id、shared_dir、evidence、boot_id、started、wall_started、source_version、config_version。started 是同一主机当前启动周期内原始 monotonic 开始，wall_started 是对应原始墙钟；截止按原值加21600秒，不按恢复时刻重置。source_version 应来自该安装物的 `code_version()`；known_total 仅接受冻结公开题量，未知时保持 None。可选 resume 显式恢复死去的本机 owner；有未知／在途请求时拒绝重发。

默认 `public_return_authority="explicit_terminal_only"`。只有部署方确实以官方公开调用返回作为其生命周期责任边界时，才能选择 `official_public_return`。后者不伪造 stop、usage 或取消回执。不得用更换 RunContext、run_id 或 SQLite 文件逃避历史未知占用；真实开发 runner 仍先通过 PriorUsage 及固定 session 清单。

多个主机上的各自本地 SQLite 不是共享服务。跨主机服务和跨启动周期恢复未实现，明确拒绝而不猜测。平台提供正式公开协调服务时，需单独实现并验收 PublicCoordinator 端口，当前没有声称该服务已存在。

## 本机材料身份

底层 S2／Skill 包及六仓的 `scripts/check_sources.py --verify docs/source_manifest.json` 返回 PASS。没有重导入实验 runner 或覆盖来源工作树。

本次修复方案 SHA256：`716b5ff3c3c83d03569f23a9181cc96455caf706999d9100aa27f925cef5ca5d`。

题集内容哈希分别为：历史 indexed `1480499bf9bc6f7a89a20610551380e378830c0b63a81f2109f7f484015d2b77`；questions.txt `2f4202a5f512ab65d1afa3d94d74bcfbe241e0cd59293f152d0ac97a371c0cef`；input/questions.txt `02960c5e9bcf56ef2f8654a59adbead869ed5b376ddc9c70b04ffb1ae7a3f634`。这些只是只读盘点，不是新运行的默认输入选择。

未修改的用户 ReferenceJudge 主文件 SHA256：`26b95eb0dc8aef97ecb459c1eab9b309af4c4b41c1bbdfbf49a4f09155308a5b`。它是保守文本／数值匹配器，不是官方隐藏判分或通用证明等价器。
