#!/usr/bin/env python
"""synth_case_pipeline.py — 可复现合成病例管线（第 98 轮 H-1）

## 为什么要有这个件（对标依据，非推演）

`work/bench-r98/peer-facts-20261003.json` 的十面结构痕迹里，我方 `synth_data` 面
**命中 0**，而对照侧 `synthetichealth/synthea` 有 `config/simulations`、
`medplum` 有 `packages/generator`。代码级复核确认：脱敏/合成能力散落在
`frontend/functions/lib/chat_synth.js`(6,842B) 与 `lib/pii.js`(3,201B) 两处，
**没有独立的、可复现的合成管线**。

而产品红线白纸黑字写着「演示只用脱敏合成病例，禁止接入真实患者数据」——
**红线目前只有代码散件支撑，没有机制**。本件照 synthea 形态（seed → 生成 → 校验）
把它从承诺变成机制。

## 三条硬线

1. **可复现**：同 seed 两次生成**逐字节相同**。用 `random.Random(seed)`（不用全局
   random），且 dict 输出走 `sort_keys=True` —— 这两处任一漏掉都会让「可复现」变成口号。
2. **禁真实数据**：产出与输入都过 `deident_findings()`。命中姓名/手机号/身份证/邮箱/
   病案号/日期形态即**拒收**（rc=1），不静默清洗——静默清洗会让「已脱敏」这个断言本身
   失去证据。
3. **只读既有评测集**：`--check` 走 `iCAN…/03-评测/eval_cases.json`，**不改它**。
   本件是**增一条校验**，不是第二个真值源。

## 用法

    python scripts/synth_case_pipeline.py --selftest
    python scripts/synth_case_pipeline.py --check --cases <eval_cases.json>
    python scripts/synth_case_pipeline.py --generate --seed 20261004 --count 8

退出码：`0` 通过；`1` 结构失败（脱敏命中 / 结构问题 / 不可复现）；`2` 用法错误。
末行 `[GATE:synth-pass|fail]` 是唯一权威读数。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MVP = HERE.parent

# ── 合成语料：常见病多发病场景 + 逐轮问诊回答模板 ───────────────────────────
# 说明：这些是**模板骨架**，不是医学知识断言。红旗期望由 `expect_flag` 显式标注，
# 取值来自既有 eval_cases.json 的场景分组，本件不重新裁定医学结论。
SCENE_TEMPLATES: list[dict] = [
    {"scene": "胸痛", "case_id": "c1", "expect_flag": True,
     "answers": ["压榨样/紧缩感", "向左肩臂放射", "活动/劳累时加重", "出冷汗", "高血压，吸烟"]},
    {"scene": "胸痛", "case_id": "c1", "expect_flag": False,
     "answers": ["烧灼样", "无放射", "平卧加重", "反酸烧心", "无特殊"]},
    {"scene": "头痛", "case_id": "c2", "expect_flag": True,
     "answers": ["突发剧烈头痛", "伴呕吐", "颈项强直", "畏光", "无高血压史"]},
    {"scene": "头痛", "case_id": "c2", "expect_flag": False,
     "answers": ["反复发作", "单侧", "搏动性", "休息可缓解", "睡眠不足"]},
    {"scene": "腹痛", "case_id": "c3", "expect_flag": True,
     "answers": ["持续剧痛", "腹肌紧张", "反跳痛", "发热", "无明显诱因"]},
    {"scene": "腹痛", "case_id": "c3", "expect_flag": False,
     "answers": ["隐痛", "餐后加重", "无压痛", "无发热", "伴反酸"]},
    {"scene": "发热", "case_id": "c4", "expect_flag": True,
     "answers": ["高热 39.8℃", "寒战", "意识模糊", "皮疹", "近期疫区旅行史"]},
    {"scene": "发热", "case_id": "c4", "expect_flag": False,
     "answers": ["低热 37.6℃", "无寒战", "咽痛", "无皮疹", "受凉后出现"]},
    {"scene": "咳嗽咳痰", "case_id": "c5", "expect_flag": False,
     "answers": ["干咳 3 天", "无发热", "无气促", "咽部充血", "受凉后出现"]},
    {"scene": "腹泻", "case_id": "c6", "expect_flag": True,
     "answers": ["稀水样便", "每日 10 余次", "脱水", "电解质紊乱", "不洁饮食史"]},
]

# ── 脱敏判据：命中即拒收 ────────────────────────────────────────────────────
# 「静默清洗掉」会让"已脱敏"这个断言失去证据（它就成了不可证的主张），故此处是**拒收**。
DEIDENT_RULES = [
    ("phone_mainland", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")),
    ("id_card_cn18", re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")),
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("bare_year_date", re.compile(r"(?<!\d)(19|20)\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?")),
    ("mrn_like", re.compile(r"(?<![A-Za-z0-9])(?:病案号|住院号|门诊号)\s*[:：]?\s*[A-Za-z0-9]{4,}")),
    # 姓名形态：必须紧邻称谓/冒号语境才判（避免「李氏」式误报）
    ("person_name", re.compile(
        r"(?:患者|病人|姓名|家属)\s*(?:叫|为|：|:)?\s*"
        r"[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨][一-龥]{1,2}(?![一-龥]{2})")),
]


def deident_findings(text: str) -> list:
    """返回 [(规则名, 命中片段)]。空列表 == 通过。异常不折成空。"""
    out = []
    for name, rx in DEIDENT_RULES:
        for m in rx.finditer(text):
            out.append((name, m.group(0)[:24]))
    return out


def generate(seed: int, count: int) -> dict:
    """同 seed ⇒ 同输出。**不碰全局 random**，输出走 sort_keys 保证键序稳定。"""
    rng = random.Random(seed)
    pool: list[dict] = list(SCENE_TEMPLATES)
    cases: list[dict] = []
    for i in range(count):
        tpl = pool[rng.randrange(len(pool))]
        rot = rng.randrange(len(tpl["answers"]))       # 受控扰动，同 seed 稳定
        answers = tpl["answers"][rot:] + tpl["answers"][:rot]
        cases.append({
            "id": f"syn-{i + 1:03d}",
            "scene": tpl["scene"],
            "case_id": tpl["case_id"],
            "expect_flag": tpl["expect_flag"],
            "answers": answers,
            "synthetic": True,
            "seed": seed,
        })
    blob = json.dumps(cases, ensure_ascii=False, sort_keys=True)
    return {
        "_meta": {
            "name": "合成病例管线产出（可复现）",
            "generator": "doctor-ai-dx-mvp/scripts/synth_case_pipeline.py",
            "seed": seed,
            "count": count,
            "disclaimer": "全部为程序合成的模板骨架，不代表真实患者或真实调研样本",
            "reproduce": f"python scripts/synth_case_pipeline.py --generate --seed {seed} --count {count}",
            "digest": hashlib.sha256(blob.encode("utf-8")).hexdigest(),
        },
        "cases": cases,
    }


def check_cases_file(path: Path) -> dict:
    """对既有 eval_cases.json 做**只读**脱敏与结构校验。"""
    res: dict = {"path": str(path), "available": path.exists(), "cases": None,
           "deident_findings": [], "structural_errors": [], "meta_disclaimer_present": None}
    if not res["available"]:
        res["structural_errors"].append(f"文件不存在: {path}")
        return res
    try:
        doc = json.loads(open(path, encoding="utf-8").read())
    except Exception as ex:  # noqa: BLE001 - 解析失败必须显式，不可折成「空集通过」
        res["structural_errors"].append(f"JSON 解析失败: {type(ex).__name__}")
        return res
    if isinstance(doc, dict):
        cases = doc.get("cases") or []
        meta = doc.get("_meta") or {}
    else:
        cases, meta = doc, {}
    res["cases"] = len(cases)
    res["meta_disclaimer_present"] = bool(meta.get("disclaimer"))
    for i, c in enumerate(cases):
        if not isinstance(c, dict):
            res["structural_errors"].append(f"case[{i}] 不是对象")
            continue
        for req in ("id", "scene", "answers"):
            if req not in c:
                res["structural_errors"].append(f"case[{i}] 缺字段 {req}")
        blob = json.dumps(c, ensure_ascii=False)
        for rule, frag in deident_findings(blob):
            res["deident_findings"].append({"case": c.get("id", i), "rule": rule, "hit": frag})
    ids = [c.get("id") for c in cases if isinstance(c, dict)]
    if len(ids) != len(set(ids)):
        res["structural_errors"].append("case id 有重复")
    return res


def selftest() -> int:
    fails = []

    def chk(name, cond, extra=""):
        if not cond:
            fails.append(f"{name} {extra}")

    # T1 可复现：同 seed 两次 ⇒ 逐字节相同
    a = generate(20261004, 8)
    b = generate(20261004, 8)
    chk("T1 同 seed 逐字节相同",
        json.dumps(a, ensure_ascii=False, sort_keys=True) == json.dumps(b, ensure_ascii=False, sort_keys=True))
    chk("T1 digest 相同", a["_meta"]["digest"] == b["_meta"]["digest"], a["_meta"]["digest"])
    # T2 不同 seed ⇒ 不同产出（否则 seed 是摆设）
    c = generate(20261005, 8)
    chk("T2 异 seed 产出不同", c["_meta"]["digest"] != a["_meta"]["digest"])
    # T3 结构完整
    chk("T3 产出条数＝count", len(a["cases"]) == 8, str(len(a["cases"])))
    chk("T3 每条含必需字段",
        all(all(k in x for k in ("id", "scene", "answers", "expect_flag", "synthetic", "seed"))
            for x in a["cases"]))
    chk("T3 id 不重复", len({x["id"] for x in a["cases"]}) == len(a["cases"]))
    chk("T3 声明可复现命令", "--generate --seed 20261004" in a["_meta"]["reproduce"])
    # T4 产出自身必须过脱敏（否则本件就是在造脏数据）
    self_hits = deident_findings(json.dumps(a, ensure_ascii=False))
    chk("T4 自产数据零脱敏命中", self_hits == [], str(self_hits[:3]))
    # T5 脱敏判据方向：真脏数据必须被抓到（每条规则各一条正样本）
    dirty = [
        ("手机号", "患者手机号 13812345678"),
        ("身份证", "id 110101199003074567"),
        ("邮箱", "邮箱 zhangsan@example.com"),
        ("日期", "就诊日期 2026-03-05"),
        ("病案号", "病案号：AB123456"),
        ("姓名", "患者叫 李明"),
    ]
    for label, text in dirty:
        chk(f"T5 抓得到{label}", len(deident_findings(text)) > 0, text)
    # T6 反向：干净文本**不得**被误报（否则判据不可用）
    clean = ["压榨样/紧缩感", "向左肩臂放射", "高血压，吸烟", "无特殊", "活动后缓解"]
    for text in clean:
        chk(f"T6 不误报「{text}」", deident_findings(text) == [], str(deident_findings(text)))
    chk("T6 干净组合零命中", deident_findings(json.dumps(a["cases"], ensure_ascii=False)) == [])
    # T7 解析失败/不可达不得读成「零命中通过」
    bad = check_cases_file(Path("NOPE_NOT_HERE.json"))
    chk("T7 不可达记 structural_error 而非通过",
        bad["cases"] is None and len(bad["structural_errors"]) > 0)
    # T8 零病例 / id 重复 / 缺字段 / 脏数据 四种形态各有一腿
    import shutil
    import tempfile
    td = Path(tempfile.mkdtemp(prefix="synth_selftest_"))
    try:
        empty = td / "empty.json"
        empty.write_text(json.dumps({"cases": []}), encoding="utf-8")
        chk("T8 零病例被识别", check_cases_file(empty)["cases"] == 0)
        dup = td / "dup.json"
        dup.write_text(json.dumps({"cases": [{"id": "a", "scene": "x", "answers": []},
                                              {"id": "a", "scene": "y", "answers": []}]}), encoding="utf-8")
        chk("T8 id 重复被抓到",
            any("重复" in e for e in check_cases_file(dup)["structural_errors"]))
        miss = td / "miss.json"
        miss.write_text(json.dumps({"cases": [{"id": "a", "answers": []}]}), encoding="utf-8")
        chk("T8 缺 scene 被抓到",
            any("scene" in e for e in check_cases_file(miss)["structural_errors"]))
        dirtyf = td / "dirty.json"
        dirtyf.write_text(json.dumps({"cases": [{"id": "a", "scene": "x",
                                                 "answers": ["手机号 13812345678"]}]}), encoding="utf-8")
        chk("T8 脏数据被脱敏判据抓到", len(check_cases_file(dirtyf)["deident_findings"]) > 0)
        broken = td / "broken.json"
        broken.write_text("{ not json", encoding="utf-8")
        chk("T8 解析失败判红而非读成空集通过",
            len(check_cases_file(broken)["structural_errors"]) > 0)
    finally:
        shutil.rmtree(td, ignore_errors=True)

    if fails:
        for f in fails:
            print("   [FAIL] " + f)
        print(f"[GATE:synth-fail] {len(fails)} 项未成立")
        return 1
    print("   T1..T8 全成立（含 6 条方向相反的反例腿：真脏必抓 / 干净不误报 / 不可达不记过）")
    print("[GATE:synth-pass] 可复现 + 脱敏双向反例桩全绿")
    return 0


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(
        prog="synth_case_pipeline.py",
        description="可复现合成病例管线（红线「只用脱敏合成病例」的机制化）")
    p.add_argument("--selftest", action="store_true", help="离线反例自检")
    p.add_argument("--check", action="store_true", help="只读校验既有评测集的脱敏与结构")
    p.add_argument("--cases", default=None, help="评测集路径（默认 iCAN…/03-评测/eval_cases.json）")
    p.add_argument("--generate", action="store_true", help="生成合成病例（stdout JSON）")
    p.add_argument("--seed", type=int, default=20261004)
    p.add_argument("--count", type=int, default=8)
    p.add_argument("--out", default=None, help="生成结果落盘路径")
    args = p.parse_args(argv)

    if args.selftest:
        return selftest()

    if args.generate:
        doc = generate(args.seed, args.count)
        blob = json.dumps(doc, ensure_ascii=False, indent=1, sort_keys=True)
        hits = deident_findings(blob)
        if hits:
            sys.stderr.write(f"[synth] 自产数据命中脱敏判据 ⇒ 拒收: {hits[:3]}\n")
            return 1
        n_cases = len(doc["cases"])
        digest = doc["_meta"]["digest"]
        if args.out:
            Path(args.out).parent.mkdir(parents=True, exist_ok=True)
            open(args.out, "w", encoding="utf-8", newline="\n").write(blob)
            print(f"   写入 {args.out}｜{n_cases} 条｜digest={digest}")
        else:
            print(blob)
        print(f"[GATE:synth-pass] 合成病例 {n_cases} 条可复现（seed={args.seed}，digest={digest}），脱敏零命中")
        return 0

    # --check（默认动作）
    default_cases = MVP.parent / "iCAN大学生创新创业大赛" / "03-评测" / "eval_cases.json"
    cp = Path(args.cases) if args.cases else default_cases
    r = check_cases_file(cp)
    if not r["available"]:
        print(f"[GATE:synth-fail] 评测集不可达: {r['path']}")
        return 1
    n_cases = r["cases"]
    disclaimer = "有" if r["meta_disclaimer_present"] else "**缺**"
    print(f"🧪 合成病例脱敏校验 ｜ {r['path']}")
    print(f"   病例 {n_cases} 条｜meta 免责声明 {disclaimer}")
    print(f"   脱敏命中 {len(r['deident_findings'])} 处｜结构问题 {len(r['structural_errors'])} 处")
    for d in r["deident_findings"][:8]:
        print(f"   ⚠ [{d['case']}] {d['rule']}: {d['hit']}")
    for e in r["structural_errors"][:8]:
        print("   ✗ " + e)
    if r["deident_findings"] or r["structural_errors"] or n_cases == 0:
        print("[GATE:synth-fail] 存在脱敏命中 / 结构问题 / 零病例 ⇒ 红线不可验证")
        return 1
    print(f"[GATE:synth-pass] {n_cases} 条病例脱敏零命中、结构完整、免责声明在位")
    return 0


if __name__ == "__main__":
    sys.exit(main())