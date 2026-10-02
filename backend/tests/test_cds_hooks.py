"""CDS Hooks 镜像面原生测：discovery/卡片形/拒绝腿/方法分流/零时钟。镜像 frontend/tests/cds_hooks_guard.mjs。

为什么必须原生测（而不是只靠 JS 守卫 subprocess 调 cds_dump.py）：subprocess 里跑的代码
coverage.py 看不见，`scripts/coverage_gate.py` 的模块级地板会把这些新文件当成零覆盖，
而"由 JS 守卫代跑"的镜像逻辑永远进不了覆盖率台账——同 red_flag_table_guard.mjs 头部记过的教训。
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import cds_services, limits  # noqa: E402
from app.main import app  # noqa: E402
from app.services import cds_hooks  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

ID_RE = re.compile(r"^[0-9a-f]{4,12}$")
LEAK_RE = re.compile(r"(Traceback|file://|[A-Za-z]:\\|sk-[A-Za-z0-9]{8,}|context\.symptoms\[)")

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


client = TestClient(app, raise_server_exceptions=False)


def post(service, body):
    return client.post(f"/cds-services/{service}", json=body)


def hook(context, hook_name="patient-view", instance="t-1"):
    return {"hook": hook_name, "hookInstance": instance, "context": context}


print("== 目录生成物在场且非空（读空＝集成面消失）==")
check(f"CDS_SERVICES 非空（实测 {len(cds_services.CDS_SERVICES)}）", len(cds_services.CDS_SERVICES) >= 2)
check(f"overrideReasons 非空（实测 {len(cds_services.CDS_OVERRIDE_REASONS)}）", len(cds_services.CDS_OVERRIDE_REASONS) >= 3)
check("specVersion 声明为 2.0", cds_services.CDS_SPEC_VERSION == "2.0", cds_services.CDS_SPEC_VERSION)
check("indicatorMap 覆盖三档严重度", set(cds_services.CDS_INDICATOR_MAP) == {"高", "中", "低"},
    str(cds_services.CDS_INDICATOR_MAP))

print("== GET /cds-services ==")
r = client.get("/cds-services")
check("200", r.status_code == 200)
check("X-Request-Id 在场", bool(ID_RE.match(r.headers.get("x-request-id", ""))), repr(r.headers.get("x-request-id")))
body = r.json()
check("顶层键恰为 services（不套 {code,data} 信封）", list(body) == ["services"], str(list(body)))
check(f"services 条数 == 目录条数（{len(body['services'])}）", len(body["services"]) == len(cds_services.CDS_SERVICES))
SVC_KEYS = {"hook", "title", "description", "id", "usageRequirements"}
check("每个 service 字段集恰为规范 discovery 五字段",
    all(set(s) == SVC_KEYS for s in body["services"]), str([sorted(s) for s in body["services"]]))
check("id 全部小写连串且唯一",
    all(re.match(r"^[a-z][a-z0-9-]*$", s["id"]) for s in body["services"])
    and len({s["id"] for s in body["services"]}) == len(body["services"]))
check("discovery 只认 GET：POST 落 404 且是 {code,message}",
    client.post("/cds-services", json={}).status_code == 404
    and client.post("/cds-services", json={}).json().get("code") == 404)

print("== POST /cds-services/red-flag-screen ==")
acs = post("red-flag-screen", hook({"symptoms": ["压榨样胸痛向左肩放射", "出冷汗"]}))
check("命中红旗 200", acs.status_code == 200, str(acs.status_code))
cards = acs.json()["cards"]
check("顶层键恰为 cards", list(acs.json()) == ["cards"], str(list(acs.json())))
check(f"卡片数 == 1（实测 {len(cards)}）", len(cards) == 1)
c0 = cards[0]
check("字段集恰为实现声明的五个（不含 uuid/links/suggestions）",
    list(c0) == ["summary", "indicator", "detail", "source", "overrideReasons"], str(list(c0)))
check(f"summary 短于 140（实测 {len(c0['summary'])}）", len(c0["summary"]) < 140)
check("indicator 在规范允许集内", c0["indicator"] in cds_services.CDS_URGENCIES, c0["indicator"])
check("source.label 常驻「医生终审」（红线二的接口承载位）", "医生终审" in c0["source"]["label"], c0["source"]["label"])
check("source.url 是 https", c0["source"]["url"].startswith("https://"))
check("overrideReasons 每条都有 display（不可驳回＝强制医嘱）",
    all(str(x.get("display", "")).strip() for x in c0["overrideReasons"]))
check("detail 里带规则名与处置建议", "冠脉综合征" in c0["detail"] and "心电图" in c0["detail"], c0["detail"][:80])
check("同输入两次调用逐字节相同（无时钟/随机字段）",
    post("red-flag-screen", hook({"symptoms": ["压榨样胸痛向左肩放射", "出冷汗"]})).text == acs.text)
check("空白 symptoms 不落 200 空卡（分隔符残留串曾骗过 trim 判据）",
    post("red-flag-screen", hook({"symptoms": ["", "   "]})).status_code == 422)
check("无命中返回空 cards 数组而不是造一张 info 卡",
    post("red-flag-screen", hook({"symptoms": ["发热三天，咽痛"]})).json() == {"cards": []})

print("== POST /cds-services/scope-boundary ==")
sc = post("scope-boundary", hook({"symptoms": ["帮我看看这张CT片子上的结节"]}))
check("范围外命中 1 张卡", sc.status_code == 200 and len(sc.json()["cards"]) == 1, str(sc.json())[:120])
check("范围卡 indicator=warning", sc.json()["cards"][0]["indicator"] == "warning")
check("范围卡 detail 带 rationale 与 doctor_note",
    "放射科" in sc.json()["cards"][0]["detail"] and "本系统只接受文字" in sc.json()["cards"][0]["detail"],
    sc.json()["cards"][0]["detail"][:100])
check("范围外未命中时 cards 为空",
    post("scope-boundary", hook({"symptoms": ["发热三天，咽痛"]})).json() == {"cards": []})

print("== 拒绝腿：422/404/400/413 各就各位，且文案零泄漏 ==")
REJECTS = [
    ("缺 hook", {"hookInstance": "x", "context": {"symptoms": ["呕血"]}}, 422),
    ("缺 hookInstance", {"hook": "patient-view", "context": {"symptoms": ["呕血"]}}, 422),
    ("缺 context", {"hook": "patient-view", "hookInstance": "x"}, 422),
    ("context 非对象", {"hook": "patient-view", "hookInstance": "x", "context": "呕血"}, 422),
    ("hook 与 discovery 不符", hook({"symptoms": ["呕血"]}, hook_name="order-sign"), 422),
    ("symptoms 非数组", hook({"symptoms": "呕血"}), 422),
    ("patientId 不在脱敏名册", hook({"patientId": "P-真实患者-1"}), 422),
    ("未知服务", hook({"symptoms": ["呕血"]}), 404),
]
for name, body_, want in REJECTS:
    svc = "no-such-service" if want == 404 else "red-flag-screen"
    res = post(svc, body_)
    txt = str(res.json())
    check(f"{name} → {want}", res.status_code == want, f"实测 {res.status_code}")
    check(f"{name} 响应是 {{code,message}} 且无泄漏",
        set(res.json()) == {"code", "message"} and not LEAK_RE.search(txt), txt[:120])
bad_json = client.post("/cds-services/red-flag-screen", content="{oops", headers={"Content-Type": "application/json"})
check("坏 JSON → 400 且文案等于常量", bad_json.status_code == 400
    and bad_json.json()["message"] == limits.BAD_JSON_PUBLIC_MESSAGE, str(bad_json.json())[:120])
non_object = client.post("/cds-services/red-flag-screen", json=["a", "b"])
check("JSON 合法但顶层非对象 → 400", non_object.status_code == 400, str(non_object.status_code))
huge = hook({"symptoms": ["x" * (limits.MAX_BODY_BYTES + 5)]})
check("超字节上界 → 413", post("red-flag-screen", huge).status_code == 413)
check("413 文案不含内部阈值数字",
    not re.search(r"\d{4,}", post("red-flag-screen", huge).json()["message"]))
check("GET 调用端点 → 404", client.get("/cds-services/red-flag-screen").status_code == 404)

print("== 失败路径不可失败：目录有服务但实现没有分支 ==")
saved = dict(cds_hooks._SERVICE_BY_ID)
try:
    cds_hooks._SERVICE_BY_ID["ghost-service"] = {"id": "ghost-service", "hook": "patient-view"}
    r_ghost = post("ghost-service", hook({"symptoms": ["呕血"]}))
    check("未实现的服务不静默发空卡，走 500 兜底", r_ghost.status_code == 500, str(r_ghost.status_code))
    check("500 响应只出医生可读文案＋故障编号",
        "服务暂时不可用" in r_ghost.json()["message"]
        and re.search(r"（故障编号 [0-9a-f]{4,12}）$", r_ghost.json()["message"]),
        str(r_ghost.json())[:120])
finally:
    cds_hooks._SERVICE_BY_ID.clear()
    cds_hooks._SERVICE_BY_ID.update(saved)

print("== 模板填充的异常路径：未知占位符原样留痕而不是抛错 ==")
filled = cds_hooks._fill("a{known}b{unknown}", {"known": "X"})
check("已知变量被替换、未知变量保留字面量（可诊断而非崩）", filled == "aXb{unknown}", filled)

print("== known_service_ids / discovery_document 与目录同源 ==")
check("known_service_ids 与 discovery 的 id 集合全等",
    set(cds_hooks.known_service_ids()) == {s["id"] for s in cds_hooks.discovery_document()["services"]})

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
