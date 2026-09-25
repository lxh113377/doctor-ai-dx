// 提交钩子/CI 用的 ESLint 薄壳：把执行目录钉在 frontend/ 后再跑本地 eslint。
// 为什么需要它（实测）：从仓根直跑 `eslint --config frontend/eslint.config.mjs frontend` 会让
// 配置里的 files: ['src/**'] 规则块不匹配 ⇒ react/jsx-uses-vars 不生效 ⇒ 正在渲染的组件
// 被误报「未使用」（1941 errors 全是这类假阳性）。flat config 的 files/ignores 基准是配置文件目录。
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const bin = join(here, "node_modules", "eslint", "bin", "eslint.js")
if (!existsSync(bin)) {
  console.error("ESLint 未安装：先在 frontend/ 执行 npm ci（本钩子刻意禁网，不代你装依赖）")
  process.exit(1)
}
const r = spawnSync(process.execPath, [bin, ".", "--max-warnings=0"], { cwd: here, stdio: "inherit" })
process.exit(r.status ?? 1)
