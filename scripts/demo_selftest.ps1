# Demo self-test (run this in a PLAIN PowerShell, NOT inside the DSH sandbox).
# Starts the mode-A demo server, submits the GF(2) case over HTTP, waits for the
# terminal result, and prints whether the server process stayed alive.
# Usage:  powershell -ExecutionPolicy Bypass -File .\scripts\demo_selftest.ps1
param(
    [int]$Port = 8014,
    [int]$TimeoutSec = 40
)
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$Py = Join-Path $Repo ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) { Write-Host "!! venv python not found at $Py" -ForegroundColor Red; exit 2 }
$log = Join-Path $env:TEMP "demo_selftest_$Port.log"
$err = Join-Path $env:TEMP "demo_selftest_$Port.err"
Remove-Item $log,$err -ErrorAction SilentlyContinue
Write-Host "== starting demo server on port $Port ==" -ForegroundColor Cyan
$env:ASTRA_DEBUG_TRACEBACK = "1"; $env:PYTHONUNBUFFERED = "1"
$proc = Start-Process -FilePath $Py -ArgumentList "scripts\web_demo_server.py","--port",$Port,"--drop-events-after","9999" -WorkingDirectory $Repo -PassThru -RedirectStandardOutput $log -RedirectStandardError $err
Write-Host "server pid = $($proc.Id)"
$base = "http://127.0.0.1:$Port"
$ok = $false
for ($i=0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try { $h = Invoke-RestMethod "$base/api/health" -TimeoutSec 3; if ($h.status -eq "ok") { $ok=$true; break } } catch {}
}
if (-not $ok) { Write-Host "!! server did not become healthy" -ForegroundColor Red; if(Test-Path $err){Get-Content $err -Tail 20}; exit 2 }
Write-Host "health OK (solver_configured=$($h.execution.solver_configured))"
Write-Host "== submitting GF(2) run ==" -ForegroundColor Cyan
$body = @{ problem = "已知线性系统方程 Ax=b，求 GF(2) 秩及通解，并验证齐次空间正交基。" } | ConvertTo-Json
$run = Invoke-RestMethod "$base/api/runs" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 15
$rid = $run.run_id; Write-Host "run_id = $rid"
$final = $null; $serverDead = $false
for ($i=0; $i -lt $TimeoutSec; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) { $serverDead = $true; Write-Host "!! server process EXITED at ~${i}s" -ForegroundColor Red }
    try { $r = Invoke-RestMethod "$base/api/runs/$rid" -TimeoutSec 3; if ($r.status -in @("completed","failed","unsolved","error","candidate")) { $final = $r; break } } catch { if ($serverDead) { break } }
}
Write-Host ""
Write-Host "==================== VERDICT ====================" -ForegroundColor Yellow
if ($final) {
    $s = $final.summary
    Write-Host ("status        : {0}" -f $final.status)
    Write-Host ("stopReason    : {0}" -f $s.stopReason)
    Write-Host ("code          : {0}" -f $s.code)
    Write-Host ("final_response: {0}" -f $s.final_response)
    Write-Host ("candidate_verified: {0}" -f $s.candidate_verified)
    if ($final.status -eq "candidate" -or $s.stopReason -eq "REVIEWS_COMPLETE") {
        Write-Host ">>> PASS: delivered a CANDIDATE (candidate_verified=false). Clean-terminal hypothesis CONFIRMED." -ForegroundColor Green
    } else {
        Write-Host ">>> FAIL: ended without candidate (code=$($s.code)). This terminal ALSO reproduces the bug." -ForegroundColor Red
    }
} else { Write-Host ">>> INCONCLUSIVE: no terminal result read (server may have died)." -ForegroundColor Red }
Write-Host ("server_process_exited_during_run: {0}" -f $serverDead)
Write-Host "================================================="
try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force } } catch {}
Write-Host "stderr tail:"; if (Test-Path $err) { Get-Content $err -Tail 15 }
