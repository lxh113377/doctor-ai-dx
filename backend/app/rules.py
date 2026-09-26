"""危险信号规则引擎（红旗拦截层）——镜像 frontend/functions/lib/rules.js。
独立于 LLM：可解释、可单测，评审安全叙事核心。
设计：关键词须特异（防"出冷汗"等词单独误触发）；支持血压数值解析；命中即强制转诊。
"""
import re
import unicodedata
from typing import Any

from .scope_rules import SCOPE_META, SCOPE_RULES

# 两张规则表都是异构字面量表（keywords: list[str] 与 all: list[list[str]] 并存），
# 第十五轮 mypy 实测：不标注 ⇒ 两个 for 循环复用同名变量被推断成 dict[str, Sequence[str]]，
# 第二条表的赋值即判不兼容（[assignment]），这正是"红旗表加字段就静默漂移"的类型层暴露。
# 与生成物 knowledge.py 同一口径：数据表标 Any，逻辑函数标具体类型。
DANGER_RULES: list[dict[str, Any]] = [
    {"name": "疑似急性冠脉综合征（ACS）红旗",
     "keywords": ["压榨", "紧缩", "胸痛放射", "胸痛向左肩", "胸痛向后背", "向左肩臂放射", "心前区闷痛"],
     "severity": "高",
     "advice": "压榨/紧缩样胸痛伴放射痛属高危征象，按急性胸痛路径处理：即刻 12 导联心电图 + 肌钙蛋白，尽快联系胸痛中心转运。"},
    {"name": "疑似主动脉夹层红旗",
     "keywords": ["撕裂样", "前胸背痛", "双上肢血压差", "脉搏不对称", "刀割样痛"],
     "severity": "高",
     "advice": "剧烈撕裂样胸痛高度提示主动脉夹层，避免使用抗凝药物，尽快影像学确认并转诊。"},
    {"name": "疑似肺栓塞红旗",
     "keywords": ["突发呼吸困难", "突发气促", "D-二聚体", "单侧下肢肿", "下肢肿胀", "制动后气促"],
     "severity": "高",
     "advice": "突发呼吸困难伴下肢肿/D-二聚体线索应考虑肺栓塞，评估抗凝禁忌后进一步影像确认。"},
    {"name": "意识障碍/循环不稳定红旗",
     "keywords": ["晕厥", "晕倒", "意识不清", "意识障碍", "不省人事", "血压下降", "休克"],
     "severity": "高",
     "advice": "意识障碍或血流动力学不稳定属濒危等级，优先处置并尽快转运，不宜基层滞留。"},
    {"name": "消化道出血红旗",
     "keywords": ["呕血", "黑便", "柏油样便", "咖啡色呕吐物", "便血"],
     "severity": "高",
     "advice": "呕血/黑便提示消化道出血，评估循环状态，必要时急诊胃镜与补液输血。"},
    {"name": "呼吸困难红旗",
     "keywords": ["呼吸困难", "发绀", "憋喘", "静息气促", "喘不上气"],
     "severity": "中",
     "advice": "静息状态仍呼吸困难的危急重程度较高，需评估氧合（SpO2、血气）并决定转运。"},
    {"name": "急腹症/腹膜炎红旗",
     "keywords": ["腹膜刺激", "反跳痛", "压痛拒按", "腹部硬", "板状腹", "腹痛进行性加重", "腹痛加重", "一按更痛"],
     "severity": "高",
     "advice": "腹痛伴腹膜刺激征或进行性加重提示外科急症，应禁食补液、尽快转诊，不宜基层观察。"},
    {"name": "高血压急症红旗",
     "keywords": ["血压骤升", "血压很高", "视物模糊伴头痛", "高血压危象"],
     "severity": "高",
     "advice": "血压显著升高伴靶器官损害症状（剧烈头痛、视物模糊、胸痛）为高血压急症，需静脉降压并急诊处理，不宜口服药观察。"},
    {"name": "霹雳样头痛/颅内急症红旗",
     "keywords": ["霹雳样", "突发剧烈头痛", "一生中最痛", "颈项强直"],
     "severity": "高",
     "advice": "突发霹雳样剧烈头痛高度提示蛛网膜下腔出血，紧急影像学评估并转诊，勿按普通头痛处理。"},
    {"name": "急性会厌炎/上气道梗阻红旗",
     "keywords": ["流涎", "喉部紧缩", "端坐呼吸", "说话含糊"],
     "severity": "高",
     "advice": "剧烈咽痛伴流涎不能下咽、说话含糊或呼吸困难，警惕急性会厌炎致上气道梗阻窒息，禁止反复压舌检查，立即转诊并备气道。"},
    {"name": "过敏性休克/血管性水肿红旗",
     "keywords": ["口唇肿胀", "眼睑肿胀", "全身风团伴气促", "喉头水肿"],
     "severity": "高",
     "advice": "皮疹伴口唇/眼睑肿胀、喉部紧缩或呼吸困难提示血管性水肿/过敏性休克，立即肌注肾上腺素并急诊转运，勿口服药观察。"},
    {"name": "马尾综合征红旗",
     "keywords": ["鞍区麻木", "大小便失禁", "会阴麻木", "尿不出伴下肢无力"],
     "severity": "高",
     "advice": "腰痛伴鞍区麻木、大小便功能障碍或进行性下肢无力提示马尾综合征，属外科急症，24–48 小时内急诊手术减压，立即转诊。"},
    {"name": "视力骤降/眼科急症红旗",
     "keywords": ["视力骤降", "突然看不见", "视野幕帘遮挡", "眼痛伴虹圈"],
     "severity": "高",
     "advice": "突发视力显著下降或视野幕帘遮挡提示视网膜血管阻塞/视网膜脱离，救治以小时计，立即转诊眼科急诊，基层不得观察等待。"},
]

# 组合规则：多线索同时命中才触发（表达临床组合逻辑，降低单一非特异词误报）
COMBO_RULES: list[dict[str, Any]] = [
    {"name": "异位妊娠（宫外孕）破裂红旗",
     "all": [["停经", "闭经", "月经没来"], ["阴道出血", "下腹剧痛", "腹痛", "腹部疼痛"], ["晕厥", "头晕", "面色苍白", "血压下降", "肩部放射痛"]],
     "severity": "高",
     "advice": "育龄女性停经后阴道出血伴下腹剧痛及晕厥/面色苍白，高度警惕异位妊娠破裂内出血：立即尿妊娠试验与超声，禁食开放静脉并紧急转诊，不可按痛经或胃肠炎处理。"},
    {"name": "肠套叠红旗（婴幼儿）",
     "all": [["哭闹", "阵发", "婴幼儿", "小儿", "孩子"], ["果酱样便", "血便", "呕吐", "面色苍白"]],
     "severity": "高",
     "advice": "婴幼儿阵发性哭闹伴呕吐、面色苍白或果酱样血便高度提示肠套叠，属儿科急症：禁食并立即转诊空气灌肠复位，超 48 小时或精神萎靡提示肠坏死。"},
    {"name": "急性尿潴留红旗",
     "all": [["尿不出", "不能排尿", "无尿"], ["下腹胀痛", "腹痛", "老年男性"]],
     "severity": "中",
     "advice": "完全不能排尿伴下腹胀痛为急性尿潴留，需导尿减压并转诊泌尿外科，警惕梗阻性肾损害。"},
    {"name": "脓毒症红旗",
     "all": [["发热", "高热", "寒战", "感染", "尿痛", "咳嗽", "伤口"],
             ["意识改变", "意识不清", "意识模糊", "说胡话", "晕厥", "精神差", "嗜睡", "呼吸急促", "气促", "少尿", "尿量明显减少", "无尿", "血压下降", "血压偏低", "末梢湿冷"]],
     "severity": "高",
     "advice": "感染基础上出现意识改变、呼吸急促、少尿或血压下降提示脓毒症，死亡风险随延迟上升：留取培养、液体复苏、尽早抗菌并紧急转诊。"},
]

_HYPERTENSION_ADVICE = next(r["advice"] for r in DANGER_RULES if "高血压急症" in r["name"])

# ---------- 红旗表载入即校验（第三十轮 #83，镜像端与 rules.js 同语义）----------
# 红旗层是三条红线里唯一"数据即代码"的表；表坏＝危险信号漏报，或多条同名被去重分支静默合并成一条。
# 规格抄 peer：kheireddinedev00/Medico `triage/rules.py`（gh api 实测 size=13599B sha=19fc7fcc）——
# 不变量写在注释里、载入即 raise、错误信息点名违规项、无降级模式。
RED_FLAG_SEVERITIES = ["高", "中", "低"]


def _all_punct_or_blank(s: str) -> bool:
    """纯标点/符号/空白——分词层（第二十七轮）已把这类字符整体剔除，这样的关键词永不命中。"""
    return all(unicodedata.category(ch)[0] in ("P", "S", "Z") or ch.isspace() for ch in s)


def validate_red_flag_rules(danger: list | None = None, combo: list | None = None) -> list[str]:
    danger = DANGER_RULES if danger is None else danger
    combo = COMBO_RULES if combo is None else combo
    errs: list[str] = []
    owner: dict[str, str] = {}

    def terms(vals, at: str, where: str) -> None:
        if not isinstance(vals, list) or not vals:
            errs.append(f"{at}: {where} 须为非空数组")
            return
        for k in vals:
            if not isinstance(k, str) or not k.strip():
                errs.append(f"{at}: {where} 含空值或非字符串项 {k!r}")
                continue
            if len(k.strip()) < 2:
                errs.append(f"{at}: {where}「{k}」是裸单字（子串会横扫全文，第二十四轮假阳性同族）")
            elif _all_punct_or_blank(k.strip()):
                errs.append(f"{at}: {where}「{k}」是纯标点/空白（分词层已剔除标点 ⇒ 永不命中＝死规则）")

    def one(r, i: int, kind: str) -> None:
        if not isinstance(r, dict):
            errs.append(f"{kind}#{i}: 规则须为对象")
            return
        raw = r.get("name")
        nm = raw.strip() if isinstance(raw, str) else ""
        at = f"{kind}#{i}({nm or '?'})"
        if not nm:
            errs.append(f"{at}: name 缺失或为空")
        elif nm in owner:
            errs.append(f"{at}: name 与 {owner[nm]} 重复（同名会被去重分支静默合并＝少报一条危险信号）")
        else:
            owner[nm] = at
        if r.get("severity") not in RED_FLAG_SEVERITIES:
            errs.append(f"{at}: severity 只能是 {'/'.join(RED_FLAG_SEVERITIES)}，实测 {r.get('severity')!r}")
        adv = r.get("advice")
        if not isinstance(adv, str) or len(adv.strip()) < 10:
            errs.append(f"{at}: advice 缺失或短于 10 字（医生看不到处置＝等于没提示）")
        if kind == "DANGER":
            terms(r.get("keywords"), at, "keywords")
        else:
            groups = r.get("all")
            if not isinstance(groups, list) or len(groups) < 2:
                errs.append(f"{at}: 组合规则须 ≥2 组线索（单组等价于关键词规则，放这里只会掩盖分母）")
            else:
                for gi, g in enumerate(groups):
                    terms(g, f"{at}/组{gi + 1}", "线索")

    for i, r in enumerate(danger or []):
        one(r, i, "DANGER")
    for i, r in enumerate(combo or []):
        one(r, i, "COMBO")
    if len(danger or []) + len(combo or []) == 0:
        errs.append("红旗表整体为空（读空＝判据失效，不许当通过）")
    return errs


def assert_red_flag_tables(danger: list | None = None, combo: list | None = None) -> None:
    """载入即拒绝（无降级模式）。写成函数而非裸 if，是为了让镜像端测试能**直接驱动这条抛异常路径**
    ——覆盖它和验证它生效是同一件事，藏在模块顶层的一次性 if 里就只能靠改源码做变异实验。"""
    errs = validate_red_flag_rules(danger, combo)
    if errs:
        raise RuntimeError("红旗规则表非法，拒绝载入（无降级模式）：\n  - " + "\n  - ".join(errs))


assert_red_flag_tables()


def _bp_crisis(text: str) -> bool:
    m = re.search(r"(\d{2,3})\s*[/／]\s*(\d{2,3})", text)
    if not m:
        return False
    sys_, dia = int(m.group(1)), int(m.group(2))
    if sys_ > 350 or dia > 250 or sys_ < 50 or dia < 20:  # 脏读拒绝（与 rules.js 值域守卫对齐）
        return False
    return sys_ >= 180 or dia >= 120


# 否定修饰：中文临床文本用「无/没有/未/否认…」直接修饰症状词表达阴性。
# 既往按子串命中 ⇒ "无气促" 命中 "气促"，脓毒症红旗假阳性（第二十四轮由产品路径评测实测抓到）。
# 只收「明确阴性表述」：不收 "排除/不支持/不" —— "不能排除心前区闷痛" 若被抑制就是漏报，
# 而本层的失败代价不对称（漏报危险信号远重于多提示），故宁缺毋滥。与 rules.js 逐字同表。
_NEGATION_TOKENS = ["没有", "未见", "未出现", "无明显", "无伴", "不伴", "否认", "阴性", "无", "未"]
_NEG_LOOKBEHIND = 4
# 形似否定实为阳性体征的词，必须先于否定判定放行，否则把「尿闭」当阴性 ⇒ 制造漏报。
# follow 是该词之后不得紧跟的字：否则 "无尿痛" 会先命中 "无尿" 这条阳性例外。
_POSITIVE_TERMS = [{"term": "无尿", "follow": ["痛", "频", "急", "不尽"]}]


def _has_positive_occurrence(text: str, kw: str) -> bool:
    """kw 在 text 中是否存在「未被否定」的一次出现（任一阳性出现即算命中，多出现取或）。"""
    k = kw.lower()
    if not k:
        return False
    positive = next((p for p in _POSITIVE_TERMS if p["term"] == k), None)
    start = 0
    while True:
        at = text.find(k, start)
        if at < 0:
            return False
        head = text[max(0, at - _NEG_LOOKBEHIND):at]
        tail = text[at + len(k):at + len(k) + 1]
        # 阳性例外词若被这些字紧跟，说明这次出现不是该体征（"无尿痛" 里的 "无尿"），该次出现作废继续找。
        disqualified = positive is not None and tail in positive["follow"]
        negated = disqualified or any(head.endswith(n) for n in _NEGATION_TOKENS)
        if not negated:
            return True
        start = at + len(k)


def _occurs_unnegated(text: str, kw: str, window: int) -> bool:
    """关键词是否存在「未被否定」的一次出现（范围层专用，语义与 JS 侧 occursUnnegated 逐字对齐）。

    基础词表沿用红旗层的紧邻判定（endswith），范围层追加线索用窗口内任意位置命中：
    中文动词会隔开否定词与关键词（「没做过CT」），只用紧邻挡不住。
    """
    k = str(kw).lower()
    if not k:
        return False
    extra = [str(x).lower() for x in SCOPE_META["negation_tokens_extra"]]
    t = text.lower()
    frm = 0
    while True:
        at = t.find(k, frm)
        if at < 0:
            return False
        head = t[max(0, at - window):at]
        negated = any(head.endswith(str(n).lower()) for n in _NEGATION_TOKENS) or any(n in head for n in extra)
        if not negated:
            return True
        frm = at + len(k)


def validate_scope_rules(list_: list | None = None, meta: dict | None = None) -> list[str]:
    """载入即校验（与 JS 侧 validateScopeRules 同一份规则集）：数据不合法就逐条报出，不留半条规则可用。"""
    rules_ = SCOPE_RULES if list_ is None else list_
    meta_ = SCOPE_META if meta is None else meta
    errs: list[str] = []
    if not isinstance(rules_, list) or not rules_:
        return ["规则表为空（零输入不得当作通过）"]
    win = meta_.get("negation_window_chars")
    if not isinstance(win, int) or win < 1:
        errs.append(f"negation_window_chars 非法：{win!r}")
    if not isinstance(meta_.get("negation_tokens_extra"), list):
        errs.append("negation_tokens_extra 必须是数组")
    seen: set = set()
    for i, r in enumerate(rules_):
        rid = r.get("id") if isinstance(r, dict) else None
        at = f"#{i}({rid})" if isinstance(rid, str) and rid else f"#{i}"
        if not isinstance(rid, str) or not re.fullmatch(r"[a-z][a-z0-9_]{2,}", rid):
            errs.append(f"{at}: id 须为 snake_case 且非空")
        if rid in seen:
            errs.append(f"{at}: id 重复")
        seen.add(rid)
        kw = r.get("keywords")
        if not isinstance(kw, list) or len(kw) < 2:
            errs.append(f"{at}: keywords 须为 ≥2 项的数组")
        else:
            for k in kw:
                if not isinstance(k, str) or len(k.strip()) < 2:
                    errs.append(f"{at}: 关键词「{k}」空或为裸单字（会子串横扫全文）")
        if not str(r.get("title") or "").strip():
            errs.append(f"{at}: title 为空")
        rat = r.get("rationale")
        if not isinstance(rat, str) or len(rat) < 20:
            errs.append(f"{at}: rationale 缺失或过短（临床取舍必须写清为什么不做）")
        if r.get("action") != "out-of-scope":
            errs.append(f"{at}: action 只能是 out-of-scope，实测 {r.get('action')!r}")
        note = r.get("doctor_note")
        if not isinstance(note, str) or not note.strip():
            errs.append(f"{at}: doctor_note 为空（医生看不到该找谁）")
    return errs


def match_scope_rule(text: str):
    """命中即返回该规则（含 rationale/doctor_note），未命中返回 None。规则顺序即优先级。"""
    window = int(SCOPE_META["negation_window_chars"])
    t = str(text or "")
    for r in SCOPE_RULES:
        matched = [k for k in r["keywords"] if _occurs_unnegated(t, k, window)]
        if matched:
            return {"id": r["id"], "title": r["title"], "matched": matched,
                    "rationale": r["rationale"], "doctor_note": r["doctor_note"]}
    return None


def _match_flag_rules(text: str) -> list[dict]:
    hits: list[dict] = []
    for r in DANGER_RULES:
        # 两侧小写归一（对齐 rules.js，d-二聚体不漏报）
        if any(_has_positive_occurrence(text, kw) for kw in r["keywords"]):
            hits.append({"name": r["name"], "severity": r["severity"], "advice": r["advice"]})
    # 组合规则：每个线索组至少命中一词才触发（表达"症状组合"临床逻辑，降低单非特异词误报）
    for r in COMBO_RULES:
        if all(any(_has_positive_occurrence(text, kw) for kw in group) for group in r["all"]):
            hits.append({"name": r["name"], "severity": r["severity"], "advice": r["advice"]})
    if _bp_crisis(text) and not any("高血压急症" in h["name"] for h in hits):
        hits.append({"name": "高血压急症红旗", "severity": "高", "advice": _HYPERTENSION_ADVICE})
    seen, out = set(), []
    for h in hits:
        if h["name"] not in seen:
            seen.add(h["name"])
            out.append(h)
    return out


def scan_flag_details(text: str) -> list[dict]:
    """结构化红旗明细（镜像 rules.js scanFlagDetails）：[{name, severity, advice}]。"""
    t = (text or "").lower()[:2000]
    if not t.strip():
        return []
    return _match_flag_rules(t)


def scan_flags(text: str) -> list[str]:
    """红旗字符串（既有契约，格式不变）。"""
    return [f"严重危险信号：{d['name']}。{d['advice']}" for d in scan_flag_details(text)]
