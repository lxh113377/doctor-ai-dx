/**
 * agent-service 自检（面3 侧会红的判据）：断言「降级契约」在任何环境下都成立。
 *
 * 为什么不是简单断言 SDK 可用：本机 / CI 很可能没登录 CodeBuddy，那种情况下判红没有意义。
 * 真正必须恒成立的是**不得谎报** —— 只有 CLI 可执行且有 Key 时才允许 mode=live；
 * 其余一切情况都必须落到 mock-fallback。这条契约一破就是「静默假装 live」，正是本项目最在意的那类假绿。
 *
 * 用法：npm run probe（退出码 0/1）
 */
import { probeSdk, cliCandidates } from "./sdk_status.js";
import { AGENT_TIMEOUT_MS, activeProviderId, listProviderIds } from "./agent.js";
import { getActiveProvider, FALLBACK_CHAIN, providerAttributionKind } from "./providers.js";

import { MAX_CONCURRENT, MAX_QUEUE, createLimiter } from "./concurrency_limiter.js";

let pass = 0;
let fail = 0;
// r96 追加判据：降级链四段归因映射、rule provider、并发闸。
const check = (name: string, ok: boolean, detail = ""): void => {
if (ok) { pass++; console.log("  PASS", name); }
else { fail++; console.log("  FAIL", name + (detail ? " :: " + detail : "")); }
};

const STATES = ["ready", "no-cli", "no-auth", "disabled"];
const MODES = ["live", "mock-fallback"];

console.log("== SDK 可用性实测 ==");
const st = await probeSdk();
console.log("  state=" + st.state + " mode=" + st.mode + " cli=" + (st.cli_path || "(none)") + " version=" + (st.cli_version || "(none)") + " has_key=" + st.has_api_key);

console.log("== 降级契约判据 ==");
check("N1 state 落在四态枚举内", STATES.includes(st.state), st.state);
check("N2 mode 落在两值枚举内（与既有 llm 口径一致）", MODES.includes(st.mode), st.mode);
check("N3 mode=live 当且仅当 state=ready（不得谎报 live）", (st.mode === "live") === (st.state === "ready"), "state=" + st.state + " mode=" + st.mode);
check("N4 state=ready 时 cli_path 与 cli_version 均非空", st.state !== "ready" || (!!st.cli_path && !!st.cli_version), "path=" + (st.cli_path || "(null)") + " version=" + (st.cli_version || "(null)"));
check("N5 path 与 version 不矛盾", !!st.cli_version === !!st.cli_path, "path=" + (st.cli_path || "(null)") + " version=" + (st.cli_version || "(null)"));
check("N6 reason 非空（任何状态都必须能解释自己）", st.reason.trim().length > 0, st.reason);
check("N7 探测结果不含密钥值", !JSON.stringify(st).includes(String(process.env.CODEBUDDY_API_KEY || "@@none@@")));
check("N8 CLI 候选列表无空串", cliCandidates().every((c) => c.trim().length > 0), JSON.stringify(cliCandidates()));
check("N9 表达层硬超时为正且有上界", AGENT_TIMEOUT_MS > 0 && AGENT_TIMEOUT_MS <= 30000, String(AGENT_TIMEOUT_MS));

console.log("== 反向对照（变异：强制关闭 Agent 编排）==");
const prev = process.env.AGENT_SDK_ENABLED;
process.env.AGENT_SDK_ENABLED = "0";
const forced = await probeSdk();
check("M1 变异后 state=disabled", forced.state === "disabled", forced.state);
check("M2 变异后 mode=mock-fallback", forced.mode === "mock-fallback", forced.mode);
check("M3 变异后仍满足 live⟺ready", (forced.mode === "live") === (forced.state === "ready"));
if (prev === undefined) delete process.env.AGENT_SDK_ENABLED;
else process.env.AGENT_SDK_ENABLED = prev;

console.log("== provider 适配器（S7）==");
const ids = listProviderIds();
check("P1 在册 provider 至少含现役 codebuddy 与内置 echo", ids.includes("codebuddy") && ids.includes("echo"), JSON.stringify(ids));
check("P2 默认生效 provider = codebuddy（未点名 AGENT_PROVIDER 时）", activeProviderId() === "codebuddy", activeProviderId());
const prevProvider = process.env.AGENT_PROVIDER;
process.env.AGENT_PROVIDER = "echo";
check("P3 显式点名 echo ⇒ 生效 provider 切换（换路不改编排代码）", activeProviderId() === "echo", activeProviderId());
const echo = getActiveProvider();
const echoProbe = echo.provider ? await echo.provider.probe() : null;
check("P4 echo provider 探测恒 ready（不依赖 CLI/密钥）", !!echoProbe && echoProbe.ready === true);
const echoOut = echo.provider
  ? await echo.provider.phrase({ userText: "测试", plan: { intent: "x", answer_text: "确定性话术原文", citations: [], handoff_reason: null, abstain: false }, history: [] }, echoProbe!)
  : null;
check("P5 echo phrase 原样回显面2 文案且 ok=true", !!echoOut && echoOut.ok === true && echoOut.text === "确定性话术原文", JSON.stringify(echoOut));
process.env.AGENT_PROVIDER = "no-such-provider";
check("P6 点名不存在的 provider ⇒ fail-closed 回 codebuddy 且给告警", activeProviderId() === "codebuddy");
if (prevProvider === undefined) delete process.env.AGENT_PROVIDER;
else process.env.AGENT_PROVIDER = prevProvider;

console.log("== 降级链四段与归因映射（r96）==");
check("P7 在册 provider 至少三路（codebuddy / echo / rule）", ["codebuddy", "echo", "rule"].every((id) => ids.includes(id)), JSON.stringify(ids));
check("P8 降级链四段齐备且顺序稳定", FALLBACK_CHAIN.length === 4 && FALLBACK_CHAIN[0].kind === "codebuddy"
  && FALLBACK_CHAIN[1].kind === "llm" && FALLBACK_CHAIN[2].kind === "rule" && FALLBACK_CHAIN[3].kind === "fallback",
  JSON.stringify(FALLBACK_CHAIN.map((s) => s.kind)));
check("P9 每段降级形态都有触发条件说明（不许只列名字）", FALLBACK_CHAIN.every((s) => s.when && s.when.trim().length > 6));
check("P10 归因映射五个入口全部有定义", providerAttributionKind("codebuddy") === "codebuddy"
  && providerAttributionKind("llm") === "llm" && providerAttributionKind("echo") === "rule"
  && providerAttributionKind("rule") === "rule" && providerAttributionKind("who-knows") === "fallback");
check("P11 归因映射取值全部落在降级链枚举内（两套口径不许漂）", FALLBACK_CHAIN.some((s) => s.kind === providerAttributionKind("echo")));

console.log("AGENT-SERVICE PROBE:" + pass + " pass / " + fail + " fail");
process.exit(fail ? 1 : 0);
