// 入库前脱敏器（红线 3：演示与留痕只用脱敏合成数据）。
//
// 为什么必须在这里而不是「后台看的时候再脱敏」：D1 里的数据一旦落盘就是既成事实，
// 展示层脱敏只能遮眼睛、遮不住备份与导出。所以顺序是**先脱敏再入库**，本模块是唯一入口。
// 后台列表、导出、统计三个读口全部复用 redactPii()，避免出现「一个口脱敏一个口不脱敏」。
//
// 刻意不做的事：不猜测「这个人是谁」；只按可判定的模式做掩码，宁可漏掩也不误伤正文。
const PATTERNS = [
  // 身份证：15 位或 18 位（含 X 结尾）。保留首 2 位与末 2 位，其余掩码。
  { type: "id_card", re: /\d{17}[\dXx]|\d{15}/g, mask: (m) => m.slice(0, 2) + "*".repeat(Math.max(0, m.length - 4)) + m.slice(-2) },
  // 手机号：1 开头 11 位。保留前 3 后 4。
  { type: "phone", re: /1[3-9]\d{9}/g, mask: (m) => m.slice(0, 3) + "****" + m.slice(-4) },
  // 邮箱：保留首字符与域名。
  { type: "email", re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g, mask: (m) => m[0] + "***@" + m.split("@")[1] },
  // 住址：省市区县 + 门牌段。保留到「号」为止的骨架，掩掉后面的具体房号。
  { type: "address", re: /[一-龥]{2,8}(省|市|区|县)[一-龥0-9]{0,12}?(路|街|道|巷|号|栋|单元|室|楼)[一-龥0-9-]{0,10}/g,
    mask: (m) => m.replace(/[一-龥0-9-]{1,}$/, (tail) => "*".repeat(Math.max(0, tail.length))) },
  // 姓名：只掩「显式自报」形态（姓名: 张三 / 我叫张三 / 李先生 / 王大夫），不做全文人名猜测。
  { type: "name", re: /姓名[:：]?\s*[一-龥]{2,4}/g, mask: (m) => m.replace(/[一-龥]{2,4}$/, (n) => n[0] + "*".repeat(n.length - 1)) },
  { type: "name", re: /(?:我叫|患者|病人)\s*[一-龥]{2,4}/g, mask: (m) => m.replace(/[一-龥]{2,4}$/, (n) => n[0] + "*".repeat(n.length - 1)) },
  { type: "name", re: /[一-龥]{1,2}(先生|女士|大夫|医生)/g, mask: (m) => m[0] + "*" + m.slice(-2) },
]

const MAX_TEXT = 4000

/**
 * 脱敏单段文本。返回 { text, hits }：
 * - text：掩码后的文本（用于入库与展示）
 * - hits：[{type, count}]，供后台审计「这一段里脱掉了什么类型」，不记录原值
 */
export function redactPii(input) {
  const src = String(input ?? "").slice(0, MAX_TEXT)
  const hits = []
  let text = src
  for (const p of PATTERNS) {
    let count = 0
    text = text.replace(p.re, (m) => {
      count++
      return p.mask(m)
    })
    if (count > 0) hits.push({ type: p.type, count })
  }
  return { text, hits }
}

/** 批量脱敏（消息数组），形状与 redactPii 一致，hits 按类型汇总。 */
export function redactPiiList(items) {
  const agg = new Map()
  const out = (Array.isArray(items) ? items : []).map((s) => {
    const r = redactPii(s)
    for (const h of r.hits) agg.set(h.type, (agg.get(h.type) || 0) + h.count)
    return r.text
  })
  return { texts: out, hits: [...agg].map(([type, count]) => ({ type, count })) }
}

/** 供守卫复算：当前脱敏规则命中哪些类型（不落盘、不改数据）。 */
export function piiTypes() {
  return PATTERNS.map((p) => p.type)
}