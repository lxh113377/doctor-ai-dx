"""知识库外置（#92）的 **Python 侧** 常驻测试：核「权威 == 镜像生成物」，且这条核对本机可独立判红。

为什么必须单独有这份：第 30 轮的教训是「双端同逻辑」里测试那一半从未对账——JS 侧守卫通过 subprocess
调 Python，既不进 Py 覆盖率、也依赖 JS 侧在场。本文件让镜像面自己说得出「我这份数据与权威同值」，
并带**非恒真对照**（造一处人为差异，必须被同一段比较识破），否则等值断言只是在报"两边都在"。

与 JS 侧共用同一份权威 `data/knowledge.json`，不在此另抄数据或字段清单。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
ROOT = Path(__file__).resolve().parents[2]

from app import knowledge as k  # noqa: E402

TOP_KEYS = {"schema_version", "_editing", "_provenance", "entries", "synonyms", "symptom_to_kb", "red_flag_terms"}
ENTRY_FIELDS = {"id", "title", "source", "year", "url", "scope", "section", "condition", "icd", "keywords", "text"}
# 与 scripts/export_knowledge.mjs 的半空止闸同源下限（此处只做断言，不放宽）
MIN_ENTRIES, MIN_SYM_KEYS, MIN_RF_TERMS = 50, 55, 20

fails: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print("  PASS", name)
    else:
        fails.append(name)
        print("  FAIL", name, ":: " + detail if detail else "")


print("== 1. 权威可读 ==")
try:
    auth = json.load(open(ROOT / "data" / "knowledge.json", encoding="utf-8"))
    check("data/knowledge.json 可读且为对象", isinstance(auth, dict))
except Exception as e:  # noqa: BLE001 - 读不到就没必要继续，直接判红
    print("FAIL 读取权威失败 ::", type(e).__name__, e)
    sys.exit(1)

print("== 2. 权威 == 镜像生成物（四组，含顺序）==")
check("KNOWLEDGE_BASE == 权威 entries", k.KNOWLEDGE_BASE == auth["entries"],
      f"py {len(k.KNOWLEDGE_BASE)} 条 vs 权威 {len(auth['entries'])} 条")
check("SYNONYMS == 权威 synonyms", k.SYNONYMS == auth["synonyms"])
check("SYMPTOM_TO_KB == 权威 symptom_to_kb", k.SYMPTOM_TO_KB == auth["symptom_to_kb"])
check("RED_FLAG_KEYWORDS == 权威 red_flag_terms", k.RED_FLAG_KEYWORDS == auth["red_flag_terms"])

print("== 3. 非恒真对照（人为改一处，同一段比较必须识破）==")
tampered = [dict(r) for r in auth["entries"]]
tampered[0]["title"] = tampered[0]["title"] + "（人为改动）"
check("改一个字段即被判为不等", k.KNOWLEDGE_BASE != tampered)
dropped = list(auth["entries"][:-1])
check("少一条即被判为不等", k.KNOWLEDGE_BASE != dropped)
check("对照用的原值仍然相等（证明上面两条红是被改动引起的）", k.KNOWLEDGE_BASE == auth["entries"])

print("== 4. 结构不变量（与生成器同一套下限，双端各核一遍）==")
check("权威顶层键集合固定", set(auth) == TOP_KEYS, f"多出/缺少：{sorted(set(auth) ^ TOP_KEYS)}")
check(f"条目数 ≥ {MIN_ENTRIES}", len(auth["entries"]) >= MIN_ENTRIES, f"实测 {len(auth['entries'])}")
check(f"症状映射键数 ≥ {MIN_SYM_KEYS}", len(auth["symptom_to_kb"]) >= MIN_SYM_KEYS, f"实测 {len(auth['symptom_to_kb'])}")
check(f"检索加权词数 ≥ {MIN_RF_TERMS}", len(auth["red_flag_terms"]) >= MIN_RF_TERMS, f"实测 {len(auth['red_flag_terms'])}")
bad_fields = [e.get("id", f"#{i}") for i, e in enumerate(auth["entries"]) if set(e) != ENTRY_FIELDS]
check("每条条目字段集合恰为 11 项（缺字段=降级数据，多字段=旁路数据）", not bad_fields, ",".join(map(str, bad_fields[:5])))
bad_ids = [e["id"] for i, e in enumerate(auth["entries"]) if e["id"] != f"kb-{i + 1:03d}"]
check("id 连续编号且无重复", not bad_ids, ",".join(map(str, bad_ids[:5])))
bad_icd = [e["id"] for e in auth["entries"] if not (e["icd"] is None or isinstance(e["icd"], str))]
check("icd 只能是字符串或显式 null", not bad_icd, ",".join(map(str, bad_icd[:5])))
ids = {e["id"] for e in auth["entries"]}
dangling = {f"{s}->{t}" for s, targets in auth["symptom_to_kb"].items() for t in targets if t not in ids}
check("症状映射不指向不存在的条目", not dangling, str(sorted(dangling)[:3]))
reachable = set().union(*auth["symptom_to_kb"].values())
check("无孤儿条目（每条至少被一个症状线索映射）", ids == reachable, f"孤儿：{sorted(ids - reachable)[:5]}")
terms = auth["red_flag_terms"]
check("检索加权词无重复且长度≥2", len(set(terms)) == len(terms) and all(len(str(t).strip()) >= 2 for t in terms))

print(f"\nRESULT: {'0 fail / all passed' if not fails else str(len(fails)) + ' fail / FAILURES=' + ','.join(fails[:4])}")
sys.exit(1 if fails else 0)
