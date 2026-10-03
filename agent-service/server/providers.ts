/**
 * 面3 表达层 provider 适配器（r91，S7；对标 LibreChat 的模型适配层形态）。
 *
 * 为什么要有这一层（r90 报告 §1 维2 / §2.8）：此前 agent.ts 硬编码单路
 * `@tencent-ai/agent-sdk`，换供应商要改代码。适配器把「措辞表达」抽象成接口：
 * 新增一路模型 = 新增一个 provider 文件并注册，编排层（medchat.ts）与降级契约零改动。
 *
 * 判定权归属不变（红线 1）：任何 provider 都只做「措辞组织」，红旗旁路 / 弃权 / 转人工
 * 仍由面2 的确定性代码裁决（medchat.ts bypass），provider 无权修改医学判断。
 */
import type { SdkStatus } from "./sdk_status.js";

/** provider 探测结果：ready 即允许参与编排；reason 必须能解释自己（不谎报）。 */
export type ProbeResult = {
  ready: boolean;
  reason: string;
  /** codebuddy provider 附加的原始 SDK 状态；其它 provider 可为 null */
  sdk?: SdkStatus | null;
};

/** 编排层交给 provider 的输入（只读：面2 已裁决的结构化结论）。 */
export type PhraseInput = {
  userText: string;
  plan: {
    intent: string;
    answer_text: string;
    citations: Array<{ title: string; source?: string; year?: string }>;
    handoff_reason: string | null;
    abstain: boolean;
  };
  history: Array<{ role: string; content: string }>;
};

export type AgentOutcome = {
  ok: boolean;
  /** 表达后的文本；ok=false 时为空串，由调用方回落到确定性文本 */
  text: string;
  /** 归一后的错误码，便于守卫断言与后台统计 */
  error_code: "sdk-unavailable" | "sdk-timeout" | "sdk-error" | null;
  detail: string;
};

/** 表达层 provider 接口：新增一路模型 = 实现它并注册进 PROVIDERS。
 *  phrase 接收 dispatcher 已完成的 probe 结果（探测一次、全程复用，不做二次 CLI 往返）。 */
export type ExpressionProvider = {
  readonly id: string;
  readonly description: string;
  probe(): Promise<ProbeResult>;
  phrase(input: PhraseInput, probe: ProbeResult): Promise<AgentOutcome>;
};

/** 内置确定性回显 provider：原样返回面2 的确定性话术（ok=true）。
 *  仅用于接线验证与离线演示——只有显式 AGENT_PROVIDER=echo 才会启用，
 *  此时 answer_source=agent 与文本逐字相同是**预期行为**（operator 显式选择，非静默降级）。 */
export const echoProvider: ExpressionProvider = {
  id: "echo",
  description: "确定性回显（不调模型，接线验证/离线演示用）",
  async probe() {
    return { ready: true, reason: "echo provider 恒可用（不依赖任何 CLI/密钥）", sdk: null };
  },
  async phrase(input: PhraseInput): Promise<AgentOutcome> {
    return { ok: true, text: input.plan.answer_text, error_code: null, detail: "echo provider：原样回显确定性话术" };
  },
};

/**
 * 规则答复 provider（r96）：**不调任何模型**，把面2 的确定性答复正文与引用条目拼成一段
 * 带来源标签的回复。存在的理由不是「省一次调用」，而是给三类场景一个可用的表达路：
 *   ① 生产环境无 Node / 无登录态（Agent SDK 必然拿不到）；
 *   ② 评审现场要演示「引用可溯源」而不能等待模型；
 *   ③ 模型超时后的降级目标——比直接抛错给医生看空白页好。
 * 它与 echo 的区别：echo 逐字回显（接线验证用），rule 会**组织**引用标签（可用输出）。
 */
export const ruleProvider: ExpressionProvider = {
  id: "rule",
  description: "知识库规则答复（不调模型，引用条目拼成带来源标签的回复）",
  async probe() {
    return { ready: true, reason: "rule provider 恒可用（纯确定性拼装，不依赖 CLI/密钥）", sdk: null };
  },
  async phrase(input: PhraseInput): Promise<AgentOutcome> {
    const parts: string[] = [input.plan.answer_text];
    if (input.plan.citations.length > 0) {
      parts.push("依据：" + input.plan.citations.map((c) => c.title + (c.source ? `（${c.source}）` : "")).join("；"));
    }
    if (input.plan.handoff_reason) parts.push(input.plan.handoff_reason);
    if (input.plan.abstain) parts.push("以上证据有限，建议由执业医生面诊确认。");
    return { ok: true, text: parts.join("\n"), error_code: null, detail: "rule provider：确定性拼装" };
  },
};

/**
 * 降级链的四段形态（r96）。**这是「回答是谁给的」那四个取值的唯一真相源**，
 * 与面2 chat_store.js 的 PROVIDERS 枚举同口径；两处必须同步改，否则后台统计会把
 * rule 记成 codebuddy，而没人能从数字上看出来。
 */
export const FALLBACK_CHAIN = Object.freeze([
  Object.freeze({ kind: "codebuddy", when: "CodeBuddy CLI 可执行且已登录，Agent 表达成功" }),
  Object.freeze({ kind: "llm", when: "换成非 CodeBuddy 的模型通道表达成功" }),
  Object.freeze({ kind: "rule", when: "红旗旁路 / 弃权 / 选用 rule provider ⇒ 确定性话术直出" }),
  Object.freeze({ kind: "fallback", when: "表达层不可用或超时 ⇒ 回落确定性文本，标记 fallback" }),
] as const);

export type AttributionKind = (typeof FALLBACK_CHAIN)[number]["kind"];

/** 表达层 provider id → 归因 provider 形态。echo/rule 都属「不调模型的确定性输出」⇒ 记 rule。 */
const ATTRIBUTION_BY_PROVIDER: Record<string, AttributionKind> = {
  codebuddy: "codebuddy",
  llm: "llm",
  echo: "rule",
  rule: "rule",
};

export function providerAttributionKind(providerId: string): AttributionKind {
  return ATTRIBUTION_BY_PROVIDER[providerId] || "fallback";
}

const REGISTRY: Record<string, ExpressionProvider> = {
  echo: echoProvider,
  rule: ruleProvider,
};

export function registerProvider(p: ExpressionProvider): void {
  REGISTRY[p.id] = p;
}

export function providerIds(): string[] {
  return Object.keys(REGISTRY).sort();
}

/**
 * 当前生效 provider：AGENT_PROVIDER 显式点名（必须在册，否则 fail-closed 回默认并说明原因），
 * 缺省 = codebuddy（现役默认路）。
 */
export function getActiveProvider(): { provider: ExpressionProvider | null; warning: string | null } {
  const wanted = (process.env.AGENT_PROVIDER || "").trim();
  if (!wanted) {
    // 默认 provider 由 agent.ts 注册；此处只按 id 查。
    const def = REGISTRY["codebuddy"] || null;
    return { provider: def, warning: def ? null : "默认 provider codebuddy 未注册" };
  }
  const p = REGISTRY[wanted];
  if (!p) {
    return {
      provider: REGISTRY["codebuddy"] || null,
      warning: `AGENT_PROVIDER=${wanted} 不在注册表（可用: ${providerIds().join(",")}）——已回退 codebuddy`,
    };
  }
  return { provider: p, warning: null };
}
