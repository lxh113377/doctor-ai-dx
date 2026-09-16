# ============================================================
# 医 · 基层AI辅助诊断系统 —— 一键演示启动包（Windows / PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -File start-demo.ps1
# 架构：Cloudflare Pages Functions 为唯一后端权威源（与线上同一份代码）
#       本地用 wrangler pages dev 同时托管 dist 静态站 + functions API，零漂移
# ============================================================
$Root = $PSScriptRoot
$Frontend = Join-Path $Root "frontend"
$Url = "http://127.0.0.1:8788"

Write-Host "=== 医 · 基层AI辅助诊断系统 演示启动 ===" -ForegroundColor Cyan

# 1) 依赖
if (-not (Test-Path (Join-Path $Frontend "node_modules\wrangler"))) {
    Write-Host "[1/3] 安装依赖 ..." -ForegroundColor Yellow
    Push-Location $Frontend
    & npm install
    Pop-Location
}

# 2) 构建前端 dist（含 functions/ 后端）
Write-Host "[2/3] 构建前端 dist ..." -ForegroundColor Yellow
Push-Location $Frontend
& npm run build
Pop-Location

# 3) 启动本地 Pages（静态 + Functions 一体化，与线上同源）
Write-Host "[3/3] 启动本地服务（wrangler pages dev）..." -ForegroundColor Yellow
Write-Host ""
Write-Host "演示地址：$Url  （推荐演示病例：张建国 · 胸痛红旗全流程）" -ForegroundColor White
Write-Host "无 DeepSeek Key 时自动进入【规则引擎降级模式】并在界面明确标注，功能完整可演示。" -ForegroundColor DarkGray
Write-Host "退出：Ctrl+C" -ForegroundColor DarkGray
Write-Host ""
Push-Location $Frontend
& node node_modules/wrangler/bin/wrangler.js pages dev dist --port 8788 --local
Pop-Location
