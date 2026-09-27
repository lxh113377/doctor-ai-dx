// live 分支浏览器级回归的配置（第四十轮 #24）。
// 与 `playwright.config.mjs` 的唯一差别就是它必须存在的理由：**没有 webServer、baseURL 指向线上**。
// 因此它不能进 `npm test`，也不能进 `ci.yml`（那条链刻意零密钥零网络，才能对每次 push 都给确定结论）；
// 它挂在 `live-e2e.yml` 的周期作业上，红了单独通知，不拦合码——这与 live_smoke / link_health 同一分层口径。
import { defineConfig } from "@playwright/test"

const BASE = process.env.LIVE_BASE || "https://doctor-ai-dx.pages.dev"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "live_redlines.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 1,          // 公网与 live 模型的抖动由重试吸收；**断言**不放水
  timeout: 300_000,
  reporter: [["list"]],
  use: { baseURL: BASE, headless: true, trace: "off", video: "off" },
})
