@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 天轭 (Zygos) 数学智能体工作台
cd /d "%~dp0"

set "NO_PROXY=127.0.0.1,localhost"
set "PORT=8000"

echo ======================================================================
echo   天轭 (Zygos) 数学智能体工作台 · 一键启动
echo   Astra Math Agent Workbench (V15 Release)
echo ======================================================================
echo.

:: 1. 检测 Python 解释器
set "PY_EXE="
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PY_EXE=%~dp0.venv\Scripts\python.exe"
    echo [环境] 检测到项目虚拟环境: .venv\Scripts\python.exe
) else if exist "%~dp0venv\Scripts\python.exe" (
    set "PY_EXE=%~dp0venv\Scripts\python.exe"
    echo [环境] 检测到虚拟环境: venv\Scripts\python.exe
) else (
    where python >nul 2>nul
    if !errorlevel! equ 0 (
        set "PY_EXE=python"
        echo [环境] 使用系统 PATH 中的 Python
    ) else (
        where py >nul 2>nul
        if !errorlevel! equ 0 (
            set "PY_EXE=py"
            echo [环境] 使用 Python 启动器 py
        )
    )
)

if "%PY_EXE%"=="" (
    echo [错误] 未在系统或目录中检测到 Python！
    echo 请先安装 Python 3.10 或更高版本，并在安装时勾选 Add Python to PATH。
    echo 安装完成后请重新运行本脚本。
    echo.
    pause
    exit /b 1
)

:: 2. 检查依赖包
"%PY_EXE%" -c "import starlette, uvicorn, pydantic, sympy" >nul 2>nul
if errorlevel 1 (
    echo.
    echo [提示] 检测到部分 Python 依赖尚未安装。
    set /p INSTALL_DEP="是否立即自动安装 requirements-web.txt？[Y/n]: "
    if /i not "!INSTALL_DEP!"=="n" (
        echo 正在安装依赖包，请稍候...
        "%PY_EXE%" -m pip install -r requirements-web.txt
        if errorlevel 1 (
            echo [警告] 依赖包安装失败，请检查网络或配置代理后手动执行: pip install -r requirements-web.txt
            pause
        )
    )
)

:: 3. 检查 Node.js 环境
where node >nul 2>nul
if errorlevel 1 (
    echo [提示] 未检测到 Node.js。若需运行完整 TS 推导引擎与工具链，建议安装 Node.js 18+。
)

:: 4. 检查端口占用
set "OCCUPIED_PID="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r /c:":%PORT% .*LISTENING"') do set "OCCUPIED_PID=%%a"
if not defined OCCUPIED_PID goto PORT_OK

echo.
echo [提示] 端口 %PORT% 当前被进程 !OCCUPIED_PID! 占用。
echo [1] 自动终止该进程并释放端口 %PORT% - 推荐，直接回车即选此项
echo [2] 改用 8080 端口启动
echo [3] 忽略并继续
set /p PORT_CHOICE="请选择处理方式 [默认 1]: "
if "!PORT_CHOICE!"=="2" (
    set "PORT=8080"
    goto PORT_OK
)
if "!PORT_CHOICE!"=="3" goto PORT_OK
taskkill /F /PID !OCCUPIED_PID! >nul 2>nul
echo 已释放端口 %PORT%。
ping -n 2 127.0.0.1 >nul

:PORT_OK
:MENU
echo.
echo ======================================================================
echo 请选择启动模式:
echo.
echo   [1] 模式 A：免 Key 全流程演示模式 - 推荐，评委答辩与复现首选
echo       - 零配置、免 API Key
echo       - 真实调用本地数学算子，图谱/审查/修复闭环
echo       - 严格恪守 candidate_verified: false 诚实交付准则
echo.
echo   [2] 模式 B：正式真实模型求解服务 - Intern-S2-Preview
echo       - 启动标准 BFF 服务，支持在浏览器设置界面填入 API Key
echo       - 或通过环境变量 ASTRA_S2_API_KEY 运行
echo.
echo   [3] 运行进程内数学算子与候选交付验证 - demo_proof.py
echo       - 纯控制台进程内直跑，当场打印数学资产证据与终态卡片
echo.
echo   [4] 运行核心自动化测试套件 - 53 项全通验证
echo.
echo   [0] 退出
echo ======================================================================
set "CHOICE="
set /p CHOICE="请输入选项数字 [直接回车默认为 1]: "

if "%CHOICE%"=="" set "CHOICE=1"
if "%CHOICE%"=="1" goto MODE_A
if "%CHOICE%"=="2" goto MODE_B
if "%CHOICE%"=="3" goto RUN_PROOF
if "%CHOICE%"=="4" goto RUN_TESTS
if "%CHOICE%"=="0" exit /b 0

echo 输入无效，请重新选择。
goto MENU

:MODE_A
echo.
echo 正在启动模式 A 演示服务 [端口: %PORT%] ...
"%PY_EXE%" scripts\demo_serve.py %PORT%
if errorlevel 1 (
    echo 尝试前台模式启动...
    "%PY_EXE%" scripts\web_demo_server.py --port %PORT% --drop-events-after 9999
)
goto END

:MODE_B
echo.
echo 正在启动模式 B [正式大模型求解服务，端口: %PORT%] ...
echo 提示：服务启动后，可在浏览器右上角设置中配置 Intern-S2 API Key。
start http://127.0.0.1:%PORT%/solve
"%PY_EXE%" -m uvicorn python.astra_web.app:app --host 127.0.0.1 --port %PORT%
goto END

:RUN_PROOF
echo.
echo 正在运行进程内数学算子与证据交付验证...
"%PY_EXE%" scripts\demo_proof.py
echo.
pause
goto MENU

:RUN_TESTS
echo.
echo 正在运行核心自动化测试套件...
"%PY_EXE%" -m pytest tests/test_web_workspace_endpoints.py tests/test_web_bff.py tests/test_web_solver_adapter.py tests/test_web_public_chat_port.py -v
echo.
pause
goto MENU

:END
echo.
pause
