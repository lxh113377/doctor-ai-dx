/**
 * 面3 表达层编排入口（原「CodeBuddy Agent SDK 封装」，r91 S7 起改为 provider 适配器形态）。
 *
 * 职责边界（重要）：本模块只做「表达层」——把面2 已经裁决好的结构化结论（intent / answer / red_flag）
 * 组织成更自然的措辞。**它无权改动任何医学判断**：红旗、意图、是否弃权、是否转人工
 * 全部由面2 的确定性代码决定，见 medchat.ts 的 bypass 规则。
 *
 * 为什么必须有这一层而不是直接让 LLM 答：项目红线「红旗规则层必须独立于 LLM，命中不可被模型覆盖」。
 * 表达层可以换措辞，红旗路径则**整条绕过 LLM**（medchat.ts 里 red_flag 命中即直出确定性话术）。
 *
 * S7：具体模型路由进 providers.ts 的适配器（现役 codebuddy + 内置 echo 回显），
 * 换/增供应商 = 实现 ExpressionProvider 并 registerProvider，本文件编排逻辑零改动。
 */
import { unstable_v2_createSession } from "@tencent-ai/agent-sdk";
import { probeSdk, type SdkStatus } from "./sdk_status.js";
import {
  getActiveProvider,
  providerIds,
  registerProvider,
  type AgentOutcome,
  type ExpressionProvider,
  type PhraseInput,
  type ProbeResult,
} from "./providers.js";

/** 单次模型硬超时：与既有面 SLOW_MS=8000 同族口径，医生关键路径上不允许无限等。 */
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 8000);

/** 表达层系统提示：把红线写进提示只是双保险，真正的保障是 medchat.ts 的 bypass。 */
const SYSTEM_PROMPT = [
  "你是基层医疗场景的对话表达层，服务于「辅助参考 · 医生终审」定位。",
  "硬性约束：",
  "1. 只做措辞组织，不得新增任何诊断结论、药品剂量、处置医嘱。",
  "2. 不得改变、弱化或省略上游给出的危险信号提示与转诊建议。",
  "3. 不得声称可替代医生，不得使用「替代医生」「确诊」等表述。",
  "4. 上游标记弃权（证据不足）时，必须如实说明证据不足并建议线下就诊，不得硬答。",
  "5. 上游标记需转人工时，必须明确告知已转人工并复述工单号。",
  "输出简体中文，简洁、克制、可直接显示给医生，不使用 Markdown 标题。",
].join("\n");

export type { AgentOutcome, PhraseInput } from "./providers.js";

/**
 * 解析 SDK 要用的 CLI 路径：显式环境变量优先（探测已验证可执行），否则交给 SDK 自己在 PATH 找。
 * 注意 `pathToCodebuddyCode` 是 SDK 官方定位 CLI 的选项，见 docs/zh/cli/sdk-typescript。
 */
function cliPathOption(status: SdkStatus): Record<string, unknown> {
  return status.cli_path ? { pathToCodebuddyCode: status.cli_path } : {};
}

/** codebuddy provider：现役默认路，经 @tencent-ai/agent-sdk（子进程调 CodeBuddy CLI）表达。 */
const codebuddyProvider: ExpressionProvider = {
  id: "codebuddy",
  description: "CodeBuddy Agent SDK（子进程 CLI）——现役默认表达路",
  async probe(): Promise<ProbeResult> {
    const status = await probeSdk();
    return {
      ready: status.state === "ready",
      reason: status.reason,
      sdk: status,
    };
  },
  async phrase(input: PhraseInput, probe: ProbeResult): Promise<AgentOutcome> {
    const status = probe.sdk;
    if (!status || status.state !== "ready") {
      return { ok: false, text: "", error_code: "sdk-unavailable", detail: status ? status.reason : "SDK 状态缺失" };
    }
    const cite = input.plan.citations
      .map((c) => "- " + c.title + (c.source ? "（" + c.source + (c.year ? " " + c.year : "") + "）" : ""))
      .join("\n");

    const prompt = [
      "【上游结构化结论】",
      "意图：" + input.plan.intent,
      "证据不足需弃权：" + (input.plan.abstain ? "是" : "否"),
      "需转人工：" + (input.plan.handoff_reason ? input.plan.handoff_reason : "否"),
      "确定性答复正文：",
      input.plan.answer_text,
      cite ? "\n【可引用证据（只允许引用以下条目，不得新增）】\n" + cite : "\n【可引用证据】无",
      "\n【用户本轮输入】\n" + input.userText.slice(0, 500),
      "请把上述结论改写为一段自然、简洁、面向医生的回复。不得新增结论或证据。",
    ].join("\n");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

    try {
      const session = await unstable_v2_createSession({
        systemPrompt: SYSTEM_PROMPT,
        maxTurns: 1,
        ...cliPathOption(status),
      } as Record<string, unknown>);

      let acc = "";
      for await (const msg of session.sendMessage(prompt)) {
        if (controller.signal.aborted) break;
        const chunk = extractText(msg);
        if (chunk) acc += chunk;
      }

      clearTimeout(timer);
      const text = acc.trim();
      if (!text) return { ok: false, text: "", error_code: "sdk-error", detail: "Agent 返回空文本" };
      return { ok: true, text, error_code: null, detail: "" };
    } catch (e) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      const detail = String((e as Error)?.message || e).slice(0, 200);
      console.error("[agent] " + (aborted ? "超时" : "失败") + ": " + detail);
      return {
        ok: false,
        text: "",
        error_code: aborted ? "sdk-timeout" : "sdk-error",
        detail,
      };
    }
  },
};

registerProvider(codebuddyProvider);

/**
 * 把结构化结论交给当前生效 provider 做措辞。
 * 任何失败都**不抛异常**，而是返回 ok=false 让调用方回落到确定性话术——
 * 「降级」必须是可测的确定行为，而不是靠运气。
 */
export async function phraseWithAgent(input: PhraseInput): Promise<AgentOutcome> {
  const { provider, warning } = getActiveProvider();
  if (warning) console.error("[agent] " + warning);
  if (!provider) {
    return { ok: false, text: "", error_code: "sdk-unavailable", detail: "无可用表达层 provider" };
  }
  const probe = await provider.probe();
  if (!probe.ready) {
    return { ok: false, text: "", error_code: "sdk-unavailable", detail: probe.reason };
  }
  return provider.phrase(input, probe);
}

/** 当前生效 provider id（供 /api/medchat/status 如实回报）。 */
export function activeProviderId(): string {
  const { provider } = getActiveProvider();
  return provider ? provider.id : "(none)";
}

/** 在册 provider 清单（供 status 端点与运维排查）。 */
export function listProviderIds(): string[] {
  return providerIds();
}

/** SDK 消息结构随版本变动，这里只做宽容提取：拿到文本即用，拿不到就当空。 */
function extractText(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) =>
        c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string"
          ? String((c as Record<string, unknown>).text)
          : "",
      )
      .join("");
  }
  return "";
}
