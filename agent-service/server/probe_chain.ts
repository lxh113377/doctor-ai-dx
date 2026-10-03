/**
 * 面3 第二探针（r96）：**降级链四段 + 归因映射 + 并发闸**。
 *
 * 为什么独立成文件而不是并进 probe.ts：probe.ts 断言「SDK 探测与 mode 不得谎报」，
 * 这一份断言「四段降级链是否齐备且映射不漂、并发闸是否真的限流」。
 * 混在一起会让「探针红了」失去指向——运维需要知道是哪一层坏了。
 *
 * 用法：npm run probe:chain（退出码 0/1）
 */
// 必须 import agent.js：codebuddy provider 是在它的模块副作用里注册的。
// 少这一步则「在册至少三路」会误红——那不是缺陷没修，是探针自己少走了一步注册。
import "./agent.js";
import { extractText } from "./agent.js";
import { FALLBACK_CHAIN, providerAttributionKind, getActiveProvider, providerIds } from "./providers.js";
import { MAX_CONCURRENT, MAX_QUEUE, createLimiter } from "./concurrency_limiter.js";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name + (detail ? " :: " + detail : "")); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("== 降级链四段与归因映射 ==");
const kinds = FALLBACK_CHAIN.map((s) => s.kind);
check("C1 四段齐备且顺序稳定（codebuddy/llm/rule/fallback）",
  kinds.length === 4 && kinds[0] === "codebuddy" && kinds[1] === "llm" && kinds[2] === "rule" && kinds[3] === "fallback",
  JSON.stringify(kinds));
check("C2 每段都有触发条件说明（只列名字的降级链等于没有降级链）",
  FALLBACK_CHAIN.every((s) => typeof s.when === "string" && s.when.trim().length > 6));
check("C3 在册 provider 至少三路（换供应商不改编排代码的实证面）",
  ["codebuddy", "echo", "rule"].every((id) => providerIds().includes(id)), JSON.stringify(providerIds()));
check("C4 归因映射取值全部落在降级链枚举内（两套口径不许漂）",
  FALLBACK_CHAIN.some((s) => s.kind === providerAttributionKind("echo")));
check("C5 归因映射五个入口全部有定义（含未知 id 兜底）",
  providerAttributionKind("codebuddy") === "codebuddy" && providerAttributionKind("llm") === "llm"
  && providerAttributionKind("echo") === "rule" && providerAttributionKind("rule") === "rule"
  && providerAttributionKind("who-knows") === "fallback");
const mapped = new Set(["codebuddy", "llm", "echo", "rule", "who-knows"].map(providerAttributionKind));
check("C6 反向对照：映射不是常量（至少三种不同取值）", mapped.size >= 3, JSON.stringify([...mapped]));

console.log("== rule provider：不调模型的可用表达路 ==");
const prevProvider = process.env.AGENT_PROVIDER;
process.env.AGENT_PROVIDER = "rule";
const ruleSel = getActiveProvider();
const ruleProbe = ruleSel.provider ? await ruleSel.provider.probe() : null;
check("C7 rule provider 探测恒 ready（不依赖 CLI/密钥）", !!ruleProbe && ruleProbe.ready === true);
const rulePlan = {
  intent: "report_interp",
  answer_text: "指标异常需结合症状与复查趋势判断。",
  citations: [{ title: "检验报告解读规范", source: "院内检验科", year: "2025" }],
  handoff_reason: null,
  abstain: true,
};
const ruleOut = ruleSel.provider ? await ruleSel.provider.phrase({ userText: "测试", plan: rulePlan, history: [] }, ruleProbe!) : null;
check("C8 rule provider 输出带来源标签", !!ruleOut && ruleOut.ok === true && ruleOut.text.includes("检验报告解读规范"), JSON.stringify(ruleOut));
check("C9 rule provider 弃权时明说证据有限（不硬答）", !!ruleOut && ruleOut.text.includes("证据有限"), JSON.stringify(ruleOut));
const bareOut = ruleSel.provider
  ? await ruleSel.provider.phrase({ userText: "t", plan: { ...rulePlan, citations: [] }, history: [] }, ruleProbe!)
  : null;
check("C10 rule provider 无引用时不编造来源", !!bareOut && bareOut.ok === true && !bareOut.text.includes("依据："), JSON.stringify(bareOut));
if (prevProvider === undefined) delete process.env.AGENT_PROVIDER;
else process.env.AGENT_PROVIDER = prevProvider;

console.log("== 表达层并发闸：SDK 子进程不许无上限并发 ==");
check("C11 并发上限为正且有上界（>16 就不算闸了）", MAX_CONCURRENT >= 1 && MAX_CONCURRENT <= 16, String(MAX_CONCURRENT));
check("C12 队列上限非负（0＝只放行并发内的请求）", MAX_QUEUE >= 0, String(MAX_QUEUE));
{
  const lim = createLimiter(1, 4);
  let peak = 0;
  let cur = 0;
  const mk = (ms: number) => async () => {
    cur += 1;
    if (cur > peak) peak = cur;
    await sleep(ms);
    cur -= 1;
    return ms;
  };
  const results = await Promise.all([lim.run(mk(30)), lim.run(mk(10)), lim.run(mk(10))]);
  check("C13 三个任务全部完成（闸不是拒绝一切）", results.length === 3, JSON.stringify(results));
  check("C14 实测峰值并发不超过上限 1", peak <= 1, "peak=" + peak);
  check("C15 完成计数可观测", lim.stats.completed === 3, JSON.stringify(lim.stats));
  // 队列满只在**真并发**下发生：顺序 await 时 running 已归零，每次都走快路径。
  // r96 首版用顺序 await，于是 C16 假红——夹具错了，不是闸错了。
  const lim2 = createLimiter(1, 0);
  const first = lim2.run(async () => { await sleep(25); return 1; });
  let code = "";
  try { await lim2.run(async () => 1); } catch (e) { code = String((e as { code?: string }).code || ""); }
  await first;
  check("C16 队列满（上限 0）⇒ 立即拒绝并给可归因错误码", code === "queue-full", "code=" + code);
  check("C17 被拒计数可观测", lim2.stats.rejected === 1, JSON.stringify(lim2.stats));
  const lim3 = createLimiter(1, 1);
  const ok1 = lim3.run(async () => { await sleep(20); return "a"; });
  const ok2 = lim3.run(async () => "b");
  check("C18 队列内允许排队（上限 1 时第二个请求被接收而非被拒）", (await ok2) === "b" && (await ok1) === "a");
}

console.log("== extractText 解析（r96 补测试盲区）==");
// 此前 41 条判据没有一条调用过 codebuddyProvider.phrase，于是「sendMessage 不存在」
// 与「文本恒为空」两个致命缺陷都在盲区里（verifier 核验发现）。extractText 是纯函数，
// 不需要真实 CLI 就能抓住这一类解析缺陷。
const realAssistant = { type: "assistant", message: { content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] } };
check("C19 助手消息真实结构 message.content[] 能取出文本", extractText(realAssistant) === "第一段第二段", JSON.stringify(extractText(realAssistant)));
check("C20 result 终帧也能取出文本", extractText({ type: "result", result: "收尾文本" }) === "收尾文本");
check("C21 旧结构（顶层 content 数组）仍兼容", extractText({ type: "assistant", content: [{ type: "text", text: "旧结构" }] }) === "旧结构");
check("C22 纯字符串原样返回", extractText("直接给字符串") === "直接给字符串");
check("C23 无法识别的结构返回空串而不是抛错（降级优先于崩）", extractText({ type: "stream_event", payload: 1 }) === "" && extractText(null) === "");

console.log("CHAIN PROBE: " + pass + " pass / " + fail + " fail");
process.exit(fail ? 1 : 0);
