"""live 路径红线守卫（后端镜像面）——与 frontend/tests/live_path_guard.mjs 同判据。

覆盖率实测（2026-09-25，coverage.py 7.16.0）暴露的真实盲点：
后端所有测试都在 `os.environ.pop("DEEPSEEK_API_KEY")` 下跑 rule-fallback，
`llm.py` 仅 37% 覆盖——即线上生产实际走的 live 分支在镜像面上从未被执行。
本文件用桩注入 httpx.post，离线覆盖 live 分支与全部降级分支，逐条验证三条红线。
零真实网络、零真实密钥（桩 Key 为占位串，落盘即违反 P0.12，故只用字面假值且不写出）。
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from app import rag  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.services import engine  # noqa: E402

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


class FakeResp:
    def __init__(self, status_code=200, payload=None, raise_json=False):
        self.status_code = status_code
        self._payload = payload
        self._raise_json = raise_json

    def json(self):
        if self._raise_json:
            raise ValueError("bad body")
        return self._payload


def content_of(obj):
    return {"choices": [{"message": {"content": obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)}}]}


VALID_DX = {
    "primary": [
        {"name": "急性冠脉综合征（ACS）", "prob": "高优先级", "strength": "high",
         "reasons": ["典型压榨样胸痛伴冷汗放射痛"], "evidence_ids": ["kb-001"]},
        {"name": "自发性气胸", "prob": "需鉴别", "strength": "mid",
         "reasons": ["突发胸痛伴呼吸困难需警惕"], "evidence_ids": ["kb-005"]},
    ],
    "differential": [{"name": "支气管哮喘", "note": "需听诊哮鸣音鉴别", "evidence_ids": ["kb-024"]},
                     {"name": "焦虑障碍", "note": "须先排器质性", "evidence_ids": ["kb-051"]}],
    "faq": [{"q": "是否需转诊", "a": "按胸痛中心路径处理"}],
}

REAL_POST = httpx.post
HISTORY = [{"role": "user", "content": "压榨样胸痛伴冷汗，放射至左肩，持续两小时不缓解"}]
calls = []


def use_stub(handler):
    global calls
    calls = []

    def fake_post(url, headers=None, json=None, timeout=None, **kw):  # noqa: A002
        calls.append({"url": url, "headers": headers, "payload": json})
        return handler(url, json)
    httpx.post = fake_post


os.environ["DEEPSEEK_API_KEY"] = "sk-placeholder-not-a-real-key"
get_settings.cache_clear()

try:
    check("有 Key 时 llm_available 为真（否则本套件的 live 分支全为假通过）", engine.llm_available() is True)

    # 1) 合法 live 输出
    use_stub(lambda u, p: FakeResp(200, content_of(VALID_DX)))
    dx = engine.build_diagnosis("c1", HISTORY)
    check("合法输出走 live 分支", dx["mode"] == "live" and len(dx["primary"]) >= 2, f'{dx["mode"]}/{len(dx["primary"])}')
    check("live 请求带 json_object 响应格式", (calls[0]["payload"] or {}).get("response_format", {}).get("type") == "json_object")
    check("live 请求带 Bearer 鉴权头", str(calls[0]["headers"].get("Authorization", "")).startswith("Bearer "))

    # 2) 红线·引用白名单：模型编造 evidence_id 必须被剔除并回填合法引用
    bad = json.loads(json.dumps(VALID_DX))
    bad["primary"][0]["evidence_ids"] = ["kb-999", "kb-001", ""]
    bad["primary"][1]["evidence_ids"] = ["kb-777"]
    use_stub(lambda u, p: FakeResp(200, content_of(bad)))
    dx = engine.build_diagnosis("c1", HISTORY)
    leaked = [i for p in dx["primary"] for i in p["evidence_ids"] if not rag.has_evidence(i)]
    check("红线·白名单外 evidence_id 全部被剔除", not leaked, ",".join(leaked))
    check("红线·全非法时回填检索证据而非留空", all(p["evidence_ids"] for p in dx["primary"]))

    # 3) 红线·模型试图推翻红旗 → 规则层重算必须胜出
    defied = json.loads(json.dumps(VALID_DX))
    defied["primary"] = [{"name": "肌肉骨骼性胸痛", "prob": "高优先级", "strength": "high",
                          "reasons": ["无高危征象"], "evidence_ids": ["kb-001"]}]
    defied["flags"] = []
    use_stub(lambda u, p: FakeResp(200, content_of(defied)))
    dx = engine.build_diagnosis("c1", HISTORY)
    check("红线·模型返回 flags:[] 仍命中红旗", len(dx["flags"]) > 0 and "急性冠脉综合征" in dx["flags"][0], str(dx["flags"]))
    check("红线·flag_details 来自规则层", bool(dx["flag_details"]) and all(d.get("advice") for d in dx["flag_details"]))

    # 4) 无高危线索不得臆造红旗
    use_stub(lambda u, p: FakeResp(200, content_of(VALID_DX)))
    dx2 = engine.build_diagnosis("c2", [{"role": "user", "content": "鼻塞流涕两天，无发热"}])
    check("红线·无高危线索时不臆造红旗", len(dx2["flags"]) == 0, str(dx2["flags"]))

    # 5) 降级路径逐条
    fallback_cases = [
        ("非法 JSON 文本", lambda u, p: FakeResp(200, content_of("这不是JSON{{{"))),
        ("primary 为空数组", lambda u, p: FakeResp(200, content_of({"primary": [], "differential": [], "faq": []}))),
        ("HTTP 500", lambda u, p: FakeResp(500, None)),
        ("HTTP 429 限流", lambda u, p: FakeResp(429, None)),
        ("响应体缺 choices", lambda u, p: FakeResp(200, {})),
        ("json() 抛异常", lambda u, p: FakeResp(200, None, raise_json=True)),
        ("网络异常（等价超时/中断）", lambda u, p: (_ for _ in ()).throw(httpx.ConnectError("timeout"))),
    ]
    for name, handler in fallback_cases:
        use_stub(handler)
        out = engine.build_diagnosis("c1", HISTORY)
        check(f"降级·{name} → rule-fallback 且给原因",
              out["mode"] == "rule-fallback" and bool(out["fallback_reason"]), f'{out["mode"]}/{out["fallback_reason"]}')
        check(f"降级·{name} → 红旗不削弱", len(out["flags"]) > 0)

    # 6) 无 Key 零外呼
    use_stub(lambda u, p: (_ for _ in ()).throw(AssertionError("无 Key 也发起了调用")))
    os.environ.pop("DEEPSEEK_API_KEY", None)
    get_settings.cache_clear()
    out = engine.build_diagnosis("c1", HISTORY)
    check("无 Key 零外呼并降级", not calls and out["mode"] == "rule-fallback", f"calls={len(calls)}")

    # 7) 红线·报告缺 disclaimer 时注入医生终审默认文案
    os.environ["DEEPSEEK_API_KEY"] = "sk-placeholder-not-a-real-key"
    get_settings.cache_clear()
    use_stub(lambda u, p: FakeResp(200, content_of({
        "soap": {"subjective": "胸痛两小时", "objective": "BP 150/95", "assessment": "首先排除 ACS", "plan": "心电图+肌钙蛋白"},
        "conclusion": "建议尽快完成心电图"})))
    rep = engine.build_report("c1", HISTORY)
    check("红线·报告 disclaimer 含医生终审语义", any(k in (rep.get("disclaimer") or "") for k in ("医生", "终审", "参考")), rep.get("disclaimer"))
finally:
    httpx.post = REAL_POST
    os.environ.pop("DEEPSEEK_API_KEY", None)
    get_settings.cache_clear()

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
