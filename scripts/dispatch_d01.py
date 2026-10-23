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
分工与权限：负责模块工程化实现（D-01）、测试与交付。F1 冻结已签署通过。"""

USER_PROMPT = """【任务指派：D-01 Web 契约与语义层实现】

F1 结构与契约冻结已通过（详见 docs/web/08-f1-freeze-signoff.md）。
请执行 D-01 任务：
1. 在 python/astra_web/contracts/ 中设计完整的 strict Pydantic v2 Web DTO 模型代码：
   - SolveResultDto（适配公开 solve() 返回对象）
   - TraceRowDto
   - MetricsDto
   - RunEventEnvelope
   - RunRequestDto（注意 max_method_loads 必须为 0 | 1）
   - CapabilitiesDto
   - ErrorDto
   - 包含 status、stopReason 权威映射字典与归类逻辑
2. 在 packages/web-contract/ 中设计对应的 TypeScript 类型定义（纯类型、无 node 依赖，安全导出）：
   - 类型契约
   - 运行时常量与字典（stopReason 中文映射与分类）
3. 提供生成 JSON Schema 的 Python 导出脚本代码
4. 提供反例测试用例与边界断言（包括 candidate+REVISE_REJECTED、unsolved+REVIEWS_COMPLETE、非法类型等）

请直接给出完整、严格类型、可落地的生产级代码和交付报告！"""

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

print("Dispatching D-01 task to Huawei Cloud deepseek-v4.1-flash...")
req = urllib.request.Request(BASE_URL, data=json.dumps(req_data).encode("utf-8"), headers=headers)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        content = result["choices"][0]["message"]["content"]
        out_path = r"C:\Users\y\OneDrive\Desktop\挑战杯\复赛\astra-refactored\docs\web\09-d01-implementation-report.md"
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"D-01 completed successfully! Saved to {out_path} ({len(content)} chars)")
except Exception as e:
    print(f"Error during D-01 dispatch: {e}")
