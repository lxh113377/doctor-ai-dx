/**
 * 面2（Pages Functions，权威判定）↔ 面3（本服务，Agent 表达层）之间的桥。
 *
 * 判定权归属（不可协商）：
 *   意图识别 / 红旗闸门 / 弃权 / 是否转人工 / 引用白名单 —— 全部由面2 的确定性代码裁决。
 *   本文件只做两件事：把用户输入转交面2；把面2 的结构化结论决定是"交给 Agent 换措辞"还是"直出确定性话术"。
 *
 * 红旗旁路（红线 1 的最强形态）：面2 命中红旗时，本文件**完全不调用 Agent**——
 * 危险信号提示与急诊/转诊建议逐字直出面2，不经任何模型改写。这比"在提示里要求模型别改"强一个量级。
 */
import type { Request, Response } from "express";
import { phraseWithAgent, AGENT_TIMEOUT_MS, activeProviderId, listProviderIds } from "./agent.js";
import { probeSdk } from "./sdk_status.js";

/** 面2 基址：本地 wrangler pages dev 用 http://127.0.0.1:8788，线上用已部署的 Pages。 */
const CLINICAL_BASE = (process.env.MED_CHAT_API_BASE || "https://doctor-ai-dx.pages.dev").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = Number(process.env.MED_CHAT_TIMEOUT_MS || 20000);

/** 面2 契约响应（data 部分）。字段以面2 openapi.json 为准，此处只声明本桥真正读取的字段。 */
type ClinicalChatData = {
  conversation_id?: string;
  intent?: string;
  confidence?: number;
  answer?: { text?: string; citations?: Array<{ title?: string; source?: string; year?: string }> };
  abstain?: boolean;
  red_flag?: { name?: string; severity?: string; advice?: string } | null;
  handoff?: { reason_code?: string; reason_text?: string; ticket_id?: string } | null;
  mode?: string;
  version?: string;
};

export type MedChatResponse = ClinicalChatData & {
  /** 谁写了 answer.text：agent=Agent 表达层；deterministic=确定性话术直出（含红旗旁路） */
  answer_source: "agent" | "deterministic";
  /** 红旗是否触发了 Agent 旁路（旁路=true 时 answer_source 必为 deterministic） */
  red_flag_bypassed: boolean;
  /** Agent 降级原因（非空说明为什么走了确定性话术），供后台统计与守卫断言 */
  agent_error_code: string | null;
  agent_error_detail: string;
};

/**
 * 调面2 的 /api/chat。
 * 面2 不可达时**如实抛错**并让上层给 502——绝不用本地假数据冒充权威判定结果。
 */
async function callClinicalChat(payload: Record<string, unknown>): Promise<ClinicalChatData> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(CLINICAL_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await resp.json()) as { code?: number; message?: string; data?: ClinicalChatData };
    if (!resp.ok || body?.code !== 0) {
      console.error(`[medchat] 面2 拒绝：HTTP ${resp.status} code=${body?.code} msg=${body?.message || ""}`);
      const err = new Error("面2 辅诊服务拒绝了本次请求") as Error & { status?: number };
      err.status = resp.status >= 400 && resp.status < 500 ? resp.status : 502;
      throw err;
    }
    return (body.data || {}) as ClinicalChatData;
  } finally {
    clearTimeout(timer);
  }
}

/** 确定性话术直出时的兜底文案：面2 没给正文时用，绝不凭空编造医学内容。 */
function deterministicFallbackText(d: ClinicalChatData): string {
  if (d.red_flag?.advice) return d.red_flag.advice;
  if (d.answer?.text) return d.answer.text;
  if (d.handoff?.reason_text) return d.handoff.reason_text;
  return "本轮未取得可引用的确定性结论，建议线下由执业医生评估。";
}

/**
 * 编排：面2 判定 → （非红旗时）尝试 Agent 换措辞 → 失败即回落确定性话术。
 * mode 字段沿用既有 llm 口径（live / mock-fallback），新增 answer_source / red_flag_bypassed 给出细节。
 */
export async function orchestrateMedChat(payload: Record<string, unknown>): Promise<MedChatResponse> {
  const plan = await callClinicalChat(payload);

  const base = { ...plan, mode: plan.mode || "mock-fallback" } as MedChatResponse;

  // ---- 红旗旁路：命中即整条绕过 Agent，危险信号提示逐字直出 ----
  if (plan.red_flag && (plan.red_flag.name || plan.red_flag.advice)) {
    return {
      ...base,
      answer: { text: deterministicFallbackText(plan), citations: plan.answer?.citations || [] },
      answer_source: "deterministic",
      red_flag_bypassed: true,
      agent_error_code: null,
      agent_error_detail: "红旗命中，按红线要求不经模型改写",
    };
  }

  const outcome = await phraseWithAgent({
    userText: String(payload.text || ""),
    plan: {
      intent: plan.intent || "unknown",
      answer_text: deterministicFallbackText(plan),
      citations: (plan.answer?.citations || []).map((c) => ({
        title: c.title || "",
        source: c.source,
        year: c.year,
      })),
      handoff_reason: plan.handoff?.reason_text || null,
      abstain: !!plan.abstain,
    },
    history: Array.isArray(payload.history)
      ? (payload.history as Array<{ role: string; content: string }>)
      : [],
  });

  if (!outcome.ok) {
    return {
      ...base,
      answer: { text: deterministicFallbackText(plan), citations: plan.answer?.citations || [] },
      answer_source: "deterministic",
      red_flag_bypassed: false,
      agent_error_code: outcome.error_code,
      agent_error_detail: outcome.detail,
    };
  }

  return {
    ...base,
    mode: "live",
    answer: { text: outcome.text, citations: plan.answer?.citations || [] },
    answer_source: "agent",
    red_flag_bypassed: false,
    agent_error_code: null,
    agent_error_detail: "",
  };
}

/** Express handler：POST /api/medchat */
export async function handleMedChat(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  try {
    const out = await orchestrateMedChat(req.body || {});
    res.json({ code: 0, data: out });
    const ms = Date.now() - startedAt;
    if (ms > AGENT_TIMEOUT_MS) {
      console.error(`[medchat] 慢请求 ${ms}ms intent=${out.intent} source=${out.answer_source}`);
    }
  } catch (e) {
    const status = (e as { status?: number })?.status || 502;
    console.error(`[medchat] 失败：${String((e as Error)?.message || e).slice(0, 200)}`);
    // 错误响应只给医生可理解文案，不带堆栈与内部路径（对齐既有 API 失败口径）
    res
      .status(status)
      .json({ code: status, message: "对话服务暂时不可用，请稍后重试或直接前往线下就诊" });
  }
}

/** Express handler：GET /api/medchat/status —— 如实回报 SDK 与降级状态，前端据此显示模式徽标。 */
export async function handleMedStatus(_req: Request, res: Response): Promise<void> {
  const status = await probeSdk();
  res.json({
    code: 0,
    data: {
      sdk: status,
      clinical_base: CLINICAL_BASE,
      agent_timeout_ms: AGENT_TIMEOUT_MS,
      // S7：当前生效的表达层 provider 与在册清单（换供应商不改编排层的实证面）。
      provider: activeProviderId(),
      providers: listProviderIds(),
    },
  });
}