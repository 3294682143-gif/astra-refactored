# 交接：把 `astra-refactored`（TS）做到"解题正确率"导向的深度重构

> 本文件写给**新上下文的执行者**。只记录本会话已核实的事实与下一步动作。
> 不要相信任何"已完成/已提分"的叙述，除非重新跑出证据。
> **状态（2026-10-24 最新）：** v5 Stage 1–5 已落地（§18）：精确观测闭环、有限群子群普查、
>   WASI explore 提示、路由扩展与全量门禁；Node **535/535**、Python **1122 passed / 24 skipped**。
>   真实 API 12 题：**10/12 candidate**，#4 已从只选 `D` 修成 `B,D`；#35 仍未修好
>   （late `MAXIMAL_MINORS` observation 未进入闭合），详见 §18.6–§18.7。
>
> **状态（2026-10-22 校正，先读这五条；以下数字是当时历史值）：**
> 1. 现行主口径见 §12：两臂全量 + 逐题人审 + 三次稳定率，重试臂 81 正确 / 14 错误 / 4 争议 / 1 未解，**三次全对率仅 59%**。
> 2. 86 / 91 / 96 / 97 **永久不得作为成绩引用**（合并 + 人工翻案 + 定向重跑）。
> 3. 稳定性主因已定位：投票按原文比、语义路由只覆盖 6 类、强制轮不是门禁、方法卡与工具共享 effect 预算、只有 `exact_check_expr` 结果进闭合（§12.3）。
> 4. **最新门禁以 §12.6.1 为准**：Node 370/370、Python 869 passed/24 skipped；
>    顶部旧状态块里的 341/722 与 §1.2 历史值均已过期。
> 5. 路由/门禁/闭合已按 §12.5 落地并跑过 9 题 pilot（§12.7），但 `observation_used` 仍为 0，
>    闭合是否真的改变候选**尚未验证**（§12.6.2）。

> **以下为 2026-10-21 的旧状态，保留供追溯：**
> 稳定性已收口，`FIELD_VALUE` 类丢题已清零。同一份 100 题输入（A 组
> `input.test0.jsonl`、同 runner 配置、no-retry 客户端、本地 ReferenceJudge）
> 的新全量实跑 `/tmp/astra-full100-c9` 为：
> **97/100 出候选、0 个因 Node/Host 语义分歧丢题、1546 次模型调用、本地严格
> 判分 23/100**。唯一 3 个未出候选（`#11`/`#15`/`#48`）全部是**传输层**故障
> （缺 `finish_reason` 的完整信封、或 HTTP 失败），在开启传输重试后 3 题全部
> 恢复为候选，即**有效口径 100/100 候选、0 `FIELD_VALUE`**。相关证据：
> `/tmp/astra-full100-c9`（全量）、`/tmp/astra-lost3`、`/tmp/astra-lost2r`
> （3 题传输重试恢复）、`/tmp/astra-fail12-c8`（12 个旧失败题 11/12 候选）。
> 上一轮 A 组全量（frozen commit `36e056f`）为 68 正确 / 12 错误 / 12 未解 /
> 8 争议、strict 18/100、1459 请求、12 个未解全部 `FIELD_VALUE`；它现在是
> **修复前基线**，不能再当作当前能力。96/97/91/86 仍是“定向修复重跑”或
> “合并快照+人工复核”口径，不是盲跑成绩。
> 本地门禁全绿：`tsc -b` 0、Node **341/341**、Python **722 passed /
> 24 skipped / 0 failed**、manifest `VERIFY_OK`。代码与文档已提交并推送到
> `origin/feat/v4-dynamic-workflows`（`b359733`、`6447829`、`59e8aca`）。
> §10.3 本轮新增的答案闭合代码、测试与文档仍**未提交、未推送**。
> 逐项复核已完成（§10.3）：**77 正确 / 20 错误 / 3 未解**；3 个未解题补跑后
> **79 正确 / 21 错误 / 0 未解**。严格判分器 23/100 只是格式匹配，不是准确率。
> 独立批次 B（§11.1，`/tmp/astra-item-audit-20261022`）为 **73 正确 / 19 错误 /
> 5 争议 / 3 未解**；A/B 两批并列保留，不互相覆盖。
> 2026-10-22 §10.3 两臂复跑：传输重试主臂 **99/100 候选、strict 27/100**
> （1551 calls / 10.426M tokens）；no-retry 对照 **88/100 候选、strict 22/100**
> （1501 calls / 10.015M tokens）。主臂唯一未解 #15 是模型非法 JSON 转义，
> 不是传输；单题复跑可出候选（但另一次复跑答案错误）。正确率仍是下一步唯一目标。

---

## 0. 唯一目标与口径

- 只以**整套题目的正确率**判断优劣：`正确数 / 全部题数`，**未求解、超时、异常都计入分母**。
- `ReferenceJudge`（本地 emulator）是**严格字符串/数值匹配**，不是数学准确率：它把 `(A)` vs `A`、`A、B` vs `AB`、`\sin` vs `sin` 判错。引用时必须标注。
- 已知实测（同一 test0 100 题、intern-s2、max profile）：
  - `/tmp/astra-test0-full-final-20261019`（100 题 max2）：93/100 有候选，841 次请求，4.739M tokens，平均 8.41 次/题，严格匹配 17/100，本地语义判分估计 68/100，统一归一化后 22/93；effect 96、method load 95、review 93。
  - `/tmp/astra-test0-merged-max8-20261020`（100 题 max8 分批合并）：**100/100 候选**，1518 请求，9.110M tokens，平均 **15.18 次/题**，严格 **20/100**，本地语义 **80/100**，格式归一化 **24/100**，effect 96、method load 96、review 100。注意这是合并快照：未做错题修复重跑时严格 19/100、逐题 86/13/1；修复 #7/#13/#17/#52/#70 后才是严格 20、逐题 91/8/1。
  - `/tmp/semantic_judge_098.jsonl`：0.9.8 的 100 个输出用**同一语义判分器**为 **70/100**；人工复核为 75/100。
  - `/tmp/astra-item-review-20261020.md`：合并 max8 的逐题复核，**91 完全正确 / 8 错误 / 1 有争议**；争议题为 idx 43（候选给出对称+反自反，参考只列对称）。其中 5 题来自错题定向修复重跑，不是单轮盲跑。
  - **2026-10-20 late 通用工具/证书定向重跑**：`exact_check_expr`（三角化简/极大子式/扩域因式分解/定积分/极限/密度归一化）与 `bounded_enumeration`（显式有限对象/笛卡尔积穷举）已接入 Host/TS；最终轮产生 `CERT1|CHECK/OPTIONS/VERDICT/FINAL` 证书，证书候选优先于相关审计多数票。定向重跑 #10/#12/#24/#35/#99 均修对（#12：223/8330，18 calls；#35：degree-6 Alexander，18 calls；#99：`假`，18 calls；#10：2/π，15 calls；#24：参考式，15 calls）。#2 仍为 Q(5^{1/4},i)/8（漏根，且参考 Q(5^{1/4},ζ8)/16 也不是最小分裂域）；#19 仍错（DENSITY_CHECK 报积分 0.295，未归一化）；#37 仍为 A,C（漏 D）。按定向口径为 **96 正确/3 错/1 争议，严格 22/100**；若把 #44 的额外真性质按“性质集合完整”接受，则为 97/3/0，但保守仍记争议。这是 targeted repair 口径，不是盲跑。
  - `/tmp/astra-test0-pilot20-audit8-20261019`（20 题 max8 审计 pilot）：20/20 候选，281 请求，1.742M tokens，平均 **14.05 次/题**（min 6/max 17），严格 2/20、归一化 5/20、本地语义判分 13–14/20（max2 同 20 题为 15/20，单独看 20 题没有证明正确率提升）。
  - `/tmp/astra-test0-full-method-20261019`（上一轮 method+consensus）：89/100 有候选，812 次请求，4.581M tokens，平均 8.12 次/题，严格匹配 18/100，统一归一化后 23/89；两轮 strict 正确并集 22，差异属模型随机波动。
  - `/tmp/astra-test0-full2`（旧基线）：93/100 有候选，399 次模型请求，1.81M tokens，严格匹配 14/100，统一归一化后 18/93。
  - 老基线 Python `0.9.8`（c3fcd62）**平台 76/100**，5303 请求 / 166 分钟；那是**平台评分**，与本地严格匹配**不可直接比较**。
- 参考架构与方案（必读，按顺序）：
  1. `/home/ma-user/work/Astra /最终架构.md`（689 行，设计规格，非完成声明）
  2. `/home/ma-user/work/Astra /Astra_MathAgent_TS_RC2_DSH_Pi_融合执行方案_v4.0_最终.md`
  3. `/home/ma-user/work/Astra /版本与评测记录总览.md`（历史版本与评测证据，含 c3fcd62 / 2e5f35b 的确证成绩）
  4. `/home/ma-user/work/Astra /TS架构重写总体设计方案.md`、`Intern-S2-397B最终核心求解架构与六仓源码映射.md`

---

## 1. 完整复跑配置（HEAD `eb36a5a` + 未提交的稳定性改动，2026-10-21）

这一节是交给另一个 agent 的**可复跑配置**。按这里的版本、命令、输入和 profile
重跑；不要根据旧会话里的 `0a88eca`、329/683 测试数或旧 profile 重跑。

### 1.1 代码版本与工作区

- 仓库：`/home/ma-user/work/Astra /astra-refactored`（路径含空格，命令必须加引号）
- 分支：`feat/v4-dynamic-workflows`
- HEAD：`36e056f2081661cba85f3417bd28c1972ab68af1`
- 已推送：`origin/main` 和 `origin/feat/v4-dynamic-workflows` 都是 `36e056f`
- 远端：`https://github.com/3294682143-gif/astra-refactored.git`
- Node `v24.7.0`，Python `3.10.6`；没有 `npx`
- 工作区应只剩未跟踪的临时文件：`.ipynb_checkpoints/`、`G5.txt`、
  `PY_STATUS.txt`、`STATUS_TMP.txt`；这些不是复跑输入，不要提交。

### 1.2 构建与门禁（必须全部通过）

```bash
cd '/home/ma-user/work/Astra /astra-refactored'
node node_modules/typescript/bin/tsc -b
node node_modules/esbuild/bin/esbuild apps/stdio-runtime/dist/src/main.js \
  --bundle --platform=node --format=esm \
  --outfile=release/stdio-runtime.bundle.mjs --log-level=warning
python3 scripts/build_release_manifest.py
python3 scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
python3 -m pytest -q
git diff --check
```

预期（**2026-10-22 最新实测**，源码改动之后重跑）：

- `tsc -b`：0
- Node（protocol + stdio-runtime）：**370/370 pass**
- Python 全量：**869 passed, 24 skipped, 0 failed**
- manifest：`VERIFY_OK`（记录 source commit `eb36a5a`；HEAD 为 `59e8aca` + 未提交改动，
  祖先规则允许）
- `git diff --check`：clean
- 仓库内无真实 API key

> 历史值供对照：`59e8aca` 提交时是 Node 334/334、Python 718 passed；
> `answer-closure` 批次加入后升到 370/869。数字变大是**新增测试**，不是回归。

### 1.3 真实 API 与客户端（密钥不落盘）

- 端点：`https://chat.intern-ai.org.cn/api/v1/chat/completions`
- 模型：`intern-s2`
- 请求参数：`temperature=0.2, top_p=0.9, max_tokens=8192,
  thinking_mode=false, stream=false`
- 密钥只从进程环境读取：`INTERN_API_KEY`、`INTERN_ENDPOINT`。
  **不要把 key 写进仓库、日志、提交或 HANDOFF。**
- 客户端文件（在 `/tmp`，不属于 repo）：
  - `/tmp/intern_s2_client.py`
  - `/tmp/real_client_factory_retry.py`：带进程间 4s 限速和 10 次 HTTP 重试（**推荐实测臂**）
  - `/tmp/astra-rerun-ab-10000-20261021-TrfJBe/no_retry_factory.py`：no-retry 对照臂
    （A 组旧全量用的就是它）；本轮已加「响应缺 `finish_reason` 就在客户端层重发同一
    provider 请求，最多 2 次」的 quirk 修复，Host 仍只看到一次派发
  - `/tmp/real_client_factory_log.py`：调试用，把每次请求/响应追加到 `/tmp/reallog.jsonl`
- `real_client_factory_retry.py` 的 `MAX_PROFILE` 必须逐项等于：

```json
{
  "engine": "ts",
  "max_model_calls": 256,
  "max_work_units": 64,
  "max_effects": 2,
  "max_reviews": 2,
  "max_method_loads": 1,
  "max_repairs": 2,
  "max_consensus": 8,
  "max_r0": 1,
  "problem_seconds": 1800,
  "policy": "BEST_EFFORT",
  "derive_budget": false,
  "mode": "local"
}
```

注意：`run_judge.py` 的 `--max-model-calls` 是 emulator 的整场 usage 上限；
真正的 `ReasoningAgent` profile 由 factory 的 `MAX_PROFILE` 注入。两者要同时保留，
不能用旧 `max_reviews=1/max_repairs=1` 的 `real_client_factory.py` 替代。

**2026-10-21 全量用的实际命令（可直接复制）**

```bash
cd /home/ma-user/work/official_judge_emulator
export INTERN_API_KEY=... INTERN_ENDPOINT=... \
       PYTHONPATH=/tmp:/tmp/astra-rerun-ab-10000-20261021-TrfJBe
setsid nohup python3 run_judge.py \
  --submission "/home/ma-user/work/Astra /astra-refactored" \
  --input /tmp/astra-rerun-ab-10000-20261021-TrfJBe/input.test0.jsonl \
  --report-dir /tmp/astra-full100-c9 --infer-total \
  --client-factory "no_retry_factory:build_client" \
  --item-concurrency 4 --item-timeout 1800 --item-kill-after 10 \
  --max-model-calls 10000 --api-concurrency 4 --default-max-tokens 8192 \
  --model-max-attempts 1 --model-retry-backoff 5 --judge-concurrency 4 \
  > /tmp/astra-full100-c9.log 2>&1 < /dev/null &
```

用 `real_client_factory_retry:build_client` 替换 factory 即得到带传输重试的对照臂。

### 1.4 输入文件、题号映射和哈希

全量输入：

- `/home/ma-user/work/input/test0.txt`
- sha256：`d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c`
- 100 行 JSONL；`--infer-total` 必须保留。

9 题定向集（原错题 + #44 争议题）：

- 文件：`/tmp/test0-remain9.txt`
- sha256：`2d392960a68a662cdab6a52ab56eab92282f908ef015d627aff3256de29a9de5`
- 0-based 原题号：`[1, 9, 11, 18, 23, 34, 36, 43, 98]`
- 对应题号：`#2, #10, #12, #19, #24, #35, #37, #44, #99`
- 映射文件：`/tmp/test0-remain9.map.jsonl`
  sha256 `81ceabcdb507a345025ca9e05644ef71244890ca6f0da73d8af30d458eda7918`
- 盲评文件：`/tmp/test0-remain9.blind.jsonl`
  sha256 `88848d87437d9596891f3ecfb9224807a9fd4ef1989ad89c82b091f2adf18ff9`
  （不含 answer，给盲评 agent 用）

抽取命令（如果 `/tmp` 被清理，先重建）：

```bash
python3 - <<'PY'
import json, hashlib
from pathlib import Path
src = Path('/home/ma-user/work/input/test0.txt')
lines = [ln for ln in src.read_text(encoding='utf-8').splitlines() if ln.strip()]
assert len(lines) == 100
picks = [1, 9, 11, 18, 23, 34, 36, 43, 98]
out = Path('/tmp/test0-remain9.txt')
blind = Path('/tmp/test0-remain9.blind.jsonl')
mp = Path('/tmp/test0-remain9.map.jsonl')
with out.open('w', encoding='utf-8') as fo, blind.open('w', encoding='utf-8') as fb, mp.open('w', encoding='utf-8') as fm:
    for new_idx, old_idx in enumerate(picks):
        item = json.loads(lines[old_idx])
        fo.write(json.dumps({'idx': new_idx, 'problem': item['problem'],
                             'answer': item['answer'], 'source_idx': old_idx},
                            ensure_ascii=False) + '\n')
        fb.write(json.dumps({'idx': new_idx, 'problem': item['problem'],
                             'source_idx': old_idx}, ensure_ascii=False) + '\n')
        fm.write(json.dumps({'report_idx': new_idx, 'source_idx': old_idx,
                             'item_no': old_idx + 1}, ensure_ascii=False) + '\n')
print('source_sha256', hashlib.sha256(src.read_bytes()).hexdigest())
PY
sha256sum /tmp/test0-remain9.txt /tmp/test0-remain9.blind.jsonl /tmp/test0-remain9.map.jsonl
```

子集文件（本次证据用）：

| 文件 | 原题 0-based | sha256 |
| --- | --- | --- |
| `/tmp/test0-tools5.txt` | `[1,9,18,23,34]` = #2,#10,#19,#24,#35 | `235acc55bbdfb9540e932a5569b2f0f28bbe3b7632cf5b86b91391d98deac1c6` |
| `/tmp/test0-tools2.txt` | `[1,18]` = #2,#19 | `bfd7957dba628c1b649d6df7962f61ca95f17f7986918e66ae48fe87b0047505` |
| `/tmp/test0-tools2b.txt` | `[36,98]` = #37,#99 | `11c31909ec8d20350ded3c7d0b3216d70994328b25cfff8644ebc3f1f3c0dd47` |
| `/tmp/test0-one12.txt` | #12 | `181ab4886404031af415a5895d1bbb11b04df1da3b49f9da67e5260fcdd0522a` |
| `/tmp/test0-one35.txt` | #35 | `3c319f2952dfed03184fb6e982a06c3688f15bab9bca0689010b72a211a08d3a` |
| `/tmp/test0-one99.txt` | #99 | `d617ed6176db0a97479ae81d0e0dc7e2c6df5235a0cbd78748a9ab585cbfe889` |
| `/tmp/test0-one19.txt` | #19 | `83f9054e89ef4dab9823d397097daaf976c6263d7988b89b209b2089264ddd97` |

### 1.5 9 题真实重跑命令（原样）

```bash
cd /home/ma-user/work/official_judge_emulator
export INTERN_API_KEY="$(cat /tmp/.k1)"          # 或用户提供的新 key
export INTERN_ENDPOINT="$(cat /tmp/.k2)"         # 或上面的 endpoint
export PYTHONPATH=/tmp
SUB='/home/ma-user/work/Astra /astra-refactored'
RUN='/tmp/astra-test0-remain9-max8-20261020c'
(cd "$SUB" && python3 scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json)
test "$(grep -c . /tmp/test0-remain9.txt)" = 9
test ! -e "$RUN"
setsid nohup bash -c '
  python3 run_judge.py \
    --submission "$SUB" \
    --input /tmp/test0-remain9.txt \
    --report-dir "$RUN" \
    --archive "$RUN.zip" \
    --infer-total \
    --client-factory real_client_factory_retry:build_client \
    --item-concurrency 3 \
    --api-concurrency 3 \
    --max-model-calls 240 \
    --default-max-tokens 8192 \
    --model-max-attempts 1 \
    --model-retry-backoff 5 \
    --item-timeout 1800 \
    --judge-concurrency 4 \
    > "$RUN.log" 2>&1
  echo "EXIT:$?" >> "$RUN.log"
' >/dev/null 2>&1 &
```

单题/子集只需把 `--input`、`--report-dir`、`--item-concurrency` 改小：

- `#12`：`--input /tmp/test0-one12.txt --item-concurrency 1 --api-concurrency 1`
- `#35`：`--input /tmp/test0-one35.txt --item-concurrency 1 --api-concurrency 1`
- `#99`：`--input /tmp/test0-one99.txt --item-concurrency 1 --api-concurrency 1`
- `#2/#19`：`--input /tmp/test0-tools2.txt --item-concurrency 2 --api-concurrency 2`
- `#37/#99`：`--input /tmp/test0-tools2b.txt --item-concurrency 2 --api-concurrency 2`

### 1.6 本次定向证据目录（不是 repo 内容）

| 目录 | 用途 |
| --- | --- |
| `/tmp/astra-full100-c9` | **修复后 100 题全量实跑（当前主结果）**：97/100 候选、0 Node/Host 分歧丢题、1546 calls、本地严格 23/100 |
| `/tmp/astra-fail12-c8` | 12 个旧失败题（A 组未解子集）复跑：11/12 候选、0 FIELD_VALUE |
| `/tmp/astra-lost3`、`/tmp/astra-lost2r` | 新全量里 3 个传输层未解题的恢复验证：`#11` 出候选且答案对，`#15`/`#48` 出候选 |
| `/tmp/astra-rerun-ab-10000-20261021-TrfJBe` | **修复前基线**：A 组 100 题全量，68 正确/12 错误/12 未解/8 争议，strict 18/100，1459 calls/9.739M tokens |
| `/tmp/astra-test0-merged-max8-20261020` | 100 题 max8 单轮基线快照：strict 19，逐题 86/13/1 |
| `/tmp/astra-tools5-20261020` | #2/#10/#19/#24/#35 的 5 题重跑；#10/#24 正确，#2/#35 当时 FIELD_VALUE |
| `/tmp/astra-one12-debug4` | #12 使用 forced enumeration，候选 `223/8330`，18 calls |
| `/tmp/astra-one35-debug7` | #35 使用 forced `MAXIMAL_MINORS`，候选 degree-6 Alexander，18 calls |
| `/tmp/astra-one99-debug` | #99 候选 `假`，18 calls |
| `/tmp/astra-tools2c-20261020` | #2/#19 最新精确工具重跑；#2 仍漏根，#19 仍非归一化 |
| `/tmp/astra-tools2b2-20261020` | #37/#99；#37 仍 A,C；#99 当次 FIELD_VALUE，后由 one99 修对 |
| `/tmp/astra-one19-debug` | density closure 尝试，但 15k 字符超长包导致 FIELD_VALUE，不能作为最终证据 |

这些目录是**本次机器上的证据**；如果被清理，按 1.4/1.5 重建重新跑。不要把
`/tmp` 结果当成 repo 的稳定资产，也不要把旧目录名当成新结果。

### 1.7 当前口径（以 stability 修复后的新全量为准）

**当前有效全量结果（2026-10-21 修复后，`/tmp/astra-full100-c9`）：**

- 输入与 runner 配置与下表 A 组完全一致（同一 `input.test0.jsonl`、4/4 并发、
  `max_model_calls=10000`、`default_max_tokens=8192`、`model_max_attempts=1`、
  no-retry 客户端、本地 ReferenceJudge）
- 代码：HEAD `eb36a5a` + 本轮**未提交**的稳定性改动（§2 顶部那 6 条）；
  bundle 已按该源码重建，`release/BUILD_MANIFEST.json` 已 `--verify`
- 结果：**97/100 出候选**；`0` 个因 Node/Host 语义分歧丢题；1546 次模型调用
- 本地严格 `ReferenceJudge`：**23/100**（格式敏感，仅供对照，不等于数学正确率）
- 3 个未出候选：`#11`、`#15`、`#48`，全部是传输层故障；开启传输重试后 3 题
  全部出候选（`#11` 答案 `223/8330` 与参考一致），即有效 **100/100 候选**
- 逐题复核（§10.3）：**77 正确 / 20 错误 / 3 未解**；补跑 3 题后 **79 / 21 / 0**
- 严格判分器把 53 道正确答案判成 B（记号差异），因此不能当准确率引用

**修复前基线（frozen commit `36e056f`，A 组旧全量，仅作对照）：**

- 数据根：`/tmp/astra-rerun-ab-10000-20261021-TrfJBe/`
- 逐题复核：`A_item_review_v2.md` / `.json`
- 冻结源码：`submission/`，commit `36e056f`，bundle sha256
  `f667d344665430ef92d214fd9c9047b736b9c01d71ef8dcf1a421ba7800326b6`
- 输入：`input.test0.jsonl`，sha256
  `d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c`
- 配置：arm `max_model_calls=10000`，4/4 并发，单题 profile 为 256 calls /
  64 units / 2 effects / 2 reviews / 1 method / 2 repairs / 8 consensus /
  1 R0 / 1800s / BEST_EFFORT / local
- 结果：**68 正确 / 12 错误 / 12 未解 / 8 争议**
- strict `ReferenceJudge`：**18/100**
- 候选：88/100；12 个未解全部是 `FIELD_VALUE`、`NO_CANDIDATE`
- 外层次数：1459 requests / 1459 attempts；9,739,322 tokens；14.59 calls/题
- 12 未解：`#2,#6,#12,#15,#16,#35,#37,#43,#82,#86,#88,#100`
- 12 错误：`#7,#17,#19,#20,#21,#23,#30,#38,#46,#52,#70,#97`
- 8 争议：`#8,#13,#27,#45,#48,#84,#95,#96`

**历史定向口径（只能作为诊断，不是全量成绩）：**

- `86` 不是一次机器跑出来的自动分，而是：
  1. `/tmp/astra-test0-merged-max8-20261020` 的 100 个 max8 合并候选；
  2. 第一遍同语义判分 `semantic_judge_merged_final.jsonl`：80/100；
  3. 第二遍更严格逐题语义判分 `item_review_b.jsonl`：**78 正确 / 21 错 / 1 争议**；
  4. 人工逐题复核把其中 8 条 B 判错项翻为正确：
     idx `27,47,57,64,76,78,83,95`（题号 #28,#48,#58,#65,#77,#79,#84,#96）；
  5. 因此 `78 + 8 = 86 正确`，余下 13 错 + 1 争议；
  6. 再对 idx `6,12,16,51,69`（#7,#13,#17,#52,#70）做 5 次定向修复重跑，
     才得到 91 正确 / 8 错 / 1 争议。
- 所以 86 的构成是 **78 条第二遍语义判分 + 8 条人工翻案**；不是 86 条自动判分。
  它包含可争议的人工翻案（例如 #84），严格说区间是 78–86，不是“机器确认 86”。
- strict `19/100` 是**另一套 exact ReferenceJudge**，不是 86 的来源；当前
  `/tmp/astra-test0-merged-max8-20261020/outputs` 含后续修复后的文件，直接重算会得到
  strict 20/100，不能用当前目录重算来“验证”19。19 对应预修复的合并快照。
- 100 题 max8 也是**分批合并**（上游 token quota 限制），不是一次不中断运行。
- 先定向修 `#7/#13/#17/#52/#70`：91 / 8 / 1；strict 20/100
- 再定向修 `#10/#12/#24/#35/#99`：96 / 3 / 1；strict 22/100
- 若按 completeness 接受 `#44` 的额外真性质：97 / 3 / 0
- 这些数字只证明“在指定错题上、允许定向重跑时能修对”，**不证明全量稳定性**；
  A 组全量已经证明 `#12/#35` 在普通单次全量里仍可能 `FIELD_VALUE` 未解。

**报告规则（2026-10-21 更新）：**

- 主结果改为**修复后新全量**：`/tmp/astra-full100-c9` → 97/100 候选、
  0 个 Node/Host 分歧丢题、1546 调用、本地严格 23/100；3 个未解是传输层故障，
  开重试后 100/100 候选。
- 旧的 A 组 **68/12/12/8、strict 18** 只能作为**修复前基线**引用，必须说明它
  是“12 个未解全是 FIELD_VALUE”的那一版。
- 96/97/91/86 必须标注为 targeted repair / 合并快照+人工复核，不得单独称为
  “全量分数”。
- 新全量的**逐题正确数**还没做（只做了 12 题子集人审），任何“正确率 X/100”
  的说法都必须先给出逐题清单来源。
- 严格 strict 与语义复核、逐题复核是三种不同口径，不能混用。
- 平台分/人工正式分尚未取得。


### 1.8 复跑纪律（另一 agent 必须遵守）

1. 不把 test0 的 `answer`、题号、参考式或定向 skill 注入 solver；参考只用于评测/复核。
2. 工具触发按题面数学对象语义，不按 idx；当前实现见
   `apps/stdio-runtime/src/agent-loop.ts` 的 `finiteCountingProblem` /
   `exactOperation`。
3. `maxConsensus=0` 必须保持默认行为不变；新机制只在 `maxConsensus>=1` 的
   answer-bearing 路径启用。
4. 真实 API key 只能从环境读；日志写文件，不写 stderr。
5. 改 TS 后必须 `tsc -b` → esbuild → manifest → `--verify`，否则真实跑的是旧 bundle。
6. 当前全量主结果必须写**修复后新全量**：97/100 候选、0 个 Node/Host 分歧丢题、
   1546 调用、本地严格 23/100；旧的 A 组 **68/12/12/8、strict 18** 只能作为
   修复前基线。96/97 只能作为 targeted repair 诊断，不得写成全量盲跑。
   报告必须同时给出 strict / 语义 / 逐题三种口径。
7. 实测默认双臂对照：`no_retry_factory`（与 A 组旧全量同臂）与
   `real_client_factory_retry`（带传输重试）。传输层故障导致的未解必须在报告里
   单列，不能混进“数学错误”。
8. 任何 Node/Host 语义改动都要同时改两侧 + 加 e2e，并保证
   `tests/e2e/test_ts_binding_parity.py` 与 `test_ts_transport_recovery.py` 仍绿。

---

## 2. 本会话已落地的改动（有验证）

> **2026-10-21 稳定性批次（本轮最新，细节见 §10 前的两节）**
> 1. WorkPacket 8 个身份字段改为**控制数据**：TS `canonicalizeP2WorkPacketText`
>    在 receipt / P4 binding / revision target 三处重绑；Python
>    `trusted_packet_binding`+`checked_packet` 在 candidate/work packet、
>    artifact 投影、progress 投影、`check_inputs` 全部重绑。数学字段一个字节不改。
> 2. 依赖口径统一为**无重复子集**（Node `packetDependencies`、`p4-binding`、
>    Host `candidate_packet` / `check_inputs`）。
> 3. Host 同题 run 归并：ballot 只收非空候选（JS 空白集合）；整轮无候选时回退
>    **首包**（对齐 Node `?? consensusAttempts[0]`）。
> 4. 修 `candidate_packet` 里 `version` 变量被依赖 ref 的 `artifactVersion`
>    覆盖（导致 G3/PR4 REPAIR 候选恒被判 None），修 `agent_history` 漏导入
>    `ProtocolError`。
> 5. 新增 e2e：`test_ts_binding_parity.py`（8 例）、
>    `test_ts_transport_recovery.py`（2 例）；8 个 TS 用例 + 3 个 Python 用例
>    改为新契约的断言。
> 6. 门禁：`tsc -b` 0 / Node 334 / Python 718+24 skipped / manifest `VERIFY_OK`；
>    全量 100 题 97 候选、0 `FIELD_VALUE`。

**A. 契约加深（目标第 2 项，已生效）**
- `packages/protocol/src/p2.ts`：`P2_OBLIGATION_KIND` 新增 `INDEPENDENT_DERIVATION`（永不是 answer 义务）。
- `packages/math-contract/src/p2-compiler.ts`：每个 goal kind 的义务表插入它（`VALUE` 4 个、`UNKNOWN` 3 个、`ALL_SOLUTIONS` 6 个），并补 `KIND_EXPECTED` / `KIND_ACCEPTANCE`（`independent-derivation-review`）。
- 实测深度（Node 探针，同一道 `Compute 2+2`）：**3 任务/4 调用 → 4 任务/6 调用**，序列 `CANDIDATE_VALIDITY → DOMAIN_VALIDITY → INDEPENDENT_DERIVATION → OUTPUT_COVERAGE`。

**B. 修掉 5 处"只允许 model-1..3/4"的硬编码**（深图下它们把第 4 次及以后的调用判成固定错误）
1. `packages/math-contract/src/p2-ledger.ts`：`YIELD_REQUEST_ORDINAL` `model-1..4` → `^model-(?:[1-9][0-9]{0,2})$`
2. `apps/stdio-runtime/src/agent-loop-context.ts`：`REVISION_ORDINAL` 同上
3. `packages/math-gateway/src/p3-effect-data.ts`：`REQUEST_IDS=[model-1..3]` → 同正则
4. `python/astra_bridge/p3_effect_contract.py`：`REQUEST_IDS` → `tuple("model-"+str(n) for n in range(1,257))`
5. **JSON schema 7 个 enum**（`packages/protocol/schema/agent-host-v13.schema.json` 与 `release/schema/agent-host-v13.schema.json`，两份内容一致）：`tool.execute` / `method.load` 的 request+result `binding.sourceRequestId`（各 3 项）、`model.generate` 的 request/result `requestId`（各 32 项）、`session.solve` 的 `candidateRequestId`（33 项）→ 全部 256 项。
- 效果：tool effect 由 `OUTCOME_UNKNOWN` 变为 `RETURNED COMPLETE`，第 4 次调用上的工具检查才真正可用。

**C. 容量上限（深图必需）**
- `packages/protocol/src/p2.ts`：`maxObligations 16 → 42`、`maxTasks 32 → 48`（旧值会让"4 个标注小问"的 multipart 直接 `BOUND_EXCEEDED`）
- `packages/math-gateway/src/p2-gate.ts`：`chooseP2ReadyTask` ready 上限 `32 → 48`
- `python/astra_bridge/agent_context.py`：`_MAX_REFS 3 → 8`

**D. WORK 提示词（仅 system prompt，payload 字节不变，有单测钉住）**
- 答案任务"先做一次注册工具检查"的要求（`ANSWER-CHECK TURN` 段，`agent-loop-context.ts`）
- `unsolved` 只允许用于"题面不可读/超范围"（原措辞会让模型 1 次调用就弃答）
- 实测：候选率 18/20 → 19/20；但**工具检查是否发生仍是模型自愿**（不同措辞下 0~7/20 题触发），不是控制属性。

**E. 文档（持续更新）**
- `docs/DEEP_LOOP_STATUS.md`：迁移现状、已修硬编码、剩余红、下一步。
- `docs/REAL_MODEL_SMOKE_20261018.md`：真实 API 冒烟 + 100 题全量 + 6 次 20 题 pilot 表 + 归一化对照。
- `docs/GATEBOARD.md`：门禁与分布状态。

---

## 3. 当前红灯（2026-10-21 已清零，保留历史结论供定位）

```
pytest -q → 869 passed, 24 skipped, 0 failed
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
          → 370 pass, 0 fail
python3 scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json → VERIFY_OK
```

> 下面这段是 2026-10-19 的三红记录，**现在都已修好**（S2 的第六份
> `model-1..model-3` 硬编码、`REVISE_REJECTED` 的断言口径、checkpoint 预算
> 断言）。保留它是因为同样的根因（request-id 面不一致）在本轮又以
> Node/Host 投影不一致的形式出现过一次，见 §10。

1. `tests/e2e/test_ts_g3_flagship.py::test_public_entry_multi_gap_complete_repair_revises_the_candidate`
   - 期望 repair 后答案是 `p!=0: two solutions; p=0: one solution`，实际拿到父候选 `p=0: zero solutions`。
2. `tests/e2e/test_ts_g3_flagship.py::test_public_entry_multi_gap_partial_repair_is_refused`
   - fail-closed 行为**是对的**（父候选保留），但断言 `result["reason"] == "REVISE_REJECTED"`，实际 `BEST_EFFORT_CANDIDATE`（`stopReason` 才是 `REVISE_REJECTED`）→ 断言口径要按实际语义对齐。
3. `tests/e2e/test_ts_g7_checkpoint_resume.py::test_resume_budget_only_tightens`
   - `CheckpointError: CHECKPOINT_BUDGET`，预算断言需迁到 4 任务图（预算语义未变）。

### 已做完的定位（省时间）

- 场景（PARAMETER 旗舰）在 4 任务图下的真实调用序列（用 `client.seen` 打印每个请求 body）：
  ```
  call0 BOUNDARY_EXCEPTIONS(答案义务，秩 1)
  call1 DOMAIN_VALIDITY
  call2 INDEPENDENT_DERIVATION
  call3 OUTPUT_COVERAGE  ← 这里发 tool 动作
  call4 OUTPUT_COVERAGE  ← 工具观测后重新投递
  call5 R2
  ```
- `allowArtifactRedo` 在答案任务上**恒为 false**，除非 `max_work_units >= 5`（`remainingUnitsAfterWork >= 1`）。已把两条用例改成 `max_model_calls=10, max_work_units=5`。
- fixture `MultiGapParamClient._work` 原先只看 `stage == "REPAIR"`；已改成同时接受 redo WORK 回合（`body["revisionProvenance"] or body["revisionTarget"]`）。
- `packages/math-review/src/p4-report.ts` 的报文校验已核对：`allowed` = 目标 goal+scope 下全部义务，`reviewCoverage/obligationIds = goal-1:OUTPUT_COVERAGE` 合法；`derivation` 来自目标 packet，`start=0,end=4,quote=前 4 字符` 自洽 → **issue 解析层不是卡点**。
- **关键未解**：S2 修复段（`agent-loop.ts` 里 `opts.maxRepairs >= 1 && stop === "REVIEWS_COMPLETE" && …` 那一大块）**从未进入**——我给该段加的 `/tmp/s2dbg.txt` 文件日志从未生成。

### 下一步就做这一件事（二分）

在 S2 段**入口**加一次性文件日志（不要用 `console.error`，Host 会把 stderr 当 `CHILD_FAILED`）：

```ts
require("node:fs").writeFileSync("/tmp/s2entry.json", JSON.stringify({
  stop, challenges: review?.snapshot().challenges.map(c => [c.status, c.availability]) ?? null,
  hasCandidateTask: candidateTask !== null, schemaRepairs, callsLeft: callsLeft(),
  repairBudget: opts.maxRepairs, targetActive: target?.availability ?? null,
}));
```

跑 `python3 -m pytest tests/e2e/test_ts_g3_flagship.py -q -k multi_gap`，按结果分支：

- `challenges` 为空 → `P4ReviewSession` 没有把 ISSUES 升成 `CHALLENGED`：查 4 义务图下的覆盖/obligation 校验；
- 有 challenge 但 `availability !== "ACTIVE"` → 追 availability 何时变 STALE（很可能与新增任务的 artifact 版本/epoch 有关）；
- `stop !== "REVIEWS_COMPLETE"` → 修评审结论归一化；
- 入口日志也没生成 → 说明外层 `try` 之前就退出，回头查 work 循环的 `stop` 赋值。

定位后**先修红、再修 checkpoint 断言**，`pytest` 全绿 + `tsc -b` 0 + Node 329 + `build_release_manifest.py --verify` 之后再谈新功能。

---

## 4. 目标第 1 项：有界多轮 review → repair → 再 review（已实现，2026-10-19 收口，见 §9）

现状：Host 与 TS 都把评审/修复钉成"恰好一次"。

要改的位置（两侧同步，保持 fail-closed）：

1. `python/astra_bridge/agent_host.py`
   - `on_model` 的 R2 分支：`review_calls >= 1 → _fail()` 改为 `review_calls >= max_reviews`
   - REPAIR 分支：`review_calls != 1`、`repair_calls >= 1` 改为 `review_calls >= 1`、`repair_calls >= max_repairs`
2. `apps/stdio-runtime/src/agent-loop.ts`：把单次 R2 块改成 `for (round = 0; round < opts.maxReviews; round++)`，每轮：评审 → 若 `CHALLENGED` 则 repair WORK → 再评审（修复后的复核打 **R4** 标签，不要复用 R2）。
3. 范围同步：`packages/protocol/schema/agent-host-v13.schema.json`（`maxReviews`/`maxRepairs` 上界）、`python/astra_bridge/host_carriers.py`、`agent_runtime.py`、`agent_protocol.py`，上限 3；Host 仍须拒绝越界。
4. 单测：`apps/stdio-runtime/tests/*`（多轮 ordinals、预算、边界）+ e2e（两轮 repair 的假客户端）。
5. 注意 `packages/runtime-core/src/agent-session.ts` 的 `AGENT_MAX_TRACE_EVENTS = 64`：调用变多后会先撞这个上限，需要同步抬高。

---

## 5. 借历史 Python 版本（c3fcd62 / 2e5f35b）要移植的东西

已确证（来源：`Astra /版本与评测记录总览.md`）：

| 提交 | 实现 | 平台成绩 | 成本 |
| --- | --- | --- | --- |
| `c3fcd623`（= c3fcd62） | 稳定 0.9.8 + **原 22 族方法层** | **76/100** | 5303 请求 / 9.99M tokens / 199.5 min |
| `2e5f35bf`（= 2e5f35b） | 0.9.8 + **General Math 1.1，20 方法卡**（`family_count=20`） | **75/100** | 6261 请求 / 20.0M tokens / 165.1 min |

> **状态（2026-10-23）：本节 1–5 项已全部落地并跑过门禁，逐项落点与证据见 §13。**
> 仍未移植的是 69 个注册工具中除白名单 8 个以外的其余工具（不在本节范围）。

要移植的不是"分数"，而是**方法层 + 调度**：

1. **方法/Skill 卡池**：把 22 族 / 20 卡的 manifest 与正文映射到 TS 的 `P2MethodCatalog` / `P2MethodAsset`，替换现在的 `python/astra_bridge/p2_methods.fixture_catalog()` / `p3_host_methods.checked_catalog()` fixture。
2. **有界多次取卡**：`max_method_loads` 从固定 1 改为有界（建议 ≤4），Host 侧 `_MAX_METHOD_LOADS` 与 schema 同步；现在每题最多载一次，和原仓库"一题多次取卡"差得很远。
3. **软路由**：每题 2–3 个候选域，元数据先看、正文后载（`最终架构.md` §2/§3 的 "Skill池 22 family / 候选领域 2–3"）。
4. **阶段配额**：`最终架构.md` 要求"前置规划与评审 ≤ 单题软预算 25%、收尾预留 10%"，现在 Host 只有一个大 cap（256）而无人使用 → 应改成 Host 侧软预算分配。
5. **R0 三评审**：文档要求"题意 / 方法 / 任务·工具"三个独立评审 + Controller 汇总 + 一次定向复核；现在只有一个 `P4R0ReviewSession` 且默认关闭。

参考位置：
- `/home/ma-user/work/Astra /baseline-runs/098-test0-intern-s2-20261002T140537Z/WHOLE-RUN-RESULTS.md`（c3fcd62 完整报告）
- `/home/ma-user/work/runs/s2-official-skill-v11-7UZxpR`（2e5f35b 工作仓库，含 `skill-mapping-manifest`：`base_runtime=0.9.8`、`skill_package_version=1.1.0`、`family_count=20`）
- `/home/ma-user/work/runs/s2-targeted100-Ok2g9w`（定向 100 题卡支线；本地语义复核 90/100、平台 92/100 —— 属**定向增强**，不可当泛化成绩）
- `/home/ma-user/work/Astra /full-architecture-study`、`/home/ma-user/work/Astra /baseline-runs/098-v4-comparison-prep-20261003T0754Z/m1-integration-20261005`
- 旧提交副本：`/home/ma-user/work/Astra /challeng_final_submit`

---

## 6. 硬性纪律（违反过的坑）

1. **不许靠抬 cap 假装加深**：成功题仍是 4 次调用时，256 的 cap 一点用没有；正确做法是加真实工作单元（已做的 `INDEPENDENT_DERIVATION` 就是范例）。
2. **不许把 `ReferenceJudge` 当准确率**；报数必须区分：平台评分 / 本地语义复核 / 严格匹配 / 归一化匹配 / 候选覆盖率。
3. **分母口径**：未求解、超时、异常都算错。
4. **不许把密钥写进仓库或日志**；改完跑 `git diff --check`，并对 key 做一次 `grep -rlF "$KEY"` 自检。
5. TS 改动后必须：`tsc -b` → esbuild 重建 bundle → 重建 `release/BUILD_MANIFEST.json` → `--verify` → Node/pytest 全绿。bundle 不重建，真实 run 用的还是旧代码。
6. 调试日志写**文件**，不要写 stderr（Host 会把 stderr 当 `CHILD_FAILED` 直接失败）。
7. 清理插桩后用 `grep -c "dbg(\|appendFileSync"` 确认归零，并**重新编译**（本会话曾因只删了单行而把多行语句切断，`tsc` 报出 `TS1005` 一大片）。

---

## 7. 建议执行顺序（给新上下文）

1. 探活 shell；`tsc -b` + Node 329 + `pytest` 复跑，确认基线就是 `680/24/3`。
2. 按 §3 二分定位 S2 未进入的原因 → 修 3 个红 → 全绿 + `--verify`。
3. 做 §4 的有界多轮 review→repair→R4（两侧同步、上限 3、抬 `AGENT_MAX_TRACE_EVENTS`）。
4. 做 §5 的方法层移植（22 族 / 20 卡 + 有界多次取卡 + 软路由 + 阶段配额）。
5. 每完成一步：20 题 pilot（`/tmp/test0-20.txt`）→ 通过后 100 题全量；报 `calls/item`、候选率、严格分、归一化分，并明确"这不是平台评分"。
6. 文档同步：`docs/DEEP_LOOP_STATUS.md`、`docs/REAL_MODEL_SMOKE_20261018.md`、`docs/GATEBOARD.md`。

---

## 8. 一句话现状

**稳定性已不是瓶颈**：新的 100 题全量实跑 97/100 出候选、0 个 Node/Host 分歧丢题、
1546 次调用、本地严格判分 23/100；剩下 3 题是传输层故障，开重试后 100/100 候选
（§10）。**正确率仍是瓶颈**：97 个候选里逐题仍有明显错解，下一步必须做新的
全量逐题人审，再按错误族做通用修复（参考 §5/§7 的顺序）。

对比 0.9.8 的历史结论（合并口径，仅供参照）：严格 ReferenceJudge 14 → 19/20，
同一本地语义判分 70 → 80，逐题复核 75 → 86（单轮）/91（合并修复），候选 81 → 100，
平均调用 51.07 → 15.18。86 才是可比的单轮基线，91 含错题定向修复重跑；
这些都不是平台分。剩余的 22 族 / 20 卡方法层、多路由规划和 69 个注册工具仍未移植。

---

## 9. 2026-10-19 执行更新（在 §3/§4 之后）

### 已修复的三红

1. **S2 修复段不进入的真正原因**：`packages/math-audit/src/p4-s1.ts` 还有第六份
   `model-1..model-3` 硬编码。四任务图里 checker effect 绑定在 `model-4`，
   `P4DiagnosticLedger.precheck` 抛 `PACKET_BINDING`，于是 S2 在发 REPAIR 前就
   置 `REVISE_REJECTED`。已改成与其他 request-id 面一致的三位序号正则，并在
   `apps/stdio-runtime/tests/p4-s1.test.ts` 钉住 `model-4` / `model-256`。
2. 完整 PARAMETER 修复现在返回 `REVISED_CANDIDATE` + 修订候选；部分修复返回
   `REVISE_REJECTED`（父候选保留），均 `candidateVerified=false`。
3. `test_ts_g7_checkpoint_resume.py::test_resume_budget_only_tightens` 的预算
   断言已按四任务 checkpoint 的 `budget/spent` 计算，预算只收紧的语义未变。

### §4 有界多轮 review → repair → 再 review（已实现）

- `agent-loop.ts`：最多 `opts.maxReviews` 轮；首轮 `R2`，修订成功后对子候选做
  `R4` 复核；每轮最多一次 `REPAIR`，仍受 S1 结构映射、checker 实质支持、
  grounded basis、PARAMETER gap coverage 的全部 fail-closed 门约束。
- `P4ReviewSession`/report parser 显式接收 `R2`/`R4`；request ordinal 上限与
  root 256 对齐。
- Host：`R4` 合法；`maxReviews/maxRepairs <= 3`；每个 review 轮最多一次
  repair；`R4` 前必须有 repair；二次 review 的 REPAIR source 从 Host 自己
  的早期 `WORK` 历史重导 scope/obligations，不信任 Node body。
- REPAIR artifact id 改成 Host projection 的
  `repair-<下一个已接受 artifact 序号>`，使子候选可被再次精确 review。
- schema、release schema、runtime 上限、trace code、checkpoint journal phase、
  `AGENT_MAX_TRACE_EVENTS`（64 → 128）已同步。
- 新增 `tests/e2e/test_ts_g3_multi_round.py`：两轮完整
  `R2 → REPAIR → R4 → REPAIR`，以及 repair 预算耗尽后仍执行 R4 并保留第一版
  修订的用例。

### 复验状态

- `tsc -b` 0；Node **330/330**；Python **685 passed / 24 skipped / 0 failed**；
  `build_release_manifest.py --verify` `VERIFY_OK`；bundle 已重建。
### 2026-10-19 真实 20 题 pilot（本地 ReferenceJudge，不是平台分）

报告：`docs/REAL_MODEL_PILOT_20261019.md`、
`/tmp/astra-test0-pilot20-r4d-20261019`。

- 严格匹配：**2/20**（#4、#10）；候选 19/20；归一化交叉核对 3/19 候选。
- 100 次模型请求，558,926 tokens，平均 5.0 次/题（最多 7）。
- 19 次 review：15 次 REVIEWS_COMPLETE，4 次 REVIEW_STOP。
- **0 次 repair**：19/20 题没有产生 checker observation，S2 无 grounded
  basis，因此多轮修复没有被真实触发。这是当前真正的瓶颈，不是 cap。

真实 review 暴露并已修复两个工程问题：review prompt 明确 `reviewCoverage`
必须是 obligation-id 数组、quote 要短且精确；parser 只在 quote 在可信推导中
唯一出现时重锚 `stepLocator`，缺失/歧义仍 fail-closed。候选门禁只允许这组
被恢复的 offset 与原始模型报告不同。

- 100 题全量已跑；最终报告 `docs/REAL_MODEL_PILOT_20261019.md`。20 题 pilot
  没有触发 REPAIR，不能当作“多轮修复已提升正确率”的证据。
- §5 的方法层（c3fcd62 22 族 / 2e5f35b 20 卡、有界多次取卡、软路由、阶段
  配额、R0 三评审）仍未移植；这是下一步的主要工作。

### 2026-10-19 最终 100 题执行更新

- **answer consensus / adversarial audit（`maxConsensus` 0..8）**：答案题先做一次盲独立重解，后续每轮带完整 claim/derivation 做对抗审计；
  候选不一致再进行一次裁决；按精确候选多数选择，否则取最后一个有候选的
  attempt。Host 侧按同一规则投影同一题的多条 WORK/CONSENSUS，避免 artifact
  id 与 eventSeq 漂移。
- **强制方法卡**：答案题首个 COMPLETE 草稿不直接接受，先发一次
  `METHOD SELECTION TURN`，必须选真实 catalog id；普通 effect 路径加载后，
  下一 WORK 轮看到真实 `methodAssets`。`maxConsensus=0` 时该路径完全关闭。
- **INCOMPLETE 草稿不再触发强制方法卡**：Host 已把 raw partial packet 当作
  task-level yield，再发同题 WORK 会被 Host 固定拒绝；改为交给 consensus 或
  fail-closed partial delivery。
- **长包护栏**：claim/derivation/candidate 超过 Host 4096 code point 的
  COMPLETE 草稿不直接接受；有合法 consensus attempt 则替换，否则返回
  `PACKET_REJECTED`，不再延后成 `FIELD_VALUE` 崩溃。
- **坏包恢复**：首包和一次 schema repair 都无法解析时，允许一次 Host 授权的
  CONSENSUS 重解；只接受合法 COMPLETE 包，坏文本永不成为 artifact；恢复成功
  后跳过普通 consensus，避免超出 Host 的 consensus 预算。
- 新增/扩展 e2e：`test_ts_answer_consensus.py`（含 INCOMPLETE 不触发方法卡、
  长包替换、坏包恢复）、`test_ts_method_forced.py`、`test_ts_g3_multi_round.py`。
- 最终复验：`tsc -b` 0；Node **330/330**；Python **695 passed / 24 skipped /
  0 failed**；manifest `VERIFY_OK`；bundle 已按最终 TS 源码重建。
- 最终 100 题（max2）：93 候选，841 请求，4,739,444 tokens，8.41 次/题，严格
  **17/100**，语义估计 **68/100**，归一化 **22/93**；7 题未解（4
  PACKET_REJECTED、2 WORK_UNITS_COMPLETE、1 FIELD_VALUE）。这些是本地口径，不是平台分。
- **max8 审计循环**：`maxConsensus` 上限 8；盲独立解之后每一轮都带当前完整
  claim/derivation 做对抗审计，并按 counterexample → proof → exact
  recomputation 轮换；选择题额外逐项判定。
- **100 题 max8 分批合并**：单轮基线快照为 100/100 候选、严格 19/100、
  语义 80/100、逐题 86 正确/13 错/1 争议；随后对 #7/#13/#17/#52/#70 做
  定向修复重跑并合并，得到逐题 91 正确/8 错/1 争议、严格 20/100、1518 请求、
  平均 15.18 次/题、9.110M tokens。91 不是一次不看错题的全量盲跑，报告里必须
  同时写 86 的单轮基线。
- **通用控制条款**：答案上下文增加一般解/齐次模式完备性、二元判断最终极性、
  约定敏感答案三条通用约束；不包含题号、标准答案或定向 skill。

### 2026-10-21 稳定性收口：Node/Host 语义对齐（binding + ballot + 依赖子集）

这一轮只有一个目标：**先把稳定性做到 100/100 候选、0 个 FIELD_VALUE**，
正确率放在其后。根因是 Node 与 Host 对同一份历史做了**不一致的投影/校验**，
模型本身没错也会被判死。

**核心契约变更（唯一一条，必须记住）**
- WorkPacket 的 8 个身份字段（`sessionId`/`problemHash`/`contractVersion`/
  `taskId`/`goalId`/`scopeId`/`routeId`/`sourceRequestId`）是**控制数据，不是
  模型权威**。Node 与 Host 都在严格解析前把这 8 个字段替换成可信绑定值：
  - TS：`canonicalizeP2WorkPacketText(text, binding)`（`packages/protocol/src/p2.ts`），
    调用点 `packages/math-workunit/src/p2-receipt.ts`（交付）、
    `packages/protocol/src/p4-binding.ts`（P4 binding 重建）、
    `apps/stdio-runtime/src/agent-loop-context.ts`（revision target 重建）。
  - Python：`trusted_packet_binding(body, source_request_id)` + `checked_packet(text, binding)`
    （`agent_workflow.py`），调用点 `agent_context.candidate_packet`/`_work_packet`/
    `check_inputs`、`agent_history.project_artifacts`、`agent_progress`。
  - 数学字段（claim/derivation/assumptions/candidate/dependencies/scopeProposal…）
    一个字节都不改；原始 receipt 文本与 hash 全程保持模型原文。
- 因此「模型写错 sessionId/scopeId/goalId 就整题作废」的行为被取消：改为在
  可信 scope/goal 下接受。**仍然 fail-closed 的**：未声明 assumption
  （PACKET_SCOPE_VIOLATION）、外来/重复/版本漂移依赖（UNKNOWN_DEPENDENCY /
  DUPLICATE_ID）、空 claim/derivation（PACKET_DELIVERY）、非法 deliveryStatus、
  超长文本、坏 JSON。

**依赖口径统一为「无重复子集」**（原来 Host 与 `p4-binding` 要求与
`task.inputArtifactRefs` 完全相等，`p2-receipt.packetDependencies` 允许子集）：
Node 三处（receipt/p4-binding）与 Host 两处（`candidate_packet`、`check_inputs`）
现在同一条规则。

**ballot 与首个合法包回退**
- Host `project_artifacts` 的同题 run 归并：只有 `js_nonempty(candidate)` 的包
  才进 ballot（原来是 `strip()`，与 JS 空白集合有差异）；有候选按 CERT1 →
  精确多数 → 最新 tie-break；**整轮都没有候选时选 `run_ids[0]`**，对应 Node
  `consensusAttempts[0]` 的 `??` 回退（原来是 `run_ids[-1]`，会导致 artifact
  sourceRequestId 与 Node 不同 → 下一题 `check_inputs` 找不到行 → FIELD_VALUE）。

**传输层（不改协议契约）**
- 仓库内 `python/astra_bridge/agent_client.py` 仍然保持严格：缺 `finish_reason`
  ⇒ `COMPLETENESS_UNKNOWN`，不允许任何 action/artifact，客户端永久 block。
  `tests/e2e/test_ts_transport_recovery.py` 两例就是钉住这个边界。
- provider 偶发“完整信封但没有终止原因”的处理放在**注入的客户端接缝**（`/tmp`
  里的 factory，不属于 repo）：同一个 provider 请求最多重发 2 次，Host 仍只看到
  一次派发、不额外消耗 Host 预算。同理 HTTP 失败用
  `real_client_factory_retry` 的传输重试。

**顺带修掉的真实 bug**
- `agent_context.candidate_packet` 里依赖循环把局部变量命名为 `version`，
  覆盖了 body schema 版本，导致 G3/PR4 的 REPAIR 候选（body 无 `scope`）
  恒被判 `None` → 12 个真实 e2e 红灯。
- `agent_history` 引用未导入的 `ProtocolError`（上一轮留下的 NameError）。

**测试口径同步（不是放宽，是改成新契约的真实断言）**
- 原来用「伪造 sessionId/scopeId/goalId/sourceRequestId 必须被拒」的用例，
  改成两条：①伪造身份字段被重绑、在可信绑定下被接受；②未声明 assumption /
  重复依赖 / 坏 JSON / 空 claim 仍然是固定拒绝。
- 新增 `tests/e2e/test_ts_binding_parity.py`（8 例）：63/65 字符 problemHash
  重绑、依赖空/子集/全集三种都成候选、不可解析轮次不抹掉已有候选、空白候选
  不进 ballot。
- 复验：`tsc -b` 0；Node **334/334**；Python **718 passed / 24 skipped /
  0 failed**；`release/BUILD_MANIFEST.json` `VERIFY_OK`。
  （716 是加入 `test_ts_transport_recovery.py` 之前的数字，以 718 为准。）

**12 题失败子集实测（`/tmp/astra-fail12-c8`，A 组 12 个失败题）**
- 旧 bundle + 旧投影（`/tmp/astra-fail12-c5`）：8 候选 / 4 未解（含 FIELD_VALUE）。
- 新 bundle + 新投影：**11/12 候选、0 FIELD_VALUE**；唯一未解是第 3 次调用
  传输 `OUTCOME_UNKNOWN`（fail-closed，不伪造），换成带重试的客户端即可恢复。
- 这 12 题的本地严格判分 3/12 是**参考判分器的格式性假阴性**；逐题人审后
  ≈7 正确 / 4 错 / 1 未解（#1 σ⁻² 写成 σ²、#34 特征多项式降级、#36 多选漏 D、
  #42 盐量解算成 0；#14/#15/#87 与参考同义但被判 B；#1 号题参考答案疑似有误：
  `x^4+5` 的分裂域确为 `Q(5^{1/4}, i)`、次数 8）。

### 2026-10-21 全量 100 题实测（stability 口径，`/tmp/astra-full100-c9`）

同一份 A 组输入 `input.test0.jsonl`、同一套 runner 配置（item/api 并发 4/4、
`max_model_calls=10000`、`default_max_tokens=8192`、`model_max_attempts=1`、
no-retry 客户端、本地 ReferenceJudge）：

| 指标 | A 组旧全量 | 本轮 |
| --- | --- | --- |
| 出候选 | 88/100 | **97/100** |
| 因 Node/Host 语义分歧丢题 | 12（FIELD_VALUE） | **0** |
| 逻辑模型调用 | 1459 | 1546 |
| 本地严格判分（格式敏感，仅供对照） | 18/100 | **23/100** |

- 3 个未出候选全部是**传输层**问题，与数学/控制逻辑无关：
  - `#11`：唯一一次调用返回**没有 `finish_reason`** 的完整信封 → Host 判
    `COMPLETENESS_UNKNOWN`（fail-closed）。
  - `#15`、`#48`：最后一次调用 **HTTP 失败**（no-retry 客户端直接把异常抛给
    Host → `OUTCOME_UNKNOWN`）。
- 这 3 题在**开启传输重试**后全部恢复为候选：
  - `#11` 用「缺 `finish_reason` 就在客户端层重发同一 provider 请求」的
    quirk-repair 客户端重跑 → 候选且答案 `223/8330` 与参考答案一致；
  - `#15`、`#48` 用 `real_client_factory_retry` 重跑 → 均出候选（17 次调用）。
  - 因此**有效口径是 100/100 候选、0 FIELD_VALUE**；仓库内 `agent_client.py`
    仍保持严格 fail-closed（缺终止原因 ⇒ 不允许任何 action / artifact），重试只
    发生在注入的客户端接缝，不改变 Host/Node 契约，也不额外消耗 Host 预算。

**本轮代码改动清单（全部带回归测试）**
- TS：`packages/protocol/src/p2.ts`（`canonicalizeP2WorkPacketText`）、
  `packages/math-workunit/src/p2-receipt.ts`、
  `packages/protocol/src/p4-binding.ts`（重绑 + 依赖子集）、
  `apps/stdio-runtime/src/agent-loop-context.ts`（revision target 重绑）。
- Python：`agent_workflow.trusted_packet_binding/checked_packet`、
  `agent_context`（candidate_packet/_work_packet/check_inputs 绑定与子集、
  修 `version` 变量遮蔽）、`agent_history`（ballot 只收非空候选、整轮无候选时
  回退首包、修 `ProtocolError` 未导入）、`agent_progress`（绑定透传）。
- 测试：`tests/e2e/test_ts_binding_parity.py`（8 例）、
  `tests/e2e/test_ts_transport_recovery.py`（2 例，钉住「缺终止原因仍然
  fail-closed」），并同步更新 8 个 TS 用例与 3 个 Python 用例的旧口径断言。
- 门禁：`tsc -b` 0；Node **334/334**；Python **718 passed / 24 skipped /
  0 failed**；`release/BUILD_MANIFEST.json` `VERIFY_OK`（commit `eb36a5a`）。
- **仍未推送**（用户要求）。工作区改动未提交。

---

## 10. 逐题口径与新 run 的人审抽样（2026-10-21）

### 10.1 12 个旧失败题的逐题人审（`/tmp/astra-fail12-c8`）

本地 `ReferenceJudge` 只给 3/12，但逐题看：

| 源题号 | 参考 | 实际 | 判定 |
| --- | --- | --- | --- |
| 1 | `Q(5^{1/4},ζ8)` / 16 / 是 | `Q(5^{1/4},i)` / 8 / 是 | **对**（`x^4+5` 的分裂域就是 `Q(5^{1/4},i)`，次数 8；参考答案本身有误） |
| 5 | `(14253),(165)` | `(13524),(165)` | 错（`σ^{-2}` 写成了 `σ²`） |
| 11 | `223/8330` | 未解 | 传输层丢题（重试后作答并对） |
| 14 | W₂ 公式 | 同式 | **对**（判分器假阴性） |
| 15 | δ₁ + 对数正态密度 | 同义 | **对**（判分器假阴性） |
| 34 | 6 次特征多项式 | `t²-t+1` | 错（阶数降级） |
| 36 | A, C, D | A、C | 错（漏 D） |
| 42 | `240-475√30/18` kg | 0 kg / `120-25√30` | 错（扩散/盐量模型错） |
| 81 | D | D | 对 |
| 85 | C | C | 对 |
| 87 | OLS 估计式 | 同式 | **对**（判分器假阴性） |
| 99 | 错误 | 错误 | 对 |

→ 这 12 题真实约为 **7 对 / 4 错 / 1 未解**，说明严格判分器的最低分不是能力下限。

### 10.2 全量 run 的已知错题方向（供下一轮定位）

- 复合概率/组合计数（如 #11 类）在给出候选后仍需自检归一化（`DENSITY_CHECK` 已
  接入，但只在被调用时才生效）。
- 多项式/特征量类容易“降阶简化”成低次式（#34 类），需要通用次数守恒检查：
  `exact_check_expr` 的 `FACTOR_OVER_EXTENSION`/`MAXIMAL_MINORS` 已经能算，但
  控制层没有强制在“次数类问题”上调用。
- 多选题漏项（#36 类）需要 `CERT1|OPTIONS` 逐项覆盖率检查成为强制闭合，而不是
  只有模型自己愿意写证书时才生效。

### 10.3 全量逐项复核结果 — 复核批次 A（2026-10-21，数据 `/tmp/astra-full100-review-v3/`）

> 本批与 §11.1 的批次 B 是**两次独立复核**，方法不同、数字接近，两者并列保留，
> 不要互相覆盖：A = 77/20/3，B = 73/19/5 争议/3。


复核方式：4 名评审先各审 24–25 题，再把 74 道非未解题交给 3 名对抗评审重判
（只允许在记号/等价形式/参考本身错误时翻案），并用本地严格判分器做第三路交叉。

| 口径 | 正确 | 错误 | 未解 |
| --- | --- | --- | --- |
| **逐项复核（主结果）** | **77** | **20** | **3** |
| 带传输重试后的有效口径 | **79** | **21** | **0** |
| 严格 ReferenceJudge | 23 | 77 | 0 |

- 严格判分器的 23 个 A 与复核的“正确”完全一致；它把 53 道正确答案判成 B，
  全部是记号/等价式/中英文差异 → 严格分不是准确率。
- 二轮推翻 3 个初判：`52`、`69`（错→对）、`94`（对→错，漏 D）。
- 20 道错题分类：漏选/选项不完整 `29,36,47,94,96`；数值或公式错 `1,6,12,18`；
  完备性/多解遗漏 `16,20,22,45`；概念或模型选错 `26,76,83,95`；
  其他 `34,43,98`。
- **参考本身有错**至少 4 题：`1`（分裂域次数给 16，实际 8）、`64`、`87`、`99`
  （后三题复核按数学判对，参考值错）。
- 未解 3 题补跑：`11` → `223/8330`（对）、`15` → 退化 δ₁ + 对数正态密度（对）、
  `48` → “两问都正确”（**错**，反例 `A=E12, B=E21`）。
- 全表 `A_item_review_v3.md` / `.json`，23 题仅单轮复核（其余 74 题双轮）。

### 10.4 下一步（按性价比排序）

1. ~~全量逐题人审~~ **已完成**（见 §10.3）：77 正确 / 20 错误 / 3 未解，
   带传输重试 79/21/0。旧的 86/91 口径作废。
2. 按错误族做通用闭合（不写题号、不写答案）：次数守恒、归一化、选项覆盖、
   多解完备性。每加一条都要有 e2e（假 client 即可）钉住。
3. 稳定复跑：`item/api` 并发 4/4 + **传输重试**（`real_client_factory_retry`）作为
   默认实测臂，另跑 no-retry 臂做对照；两臂都要报候选率与严格分。
4. 迭代门禁不变：`tsc -b` → esbuild → manifest `--verify` → Node 全测 → pytest 全测
   → 才允许跑真实 100 题。

---

## 11. 2026-10-22 执行 §10.3（已完成）

### 11.1 全量 100 题逐题人审（已完成）

- 被审对象：`/tmp/astra-full100-c9`（97 个候选；3 个传输未解）。
- 方法：两遍独立分批复核（每批 ≤10 题，共 10 批/遍），5 个分歧进入第三遍
  裁决；两遍状态一致率 95/100。
- 结果：**73 正确 / 19 错误 / 5 争议 / 3 未解**。
- 参考本身有误：**#1、#64**（#1 的 `Q(∜5,i)` 不是 `x^4+5` 的分裂域；
  HANDOFF §10.1 旧说法需按此纠正。#64 候选 `假` 才是对的）。
- 完整证据：`/tmp/astra-item-audit-20261022/review.jsonl`
  sha256 `de2a91be1d06e0227b45ecfd6ae824e687ec365f342a1cd7b411e4ad118a2494`；
  `/tmp/astra-item-audit-20261022/AUDIT.md`
  sha256 `33829c1598f5bd1ea7814280a8afbfb67b33aab37a526401f20c8623cbf8424c`；
  `/tmp/astra-item-audit-20261022/adjudication/decisions.jsonl`
  sha256 `f6c795e1cbf85e18851785324ec4c2c3c603fb0e99d87099f2849e77873f4ab1`。
- 仓库内摘要：`docs/ITEM_AUDIT_20261022.md`。

### 11.2 通用答案闭合（已完成）

- 新增 `apps/stdio-runtime/src/agent-answer-closure.ts`：选项覆盖、次数守恒
  （MAXIMAL_MINORS 精确观察）、密度归一化、解集完备性四类诊断。
- `agent-loop.ts` 在 consensus/certificate 之后最多花一轮有界 WORK 关闭缺陷；
  只有闭合包严格减少缺陷数时才替换候选；`maxConsensus < 1` 时完全关闭。
- 新增 `apps/stdio-runtime/tests/agent-answer-closure.test.ts`（7 例）和
  `tests/e2e/test_ts_answer_closures.py`（4 例）。
- 复验：`tsc -b` 0；Node **341/341**；Python **722 passed / 24 skipped**；
  manifest `VERIFY_OK`；bundle 已重建。详见 `docs/ANSWER_CLOSURE_103.md`。

### 11.3 两臂全量复跑（已完成）

- 主臂（传输重试）：`/tmp/astra-full100-103-retry`
- 对照臂（no-retry）：`/tmp/astra-full100-103-noretry`
- 两臂使用同一输入 sha256、4/4 并发、10000 calls、8192 max tokens、同一
  `MAX_PROFILE`；只有注入客户端的传输重试不同。

| 臂 | 候选 | 严格 `ReferenceJudge` | calls | tokens | calls/题 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 传输重试（主） | **99/100** | **27/100** | 1551 | 10,426,268 | 15.51 |
| no-retry（对照） | **88/100** | **22/100** | 1501 | 10,014,540 | 15.01 |

- 主臂唯一未解是 **#15**：`FIELD_VALUE`，模型返回含未转义 LaTeX 反斜杠的
  WorkPacket（`remote_outcome_unknown=false`），不是传输层故障。单题用重试
  客户端复跑 9 calls 出候选且密度数学正确
  `/tmp/astra-one15-103-debug`；另一次单题复跑出候选但把对数正态参数写错
  `/tmp/astra-lost15-103`。该失败是随机的模型/协议输出问题，不是确定性绑定
  错误。按“原始全量”口径不把单题复跑合并进 99/100。
- no-retry 的 12 个未解中，9 个 `remote_outcome_unknown=true`（传输/HTTP），
  3 个是 malformed-content `FIELD_VALUE`（#11/#15/#46）。两者在报告里必须
  分开，不能把 12 个都算成数学错误。
- 严格分仍是格式敏感的本地 `ReferenceJudge`，不是平台分；未解、异常都计入
  100 的分母。相对 c9（97 候选、strict 23），主臂候选 +2、strict +4，但这是
  不同模型运行的比较，不是配对因果实验。
- 两臂汇总 JSON：`/tmp/astra-full100-103-summary.json`
  sha256 `4f628325f5ffef20dd7ee6f6d19a2c9163b6c74a6982ddc2d796b7c657bd6c75`。

---

## 12. 逐题复核批次 C（103 两臂）+ 稳定率 + 工具/方法卡改动计划

> 本节所有数字都由**单次盲跑 + 逐题人审**产生，禁止与 §10 的 targeted/合并口径混用。

### 12.1 两臂结果（同一输入 `/home/ma-user/work/input/test0.txt`，4/4 并发，10000 calls）

| 臂 | report-dir | 候选 | 未解 | 模型调用 | 逐题复核（正确/错误/争议/未解） | 严格分 |
| --- | --- | --- | --- | --- | --- | --- |
| 重试 | `/tmp/astra-full100-103-retry` | **99/100** | 1 (`#15`) | 1551 | **81 / 14 / 4 / 1** | 27/100 |
| 不重试 | `/tmp/astra-full100-103-noretry` | 88/100 | 12 | 1501 | **67 / 17 / 4 / 12** | 22/100 |

- 不重试臂 12 个未解里 **9 个是传输层 `OUTCOME_UNKNOWN`**（`#2,#3,#4,#6,#7,#13,#14,#18,#42`），
  换成重试客户端后全部出候选 → **重试臂的 +14 分几乎全部来自"传输救回"，不是数学变强**。
- 逐题复核数据：`/tmp/astra-103-review/out/{retry,noretry}_all.txt`（格式 `idx|verdict|conf|tags|note`）。

### 12.2 稳定率：三次独立盲跑（c9 / 103-retry / 103-noretry）

| 稳定度 | 题数 | 题号 |
| --- | --- | --- |
| **3/3 全对（稳定正确）** | **59** | 见下 |
| 2/3 对 | 19 | `2,3,4,7,13,14,19,23,24,28,29,38,46,52,53,76,84,94,96` |
| 1/3 对 | 10 | `5,6,11,20,22,42,43,45,82,98` |
| **0/3 对（稳定失败）** | **12** | `1,12,15,16,18,26,34,36,47,48,83,95` |

- 单次均值 **75.0/100**；三次全对率 **59%**；"至少对一次"上界 **88/100**。
- 说明：**能力上界约 88，稳定输出只有 59** —— 这 29 分的差就是"能做对但不稳定"。
- 0/3 的 12 题是真正的能力缺口，必须靠工具/方法卡补，不是靠多采样。

### 12.3 为什么"能做对却不稳定"（有代码定位）

> **本表是 2026-10-21 诊断时的状态**。§12.7 之后：语义路由（6 类→10 条）✅、强制轮门禁 ✅、
> 方法卡脱 effect 预算 ✅、所有工具结果进闭合视图 ✅、白名单（4→8）✅；
> **仍未修的是"投票按原文比对"**（第 1 行），它直接决定多次采样能否收敛。

| 原因 | 位置 | 诊断时状态（修前） |
| --- | --- | --- |
| 投票按原文比对 | `agent-loop.ts` consensus `counts.set(attempt.candidate, …)` | `1/2` 与 `\frac12` 算两票 → 明明都对却投不出多数 |
| 语义路由表只有 6 类 | `agent-loop.ts` L1733–1752 `exactOperation` + L1723 `finiteCountingProblem` | 我的 20 道错题里 14 道**结构上不在表内** |
| 强制轮是"提示"不是"门禁" | L1722–1770 | 模型直接交 WorkPacket 也算过，`*Attempted` 已置位 → 机会烧掉 |
| 方法卡与工具共享 effect 预算 | `reserveEffect`（`max_effects=2`）+ L1698 方法卡轮排在工具轮之前 | 卡先吃 1 个 effect，工具只剩 1 次 |
| 只有 `exact_check_expr` 结果能喂闭合 | L1318 | 调 `bounded_enumeration`/`linear_system_solution_set` 白调 |
| 白名单只有 4 个工具 | `packages/protocol/src/p3.ts` `P3_TOOL_NAMES` | 73 个注册、11 个有实现，能用的 4 个 |
| 实测工具命中率 | c9 全量 100 题 | 只有 **17 题**真调过工具（17%）；**81 题**的唯一 effect 是方法卡；**2 题**既没调工具也没加载卡 |

### 12.4 方法卡到底改什么、改在哪

- **是什么**：`mathagent/resources/general_v11/data/methods.json`（20 张）+ `references/<id>.md` 正文
  （单张 ≈2–5KB，`_MAX_BODY_CHARS=24000`），读取器 `mathagent/lite/methods.py:MethodCatalog`，
  协议动作 `{"action":"method","id":...}`，Host `p3_host_methods.py`/`agent_host.py:_methods_enabled`，
  Node `packages/runtime-core` `p3MethodCatalog` + `agent-loop.ts:allowMethods/forcedMethodSelection`，
  正文作为 `methodAssets` 注入下一轮（`agent-loop-context.ts`）。
- **本轮只改"何时必选/如何记录"，不改 20 张卡的内容**。

### 12.5 改动清单（按冲突面分成两类）

**A 类：不碰 `agent-loop.ts`（可立即做）**

| 改动 | 文件 | 锚点 |
| --- | --- | --- |
| 路由漏斗指标 `routed/forced/obeyed/observationUsed` | `python/astra_bridge/agent_runtime.py` | metrics 字典（`remote_outcome_unknown` 附近 L604/L690） |
| 记录加载过的卡 id | `python/astra_bridge/agent_host.py` | `method_loads += 1` 处 |
| 记录工具名与 operation | `python/astra_bridge/agent_host.py` | effect receipt 处 |
| 白名单 4→8（纯数据） | `packages/protocol/src/p3.ts`、`mathagent/input_contracts.py`、`math_families/bridge/dispatch.py` | `P3_TOOL_NAMES` L12 / L221 / L411–420 |

**B 类：必须改 `agent-loop.ts`（等批次 103 的未提交改动落地后）**

| 改动 | 锚点 |
| --- | --- |
| 强制轮改协议门禁（没返回 tool 就再发一轮，bounded 1 次） | L1722–1770 |
| 方法卡脱离 effect 预算 | `reserveEffect` 的 method 分支（L707 附近） |
| 所有工具结果都进 `exactObservation` | L1318–1340 |
| 语义表扩容（Laplacian/根的个数/关系复合/回归诊断） | L1733–1752 |

**明确不动**：`mathagent/resources/general_v11/**`（20 卡内容）、`packages/math-workunit/**`、
`packages/math-audit/**`、另一会话在建的 `agent-answer-closure.ts` / `agent-semantics.ts` /
`tests/e2e/test_ts_answer_closures.py`。

> **实施状态（2026-10-22 核对）**：A 类 4 项、B 类 4 项均已在工作树落地并通过门禁，
> 详见 §12.7；唯一**没有**落地的是 §12.3 第 1 行的"投票键规范化"（见 §12.6.3）。

### 12.6 验收标准（替代旧的"97"口径）

| 指标 | 现状 | 目标 |
| --- | --- | --- |
| 单次盲跑正确（逐题人审） | 81（retry）/ 67（noretry） | ≥88 |
| **三次全对率** | **59%** | ≥92% |
| 单次极差（两臂 81 vs 67；三次含 c9=77 亦为 14） | 14 | ≤3 |
| 工具命中率 | 17% | 语义命中题 100% |
| `FIELD_VALUE` | 0 | 0 |

**永久禁用为"成绩"的数字**：86 / 91 / 96 / 97（合并 + 人工翻案 + 定向重跑）、任何单题挑最好；
它们只能出现在"诊断"章节。

#### 12.6.1 门禁数字的时点对照（避免把旧数当回归）

| 时点 | Node | Python | 说明 |
| --- | --- | --- | --- |
| `59e8aca`（本文件提交的那版） | 334/334 | 718 passed / 24 skipped | 只有 binding/parity 批次 |
| 2026-10-22 `answer-closure` 批次（§12.7，未提交） | **370/370** | **869 passed / 24 skipped** | +36 Node 例、+151 Python 例 |
| 本文件顶部"2026-10-21 旧状态"块里的 341/722 | 341/341 | 722 passed | 那是 §10.3 审计批次时的中间值，**已过期** |

#### 12.6.2 闭合接观察（**2026-10-23 已闭环**，原"9 题 pilot 暴露的缺口"）

原缺口：9 题 pilot 里 `observation_used` 全为 0，无法区分"闭合跑了但没发现缺陷"和
"闭合根本没跑"。本轮把三个层次都修掉并拿到正样本：

1. **观察视图按任务重置（结构性根因）**：`toolObservationViews` / `exactObservation`
   原先声明在**单个任务循环体内部**，而语义路由经常在**更早的任务**上触发，
   于是答案任务开始时视图已被清空。已hoist 到 `runAgentLoop` 作用域，
   `exactObservation` 改为按 operation 建索引（`exactObservations: Map<string, …>`），
   一个无关的 `LIMIT` 结果再也不会顶掉 `MAXIMAL_MINORS` 的结果。
2. **`observationUsed` 从"硬编码 kind 白名单"改为真实溯源**：每个缺陷带
   `evidence: "OBSERVATION" | "CERTIFICATE" | "TEXT"`，指标只看
   `evidence === "OBSERVATION"`；OPTION_COVERAGE / SOLUTION_COMPLETENESS 仍是证书类，
   不会虚报成"用了观察"。
3. **每次闭合判定都留痕**：`CONSENSUS`/`ANSWER_CLOSURE` 行现在**每次都写**，带
   `requestId` / `defects` / `observationViews` / `observationUsed` /
   `closureRequested` / `candidateChanged` / `remainingDefects`；Python 侧新增
   `closure_evaluations` / `closure_defects` / `observation_views` 三个指标。
4. **候选解析补 unicode 上下标**：`t²-t+1` 之前解析成 `null`（`polynomialOf` 只认
   `^`/`**`），导致真实中文答案基本不可能触发次数守恒。现支持 `²³⁴`、`⁻¹`、`−`、`·`、`×`。

**真实 API 正样本**（`/tmp/astra-observe6-107`，6 题：分裂域/密度/结点 Alexander/组合计数/
圆 Laplacian/分离变量，item-concurrency 3，400 calls 上限）：

| 题 | 路由命中 | 闭合判定 | 缺陷 | 观察视图 | `observation_used` | 结论 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| #2 分裂域次数 | 2 | 1 | 0 | 1 | 0 | 观察到达闭合且与候选一致（度 8），无缺陷 → 指标**如实为 0** |
| #35 结的 Alexander 多项式 | 2 | 1 | **1** | 1 | **1** | 观察落地成 DEGREE_CONSERVATION 缺陷 → 花掉一次有界闭合轮 |
| #16 密度极限 | 1 | 0 | 0 | 0 | 0 | 未进入共识块，闭合未评估（见下） |
| #27 圆 Laplacian | 2 | 1 | 0 | 0 | 0 | 闭合跑了，该族没有观察型诊断 |
| #24 分离变量 PDE | 2 | 1 | 0 | 1 | 0 | 观察到达闭合，无缺陷 |

- **可复现**：单题复跑 `/tmp/astra-one35-108`（21 calls，同一 bundle）再次得到
  `closure_evaluations=1 / closure_defects=1 / observation_views=1 / observation_used=1`，
  候选仍是 `t^2-3*t+1` → 观察落地与指标是确定性的，不是偶然。
- 该 run 的第 6 题（#12 组合计数）在收尾前被 shell 重置打断，没有 `run_summary.json`；
  它属于 `FINITE_ENUMERATION`，本来就没有观察型闭合诊断，不影响上面的结论。
- 所以 §12.6.2 想要的两件事都成立：**`observation_used > 0` 的样本存在**（#35），
  且**指标会区分**"观察确认无缺陷（views=1, def=0）"与"观察落地成缺陷（def=1, USED=1）"。
- 仍未证明的是**修复率**：#35 的候选仍是降阶的 `t^2-3t+1`，缺陷被记录、闭合轮被花掉，
  但一次有界轮没能把它改成 6 次不变式（fail-closed：只有缺陷严格减少才替换候选）。
  这条要单独统计，不能算成"闭合已提升正确率"。
- 另一条待办：`#16` 这类题没进入共识块（`answerBearingTask` / 任务归属判定），
  所以闭合根本未被评估；`closure_evaluations` 现在能让这类沉默情况可见，
  但让更多答案任务走进闭合路径仍需单独一轮改动。

#### 12.6.3 投票键规范化（**已落地**，原"唯一未落地项"作废）

原文（作废）：计票仍是 `counts.set(attempt.candidate, …)` 逐字比较，`1/2` 与 `\frac12`
算两票。**这条描述的是改动前的代码**，现已不成立。

实际状态（2026-10-23 逐行核对）：

- `apps/stdio-runtime/src/agent-loop.ts` 唯一计票点用**规范键**：
  `const key = canonicalAnswerKey(attempt.candidate); counts.set(key, (counts.get(key) ?? 0) + 1);`，
  tie-break 重扫同样用规范键；选中的仍是 `attempt.prepared/outcome`，**输出保留模型原文**。
- 规范键实现 `apps/stdio-runtime/src/agent-answer-key.ts`（`truth:` / `rat:n/d` / `set:` /
  `options:` / `poly:` / `text:` 六族，含 `\frac12`、`(A)`、`A、C`、`AC`、集合排序、
  多项式系数标准化）；保守守卫：带选项字母的整句仍是 `text:`，单个小写字母仍是变量。
- Python 侧 `agent_history.ballot_choice` 用 `answer_semantics.canonical_answer_key` 计票，
  tie-break 与 TS 反向扫描等价；`tests/bridge/test_answer_semantics_parity.py` 做
  Node↔Python 差分对拍（`fixtures/canonical_answer_keys.v2.json`，16 同 / 12 异）。
- 回归：`tests/e2e/test_ts_answer_consensus.py::test_canonical_fraction_keys_drive_majority_and_latest_tiebreak`
  （`["1/2", "1/2", "\\frac12"]` → 输出 `\\frac12`，逐字比较会退化成 `1/2`）；
  `tests/bridge/test_answer_semantics.py` 的 `test_ballot_counts_canonical_keys_not_raw_text` /
  `test_ballot_keeps_the_latest_tie_break`；`apps/stdio-runtime/tests/agent-answer-key.test.ts`。
- 本轮补的一处一致性：`agent-loop.ts` 证书闭合判定原用 `!==` 比较候选文本，会把
  `1/2` 与 `\frac12` 当成矛盾并白烧一次闭合轮；已改为 `sameAnswerKey`。
- 遗留：`agreement` 遥测字段仍是逐字 `===`（只写日志、不影响计票），保留原语义以便对照。

### 12.7 §12.5 实施与验收（本轮落地结果）

**A 类（不碰 `agent-loop.ts`）已全部落地**

| 改动 | 落点 |
| --- | --- |
| 漏斗指标 `routed/forced/obeyed/observation_used/tool_effect_calls/method_effect_calls/tool_names/method_ids` | `python/astra_bridge/agent_runtime.py` `_funnel_metrics`，只从真实 SessionLog 行与 effect 记录推导；`observation_used` 只在 `data.observationUsed === true` 时加一 |
| 已加载方法卡 id、工具名与 operation | `python/astra_bridge/agent_host.py` effect/method 记录处 |
| 工具白名单 4→8 | `packages/protocol/src/p3.ts`、`python/astra_bridge/p3_effect_contract.py` 及全部 schema 副本（`packages/protocol/schema/*`、`release/schema/*`） |

**B 类（改 `agent-loop.ts`）已全部落地**

| 改动 | 落点 |
| --- | --- |
| 强制轮改协议门禁：一次 bounded 重试，之后 fail-open 成 best-effort packet，不伪造回执 | `buildSchemaRepairMessages` + `FORCED_TURN_RETRY`/`TOOL_ROUTE` 事件 |
| 方法卡脱离 effect 预算：对外 `maxEffects <= 2`，内部总容量 `maxEffects + maxMethodLoads`（3），Node 与 Host 两侧按类分别记账 | `agent-session.ts`、`p3-gate.ts`、`agent_host.py` |
| 所有工具结果进 answer closure 视图；只有显式 `observationUsed` 才算“用过观察” | `agent-answer-closure.ts` + `agent-loop.ts` 调用点 |
| 语义表扩容（根的个数、分裂域次数、圆/平面 Laplacian、显式解集）并收窄行列式/密度正则 | `agent-semantics.ts`（纯措辞匹配，无题号/答案/隐藏表） |

语义表当前是 10 条确定性路由（首个命中生效）：`bounded_enumeration`、`real_root_count_expr`、
`splitting_field_degree_expr`、`circle_laplacian_expr`、`planar_laplacian_expr`，以及
`exact_check_expr` 的 5 个 operation（`MAXIMAL_MINORS` / `FACTOR_OVER_EXTENSION` /
`DENSITY_CHECK` / `TRIG_REDUCE` / `LIMIT`）。白名单里另外两个老工具
（`polynomial_expand_coefficients`、`linear_system_solution_set`）**故意不加路由**：§12.5 要求扩容的
是“根的个数 / 分裂域 / Laplacian / 关系复合 / 回归诊断”这几族，老工具由模型按需自选，
避免为措辞宽泛的题目强行塞一个用不上的观测。

**另外两处必须修的工具缝**

1. `summary.effectCalls.maximum` 在三份 schema 里还是 2，导致 3 次 effect 的合法运行被整帧拒成
   `FIELD_VALUE`（上一轮 9 题 pilot 的直接死因）。三份副本 + `release/schema` 已统一为 3。
2. `^` 与 `**` 的幂语法只在执行缝归一（`mathagent/tools.py`），`math_families/**` 冻结基线未动，
   `test_g7_registry` / scoped asset 门禁保持通过。

**门禁（最后一次源码改动之后重跑）**

- `tsc -b`：0
- Node（protocol + stdio-runtime）：**370/370**
- 全量 pytest：**869 passed, 24 skipped**
- 聚焦 bridge（规范答案键、TS/Py 一致性、白名单/effect id、Host effect 预算、unsolved 码表）：**458 passed**
- 聚焦 agent e2e（closure / forced / consensus）：**20 passed**
- `release/BUILD_MANIFEST.json`：`VERIFY_OK`（3 JS + 4 assets + 2 bundle），bundle 在最后一次源码改动后重建
- 未 commit、未 push

**9 题真实 API pilot**（`/tmp/astra-tools9-103c`，item-concurrency 3，240 model calls）

- 9/9 题正常返回，无 runner 异常：8 题 candidate + 1 题诚实 unsolved。
- 每题 effect 数为 1 或 3，从未超过容量；`tool_effect_calls <= 2`、`method_effect_calls <= 1` 全部成立。
- 命中路由的 5 题全部 `routed == forced == obeyed`（每条路由都被强制且被遵守，无漏记也未误记）。
- `observation_used` 全为 0：这些题没有触发 closure，因此没有把“抓到观察”冒充成“用了观察”。
- 早前 pilot 的 `FIELD_VALUE`（effect 预算 = 2 的 schema 旧绑定）不再出现。

**唯一异常题（第 2 题，52 张牌“花色数 > 点数数”概率）**：18 次模型调用、142k tokens、
最后一次响应被截断，最终 `unsolved`，码是旧的通用 `FIELD_VALUE`。它没有给出任何答案，
所以这是“基础设施码导致的丢题”，不是错答。为避免同类题继续不可定位，本轮补了三处码表
和一处留证：

| 情况 | 新码 | 位置 |
| --- | --- | --- |
| 驱动层未预期异常 | `EXC_<类型名>`（只取类型名，长度/字符集受限，绝不带消息） | `agent_runtime._exception_code` |
| 子进程干净退出却没给 `session.solve` 结果 | `NO_SOLVE_RESULT` | `agent_runtime` wait 分支 |
| 相位非法帧（例如 solve 未完成就 stop） | `ILLEGAL_TRANSITION` | `agent-host-flow.onRequest` |
| 模型/评审/修复/共识/effect 预算被拒 | `BUDGET` | `agent_host.on_model` / `on_effect` 相位门禁 |
| 根截止时间触底 | `DEADLINE_EXCEEDED` | `agent_host` 回调 deadline 检查 |

`p0_probe.py` 另保留子进程自己写的固定 stderr 码（只取首个大写 token），unsolved 投影新增
`code` / `stage` / `childExit` / `childCode` 四个有界字段。两次复跑把这条题定位到
`stage: session.solve`、`childExit: None`、`childCode: None`，即失败发生在 solve 期间某一帧被
Host 侧判退，而不是子进程崩溃。

**该题单题复跑（第 3 次）已经给出正确候选**：21 次模型调用、549 秒、3 次 effect
（2 工具 + 1 方法）、`routed = forced = obeyed = 2`、`observation_used = 0`，答案是
`223/8330`；离线穷举 52 选 5 的 2,598,960 个手牌得到 69,576 / 2,598,960 = 223/8330，
与该候选逐字一致。也就是说这题不是“做不出”，而是“长跑时会被一个笼统码判死”。

顺带把 Host 侧的两类判退也各自给了码：预算类（模型/评审/修复/共识/effect 配额）→ `BUDGET`，
根截止时间触底 → `DEADLINE_EXCEEDED`。此前它们都是 `FIELD_VALUE`，长跑题目一旦踩到就会被
当成“格式错”，这一轮之后不会再混在一起。

**口径**：以上是 9 题 pilot，不是成绩；§12.6 的 100 题盲跑口径不变，
86 / 91 / 96 / 97 仍然禁止被当作分数引用。

**过程注记**：实现期间一个子代理在排查类型错误时误把 `agent-loop.ts` /
`agent-semantics.ts` 从 HEAD 还原过一次；之后两文件被重新核对，上面所有门禁都在当前工作树上
重跑过，因此这些数字反映的是本轮改动的真实实现。

### 12.8 2026-10-23 闭合接观察 + 计票规范化收口（agent team 执行）

**改动（Node，两个 agent 协作）**

| 改动 | 文件 | 要点 |
| --- | --- | --- |
| 观察视图提升到 run 作用域 | `apps/stdio-runtime/src/agent-loop.ts` | `toolObservationViews` / `exactObservations` / `answerClosureAttempted` 从"每个任务重置"改为"每次 run 累计"，修掉"工具在早任务触发、答案任务视图为空"的结构性根因 |
| exact 观察按 operation 建索引 | 同上 + `agent-answer-closure.ts` | `ExactObservationIndex.get(operation)`；`LIMIT` 结果不再顶掉 `MAXIMAL_MINORS`；不匹配的 operation 永远不能满足诊断 |
| 观察溯源取代 kind 白名单 | `agent-answer-closure.ts` + `agent-loop.ts` | 每个缺陷带 `evidence: OBSERVATION / CERTIFICATE / TEXT`；`observationUsed` 只看 `OBSERVATION` |
| 每次闭合判定都留痕 | `agent-loop.ts` | `ANSWER_CLOSURE` 行带 `requestId/defects/observationViews/observationUsed/closureRequested/candidateChanged/remainingDefects` |
| 候选解析补 unicode 记号 | `agent-semantics.ts` | `x² x³ x⁴ x⁻¹`、`−`、`·`、`×`；`t²-t+1` 之前解析失败导致次数守恒永不触发 |
| 多 minor 观察 | `agent-answer-closure.ts` | 接受字符串或 `{polynomial}` 条目；多个非零 minor 必须同 degree 或同多项式（差常数）才取最高次，否则返回 null，绝不编造 |
| 证书闭合改规范键比较 | `agent-loop.ts` | `1/2` vs `\frac12` 不再被当成矛盾白烧一轮 |

**改动（Python）**

- `python/astra_bridge/agent_runtime.py`：`_funnel_metrics` 新增 `closure_evaluations` /
  `closure_defects` / `observation_views`（防类型污染，坏字段忽略而不抛），
  `_unsolved` 投影同步带这三个键。

**测试**

- Node 新增 15 例（总 **385/385**）：unicode 上下标解析、次数守恒用 `t²-t+1`、
  `REAL_ROOT_COUNT` / `SPLITTING_FIELD_DEGREE` 用真实裸整数 payload、
  多 minor 一致/不一致、R1（工具在单元 1、答案在单元 3 仍能用地基观察）、
  R2（`LIMIT→MAXIMAL_MINORS` 与反向顺序都能读到正确观察）、
  R3（选项缺陷是证书类、无视图时 `observationUsed` 恒假）。
  三个回归都做了变异验证：把 per-task 重置、latest-slot、`views>0` 三个旧写法逐个放回去，
  对应测试分别变红，再恢复。
- Python 新增 `tests/bridge/test_closure_metrics.py`（6 例，bridge 套件 **464 passed**）。

**门禁（最后一次源码改动之后）**

- `tsc -b`：0
- Node：**385/385**
- 全量 pytest：**875 passed, 24 skipped**
- 聚焦 bridge：**464 passed**
- bundle 已重建；`release/BUILD_MANIFEST.json`：`VERIFY_OK`（3 JS + 4 assets + 2 bundle）
- 未 commit、未 push

**真实 API 证据**：见 §12.6.2 的表（`/tmp/astra-observe6-107`：5/6 题完成，
#35 拿到 `closure_evaluations=1 / closure_defects=1 / observation_views=1 /
observation_used=1`，#2 拿到 `views=1 / def=0 / USED=0` 的对照）。

**已知限制（不要当成已完成）**

1. **修复率未证明**：#35 的缺陷被观察到、闭合轮被花掉，候选仍是降阶的 `t^2-3t+1`。
   一次有界轮不保证修好；要单独统计"缺陷→修好"的转化率。
2. **观察视图未按输入键控**：现在按 run 累计，同一 run 里不同子问题的观察理论上可能串用；
   方向是 fail-closed（缺陷只花一轮、且只有缺陷严格减少才替换候选），但仍应按 task/输入哈希分区。
3. **闭合每 run 最多一次**（原来按任务）——与既有设计意图一致，但多任务 run 的后继答案任务不再评估。
4. **`#16` 类题进不了共识块**：`closure_evaluations=0` 说明闭合未被评估；
   现在能看见这种沉默，但让它进入闭合路径仍要单独改任务归属判定。
5. 100 题盲跑**未做**：本轮只有 6 题诊断集，正确率口径仍是 §12.6 的旧数字（81/67，三次全对 59%）。

---

## 13. 2026-10-23 §5 方法层移植（agent team 执行，已落地）

五个 agent 串/并行完成，每个都带独立门禁；最后一次源码改动之后重跑了全量门禁。

### 13.1 逐项落点

| §5 项 | 状态 | 落点 |
| --- | --- | --- |
| 1. 方法卡池（20 卡真实池 + 路由元数据上线） | 已落地 | `mathagent/lite/methods.py`：`catalog(include_metadata=True)` 额外返回 `tasks/objects/structures/role`（有界 token，≤6 项、≤24 字符）；默认仍是 `{id,title}`，lite 旧路径字节不变。`p2_methods.fixture_catalog` 显式请求元数据并对越界字段丢弃；`p3_host_methods.checked_catalog` 严格校验；v13 schema 条目新增这四个可选字段（两份副本逐字节一致）。P3/P0 路径仍投影回 `{id,title}`。 |
| 2. 有界多次取卡（1 → ≤4） | 已落地 | `_MAX_METHOD_LOADS = 4`、`AGENT_MAX_METHOD_LOADS = 4`；effect id 由 3 个扩到 **6** 个（`effect-1..6`，6 处 TS 副本 + 全部 schema 副本），`summary.effectCalls.maximum = 6`，`maxMethodLoads` 上界 4。容量 = `maxEffects(≤2) + maxMethodLoads(≤4) = ≤6`，按类分账不变。**1.2 旧契约保持 `effect-1/2` 与 bound 3**，并新增 `test_legacy_manifest_keeps_its_narrow_effect_table` 钉住这条边界。 |
| 3. 软路由（元数据先看、正文后载） | 已落地 | `semanticMethodRoute(problemText, entries)`（`agent-semantics.ts`）：按卡片自身 `objects/structures` 与题面的静态双语触发表打分，最多 3 个候选，分数降序 + id 升序 tie-break，永不返回目录外的 id；`agent-loop-context.ts` 的方法选择轮只列 `id — title — objects`（无正文），其余 id 仍全列；`sessionLog` 记 `REPAIR/METHOD_ROUTE`。目录无元数据时提示词与日志与改动前完全一致（有测试）。 |
| 4. 阶段配额（前置 ≤25%、尾部保留 10%） | 已落地 | Host：`front_budget = max(1, ceil(cap*25/100))`、`tail_reserve = max(1, ceil(cap*10/100))`，纯整数运算；`R0/R2/R4` 越 fronts 上限 → `BUDGET`；已有候选阶段（`R2/R4/REPAIR/CONSENSUS` 出现过）后，`WORK/CONSENSUS` 在剩余 ≤ `tail_reserve` 时 → `BUDGET`；复核/修复调用不受尾部保留阻挡。指标新增 `front_budget/tail_reserve/front_spent`。启用 `maxR0=1` 时 fronts 允许量抬到该阶段的固定 4 次调用（否则第 3 次评审会被配额饿死）。 |
| 5. R0 三评审 + 汇总 + 一次定向复核 | 已落地 | 角色 `MEANING/METHOD/TASK_TOOL` 各绑定一个既有维度，三次**独立** `model.generate`（不同根 id、互斥 system prompt 与 user payload）；纯函数聚合 `p4-r0-aggregate.ts`（任一 ISSUES ⇒ ISSUES，否则任一 UNKNOWN ⇒ UNKNOWN，否则 NO_ISSUE；`dissents`/`missing` 有界且只含枚举值，不取模型文本）；ISSUES 才进入"至多一次修订 + **恰好一次** `R0_RECHECK`"；根预算界 4 → 5，不足时 `INSUFFICIENT_BUDGET` 且**零模型调用**；`maxR0` 仍是 0/1 开关。审计：每角色一行 `R0_REVIEW` + 一行 `AGGREGATE`。 |

### 13.2 门禁（最后一次源码改动之后）

- `tsc -b`：0
- Node（protocol + stdio-runtime）：**407/407**
- 全量 pytest：**909 passed, 24 skipped**
- bundle 已重建；`release/BUILD_MANIFEST.json`：`VERIFY_OK`（3 JS + 4 assets + 2 bundle）
- `git diff --check`：clean
- 未 commit、未 push（HEAD 仍是 `59e8aca`）

### 13.3 本轮修掉的真实缝

1. **`MethodCatalog.catalog()` 的旧契约不能漂移**：新元数据改为 `include_metadata=True` 显式请求，默认形状仍 `{id,title}`，
   `tests/test_lite_methods.py` 的旧断言因此保持原样而不是被放宽；`a2-source-lock.json` 随 `methods.py` 变更重算。
2. **R0 阶段没有 Host 门禁**：`max_r0` 之前只存不读，R0 帧走 `else` 分支无约束；本轮把 fronts 配额与阶段形状接上。
3. **effect-id 词汇与容量分家**：把"配额"（`maxEffects` 仍 ≤2）与"id 总量"（6）拆开后，方法卡才能多次加载而不挤占工具。
4. **配额会饿死它所保护的阶段**：`maxR0=1` 且小预算时，25% 的 fronts 允许量装不下固定的 4 次 R0 调用；已用显式下限修正，并加测试。

### 13.4 已知限制（不要当成已完成）

1. **软路由只在措辞重合时才给候选**：100 题输入里有 87 题不命中任何工具路由，方法路由同理会有大量"无候选"，
   此时行为与改动前一致；没有"未命中也要给默认 3 张"的兜底（有意为之，避免噪声）。
2. **R0 仍是单轮聚合**：三次评审串行、共用一个根预算；没有并行派发，也没有跨题缓存。
3. **阶段配额是硬门禁**：它按 25%/10% 的固定比例拒绝请求，不做动态再平衡；真实长跑里可能把有用调用拒早，
   需要下一轮用真实 100 题观察"被 BUDGET 拒掉的调用是否都是浪费"。
4. **方法正文仍是 24000 字符上限**、单卡一次加载；多卡组合推理（软路由给 3 个候选但只能载 1 张）还没有做。
5. **本轮没有跑真实 API**：全部是本地门禁 + 假 client e2e；正确率口径仍是 §12.6 的旧数字。

### 13.5 2026-10-23 第二轮：路由扩容 + 第二张卡 + 20 题真实 pilot

#### 路由扩容（`semanticToolRoute`）

新增两族并放宽两族，**旧族优先级不变**、仍然只按措辞匹配：

| 族 | 工具 | 触发 | 明确排除 |
| --- | --- | --- | --- |
| `POLYNOMIAL_EXPAND_COEFFICIENTS` | `polynomial_expand_coefficients` | 展开/展开式/化简为多项式/系数/乘积展开/因式分解后相乘、expand、collect coefficients | 单纯提到多项式、求根/解方程、特征多项式/行列式 |
| `LINEAR_SYSTEM_SOLUTION_SET` | `linear_system_solution_set` | 线性方程组/解方程组/高斯消元/联立方程、`\begin{cases}`、solve the system | 单方程、只有特征值/特征向量措辞 |
| 放宽 `FINITE_ENUMERATION` | `bounded_enumeration` | 追加 枚举/列举/计数/有多少种/排列数/组合数/共轭类的个数/生成元的个数、number of ways | 连续型密度/分布/期望、无限范围 |
| 放宽 `EXACT_LIMIT` | `exact_check_expr`（LIMIT） | 追加 级数(的)和/求和/收敛(到|于)/发散、sum of the series、asymptotic limit | 单纯求积分 |

100 题静态扫描：命中 **13 → 14 题**（`POLYNOMIAL_EXPAND_COEFFICIENTS` 与
`LINEAR_SYSTEM_SOLUTION_SET` 在这套输入上都是 0 命中）。这不是实现失败，而是这套输入的
性质：22 道"多项式"题全是概念选择/证明（主理想整环判定、勒让德生成函数、拉格朗日插值、
龙格现象、回归模型选择），**没有一道在要求展开或求系数**——路由器按设计拒绝过度匹配。
结论：这套输入的工具可达上限约 **14–17%**，要再提高必须**移植新工具**（§5 提到的 69 个
注册工具里目前只接了 8 个），不是继续调路由。

#### 第二张方法卡（`AGENT_MAX_METHOD_ASSETS = 2`）

- 首次加载成功后，仅当 `METHOD_ROUTE` 候选 ≥2、首张卡与候选 2 不同、方法配额还有余、
  `methodLoad` 可用、id 容量有空间、`callsLeft() >= 2 + maxReviews` 时，才**提供**第二次加载；
  模型直接作答同样接受（提示是邀请，不是强制）。
- 上限固定 2（`min(maxMethodLoads, 2)`），第三次请求被拒且整轮仍能出候选；
  `maxMethodLoads = 1` 时行为与改动前完全一致。
- `METHOD_LOAD` 行新增 `ordinal`（1/2）。锁定 profile 的 `maxMethodLoads` 由 1 → **2**（manifest 已重建）。

#### 20 题真实 pilot（`/tmp/astra-pilot20b-109`，4/4 并发，1200 calls）

按族抽样 20 题（多项式 6 / 概率 5 / 级数 3 / 线代 2 / ODE 2 / 拓扑 2）：

| 指标 | 结果 |
| --- | --- |
| 出候选 | **19/20**（1 题 `unsolved`：convergence-limits，`exact_check_expr` 后仍无候选） |
| 路由命中并被遵守 | **8/20**（`routed == obeyed == 2`），tool effect 合计 17 次 |
| 方法卡加载 | 20/20 各 1 张；**0 题载 2 张** |
| 闭合判定 | 19/20 评估；其中 2 题有缺陷（均为证书类） |
| `observation_used` | **0**（两处缺陷都不是观察型，指标如实为 0） |
| `front_spent / front_budget` | 0 或 1 / 64 —— 25% 配额在 cap=256 下**不咬合**（设计如此） |

**第二张卡为何未触发（补充实测）**：另外跑了两组（`/tmp/astra-twocard8-110` 8 题、
`/tmp/astra-twocard4-111` 4 题，后者专门挑 `METHOD_ROUTE` 候选 ≥2 且
`max_method_loads=2` 的题），12 题仍然全部只载 1 张。也就是说机制可用、单元与 e2e 都覆盖，
但**模型拿到第一张正文后就直接作答**、不再申请第二张。下一步要么在提示层让"多域题"更倾向
再取一张，要么把第二张变成多域题的强制门禁——这是策略选择，不是实现缺陷。

#### 门禁（第二轮改动之后）

- `tsc -b`：0
- Node：**417/417**
- 全量 pytest：**910 passed, 24 skipped**
- bundle 已重建；manifest `VERIFY_OK`，`lockedRunProfile.maxMethodLoads = 2`
- 未 commit、未 push

### 13.6 2026-10-23 第三轮：新增 3 个确定性工具 + 接进闭合

#### 为什么不是"移植那 69 个"

清点 `tool-registry.json`（73 个注册工具）后确认：未移植的 69 个绝大多数是**特定谜题工具**
（铺砌计数、LZ78 编解码、rook 数、Tutte 集、牌组博弈……），与这套大学数学 100 题
（环论/群论/分析/概率）几乎不重叠——移植它们**不会提高这套题的覆盖率**。真正缺的是
三个"题面给了显式数据，答案是一个可被精确核对的模型"的能力，于是按这个方向新写：

| 新工具 | 作用 | 载荷要点 | 边界 |
| --- | --- | --- | --- |
| `interpolation_fit_check` | 给定 2–8 个精确有理点 + 一个候选表达式，逐点精确求残差 | `residuals`（精确有理串）、`all_zero`、`degree`、`interpolating_polynomial` | 点数 >8 或次数 > n−1 → out_of_scope；重复 x、非精确数、多变量、不可解析 → invalid_input；全程 `Fraction`，无浮点 |
| `stats_ols_check` | 给定 3–12 对精确数据（可带 slope/intercept 声称），精确算 OLS | `slope`/`intercept`/`sse`/`sst`/`r_squared`/`claim_matches`/`residuals` | 全部 x 相等 → 拒绝而非除零；越界 → out_of_scope |
| `finite_group_structure` | 给定 1–4 个置换生成元（圈记号），闭包枚举子群 | `order`/`is_abelian`/`is_cyclic`/`exponent`/`center_size`/`element_orders`/`conjugacy_classes` | 生成元 >4 或 degree 越界 → out_of_scope；圈记号畸形/点越界 → invalid_input；闭包 >600 元素 → out_of_scope |

落地方式：实现放在 `mathagent/exact_data_checks.py` 与 `mathagent/finite_group_tools.py`
（**没有动冻结的 `math_families/**`**），`tool_contracts.py` 加契约与派发、`tool-registry.json`
加条目；P3 白名单 **8 → 11**，同步 `p3.ts`、`p3_effect_contract.py`、两份 v13 schema 与
`p3-host.schema.json`（两份 v13 逐字节一致）；**冻结的 1.2 `agent-host.schema.json` 仍是 8 个名字**，
SHA 未变。

#### 路由与闭合

- 新路由族：`INTERPOLATION_FIT`（插值/拉格朗日/牛顿插值/过这些点的多项式）、`OLS_CHECK`
  （最小二乘/OLS/回归系数/拟合直线/残差）、`GROUP_STRUCTURE`（共轭类/置换群/元素的阶/生成子群，
  **必须同时出现显式圈记号**如 `(123)`，只有"群同态命题判断"这类背景措辞不路由）。
- 100 题静态命中：**14 → 22 题**（OLS 5、插值 3、加上原有 14）。群结构族在这套输入上 0 命中，
  因为题面给的是 `$A_4$` 这类名字而不是置换圈记号——这是设计的排除规则，不是 bug。
- 三个新工具接进 answer closure，新增三个**观察型**缺陷（`evidence: "OBSERVATION"`）：

| 缺陷 | 触发 | 何时不触发 |
| --- | --- | --- |
| `INTERPOLATION_RESIDUAL` | 观察到 `all_zero === false`，且候选写了一个与观测插值多项式不（规范）相等的多项式 | `all_zero === true`、候选没写显式多项式、载荷畸形 |
| `OLS_MISMATCH` | 观察 `claim_matches === false`，且候选显式写了 slope/截距（或 `y=mx+b`）且与观测值不等 | `claim_matches` 为 true/null、候选没写系数、候选给的数有歧义 |
| `GROUP_STRUCTURE_MISMATCH` | 观察到的 order 或共轭类个数与候选显式陈述的不一致 | 候选两者都没写、载荷自相矛盾、畸形 |

缺陷顺序固定为 `OPTION_COVERAGE → NORMALIZATION → DEGREE_CONSERVATION → REAL_ROOT_COUNT →
SPLITTING_FIELD_DEGREE → INTERPOLATION_RESIDUAL → OLS_MISMATCH → GROUP_STRUCTURE_MISMATCH →
SOLUTION_COMPLETENESS`，`observationUsed` 仍只由 `evidence === "OBSERVATION"` 推导，闭合轮次不变（≤1 评估 + ≤1 轮）。

#### 门禁（本轮最后一次源码改动之后）

- `tsc -b`：0
- Node：**426/426**
- 全量 pytest：**935 passed, 24 skipped**
- bundle 已重建；manifest `VERIFY_OK`（`lockedRunProfile.maxMethodLoads = 2`）
- 冻结基线：1.2 schema SHA 未变、`math_families/**` 未动、两份 v13 逐字节一致
- 未 commit、未 push

#### 已知限制

1. **三个新工具还没有真实 API 实证**：目前只有 bridge 单测 + 假 client e2e；要证明它们改变候选，
   必须挑 OLS/插值/群论题跑真实 pilot（`observation_used` 是否从 0 变正）。
2. **群结构族在现有输入上 0 命中**：题面给的是 `A_4` 这种群名，不写圈记号；要覆盖这类题，
   需要再做一个"按群名建群"的输入形态（例如 `named_group: "A4"`），那属于新契约，未做。
3. **新工具的证据只到"精确核对"层**：`all_zero`/`claim_matches`/`order` 都是对**给定数据**的核对，
   不会判断题面该用哪个模型，也不构成证明。

### 13.7 2026-10-23 第四轮：named group 输入形态 + 12 题真实验证

#### named group（让"题面只给群名"的题也能用工具）

`finite_group_structure` 现在接受两种输入形态之一：

- `generators`：原有 1–4 个置换（圈记号）。
- `named_group`：封闭小群词表 `S3, S4, A4, A5, D8, D10, Z2..Z12`（`C_n` 是 `Z_n` 的别名），
  内部展开成最小忠实置换度上的生成元，再走**同一条**闭包枚举路径：
  `S3=(12),(123)`、`S4=(12),(1234)`、`A4=(123),(124)`、`A5=(12345),(123)`、
  `D8=(1234),(13)`、`D10=(12345),(25)(34)`、`Z_n=(1..n)`。

载荷除原有字段外新增 `input_mode: "generators" | "named_group"`，命名形态再带 `group_name`；
其余字段与等价的显式生成元结果**逐字段相同**（有测试钉住 `S3` 的两种形态）。拒绝规则：
两种形态同时给 / 都不给 / 名字不在词表 / `n` 越界 → `invalid_input`；闭包 >600 元素 → `out_of_scope`。

路由也从"必须有圈记号"放宽为"(受支持群名 + 结构措辞) 或 显式圈记号"，仍排除：只有
`设群 G 同态…` 这类没有群名/圈记号的措辞，以及任何 环/域/理想/扩域 措辞。

#### 100 题静态路由命中

**13 → 22 → 23**（本轮 +named group 之后：`GROUP_STRUCTURE` 2 题）。分布：
OLS_CHECK 5、EXACT_TRIG_REDUCE 4、EXACT_LIMIT 3、INTERPOLATION_FIT 3、GROUP_STRUCTURE 2、
FINITE_ENUMERATION 2、SPLITTING_FIELD_DEGREE / DENSITY / CIRCLE_LAPLACIAN / MAXIMAL_MINORS 各 1。

#### 12 题真实 API 验证（`/tmp/astra-tools12-112`，4/4 并发，800 calls）

挑的是**路由到新族/计数族的全部题**（`D_8` 命题、`A_4` 共轭类、两道组合计数、三道插值、
五道 OLS）：

| 指标 | 结果 |
| --- | --- |
| 出候选 | **12/12** |
| 新族工具真的被调用 | **10/12**（`finite_group_structure` 2、`interpolation_fit_check` 3、`stats_ols_check` 5），另 2 题走 `bounded_enumeration` |
| `routed == obeyed` | **12/12 全等** |
| 观察进入闭合视图（`observation_views > 0`） | **8/12** |
| 闭合判定 | 12/12 都评估了 |
| `closure_defects` | **0** |
| `observation_used` | **0** |
| 模型调用合计 | 238（19–21 次/题） |

**为什么还是 0 缺陷**：这 12 题的答案形态是"选项/判断/个数"，而不是"一个可与观测逐字比对的量"。
观测确实到达了闭合（8 题 `views > 0`），但没有任何一条诊断能把它变成缺陷：插值题是
"拉格朗日/牛顿插值是否精确经过数据点"的判断题，候选里没有多项式；OLS 题是"参数估计用哪种方法"的
选择题，候选里没有 slope/截距；`D_8` 题是命题判断，候选里没有群阶或共轭类个数。
按现有三族诊断的触发条件，这些题**正确地**不产生缺陷——不是 bug，是形态不匹配。

#### 由此得到的下一步（明确、可执行）

要让观测真正改变这类答案，闭合需要**选项级诊断**：把选中的选项文本里的数字/断言抽出来，
与观测值比对（例如选项写"共轭类有 5 个"而观测是 4；选项写"|D8|=16"而观测是 8）。
这属于新诊断形态（`OPTION_NUMERIC_CONTRADICTION`），需要选项文本解析 + 与观测量的对应关系，
比现有三个诊断更难，但是唯一能把"概念题"接进闭合的路。

#### 门禁（本轮最后一次源码改动之后）

- `tsc -b`：0
- Node：**426/426**
- 全量 pytest：**941 passed, 24 skipped**
- bundle 已重建；manifest `VERIFY_OK`（`lockedRunProfile.maxMethodLoads = 2`）
- 冻结基线未动：1.2 schema SHA 不变、`math_families/**` clean、两份 v13 逐字节一致
- 未 commit、未 push

### 13.8 2026-10-23 第五轮：选项级闭合诊断（把"选择题/判断题"接进观测闭环）

§13.7 的结论是"概念题接不进闭合"。本轮补上两个**选项级**观察型缺陷
（`evidence: "OBSERVATION"`），仍然不加任何模型调用、不改闭合轮次上限：

| 缺陷 | 触发 | 排除 |
| --- | --- | --- |
| `OPTION_NUMERIC_CONTRADICTION` | 候选选中的**选项自身文本**把某个数字绑定到某个量，而该量有观测：群的阶（`\|G\|`/群的阶/阶为/order）↔ `finite_group_structure.order`；共轭类个数（`N 个共轭类`/`共轭类…为 N`）↔ `conjugacy_classes.length`；实根个数 ↔ `real_root_count_expr`；分裂域次数（`[E:Q]=N`/扩张次数/分裂域…次数）↔ `splitting_field_degree_expr`；OLS 斜率/截距 ↔ `stats_ols_check` | `元素的阶` 先被掩蔽（它是分布不是单值）；`次数` 只在同句出现分裂域/扩张时才读；一句里出现多个数字或出现未被任何族匹配的裸数字 → **整条选项不产缺陷**；同一量出现两个不同值 → 不产缺陷；观测缺失/畸形 → 不产缺陷 |
| `OPTION_VERDICT_CONTRADICTION` | 选中选项的同一从句断言 `可交换/交换群/阿贝尔/abelian` 与观测 `is_abelian === false` 冲突，或断言 `循环群/cyclic` 与 `is_cyclic === false` 冲突 | 从句里有任何否定/模糊词（`不/非/未/否/未必/不一定/可能/也许/是否/not/never/may/might/non-`）→ 不产缺陷；`元素的阶` 不比 |

**选项解析**：新增导出 `problemOptionTexts`，只认"行/分句开头 + 字母 A–E + `.)、:：`"的标记
（`[` 不在允许前缀里，所以 `[E:Q]=6` 不会被误读成选项 E），少于 2 个标记、字母重复、
正文为空或 >320 字符都判为不可用；只读标记**之间**的正文，且只保留候选真正选中的字母。
`detail` 会写出选项字母、量名、观测值与断言值；`answerClosureNote` 增加一条 ≤240 字符的
`Reconcile the chosen option …` 提示。

缺陷顺序（文档化）：`… GROUP_STRUCTURE_MISMATCH → OPTION_NUMERIC_CONTRADICTION →
OPTION_VERDICT_CONTRADICTION → SOLUTION_COMPLETENESS`；同一轮内按选项字母升序、量族固定顺序。

**测试**：`agent-answer-closure.test.ts` 新增 11 例（选项表只从选项块读、群阶/共轭类、实根、
分裂域次数、OLS 斜率与截距的正确-错误两向、一句两数字不产缺陷、否定/模糊不产缺陷、
确定性顺序、裸数字不归因、畸形观测不抛、note 文案），
`agent-answer-closure-loop.test.ts` 新增 2 例（选项级群阶矛盾 ⇒ 一轮闭合 + `observationUsed: true`；
选对时 `observationUsed: false` 且不花轮次）。Node 总数 426 → **439**。

**真实 API 抽样**（`/tmp/astra-opt12-114`，12 题全部跑完，4/4 并发，800 calls 上限）

挑的是路由到新族/计数族的全部题（`D_8` 命题、`A_4` 共轭类、2 道组合计数、3 道插值、5 道 OLS）：

| 指标 | 结果 |
| --- | --- |
| 出候选 | **10/12**（2 题 unsolved：一道组合计数、一道 OLS 选择） |
| 新族工具真被执行 | **10/12**（group 2、interpolation 3、OLS 5） |
| 路由命中 | 11/12 |
| 观测进入闭合视图（`observation_views > 0`） | **5/12** |
| 闭合判定被执行 | **10/12** |
| `closure_defects` | **0** |
| `observation_used` | **0** |
| 误报 | **0**（没有把一致的答案误判成矛盾） |

**为什么还是 0 缺陷**：这 12 题的答案形态仍然不落进选项级比对——插值题答的是
「正确」（判断题）、「B」、「区间端点附近」（选项文本里没有观测的那个量）；OLS 题答的是
**公式**（`β̂=Σ(x_i−x̄)(y_i−ȳ)/Σ(x_i−x̄)^2`）、「假」、「D」、「A,B,C,D」；
`A_4` 那题答 `4`，与观测（4 个共轭类）**一致**，按规则正确地不产缺陷。
`D_8` 题选中选项与观测也不冲突。

也就是说：选项级诊断的**防误报那一半被真实数据验证了**（11 题、5 个观测视图、0 误报），
但**正例仍然只有单测覆盖**——要拿到真实正例，需要模型真的选中一个与观测矛盾的数字选项，
这属于模型行为，不是代码可控；连续两次抽样（共 16 题）都没出现。

#### 门禁（本轮最后一次源码改动之后）

- `tsc -b`：0
- Node：**439/439**
- 全量 pytest：**941 passed, 24 skipped**
- bundle 已重建；manifest `VERIFY_OK`（`lockedRunProfile.maxMethodLoads = 2`）
- 冻结基线未动：1.2 schema SHA 不变、`math_families/**` clean、两份 v13 逐字节一致
- 本轮结束按用户要求**提交并推送**

---

## 14. 2026-10-23 方法卡 × 数学族 × 工具整合重构（Phase 1，按 `Astra_数学族方法卡与数学工具整合重构方案_及DeepSeek修改提示词.md`）

三个 agent 并行、按文件归属分工，各自带门禁；最后一次改动之后重跑了全量门禁。

### 14.1 任务 1：卡片契约融合 + 归属纠偏 + 提示词补签

| 子任务 | 落点 | 结果 |
| --- | --- | --- |
| 20 张 `general_v11` 卡片追加 `## 绑定计算工具与精确调用契约 (Bound Registered Tools)` | `mathagent/resources/general_v11/references/*.md` | 20/20 已追加；每张 1878–4324 UTF-8 字节（上限 10000/12000），正文远低于 `p3-methods` 的 16000 字节观测上限 |
| 只写**当前可调用**的 11 个白名单工具 | 同上 | `modular-crt`、`coordinates-geometry`、`inequalities-optimization`、`topology-local-global` 4 张卡片明确写"本 profile 无注册算子，纯推理" |
| 模板可执行性 | `mathagent/tool_contracts.py` + `mathagent/tools.py` | 卡片里出现的 **31 个 JSON 模板全部实跑校验：31/31 status=ok**；并纠正了方案里的一个真实偏差——`real_root_count_expr`/`splitting_field_degree_expr`/`circle_laplacian_expr`/`planar_laplacian_expr` **不接受 `^`**，模板统一用 `**` 并注明 |
| 工具归属纠偏 | `mathagent/resources/skill-mapping-manifest.json` | `tool_inventory.validate_inventory()` 硬性要求 `families[].tools` 与 registry 完全一致，**不能搬移**；改为每个族新增 `general_method_ids`，并新增顶层 `tool_ownership`（11 个工具 → 保留的 `family_id` + 权威 `general_method_id`）与 `relocations`，记录四处错挂（`stats_ols_check`→`regression-diagnostics`、`interpolation_fit_check`→`numerical-approximation`、`finite_group_structure`→`algebraic-structures`、`bounded_enumeration`→`counting-bijections`） |
| `SYSTEM_PROMPT` 补 5 个工具签名 | `apps/stdio-runtime/src/agent-loop-context.ts` | 补齐 `polynomial_expand_coefficients` / `linear_system_solution_set` / `interpolation_fit_check` / `stats_ols_check` / `finite_group_structure` 一行式参数说明（+524 字节，总量 ≈11.3 KB，远低于 `MAX_CONTEXT_BYTES=65536`） |

### 14.2 任务 2：路由统一

- 新增 `EXACT_DEFINITE_INTEGRAL_ROUTE`（定积分/`\int` 带上下限；排除极限题与"收敛性/可积性/存在性"等定性判断）与 `EXACT_SIMPLIFY_ROUTE`（化简/约分/通分；排除展开/系数题）。分支顺序：… trig → LIMIT → DEFINITE_INTEGRAL → SIMPLIFY → EXPAND → LINEAR_SYSTEM，并有用例证明三者互斥。
- 新增纯函数 `preferredMethodForToolRoute(route)`：工具路由 → `general_v11` 卡片 id 的 17 行冻结映射。
- `semanticMethodRoute` 融合该信号：命中路由的归属卡获得决定性命中加分（+1024，远大于 ≤12 的 token 分），保证排第一；**无工具路由时返回结果与改动前逐字节一致**（有基线断言）。

### 14.3 任务 3：卡片加载后的协同提示（不改变控制流）

- 卡片刚加载、且命中工具路由、且尚无 `PROGRAM_OBSERVATION`、且工具可调用/预算允许时，在**同一轮** WORK 用户消息里追加一段 ≤600 字符的提示：卡片 id + 路由工具 + 精确 `argsTemplate` + 一行真实输入约束 + "拿到观测后再交完整 packet"。
- 任一守卫不满足时提示**逐字节不变**（有测试）。
- 控制流零改动：请求序号 `model-1..4`（提示路径）/`model-1..5`（强制兜底路径）与事件顺序 `METHOD_ROUTE → METHOD_LOAD → (TOOL_ROUTE) → TOOL_OBSERVATION` 全部保持；强制工具兜底仍然生效。
- 顺带补了 `operationArgs` 的 `DEFINITE_INTEGRAL`（`expression/variable/lower/upper`）与 `SIMPLIFY` 两个分支——此前 EXACT CHECK TURN 的提示会漏掉上下限。

### 14.4 任务 4：完整性基线 + 门禁

- 重算 `mathagent/resources/general_v11/SOURCE.json`（20 张卡片 SHA）与 `python/astra_bridge/asset_baseline.json`（`registry_snapshot` 重建，其他资产组零漂移），`verify_integrity(Path("."))` → **ok=True、errors=[]**；`packages/protocol/schema/a2-source-lock.json` 的 `SOURCE.json` 单行 pin 同步刷新（`224de088…`→`e443a58b…`）。
- `mathagent/tool_inventory.validate_inventory()` → `{'families': 22, 'tools': 76}`。

- `tsc -b`：0
- Node（protocol + stdio-runtime）：**455/455**（基线 439，+11 路由/融合、+5 协同提示与 operationArgs 用例）
- 全量 pytest：**941 passed, 24 skipped**
- 聚焦 bridge：**525 passed**
- bundle 已重建；`release/BUILD_MANIFEST.json`：**VERIFY_OK**（此前因 `skillSkillMapping` 资产哈希变化会 `VERIFY_FAILED`，重建后恢复）
- `git diff --check`：clean

### 14.5 已知限制

1. **卡片只写白名单工具**：方案 §第二部分 表格里点名的 65 个未暴露算子（`gf2_rank`、`rook_numbers`、`markov_expected_steps`、`line_through` 等）**没有写进卡片**——写进去只会让模型调用一个 Host 会拒的工具。它们属于方案 §第四部分 Phase 2。
2. **归属纠偏是"标注"而非"搬移"**：`tool_inventory` 的一致性检查锁死了 `families[].tools` 与 registry 的 family 字段，所以纠偏以 `general_method_ids` + `tool_ownership` + `relocations` 的形式记录，registry 里的 `family` 字段本身没变。
3. **协同提示是"建议"不是门禁**：模型仍可能先交 packet，此时由既有的强制工具轮兜底；本轮没有把第二张卡做成强制（见 §13.7）。
4. **没有跑真实 API**：本轮全部是本地门禁 + 假 client e2e，正确率口径仍是 §12.6 的旧数字。

---

## 15. 2026-10-24 Phase 2 第一批：6 个沉睡算子开进白名单（11 → 17）

按方案 §第四部分 Phase 2 的"第一批优先开放"，把已经写好独立输出审计、但被协议硬编码挡在门外的
六个算子开放出来。三个 agent 按文件归属并行，各自带门禁。

### 15.1 白名单 11 → 17

追加顺序（方案指定）：`solve_quadratic_diophantine`、`symbolic_diophantine_with_timeout`、
`solve_system_guarded_expr`、`polynomial_function_check`、`gf2_rank`、`gf2_nullspace`。

同步五份 live 副本：`packages/protocol/src/p3.ts`、`python/astra_bridge/p3_effect_contract.py`、
两份 v13 schema（逐字节一致，sha `85cdadb2…`）、`p3-host.schema.json`。
**冻结的 1.2 `agent-host.schema.json` 仍是 8 个名字、SHA `d21953e2…` 未变**，并新增两个测试：
一个是"1.2 里绝不能出现 Phase 2 名字"，一个是把 1.2 的字节钉死。

### 15.2 六个算子真的能跑（不是只加名字）

每个都在真实 `RegisteredExecutor` 里跑通并断言 `status == "ok"`、审计 `VERIFIED_FOR_INPUT`、无浮点：

| 工具 | 已验证 payload | 结果 |
| --- | --- | --- |
| `gf2_rank` | `{"rows":[1,2,4]}` | 3 |
| `gf2_nullspace` | `{"rows":[1,2],"width":3}` | `[4]` |
| `solve_system_guarded_expr` | `{"expressions":["x+y-3","x-y-1"],"variables":["x","y"]}` | 1 |
| `polynomial_function_check` | `{"equation":"f(x+y)=f(x)+f(y)","function":"f","argument":"x","variables":["x","y"],"expression":"x"}` | `identity_holds: true` |
| `solve_quadratic_diophantine` | `{"a":1,"b":0,"c":1,"d":0,"e":0,"f":-25}` | 12 组整数对 |
| `symbolic_diophantine_with_timeout` | `{"lhs":"x**2+y**2-25"}` | 12 组字符串解对 |

关键约束（写进了卡片与测试）：`solve_quadratic_diophantine` 要求 `a≠0`、`|系数|≤32`、且必须是
**定形（椭圆型）**，否则需要 `y_bound≤32`、再否则 `resource_limited`；`gf2_rank` 不接受多余
`width` 字段，`gf2_nullspace` 拒绝超宽行；`polynomial_function_check` 恰好 5 个字段且
`expression` 必须是 `argument` 的一元式。

### 15.3 路由与卡片

- 六个新语义路由（纯措辞匹配）：`SOLVE_QUADRATIC_DIOPHANTINE`、`SYMBOLIC_DIOPHANTINE`、
  `SYSTEM_OF_EXPRESSIONS`、`POLYNOMIAL_FUNCTION_CHECK`、`GF2_RANK`、`GF2_NULLSPACE`，
  显式互斥：线性方程组仍归 `LINEAR_SYSTEM_SOLUTION_SET`，单方程不会变成丢番图族，
  GF(2) 核空间优先于 GF(2) 秩。
- `preferredMethodForToolRoute` 增加 6 行：两个丢番图 → `modular-crt`、
  `solve_system_guarded_expr`/`polynomial_function_check` → `domain-equivalence`、
  `gf2_rank`/`gf2_nullspace` → `linearization-spectral`，于是"有卡无枪"的三张卡真正配上了枪。
- 三张卡片补上精确契约（每个模板都从成品卡片里反抽出来再跑一遍，0 失败）：
  `modular-crt` 3410 B、`domain-equivalence` 5226 B、`linearization-spectral` 4488 B
  （上限 10000 B / 4000 字），`modular-crt` 原先那句"本 profile 无注册算子"已被真实契约替换。

### 15.4 完整性与门禁

- `general_v11/SOURCE.json`（3 张卡 SHA）、`asset_baseline.json`、`a2-source-lock.json`
  （`general_v11/SOURCE.json` 单行 pin `e443a58b…`→`e95a362d…`）已重算；
  `verify_integrity` → **ok=True, errors=[]**，未触碰的资产组零漂移。
- `tsc -b`：0
- Node：**464/464**（基线 455，+9 路由/融合用例）
- 全量 pytest：**998 passed, 24 skipped**（基线 941，+57 白名单/Host/执行器用例）
- 聚焦 bridge：**582 passed**
- bundle 已重建；`release/BUILD_MANIFEST.json`：**VERIFY_OK**
- `git diff --check`：clean

### 15.5 已知限制

1. **只开了 Phase 2 第一批 6 个**：第二/三批（`transition_count`、`independence_polynomial_chain`、
   `count_by_digit_property`、`rook_numbers`、`count_avoiding_permutations`、
   `markov_expected_steps`、`cover_time_complete_graph`、`finite_difference_derivative`、
   `richardson_extrapolate`）仍在门外。
2. **新算子没有接进 answer closure**：它们目前只产生观测（`tool_names`/`observation_views`）、
   不会生成缺陷。要像 `finite_group_structure` 那样参与改答案，还需各自的诊断（下一轮）。
3. **没有真实 API 实证**：本轮全是本地门禁 + 假 client；这 6 个算子在真实题上的命中率与收益未测。

---

## 16. 2026-10-24 Stage A–E：断层收口 + 白名单 17→26 + 闭环扩容 + WASI 桥接（按 `Astra_数学族方法卡与数学工具整合重构方案_及DeepSeek修改提示词.md` 新版）

六个 agent 按文件归属并行（loop / 白名单 / 路由 / 卡片 / 闭环 / WASI），最后由我统一做 Stage E 的
完整性同步与门禁。

### 16.1 Stage A：修掉 `c422ddb` 的四个断层

| 断层 | 修法 |
| --- | --- |
| `methodToolInputConstraint` 漏 15 个 Phase-2 算子 → 整数参数被误导加引号 | 补齐 **15 条**真实约束（6 个既有 + 9 个新增），整数参数工具不再收到"全部加引号"的默认提示 |
| `SEMANTIC TOOL TURN` 固定句与整数参数冲突 | 改为 `semanticToolTurnNote(route)` = `methodToolInputConstraint(route) + " Never substitute a different tool."`；协同提示整块仍 ≤600 码点（实测最坏 598） |
| `checkerSupportsObligation` 要求 `args.expression` → `linear_system_solution_set` 永远 false | 该工具改判 `Array.isArray(matrix) && Array.isArray(rhs)`；表达式族不变；未知形态仍 fail-closed |
| `SYSTEM_PROMPT` / `tool_ownership` 只覆盖 11 个 | SYSTEM_PROMPT 补到 26 个（+993 B，总量 12,765 B）；`tool_ownership.tools` 登记 **26** 条（含 `family_id` + 权威 `general_method_id`），`validate_inventory()` 仍 `{families: 22, tools: 76}` |

### 16.2 Stage B：白名单 17 → 26（九个算子，全部实跑验证）

追加顺序：`transition_count`、`independence_polynomial_chain`、`count_by_digit_property`、`rook_numbers`、
`count_avoiding_permutations`、`markov_expected_steps`、`cover_time_complete_graph`、
`finite_difference_derivative`、`richardson_extrapolate`（五份 live 副本同序；两份 v13 逐字节一致；
**冻结 1.2 仍是 8 个名字、SHA `d21953e2…` 未变**）。

| 工具 | 实跑 payload | 结果 |
| --- | --- | --- |
| `transition_count` | `{"length":3,"num_states":2,"transitions":[[0,1],[1,0],[1,1]]}` | 5 |
| `independence_polynomial_chain` | `{"n":5}` | `[1,6,5,1]` |
| `count_by_digit_property` | `{"digit_set":[1,2,3],"max_digits":3,"modulus":3,"residue":0,"include_zero":false}` | 13 |
| `rook_numbers` | `{"n":3,"forbidden":[[0,0],[1,1],[2,2]]}` | `[1,3,3,1]` |
| `count_avoiding_permutations` | `{"n":4,"forbidden":[[0,0],[1,1],[2,2],[3,3]]}` | 9 |
| `markov_expected_steps` | `{"transition":[[0.0,1.0,0.0],[0.5,0.0,0.5],[0.0,0.0,1.0]],"start":0,"targets":[2]}` | `4.0` |
| `cover_time_complete_graph` | `{"num_vertices":4}` | `"11/2"` |
| `finite_difference_derivative` | `{"f":"x**3","x":1.0,"h":0.01,"method":"central"}` | 3.0001… |
| `richardson_extrapolate` | `{"f":"x**3","x":1.0,"h":0.01,"method":"central","order":2}` | 2.99999… |

九个新语义路由 + 九行 `preferredMethodForToolRoute`（→ `finite-state-dp` / `counting-bijections` /
`conditioning-indicators` / `numerical-approximation`），并显式互斥：Markov 不进 `FINITE_ENUMERATION`、
cover-time 不进 `TRANSITION_COUNT`、Richardson 不被普通差分路由吃掉。

五张卡片补契约（`finite-state-dp` 4945 B、`induction-recurrence` 3795 B、`counting-bijections` 3857 B、
`conditioning-indicators` 4663 B、`numerical-approximation` 3953 B），**20 个模板从成品卡片反抽后重跑，0 失败**。

### 16.3 Stage C：闭环扩容（5 个新观察型缺陷）

`GF2_RANK_MISMATCH`、`GF2_NULLITY_MISMATCH`、`EXACT_COUNT_MISMATCH`、`COVER_TIME_MISMATCH`、
`IDENTITY_VERDICT_MISMATCH`，全部 `evidence: "OBSERVATION"`，零误报规则照旧并加测试：
概率分数（`223/8330`）绝不与整数计数比对；一句多数字/裸数字不归因；否定/模糊词丢弃；
只读候选真选中的选项；观测缺失或畸形不产缺陷。缺陷顺序固定为
`… OPTION_VERDICT_CONTRADICTION → 五个新缺陷 → SOLUTION_COMPLETENESS`。

### 16.4 Stage D：WASI 生成式 Python 沙箱在 `engine="ts"` 下受控激活

- `p3_effects.perform_effect(..., python_sandbox=None)`：只加可选关键字，行为不变。
- 新增 `generated_execution_gate.execute_with_gate(gate, sandbox, request, code, *, deadline, problem_id, scope)`：
  先问 `gate.decision(request)`，非 `"ADMITTED"` 直接拒绝且**绝不执行**；无可用沙箱 → `REFUSED_NO_PROFILE`；
  边界/identity 非法 → `REFUSED_UNBOUNDED`；执行异常/超时 → `REFUSED_EXECUTION_FAILED`；
  成功则封装 `{kind:"BOUNDED_OBSERVATION", interpretation:"BOUNDED_OBSERVATION_NOT_PROOF"}`，
  不可序列化或 >64 KiB 一律拒绝（不截断、不伪造）。
- `AgentHost` / `AgentRuntime` 新增可选 `python_sandbox_profile`（`None` 时再读 `ASTRA_WASI_PROFILE`）：
  未配置时**完全不触发文件 I/O**（用 `Path.read_bytes`/`open`/`io.open` 打桩证明事件为 0），
  `capabilities.generatedPython` 仍 `UNAVAILABLE`，Node 侧 `nodeCapabilities.wasi: "DISABLED"` 未动。
- 新增 `AgentHost.generated_exploration(request, code, *, gate, scope)` 作为**唯一**可达入口；
  P3 线上动作词表仍只有 `("tool","method")`，**没有**新增 wire action（有意为之，避免破坏冻结契约）。

### 16.5 Stage E：完整性 + 门禁（本轮实测）

- 卡片模板：**48/48 全部实跑 `status == "ok"`、0 失败、0 张卡片超限**（≤10000 B / ≤4000 chars）。
  顺带修掉 8 张卡片里 9 处畸形标题（``### `exact_check_expr（…）` `` 缺闭合反引号，导致 markdown 渲染错乱）。
- 三重 SHA：`general_v11/SOURCE.json`（12 条：8 张标题修正卡 + 5 张新契约卡，其中 1 张重叠）、
  `a2-source-lock.json`（`general_v11/SOURCE.json` pin `20dac0c1…`）、
  `asset_baseline.json`（按 `astra-asset-baseline-v1` 结构重算 12 张卡哈希），
  `verify_integrity` → **ok=True, errors=[]**。
- `tsc -b`：0
- Node：**508/508**（基线 464，+44）
- 全量 pytest：**1086 passed, 24 skipped**（基线 998，+88）
- bundle 已重建；`release/BUILD_MANIFEST.json`：**VERIFY_OK**
- `git diff --check`：clean

### 16.6 已知限制

1. **WASI 仍未接上真实 profile**：本轮只做了受控桥接与 fail-closed 默认路径；仓库里没有已验收的
   `python-3.12.0.wasm` profile，所以真实运行时仍不会执行生成式 Python。
2. **没有新增 wire action**：`generated_exploration` 只能被 Host 内部显式调用，TS 侧目前无法主动请求
   一次沙箱探索；要打通需要在 P3 动作词表里加一个受控动作（会改动冻结契约，需单独决策）。
3. **数值类算子的观测是浮点**（`finite_difference_derivative` / `richardson_extrapolate` /
   `markov_expected_steps`），闭环对它们只做"显式断言且不等"的比对，不参与精确有理数闭环。
4. **没有跑真实 API**：本轮全部是本地门禁 + 假 client，正确率口径仍是 §12.6 的旧数字。

---

## 17. 2026-10-24 受控 WASI 探索动作（Stage D 的最后一环）+ 路由覆盖实测

### 17.1 为什么还要改

§16.4 把 WASI 沙箱在 Host 侧接好了，但**线上动作词表仍只有 `("tool","method")`**，TS 循环无法主动请求
一次沙箱探索——沙箱实际上不可达。本轮补上这个受控动作，并把"默认不可用"做成硬约束。

### 17.2 新增 `{"action":"explore","code":...,"scope":...}`（默认关闭）

| 环节 | 规则 |
| --- | --- |
| 动作形状 | `code` 非空、UTF-8 ≤ 65536 字节；`scope` 1..256 码点；键集精确（多一个键即拒）；TS 与 Python 双侧同一套严格校验 |
| 能力位 | `capabilities.generatedPython` 新增 `"AVAILABLE_BOUNDED"`，**仅当 Host 真的持有可用沙箱**时才上报；默认仍是 `"UNAVAILABLE"` |
| 准入 | 必须同时满足：能力位为 `AVAILABLE_BOUNDED`、`GenerativeExecutionGate` 判定 `ADMITTED`、仍有空闲 effect id；否则返回固定码（`ACTION_NOT_ALLOWED` / `REFUSED_NO_PROFILE` / `REFUSED_PROFILE_MISMATCH` / `REFUSED_SHA_MISMATCH` / `REFUSED_UNBOUNDED`） |
| 拒绝不烧预算 | 被拒的探索**不消耗 effect id**（有测试断言 `effect_calls` 不变） |
| 观测形态 | `{kind:"BOUNDED_OBSERVATION", interpretation:"BOUNDED_OBSERVATION_NOT_PROOF", ...}`，`source: "GENERATED_OBSERVATION"`、`level: "OBSERVED"`、`checkResult: "UNKNOWN"`；**永远不能**满足 `checkerSupportsObligation`、**永远不能**成为证书 |
| 记账 | 一次被准入的探索计为一次工具类 effect（沿用 `maxEffects`/容量算术），`tool_names` 记 `generated_exploration`，新增指标 `exploration_calls` |
| 默认路径 | 无 profile 时能力位 `UNAVAILABLE`、探索动作被固定拒绝、**现有运行的输出逐字节不变** |

### 17.3 门禁

- `tsc -b`：0
- Node：**519/519**（基线 508，+11 探索动作用例）
- 聚焦 bridge：**701 passed**（基线 670，+31）
- 全量 pytest：**1117 passed, 24 skipped**（基线 1086，+31）
- bundle 已重建；`release/BUILD_MANIFEST.json`：**VERIFY_OK**（首轮 pytest 曾因 manifest 未重建而红 1 例，重建后恢复）
- `git diff --check`：clean

### 17.4 真实 API 本轮未跑成（上游故障，不是代码问题）

计划跑 12 题（`/tmp/test0-stage16.txt`：分裂域/群结构/行列式/插值/OLS/密度/定积分）验证新闭环，
但本轮所有请求都以 `INTERN_RETRY_EXHAUSTED` 结束（每次约 405 秒后失败），直接用最小请求探活也是
`HTTP 400`。因此：

- 该 run（`/tmp/astra-stage16-115`）8 题的 `unsolved` **全部是传输层失败**，`logical_model_calls=1`、
  `frames=10`、`code=None`，不能作为能力证据，也不能当作回归。
- 复跑命令与输入已固定（`sha256 6217523d5ffebbe4171c65bc3bef91df3ca3966cea1f4c9dee822354b07f9854`），
  API 恢复后可直接重跑。

### 17.5 顺带实测出的路由覆盖（这套输入的真相）

在 100 题输入上，当前 26 个算子 + 全部路由族合计命中 **24 题**（14 → 22 → 23 → 24 的演进）：

`OLS_CHECK 5`、`EXACT_TRIG_REDUCE 4`、`EXACT_LIMIT 3`、`INTERPOLATION_FIT 3`、`GROUP_STRUCTURE 2`、
`FINITE_ENUMERATION 2`、`SPLITTING_FIELD_DEGREE`/`EXACT_DENSITY_CHECK`/`EXACT_DEFINITE_INTEGRAL`/
`CIRCLE_LAPLACIAN`/`EXACT_MAXIMAL_MINORS` 各 1。

**Stage B 新增的 9 个算子（`transition_count`、`rook_numbers`、`markov_expected_steps`、
`finite_difference_derivative` 等）在这套输入上命中 0 题**——它们是竞赛/离散组合型算子，与这套
大学数学题（环论/群论/分析/概率）不重叠。这不影响正确性，但意味着：**这批算子对当前 100 题的
正确率贡献预计为 0**，要看到收益必须换一批匹配的题（离散组合/DP/随机过程）。

### 17.6 已知限制

1. **仍然没有可用的 WASI profile**：全机器找不到 `python-3.12.0.wasm`，所以 `AVAILABLE_BOUNDED`
   永远不上报，探索动作在真实运行里仍是关闭状态（代码路径已就绪、有 stub 测试覆盖）。
2. **探索观测不进闭环**：它被明确标记为不可作证，因此不会产生任何 `AnswerClosureDefect`。
3. **数值型算子（差分/外推/Markov）**只做"显式断言且不等"的比对，不参与精确有理数闭环。
4. ~~**真实 API 证据缺失一轮**~~：已补，见 §17.7（上游恢复后 12/12 候选）。

### 17.7 真实 API 复跑：一个真回归、一处修复、一组新证据

#### 17.7.1 回归（不是模型问题，是协议不匹配）

第一次复跑（`/tmp/astra-stage16-116`）12 题里 **11 题 `unsolved`**，每项只有 2 次模型调用，
`code=FIELD_VALUE`、`stage=session.solve`、`childCode=None`。定位结果：Host 的 `validate_context`
把 `messages[1].content` 当作**恰好一个 JSON 对象**解析（`_parse_inner`），而本轮新加的
`methodToolCoPrompt` 把提示散文**追加在 user JSON 之后** → 每个 post-card WORK 包都在会话层被固定拒收。
这类失败此前被压成 `FIELD_VALUE`，看不出根因（第 3 条待办：失败码细化）。

#### 17.7.2 修复

- advisory 改挂到 `messages[0]`（system），**user 消息保持纯 JSON**；advisory 内容、字数上限
  （≤600 码点）和出现时机不变。
- `apps/stdio-runtime/tests/agent-method-tool-coprompt.test.ts` 同步更新：三处断言改为读 system，
  新增 `JSON.parse(messages[1].content)` 断言 + "user 消息不含 marker" 断言，正是这次的回归护栏。

#### 17.7.3 复跑（`/tmp/astra-stage16-118`，同一 12 题、同一输入、新 key）

输入 `/tmp/test0-stage16.txt`，`sha256 6217523d5ffebbe4171c65bc3bef91df3ca3966cea1f4c9dee822354b07f9854`，
factory `real_client_factory_retry2:build_client`，`item_concurrency=4`、`max_model_calls=800`、
`api_concurrency=4`、`default_max_tokens=8192`、`model_max_attempts=1`。

| 指标 | 值 |
| --- | --- |
| 候选 | **12/12**（修复前同一套输入 1/12） |
| 模型调用合计 | 235（19–21/项） |
| 路由 / 强制 / 遵守 | **19 / 19 / 19**（`routed == forced == obeyed`，无一例外） |
| 工具类 effect | 24（method load 12 + tool 12） |
| 方法卡命中 | 24 次读卡（`algebraic-structures` 等），每项 1–2 张 |
| 复核闭环 | `closure_evaluations 12`、`closure_defects 2`、`observation_views 9`、`observation_used 2` |
| 探索动作 | `exploration_calls 0`（无 WASI profile，按设计关闭） |
| 严格参考判分 | **3/12 = 25%**（`ReferenceJudge` 只做字符串/数值精确比对，自由文本必然判错） |

工具分布：`interpolation_fit_check 3`、`stats_ols_check 3`、`exact_check_expr 3`、
`finite_group_structure 2`、`splitting_field_degree_expr 1`，全部 `status=ok`。

#### 17.7.4 人工语义审计（12 题逐条看过，供后续对标，不是平台成绩）

- **9/12 与参考一致**（多数只是 LaTeX 写法差异）：#5、#16、#21、#56、#57、#59、#88、#89、#97。
- **#4 少选**：模型只给 `D`，参考 `B, D`（`D_8` 的四阶子群也全是 Abel 的，漏了 B）。
- **#35 实质错误**：亚历山大多项式给 `t²-3t+1`，参考是 6 次多项式；工具虽被路由并执行，
  但模型没把自己的结论跟观测对齐。
- **#2 争议**：模型给 `E=Q(⁴√5,i)`、`[E:Q]=8`、"是"；参考给 `Q(⁴√5,ζ₈)`、`16`。
  已用 sympy 验证 $x^2+1$ 在 $\mathbb{Q}(\alpha)$（$\alpha^4=-5$）上不可约，故分裂域次数确为 **8**，
  **参考里的 16 是错的**；模型把域写成 $x^4-5$ 的答案，属于"次数对、域描述不严谨"。
- 结论：这一轮的价值在**管道**（12/12 候选、路由全遵守、工具全执行、闭环无假阳性），
  不在准确率；严格判分 25% 与语义 9/12 必须分开报，不能混为一谈。

#### 17.7.5 本轮门禁（复跑前）

- `tsc -b`：0
- Node（protocol + stdio-runtime）：**519/519**
- 全量 pytest：**1117 passed, 24 skipped**
- bundle 已用 esbuild 重建；`release/BUILD_MANIFEST.json`：**VERIFY_OK**（commit `71cbd4e`）
- `git diff --check`：clean

---

## 18. 2026-10-24 v5 Stage 1–5 落地记录

> 本节只记录本轮实际代码、测试与门禁，不把“已实现”写成“已提分”。
> 真实 API 复跑见 §18.6；若该项未完成，明确写“未完成”，不得用离线测试冒充。

### 18.1 Stage 1：观测到最终答案的闭环转化

- `degreeConservationDefect`（`agent-answer-closure.ts`）的 `detail` 现在携带
  `exact_check_expr[MAXIMAL_MINORS]` 的精确多项式；同次数但系数不等价（包括同次伪因子）
  会触发 `DEGREE_CONSERVATION`；`±t^k` 的 Alexander 单位移位先于次数比较处理。
- `answerClosureNote` 增加 `DEGREE_CONSERVATION` 专用提示，并要求
  `Preserve all valid CERT1|... rows in suggestedChecks`。
- `agent-loop.ts` 的闭环采纳判据改为：优先看 `evidence === "OBSERVATION"` 的缺陷数，
  只有观测缺陷数不增加时才允许总数下降，避免“证书缺陷抵消观测修复”。
- `realRootCountDefect` 不再要求同一路由；`splittingFieldDegreeDefect` 放宽为语义
  措辞或路由；`interpolationResidualDefect` 只依赖合法观测本身。

### 18.2 Stage 2：exact_check_expr 与线性方程组观测

- 新增 `EXACT_VALUE_MISMATCH`：覆盖 `LIMIT`、`DEFINITE_INTEGRAL`、`SIMPLIFY`、
  `TRIG_REDUCE` 的精确标量；支持 `pi/2`、`sqrt(2)/2`、`\frac{\pi}{2}`、
  `\frac{\sqrt{2}}{2}` 等标准写法；符号表达式/自由变量不会被强行转成标量。
- 新增 `LINEAR_SYSTEM_STATUS_MISMATCH`：核对 `EMPTY/UNIQUE/AFFINE` 状态、`rank`、
  `nullity`，并在 `UNIQUE` 时核对 `particular` 解向量（支持 `(1,-2)`、`x=1,y=-2`、
  一维 `x=2`；`f(1,2)` 这类函数调用不会被误当解向量）。

### 18.3 Stage 3：有限群子群普查

- `mathagent/finite_group_tools.py` 新增 `derived_size` 与 `subgroup_summary`
  （仅 `order <= 64`；旧 7 个字段完全保留），按阶统计 `count`、`normal_count`、
  `all_abelian`、`all_cyclic`、`has_cyclic`。
- named-group 词表新增 `V4`（`K4/K_4/V_4/klein/克莱因四元群`）与 `Q8`
  （`Q_8/quaternion/四元数群`）；`input_contracts.py` 的 named-group 描述同步更新。
  `tool-registry.json` 与方法卡正文的哈希锁定资产本轮**未改**，避免无谓的资产指纹漂移。
- 闭环新增 `finiteGroupOptionDefect`：对“所有 d 阶子群都阿贝尔/循环/正规”“存在 d 阶
  子群”、中心阶 `|Z(G)|`、换位子群阶 `|[G,G]|` 做选项级真假判断；多选题漏选真选项
  或误选假选项触发 `OPTION_VERDICT_CONTRADICTION`。
- `D_8` 回归：B（4 阶子群全 Abel）判真、D（`[D_8,D_8]` 阶 2）判真、C（`C(D_8)={1}`）
  判假；候选只给 `D` 时能指出漏选 B。

### 18.4 Stage 4：WASI explore 提示与路由

- post-card WORK 轮在满足以下全部条件时，仅向 `messages[0].content`（system）追加
  有界 `POST-METHOD EXPLORATION ADVISORY`：无固定语义工具路由、`allowExplore === true`、
  尚无 `PROGRAM_OBSERVATION`/`GENERATED_OBSERVATION`、effect 与 model call 预算仍保留
  一次后续 WorkPacket。默认 `allowExplore=false` 时完全不触发，user JSON 保持字节不变。
- 方法卡 ≥2 的提示不再写死“立即作答”：仍可执行一次工具或一次 `explore`。
- `agent-semantics.ts` 扩展：LaTeX `\int_{a}^{b}`/`\int_a^b`、`\lim_{...}`、
  Taylor/Maclaurin 展开、显式数值矩阵的秩/零度、K4/V4/Q8 命名群；混合“行列式 + 秩”
  题因需要多个观测而保持不路由，避免把 determinant 部分藏掉。
- WASI：找到 `/home/ma-user/work/wasi-local-run/profile.json` 与 accepted profile；
  `run_wasi_acceptance.py` 本轮实跑 **24 passed**，`accept_wasi_profile.py` 生成临时
  accepted profile；真实 `PythonSandbox` 冒烟 `integrate(sin(x),0,pi)` 返回 `2`。

### 18.5 Stage 5：门禁与静态扫描

- `tsc -b`：0
- Node（protocol + stdio-runtime）：**535/535**
- 全量 pytest：**1122 passed, 24 skipped**
- 方法卡 JSON 模板：**48/48** 经真实 contract/bridge 执行 `status=ok`
- `test0` 100 题静态路由：**24/100**，分布未回退：
  OLS 5、EXACT_TRIG_REDUCE 4、EXACT_LIMIT 3、INTERPOLATION_FIT 3、GROUP_STRUCTURE 2、
  FINITE_ENUMERATION 2，其余各 1；24 条路由的 `toolName` **24/24** 在 P3 白名单。
- bundle 已用 esbuild 重建；`release/BUILD_MANIFEST.json`：**VERIFY_OK**（source commit `5919e7d`）。
- `git diff --check`：clean。

### 18.6 真实 API 12 题复跑（2026-10-24 完成）

- 输入：`/tmp/test0-stage16.txt`，sha256
  `6217523d5ffebbe4171c65bc3bef91df3ca3966cea1f4c9dee822354b07f9854`；
  factory `real_client_factory_retry2:build_client`，4/4 并发，`max_model_calls=800`。
  新 key 的最小请求先返回 HTTP 200；该 key 不再有旧的 `-20080 输入 tokens 配额` 错误。
- 结果目录：`/tmp/astra-v5-stage16-pilot2`。
  **12/12 runner success、12/12 有输出、10/12 有 candidate、2 题 unsolved
  （#35、#15，均为 `FIELD_VALUE @ session.solve`）**；219 次 provider 请求、
  0 retry、0 truncated、1,964,301 tokens。
- 语义核对（ReferenceJudge 只做格式严格匹配，2/12 不是准确率）：
  - **#4（D8 多选题）已修好**：候选从旧 pilot 的 `D` 变为 **`B、D`**；
    `finite_group_structure` 被调用，`subgroup_summary` 进入 observation。
  - 其余语义正确：#4 对应 D8、A4 共轭类 4、复积分公式、插值判断、Lagrange 选项、
    Runge 端点、OLS 系数公式、非线性 OLS 判断、多重共线性 ABCD，合计 **9/12**。
  - #1 分裂域：候选 `Q(4√5,i), [E:Q]=8, 是`；参考写 16。按 §17.7.4，
    参考次数 16 本身可疑；本轮不把该题算作无条件正确，仍标“争议”。
  - **#35 没有修好**：12 题 run 中 13 次模型调用后 `FIELD_VALUE` 未产出 candidate。
    单题 8k `max_tokens` 复核（`/tmp/astra-v5-one35-log`）首轮 `finishReason=length`；
    把 `--default-max-tokens` 提到 16384 后（`/tmp/astra-v5-one35-16k`）能出 candidate，
    但答案是 **`t^4-2t^3+3t^2-2t+1`**，不是精确的
    `t^6-5t^5+10t^4-13t^3+10t^2-5t+1`。
    日志显示 `exact_check_expr[MAXIMAL_MINORS]` 确实返回了 `normalized_minors`
    （第一项就是正确 6 次式），但该工具调用发生在候选已保护之后：
    `observation_views=0`、`closure_defects=0`，后续任务 packet 虽提出
    `t^2-3t+1` 也无法替换已保护的 candidate。故 **Stage 1 的闭环代码未拿到这次
    观测**；真正缺口是“候选保护后到达的精确观测”没有触发重开候选或再跑一次闭合。
  - #15 概率题同样 `FIELD_VALUE` unsolved，不是本轮改动引入的路由失败。
- 全部 12 题的 `closure_defects` 都是 0、`observation_used` 都是 0：本轮真实 API
  只证明了 #4 能从工具 payload 直接改成 `B,D`，没有提供“缺陷驱动闭环改写候选”的正例。
  严格 ReferenceJudge 为 2/12；按语义核对为 **9/12 正确、1 题争议、2 题 unsolved**。

### 18.7 test0 路由上限（不要重复踩坑）

本轮扩充后静态命中仍是 **24/100**，不是新路由失效，而是剩余 76 题大多为
证明/概念选择/拓扑/ODE/PDE/数理统计推断，固定 26 个算子没有对应的“给定输入 →
可核对对象”。继续堆关键词只会把概念题强制送进空参数工具，违反零空参铁律。
要再提高必须**新增可核对的数据型工具**（如 ODE 通解、置信区间、线性变换矩阵），
不能继续在 `semanticToolRoute` 里加宽泛措辞。
