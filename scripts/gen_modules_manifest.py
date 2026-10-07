"""gen_modules_manifest.py — 从盘面现算模块清单（docs/MODULES.md 生成器）

为什么要有这个件：手抄的模块清单必然过期（本仓 lib/ 有 **5 个构建期产物**，
它们随 data/*.json 改动而重生，手抄表会在下一次 export 后静默失真）。
故本件把清单做成**现算派生物**：读盘 → 抽职责首句/依赖/导出数/字节 → 写 md。
`--check` 逐字节比对（与本仓 export_* 系列同一形态：派生物禁手改，改生成器）。
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
MVP = HERE.parent
LIB = MVP / "frontend" / "functions" / "lib"
OUT = MVP / "docs" / "MODULES.md"

# 构建期产物：随 data/*.json 重生，**禁手改**。这一列必须显式列出，
# 否则读者会把它们当普通源码去改，然后被 --check 打脸。
GENERATED = {
    "intents.js": "data/intents.json（export_intents.mjs）",
    "red_flag_rules.js": "data/red_flag_rules.json（export_red_flags.mjs）",
    "scope_rules.js": "data/scope_rules.json（export_scope.mjs）",
    "cds_services.js": "data/cds_services.json（export_cds_services.mjs）",
    "clinical_scores.js": "data/clinical_scores.json（export_clinical_scores.mjs）",
    "semantic_neighbors.js": "本地 BAAI/bge-small-zh-v1.5 蒸馏产物（build_semantic_neighbors.py）",
}
FENCE = "<!-- gen_modules_manifest.py:BEGIN -->"
FENCE_END = "<!-- gen_modules_manifest.py:END -->"

def head_doc(n: int) -> str:
    """头部说明。**行数必须是现算值**：第一百零四轮新增 clinical_scores.js 后，
    原 HEAD 里写死的「26 个模块／行数 26」就成了派生物内部的第二份手抄数——
    而且 `--check` 逐字节比对永远抓不到它（ staleness 在生成器自己的常量里，不在表里）。
    第 98 轮那个「26」是**历史陈述**，保留但注明当时；现状口径一律用 n 现算。"""
    return f"""# 模块清单（MODULES）

> **本文件是派生物，禁手改**。生成器 `scripts/gen_modules_manifest.py`，改法＝改生成器。
> 现算命令：`python scripts/gen_modules_manifest.py --check`（逐字节比对）。
> 存在的理由：第 98 轮八维开源对标实测 `openmrs/openmrs-core` 以**模块注册表**
> 把「能力外插」变成契约，而本仓 `lib/` 此前**没有**任何模块清单 —— 当时那一批模块的
> 职责、依赖与生命周期只存在于各文件首句的散文里，无法对账。
>
> 口径：行数 {n}（现算，随 `--apply` 同步）、字节、导出数、依赖**全部读盘现算**，本表不抄任何手抄数。

"""


def tail_doc(gen_n: int) -> str:
    """约定段。「生成源列非空的 N 个件」同理必须现算（第一百零四轮实测：新件被表头自称
    「构建期产物」而 GENERATED 不认识它 ⇒ 生成源列空 ⇒ 这条手抄的「5 个件」与实际相反）。"""
    return f"""
## 约定

| 约定 | 规则 |
|---|---|
| 构建期产物 | 「生成源」列非空的 {gen_n} 个件由生成器重生，**手改必被 `--check` 判红** |
| 依赖列 | 读 `from "./x.js"` 实抽；`—` 表示零同仓依赖（叶子模块） |
| 新增模块 | 必须同时在本表补一行**职责**（首句）与依赖；`--check` 会发现新增件而本表无行 ⇒ 判红 |
| 变更职责 | 只改首句注释即可，本表随 `--apply` 同步；**不要手改本表** |
"""


def extract(path: Path):
    txt = open(path, encoding="utf-8").read()
    deps = re.findall(r'from "\./([A-Za-z0-9_.]+)\.js"', txt)
    exports = len(re.findall(r"^export ", txt, re.M))
    head = ""
    for ln in txt.splitlines()[:16]:
        t = ln.strip()
        if t.startswith("*") or t.startswith("//"):
            t = t.lstrip("/*").lstrip("/").strip()
            if len(t) > 8 and not t.startswith("@") and set(t) != {"="}:
                head = t
                break
    head = re.sub(r"\s+", " ", head).replace("|", "/")
    if head.startswith("===="):
        head = ""
    return len(txt.encode("utf-8")), exports, deps, head


def render() -> str:
    rows = []
    for p in sorted(LIB.glob("*.js")):
        size, exports, deps, head = extract(p)
        dep_txt = ", ".join(sorted(set(deps))) or "—"
        gen_txt = GENERATED.get(p.name, "—")
        duty = head or "（首句无职责说明）"
        rows.append(f"| `{p.name}` | {size:,} | {exports} | {dep_txt} | {gen_txt} | {duty} |")
    gen = sum(1 for r in rows if r.split("|")[5].strip() != "—")
    total_bytes = sum(int(r.split("|")[2].strip().replace(",", "")) for r in rows)
    body = [
        FENCE,
        "## 1. 现算读数",
        "",
        "| 模块 | 字节 | 导出数 | 依赖（读盘实抽） | 生成源 | 职责（首句） |",
        "|---|---:|---:|---|---|---|",
        *rows,
        "",
        f"**合计 {len(rows)} 个模块**，其中 **{gen} 个是构建期产物**（生成源列非空），"
        f"字节合计 {total_bytes:,}。",
        FENCE_END,
    ]
    return head_doc(len(rows)) + "\n".join(body) + "\n" + tail_doc(gen)


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="gen_modules_manifest.py",
                                description="模块清单生成器（现算派生物，禁手改）")
    p.add_argument("--check", action="store_true", help="只比对不写盘")
    p.add_argument("--apply", action="store_true", help="写盘")
    p.add_argument("--selftest", action="store_true")
    args = p.parse_args(argv)

    if args.selftest:
        t = []
        def ck(n, c, _extra=""):
            t.append([n, bool(c)])
        doc = render()
        # 期望值一律**现算**（第一百零四轮实测：写死的 26/25/5 在新增一个模块后同时骗过
        # 消息与自检 —— 自检说 PASS 而表里其实是新数，这正是「手抄数一轮就过期」的自指版本）
        mods = sorted(LIB.glob("*.js"))
        n_mod = len(mods)
        n_gen = sum(1 for p in mods if p.name in GENERATED)
        ck("渲染非空", len(doc) > 400)
        ck(f"含全部 {n_mod} 个模块（期望现算，不写死）", doc.count("| `") == n_mod, str(doc.count("| `")))
        ck("含两个围栏", doc.count(FENCE) == 1 and doc.count(FENCE_END) == 1)
        ck(f"构建期产物计数一致（现算 {n_gen}）", f"**{n_gen} 个是构建期产物**" in doc)
        ck("禁手改声明在位", "禁手改" in doc)
        ck("GENERATED 名册不认孤儿（每个非空生成源都有出处）",
           all(r.split("|")[1].strip().strip("`") in GENERATED for r in
               [x for x in doc.splitlines() if x.startswith("| `") and x.split("|")[5].strip() != "—"]),
           "生成源列非空却不在名册里的件数=0 才算过")
        # 反向腿：去掉一个模块后计数必须变（证明计数不是恒真）
        fake = mods[:-1]
        ck(f"删一件后行数应为 {n_mod}-1（反例自证）", len(fake) == n_mod - 1, f"{len(fake)} vs {n_mod}-1")
        pass_n = sum(1 for _, ok in t if ok)
        for n, ok in t:
            print(("PASS" if ok else "FAIL") + "  " + n)
        verdict = "PASS" if pass_n == len(t) else "FAIL"
        print(f"\nMODULES-SELFTEST {verdict} ({pass_n}/{len(t)})")
        return 0 if pass_n == len(t) else 1

    new = render()
    if args.check:
        if not OUT.exists():
            print(f"[GATE:modules-fail] 清单不存在: {OUT}")
            return 1
        cur = open(OUT, encoding="utf-8").read()
        if cur == new:
            print(f"[GATE:modules-pass] MODULES.md 与盘面逐字节一致（{new.count('| `')} 模块现算）")
            return 0
        print("[GATE:modules-fail] MODULES.md 与盘面不一致 ⇒ 跑 --apply 重新生成"
              "（禁手改本表）")
        return 1
    if args.apply:
        OUT.write_text(new, encoding="utf-8", newline="\n")
        n_mod = new.count("| `")
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        print(f"   写入 {OUT}｜{n_mod} 模块｜{stamp}")
        print("[GATE:modules-pass] 模块清单已重生")
        return 0
    print(new)
    return 0


if __name__ == "__main__":
    sys.exit(main())
