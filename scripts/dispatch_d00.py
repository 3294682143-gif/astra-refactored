import os
import json
import urllib.request
import urllib.error

API_KEY = "ouu8ENI6fQkWvDgZ_UKPlJa7AvwneyJi0yikUsiQwVFvTDrFFZXcwrS5MOlDQwU-TvQzrAaarvo-jPYeptMl3w"
BASE_URL = "https://api.modelarts-maas.com/plan/v2/chat/completions"

SYSTEM_PROMPT = """你正在为 Zygos（天轭）/ astra-refactored 执行前端建设任务。
项目原址：https://github.com/3294682143-gif/astra-refactored
当前分支：前端设计
本次代码基线 baseCommit：eb36a5acadc5de53d1c436b63faefca193b7d3f4
你的角色身份：D (deepseek-v4.1-flash)
分工与权限：只读可行性复核；不安装依赖、不改既有求解代码、不自行重构数学内核。"""

USER_PROMPT = """【任务指派：D-00 冻结前只读可行性复核】

请严格按《落地执行方案》执行 D-00 任务。
任务要求：
1. 只读核对前端方案与当前仓库（eb36a5acadc5de53d1c436b63faefca193b7d3f4），不安装依赖，不修改文件。
2. 逐项检查：
   - user_agent.py 入口、AgentRuntime 预算准入（注意 max_method_loads 上限为 0..1，原稿写 2 会被拒绝）
   - RPC manifest (agent-host-v13.schema.json) 的方言属性，说明为何不能直接将整个 manifest 交给浏览器 Ajv 校验 SolveResult
   - packages/protocol 导出链中的 node:crypto 等 Node 依赖，说明浏览器安全隔离需求
   - SessionLog 与公开 trace 的结构差异（公共 trace 仅有 seq/kind/id/state/code，没有依赖、推导与时间戳）
   - 进程生命周期与取消机制（说明为何 session.stop 不能直接等同于用户取消，运行中取消需如何收尾）
   - 新建 apps/web-demo、packages/web-contract、python/astra_web 是否会被既有 tsc -b 或 python 打包规则误包含
3. 产出字段与交互可行性台账：
   - 按每个主要字段与交互分类：【可直接复用】、【可通过新增适配实现】、【需要修改既有文件（白名单建议）】、【当前不可实现（需明确标注能力缺失）】
4. 深度复核五大陷阱：
   - (1) max_method_loads=2 风险
   - (2) 直接 Ajv 校验整个 manifest 风险
   - (3) 任意结果完整回放（无详细存档时只能进入 L1 摘要回放）
   - (4) 从 trace id 猜测 DAG 边或义务覆盖（禁止无据推断）
   - (5) session.stop 等同取消（需要显式取消 token 与孤儿进程清理）
5. 输出：
   - 兼容性试验计划
   - 最小变更白名单（建议改动的既有文件及改动范围）
   - 阻塞清单
   - 对 G (gemini-3.8-flash-high) 信息架构与设计提案的具体修改建议

请给出严谨、翔实且直接可作为工程交付的 Markdown 报告。"""

req_data = {
    "model": "deepseek-v4.1-flash",
    "messages": [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_PROMPT}
    ],
    "max_tokens": 8192,
    "temperature": 0.2
}

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json; charset=utf-8"
}

print("Dispatching D-00 task to Huawei Cloud deepseek-v4.1-flash...")
req = urllib.request.Request(BASE_URL, data=json.dumps(req_data).encode("utf-8"), headers=headers)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        content = result["choices"][0]["message"]["content"]
        out_path = r"C:\Users\y\OneDrive\Desktop\挑战杯\复赛\astra-refactored\docs\web\00-d00-feasibility-review.md"
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"D-00 completed successfully! Saved to {out_path} ({len(content)} chars)")
except Exception as e:
    print(f"Error during D-00 dispatch: {e}")
