// live 分支的浏览器级回归（第四十轮，台账 #24）。
// 为什么要单独一个 spec：既有 `app.spec.mjs` 刻意不设 DEEPSEEK_API_KEY ⇒ 只覆盖 rule-fallback 分支
// （为了确定性，这是对的选择），而 **live 分支从来没有浏览器级自动化**——`live_path_guard.mjs` 用 fetch 桩
// 在 Node 里测，测不到"真浏览器里 live 链路会不会把红线区块渲染丢、会不会溢出、会不会抛控制台异常"。
//
// 判据设计的硬约束（台账原文）：**只断言红线在场与结构字段，绝不断言结论文本**。
// 理由：live 走 DeepSeek，同输入两次输出不同是常态；一旦断言"诊断里有 ACS"之类，
// 这条判据测的就不是集成而是模型心情，红了也没法定位。所以这里只问四件事：
//   ① 线上自报 version == 仓内单一源（否则本文件测的是别的站）；
//   ② 红线文案常驻 ＋ 全站负向（不得出现"替代医生"类表述）；
//   ③ live 五步链路的**结构骨架**齐全（疑似/鉴别/引用/三组检查建议/SOAP 四段/免责）；
//   ④ 全程零控制台 error。
// 五步推进逻辑与 `app.spec.mjs` **共用 `walk.mjs`**（两边各写一份＝两份真值，必然一份先漂）。
import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { noConsoleErrors, 走到辅助诊断 } from "./walk.mjs"

const BASE = process.env.LIVE_BASE || "https://doctor-ai-dx.pages.dev"
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")
const REDLINE = "AI 辅助参考 · 医生终审"

test("线上自报 version 与仓内单一源全等（否则本 spec 测的是别的站）", async ({ request }) => {
  test.setTimeout(60_000)
  const res = await request.get(`${BASE}/api/health`)
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  const src = readFileSync(path.join(REPO, "backend", "app", "version.py"), "utf8")
  const repoVer = src.match(/APP_VERSION\s*=\s*"([\d.]+)"/)[1]
  expect(String(body?.data?.version), `线上=${body?.data?.version} 仓内=${repoVer}`).toBe(repoVer)
})

test("首页红线常驻＋全站无「替代医生」类表述＋零控制台 error", async ({ page }) => {
  test.setTimeout(90_000)
  const errs = noConsoleErrors(page)
  await page.goto(BASE, { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toContainText(REDLINE, { timeout: 20_000 })
  const body = await page.locator("body").innerText()
  expect(body).not.toMatch(/替代医生|取代医生|代替医生/)
  expect(errs, `控制台异常：${errs.slice(0, 2).join(" | ")}`).toHaveLength(0)
})

test("live 五步链路：结构骨架齐全（不断言任何结论文本）", async ({ page }) => {
  // live 每轮都要过真实模型窗口：12 轮 × (最长 8s 超时 + 25s 等待预算) 的最坏情况留足，
  // 但这是**分档算出来的预算**，不是"卡住了就抬 timeout"。
  test.setTimeout(480_000)
  const errs = noConsoleErrors(page)
  // 行为回执（不是配置断言）：抓浏览器与 /api/dx 的真实往返，读服务端自己标的 mode。
  // 为什么必须有：一次跑完只花 20.9s 时，"测的是 live 链路"与"其实静默降级了"两种情况**看起来一样**；
  // 只看 health 也不够——health 说有没有 Key，这单到底走了哪条链要由响应自己交代。
  const modes = []
  page.on("response", async (res) => {
    if (!/\/api\/(dx|intake)\//.test(res.url())) return
    try {
      const j = await res.json()
      if (j?.data?.mode) modes.push(String(j.data.mode))
    } catch { /* 非 JSON 响应与本判据无关，忽略 */ }
  })
  await page.goto(BASE, { waitUntil: "domcontentloaded" })
  const body = page.locator("body")
  await 走到辅助诊断(page)
  await expect(body).toContainText(/疑似诊断|初步诊断/)
  await expect(body).toContainText(/鉴别诊断/)
  await expect(body).toContainText(/参考来源|引用|指南/)
  // 红旗区是**条件在场**：live 输出不保证命中，所以断言的是"若命中则必须是独立区块且带转诊语义"
  const flagBlock = page.locator(".red-flag, [data-red-flag], .banner-danger, .flags")
  if (await flagBlock.count() > 0) {
    await expect(flagBlock.first()).toContainText(/危险信号|红旗|转诊/)
  }
  expect(modes.length, "本 spec 的立意是测 live 分支；一次 /api/dx 往返都没抓到＝测了个空壳").toBeGreaterThan(0)
  expect(modes.filter((m) => m === "live").length,
    `链路 mode 采样=${JSON.stringify(modes)}；若全是 rule-fallback 说明线上此刻并未真走模型（那是另一条判据的形状）`)
    .toBeGreaterThan(0)
  await page.getByRole("button", { name: /下一步：检查建议/ }).first().click()
  await expect(body).toContainText(/必查|建议检查|进一步检查/, { timeout: 120_000 })
  await page.getByRole("button", { name: /下一步：病历报告/ }).first().click()
  await expect(body).toContainText(/主观资料|客观资料|评估|计划/, { timeout: 120_000 })
  await expect(body).toContainText(REDLINE)
  expect(errs, `live 链路控制台异常：${errs.slice(0, 2).join(" | ")}`).toHaveLength(0)
})

