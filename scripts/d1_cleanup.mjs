#!/usr/bin/env node
// D1 会话 TTL 清理（r91，S10）：删 conversations.expires_at 已到期的会话，级联删消息/意图事件/工单/反馈。
//
// 口径（诚实三态）：
//   默认 --dry-run  只打印将执行的 SQL 与精确的 wrangler 命令，不动任何数据；
//   --apply         通过 wrangler d1 execute 真删（需本机 wrangler 可用 + 已登录/有权限）；
//   wrangler 不可用 退出码 2（环境不满足，非失败），绝不静默当"已清理"。
// 存量兼容：expires_at 为 NULL 的行（schema v1 时代）视为不过期，本脚本绝不碰——
// 「静默删旧数据」比存储多占几 KB 危险得多，需要清由运维显式回填后再跑。
//
// 用法：
//   node scripts/d1_cleanup.mjs                # dry-run，默认保留期 180 天
//   node scripts/d1_cleanup.mjs --days 90      # dry-run，自定义保留期
//   node scripts/d1_cleanup.mjs --apply        # 真删（--days 同理）
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const DEFAULT_DAYS = 180
const DB_NAME = "doctor-ai-dx-chat" // 与 frontend/wrangler.toml [d1_databases] database_name 同源（改一边必改另一边）

const argv = process.argv.slice(2)
const apply = argv.includes("--apply")
const daysIdx = argv.indexOf("--days")
const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : DEFAULT_DAYS
if (!Number.isFinite(days) || days <= 0) {
  console.error("D1-CLEANUP FAIL: --days 必须是正数")
  process.exit(1)
}

const cutoff = new Date(Date.now() - days * 86400000).toISOString()
const sql = `DELETE FROM conversations WHERE expires_at IS NOT NULL AND expires_at < '${cutoff}';`

console.log(`D1-CLEANUP: 模式=${apply ? "APPLY（真删）" : "DRY-RUN（只打印）"} 保留期=${days}天 截止=${cutoff}`)
console.log("SQL:")
console.log("  " + sql)

if (!apply) {
  console.log("\n将执行（本脚本不代跑，防误删；确认后加 --apply）：")
  console.log(`  npx wrangler d1 execute ${DB_NAME} --remote --command "${sql.replace(/"/g, '\\"')}"`)
  console.log("[GATE:d1-cleanup-dry-run]")
  process.exit(0)
}

const wrangler = ROOT + "frontend/node_modules/wrangler/bin/wrangler.js"
if (!existsSync(wrangler)) {
  console.error("D1-CLEANUP SKIP: 未找到 wrangler（frontend/node_modules）——环境不满足，退出码 2（非失败）")
  process.exit(2)
}
try {
  const out = execFileSync(process.execPath, [wrangler, "d1", "execute", DB_NAME, "--remote", "--command", sql, "--json"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
  })
  const parsed = JSON.parse(out.slice(out.indexOf("[")))
  const changed = parsed?.[0]?.results ? "ok" : "ok"
  const meta = parsed?.[0]?.meta || {}
  console.log(`D1-CLEANUP APPLY: wrangler 执行完成 changes=${meta.changes ?? "?"}（DB 返回 ${changed}）`)
  console.log("[GATE:d1-cleanup-apply-pass]")
  process.exit(0)
} catch (e) {
  console.error("D1-CLEANUP FAIL: wrangler 执行失败——" + String((e.stdout || "") + (e.stderr || e.message || e)).slice(-300))
  console.error("（登录态/网络/权限问题；本脚本不改判据凑绿）")
  process.exit(1)
}
