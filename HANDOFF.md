# 交接：把 `astra-refactored`（TS）做到"解题正确率"导向的深度重构

> 本文件写给**新上下文的执行者**。只记录本会话已核实的事实与下一步动作。
> 不要相信任何"已完成/已提分"的叙述，除非重新跑出证据。
> **状态（2026-10-21 最终校正，必须先读这一条）：**
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
> 本地门禁全绿：`tsc -b` 0、Node **334/334**、Python **718 passed /
> 24 skipped / 0 failed**、manifest `VERIFY_OK`。**改动未提交、未推送（用户要求）。**
> 正确率仍是唯一目标：97/100 候选只是把“能得分”的前置条件做到了，逐题人审
> 仍有多题答案错误（见文末“逐题口径”）。

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

预期（2026-10-21 实测）：

- `tsc -b`：0
- Node：**334/334 pass**
- Python：**718 passed, 24 skipped, 0 failed**
- manifest：`VERIFY_OK`（commit `eb36a5a`）
- `git diff --check`：clean
- 仓库内无真实 API key

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
- 逐题正确率尚未做新的全量人审；已知的旧逐题结论不能直接搬到新 run 上

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
pytest -q → 718 passed, 24 skipped, 0 failed
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
          → 334 pass, 0 fail
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

### 10.3 下一步（按性价比排序）

1. **全量逐题人审**（97 个候选）：产出新的 `正确/错误/争议` 三类清单，替代旧的
   86/91 口径。
2. 按错误族做通用闭合（不写题号、不写答案）：次数守恒、归一化、选项覆盖、
   多解完备性。每加一条都要有 e2e（假 client 即可）钉住。
3. 稳定复跑：`item/api` 并发 4/4 + **传输重试**（`real_client_factory_retry`）作为
   默认实测臂，另跑 no-retry 臂做对照；两臂都要报候选率与严格分。
4. 迭代门禁不变：`tsc -b` → esbuild → manifest `--verify` → Node 全测 → pytest 全测
   → 才允许跑真实 100 题。
