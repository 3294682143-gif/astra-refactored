# 14 · 凭据卫生与轮换状态（Credential Hygiene & Rotation Status）

> 本文只记录**事实与待办**，不含任何明文凭据。所有命中一律以
> `<MASKED len=… sha256=…>` 掩码 + 值指纹呈现，便于核验轮换是否生效而不披露值。

**结论（一句话）**：代码侧的凭据卫生已收口——工作树 0 明文命中、历史残留已移出版本控制、并新增回归门禁脚本；但**服务端轮换尚未完成**，且 `.git/config` 中另有一处**仍然存活**的 GitHub PAT，二者都必须由人工动作处置，**代码侧无法替代**。

---

## 1. 状态总览

| 项目 | 状态 | 处置 |
| --- | --- | --- |
| 工作树明文凭据 | 0 命中 | 回归门禁 `scripts/secret_scan.py`（退出码 0） |
| 历史残留 `MODELARTS_API_KEY` | 已移出版本控制；历史不可改写 | 提交 `8222b6c`；**待人工轮换** |
| `.git/config` remote 内嵌 GitHub PAT | **仍然存活** | **待人工轮换**，之后执行 §5-A |
| 回归护栏 | 已就位 | 门禁 + 检出能力自证（注入假样本必报命中） |

扫描口径：工作树 1472 个文件（跳过 1 个 >5 MiB 容器，见 §7）、172 个提交（`git rev-list --all`）、1 个 remote URL key。

---

## 2. 历史残留（已进入公开历史）——`MODELARTS_API_KEY`

- 泄漏形态（掩码）：`API_KEY = "<MASKED len=86 sha256=2b31aac19370>"`
- 命中提交（4 个，`git rev-list --all`）：`2cfe091`、`544cbae`、`7aad248`、`852b62e`
- 命中文件（5 个）：`scripts/dispatch_d00.py` 至 `scripts/dispatch_d04.py`（均在各自文件第 6 行）
- 引入提交：`2cfe091`；移除提交：`8222b6c`
- 值长度 86，指纹前 12 位 `2b31aac19370`；四个提交中指纹一致，说明是**同一把 key**
- 该仓库为**公开可读**（`origin` 指向 GitHub），因此这把 key 必须视为**已公开泄漏**

> `HANDOFF.md` 仅出现变量名（`INTERN_API_KEY` / `INTERN_ENDPOINT`），**无明文值**；扫描对其无命中。

---

## 3. 已完成的处置

1. **改为读环境变量**：本地工作副本 `scripts/dispatch_d00.py` 至 `scripts/dispatch_d04.py` 第 7 行改为从环境变量 `MODELARTS_API_KEY` 读取（`os.environ.get(...)`，未设置时直接 `SystemExit`），不再回落硬编码。
2. **移出版本控制**：提交 `8222b6c`（`fix(secrets): read dispatch key from env and stop tracking dispatch scripts`）删除了 5 个脚本的**已跟踪**副本，并在 `.gitignore` 增加规则：

```
scripts/dispatch_d*.py
```

3. **现行核验（实测）**：
   - `git ls-files -- scripts/dispatch_*.py` → 输出为空（不再跟踪）
   - `git check-ignore -v scripts/dispatch_d00.py` → `.gitignore:22:scripts/dispatch_d*.py	scripts/dispatch_d00.py`
   - 上述 5 个脚本的本地副本仍在工作树中，但受 `.gitignore` 保护，不入库。

---

## 4. 当前仍然存活的本地暴露面——`.git/config` remote 内嵌 PAT

- 位置：`astra-refactored/.git/config` 的 `remote.origin.url`；**fetch 与 push 两条 URL 均内嵌该 PAT**
- 组织/仓库：`3294682143-gif/astra-refactored`
- 掩码形态（为免扫描器把掩码占位符本身误判成 URL 凭据，此处把 URL 拆开书写）：
  `https://` + `<MASKED len=40 sha256=457f7c648497>` + `@github.com/3294682143-gif/astra-refactored.git`
- **不在版本控制**：`.git/config` 不入库，因此工作树扫描与历史扫描都看不到它；本次由新增的 repository-metadata 类别发现
- 历史扫描对 `ghp_` / `github_pat_` **无任何命中**，说明该 PAT 未曾进入提交历史
- 暴露向量：**OneDrive 同步目录中的本地文件**（本工作副本位于 OneDrive 同步路径下），以及可能落入其他 agent 的会话记录
- 与 §2 的级别差异：§2 是**已公开**的历史泄漏；本节是**本地暴露面**——只要本地文件被同步、备份或共享，即可被第三方读取

**为什么本轮不直接剥掉 userinfo（队长裁定，记录备查）**：剥掉后立即失去唯一可用的推送凭据，而本轮修复最终需要推送交付。**正确顺序是「先轮换、后剥离」**——服务端让旧值失效才是真修复，剥本地只是事后卫生。

---

## 5. 仍未完成的人工动作

> **吊销/轮换是人工动作，代码侧无法替代。** 下表 M1、M2 必须在人工侧完成。

| # | 动作 | 责任 | 完成判据 |
| --- | --- | --- | --- |
| M1 | 在服务端**吊销**旧 `MODELARTS_API_KEY`（华为云 ModelArts / MaaS）并签发新 key | 人工 | 旧 key 调用返回鉴权失败 |
| M2 | 在 GitHub 设置中**吊销/重新生成**该 PAT（Settings → Developer settings → Personal access tokens） | 人工 | 旧 PAT 无法再 push；用旧值 `git ls-remote` 失败 |
| M3 | 轮换后执行 §5-A，并把 `--strict-remotes` 设为默认门禁 | 人工 + 代码 | remote 干净时门禁退出码 0 |

### §5-A 轮换之后的一次性命令（**现在不要执行**）

```bash
# 1) 剥离 remote URL 中的 userinfo（凭据改由 credential helper 提供）
git -C astra-refactored remote set-url origin \
  https://github.com/3294682143-gif/astra-refactored.git

# 2) 配置凭据助手（示例：Windows 凭据管理器；按本机环境替换）
git -C astra-refactored config --local credential.helper manager

# 3) 验证：remote URL 不再含 userinfo；门禁在 strict 模式下通过
git -C astra-refactored remote -v
python astra-refactored/scripts/secret_scan.py --strict-remotes   # 期望 exit 0
```

> `--strict-remotes` 已实现并可用，但**当前不设为默认**：在 M2 完成前，它会因一个已知且尚未轮换的条件持续 FAIL，那属于**假失败**（用一个不可能通过的门禁掩盖真实状态）。M2 完成后再将其设为默认。

---

## 6. 回归护栏：`scripts/secret_scan.py`

检测形态：命名赋值长串（`API_KEY = "…"`、`client_secret:`、`password` 等）、`ghp_`/`gho_`/`ghs_`/`github_pat_`、`sk-`/`sk-ant-`、`AKIA`、长 `Bearer` 串、以及 URL userinfo 内嵌凭据。

退出码（门禁语义）：

| 退出码 | 含义 |
| --- | --- |
| `0` | 工作树干净（历史命中与 repository-metadata 命中**只报告**，不改退出码） |
| `1` | 工作树命中 >= 1 → 门禁失败；加 `--strict-remotes` 时 metadata 命中同样失败 |
| `2` | 用法/环境错误（不是凭据判定） |

常用命令：

```bash
python scripts/secret_scan.py                 # 工作树 + 全历史 + remote URL
python scripts/secret_scan.py --no-history
python scripts/secret_scan.py --no-remotes
python scripts/secret_scan.py --strict-remotes
python scripts/secret_scan.py --json
python scripts/secret_scan.py --self-test     # 检出能力自证
```

---

## 7. 覆盖范围与局限（诚实边界）

- `node_modules/`、`dist/`、`build/` 等目录默认跳过（`--include-vendored` 可纳入）。
- `.git/` 默认跳过；remote 凭据由 repository-metadata 类别单独覆盖。
- **>5 MiB 的文件被跳过，并在报告中逐条列出**（当前 1 个：`tests/web_review/baseline_db33c29.zip`，9.78 MB）。**归档容器内部成员不会被检查**，这是已知盲区。
- 历史扫描用 `git grep -E` 只做候选筛选，最终以 Python 判据复核，避免 ERE 过宽造成假命中。
- 扫描**不能替代轮换**：即使工作树 0 命中，只要服务端旧凭据仍然有效，风险依然存在。
- 掩码为 `<MASKED len=… sha256=…>`：**核验轮换是否生效**的方式是重跑扫描，确认对应指纹不再出现。

---

## 8. 复现（实测命令与原始输出）

```
$ python astra-refactored/scripts/secret_scan.py
repo: <workspace>/astra-refactored
worktree scan: 1472 files scanned, 1 skipped
[SKIPPED] <workspace>/astra-refactored/tests/web_review/baseline_db33c29.zip (size=9778279)
history scan: 172 commits scanned
repository-metadata scan: 1 remote key(s) checked
[HISTORY] 852b62e scripts/dispatch_d00.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 852b62e scripts/dispatch_d01.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 852b62e scripts/dispatch_d02.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 852b62e scripts/dispatch_d03.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 852b62e scripts/dispatch_d04.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 7aad248 scripts/dispatch_d00.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 7aad248 scripts/dispatch_d01.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 7aad248 scripts/dispatch_d02.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 7aad248 scripts/dispatch_d03.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 7aad248 scripts/dispatch_d04.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 544cbae scripts/dispatch_d00.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 544cbae scripts/dispatch_d01.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 544cbae scripts/dispatch_d02.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 544cbae scripts/dispatch_d03.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 544cbae scripts/dispatch_d04.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 2cfe091 scripts/dispatch_d00.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 2cfe091 scripts/dispatch_d01.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 2cfe091 scripts/dispatch_d02.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 2cfe091 scripts/dispatch_d03.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[HISTORY] 2cfe091 scripts/dispatch_d04.py:6 [named-assignment] API_KEY = "<MASKED len=86 sha256=2b31aac19370>"
[REPO-METADATA] .git/config remote.origin.url [github-pat,url-userinfo] https://<MASKED len=40 sha256=457f7c648497>@github.com/3294682143-gif/astra-refactored.git
!! repository metadata carries credential material: rotate it and strip the userinfo from the remote URL (manual action; see docs/web/14-credential-status.md)
working-tree hits: 0
history hits: 20 (historical residue, informational only; see docs/web/14-credential-status.md)
repository-metadata hits: 1 (advisory)
gate: PASS
$ echo $?
0

$ python astra-refactored/scripts/secret_scan.py --self-test
SELF-TEST PASS: fixture gate fails, clean tree passes, values masked
$ echo $?
0

$ python astra-refactored/scripts/secret_scan.py --strict-remotes --no-history
...
repository-metadata hits: 1 (gating)
gate: FAIL
$ echo $?
1

$ git -C astra-refactored check-ignore -v scripts/dispatch_d00.py
.gitignore:22:scripts/dispatch_d*.py	scripts/dispatch_d00.py

$ git -C astra-refactored ls-files -- scripts/dispatch_*.py
(no output)
```

---

## 9. 变更记录

| 日期 | 变更 |
| --- | --- |
| 本轮 | 新增 `scripts/secret_scan.py` 与本文；发现并记录 `.git/config` remote userinfo 暴露面；工作树扫描归零 |

相关文件：`scripts/secret_scan.py`、`.gitignore`、`scripts/dispatch_d00.py` 至 `scripts/dispatch_d04.py`、提交 `8222b6c`。