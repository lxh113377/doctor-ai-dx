"""对话面契约（镜像侧）：意图识别 / 红旗前置 / 转人工 / 脱敏 / 后台鉴权。

镜像 frontend/tests/intents_guard.mjs 与 chat_api_guard.mjs 的核心判据。
**最重要的判据是 M1**：客服话术里塞进红旗症状，必须判red_flag 而不是 refund/order_query/tech_support。
这条判据一旦破，红线「危险信号不可被任何其他意图吞掉」就没了。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import chat as chat_mod  # noqa: E402

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


def d(text):
    return chat_mod.detect_intent(text)


# ---- 红旗闸门前置（本轮最关键的一组） ----
mixed = d("我要退挂号费，但是压榨样胸痛还冒冷汗")
check("M1 退费+压榨样胸痛 判 red_flag（不被 refund 吞掉）", mixed["intent"] == "red_flag", mixed["intent"])
check("M2 同上 命中红旗明细非空", len(mixed["flags"]) >= 1, str(len(mixed["flags"])))
check("M3 红旗时 need_human 恒为 False（红旗优先于人工请求）",
      d("转人工，胸痛压榨样冷汗")["intent"] == "red_flag" and d("转人工，胸痛压榨样冷汗")["need_human"] is False)
check("M4 红旗路径的 handoff reason_code 恒为 RED_FLAG",
      chat_mod.decide_handoff(intent=mixed["intent"], flags=mixed["flags"])["reason_code"] == "RED_FLAG")

# ---- 五类意图基本路由 ----
check("T1 退挂号费 => refund", d("我要退挂号费")["intent"] == "refund")
check("T2 检查报告 => order_query", d("检查报告在哪里看")["intent"] == "order_query")
check("T3 页面打不开 => tech_support", d("页面打不开")["intent"] == "tech_support")
check("T4 孩子高热惊厥 => general_medical", d("孩子高热惊厥怎么办")["intent"] == "general_medical")
check("T5 今天天气怎么样 => out_of_scope", d("今天天气怎么样")["intent"] == "out_of_scope")

# ---- 否定词否决（含反向对照，防恒真） ----
check("N1 「不退费」不得判 refund", d("我不退费，只是问一下")["intent"] != "refund", d("我不退费，只是问一下")["intent"])
check("N2 反向对照：去掉否定词后必须判回 refund", d("我要退费")["intent"] == "refund")
check("N3 无症状输入 confidence 恒为 0（不虚构置信度）", d("你好")["confidence"] == 0)

# ---- 转人工五类触发 ----
check("H1 超范围 => OUT_OF_SCOPE",
      chat_mod.decide_handoff(intent="out_of_scope")["reason_code"] == "OUT_OF_SCOPE")
check("H2 缺槽位 => MISSING_SLOT",
      chat_mod.decide_handoff(intent="order_query", missing_slot=True)["reason_code"] == "MISSING_SLOT")
check("H3 显式要人工 => USER_REQUESTED",
      chat_mod.decide_handoff(intent="general_medical", need_human=True)["reason_code"] == "USER_REQUESTED")
check("H4 弃权 => ABSTAIN",
      chat_mod.decide_handoff(intent="general_medical", abstain=True)["reason_code"] == "ABSTAIN")
check("H5 技术支持重复失败 => REPEATED_FAILURE",
      chat_mod.decide_handoff(intent="tech_support", unresolved_turns=2)["reason_code"] == "REPEATED_FAILURE")
check("H6 一切正常时不转人工",
      chat_mod.decide_handoff(intent="general_medical", confidence=0.9)["need_handoff"] is False)

# ---- 合规文案 ----
red = chat_mod.synthesize(intent="red_flag", flags=mixed["flags"])
check("C1 红旗话术含急诊指引", "120" in red["text"], red["text"][:60])
check("C2 任何话术都带「医生终审」合规声明", "医生终审" in red["text"])
check("C3 不得出现「替代医生」表述", "替代医生" not in red["text"].replace("不能替代医生面诊", ""))
svc = chat_mod.synthesize(intent="refund")
check("C4 客服话术带合规声明且不含医学结论", "医生终审" in svc["text"] and "建议服用" not in svc["text"])

# ---- 脱敏 ----
r = chat_mod.redact_pii("我叫张三，手机13812345678，身份证110101199003071234")
check("P1 手机号被掩码", "138****5678" in r["text"], r["text"])
check("P2 身份证被掩码", "110101199003071234" not in r["text"])
check("P3 姓名被掩码", "张三" not in r["text"], r["text"])
check("P4 反向对照：不含 PII 的文本原样返回",
      chat_mod.redact_pii("今天头晕有点疼")["text"] == "今天头晕有点疼")

# ---- 后台鉴权三态 ----
check("T5a 未配置令牌 => 503", chat_mod.authorize_admin("", "x")[1] == 503)
check("T5b 未提供令牌 => 401", chat_mod.authorize_admin("s3cret", "")[1] == 401)
check("T5c 错误令牌 => 403", chat_mod.authorize_admin("s3cret", "bad")[1] == 403)
check("T5d 正确令牌 => 放行", chat_mod.authorize_admin("s3cret", "s3cret")[0] is True)

# ---- 编排面 ----
out = chat_mod.handle_chat({"text": "我要退挂号费，但是压榨样胸痛还冒冷汗"})
check("O1 编排层红旗优先", out["intent"] == "red_flag" and out["red_flag"] is not None)
check("O2 镜像面如实回报未持久化（不假装已保存）", out["persisted"] is False and "Pages-only" in out["persist_reason"])
check("O3 mode恒为 deterministic（本面不调模型）", out["mode"] == "deterministic")
check("O4 缺槽位首轮 ⇒ 追问一轮（不直接转人工）",
      chat_mod.handle_chat({"text": "检查报告在哪里看"})["handoff"] is None
      and "请提供您的挂号单号" in chat_mod.handle_chat({"text": "检查报告在哪里看"})["answer"]["text"])
_escalate = chat_mod.handle_chat({
    "text": "我就是要退费嘛",
    "history": [
        {"role": "user", "content": "我要退费"},
        {"role": "assistant", "content": chat_mod.SLOT_ASK_TEXT + "\n\n" + chat_mod.COMPLIANCE_LINE},
    ],
})
check("O5 追问后仍缺 ⇒ MISSING_SLOT 转人工", _escalate["handoff"]["reason_code"] == "MISSING_SLOT",
      str(_escalate["handoff"]))
check("O5b 镜像面转人工工单号 HO- 形态", _escalate["handoff"]["ticket_id"].startswith("HO-"))
_carry = chat_mod.handle_chat({
    "text": "挂号号是12345678",
    "history": [
        {"role": "user", "content": "我要退费"},
        {"role": "assistant", "content": chat_mod.SLOT_ASK_TEXT + "\n\n" + chat_mod.COMPLIANCE_LINE},
    ],
})
check("O5c 追问后只回号 ⇒ 承接上轮意图（refund）且不转人工",
      _carry["intent"] == "refund" and _carry["handoff"] is None,
      f"intent={_carry['intent']} handoff={_carry['handoff']}")

print(f"\nCHAT MIRROR SUMMARY: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)