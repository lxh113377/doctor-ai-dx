"""危险信号规则引擎（红旗拦截层）——镜像 frontend/functions/lib/rules.js。
独立于 LLM：可解释、可单测，评审安全叙事核心。
设计：关键词须特异（防"出冷汗"等词单独误触发）；支持血压数值解析；命中即强制转诊。
"""
import re

DANGER_RULES = [
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
COMBO_RULES = [
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


def _bp_crisis(text: str) -> bool:
    m = re.search(r"(\d{2,3})\s*[/／]\s*(\d{2,3})", text)
    if not m:
        return False
    sys_, dia = int(m.group(1)), int(m.group(2))
    if sys_ > 350 or dia > 250 or sys_ < 50 or dia < 20:  # 脏读拒绝（与 rules.js 值域守卫对齐）
        return False
    return sys_ >= 180 or dia >= 120


def _match_flag_rules(text: str) -> list[dict]:
    hits: list[dict] = []
    for r in DANGER_RULES:
        if any(kw.lower() in text for kw in r["keywords"]):  # 两侧小写归一（对齐 rules.js，d-二聚体不漏报）
            hits.append({"name": r["name"], "severity": r["severity"], "advice": r["advice"]})
    # 组合规则：每个线索组至少命中一词才触发（表达"症状组合"临床逻辑，降低单非特异词误报）
    for r in COMBO_RULES:
        if all(any(kw.lower() in text for kw in group) for group in r["all"]):
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
