// 端到端浏览器回归（第十七轮）。为什么必须进 CI（对标实测）：
// OpenEMR 有 `Acceptance test (docker)` / `Acceptance test (package)` 常驻作业；phlox 有 CI+CodeQL；
// 我方历史文档写的是"双视口 E2E 通过"，但那是**本机一次性人工运行**，不在任何常驻判据里——
// 也就是说：三条产品红线在**真实浏览器渲染结果**上此前没有任何自动化拦截。
// 本文件跑的是生产构建 + Pages Functions 本地运行时（见 playwright.config.mjs），无密钥 ⇒ 必走降级链路，
// 因此可重复、可进 CI。live 分支的自动化由 tests/live_path_guard.mjs（fetch 桩）负责，二者职责不重叠。
import { expect, test } from "@playwright/test"

const RED_LINE = "AI 辅助参考 · 医生终审"

async function noConsoleErrors(page) {
  const errs = []
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()) })
  page.on("pageerror", (e) => errs.push(String(e && e.message)))
  return errs
}

async function 走到辅助诊断(page) {
  const dxCard = page.locator(".card-title", { hasText: "疑似诊断" })
  await page.getByRole("button", { name: /胸闷、胸痛/ }).click()
  // 每轮必须等"打字气泡消失"才点下一个快选项：
  // 实测按"消息数增加"判定会在用户气泡入列的瞬间就返回，而组件在 busy 期间直接吞掉点击
  // （Intake.jsx 的 choose → if (!busy)），结果是 8 轮预算被空等吃掉一半，表现为"链路卡住"的假故障。
  for (let i = 0; i < 12; i++) {
    if (await dxCard.count() > 0) return
    await expect.poll(async () => await page.locator(".msg .typing").count(), { timeout: 25_000 }).toBe(0)
    if (await dxCard.count() > 0) return
    const chip = page.locator(".chip").first()
    if (await chip.count() === 0) { await page.waitForTimeout(500); continue }
    await chip.click()
  }
  await expect(dxCard).toBeVisible({ timeout: 30_000 })
}

test.describe("首屏与常驻红线", () => {
  test("3 张脱敏病例卡可见，红线文案与降级标注常驻，且零控制台异常", async ({ page }) => {
    const errs = await noConsoleErrors(page)
    await page.goto("/")
    await expect(page.locator(".case-card")).toHaveCount(3)
    await expect(page.locator(".app-footer")).toContainText(RED_LINE)
    await expect(page.locator(".app-footer")).toContainText("演示环境 · 脱敏模拟病例")
    expect(errs).toEqual([])
  })

  test("全站不得出现「替代医生」类表述（红线负向）", async ({ page }) => {
    await page.goto("/")
    const body = await page.locator("body").innerText()
    expect(body).not.toContain("替代医生")
    expect(body).not.toContain("自动诊断")
    expect(body).toContain("辅助参考")
  })
})

test.describe("五步全链路（c1 胸痛，无密钥 ⇒ 规则降级）", () => {
  test("问诊 → 红旗独立检出 → 检查建议 → SOAP 报告", async ({ page }) => {
    const errs = await noConsoleErrors(page)
    await page.goto("/")
    await 走到辅助诊断(page)

    // 红线一：红旗规则层独立呈现且声明不可被模型覆盖
    await expect(page.locator("h4", { hasText: "危险信号 · 规则引擎独立检出（不可被模型覆盖）" })).toBeVisible()
    await expect(page.locator("body")).toContainText(/严重危险信号：.+。/s)
    // 降级模式必须被明确标注（不允许把 rule-fallback 冒充成模型生成）
    await expect(page.locator(".mode-badge")).toContainText("规则引擎降级模式")
    await expect(page.locator(".mode-badge")).toContainText("输出均为辅助参考，医生终审")
    // 引用可溯源
    await expect(page.locator(".ref-list a, .ref-list .ref-tag").first()).toBeVisible()

    await page.getByRole("button", { name: /下一步：检查建议/ }).click()
    await expect(page.locator("h2", { hasText: "检查与检验建议" })).toBeVisible()
    // AC-OBS-05：必查/建议/可选三组都必须渲染出来（缺一组即视为检查建议面回归）
    await expect(page.locator(".workup-group")).toHaveCount(3)

    await page.getByRole("button", { name: /下一步：病历报告/ }).click()
    // AC-OBS-06：SOAP 四段齐 + 结论 + 免责（报告页仍要留着打印入口）
    for (const seg of ["主观", "客观", "评估", "计划"]) {
      await expect(page.locator("body")).toContainText(seg)
    }
    await expect(page.locator("body")).toContainText("急性冠脉综合征")
    await expect(page.locator("body")).toContainText("执业资质的医生")
    await expect(page.getByRole("button", { name: /打印/ })).toBeVisible()
    expect(errs).toEqual([])
  })
})

test.describe("双视口无横向溢出（AC-OBS 口径）", () => {
  for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
    test(`${vp.w}×${vp.h} 五步全页面均不出现横向溢出`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h })
      await page.goto("/")
      const overflowAt = async (where) => {
        const { sw, cw } = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        }))
        expect(sw, `${where}: scrollWidth=${sw} > clientWidth=${cw}`).toBeLessThanOrEqual(cw + 1)
      }
      await overflowAt("首屏")
      await 走到辅助诊断(page)
      await overflowAt("问诊页")
      await overflowAt("诊断页")
      await page.getByRole("button", { name: /下一步：检查建议/ }).click()
      await page.locator("h2", { hasText: "检查与检验建议" }).waitFor()
      await overflowAt("检查建议页")
      await page.getByRole("button", { name: /下一步：病历报告/ }).click()
      await page.getByRole("button", { name: /打印/ }).waitFor()
      await overflowAt("病历报告页")
      // 同类出口补全（并行会话立规「修缺陷先枚举同类出口」）：报告页表格最宽、历史上最易溢出，
      // 只测首屏+诊断页等于把最可能出事的一半留在盲区。五步全部走完后仍须零控制台异常。
})
  }
})

// 第三态（#52）在真实浏览器里的两向验收：
// 正向用**响应改写**注入 abstain=true（弃权不由演示病例触发，但不能因此永不验收——
// 上一轮的教训就是"判据测的不是产品"），反向用真实降级链路确认弃权卡不会常驻。
test("演示链路（真实降级）不出弃权卡，红旗横幅与红线文案照旧", async ({ page }) => {
  const errs = await noConsoleErrors(page)
  await page.goto("/")
  await 走到辅助诊断(page)
  await expect(page.getByTestId("abstain-card")).toHaveCount(0)
  await expect(page.locator("h4", { hasText: "危险信号 · 规则引擎独立检出（不可被模型覆盖）" })).toBeVisible()
  await expect(page.locator("body")).toContainText(RED_LINE)
  expect(errs).toEqual([])
})

test("API 返回 abstain=true 时，浏览器同时渲染弃权卡与红旗横幅（弃权不吞危险信号）", async ({ page }) => {
  // 直接合成整份响应：曾用 route.fetch() 取回真实响应再改字段，结果在本运行时里拿不到期望结构
  // （断言表现为"元素不存在"）。合成后唯一变量就是 abstain 字段，测的确实是要测的那段渲染。
  await page.route("**/api/dx/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ code: 0, message: "ok", data: {
        mode: "rule-fallback", fallback_reason: "未配置 LLM Key，使用规则引擎",
        abstain: true, scope_status: "insufficient-information", top_evidence_score: 31.109,
        abstain_reason: "现有问诊信息不足以支撑鉴别，请补充问诊后重试；本系统仅作用药与鉴别参考，最终判断由执业医生作出",
        flags: ["严重危险信号：ACS 高危胸痛，立即转诊"],
        flag_details: [{ name: "急性冠脉综合征", severity: "高", advice: "10 分钟内完成心电图并转诊胸痛中心" }],
        primary: [{ name: "信息不足，建议补充问诊", prob: "信息不足", strength: "low", reasons: ["最高证据分低于阈值"], evidence_ids: [], refs: [] }],
        differential: [], evidence: [],
        faq: [{ q: "为什么弃权？", a: "证据不足时不编诊断，请医生主导鉴别" }],
        trace: { evidence_ids: [], rounds: 5, symptoms: [] },
        fhir: { resourceType: "Bundle", entry: [] },
      } }),
    })
  })
  await page.goto("/")
  await 走到辅助诊断(page)
  const card = page.getByTestId("abstain-card")
  await expect(card).toBeVisible()
  await expect(card).toContainText("信息不足 · 请医生主导鉴别")
  await expect(card).toContainText("问诊信息不足，建议补充后再评估")
  // 红线：红旗横幅必须仍在场，且"替代医生"字样仍不得出现
  await expect(page.locator("h4", { hasText: "危险信号 · 规则引擎独立检出（不可被模型覆盖）" })).toBeVisible()
  await expect(page.locator("body")).not.toContainText("替代医生")
})
