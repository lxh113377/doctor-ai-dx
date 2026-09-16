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
]

_HYPERTENSION_ADVICE = next(r["advice"] for r in DANGER_RULES if "高血压急症" in r["name"])


def _bp_crisis(text: str) -> bool:
    m = re.search(r"(\d{2,3})\s*[/／]\s*(\d{2,3})", text)
    if not m:
        return False
    return int(m.group(1)) >= 180 or int(m.group(2)) >= 120


def scan_flags(text: str) -> list[str]:
    hits = []
    for r in DANGER_RULES:
        if any(kw in text for kw in r["keywords"]):
            hits.append(f"严重危险信号：{r['name']}。{r['advice']}")
    if _bp_crisis(text) and not any("高血压急症" in h for h in hits):
        hits.append(f"严重危险信号：高血压急症红旗。{_HYPERTENSION_ADVICE}")
    seen, out = set(), []
    for h in hits:
        if h not in seen:
            seen.add(h)
            out.append(h)
    return out
