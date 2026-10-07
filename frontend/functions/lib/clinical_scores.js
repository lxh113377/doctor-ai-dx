// 临床评分量表表（构建期产物，禁手改）——由 scripts/export_clinical_scores.mjs 从 data/clinical_scores.json 生成。
// schema_version=1；改表请改权威文件后跑 `npm run scores:export`。
// 三方全等（权威⇄JS⇄Py）由 frontend/tests/clinical_score_guard.mjs 逐字段复算对账；判读逻辑不住这里，住 functions/lib/rules.js ↔ backend/app/rules.py。

export const CLINICAL_SCORE_SCHEMA = 1;
export const PLAUSIBLE_RANGES = {"hr":[20,250],"rr":[5,60],"spo2":[50,100],"temperature_c":[30,43],"sbp":[40,300]};
export const CONSCIOUSNESS_TOKENS = ["意识改变","意识模糊","意识障碍","嗜睡","烦躁不安","反应迟钝","答非所问","神志不清","昏睡","昏迷","叫不醒"];
export const DERIVED_VALUES = [{"id":"si","kind":"ratio","numerator":"hr","denominator":"sbp","round":2}];
export const SCORE_TABLES = [
  {"id":"qsofa","title":"qSOFA","source":"Sepsis-3 脓毒症与脓毒性休克第三国际共识（JAMA 2016）；仓内语料同条出处 data/knowledge.json kb-054「脓毒症早期识别与抗菌药物原则」","hint":"疑似感染基础上适用；三项各 1 分，≥2 分提示预后不良风险升高","items":[{"label":"呼吸频率 ≥22 次/分","need":"rr","op":">=","value":22,"points":1},{"label":"收缩压 ≤100 mmHg","need":"sbp","op":"<=","value":100,"points":1},{"label":"意识改变","need":"consciousness","points":1}],"bands":[{"min":2,"max":3,"level":"高","advice":"qSOFA ≥2 分为脓毒症高风险：立即复评感染灶与器官功能，留取血培养后按集束化路径启动液体复苏与抗菌治疗，并紧急转上级医院，不得在基层观察等待。"}]},
  {"id":"shock_index","title":"休克指数 SI","source":"《外科学》教材与急症/创伤容量评估通行口径（SI 正常 0.5~0.7；≥1.0 提示失血性休克可能，≥1.5 属重度）","hint":"SI＝心率÷收缩压，用于血压尚「正常」但已代偿的隐匿性低血容量","items":[{"label":"SI ≥0.9（容量不足警戒）","need":"si","op":">=","value":0.9,"points":1},{"label":"SI ≥1.0（休克可能）","need":"si","op":">=","value":1,"points":1}],"bands":[{"min":2,"max":99,"level":"高","advice":"SI ≥1.0 提示休克可能：即刻开放静脉通路、快速补液试验并复测血压与心率，按急症转运上级医院，勿以「血压还测得到」判断循环稳定。"},{"min":1,"max":1,"level":"中","advice":"SI ≥0.9 属隐匿性容量不足警戒带：血压可在正常范围而已代偿，请复测四肢温度、毛细血管充盈与尿量，限制盲目口服补液并缩短复评间隔。"}]},
];
