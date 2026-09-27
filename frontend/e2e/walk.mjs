// 五步链路的共用走查（第四十轮 #24 抽出）。
// 为什么要有这个文件：`app.spec.mjs`（rule-fallback，进 CI）与 `live_redlines.spec.mjs`（打线上 live）
// 需要**同一套**推进逻辑；两边各写一份＝两份真值，任何一份先漂就出现"一边假绿一边假红"。
// 注释里那两条实测教训（等打字气泡消失＝完成态信号；busy 期间点击被组件吞掉）一并搬过来，不重述第二遍。
import { expect } from "@playwright/test"

export function noConsoleErrors(page) {
  const errs = []
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()) })
  page.on("pageerror", (e) => errs.push(String(e && e.message)))
  return errs
}

export async function 走到辅助诊断(page) {
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
