import os
import json
import urllib.request
import urllib.error

API_KEY = "ouu8ENI6fQkWvDgZ_UKPlJa7AvwneyJi0yikUsiQwVFvTDrFFZXcwrS5MOlDQwU-TvQzrAaarvo-jPYeptMl3w"
BASE_URL = "https://api.modelarts-maas.com/plan/v2/chat/completions"

SYSTEM_PROMPT = """你正在为 Zygos（天轭）/ astra-refactored 执行前端建设任务。
项目原址：https://github.com/3294682143-gif/astra-refactored
当前分支：前端设计
代码基线 baseCommit：eb36a5acadc5de53d1c436b63faefca193b7d3f4
角色：D (deepseek-v4.1-flash)
已完成：D-00 只读复核、F1 冻结签署、D-01 Web 契约与 Schema 导出测试通过。"""

USER_PROMPT = """【任务指派：D-02 工程骨架、设计系统与构建】

请严格按《落地执行方案》执行 D-02 任务，目标为 apps/web-demo：
1. 给出 apps/web-demo/package.json 配置：
   - 依赖项：React 19, react-dom 19, react-router (7 系列), lucide-react, clsx, tailwindcss, @astra/web-contract: "workspace:*"
   - 构建工具：Vite (SPA)
   - 独立 script: dev, build, preview, test
2. 给出 apps/web-demo/vite.config.ts 与 tsconfig.json（独立 DOM/Bundler 配置，不继承 Node-only 配置，不污染全局 tsc）
3. 给出基础设计系统实现与核心原子组件源码：
   - index.html、src/main.tsx、src/index.css (Tailwind v4 tokens: 按照已冻结的方向 B：书生先锋蓝 #1152B6 + 天轭深蓝 #0F265C)
   - 核心基础组件：
     * StatusBadge.tsx (区分 candidate / unsolved / error / stale)
     * ResultCard.tsx (呈现候选答案、未解说明，严禁出现已验证/正确文案)
     * DataSourceBadge.tsx (L1 摘要 / L2 历史 / L3 完整观察)
     * PanelEmptyState.tsx (优雅空态与缺失态提示)
     * ErrorBoundary.tsx (局部错误隔离保护)
4. 路由与全局外壳：
   - AppLayout.tsx (全局顶栏 Header + 侧栏导航 + 主视口)
   - 路由配置（/solve, /runs, /runs/:runId, /runs/:runId/replay, /batch, /assets, /settings）

请输出完整、无缺失的组件源码与工程文件！"""

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

print("Dispatching D-02 task to Huawei Cloud deepseek-v4.1-flash...")
req = urllib.request.Request(BASE_URL, data=json.dumps(req_data).encode("utf-8"), headers=headers)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        content = result["choices"][0]["message"]["content"]
        out_path = r"C:\Users\y\OneDrive\Desktop\挑战杯\复赛\astra-refactored\docs\web\10-d02-implementation-report.md"
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"D-02 completed successfully! Saved to {out_path} ({len(content)} chars)")
except Exception as e:
    print(f"Error during D-02 dispatch: {e}")
