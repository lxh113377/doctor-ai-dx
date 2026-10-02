// 意图注册表（构建期产物，禁手改）——由 scripts/export_intents.mjs 从 data/intents.json 生成。
// schema_version=1.0.0；改表请改权威文件后跑 npm run intents:export。
// 三方全等由 frontend/tests/intents_guard.mjs 对账。

export const INTENTS_SCHEMA_VERSION = "1.0.0"
export const MIN_INTENTS = 5

export const INTENTS = Object.freeze([
  Object.freeze({ id: "general_medical", label: "常见病与多发病咨询（转既有辅诊链路）", keywords: Object.freeze(["头痛","头晕","发热","发烧","咳嗽","咳痰","咽痛","鼻塞","腹痛","腹泻","恶心","呕吐","心慌","心悸","乏力","失眠","腰痛","关节痛","皮疹","瘙痒","血糖","血压","贫血","胃疼","便秘","眩晕","气短","水肿","消瘦","高热","惊厥","抽搐","痉挛","牙痛","耳鸣","视物模糊","胸闷","嗓子疼","手脚麻","盗汗","记忆","焦虑","睡眠","荨麻疹","拉肚子","没精神","浮肿","体重下降","打喷嚏","流鼻涕"]), negative_terms: Object.freeze([]), reply_policy: "route_dx", confidence_floor: 0.3, handoff_policy: "abstain_or_low_confidence" }),
  Object.freeze({ id: "refund", label: "挂号与缴费的退费、退号", keywords: Object.freeze(["退费","退挂号费","挂号费退","退号","取消挂号","退款","退钱","退挂号","撤销挂号","退费流程","退费窗口","能不能退","怎么退费","退掉挂号","挂号退掉","退缴费"]), negative_terms: Object.freeze(["不退费","不用退费","无需退费","不退款","别退费","不退号","不用退号"]), reply_policy: "service_refund", confidence_floor: 0.45, handoff_policy: "escalate_if_missing_slot" }),
  Object.freeze({ id: "order_query", label: "检查报告、处方、挂号单查询", keywords: Object.freeze(["查报告","检查报告","化验单","检验结果","报告单","结果出来了","处方","处方笺","开药","挂号单","就诊记录","病历","报告怎么看","片子","影像","影像报告","ct","核磁","彩超","血常规","肝功能","在哪里看报告","怎么看结果","报告怎么看懂"]), negative_terms: Object.freeze(["没报告","没有报告","还没出报告","不用查报告","不查报告"]), reply_policy: "service_order_query", confidence_floor: 0.45, handoff_policy: "escalate_if_missing_slot" }),
  Object.freeze({ id: "tech_support", label: "系统使用与故障（技术支持）", keywords: Object.freeze(["打不开","打不开页面","登录不上","登不进去","闪退","报错","卡住","没反应","无法使用","用不了","使用问题","怎么用","怎么操作","如何操作","按钮点不动","页面空白","加载失败","网络错误","进不去","提交不了","保存失败"]), negative_terms: Object.freeze(["不是技术问题","不用教我"]), reply_policy: "service_tech_support", confidence_floor: 0.4, handoff_policy: "escalate_if_repeated" }),
  Object.freeze({ id: "out_of_scope", label: "超出医疗与本系统范围（弃权并转人工）", keywords: Object.freeze(["天气","股票","基金","房价","相亲","游戏","娱乐","菜谱","法律咨询","签证","代写","论文代写","算命","减肥药推荐","开假条","投诉医生","赔偿多少钱"]), negative_terms: Object.freeze([]), reply_policy: "abstain_and_handoff", confidence_floor: 0.5, handoff_policy: "always_handoff" }),
])

export const INTENT_IDS = Object.freeze(INTENTS.map((i) => i.id))
export const INTENT_BY_ID = new Map(INTENTS.map((i) => [i.id, i]))
export const REQUIRED_INTENT_IDS = Object.freeze([
  "general_medical",
  "refund",
  "order_query",
  "tech_support",
  "out_of_scope",
])
