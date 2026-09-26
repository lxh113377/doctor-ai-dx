// 从 knowledge.js 生成 backend/app/knowledge.py（保证两端知识库数据零漂移）
// 第二十四轮从参赛工作区收进本仓：此前该生成器不随仓库发布，README/CONTRIBUTING 只能指向仓外路径
// ⇒ 第三方 clone 后无法重生成镜像面知识库，「请勿手改 .py 数据」的承诺对他们是死路。
// 数据为 str/list/dict/null：null 先经占位符序列化为 Python None，避免裸 null 字面量非法
import { writeFileSync } from "node:fs"
import { KNOWLEDGE_BASE, SYNONYMS, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB } from "../frontend/functions/lib/knowledge.js"

const toPy = (value, indent) => JSON.stringify(value, (k, v) => (v === null ? "__PY_NULL__" : v), indent)
  .replaceAll('"__PY_NULL__"', "None")
  .replace(/"__PY_NULL__"/g, "None")

const header = `# ============================================================
# 医学知识库（RAG 语料，带完整元数据）+ 同义词表 + 红旗词 + 症状映射
# ⚠️ 本文件由 scripts/export_kb.mjs 从 frontend/functions/lib/knowledge.js 自动生成，
#    两端数据同源零漂移；请勿手改数据，改 knowledge.js 后重新生成。
# ============================================================
`
const py = header
  // 类型注解由生成器统一注入：数据本体来自 JS 单一源，值域异构（str/list 混合）。
  // 不标注 ⇒ mypy 推断为 dict[str, object] ⇒ 下游数十条「object 不可下标」假性告警
  // （第十五轮实测 26 条里 19 条属此类）。生成物禁手改，要改请改本文件。
  + "from typing import Any\n\n"
  + "KNOWLEDGE_BASE: list[dict[str, Any]] = " + toPy(KNOWLEDGE_BASE, 2) + "\n\n"
  + "SYNONYMS: dict[str, list[str]] = " + toPy(SYNONYMS, 2) + "\n\n"
  + "RED_FLAG_KEYWORDS: list[str] = " + toPy(RED_FLAG_KEYWORDS) + "\n\n"
  + "SYMPTOM_TO_KB: dict[str, list[str]] = " + toPy(SYMPTOM_TO_KB, 2) + "\n"

writeFileSync(
  new URL("../backend/app/knowledge.py", import.meta.url),
  py, "utf8"
)
console.log("generated knowledge.py with", KNOWLEDGE_BASE.length, "entries")
