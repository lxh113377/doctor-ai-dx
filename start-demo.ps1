# ============================================================
# 医 · AI 辅助诊断 —— 一键演示启动包（Windows / PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -File start-demo.ps1
# 效果：起后端(8000) + 生产静态托管(5173) + 自动打开浏览器
# ============================================================
$Root = $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Url = "http://localhost:5173"
$hdr = @{ "Content-Type" = "application/json" }

Write-Host "=== 医 · AI 辅助诊断 演示启动 ===" -ForegroundColor Cyan

# 1) 后端健康检查/自启
$bk = $null
try { $bk = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 3 } catch {}
if ($bk) {
    Write-Host "[1/3] 后端已在运行 (mode: $($bk.llm_mode))" -ForegroundColor Green
} else {
    Write-Host "[1/3] 启动后端 ..." -ForegroundColor Yellow
    $job = Start-Process -FilePath "python" -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000") `
        -WorkingDirectory $Backend -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 4
    try { $bk = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 5 }
    catch { Write-Host "后端启动失败：$($_.Exception.Message)" -ForegroundColor Red; exit 1 }
    Write-Host "[1/3] 后端已启动 (mode: $($bk.llm_mode))" -ForegroundColor Green
}

# 2) 前端静态托管（dist 已构建；如缺则先 build）
if (-not (Test-Path (Join-Path $Frontend "dist\index.html"))) {
    Write-Host "[2/3] 构建前端 dist ..." -ForegroundColor Yellow
    Push-Location $Frontend
    & npm run build | Out-Null
    Pop-Location
}
$fe = $null
try { $fe = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -UseBasicParsing } catch {}
if ($fe) {
    Write-Host "[2/3] 前端已在运行" -ForegroundColor Green
} else {
    Write-Host "[2/3] 启动前端静态服务 (vite preview) ..." -ForegroundColor Yellow
    $feJob = Start-Process -FilePath "npm" -ArgumentList @("run", "preview", "--", "--port", "5173", "--strictPort") `
        -WorkingDirectory $Frontend -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 4
    try { $fe = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -UseBasicParsing } catch {}
    if (-not $fe) { Write-Host "前端启动失败（可先 npm install）" -ForegroundColor Red; exit 1 }
    Write-Host "[2/3] 前端已启动" -ForegroundColor Green
}

# 3) 链路自检
try {
    $cases = Invoke-RestMethod -Uri "$Url/api/cases" -TimeoutSec 6
    Write-Host "[3/3] API 链路 OK（$($cases.data.Count) 个病例可用）" -ForegroundColor Green
} catch {
    Write-Host "[3/3] 警告：API 链路异常 - $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "演示地址：$Url  （推荐演示病例：张建国 · 胸痛红旗流程）" -ForegroundColor White
Write-Host "退出演示：关闭后端/前端进程窗口即可；或执行 Stop-Process -Name python,npm" -ForegroundColor DarkGray
Start-Process $Url