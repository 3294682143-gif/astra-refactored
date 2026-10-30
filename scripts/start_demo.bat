@echo off
rem Track160 一键演示启动（答辩态）：BFF(8011) + mock-gateway(8787) + inkstone UI(8899)
rem 用法：scripts\start_demo.bat ；无真实 key 时自动走诚实不可用路径（SOLVER_NOT_CONFIGURED），协议观测走 mock 合成并带 synthetic 标注
setlocal
set ROOT=%~dp0..
cd /d "%ROOT%"

if not defined ASTRA_DATA_ROOT set ASTRA_DATA_ROOT=%ROOT%\var\astra
if not defined ASTRA_WEB_DIST set ASTRA_WEB_DIST=%ROOT%\apps\web-demo\dist
if not defined ASTRA_PROTOCOL_SOURCE set ASTRA_PROTOCOL_SOURCE=mock
if not defined INKSTONE_GATEWAY_URL set INKSTONE_GATEWAY_URL=http://127.0.0.1:8787
if not defined INKSTONE_RE_LAB_ROOT set INKSTONE_RE_LAB_ROOT=D:\书生\inkstone-re-lab

echo [1/3] mock-gateway on 8787 (synthetic, offline protocol source)...
start "mock-gateway" /min cmd /c "node "%INKSTONE_RE_LAB_ROOT%\tools\mock-gateway.mjs" --port 8787 --host 127.0.0.1"

echo [2/3] inkstone aiyan-ui on 8899...
start "aiyan-ui" /min cmd /c "node "%INKSTONE_RE_LAB_ROOT%\tools\aiyan-ui.mjs""

echo [3/3] AI4S cockpit BFF+SPA on 8011...
python -m uvicorn python.astra_web.app:app --host 127.0.0.1 --port 8011
