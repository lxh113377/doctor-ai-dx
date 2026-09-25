# 错误契约（ERRORS）— 对外只会出现的这些码

> 用途：给集成方（HIS 侧、脚本、AI Agent）一张**不需要读源码**就能写对分支的表。
> 本表与实现的关系由 `frontend/tests/api_contract_guard.mjs` 机器核对：
> ①`docs/openapi.json` 里每个操作声明的状态码都必须在下表出现一行；②表里写的对外文案必须等于
> `frontend/functions/lib/limits.js` 与 `backend/app/limits.py` 里的同名常量（逐字）；
> ③表里出现而契约没声明的码也算红（防止文档领先实现）。**改了码或文案不改本表 ⇒ CI 判红。**

| 状态码 | 含义 | 对外 message（`{code,message}` 的 message 字段） | 常量来源 | 端上建议 |
|---|---|---|---|---|
| `200` | 成功，含**降级成功**（LLM 不可用时走规则兜底，`data.mode="rule-fallback"`） | — | — | 读 `data.mode` 决定是否标注"降级"，不要按失败处理 |
| `400` | 请求体不是合法 JSON 对象（不再静默当空对象继续跑） | `请求内容无法解析，请刷新页面后重试` | `BAD_JSON_MESSAGE` / `BAD_JSON_PUBLIC_MESSAGE` | 提示"请重试"，不重放同一 body |
| `404` | 病例 id 不存在，或路径未匹配 | `unknown case: {id}` ／ `not found: {path}` | `engine.js` / `engine.py` 抛出后由路由翻译 | 视为调用方参数错误，不重试 |
| `413` | 入站边界超限（body 64 KiB／history 64 条／单条 2000 字） | `请求内容超出可处理范围，请精简问诊记录后重试` | `TOO_LARGE_MESSAGE` / `TOO_LARGE_PUBLIC_MESSAGE` | 截断或分页后重试；阈值单一源见 `frontend/tests/fixtures/request_limits.json` |
| `422` | JSON 合法但结构不合契约（`history` 非数组、元素非对象、`content`/`role` 非字符串、`dx` 非对象） | `请求参数不完整，请刷新后重试（故障编号 {id}）` | `BAD_SHAPE_MESSAGE` / `BAD_SHAPE_PUBLIC_MESSAGE` | 修参数后重试；带编号来咨询可直接定位日志 |
| `500` | 未预期异常（**只留给真故障**，任何客户端可修正的错误都不落在这一档） | `服务暂时不可用，请稍后重试（故障编号 {id}）` | `main.py` / `functions/api/[[route]].js` 兜底 | 带 `X-Request-Id` 退避重试（指数退避，最多 2 次） |

## 三条通用约定

1. **响应体形状恒定**：所有码都是 `{"code": <int>, "message": <string>}`，错误响应**一定**带
   `X-Request-Id` 响应头；`message` 永远是医生/运维可读文案，**不含堆栈、不含服务端内部路径**。
   这条口径的常驻判据：`frontend/tests/route_guard.mjs`（500 分支响应体零泄漏 + 日志级别）与
   `backend/tests/test_api_observe.py`（镜像面同形 + 不外泄 `detail` 数组）。
2. **双端一致**：本表由 `frontend/tests/error_parity_guard.mjs` 按「POST 路由 × 入站违规类型」的
   **枚举矩阵**（当前 4×9+2＝38 条用例）逐条比对 期望 ↔ Functions(JS) ↔ FastAPI(Py) 三方，
   状态码与剥掉故障编号后的文案都要全等。用例由 `scripts/gen_error_matrix.py` 生成，
   手改 `fixtures/error_parity.json` 会因漂移判红。
3. **安全叙事不受错误路径影响**：即使返回 4xx/5xx，红旗规则层结论、引用白名单与
   「AI 辅助参考 · 医生终审」文案都不会被改写（错误响应只是拒绝，不产出诊断）。

## 不会出现的形态（刻意排除）

- 不会返回框架默认的 `{"detail": [...]}`（FastAPI 校验错误已被翻译，第十四轮起由测试钉住）。
- 不会把客户端错误记成服务端 `error` 级日志（第十九轮起 4xx 一律 `warn`，防滥用流量淹没真故障）。
- 不会用 `500` 表示"你传的参数不对"（第二十一轮收敛台账#28 后由 `422` 承担）。
