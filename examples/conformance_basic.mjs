#!/usr/bin/env node
// 对外契约自验示例（conformance kit · 第三方入口）
//
// 这个文件存在的唯一理由：把「本系统能集成」这句话变成**别人能自己跑一次**的东西。
// 对标依据（第一百零七轮八维现取）：`inferno-framework/smart-app-launch-test-kit`（31 releases／18 贡献者）
// 就是一件"别人能拿去跑"的契约套件；我方此前有 FHIR/CDS 实现却没有对应的验证面（差距 0 vs 1）。
//
// 两种用法（都不需要密钥、不需要读源码）：
//   ① 验本地仓（零网络，直驱 Functions 处理器）：
//        node examples/conformance_basic.mjs
//   ② 验一个已部署实例（打真实 HTTP，含线上）：
//        node examples/conformance_basic.mjs --base https://doctor-ai-dx.pages.dev
//
// 退出码：0 全过｜1 有违例｜2 取数面坏。判据本体住 `frontend/tests/conformance_guard.mjs`，
// 本文件只做「一条命令」的入口（不复制任何断言，避免第二真值）。
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const guard = resolve(HERE, "..", "frontend", "tests", "conformance_guard.mjs")
const baseIdx = process.argv.indexOf("--base")
const args = [guard]
if (baseIdx >= 0 && process.argv[baseIdx + 1]) args.push("--base", process.argv[baseIdx + 1])

console.log("跑对外契约套件：" + (args.includes("--base") ? "线上 " + args[args.indexOf("--base") + 1] : "本地仓（零网络）"))
const r = spawnSync(process.execPath, args, { cwd: resolve(HERE, ".."), stdio: "inherit" })
process.exit(r.status === null ? 2 : r.status)
