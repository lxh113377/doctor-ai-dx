// 端到端浏览器回归的判据配置（第十七轮，对标 OpenEMR 的 Acceptance test 工作流）。
// 取向说明：
//   · 跑的是**生产构建 + Pages Functions 本地运行时**（`wrangler pages dev dist`），不是 vite dev server——
//     否则测的是一条线上不存在的路径（dev 代理到 :8000 的 FastAPI 镜像面）。
//   · 不设 DEEPSEEK_API_KEY ⇒ 必然走 rule-fallback 降级链路，因此**零网络、零密钥、结果确定**，
//     可以进 CI（live 分支的自动化覆盖由 tests/live_path_guard.mjs 用 fetch 桩完成，职责不重叠）。
//   · 刻意只装 chromium 一种引擎：本项目 AC 口径是「桌面 1440 + 移动 390 双视口」，
//     不是跨浏览器矩阵；加 firefox/webkit 只会把 CI 时长翻倍而不会多抓一类缺陷。
import { defineConfig } from "@playwright/test"

const PORT = 8788
const BASE = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    headless: true,
    trace: "off",
    video: "off",
  },
  webServer: {
    // --no-install 刻意保留：未装 wrangler 时报错而不是后台偷偷下一份（供应链面收敛，与 pre-commit 同口径）
    command: `npx --no-install wrangler pages dev dist --port ${PORT} --local`,
    url: BASE,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    reuseExistingServer: !process.env.CI,
  },
})
