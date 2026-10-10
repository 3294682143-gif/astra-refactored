# 来源与迁移说明

规范来源为本目录父级的已解包目录；两个同名tar包此前逐内容哈希核对一致，不重复作为独立底座。
机器可核对快照见 `source_manifest.json`。本轮未修改任何来源文件。

| 来源 | 实际采用 | 目标与改造 |
|---|---|---|
| S2 preset_engine/workunit_v12.py | 三行字段、STATUS prefill、WorkUnit与背景分离 | runtime/protocol.py 重新实现窄接口，移除oracle输入及禁止候选的实验专用全局规则 |
| S2 artifact_parser / Enumerator / completion-obligation 系列 | 唯一绑定、目标检查、完成义务和晋升分层 | verification.py、check_templates.py的窄范围精确检查；六类语义重新实现，不声称覆盖历史全部语法 |
| S2 persistent_rate_window_v115.py | 持久计数与事务思路 | runtime/coordinator.py；重写公平调度，不保留1800秒80次及串行阶段约束 |
| challeng_repo/math-families-variant-a | 22族方法资源、64工具注册表、数学源函数与21份性质测试 | math_families/、resources/；只读复制后修改目标副本的evidence_bridge，去除self_check字符串晋升 |
| STAR-PolyaMath | 评审、回退、局部结果保存设计 | review.py / controller.py；不复制原模型ACCEPT赋真值及终审失败接受的行为 |
| Math-Agents | 不可变版本、依赖与证据范围、资源记账设计 | domain.py / store.py / coordinator.py；不引入Java、Temporal或数据库服务体系 |
| MACM | 条件与目标推进 | planning.py；新条件均为暂定，不移植投票和Assistants调用 |
| Math.Skill | 定义域、边界、漏解等检查方法 | Review任务模板；不声称提示词等于验证器 |
| DeepMath | 工具观察与执行边界设计 | tools.py；登记函数进程控制不是生成式Python沙箱 |
| Medalist | 数学错误/证明缺口分类与修复设计 | 精确版本绑定；不复制未回写新版的修订循环 |

六仓Git提交与详细方案给定提交一致；challeng_repo存在用户原有未提交修改，故同时冻结工作树内容哈希。
旧R4目录仅作来源和独立对照，未导入新核心。21.34分对应的确切提交/配置尚未交付，不将现有快照冒充该成绩版本。

## 许可证与发布

直接带入的是用户提供的数学函数与资源。该包未提供足以确认再分发许可的独立许可证声明，正式外部分发前需要权利确认；本轮仅在用户工作区本地开发。
六个公开参考仓库本轮主要借鉴设计，未整段复制它们的运行代码。后续新增直接代码移植须按对应许可证补齐声明。
性质测试复制自同一用户工具包，测试输入有工具标签，属于函数回归，不当作自主路由/整套正确率证据。

0.2.0补读S2_EXP/controller_owned_core.py、oracle_free_enumerator_r5.py及protocol_v1_7/hybrid_core.py，选取等价、代入、不变性、定义域、去重与边界基数的检查语义。目标实现重新绑定本项目WorkUnit，不导入来源中的gold相关字段、评分器或顶层枚举器替换。
新增tool_contracts.py是本项目独立复算层；原生产数学函数未改写。首批8项的输入约定及独立复算边界见tool_integration_matrix.md。

0.3.0补读目标副本algorithm_simulation.py、graph_extremal.py、transfer_matrix.py及bridge/dispatch.py，核对实际字典扩展、类型强转、图见证和计数约定。第二批8项复算加入本项目tool_contracts.py；在线检查器不调用生产函数或读取其self_check。测试中允许将生产输出与独立复算交叉核对，但不把这些测试用工具标签当成自主路由证据。

0.5.0新增48项独立输出契约，位于mathagent/output_checks/，未导入生产math_families或其表达式解析器进行自证。只修改本项目内的目标副本：classical_geometry_compute.py排除端点角度跳变伪根；constrained_tiling.py补齐证书2x2约束与空放置拒绝；probabilistic_model.py让首次到达目标停止可达性展开；numerical_methods.py拒绝重复/未知证书字段及超界阶数。原8个来源、六个借鉴仓库和原方案文件快照复核PASS，未修改来源仓库。

0.4系列：task_graph.py沿用账本/依赖设计但由本项目实现，不引入Java服务或历史实验runner；输入契约、条件补查与恢复代码均在目标目录新增。判分器本体保持原样，通过外部worker入口使用。
user_client.py选择性重写S2_CORE/preset_engine/chat_client.py的单次请求、thinking_mode、SSE与终态处理约定，移除独立reasoning读取/保存，不复制实验评分、旧重试或私有client绕行。显式factory仅在用户授权的runner/probe调用时读取所供配置，Agent仍仅使用注入client。
新增requests依赖已声明；离线干净验证中的17个依赖wheel为本机安装快照派生，保留许可证文件并排除安装专用元数据，不冒称上游原版或完成再分发许可确认。
