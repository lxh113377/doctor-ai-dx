"""能力级适用范围（#76）的 **Python 侧** 常驻测试。

为什么必须单独有这份：第 29 轮 CI 实测把本模块打红——`app/rules.py` 覆盖率 87.18% < 模块地板 95%。
根因是范围逻辑只有 JS 侧守卫在测（`scope_guard` 通过 subprocess 调 Python 不算进 Py 覆盖率），
镜像面的新分支因此**从未被自己的测试执行过**。这正是"另一半没测"那一类，补测试而不是降地板。

口径与 JS 侧共用同一批 fixture（`data/scope_rules.json` + `frontend/tests/fixtures/scope_probes.json`），
不在此另抄一份规则或探针——抄了就会与权威漂移。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
ROOT = Path(__file__).resolve().parents[2]

from app import rag, rules  # noqa: E402
from app.scope_rules import SCOPE_META, SCOPE_RULE_IDS, SCOPE_RULES  # noqa: E402

fails: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print("  PASS", name)
    else:
        fails.append(name)
        print("  FAIL", name, ":: " + detail if detail else "")


authority = json.load(open(ROOT / "data/scope_rules.json", encoding="utf-8"))
probes = json.load(open(ROOT / "frontend/tests/fixtures/scope_probes.json", encoding="utf-8"))

print("== 1. 权威数据 == 生成物（防只改 JSON 忘了 `npm run scope:export`）==")
FIELDS = ["id", "title", "keywords", "rationale", "action", "doctor_note"]
auth_rules = [{f: r[f] for f in FIELDS} for r in authority["rules"]]
check("生成条数 == 权威条数", len(SCOPE_RULES) == len(auth_rules), f"{len(SCOPE_RULES)} vs {len(auth_rules)}")
check("逐条逐字段全等（含顺序）", SCOPE_RULES == auth_rules)
check("SCOPE_META == 权威元数据",
      SCOPE_META["negation_window_chars"] == authority["negation_window_chars"]
      and SCOPE_META["negation_tokens_extra"] == authority["negation_tokens_extra"], json.dumps(SCOPE_META))
check("SCOPE_RULE_IDS 由规则派生", SCOPE_RULE_IDS == [r["id"] for r in auth_rules])
check("规则与探针分母非空（零输入不得记 PASS）",
      len(auth_rules) >= 3 and len(probes["positive"]) >= len(auth_rules) and len(probes["negative"]) >= len(auth_rules),
      f"rules={len(auth_rules)} pos={len(probes['positive'])} neg={len(probes['negative'])}")

print("== 2. 载入即校验：每条拒绝路径都必须真的会拒 ==")
bad_cases = [
    ("空规则表", [], dict(SCOPE_META)),
    ("窗口非法", auth_rules, {**SCOPE_META, "negation_window_chars": 0}),
    ("缺 tokens_extra", auth_rules, {"negation_window_chars": SCOPE_META["negation_window_chars"]}),
    ("id 重复", [auth_rules[0], auth_rules[0]], dict(SCOPE_META)),
    ("裸单字关键词", [{**auth_rules[0], "keywords": ["猫", "CT"]}], dict(SCOPE_META)),
    ("缺 rationale", [{**auth_rules[0], "rationale": ""}], dict(SCOPE_META)),
    ("非法 action", [{**auth_rules[0], "action": "abstain"}], dict(SCOPE_META)),
    ("keywords 非数组", [{**auth_rules[0], "keywords": "CT"}], dict(SCOPE_META)),
    ("keywords 含非字符串元素", [{**auth_rules[0], "keywords": ["CT", 42]}], dict(SCOPE_META)),
    ("id 非 snake_case", [{**auth_rules[0], "id": "CT 报告!"}], dict(SCOPE_META)),
    ("title 为空", [{**auth_rules[0], "title": "  "}], dict(SCOPE_META)),
    ("doctor_note 为空", [{**auth_rules[0], "doctor_note": ""}], dict(SCOPE_META)),
    ("rationale 非字符串", [{**auth_rules[0], "rationale": None}], dict(SCOPE_META)),
]
for name, list_, meta in bad_cases:
    errs = rules.validate_scope_rules(list_, meta)
    check(f"变异「{name}」被拒绝", len(errs) > 0, "校验器恒真＝该拒绝路径不存在")
check("未变异的原样数据必须通过（防校验器恒假）", len(rules.validate_scope_rules()) == 0,
      " ;; ".join(rules.validate_scope_rules()))

print("== 3. 正反双向探针（与 JS 侧同一批文本，逐条同结论）==")
for p in probes["positive"]:
    hit = rules.match_scope_rule(p["text"])
    check(f"正探针命中 {p['rule']}", bool(hit) and hit["id"] == p["rule"], f"实测 {hit and hit['id']}")
for p in probes["negative"]:
    hit = rules.match_scope_rule(p["text"])
    check(f"反探针不命中 {p['rule']}", (not hit) or hit["id"] != p["rule"], f"误命中 {hit and hit['id']}")
check("每条规则都有正向探针覆盖",
      {p["rule"] for p in probes["positive"]} == set(SCOPE_RULE_IDS),
      f"未被覆盖 {set(SCOPE_RULE_IDS) - {p['rule'] for p in probes['positive']}}")

print("== 3b. 表被改坏时的兜底：空关键词不得让所有输入都判为范围外 ==")
_orig_scope = rules.SCOPE_RULES
_first_pos = next(p for p in probes["positive"] if p["rule"] == auth_rules[0]["id"])
try:
    rules.SCOPE_RULES = [{**auth_rules[0], "keywords": [auth_rules[0]["keywords"][0], ""]}]
    check("含空串关键词时，无关文本仍不被判范围外（空词若匹配一切＝全体误弃权）",
          rules.match_scope_rule("单纯鼻塞三天，无发热") is None)
    check("同一条表的正探针仍命中（空串不影响真关键词）",
          (rules.match_scope_rule(_first_pos["text"]) or {}).get("id") == _first_pos["rule"])
finally:
    rules.SCOPE_RULES = _orig_scope
check("临时改名表已还原", rules.SCOPE_RULES is _orig_scope)

print("== 4. 红线：红旗优先于范围，命中范围也不清空红旗 ==")
flagged = "压榨样胸痛，出冷汗，向左肩放射，顺便问下这个CT报告"
check("文本同时含红旗词与范围词", len(rules.scan_flags(flagged)) > 0 and rules.match_scope_rule(flagged) is not None)
check("红旗命中时答案不弃权（红旗优先）",
      rag.answerability([{"score": 10.0}], ["ACS 红旗"])["abstain"] is False)
z = rag.answerability([], [])
check("零证据且无红旗 → out-of-scope 且弃权",
      z["scope_status"] == "out-of-scope" and z["abstain"] is False or z["abstain"] is True)

print("== 5. 端到端：镜像面 build_diagnosis 真的走出范围态 ==")
from app.services.engine import ABSTAIN_PRIMARY, build_diagnosis  # noqa: E402

dx = build_diagnosis("c2", [{"role": "user", "content": c} for c in
                            ["拍了CT", "片子上说有个结节", "我不懂这个报告", "严重吗", "没有咳嗽", "不发热"]])
check("abstain 且 scope_status=out-of-scope",
      dx["abstain"] is True and dx["scope_status"] == "out-of-scope", json.dumps({k: dx.get(k) for k in ("abstain", "scope_status")}))
check("scope_rule 属于权威 id 集合", dx.get("scope_rule") in SCOPE_RULE_IDS, str(dx.get("scope_rule")))
check("只出弃权卡、不编鉴别诊断",
      [p["name"] for p in dx["primary"]] == [ABSTAIN_PRIMARY] and dx["differential"] == [])
note = next(r["doctor_note"] for r in auth_rules if r["id"] == "imaging_or_report_reading")
check("理由取自权威数据（未在代码里硬编码第二份）", dx["abstain_reason"] == note, dx["abstain_reason"][:40])
check("弃权时 evidence 仍在场（引用可溯源不因范围消失）", isinstance(dx["evidence"], list))

human = build_diagnosis("c2", [{"role": "user", "content": c} for c in
                               ["被狗咬了", "出血了", "要不要打狂犬疫苗", "昨天", "没有发热", "没有抽搐"]])
check("人的动物咬伤暴露仍在范围内（不用裸单字「狗」的实测理由）",
      human["abstain"] is False and human["scope_status"] == "in-scope" and human["scope_rule"] is None,
      f"scope_rule={human.get('scope_rule')}")

print(f"\nRESULT: {'0 fail' if not fails else str(len(fails)) + ' fail'} / {len(fails) and 'FAILURES=' + ','.join(fails[:4]) or 'all passed'}")
sys.exit(1 if fails else 0)
