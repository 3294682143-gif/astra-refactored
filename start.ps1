# ======================================================================
#   天轭 (Zygos) 数学智能体工作台 · 一键启动脚本 (PowerShell 版)
#   Astra Math Agent Workbench (V15 Release)
# ======================================================================

$ErrorActionPreference = "Stop"
$env:NO_PROXY = "127.0.0.1,localhost"
$port = 8000
$root = $PSScriptRoot

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  天轭 (Zygos) 数学智能体工作台 · 一键启动" -ForegroundColor Green
Write-Host "  Astra Math Agent Workbench (V15 Release)" -ForegroundColor Gray
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. 查找 Python 解释器
$pyExe = $null
$candidates = @(
    Join-Path $root ".venv\Scripts\python.exe",
    Join-Path $root "venv\Scripts\python.exe",
    Join-Path $root ".venv/bin/python",
    Join-Path $root "venv/bin/python"
)

foreach ($c in $candidates) {
    if (Test-Path $c) {
        $pyExe = $c
        Write-Host "[环境] 检测到项目虚拟环境: $pyExe" -ForegroundColor Green
        break
    }
}

if (-not $pyExe) {
    $sysPy = Get-Command "python" -ErrorAction SilentlyContinue
    if ($sysPy) {
        $pyExe = $sysPy.Source
        Write-Host "[环境] 使用系统 PATH 中的 Python: $pyExe" -ForegroundColor Green
    } else {
        $sysPyLauncher = Get-Command "py" -ErrorAction SilentlyContinue
        if ($sysPyLauncher) {
            $pyExe = "py"
            Write-Host "[环境] 使用 Python 启动器: py" -ForegroundColor Green
        }
    }
}

if (-not $pyExe) {
    Write-Host "[错误] 未检测到 Python 运行环境！请先安装 Python 3.10+。" -ForegroundColor Red
    pause
    exit 1
}

# 2. 检查关键依赖
try {
    & $pyExe -c "import starlette, uvicorn, pydantic, sympy" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Missing deps" }
} catch {
    Write-Host ""
    Write-Host "[提示] 检测到部分 Python 依赖尚未安装。" -ForegroundColor Yellow
    $ans = Read-Host "是否立即自动安装 requirements-web.txt？(Y/n)"
    if ($ans -ne "n" -and $ans -ne "N") {
        Write-Host "正在安装依赖，请稍候..." -ForegroundColor Cyan
        & $pyExe -m pip install -r (Join-Path $root "requirements-web.txt")
    }
}

# 3. 检查端口占用
$conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($conn) {
    $occupiedPid = $conn[0].OwningProcess
    Write-Host ""
    Write-Host "[提示] 端口 $port 当前被 PID=$occupiedPid 占用。" -ForegroundColor Yellow
    Write-Host "[1] 自动终止该进程并释放端口 $port (推荐)"
    Write-Host "[2] 改用 8080 端口"
    Write-Host "[3] 忽略并继续"
    $pChoice = Read-Host "请选择处理方式 (默认 1)"
    if ($pChoice -eq "2") {
        $port = 8080
    } elseif ($pChoice -eq "3") {
        # continue
    } else {
        Stop-Process -Id $occupiedPid -Force -ErrorAction SilentlyContinue
        Write-Host "已释放端口 $port。" -ForegroundColor Green
        Start-Sleep -Seconds 1
    }
}

function Show-Menu {
    Write-Host ""
    Write-Host "======================================================================" -ForegroundColor Cyan
    Write-Host "请选择启动模式:" -ForegroundColor Yellow
    Write-Host "  [1] 模式 A：免 Key 全流程演示模式 (推荐 ⭐⭐⭐)" -ForegroundColor White
    Write-Host "      - 零配置、免 API Key，评委答辩与复现首选" -ForegroundColor Gray
    Write-Host "      - 真实调用本地数学算子 (如 GF(2) 秩求解)，图谱/审查/修复闭环" -ForegroundColor Gray
    Write-Host "      - 严格恪守 candidate_verified: false 诚实交付" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  [2] 模式 B：正式真实模型求解服务 (Intern-S2-Preview)" -ForegroundColor White
    Write-Host "      - 启动标准 BFF 服务，支持在浏览器「设置」界面填入 API Key" -ForegroundColor Gray
    Write-Host "      - 或通过环境变量 ASTRA_S2_API_KEY 运行" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  [3] 运行进程内数学算子与候选交付验证 (demo_proof.py)" -ForegroundColor White
    Write-Host "      - 纯控制台单进程直跑，当场打印数学资产证据与终态卡片" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  [4] 运行核心自动化测试套件 (53 项全通验证)" -ForegroundColor White
    Write-Host ""
    Write-Host "  [0] 退出" -ForegroundColor White
    Write-Host "======================================================================" -ForegroundColor Cyan
}

while ($true) {
    Show-Menu
    $choice = Read-Host "请输入选项数字 [直接回车默认为 1]"
    if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "1" }

    switch ($choice) {
        "1" {
            Write-Host "正在启动模式 A 演示服务 (端口: $port) ..." -ForegroundColor Cyan
            & $pyExe (Join-Path $root "scripts/demo_serve.py") $port
            exit 0
        }
        "2" {
            Write-Host "正在启动模式 B (正式大模型求解服务，端口: $port) ..." -ForegroundColor Cyan
            Write-Host "提示：服务启动后，可在浏览器右上角「设置」中配置 Intern-S2 API Key。" -ForegroundColor Yellow
            Start-Process "http://127.0.0.1:$port/solve"
            & $pyExe -m uvicorn python.astra_web.app:app --host 127.0.0.1 --port $port
            exit 0
        }
        "3" {
            Write-Host "正在运行进程内数学算子与证据交付验证..." -ForegroundColor Cyan
            & $pyExe (Join-Path $root "scripts/demo_proof.py")
        }
        "4" {
            Write-Host "正在运行核心自动化测试套件..." -ForegroundColor Cyan
            & $pyExe -m pytest (Join-Path $root "tests/test_web_workspace_endpoints.py") `
                              (Join-Path $root "tests/test_web_bff.py") `
                              (Join-Path $root "tests/test_web_solver_adapter.py") `
                              (Join-Path $root "tests/test_web_public_chat_port.py") -v
        }
        "0" {
            exit 0
        }
        Default {
            Write-Host "输入无效，请重新选择。" -ForegroundColor Red
        }
    }
}
