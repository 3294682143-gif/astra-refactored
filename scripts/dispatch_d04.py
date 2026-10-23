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
已完成：D-00、F1 冻结、D-01、D-02、D-03（15 项测试全通）。"""

USER_PROMPT = """【任务指派：D-04 reducer、回放与序列一致性】

请编写 `apps/web-demo/src/domain/reduceRun.ts` 与 `apps/web-demo/src/domain/playback.ts`：
1. `reduceRun(state: RunViewState, ev: RunEventEnvelope): RunViewState` 纯函数。
2. 红线约束：无论收到什么事件（包括 RESULT / FINAL），`state.candidateVerified` 必须恒为 `false`，绝不展示“已验证/证明完成”。
3. 幂等与冲突处理：
   - 同 seq 同 payload 自动去重。
   - 同 seq 不同 payload 记录 conflict 错误。
   - 乱序与缺序：具备自动按 seq 排序或填补机制。
   - 未知事件类型：安全记录在 `unknownEvents` 并标记能力不足。
4. 回放控制器 `PlaybackController`：
   - 支持：play, pause, stepForward, stepBackward, jumpTo(seq), setSpeed(0.5 | 1 | 2 | 5)。
   - 历史游标不因新事件到达而强制跳到最新。
   - 分段快照缓存：每隔 20 条保留快照，使得任意跳转无需从 0 开始重新计算。

请给出精炼、直接可用的 TypeScript 完整代码！"""

req_data = {
    "model": "deepseek-v4.1-flash",
    "messages": [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_PROMPT}
    ],
    "max_tokens": 4096,
    "temperature": 0.2
}

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json; charset=utf-8"
}

print("Dispatching targeted D-04 task (timeout=300, max_tokens=4096)...", flush=True)
req = urllib.request.Request(BASE_URL, data=json.dumps(req_data).encode("utf-8"), headers=headers)

try:
    with urllib.request.urlopen(req, timeout=300) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        content = result["choices"][0]["message"]["content"]
        out_path = r"C:\Users\y\OneDrive\Desktop\挑战杯\复赛\astra-refactored\docs\web\12-d04-implementation-report.md"
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"D-04 completed successfully! Saved to {out_path} ({len(content)} chars)", flush=True)
except Exception as e:
    print(f"Error during D-04 dispatch: {e}", flush=True)
