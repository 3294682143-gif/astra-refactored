@echo off
REM ============================================================================
REM Inkstone / Astra Scientific Multi-Agent Workbench - Windows Launcher (E16)
REM Track 160 AI4S Multi-Agent Scientific Research System
REM ============================================================================

setlocal enabledelayedexpansion

echo [Inkstone] Starting Unified Scientific Multi-Agent Workbench...
python scripts\start_services.py %*

if %ERRORLEVEL% neq 0 (
    echo [Inkstone] Exited with error code %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)

endlocal
