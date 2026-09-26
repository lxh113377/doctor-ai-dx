# 适用范围规则（构建期产物，禁手改）——由 scripts/export_scope.mjs 从 data/scope_rules.json 生成。
# schema_version=1.0；与 functions/lib/scope_rules.js 同源同值，由 frontend/tests/scope_guard.mjs 对账。
from typing import Any

SCOPE_SCHEMA: str = "1.0"
SCOPE_META: dict[str, Any] = {"negation_window_chars": 6, "negation_tokens_extra": ["没"]}

SCOPE_RULES: list[dict[str, Any]] = [
    {"id": "imaging_or_report_reading", "title": "影像与检查报告解读", "keywords": ["CT", "片子", "X光", "核磁", "超声", "报告单", "化验单", "活检", "病理", "影像报告"], "rationale": "本系统只接受文字形式的症状与问诊信息，不具备影像、报告单或化验单的解析能力，也没有按患者具体数值判读的训练与验证。把「片子上写了一个结节」翻译成诊断，等于用文本检索冒充阅片，是幻觉风险最高的一类越界。", "action": "out-of-scope", "doctor_note": "请把影像或报告交由放射科与临床医生判读；本系统可在您转述症状后提供鉴别参考。"},
    {"id": "weight_based_dosing", "title": "给药剂量与处方方案", "keywords": ["剂量", "每公斤", "几毫升", "吃多少", "用量", "开点药", "开个方", "mg/kg"], "rationale": "知识库只收录鉴别诊断与转诊指征，不含按体重、年龄、肝肾功能调整的药代动力学数据，也没有处方权。给错剂量的代价与漏诊同量级，且这类请求一旦答错不会被任何下游环节发现。", "action": "out-of-scope", "doctor_note": "具体药品、剂量与疗程须由处方医生按患者体重、肝肾功能与合并用药决定；本系统不提供剂量建议，最终用药方案由医生判断。"},
    {"id": "non_human_patient", "title": "非人类患者", "keywords": ["宠物", "牲畜", "家畜", "我家猫", "我家狗", "家里的猫", "家里的狗", "小猫", "小狗", "猫咪", "狗狗", "动物"], "rationale": "知识库取料于人类基层诊疗指南与专家共识，其症状阈值（血压、体温、意识判定）在兽医场景无对应意义。此前该类输入只是偶然因分数偏低被弃权，属于靠运气兜住。刻意不用裸「猫」「狗」作关键词：被狗咬伤的暴露处置（狂犬病疫苗与破伤风）本身是基层人医业务，以单字动物名命中会把这类真实人类需求挡在范围外，故要求所有物/指小形式或「宠物」等上下文字。", "action": "out-of-scope", "doctor_note": "本系统仅面向人类基层诊疗，动物请转诊兽医；若是人的动物咬伤暴露，请由接诊医生按狂犬病暴露处置流程评估，本系统仅提供辅助参考，最终判断由接诊医生作出。"},
]

SCOPE_RULE_IDS: list[str] = [r["id"] for r in SCOPE_RULES]
