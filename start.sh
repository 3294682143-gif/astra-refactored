#!/usr/bin/env bash
set -e

# Change to script directory
cd "$(dirname "$0")"

export NO_PROXY="127.0.0.1,localhost"
PORT=8000

echo "======================================================================"
echo "  天轭 (Zygos) 数学智能体工作台 · 一键启动脚本"
echo "  Astra Math Agent Workbench (V15 Release)"
echo "======================================================================"
echo ""

# 1. Detect Python
PY_EXE=""
if [ -f ".venv/bin/python" ]; then
    PY_EXE=".venv/bin/python"
    echo "[环境] 检测到项目虚拟环境: .venv/bin/python"
elif [ -f "venv/bin/python" ]; then
    PY_EXE="venv/bin/python"
    echo "[环境] 检测到项目虚拟环境: venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PY_EXE="python3"
    echo "[环境] 使用系统 Python3: $(command -v python3)"
elif command -v python >/dev/null 2>&1; then
    PY_EXE="python"
    echo "[环境] 使用系统 Python: $(command -v python)"
else
    echo "[错误] 未检测到 Python 运行环境！请先安装 Python 3.10+。"
    exit 1
fi

# 2. Check deps
if ! "$PY_EXE" -c "import starlette, uvicorn, pydantic, sympy" >/dev/null 2>&1; then
    echo "[提示] 检测到部分 Python 依赖尚未安装。"
    read -p "是否立即自动安装 requirements-web.txt？(Y/n): " ans
    if [ "$ans" != "n" ] && [ "$ans" != "N" ]; then
        "$PY_EXE" -m pip install -r requirements-web.txt
    fi
fi

echo ""
echo "======================================================================"
echo "请选择启动模式:"
echo "  [1] 模式 A：免 Key 全流程演示模式 (推荐 ⭐⭐⭐)"
echo "  [2] 模式 B：正式真实模型求解服务 (Intern-S2)"
echo "  [3] 运行进程内数学算子与候选交付验证 (demo_proof.py)"
echo "  [4] 运行核心自动化测试套件 (53 项全通验证)"
echo "  [0] 退出"
echo "======================================================================"
read -p "请输入选项数字 [直接回车默认为 1]: " choice
choice=${choice:-1}

case "$choice" in
    1)
        echo "正在启动模式 A 演示服务 (端口: $PORT) ..."
        "$PY_EXE" scripts/demo_serve.py "$PORT"
        ;;
    2)
        echo "正在启动模式 B (端口: $PORT) ..."
        echo "服务就绪后请访问: http://127.0.0.1:$PORT/solve"
        "$PY_EXE" -m uvicorn python.astra_web.app:app --host 127.0.0.1 --port "$PORT"
        ;;
    3)
        echo "正在运行进程内验证..."
        "$PY_EXE" scripts/demo_proof.py
        ;;
    4)
        echo "正在运行核心自动化测试套件..."
        "$PY_EXE" -m pytest tests/test_web_workspace_endpoints.py tests/test_web_bff.py tests/test_web_solver_adapter.py tests/test_web_public_chat_port.py -v
        ;;
    0)
        exit 0
        ;;
    *)
        echo "输入无效。"
        exit 1
        ;;
esac
