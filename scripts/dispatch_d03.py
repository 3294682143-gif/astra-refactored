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
已完成：D-00、F1、D-01（Web 契约测试全通）、D-02（Vite 构建一次性通过）。"""

USER_PROMPT = """【任务指派：D-03 只读 BFF、导入与存档实现】

请严格按《落地执行方案》执行 D-03 任务：
目标路径：python/astra_web/
1. app.py：FastAPI 应用入口，挂载 /api/health、/api/capabilities、/api/runs、/api/replays、/api/assets 路由，同时将 apps/web-demo/dist 静态资源挂载到根路径
2. storage.py / archive.py：
   - 基于 SQLite 索引管理运行记录元数据
   - 区分普通结果（L1 摘要）与详细存档（L2/L3）
   - 原子文件写入，路径防穿越（安全规范）
3. replays.py：导入外部 SolveResult JSON 或 JSONL 历史日志，校验并入库
4. 提供 pytest 测试用例（tests/test_web_bff.py）：测试健康检查（不调模型）、导入校验与合法拦截

请给出完整、直接可运行的代码！"""

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

print("Dispatching D-03 task to Huawei Cloud deepseek-v4.1-flash...")
req = urllib.request.Request(BASE_URL, data=json.dumps(req_data).encode("utf-8"), headers=headers)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        content = result["choices"][0]["message"]["content"]
        out_path = r"C:\Users\y\OneDrive\Desktop\挑战杯\复赛\astra-refactored\docs\web\11-d03-implementation-report.md"
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"D-03 completed successfully! Saved to {out_path} ({len(content)} chars)")
except Exception as e:
    print(f"Error during D-03 dispatch: {e}")
