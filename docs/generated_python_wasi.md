# 显式WASI生成式Python后端

这是本机实测的强隔离配置，不是普通Python子进程或AST过滤。正式平台接受状态仍为false。

受信配置资产包括宿主Python、Wasmtime 48.0.0、固定CPython WASM及预编译模块、只读库。模型仅提供最长64 KiB的Python源码；源码只交给WASI解释器，绝不由宿主`exec`执行。受信资产或配置被同用户/管理员篡改不属于guest隔离能保证的威胁模型；运行前文件pin用于检测变化。

默认`PythonSandbox()`仍不可用。明确启用：

```python
import time
from mathagent.tools import PythonSandbox

sandbox = PythonSandbox(profile="/explicit/accepted-profile.json")
result = sandbox.execute(
    "import math; print(math.comb(13, 6))",
    deadline=time.monotonic() + 30,
    problem_id="owned-problem",
    scope="finite integer calculation",
)
```

求解入口可传`ReasoningAgent(..., python_sandbox_profile=...)`。Controller只在配置可用时暴露提案说明；提案必须经过R3且没有缺失/未解决报告才执行。配置身份进入同轮版本与恢复绑定；开始执行但未提交回执的探索不重放。原额度、截止和once不因启用Python重置。

整套本地runner支持`--python-sandbox-profile`，manifest记录profile身份，派发前再次校验；共享协调器与每个ReasoningAgent采用同一绑定。这个选项不替代F12/F13门禁。真实整套执行也必须有非空的历史账本清单及明确公共model身份。

配置生成顺序：

1. 在目标安装环境运行`build_wasi_profile.py`，明确指定runtime、libraries、专用宿主Python、Wasmtime包及可信预编译模块。生成的配置未被接受。
2. 用`test_wasi_actual.py`对该配置运行24项实际门禁；`for_validation=True`仅用于明确的验收设施，生产入口不接受待验配置。
3. `accept_wasi_profile.py`检查实际门禁XML与当前文件pin，另写本机接受配置。配置不能直接搬到另一个安装位置；应在目标位置重建并重跑。

预编译仅针对可信解释器资产，由`compile_wasi_runtime.py`校验原WASM哈希后完成。Wasmtime序列化模块不能来自模型或不可信提交；编译版本/CPU发生变化应重新准备资产及验收。

实际profile：guest内存512 MiB，宿主虚拟地址空间1 GiB，30秒CPU/墙钟、64 KiB输出、单文件1 MiB以及额外目录数量/体积监控。WASI能力与guest内存限制由运行时强制；CPU/独立墙钟由OS强制。目录监控是额外资源保护，不冒充精确聚合磁盘配额。

只开放CPython WASI标准库、SymPy 1.12和mpmath 1.3.0；不开放NumPy/SciPy、本机扩展、网络、安装、系统命令、宿主文件或跨题数据。数据目录按调用隔离并回收，不提供跨调用文件持久化。

执行成功仍只有`BOUNDED_OBSERVATION`。打印“VERIFIED”、证书字符串或退出码0不具有数学晋升权；原题映射、见证、反例和证明仍须经过独立绑定检查。
