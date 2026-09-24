# 安全策略 / Security Policy

## 支持的版本 / Supported Versions

本项目当前处于 iCAN 参赛交付阶段，仅对 `main` 分支 HEAD 提供安全支持。

| 版本 | 支持 |
|---|---|
| 1.6.x | ✅ |
| < 1.6  | ❌（请升级到最新 tag） |

## 风险面声明（先读这条再决定要不要报）

本系统为**辅助参考工具**，架构上已内置三重防线，以下情形**不属于安全漏洞**（避免无效报告）：

- LLM 输出的医学内容偏差 —— 已由「红旗规则层独立兜底 + 医生终审」设计覆盖，属产品边界而非缺陷。
- 客户端本地可见的演示病例数据 —— 全部为**脱敏合成病例**，无真实患者信息。
- 无鉴权的只读接口 —— MVP 定位为公开演示系统，`/api/*` 设计上不含隐私与权限语义。

## 真正希望被报告的（按优先级）

1. **服务端密钥泄漏路径**：`DEEPSEEK_API_KEY` 等 env 经由响应体 / 日志 / 错误堆栈外泄（响应侧已有 redact 守卫与测试，绕过它的输入形态欢迎报告）。
2. **注入类**：能突破引用白名单（伪造 `evidence_id` 被前端渲染为带链接引用）、或让红旗规则层被模型输出覆盖的路径。
3. **依赖供应链**:可利用的已公开 CVE 依赖版本（附 GHSA 编号）。

## 报告方式 / Reporting

- **请勿公开创建 Issue 披露未修复漏洞**（issue 模板首项已提示）。
- 请使用仓库的 **Private vulnerability reporting**（GitHub → Security → Report a vulnerability），该通道复用 GitHub 私有安全议题，修复前对其他访客不可见。
- 一般问题走 [Discussions](../../discussions/categories/q-a) 或普通 issue。

## 响应承诺

- 确认收到：7 天内（维护者为单人学生团队，请理解节奏）。
- 复现成立且触及上述 1/2 类：公开修复提交 + 更新 `docs/EVAL_CARD.md` / CHANGELOG，并在 release notes 致谢（经你同意）。

---
本策略参照 OpenSSF / OSMB Security Blueprints 的协调披露（CVD）最小模板裁剪，措辞与本项目 `.env` 不入库、日志脱敏的既有事实对齐。
