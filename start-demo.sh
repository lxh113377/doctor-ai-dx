#!/usr/bin/env bash
# ============================================================
# 医 · 基层AI辅助诊断系统 —— 一键演示启动（跨平台：Linux / macOS / Windows Git Bash）
# 用法：./start-demo.sh
# 与 start-demo.ps1 同一口径：Pages Functions 为唯一后端权威源，
# wrangler pages dev 同时托管 dist 静态站 + functions API，与线上零漂移。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$ROOT/frontend"
URL="http://127.0.0.1:8788"

echo "=== 医 · 基层AI辅助诊断系统 演示启动 ==="

command -v node >/dev/null 2>&1 || { echo "缺少 node（需 Node 22+）"; exit 1; }
[ -d "$FRONTEND" ] || { echo "未找到 frontend/，请在仓库根目录运行"; exit 1; }

if [ ! -d "$FRONTEND/node_modules/wrangler" ]; then
  echo "[1/3] 安装依赖 ..."
  (cd "$FRONTEND" && npm install --no-audit --no-fund)
else
  echo "[1/3] 依赖已就绪，跳过安装"
fi

echo "[2/3] 构建前端 dist ..."
(cd "$FRONTEND" && npm run build)

echo "[3/3] 启动本地服务（wrangler pages dev）..."
echo ""
echo "演示地址：$URL  （推荐演示病例：张建国 · 胸痛红旗全流程）"
echo "无 DeepSeek Key 时自动进入【规则引擎降级模式】并在界面明确标注，功能完整可演示。"
echo "退出：Ctrl+C"
echo ""
cd "$FRONTEND"
exec node node_modules/wrangler/bin/wrangler.js pages dev dist --port 8788 --local
