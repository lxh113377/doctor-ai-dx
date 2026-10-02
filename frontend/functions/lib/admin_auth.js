// 管理后台最小鉴权。
//
// 现状事实：既有 6 条端点**零认证**（round89 记录「认证/RBAC/审计 = 0」）。本轮新增的 /api/admin/*
// 会暴露对话记录与统计，不能继续裸奔，但也不擅自引入 RBAC/用户体系——单维护者项目上一个
// ADMIN_TOKEN 是与规模匹配的最小可行形态。取舍写进 docs/ARCHITECTURE.md 的对账矩阵。
//
// 三条纪律：
// 1. **密钥只走 secret，不进 [vars]、不入库**（与既有 DEEPSEEK_API_KEY 同一约定）。
// 2. **恒定时间比较**，避免按字节前缀早退泄露长度信息。
// 3. **未配置 token 时一律 503 而不是放行**：没配密钥就等于没门，装个样子比没有更危险。
const HEADER = "x-admin-token"

/** 从请求头取 token（只认 x-admin-token，不接受 query 参数——query 会被日志与浏览器历史记录下来）。 */
export function readAdminToken(request) {
  return String(request?.headers?.get(HEADER) || "").trim()
}

/** 恒定时间字符串比较。长度不同也走完整轮次，避免早退泄露前缀长度。 */
export function safeEqual(a, b) {
  const x = String(a || "")
  const y = String(b || "")
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0)
  }
  return diff === 0
}

export const AUTH_MISSING = { status: 503, message: "管理后台未启用：服务器未配置 ADMIN_TOKEN" }
export const AUTH_NO_TOKEN = { status: 401, message: "未提供管理令牌" }
export const AUTH_BAD_TOKEN = { status: 403, message: "管理令牌不正确" }

/**
 * 鉴权判定。返回 { ok:true } 或 { ok:false, status, message }——调用方据此 fail()。
 * 刻意不抛异常：与 [[route]].js 的既有 4xx 分流保持一致。
 */
export function authorizeAdmin(request, env = {}) {
  const expected = String(env?.ADMIN_TOKEN || "").trim()
  if (!expected) return { ok: false, ...AUTH_MISSING }
  const got = readAdminToken(request)
  if (!got) return { ok: false, ...AUTH_NO_TOKEN }
  if (!safeEqual(got, expected)) return { ok: false, ...AUTH_BAD_TOKEN }
  return { ok: true }
}